import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { NotificationService } from '../lib/NotificationService.js';
import { InstallmentService } from '../lib/payments/InstallmentService.js';
import { PaymentStateService } from '../lib/payments/PaymentStateService.js';
import { AsaasWebhookPayload, TransitionOutcome } from '../lib/payments/PaymentStateTypes.js';
import { RefundOperationRepository } from '../lib/payments/RefundOperationRepository.js';
import { SettlementService } from '../lib/payments/SettlementService.js';
import { SettlementType } from '../lib/payments/SettlementTypes.js';
import { ProjectionDispatcher } from '../lib/payments/projections/ProjectionDispatcher.js';
import { ProjectionSourceEventType } from '../lib/payments/projections/ProjectionTypes.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBodyBuffer(req: any): Promise<Buffer> {
  // 1. Check if rawBody Buffer was attached by Express verify middleware (server.ts)
  if (Buffer.isBuffer(req.rawBody)) {
    req.ingestionMode = 'express_middleware';
    return req.rawBody;
  }
  if (typeof req.rawBody === 'string' && req.rawBody.length > 0) {
    req.ingestionMode = 'express_middleware';
    return Buffer.from(req.rawBody, 'utf-8');
  }

  // 2. Check if req.body is already a Buffer or String
  if (Buffer.isBuffer(req.body)) {
    req.ingestionMode = 'raw_buffer_body';
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length > 0) {
    req.ingestionMode = 'raw_string_body';
    return Buffer.from(req.body, 'utf-8');
  }

  // 3. Read directly from the raw HTTP incoming stream (Vercel Serverless with bodyParser: false)
  if (req.readable !== false && (req.readable || typeof req[Symbol.asyncIterator] === 'function')) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const fullBuffer = Buffer.concat(chunks);
      if (fullBuffer.length > 0) {
        req.rawBody = fullBuffer;
        req.ingestionMode = 'raw_stream';
        return fullBuffer;
      }
    } catch (streamErr) {
      console.warn('⚠️ [ASAAS WEBHOOK] Stream reading encountered an error, checking fallback:', streamErr);
    }
  }

  // 4. Contingency fallback if body was pre-parsed by upstream middleware without preserving rawBody
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    console.warn('⚠️ [ASAAS WEBHOOK] Contingency Fallback Triggered: Raw stream unavailable. Re-serializing parsed req.body to Buffer.');
    req.ingestionMode = 'contingency_fallback';
    return Buffer.from(JSON.stringify(req.body), 'utf-8');
  }

  throw new Error('RAW_HTTP_BODY_UNAVAILABLE');
}

function computeRawPayloadHash(rawBuffer: Buffer): string {
  return crypto.createHash('sha256').update(rawBuffer).digest('hex');
}

export default async function handler(req: Request, res: Response) {
  // 1. Receber requisições POST do Asaas.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Validar o token enviado no cabeçalho utilizando ASAAS_WEBHOOK_SECRET.
  const webhookSecret = process.env.ASAAS_WEBHOOK_SECRET;
  const receivedToken = req.headers['asaas-access-token'];

  if (!webhookSecret || !receivedToken || receivedToken !== webhookSecret) {
    console.error('❌ Asaas Webhook Authentication Failed: Invalid or missing asaas-access-token.');
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing asaas-access-token' });
  }

  let ledgerId: string | undefined;

  try {
    // 1. Read Raw HTTP Body Buffer (Authentic wire bytes) & compute SHA-256
    let rawBodyBuffer: Buffer;
    let rawBodyStr: string;
    try {
      rawBodyBuffer = await getRawBodyBuffer(req);
      rawBodyStr = rawBodyBuffer.toString('utf-8');
    } catch (err) {
      console.error('❌ [ASAAS WEBHOOK] Infrastructure Error: Raw HTTP request body unavailable for cryptographic hash calculation.');
      return res.status(500).json({ error: 'Infrastructure Error: Raw HTTP body unavailable for cryptographic hash' });
    }

    const payloadHash = computeRawPayloadHash(rawBodyBuffer);

    // 2. Parse JSON payload securely from authentic raw body string
    let payload: any;
    try {
      payload = JSON.parse(rawBodyStr);
    } catch (parseErr: any) {
      if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        payload = req.body;
      } else {
        console.error('❌ [ASAAS WEBHOOK] Malformed JSON payload received:', parseErr.message);
        return res.status(400).json({ error: 'Bad Request: Malformed JSON payload' });
      }
    }

    // Parse fields safely
    const timestamp = new Date().toISOString();
    const event = payload?.event || 'UNKNOWN_EVENT';
    const accountId = payload?.account?.id || payload?.accountId || payload?.account || null;
    const paymentId = payload?.payment?.id || payload?.paymentId || null;

    // 2. Extract Native Provider Event ID (STRICT: null if missing from provider)
    const providerEventId: string | null = payload?.id || null;

    // 3. Compute Deterministic Idempotency Key
    const idempotencyKey = providerEventId ? `evt_${providerEventId}` : `hash_${payloadHash}`;

    // 3. Registrar logs estruturados
    console.log('=== [ASAAS WEBHOOK EVENT RECEIVED] ===');
    console.log(`Timestamp:        ${timestamp}`);
    console.log(`Event:            ${event}`);
    console.log(`Provider Event ID:${providerEventId || 'N/A (Using Hash Idempotency)'}`);
    console.log(`Idempotency Key:  ${idempotencyKey}`);
    console.log(`Account ID:       ${accountId || 'N/A'}`);
    console.log(`Payment ID:       ${paymentId || 'N/A'}`);
    console.log(`Payload Hash:     ${payloadHash}`);
    console.log('=======================================');

    // --- EVENT LEDGER INGESTION & IDEMPOTENCY CHECK (ETAPA 1) ---
    let ledgerQuery = supabaseAdmin
      .from('transactions')
      .select('id, processing_status, attempt_count, metadata')
      .eq('type', 'webhook_event')
      .eq('provider', 'asaas');

    if (providerEventId) {
      ledgerQuery = ledgerQuery.eq('provider_event_id', providerEventId);
    } else {
      ledgerQuery = ledgerQuery.eq('idempotency_key', idempotencyKey);
    }

    const { data: existingLedger } = await ledgerQuery.maybeSingle();

    let currentAttempt = 1;

    if (existingLedger) {
      ledgerId = existingLedger.id;
      currentAttempt = (existingLedger.attempt_count || 1) + 1;

      const existingMetadata = existingLedger.metadata && typeof existingLedger.metadata === 'object' ? existingLedger.metadata : {};
      const rawHistory = Array.isArray(existingMetadata.retry_history) ? existingMetadata.retry_history : [];

      const newAttemptRecord = {
        attempt: currentAttempt,
        received_at: timestamp,
        payload_hash: payloadHash
      };

      // Refinement 2 Policy: Capped array at max 10 records (ring-buffer strategy: preserve initial attempt + last 9 attempts)
      let updatedHistory = [...rawHistory, newAttemptRecord];
      if (updatedHistory.length > 10) {
        updatedHistory = [updatedHistory[0], ...updatedHistory.slice(updatedHistory.length - 9)];
      }

      const updatedMetadata = {
        ...existingMetadata,
        retry_history: updatedHistory,
        last_attempt_at: timestamp
      };

      // Idempotency Check (Refinement 1 & Approved Model)
      if (existingLedger.processing_status === 'PROCESSED') {
        console.log(`ℹ️ [EVENT LEDGER] Duplicate event received and already PROCESSED. Provider Event ID: ${providerEventId}, Attempt: ${currentAttempt}. Idempotency hit.`);

        await supabaseAdmin
          .from('transactions')
          .update({
            attempt_count: currentAttempt,
            metadata: updatedMetadata,
            updated_at: timestamp
          })
          .eq('id', ledgerId);

        return res.status(200).json({
          success: true,
          message: 'Webhook event already processed (idempotent)',
          provider_event_id: providerEventId,
          idempotency_key: idempotencyKey,
          receipt_status: 'RECEIVED',
          processing_status: 'PROCESSED'
        });
      }

      // Retry attempt: update record to RECEIVED / PENDING for re-processing
      await supabaseAdmin
        .from('transactions')
        .update({
          attempt_count: currentAttempt,
          receipt_status: 'RECEIVED',
          processing_status: 'PENDING',
          metadata: updatedMetadata,
          updated_at: timestamp
        })
        .eq('id', ledgerId);

    } else {
      const initialMetadata = {
        ingestion_mode: (req as any).ingestionMode || 'raw_stream',
        raw_body_bytes: rawBodyBuffer.length,
        retry_history: [{
          attempt: 1,
          received_at: timestamp,
          payload_hash: payloadHash
        }]
      };

      const { data: insertedLedger, error: ledgerErr } = await supabaseAdmin
        .from('transactions')
        .insert({
          type: 'webhook_event',
          provider: 'asaas',
          provider_event_id: providerEventId,
          idempotency_key: idempotencyKey,
          receipt_status: 'RECEIVED',
          processing_status: 'PENDING',
          attempt_count: 1,
          raw_payload: payload,
          payload_hash: payloadHash,
          processor_version: '1.0.0',
          metadata: initialMetadata
        })
        .select('id')
        .single();

      if (ledgerErr) {
        console.error(`❌ [EVENT LEDGER] Critical error persisting event ledger: ${ledgerErr.message}`);
        return res.status(500).json({ error: 'Internal Server Error: Event Ledger ingestion failed' });
      }

      ledgerId = insertedLedger.id;
    }

    const finalizeLedger = async (status: 'PROCESSED' | 'FAILED' | 'IGNORED' | 'RECONCILIATION_PENDING', errorMsg?: string) => {
      try {
        await supabaseAdmin
          .from('transactions')
          .update({
            processing_status: status,
            processed_at: new Date().toISOString(),
            ...(errorMsg ? { processing_error: errorMsg } : {})
          })
          .eq('id', ledgerId);
      } catch (err) {
        console.error(`⚠️ [EVENT LEDGER] Failed to update processing status to ${status}:`, err);
      }
    };

    // Invoke PaymentStateService (Etapa 5) & SettlementService (Etapa 6)
    if (paymentId && event.toUpperCase().startsWith('PAYMENT_')) {
      const externalRef = payload.payment?.externalReference || '';
      const isTip = externalRef.startsWith('tip:');

      if (isTip) {
        console.log(`[ASAAS WEBHOOK] Processando confirmação de caixinha: ${externalRef}`);
        const parts = externalRef.split(':');
        const appointmentId = parts[1] || null;
        const transactionId = parts[2] || null;

        if (!appointmentId || !transactionId) {
          console.error(`❌ [ASAAS WEBHOOK] Caixinha com referência inválida: ${externalRef}`);
          await finalizeLedger('FAILED', 'Invalid tip externalReference format');
          return res.status(400).json({ error: 'Invalid tip externalReference format' });
        }

        // Fetch transaction to ensure it exists and prevent duplicates
        const { data: tx, error: fetchTxError } = await supabaseAdmin
          .from('transactions')
          .select('id, status, amount, student_id, instructor_id, metadata')
          .eq('id', transactionId)
          .maybeSingle();

        if (fetchTxError) {
          console.error(`❌ [ASAAS WEBHOOK] Error fetching transaction ${transactionId}:`, fetchTxError.message);
          await finalizeLedger('FAILED', fetchTxError.message);
          return res.status(500).json({ error: 'Database error fetching transaction' });
        }

        if (!tx) {
          console.error(`❌ [ASAAS WEBHOOK] Nenhuma transação provisória encontrada com ID ${transactionId}.`);
          await finalizeLedger('FAILED', 'Provisional transaction not found');
          return res.status(404).json({ error: 'Provisional transaction not found' });
        }

        if (tx.status === 'completed') {
          console.log(`ℹ️ [ASAAS WEBHOOK] Caixinha transação ${transactionId} já está concluída (idempotente).`);
          await finalizeLedger('PROCESSED');
          return res.status(200).json({
            success: true,
            message: 'Caixinha already completed (idempotent)',
            event,
            timestamp
          });
        }

        const isReceivedEvent = ['PAYMENT_RECEIVED', 'PAYMENT_DUNNING_RECEIVED'].includes(event.toUpperCase());

        if (!isReceivedEvent) {
          console.log(`ℹ️ [ASAAS WEBHOOK] Caixinha transação ${transactionId} evento ${event} registrado como pendente (aguardando PAYMENT_RECEIVED).`);
          const existingMetadata = tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
          const updatedMetadata = {
            ...existingMetadata,
            asaas_payment_id: paymentId,
            payment_type: 'PIX_TIP'
          };

          await supabaseAdmin
            .from('transactions')
            .update({
              provider_payment_id: paymentId,
              metadata: updatedMetadata
            })
            .eq('id', transactionId);

          await finalizeLedger('PROCESSED');
          return res.status(200).json({
            success: true,
            message: `Caixinha payment event ${event} registered as pending`,
            event,
            timestamp
          });
        }

        const grossAmountCents = tx.amount || Math.round((payload.payment?.value || 0) * 100);
        const netValue = payload.payment?.netValue;
        const netAmountCents = netValue !== undefined ? Math.round(netValue * 100) : grossAmountCents;
        const asaasFeeCents = grossAmountCents - netAmountCents;

        const existingMetadata = tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
        const updatedMetadata = {
          ...existingMetadata,
          asaas_payment_id: paymentId,
          asaas_fee_cents: asaasFeeCents,
          payment_type: 'PIX_TIP'
        };

        console.log('[AUDIT TX]', {
          transactionId,
          txId: tx.id,
          providerPaymentId: paymentId,
          status: tx.status,
          externalReference: externalRef
        });

        // Update the transaction status to 'completed'
        const updateTxResponse = await supabaseAdmin
          .from('transactions')
          .update({
            status: 'completed',
            provider_payment_id: paymentId,
            event_date: new Date().toISOString(),
            net_amount: netAmountCents,
            platform_fee: 0,
            metadata: updatedMetadata
          })
          .eq('id', transactionId)
          .select();

        console.log('[AUDIT UPDATE TRANSACTIONS]', {
          transactionId,
          response: updateTxResponse
        });

        console.log('[AUDIT UPDATE RESULT]', {
          affectedRows: updateTxResponse.data?.length ?? 0,
          returnedIds: updateTxResponse.data?.map((r: any) => r.id),
          error: updateTxResponse.error
        });

        const updateTxError = updateTxResponse.error;

        if (updateTxError) {
          console.error(`❌ [ASAAS WEBHOOK] Error completing tip transaction ${transactionId}:`, updateTxError.message);
          await finalizeLedger('FAILED', updateTxError.message);
          return res.status(500).json({ error: 'Database error completing transaction' });
        }

        console.log(`✅ [ASAAS WEBHOOK] Caixinha transação ${transactionId} marcada como completed com sucesso!`);

        // Forward tip payment to official SettlementService
        try {
          await SettlementService.processSettlement(
            {
              origin: 'TIP',
              providerPaymentId: paymentId,
              settlementType: SettlementType.PAYMENT,
              grossAmount: grossAmountCents,
              netAmount: netAmountCents,
              feeAmount: asaasFeeCents,
              platformFee: 0,
              instructorAmount: netAmountCents,
              studentId: tx.student_id,
              instructorId: tx.instructor_id,
              appointmentId: appointmentId,
              settledAt: new Date().toISOString(),
              eventLedgerId: ledgerId
            },
            supabaseAdmin
          );
          console.log(`✅ [ASAAS WEBHOOK] Caixinha settlement processado com sucesso no SettlementService!`);
        } catch (settleErr) {
          console.error(`⚠️ [ASAAS WEBHOOK] Erro ao processar settlement da caixinha no SettlementService:`, settleErr);
        }

        // Send a beautiful notification to the instructor
        const amountCents = tx.amount || Math.round((payload.payment?.value || 0) * 100);
        const amountFormatted = (amountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        const instructorId = tx.instructor_id;

        if (instructorId) {
          try {
            // 1. Idempotency Check using notification_logs
            const { error: logError } = await supabaseAdmin
              .from('notification_logs')
              .insert({
                appointment_id: appointmentId,
                status: 'tip',
                target_user_id: instructorId
              });

            if (logError) {
              if (logError.code === '23505') {
                console.log(`ℹ️ [ASAAS WEBHOOK] Notificação de caixinha já enviada para o appointment ${appointmentId} (idempotente via notification_logs).`);
                await finalizeLedger('PROCESSED');
                return res.status(200).json({
                  success: true,
                  message: 'Tip notification already processed (idempotency)',
                  event,
                  timestamp
                });
              }
              throw logError;
            }

            // 2. Insert In-App Notification and auto-trigger Push via NotificationService
            await NotificationService.sendTip({
              instructorId,
              amountFormatted,
              appointmentId
            });
            console.log(`✅ [ASAAS WEBHOOK] Notificação de caixinha processada via NotificationService para o instrutor ${instructorId}`);

          } catch (notifErr) {
            console.error(`⚠️ [ASAAS WEBHOOK] Error processing tip notification & push:`, notifErr);
          }
        }

        await finalizeLedger('PROCESSED');
        return res.status(200).json({
          success: true,
          message: 'Caixinha payment confirmed and processed successfully',
          event,
          timestamp
        });
      }

      const instNumber = payload.payment?.installmentNumber || 1;

      // STRICT HARDENING: Check presence of Official Contract (payment_installments)
      let officialInstRecord: {
        instructor_id: string | null;
        student_id: string | null;
        appointment_id: string | null;
        gross_amount: number;
        net_amount: number;
        platform_fee: number;
      } | null = null;

      if (paymentId) {
        const { data: instRec } = await supabaseAdmin
          .from('payment_installments')
          .select('instructor_id, student_id, appointment_id, gross_amount, net_amount, platform_fee')
          .eq('provider_payment_id', paymentId)
          .eq('installment_number', instNumber)
          .limit(1)
          .maybeSingle();

        if (instRec) {
          officialInstRecord = instRec;
        } else {
          const { data: instRecAny } = await supabaseAdmin
            .from('payment_installments')
            .select('instructor_id, student_id, appointment_id, gross_amount, net_amount, platform_fee')
            .eq('provider_payment_id', paymentId)
            .limit(1)
            .maybeSingle();

          if (instRecAny) {
            officialInstRecord = instRecAny;
          }
        }
      }

      // IF OFFICIAL CONTRACT DOES NOT EXIST -> RETAIN FOR RECONCILIATION
      if (!officialInstRecord) {
        const reconciliationErrorMsg = `Missing official contract in payment_installments for provider_payment_id '${paymentId}' (installment: ${instNumber}). Event retained for reconciliation.`;
        console.warn(`⚠️ [RECONCILIATION REQUIRED] ${reconciliationErrorMsg}`, {
          provider_payment_id: paymentId,
          installment_number: instNumber,
          provider_event_id: providerEventId,
          event_type: event,
          timestamp: timestamp
        });

        await finalizeLedger('RECONCILIATION_PENDING', reconciliationErrorMsg);

        return res.status(200).json({
          success: true,
          message: 'Webhook event retained for reconciliation: missing payment_installments contract',
          provider_payment_id: paymentId,
          installment_number: instNumber,
          provider_event_id: providerEventId,
          event_type: event,
          processing_status: 'RECONCILIATION_PENDING',
          reason: reconciliationErrorMsg
        });
      }

      // OFFICIAL CONTRACT CONFIRMED -> Strictly use contractual amounts from payment_installments
      const grossCents = officialInstRecord.gross_amount;
      const netCents = officialInstRecord.net_amount;
      const platformFeeCents = officialInstRecord.platform_fee;

      let resolvedInstructorId: string | undefined = payload.payment?.metadata?.instructor_id || officialInstRecord.instructor_id || undefined;
      let resolvedStudentId: string | undefined = payload.payment?.metadata?.student_id || officialInstRecord.student_id || undefined;
      let resolvedAppointmentId: string | undefined = payload.payment?.metadata?.appointment_id || officialInstRecord.appointment_id || undefined;

      if (!resolvedInstructorId && paymentId) {
        const { data: aptRec } = await supabaseAdmin
          .from('appointments')
          .select('instructor_id, student_id, id')
          .eq('provider_payment_id', paymentId)
          .limit(1)
          .maybeSingle();

        if (aptRec) {
          resolvedInstructorId = aptRec.instructor_id || undefined;
          resolvedStudentId = aptRec.student_id || undefined;
          resolvedAppointmentId = aptRec.id || undefined;
        }
      }

      try {
        const stateResult = await PaymentStateService.processEvent({
          providerPaymentId: paymentId,
          providerEventId: providerEventId,
          eventType: event,
          installmentNumber: payload.payment?.installmentNumber || null,
          externalReference: payload.payment?.externalReference || null,
          payload: payload as AsaasWebhookPayload,
          ledgerId: ledgerId,
          timestamp: timestamp
        }, supabaseAdmin);
        console.log(`ℹ️ [PaymentStateService] Executed transition for ${paymentId}: ${stateResult.outcome} (${stateResult.oldState} -> ${stateResult.newState})`);

        // OFFICIAL SETTLEMENT SERVICE TRIGGER MATRIX (Etapa 6)
        // Note: Asaas revenue recognition strictly requires financial availability (PAYMENT_RECEIVED / RECEIVED).
        // PAYMENT_CONFIRMED keeps split in AWAITING_CREDIT and money is not credited yet, so settlement is NOT executed on CONFIRMED.
        if (stateResult.outcome === TransitionOutcome.TRANSITION_EXECUTED) {
          if (stateResult.newState === 'RECEIVED') {
            const payment = payload.payment;
            const feeAmount =
              payment?.value !== undefined && payment?.netValue !== undefined
                ? Math.max(
                      0,
                      Math.round(payment.value * 100) -
                      Math.round(payment.netValue * 100)
                  )
                : (payment?.feeValue !== undefined ? Math.round(payment.feeValue * 100) : undefined);

            const settleRes = await SettlementService.processSettlement({
              providerPaymentId: paymentId,
              installmentNumber: instNumber,
              providerSettlementId: payload.payment?.id || paymentId,
              settlementType: SettlementType.PAYMENT,
              grossAmount: grossCents,
              netAmount: netCents,
              platformFee: platformFeeCents,
              feeAmount,
              paymentMethod: payload.payment?.billingType,
              settledAt: payload.payment?.paymentDate || payload.payment?.clientPaymentDate || timestamp,
              eventLedgerId: ledgerId,
              payload: payload
            }, supabaseAdmin);
            console.log(`ℹ️ [SettlementService] Settlement executed for ${paymentId}: ${settleRes.outcome} (key: ${settleRes.settlementKey})`);

          } else if (stateResult.newState === 'REFUNDED' || stateResult.newState === 'CHARGEBACK') {
            const sType = stateResult.newState === 'CHARGEBACK' ? SettlementType.CHARGEBACK : SettlementType.REFUND;
            const settleRes = await SettlementService.processRefundSettlement({
              providerPaymentId: paymentId,
              installmentNumber: instNumber,
              providerSettlementId: payload.payment?.id ? `${payload.payment.id}_${sType.toLowerCase()}` : undefined,
              settlementType: sType,
              grossAmount: grossCents,
              netAmount: netCents,
              platformFee: platformFeeCents,
              paymentMethod: payload.payment?.billingType,
              settledAt: timestamp,
              eventLedgerId: ledgerId,
              payload: payload
            }, supabaseAdmin);
            console.log(`ℹ️ [SettlementService] Refund Settlement executed for ${paymentId}: ${settleRes.outcome} (key: ${settleRes.settlementKey})`);
          }
        }
      } catch (stateErr: any) {
        console.warn(`⚠️ [PaymentStateService/SettlementService] Processing error:`, stateErr?.message || stateErr);
      }
    }

    // Procesasmento exclusivo do evento ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED
    if (event === 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED') {
      if (!accountId) {
        console.error('❌ Asaas Webhook Error: Event ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED received but accountId is missing.');
        await finalizeLedger('FAILED', 'Bad Request: accountId/account object is missing from payload');
        return res.status(400).json({ error: 'Bad Request: accountId/account object is missing from payload' });
      }

      console.log(`🔍 [ASAAS WEBHOOK] Locating instructor with provider_account_id: ${accountId}`);
      const { data: instructor, error: selectError } = await supabaseAdmin
        .from('instructors')
        .select('id, provider_status, provider_onboarding_completed, payouts_enabled')
        .eq('provider_account_id', accountId)
        .maybeSingle();

      if (selectError) {
        console.error(`❌ [ASAAS WEBHOOK] Error retrieving instructor metadata: ${selectError.message}`);
        await finalizeLedger('FAILED', selectError.message);
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      if (!instructor) {
        console.warn(`⚠️ [ASAAS WEBHOOK] No instructor found registered with provider_account_id: ${accountId}`);
        await finalizeLedger('FAILED', `Not Found: No instructor found for provider_account_id ${accountId}`);
        return res.status(404).json({ error: `Not Found: No instructor found for provider_account_id ${accountId}` });
      }

      // Check for duplication / idempotency
      if (
        instructor.provider_status === 'approved' &&
        instructor.provider_onboarding_completed === true &&
        instructor.payouts_enabled === true
      ) {
        console.log(`ℹ️ [ASAAS WEBHOOK] Duplicate event ignored. Instructor ${instructor.id} already approved with active payouts.`);
        await finalizeLedger('PROCESSED');
        return res.status(200).json({
          success: true,
          message: 'Webhook processed (no-op/idempotent): Instructor status already approved',
          event,
          timestamp
        });
      }

      console.log(`✍️ [ASAAS WEBHOOK] Updating instructor id=${instructor.id} -> approved & payouts enabled`);
      const { error: updateError } = await supabaseAdmin
        .from('instructors')
        .update({
          provider_status: 'approved',
          provider_onboarding_completed: true,
          payouts_enabled: true
         })
        .eq('id', instructor.id);

      if (updateError) {
        console.error(`❌ [ASAAS WEBHOOK] Error updating instructor: ${updateError.message}`);
        await finalizeLedger('FAILED', updateError.message);
        return res.status(500).json({ error: 'Internal Server Error: Unable to update instructor status' });
      }

      console.log(`✅ [ASAAS WEBHOOK] Successfully processed ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED status update for instructor ID: ${instructor.id}`);
      await finalizeLedger('PROCESSED');
      return res.status(200).json({
        success: true,
        message: 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED processed successfully',
        event,
        timestamp
      });
    } else if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_UPDATED'].includes(event.toUpperCase())) {
      const currentPaymentId = payload.payment?.id || payload.paymentId || paymentId;
      let groupId = payload.payment?.externalReference;
      const paymentStatus = payload.payment?.status;

      // If PAYMENT_UPDATED, we only want to mark as paid if the status is actually RECEIVED or CONFIRMED or RECEIVED_IN_CASH
      if (event.toUpperCase() === 'PAYMENT_UPDATED' && !['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(paymentStatus?.toUpperCase())) {
        console.log(`ℹ️ [ASAAS WEBHOOK] Payment updated but status is ${paymentStatus}. Not confirming booking yet.`);
        await finalizeLedger('IGNORED');
        return res.status(200).json({
          success: true,
          message: 'Updated status ignored (not paid yet)',
          event,
          timestamp
        });
      }

      if (!currentPaymentId) {
        console.error('❌ Asaas Webhook: Payment ID missing for payment event.');
        await finalizeLedger('FAILED', 'Missing paymentId');
        return res.status(400).json({ error: 'Missing paymentId' });
      }

      // Fallback search to find groupId if not present/sent in externalReference
      if (!groupId) {
        const { data: foundApts } = await supabaseAdmin
          .from('appointments')
          .select('group_id')
          .eq('provider_payment_id', currentPaymentId)
          .limit(1);
        if (foundApts && foundApts.length > 0) {
          groupId = foundApts[0].group_id;
        }
      }

      if (!groupId) {
        console.warn(`⚠️ [ASAAS WEBHOOK] No group_id found for payment identifier: ${currentPaymentId}`);
        await finalizeLedger('PROCESSED');
        return res.status(200).json({
          success: true,
          message: 'Processed but no associated booking found',
          event,
          timestamp
        });
      }

      console.log(`✍️ [ASAAS WEBHOOK] Confirming asaas booking group: ${groupId} (payment: ${currentPaymentId})`);

      // Verify if any appointment in this group is already expired, cancelled, or rejected
      const { data: existingApts, error: fetchAptsError } = await supabaseAdmin
        .from('appointments')
        .select('status')
        .eq('group_id', groupId);

      if (fetchAptsError) {
        console.error(`❌ [ASAAS WEBHOOK] Error querying appointments for validation:`, fetchAptsError.message);
        await finalizeLedger('FAILED', fetchAptsError.message);
        return res.status(500).json({ error: 'Database verification failed' });
      }

      if (!existingApts || existingApts.length === 0) {
        console.warn(`⚠️ [ASAAS WEBHOOK] No appointments found for group: ${groupId}`);
        await finalizeLedger('PROCESSED');
        return res.status(200).json({
          success: true,
          message: 'No appointments found',
          event,
          timestamp
        });
      }

      const hasInvalidStatus = existingApts.some(apt => ['expired', 'cancelled', 'rejected'].includes(apt.status));
      if (hasInvalidStatus) {
        console.warn(`⚠️ Pagamento recebido para reserva expirada. Necessária análise manual. (Grupo: ${groupId})`);
        await finalizeLedger('PROCESSED');
        return res.status(200).json({
          success: true,
          message: 'Pagamento recebido para reserva expirada. Necessária análise manual.',
          event,
          timestamp
        });
      }

      // Update appointments payload (pending approval instead of directly confirmed)
      const updatePayload = {
        status: 'pending_approval',
        payment_status: 'paid',
        updated_at: new Date().toISOString()
      };

      const { data: updatedApts, error: updateErr } = await supabaseAdmin
        .from('appointments')
        .update(updatePayload)
        .eq('group_id', groupId)
        .in('status', ['pending', 'pending_approval', 'awaiting_payment', 'reserved'])
        .select('id, student_id, instructor_id, price');

      if (updateErr) {
        console.error(`❌ [ASAAS WEBHOOK] Error updating appointments for group ${groupId}:`, updateErr.message);
        await finalizeLedger('FAILED', updateErr.message);
        return res.status(500).json({ error: 'Database update failed' });
      }

      const rowsCount = updatedApts?.length || 0;
      console.log(`✅ [ASAAS WEBHOOK] Successfully updated ${rowsCount} appointments to pending_approval.`);

      if (rowsCount > 0) {
        const firstApt = updatedApts[0];
        
        // Log into transactions table
        try {
          for (const apt of updatedApts) {
            // Anti-Downgrade Protection
            const { data: existingTx } = await supabaseAdmin
              .from('transactions')
              .select('status')
              .eq('appointment_id', apt.id)
              .eq('type', 'lesson_payment')
              .maybeSingle();

            if (existingTx?.status === 'completed') {
              console.log(`ℹ️ [ASAAS WEBHOOK] Transaction for appointment ${apt.id} is already completed. Skipping.`);
              continue;
            }

            const gross_amount = apt.price || 0;
            const platform_fee = Math.floor(gross_amount * 0.1);
            const net_amount = gross_amount - platform_fee;

            const { error: txErr } = await supabaseAdmin
              .from('transactions')
              .upsert({
                appointment_id: apt.id,
                student_id: apt.student_id,
                instructor_id: apt.instructor_id,
                type: 'lesson_payment',
                amount: gross_amount,
                gross_amount: gross_amount,
                platform_fee: platform_fee,
                net_amount: net_amount,
                status: 'pending',
                provider_name: 'asaas',
                provider_payment_id: currentPaymentId,
                event_date: new Date().toISOString(),
                description: 'Pagamento de Aula via Asaas',
                metadata: { 
                  provider: 'asaas', 
                  pay_event: event,
                  ...(payload?.payment?.metadata || {})
                }
              }, { onConflict: 'appointment_id,type' });

            if (txErr) {
              console.error(`❌ [ASAAS WEBHOOK] Error inserting transaction for appointment ${apt.id}:`, txErr.message);
            } else {
              console.log(`✅ [ASAAS WEBHOOK] Successfully logged pending transaction for appointment ${apt.id}`);
            }
          }
        } catch (txErr) {
          console.error(`⚠️ [ASAAS WEBHOOK] Error logging transaction:`, txErr);
        }

        // Record Cash Flow Settlement in payment_installments & payment_settlements
        // Revenue recognition occurs ONLY when funds are actually received (PAYMENT_RECEIVED / PAYMENT_DUNNING_RECEIVED)
        try {
          const isReceivedEvent = ['PAYMENT_RECEIVED', 'PAYMENT_DUNNING_RECEIVED'].includes(event.toUpperCase());
          if (isReceivedEvent) {
            const instNum = payload.payment?.installmentNumber || 1;
            const totalInst = payload.payment?.installmentCount || 1;
            const payDate = payload.payment?.paymentDate || payload.payment?.clientPaymentDate || new Date().toISOString();

            const { data: existingInstRecord } = await supabaseAdmin
              .from('payment_installments')
              .select('gross_amount, net_amount, platform_fee, fee_amount')
              .eq('provider_payment_id', currentPaymentId)
              .eq('installment_number', instNum)
              .limit(1)
              .maybeSingle();

            if (existingInstRecord) {
              await InstallmentService.recordPaymentSettlement(supabaseAdmin, {
                providerPaymentId: currentPaymentId,
                installmentNumber: instNum,
                totalInstallments: totalInst,
                grossAmountCents: existingInstRecord.gross_amount,
                netAmountCents: existingInstRecord.net_amount,
                platformFeeCents: existingInstRecord.platform_fee,
                feeAmountCents: existingInstRecord.fee_amount || 0,
                paymentDate: payDate,
                groupId: groupId,
                appointmentId: firstApt.id,
                studentId: firstApt.student_id,
                instructorId: firstApt.instructor_id,
                providerSettlementId: payload.payment?.id || currentPaymentId,
              });
            } else {
              console.warn(`⚠️ [ASAAS WEBHOOK] recordPaymentSettlement skipped: payment_installments official contract missing for ${currentPaymentId}`);
            }
          } else {
            console.log(`ℹ️ [ASAAS WEBHOOK] Skipping cash flow settlement for event ${event} (settlement occurs only on PAYMENT_RECEIVED).`);
          }
        } catch (settleErr) {
          console.error(`⚠️ [ASAAS WEBHOOK] Error recording payment settlement:`, settleErr);
        }

        // Notify instructor about new booking request pending approval (Idempotent)
        const instructorId = firstApt.instructor_id;
        if (instructorId) {
          try {
            // Find student name
            let studentName = 'Um aluno';
            if (firstApt.student_id) {
              const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('full_name')
                .eq('id', firstApt.student_id)
                .maybeSingle();
              if (profile?.full_name) {
                studentName = profile.full_name;
              }
            }

            // Find combo count
            let comboCount = updatedApts ? updatedApts.length : 1;

            await NotificationService.sendBookingRequest({
              instructorId,
              studentName,
              comboCount,
              groupId: groupId || firstApt.id
            });
          } catch (notifErr) {
            console.error(`⚠️ [ASAAS WEBHOOK] Error sending notification:`, notifErr);
          }
        }
      }

      await finalizeLedger('PROCESSED');
      return res.status(200).json({
        success: true,
        message: 'Payment event processed successfully',
        event,
        timestamp
      });
    } else if (event.toUpperCase() === 'PAYMENT_REFUND_IN_PROGRESS') {
      const currentPaymentId = payload.payment?.id || payload.paymentId || paymentId;
      if (!currentPaymentId) {
        await finalizeLedger('FAILED', 'Missing paymentId');
        return res.status(400).json({ error: 'Missing paymentId' });
      }

      // Reconcile reconcilable RefundOperations: transition REQUESTED -> PENDING
      const reconcilableOps = await RefundOperationRepository.getReconcilableOperations(supabaseAdmin, 'asaas', currentPaymentId);
      for (const op of reconcilableOps) {
        if (op.status === 'REQUESTED') {
          try {
            await RefundOperationRepository.reconcileTransition(supabaseAdmin, op.id, op.version, 'PENDING', {
              sent_at: new Date().toISOString(),
              metadata: { ...(op.metadata || {}), in_progress_event_at: new Date().toISOString() }
            });
          } catch (trErr) {
            console.warn(`[ASAAS WEBHOOK] Could not transition op ${op.id} to PENDING:`, trErr);
          }
        }
      }

      const { data: apts } = await supabaseAdmin
        .from('appointments')
        .select('id')
        .or(`provider_payment_id.eq.${currentPaymentId},payment_intent_id.eq.${currentPaymentId}`);
      for (const apt of apts || []) {
        await supabaseAdmin.from('appointments').update({
          payment_status: 'refund_requested',
          updated_at: new Date().toISOString()
        }).eq('id', apt.id);
      }
      await finalizeLedger('PROCESSED');
      return res.status(200).json({ success: true, message: 'Refund in progress recorded', event, timestamp });
    } else if (['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED'].includes(event.toUpperCase())) {
      const isPartialRefundEvent = event.toUpperCase() === 'PAYMENT_PARTIALLY_REFUNDED';
      const currentPaymentId = payload.payment?.id || payload.paymentId || paymentId;

      if (!currentPaymentId) {
        console.error('❌ Asaas Webhook: Payment ID missing for refund event.');
        await finalizeLedger('FAILED', 'Missing paymentId');
        return res.status(400).json({ error: 'Missing paymentId' });
      }

      console.log(`🔍 [ASAAS WEBHOOK] Refund event ${event} received for payment ${currentPaymentId}`);

      const { data: apts, error: fetchErr } = await supabaseAdmin
        .from('appointments')
        .select('id, status, payment_status, group_id')
        .or(`provider_payment_id.eq.${currentPaymentId},payment_intent_id.eq.${currentPaymentId}`);

      if (fetchErr) {
        console.error(`❌ [ASAAS WEBHOOK] Error querying appointments for refund event:`, fetchErr.message);
        await finalizeLedger('FAILED', fetchErr.message);
        return res.status(500).json({ error: 'Database verification failed' });
      }

      // Reconcile RefundOperation(s) with actual refund items
      const reconcilableOps = await RefundOperationRepository.getReconcilableOperations(supabaseAdmin, 'asaas', currentPaymentId);
      const rawRefunds = payload.payment?.refunds;
      const refundItems = Array.isArray(rawRefunds) && rawRefunds.length > 0
        ? rawRefunds
        : (payload.refund ? [payload.refund] : []);

      let matchedOpCount = 0;
      let conflictCount = 0;

      if (reconcilableOps.length > 0) {
        if (refundItems.length > 0) {
          for (const item of refundItems) {
            const itemStatus = String(item.status || 'DONE').toUpperCase();
            if (!['DONE', 'REFUNDED', 'COMPLETED'].includes(itemStatus)) continue;

            const itemValueCents = Math.round(Number(item.value || 0) * 100);
            const providerRefundId = item.id || null;

            // Match candidates
            const candidateOps = reconcilableOps.filter(op =>
              (providerRefundId && (op.provider_refund_id === providerRefundId || op.metadata?.provider_refund_id === providerRefundId)) ||
              (op.requested_amount_cents === itemValueCents)
            );

            if (candidateOps.length === 1) {
              const matched = candidateOps[0];
              const targetStatus = itemValueCents >= matched.requested_amount_cents ? 'COMPLETED' : 'PARTIALLY_COMPLETED';
              try {
                await RefundOperationRepository.reconcileTransition(supabaseAdmin, matched.id, matched.version, targetStatus, {
                  completed_amount_cents: itemValueCents,
                  provider_refund_id: providerRefundId || matched.provider_refund_id,
                  metadata: { ...(matched.metadata || {}), reconciled_via_webhook: true, event_id: payload.id || null }
                });
                matchedOpCount++;
              } catch (trErr) {
                console.warn(`[ASAAS WEBHOOK] Transition error for matched op ${matched.id}:`, trErr);
              }
            } else if (candidateOps.length > 1) {
              // Ambiguous match across multiple operations with exact same amount -> CONFLICT
              console.warn(`⚠️ [ASAAS WEBHOOK] Multiple candidate operations match refund item ${itemValueCents} cents for payment ${currentPaymentId}. Marking CONFLICT.`);
              for (const op of candidateOps) {
                try {
                  await RefundOperationRepository.reconcileTransition(supabaseAdmin, op.id, op.version, 'CONFLICT', {
                    metadata: { ...(op.metadata || {}), conflict_reason: 'Ambiguous match across multiple operations with same amount' }
                  });
                  conflictCount++;
                } catch (trErr) {
                  console.warn(`[ASAAS WEBHOOK] Error setting CONFLICT on op ${op.id}:`, trErr);
                }
              }
            }
          }
        } else if (reconcilableOps.length === 1 && !isPartialRefundEvent) {
          // Single candidate operation and payment fully refunded -> Unequivocal match
          const singleOp = reconcilableOps[0];
          try {
            await RefundOperationRepository.reconcileTransition(supabaseAdmin, singleOp.id, singleOp.version, 'COMPLETED', {
              completed_amount_cents: singleOp.requested_amount_cents,
              metadata: { ...(singleOp.metadata || {}), reconciled_via_webhook: true, event_id: payload.id || null }
            });
            matchedOpCount++;
          } catch (trErr) {
            console.warn(`[ASAAS WEBHOOK] Transition error for single op ${singleOp.id}:`, trErr);
          }
        } else if (reconcilableOps.length > 1 && !isPartialRefundEvent) {
          // Multiple candidate operations without refund items breakdown -> CONFLICT
          console.warn(`⚠️ [ASAAS WEBHOOK] Multiple candidate operations (${reconcilableOps.length}) for payment ${currentPaymentId} without item breakdown. Marking CONFLICT.`);
          for (const op of reconcilableOps) {
            try {
              await RefundOperationRepository.reconcileTransition(supabaseAdmin, op.id, op.version, 'CONFLICT', {
                metadata: { ...(op.metadata || {}), conflict_reason: 'Multiple operations exist for payment without item breakdown' }
              });
              conflictCount++;
            } catch (trErr) {
              console.warn(`[ASAAS WEBHOOK] Error setting CONFLICT on op ${op.id}:`, trErr);
            }
          }
        }
      }

      // Update appointments and transactions based on reconciled scope
      if (Array.isArray(apts) && apts.length > 0) {
        for (const apt of apts) {
          const newStatus = apt.status === 'cancelling' ? 'cancelled' : apt.status;
          await supabaseAdmin
            .from('appointments')
            .update({
              status: newStatus,
              payment_status: isPartialRefundEvent ? 'refund_requested' : 'refunded',
              updated_at: new Date().toISOString()
            })
            .eq('id', apt.id);
        }
      }

      try {
        await supabaseAdmin
          .from('transactions')
          .update({ status: isPartialRefundEvent ? 'pending' : 'completed' })
          .eq('provider_payment_id', currentPaymentId)
          .eq('type', 'refund');

        await supabaseAdmin
          .from('transactions')
          .update({ status: 'failed' })
          .eq('provider_payment_id', currentPaymentId)
          .eq('type', 'lesson_payment');
      } catch (txErr) {
        console.warn(`⚠️ [ASAAS WEBHOOK] Error updating transaction statuses on refund:`, txErr);
      }

      try {
        if (isPartialRefundEvent) {
          await finalizeLedger('RECONCILIATION_PENDING', 'Partial refund recorded pending reconciliation');
          return res.status(200).json({
            success: true,
            message: 'Partial refund recorded pending reconciliation',
            event,
            timestamp
          });
        }

        const instNum = payload.payment?.installmentNumber || 1;
        const refundVal = Math.round((payload.payment?.value || 0) * 100);
        const refundGroupId = apts && apts.length > 0 ? apts[0].group_id : null;
        const providerSettlementId = `${currentPaymentId}_refund_${instNum}`;

        await InstallmentService.recordRefundSettlement(supabaseAdmin, {
          providerPaymentId: currentPaymentId,
          groupId: refundGroupId,
          installmentNumber: instNum,
          refundAmountCents: refundVal,
          providerSettlementId: providerSettlementId,
          refundDate: new Date().toISOString()
        });
      } catch (refErr) {
        console.error(`⚠️ [ASAAS WEBHOOK] Error recording refund settlement:`, refErr);
      }

      await finalizeLedger('PROCESSED');
      return res.status(200).json({
        success: true,
        message: 'Refund event reconciled successfully',
        event,
        matchedOperations: matchedOpCount,
        conflicts: conflictCount,
        timestamp
      });
    } else if (event.toUpperCase() === 'PAYMENT_REFUND_DENIED') {
      const currentPaymentId = payload.payment?.id || payload.paymentId || paymentId;
      const denialReason = payload.additionalInfo?.denialReason || payload.payment?.denialReason || payload.denialReason || payload.payment?.additionalInfo?.denialReason || 'Falha ao processar a transferência.';

      if (!currentPaymentId) {
        console.error('❌ Asaas Webhook: Payment ID missing for PAYMENT_REFUND_DENIED event.');
        await finalizeLedger('FAILED', 'Missing paymentId');
        return res.status(400).json({ error: 'Missing paymentId' });
      }

      console.log(`⚠️ [ASAAS WEBHOOK] Refund denied event received for payment ${currentPaymentId}. Reason: ${denialReason}`);

      // Reconcile RefundOperation(s) -> DENIED (without downgrading COMPLETED)
      const reconcilableOps = await RefundOperationRepository.getReconcilableOperations(supabaseAdmin, 'asaas', currentPaymentId);
      for (const op of reconcilableOps) {
        if (['REQUESTED', 'PENDING', 'UNKNOWN'].includes(op.status)) {
          try {
            await RefundOperationRepository.reconcileTransition(supabaseAdmin, op.id, op.version, 'DENIED', {
              metadata: { ...(op.metadata || {}), denial_reason: denialReason, denied_at: new Date().toISOString() }
            });
          } catch (trErr) {
            console.warn(`[ASAAS WEBHOOK] Could not transition op ${op.id} to DENIED:`, trErr);
          }
        }
      }

      const { data: apts } = await supabaseAdmin
        .from('appointments')
        .select('id, status, payment_status, group_id')
        .or(`provider_payment_id.eq.${currentPaymentId},payment_intent_id.eq.${currentPaymentId}`);

      try {
        const { data: refundTxs } = await supabaseAdmin
          .from('transactions')
          .select('id, metadata')
          .eq('provider_payment_id', currentPaymentId)
          .eq('type', 'refund');

        if (refundTxs && refundTxs.length > 0) {
          for (const tx of refundTxs) {
            const existingMeta = (tx.metadata && typeof tx.metadata === 'object') ? tx.metadata : {};
            await supabaseAdmin
              .from('transactions')
              .update({
                status: 'failed',
                metadata: {
                  ...existingMeta,
                  denial_reason: denialReason,
                  denialReason: denialReason,
                  denied_at: new Date().toISOString()
                }
              })
              .eq('id', tx.id);
          }
        }
      } catch (txErr) {
        console.warn(`⚠️ [ASAAS WEBHOOK] Error updating transaction status for PAYMENT_REFUND_DENIED:`, txErr);
      }

      if (apts && apts.length > 0) {
        for (const apt of apts) {
          await supabaseAdmin
            .from('appointments')
            .update({
              payment_status: 'failed',
              updated_at: new Date().toISOString()
            })
            .eq('id', apt.id);
        }
      }

      await finalizeLedger('PROCESSED');
      return res.status(200).json({
        success: true,
        message: 'PAYMENT_REFUND_DENIED event processed successfully',
        event,
        denialReason,
        timestamp
      });
    } else {
      console.log(`ℹ️ [ASAAS WEBHOOK] Event ${event} parsed but ignored.`);
      await finalizeLedger('IGNORED');
      return res.status(200).json({
        success: true,
        message: 'Event ignored',
        event,
        timestamp
      });
    }
  } catch (error: any) {
    console.error('⚠️ Error processing Asaas Webhook:', error.message);
    // Best-effort attempt to log ledger error if ledgerId was defined
    if (typeof ledgerId !== 'undefined') {
      try {
        await supabaseAdmin
          .from('transactions')
          .update({
            processing_status: 'FAILED',
            processing_error: error.message,
            processed_at: new Date().toISOString()
          })
          .eq('id', ledgerId);
      } catch (e) {
        // ignore secondary catch error
      }
    }
    return res.status(500).json({ error: `Internal Server Error: ${error.message}` });
  }
}
