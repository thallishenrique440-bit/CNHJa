// supabase/functions/create-tip/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16" as any,
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req: Request) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("== INÍCIO REQUEST CREATE-TIP (STRIPE) ==");

    // 1. Autenticação (Hardening)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Header Authorization ausente.');
    }
    const token = authHeader.replace('Bearer ', '');

    const supabaseAuthClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    const { data: { user }, error: userError } = await supabaseAuthClient.auth.getUser(token)
    if (userError || !user) {
      throw new Error('Token de usuário inválido ou expirado.');
    }

    // 1.5 Gerenciar Cliente Stripe (Customer)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('full_name, stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profileError) throw profileError;

    let stripeCustomerId = profile.stripe_customer_id;

    if (!stripeCustomerId) {
      console.log(`Criando novo Cliente Stripe para o usuário ${user.id}`);
      const customer = await stripe.customers.create({
        email: user.email,
        name: profile.full_name || undefined,
        metadata: {
          supabase_user_id: user.id
        }
      });
      stripeCustomerId = customer.id;

      await supabaseAdmin
        .from('profiles')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', user.id);
    }

    // 2. Ler corpo da requisição
    const body = await req.json();
    const { appointment_id, amount } = body;

    if (!appointment_id || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100) {
      throw new Error('Valor inválido. Use centavos inteiros (mínimo R$ 1,00).');
    }

    // 3. (Removido inicialização duplicada do supabaseAdmin)
    
    // 4. Validar Aula (Appointment)
    // - Existe?
    // - Pertence ao aluno logado?
    // - Está concluída?
    // - Está dentro do prazo (24h)?
    const { data: apt, error: aptError } = await supabaseAdmin
      .from('appointments')
      .select('id, student_id, instructor_id, status, date, start_time')
      .eq('id', appointment_id)
      .single();

    if (aptError || !apt) {
      throw new Error('Aula não encontrada.');
    }

    if (apt.student_id !== user.id) {
      throw new Error('Você não tem permissão para dar caixinha nesta aula.');
    }

    const isCompleted = apt.status === 'completed';
    // Combine date and start_time to get a Date object with explicit Brazil offset (UTC-3)
    // Garantir que pegamos apenas HH:mm caso o banco retorne HH:mm:ss
    const [h, m] = apt.start_time.split(':');
    const startTime = new Date(`${apt.date}T${h}:${m}:00-03:00`);
    const nowMs = Date.now();
    
    // Permitir se concluída OU se confirmada/agendada/pendente e o horário de início já passou
    // Usamos o horário de início (startTime) como gatilho para permitir a caixinha
    const isPastOrCurrent = ['confirmed', 'scheduled', 'pending_approval'].includes(apt.status) && 
                            (startTime.getTime() <= nowMs);

    if (!isCompleted && !isPastOrCurrent) {
      throw new Error('A caixinha só pode ser enviada para aulas concluídas ou que já iniciaram.');
    }

    // 4.1 Validação de Prazo (24 horas após o início da aula)
    const diffInHours = (nowMs - startTime.getTime()) / (1000 * 60 * 60);
    
    if (diffInHours > 24) {
      throw new Error('O prazo para enviar caixinha já expirou.');
    }

    // 5. Regra de Negócio: Verificar se já existe caixinha para esta aula
    const { data: existingTip, error: tipCheckError } = await supabaseAdmin
      .from('transactions')
      .select('id')
      .eq('appointment_id', appointment_id)
      .eq('type', 'tip')
      .eq('status', 'completed')
      .maybeSingle();

    if (tipCheckError) throw tipCheckError;
    if (existingTip) {
      throw new Error('Já foi enviada uma caixinha para esta aula.');
    }

    // 6. Buscar dados do instrutor (Stripe Account)
    const { data: instructor, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('stripe_account_id, payouts_enabled')
      .eq('id', apt.instructor_id)
      .single();

    if (instructorError || !instructor) {
      throw new Error('Instrutor não encontrado.');
    }

    if (!instructor.stripe_account_id) {
      throw new Error('Este instrutor ainda não conectou uma conta bancária.');
    }

    if (instructor.payouts_enabled !== true) {
      throw new Error('Instrutor ainda não está habilitado para receber pagamentos.');
    }

    // 7. Criar PaymentIntent no Stripe (Cobrança Direta)
    // Idempotency Key: appointment_id + student_id
    const idempotencyKey = `tip_${appointment_id}_${user.id}`;

    // AJUSTE: Regra da Caixinha (0% de taxa da plataforma)
    const platformFee = 0;

    console.log(`Creating TIP | Apt: ${appointment_id} | Student: ${user.id} | Instructor: ${apt.instructor_id} | Amount: ${amount} | Platform Fee: ${platformFee}`);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: 'brl',
      customer: stripeCustomerId, // Vínculo com o cliente Stripe
      capture_method: 'automatic', // Cobrança imediata
      automatic_payment_methods: {
        enabled: true,
      },
      description: `Caixinha • Aula ${appointment_id}`,
      
      // Destination Charges (Split Payment)
      application_fee_amount: platformFee, // 0 para caixinhas
      transfer_data: {
        destination: instructor.stripe_account_id,
      },
      
      metadata: {
        type: 'tip',
        appointment_id: String(appointment_id),
        student_id: String(user.id),
        instructor_id: String(apt.instructor_id),
        customer_id: stripeCustomerId
      },
      
    }, { idempotencyKey });

    console.log(`✅ Tip PaymentIntent created: ${paymentIntent.id}`);

    return new Response(
      JSON.stringify({ 
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (err: any) {
    console.error('CRITICAL ERROR in create-tip:', err);
    return new Response(
      JSON.stringify({ 
        error: err.message || 'Erro interno ao processar caixinha.',
        type: err.type || 'unknown'
      }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
});
