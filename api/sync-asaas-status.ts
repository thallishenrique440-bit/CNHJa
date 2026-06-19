import { createClient } from '@supabase/supabase-js';
import { PaymentProviderFactory } from '../lib/payments/PaymentProviderFactory.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const supabaseAnon = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Auth check
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(token);

    if (authError || !user) {
      console.error('[SyncAsaasStatus] Auth Error:', authError?.message || 'No user found');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. Fetch instructor's provider_account_id
    const { data: instructor, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('provider_account_id, provider_status, provider_onboarding_completed, payouts_enabled')
      .eq('id', user.id)
      .single();

    if (instructorError || !instructor) {
      console.error('[SyncAsaasStatus] Instructor retrieval error:', instructorError);
      return res.status(404).json({ error: 'Instrutor não encontrado.' });
    }

    const providerAccountId = instructor.provider_account_id;
    if (!providerAccountId) {
      return res.status(400).json({ error: 'Nenhuma conta Asaas vinculada a este instrutor.' });
    }

    // 3. Query Asaas via provider getAccountStatus
    const paymentProvider = PaymentProviderFactory.getProvider('asaas');
    const statusRes = await paymentProvider.getAccountStatus(providerAccountId);

    console.log('[SyncAsaasStatus] Status fetched from Asaas:', statusRes);

    // 4. Update the DB with regression protection for approved status
    const isAlreadyApproved = instructor.provider_status === 'approved';

    const finalStatus = isAlreadyApproved ? 'approved' : statusRes.status;
    const finalOnboardingCompleted = isAlreadyApproved ? true : statusRes.onboardingCompleted;
    const finalPayoutsEnabled = isAlreadyApproved ? true : statusRes.payoutsEnabled;

    const { error: updateError } = await supabaseAdmin
      .from('instructors')
      .update({
        provider_status: finalStatus,
        provider_onboarding_completed: finalOnboardingCompleted,
        payouts_enabled: finalPayoutsEnabled
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('[SyncAsaasStatus] DB update error:', updateError);
      return res.status(500).json({ error: 'Erro ao atualizar dados no banco de dados.' });
    }

    return res.status(200).json({
      success: true,
      providerAccountId,
      status: finalStatus,
      onboardingCompleted: finalOnboardingCompleted,
      payoutsEnabled: finalPayoutsEnabled
    });

  } catch (error: any) {
    console.error('[SyncAsaasStatus] Error in synching asaas status:', error);
    return res.status(500).json({ error: error.message || 'Erro interno do servidor.' });
  }
}
