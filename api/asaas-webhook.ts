import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { NotificationService } from '../lib/NotificationService.js';
import { InstallmentService } from '../lib/payments/InstallmentService.js';
import { PaymentStateService } from '../lib/payments/PaymentStateService.js';
import { AsaasWebhookPayload, TransitionOutcome } from '../lib/payments/PaymentStateTypes.js';
import { SettlementService } from '../lib/payments/SettlementService.js';
import { SettlementType } from '../lib/payments/SettlementTypes.js';
import { ProjectionService } from '../lib/payments/projections/ProjectionService.js';
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

    const finalizeLedger = async (status: 'PROCESSED' | 'FAILED' | 'IGNORED', errorMsg?: string) => {
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
        if (stateResult.outcome === TransitionOutcome.TRANSITION_EXECUTED) {
          const grossCents = Math.round((payload.payment?.value || 0) * 100);
          const netVal = payload.payment?.netValue;
          const netCents = netVal !== undefined ? Math.round(netVal * 100) : undefined;

          if (stateResult.newState === 'RECEIVED' || stateResult.newState === 'CONFIRMED') {
            const settleRes = await SettlementService.processSettlement({
              providerPaymentId: paymentId,
              installmentNumber: payload.payment?.installmentNumber || 1,
              providerSettlementId: payload.payment?.id || paymentId,
              settlementType: SettlementType.PAYMENT,
              grossAmount: grossCents,
              netAmount: netCents,
              feeAmount: payload.payment?.feeValue ? Math.round(payload.payment.feeValue * 100) : undefined,
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
              installmentNumber: payload.payment?.installmentNumber || 1,
              providerSettlementId: payload.payment?.id ? `${payload.payment.id}_${sType.toLowerCase()}` : undefined,
              settlementType: sType,
              grossAmount: grossCents,
              netAmount: netCents,
              paymentMethod: payload.payment?.billingType,
              settledAt: timestamp,
              eventLedgerId: ledgerId,
              payload: payload
            }, supabaseAdmin);
            console.log(`ℹ️ [SettlementService] Refund Settlement executed for ${paymentId}: ${settleRes.outcome} (key: ${settleRes.settlementKey})`);
          }

          // Trigger ProjectionService (Etapa 7)
          try {
            const grossCents = Math.round((payload.payment?.value || 0) * 100);
            const netCents = payload.payment?.netValue !== undefined ? Math.round(payload.payment.netValue * 100) : 0;
            const feeCents = payload.payment?.feeValue ? Math.round(payload.payment.feeValue * 100) : 0;

            let pType = ProjectionSourceEventType.STATE_TRANSITION;
            if (stateResult.newState === 'RECEIVED' || stateResult.newState === 'CONFIRMED') {
              pType = ProjectionSourceEventType.SETTLEMENT_EXECUTED;
            } else if (stateResult.newState === 'REFUNDED') {
              pType = ProjectionSourceEventType.SETTLEMENT_REFUND;
            } else if (stateResult.newState === 'CHARGEBACK') {
              pType = ProjectionSourceEventType.SETTLEMENT_CHARGEBACK;
            }

            await ProjectionService.update({
              eventType: pType,
              eventId: ledgerId || undefined,
              providerPaymentId: paymentId,
              grossAmount: grossCents,
              netAmount: netCents,
              platformFee: Math.max(0, grossCents - netCents - feeCents),
              feeAmount: feeCents,
              instructorAmount: netCents,
              status: stateResult.newState || undefined,
              settledAt: timestamp
            }, supabaseAdmin);
          } catch (projErr: any) {
            console.warn(`⚠️ [ProjectionService] Non-blocking projection error:`, projErr?.message || projErr);
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

      // Check if this is a caixinha (tip) payment
      const externalRef = payload.payment?.externalReference || groupId || '';
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

        const grossAmountCents = tx.amount || Math.round((payload.payment?.value || 0) * 100);
        const netValue = payload.payment?.netValue;
        const netAmountCents = netValue !== undefined ? Math.round(netValue * 100) : grossAmountCents;
        const asaasFeeCents = grossAmountCents - netAmountCents;

        const existingMetadata = tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
        const updatedMetadata = {
          ...existingMetadata,
          asaas_payment_id: currentPaymentId,
          asaas_fee_cents: asaasFeeCents,
          payment_type: 'PIX_TIP'
        };

        // Update the transaction status to 'completed'
        const { error: updateTxError } = await supabaseAdmin
          .from('transactions')
          .update({
            status: 'completed',
            provider_payment_id: currentPaymentId,
            event_date: new Date().toISOString(),
            net_amount: netAmountCents,
            platform_fee: 0,
            metadata: updatedMetadata
          })
          .eq('id', transactionId);

        if (updateTxError) {
          console.error(`❌ [ASAAS WEBHOOK] Error completing tip transaction ${transactionId}:`, updateTxError.message);
          await finalizeLedger('FAILED', updateTxError.message);
          return res.status(500).json({ error: 'Database error completing transaction' });
        }

        console.log(`✅ [ASAAS WEBHOOK] Caixinha transação ${transactionId} marcada como completed com sucesso!`);

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
        try {
          const grossVal = Math.round((payload.payment?.value || 0) * 100);
          const netVal = payload.payment?.netValue !== undefined 
            ? Math.round(payload.payment.netValue * 100) 
            : Math.round(grossVal * 0.90);
          const platformFeeVal = grossVal - netVal;
          const instNum = payload.payment?.installmentNumber || 1;
          const totalInst = payload.payment?.installmentCount || 1;
          const payDate = payload.payment?.paymentDate || payload.payment?.clientPaymentDate || new Date().toISOString();

          await InstallmentService.recordPaymentSettlement(supabaseAdmin, {
            providerPaymentId: currentPaymentId,
            installmentNumber: instNum,
            totalInstallments: totalInst,
            grossAmountCents: grossVal,
            netAmountCents: netVal,
            platformFeeCents: platformFeeVal,
            paymentDate: payDate,
            groupId: groupId,
            appointmentId: firstApt.id,
            studentId: firstApt.student_id,
            instructorId: firstApt.instructor_id,
            providerSettlementId: payload.payment?.id || currentPaymentId,
          });
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
    } else if (['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED'].includes(event.toUpperCase())) {
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

      if (!apts || apts.length === 0) {
        console.warn(`⚠️ [ASAAS WEBHOOK] No appointments found for refunded payment: ${currentPaymentId}`);
        await finalizeLedger('PROCESSED');
        return res.status(200).json({
          success: true,
          message: 'Refund event processed but no associated appointment found',
          event,
          timestamp
        });
      }

      const cancellingApts = apts.filter(a => a.status === 'cancelling');

      if (cancellingApts.length === 0) {
        console.log(`ℹ️ [ASAAS WEBHOOK] No appointments in 'cancelling' status for payment ${currentPaymentId} (already cancelled or not cancelling). Idempotent no-op.`);
        await finalizeLedger('PROCESSED');
        return res.status(200).json({
          success: true,
          message: 'Refund event processed (idempotent/no-op)',
          event,
          timestamp
        });
      }

      const { data: updatedApts, error: updateErr } = await supabaseAdmin
        .from('appointments')
        .update({
          status: 'cancelled',
          payment_status: 'refunded',
          updated_at: new Date().toISOString()
        })
        .or(`provider_payment_id.eq.${currentPaymentId},payment_intent_id.eq.${currentPaymentId}`)
        .eq('status', 'cancelling')
        .select('id');

      if (updateErr) {
        console.error(`❌ [ASAAS WEBHOOK] Error updating appointments to cancelled:`, updateErr.message);
        await finalizeLedger('FAILED', updateErr.message);
        return res.status(500).json({ error: 'Database update failed' });
      }

      console.log(`✅ [ASAAS WEBHOOK] Successfully reconciled ${updatedApts?.length || 0} appointment(s) from 'cancelling' to 'cancelled'.`);

      // Record Refund Settlement in payment_installments & payment_settlements
      try {
        const refundVal = Math.round((payload.payment?.value || 0) * 100);
        const refundGroupId = apts && apts.length > 0 ? apts[0].group_id : null;
        await InstallmentService.recordRefundSettlement(supabaseAdmin, {
          providerPaymentId: currentPaymentId,
          groupId: refundGroupId,
          installmentNumber: payload.payment?.installmentNumber,
          refundAmountCents: refundVal,
          providerSettlementId: payload.payment?.id ? `${payload.payment.id}_refund` : undefined,
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
