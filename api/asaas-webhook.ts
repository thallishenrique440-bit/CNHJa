import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

  try {
    const payload = req.body;
    
    // Parse fields safely
    const timestamp = new Date().toISOString();
    const event = payload?.event || 'UNKNOWN_EVENT';
    const accountId = payload?.account?.id || payload?.accountId || payload?.account || null;
    const paymentId = payload?.payment?.id || payload?.paymentId || null;
    const payloadBruto = JSON.stringify(payload);

    // 3. Registrar logs estruturados
    console.log('=== [ASAAS WEBHOOK EVENT RECEIVED] ===');
    console.log(`Timestamp:  ${timestamp}`);
    console.log(`Event:      ${event}`);
    console.log(`Account ID: ${accountId || 'N/A'}`);
    console.log(`Payment ID: ${paymentId || 'N/A'}`);
    console.log(`Payload Bruto:\n${payloadBruto}`);
    console.log('=======================================');

    // Procesasmento exclusivo do evento ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED
    if (event === 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED') {
      if (!accountId) {
        console.error('❌ Asaas Webhook Error: Event ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED received but accountId is missing.');
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
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      if (!instructor) {
        console.warn(`⚠️ [ASAAS WEBHOOK] No instructor found registered with provider_account_id: ${accountId}`);
        return res.status(404).json({ error: `Not Found: No instructor found for provider_account_id ${accountId}` });
      }

      // Check for duplication / idempotency
      if (
        instructor.provider_status === 'approved' &&
        instructor.provider_onboarding_completed === true &&
        instructor.payouts_enabled === true
      ) {
        console.log(`ℹ️ [ASAAS WEBHOOK] Duplicate event ignored. Instructor ${instructor.id} already approved with active payouts.`);
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
        return res.status(500).json({ error: 'Internal Server Error: Unable to update instructor status' });
      }

      console.log(`✅ [ASAAS WEBHOOK] Successfully processed ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED status update for instructor ID: ${instructor.id}`);
    } else {
      console.log(`ℹ️ [ASAAS WEBHOOK] Event ${event} parsed but ignored (in accordance with Phase 2 rules).`);
    }

    // 4. Responder HTTP 200 quando o payload for válido.
    return res.status(200).json({ 
      success: true, 
      message: 'Webhook processed successfully',
      event,
      timestamp
    });
  } catch (error: any) {
    console.error('⚠️ Error processing Asaas Webhook:', error.message);
    return res.status(400).json({ error: `Bad Request: ${error.message}` });
  }
}
