import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "stripe";

// Declaração do Deno para evitar erros de lint
declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Configuração do Stripe
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") as string, {
  apiVersion: "2023-10-16" as any,
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req: any) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("== INÍCIO REQUEST CREATE-BOOKING (STRIPE) ==");

    // 1. Extração Manual do Token (Hardening)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Header Authorization ausente.');
    }
    const token = authHeader.replace('Bearer ', '');

    // 2. Determinar a URL base (Origin) para o redirecionamento correto
    const requestOrigin = req.headers.get('origin') || req.headers.get('referer');
    let baseUrl = 'http://localhost:3000';
    
    if (requestOrigin) {
      // Remove trailing slash e index.html se existirem
      baseUrl = requestOrigin.endsWith('/') ? requestOrigin.slice(0, -1) : requestOrigin;
      baseUrl = baseUrl.replace(/\/index\.html$/, '');
    }

    // Se houver hash na baseUrl, remove para reconstruir corretamente
    const hashIndex = baseUrl.indexOf('#');
    if (hashIndex !== -1) {
      baseUrl = baseUrl.substring(0, hashIndex);
    }
    
    console.log(`Base URL para retorno: ${baseUrl}`);

    // 3. Inicializar Supabase Client
    const supabaseAuthClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    // 4. Validar Usuário
    const { data: { user }, error: userError } = await supabaseAuthClient.auth.getUser(token)
    
    if (userError || !user) {
      throw new Error('Token de usuário inválido ou expirado.');
    }

    // 5. Ler corpo da requisição
    const body = await req.json();
    const { instructor_id, slots, category } = body;

    if (!instructor_id || !slots || slots.length === 0) {
      throw new Error('Dados incompletos: instrutor ou horários faltando.')
    }

    // 6. Inicializar Supabase Admin
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 7. Verificar Disponibilidade (Double booking check)
    const dates = slots.map((s: any) => s.date)
    const times = slots.map((s: any) => s.time)

    const { data: busySlots, error: busyError } = await supabaseAdmin
      .from('appointments')
      .select('date, start_time')
      .eq('instructor_id', instructor_id)
      .in('date', dates)
      .in('start_time', times)
      .neq('status', 'cancelled')
      .neq('status', 'failed') // Se falhou, o horário teoricamente está livre, mas vamos manter simples
    
    if (busyError) throw busyError;

    if (busySlots && busySlots.length > 0) {
      return new Response(
        JSON.stringify({ error: 'Alguns horários já foram reservados.', busySlots }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 8. Buscar dados do instrutor e CONTA STRIPE
    const { data: instructorData, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('base_price, night_price, has_night_lessons, stripe_account_id, payouts_enabled')
      .eq('id', instructor_id)
      .single();
    
    if (instructorError || !instructorData) {
      throw new Error('Instrutor não encontrado.');
    }

    // CRITICAL CHECK: Instrutor tem conta Stripe ativa?
    if (!instructorData.stripe_account_id || !instructorData.payouts_enabled) {
      throw new Error('Este instrutor ainda não configurou o recebimento de pagamentos.');
    }

    let totalPrice = 0;
    const purchaseId = crypto.randomUUID();
    const reservationExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); 

    // Preparar inserts
    const appointmentsToInsert = slots.map((slot: any) => {
       const [h] = slot.time.split(':').map(Number);
       const isNight = h >= 18;
       const price = (isNight && instructorData.has_night_lessons) 
          ? instructorData.night_price 
          : instructorData.base_price;
       
       totalPrice += price;

       const [year, month, day] = slot.date.split('-').map(Number);
       const [hour, minute] = slot.time.split(':').map(Number);
       const d = new Date(year, month - 1, day, hour, minute);
       d.setMinutes(d.getMinutes() + 50);
       const end_time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

       return {
         student_id: user.id,
         instructor_id: instructor_id,
         date: slot.date,
         start_time: slot.time,
         end_time: end_time,
         category: category || 'B',
         price: price,
         status: 'reserved', 
         expires_at: reservationExpiresAt,
         purchase_id: purchaseId,
         payment_status: 'pending'
       }
    });

    // 9. Inserir Reservas no Banco
    const { error: insertError } = await supabaseAdmin
      .from('appointments')
      .insert(appointmentsToInsert);

    if (insertError) throw insertError;

    // 10. Criar Sessão de Checkout na Stripe
    // Cálculo da Taxa da Plataforma (10%)
    const platformFee = Math.round(totalPrice * 0.10); 

    const title = slots.length === 1 
      ? `Aula Dir. - ${slots[0].date} ${slots[0].time}`
      : `Pacote ${slots.length} Aulas`;

    // Metadata: Pegamos o ID do primeiro agendamento como referência principal, 
    // mas o ideal é que o Webhook use o 'purchase_id' para confirmar todos.
    // Vamos passar purchase_id no metadata.
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], // Adicionar 'pix' requer configuração extra na conta Stripe BR
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: title,
              description: `Agendamento com instrutor(a). Categoria: ${category || 'B'}`,
            },
            unit_amount: totalPrice, // Valor total em centavos
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      
      // Destination Charges: O dinheiro vai para o instrutor, menos a taxa
      payment_intent_data: {
        application_fee_amount: platformFee,
        transfer_data: {
          destination: instructorData.stripe_account_id,
        },
        metadata: {
          purchase_id: purchaseId, // Chave para o webhook confirmar todas as aulas
          student_id: user.id,
          instructor_id: instructor_id
        },
      },
      
      metadata: {
        purchase_id: purchaseId,
        student_id: user.id,
      },
      
      // URLs de retorno para o Frontend
      success_url: `${baseUrl}/#/student/lessons?success=true`,
      cancel_url: `${baseUrl}/#/student/instructor/${instructor_id}?canceled=true`,
      
      // Idempotência
    }, { idempotencyKey: purchaseId });

    return new Response(
      JSON.stringify({ 
        purchaseId: purchaseId,
        paymentUrl: session.url, // URL hospedada da Stripe
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (err: any) {
    console.error('CRITICAL ERROR:', err);
    return new Response(
      JSON.stringify({ 
        error: err.message || 'Erro interno ao processar pagamento.',
        details: String(err)
      }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
});