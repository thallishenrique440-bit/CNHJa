import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

// Declare Deno to resolve TypeScript errors
declare const Deno: any;

// CRITICAL FIX: Use esm.sh import above + createFetchHttpClient here
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16" as any,
  httpClient: Stripe.createFetchHttpClient(),
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
    // 1. Validar Autenticação Manualmente
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing Authorization header');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Invalid user token');
    }

    // 2. Determinar URLs de Retorno com precisão
    // FIX: Priorizamos 'referer' porque em ambientes de preview (Bolt/StackBlitz) ou subpastas,
    // o 'origin' retorna apenas o domínio raiz, causando 404 no redirecionamento.
    let baseUrl = req.headers.get('referer') || req.headers.get('origin') || 'http://localhost:3000';
    
    // Limpeza da URL para evitar duplicatas ou erros
    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1);
    }
    // Remove arquivo específico se houver (ex: index.html)
    baseUrl = baseUrl.replace(/\/index\.html$/, '');

    // Se o referer já contiver a hash (alguns browsers enviam), removemos para reconstruir corretamente
    const hashIndex = baseUrl.indexOf('#');
    if (hashIndex !== -1) {
      baseUrl = baseUrl.substring(0, hashIndex);
    }

    // Constrói as URLs finais para o HashRouter
    // Ex: https://url-do-preview.com/caminho-do-app/#/instructor/finance
    const returnUrl = `${baseUrl}/#/instructor/finance`;
    const refreshUrl = `${baseUrl}/#/instructor/finance`;
    
    console.log(`Base URL detectada: ${baseUrl}`);
    console.log(`Return URL gerada: ${returnUrl}`);

    // 3. Inicializar Admin Client
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 4. Buscar dados atuais
    const { data: instructor, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('stripe_account_id')
      .eq('id', user.id)
      .single();

    if (instructorError) throw instructorError;

    let accountId = instructor.stripe_account_id;

    // 5. Criar conta Stripe se não existir
    if (!accountId) {
      console.log(`Criando nova conta Stripe Express para ${user.email}`);
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

      const { error: updateError } = await supabaseAdmin
        .from('instructors')
        .update({ stripe_account_id: accountId })
        .eq('id', user.id);

      if (updateError) throw updateError;
    }

    // 6. Gerar Link de Onboarding
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

  } catch (error: any) {
    console.error('Erro na function:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});