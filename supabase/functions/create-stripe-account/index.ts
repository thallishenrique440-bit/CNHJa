import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

declare const Deno: any;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16" as any,
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) throw new Error('Invalid user token');

    // Check request mode (Link Creation vs Manual Sync)
    let body = {};
    try {
        const text = await req.text();
        if (text) body = JSON.parse(text);
    } catch(e) { /* ignore empty body */ }
    
    const mode = (body as any).mode || 'create_link'; // 'create_link' | 'sync'

    // Admin Client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: instructor, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('stripe_account_id')
      .eq('id', user.id)
      .single();

    if (instructorError) throw instructorError;
    let accountId = instructor.stripe_account_id;

    // --- MODE: SYNC (Manual Refresh) ---
    if (mode === 'sync') {
        if (!accountId) {
            return new Response(JSON.stringify({ status: 'no_account' }), { 
                status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            });
        }

        console.log(`[Sync] Fetching Stripe data for ${accountId}`);
        const account = await stripe.accounts.retrieve(accountId);
        
        await supabaseAdmin
            .from('instructors')
            .update({ 
                payouts_enabled: account.payouts_enabled,
                stripe_onboarding_completed: account.details_submitted
            })
            .eq('id', user.id);

        return new Response(
            JSON.stringify({ 
                status: 'synced', 
                payouts_enabled: account.payouts_enabled,
                details_submitted: account.details_submitted
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    // --- MODE: CREATE LINK (Default) ---
    
    // Configura URL base para retorno
    let baseUrl = req.headers.get('referer') || req.headers.get('origin') || 'http://localhost:3000';
    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    baseUrl = baseUrl.replace(/\/index\.html$/, '');
    const hashIndex = baseUrl.indexOf('#');
    if (hashIndex !== -1) baseUrl = baseUrl.substring(0, hashIndex);

    const returnUrl = `${baseUrl}/#/instructor/finance`;
    const refreshUrl = `${baseUrl}/#/instructor/finance`;

    // 1. Se não existir conta, cria uma nova
    if (!accountId) {
      console.log(`Creating new Stripe Express account for ${user.email}`);
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'BR',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      
      await supabaseAdmin
        .from('instructors')
        .update({ stripe_account_id: accountId })
        .eq('id', user.id);
    }

    // 2. Verifica o status atual no Stripe para decidir qual link gerar
    const account = await stripe.accounts.retrieve(accountId);

    // Autocorreção: Se o status no DB estiver desatualizado, atualiza agora
    if (account.details_submitted !== instructor.stripe_onboarding_completed) {
       await supabaseAdmin
        .from('instructors')
        .update({ stripe_onboarding_completed: account.details_submitted })
        .eq('id', user.id);
    }

    if (account.details_submitted) {
        // --- CASO A: CONTA ATIVA OU EM ANÁLISE ---
        // Gera link de LOGIN para o Dashboard Express
        console.log(`Generating Login Link for active account: ${accountId}`);
        const loginLink = await stripe.accounts.createLoginLink(accountId);
        
        return new Response(
            JSON.stringify({ url: loginLink.url }),
            { 
              status: 200, 
              headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            }
        );
    } else {
        // --- CASO B: CADASTRO INCOMPLETO ---
        // Gera link de ONBOARDING para preencher dados
        console.log(`Generating Onboarding Link for pending account: ${accountId}`);
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: refreshUrl,
            return_url: returnUrl,
            type: 'account_onboarding',
        });

        return new Response(
            JSON.stringify({ url: accountLink.url }),
            { 
              status: 200, 
              headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            }
        );
    }

  } catch (error: any) {
    console.error('Error in create-stripe-account:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});