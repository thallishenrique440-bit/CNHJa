import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
  telemetry: false,
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Auth Validation
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) throw new Error('Invalid user token');

    // 2. Parse Body (for Sync mode)
    let body = {};
    try {
        const text = await req.text();
        if (text) body = JSON.parse(text);
    } catch(e) { /* ignore */ }
    const mode = (body as any).mode || 'create_link';

    // 3. Admin Client for DB operations
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 4. Get Instructor
    const { data: instructor, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('stripe_account_id')
      .eq('id', user.id)
      .single();

    if (instructorError) throw instructorError;
    let accountId = instructor.stripe_account_id;

    // 5. Create Account if missing
    if (!accountId) {
        console.log(`Creating new Stripe Express account for ${user.email}`);
        const newAccount = await stripe.accounts.create({
            type: 'express',
            country: 'BR',
            email: user.email,
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
        });
        accountId = newAccount.id;
        
        await supabaseAdmin
            .from('instructors')
            .update({ stripe_account_id: accountId })
            .eq('id', user.id);
    }

    // 6. Handle Sync Mode
    if (mode === 'sync') {
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

    // 7. Generate Link Logic (The Fix)
    const account = await stripe.accounts.retrieve(accountId);
    
    // Check if account is active/completed
    // We check details_submitted. If true, we assume account is ready for dashboard.
    const isAccountActive = account.details_submitted;

    // Sync DB status just in case
    if (instructor.stripe_onboarding_completed !== isAccountActive) {
        await supabaseAdmin
            .from('instructors')
            .update({ stripe_onboarding_completed: isAccountActive })
            .eq('id', user.id);
    }

    if (isAccountActive) {
        // --- ACTIVE: LOGIN LINK ---
        console.log(`Generating Login Link for active account: ${accountId}`);
        const loginLink = await stripe.accounts.createLoginLink(accountId);
        
        return new Response(
            JSON.stringify({ url: loginLink.url }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } else {
        // --- INCOMPLETE: ONBOARDING LINK ---
        console.log(`Generating Onboarding Link for pending account: ${accountId}`);
        
        let baseUrl = req.headers.get('origin') || req.headers.get('referer') || 'http://localhost:3000';
        // Clean up URL
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
        const hashIndex = baseUrl.indexOf('#');
        if (hashIndex !== -1) baseUrl = baseUrl.substring(0, hashIndex);
        
        const returnUrl = `${baseUrl}/#/instructor/finance`;
        const refreshUrl = `${baseUrl}/#/instructor/finance`;

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: refreshUrl,
            return_url: returnUrl,
            type: 'account_onboarding',
        });

        return new Response(
            JSON.stringify({ url: accountLink.url }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

  } catch (error: any) {
    console.error('Error in create-stripe-account:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});