import { buffer } from 'micro';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Configuração para desativar o body parser padrão do Next.js/Vercel
// Necessário para validar a assinatura do Stripe com o corpo bruto
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover' as any,
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET!;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  let event: Stripe.Event;

  try {
    // 1. Ler o corpo bruto da requisição
    const buf = await buffer(req);
    const sig = req.headers['stripe-signature']!;

    // 2. Validar a assinatura do Stripe (Connect)
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err: any) {
    console.error(`❌ Connect Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔔 Connect Event received: ${event.type} [ID: ${event.id}]`);

  try {
    // 3. Processar eventos de Conta Conectada
    switch (event.type) {
      case 'account.updated':
      case 'capability.updated': {
        // Em capability.updated, o objeto vem dentro de event.data.object.account ou direto, 
        // mas para simplificar, buscamos sempre o ID da conta e consultamos a fonte da verdade.
        
        let accountId = "";
        if (event.type === 'account.updated') {
            accountId = (event.data.object as Stripe.Account).id;
        } else if (event.type === 'capability.updated') {
            accountId = (event.data.object as any).account;
        }

        if (accountId) {
            // Buscamos a conta fresca do Stripe para garantir o status real
            const account = await stripe.accounts.retrieve(accountId);
            
            const updates = {
              payouts_enabled: account.payouts_enabled,
              stripe_onboarding_completed: account.details_submitted,
            };

            console.log(`🔄 Syncing Instructor ${accountId}: Payouts=${account.payouts_enabled}, Onboarding=${account.details_submitted}`);

            const { error } = await supabaseAdmin
              .from('instructors')
              .update(updates)
              .eq('stripe_account_id', accountId);

            if (error) {
              console.error(`❌ Failed to update instructor ${accountId}:`, error);
              throw error;
            }
            console.log(`✅ Instructor ${accountId} updated successfully.`);
        }
        break;
      }

      default:
        console.log(`ℹ️ Unhandled Connect event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`🚨 Connect Webhook Logic Error:`, err);
    res.status(500).json({ error: err.message });
  }
}
