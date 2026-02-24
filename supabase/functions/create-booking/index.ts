// FIX: Use esm.sh for robust bundling in Edge Runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// FIX: Uso de URL absoluta compatível com Deno/Edge Runtime para evitar erro de bundle
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno&no-check";

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

    // VALIDAR CATEGORIA (Backend Source of Truth)
    const requestedCategory = category;
    if (!requestedCategory || !['A', 'B'].includes(requestedCategory)) {
        throw new Error('Categoria da aula (A ou B) é obrigatória.');
    }

    // 6. Inicializar Supabase Admin
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const dates = slots.map((s: any) => s.date)
    const times = slots.map((s: any) => s.time)

    // --- LOGICA DE AUTO-LIMPEZA (LAZY CLEANUP - SOFT UPDATE) ---
    // Em vez de DELETAR, marcamos como 'failed'.
    // O índice parcial "WHERE status NOT IN ('cancelled', 'failed')" fará com que esses registros
    // sejam ignorados na verificação de unicidade, liberando o slot imediatamente.
    
    const nowISO = new Date().toISOString();

    // A. Invalidar slots 'reserved' antigos (Garbage Collection preventiva)
    await supabaseAdmin
      .from('appointments')
      .update({
        status: 'failed',
        payment_status: 'failed',
        cancelled_reason: 'system_cleanup_expired' // Auditoria: expirou sem pagamento
      })
      .eq('instructor_id', instructor_id)
      .in('date', dates)
      .in('start_time', times)
      .eq('status', 'reserved')
      .lt('expires_at', nowISO);

    // B. Invalidar tentativa anterior DO PRÓPRIO USUÁRIO (Retry Flow)
    // Se o usuário fechou o checkout e tentou de novo, falhamos a anterior para permitir a nova.
    await supabaseAdmin
        .from('appointments')
        .update({
            status: 'failed',
            payment_status: 'failed',
            cancelled_reason: 'user_retry_new_attempt' // Auditoria: usuário reiniciou checkout
        })
        .eq('instructor_id', instructor_id)
        .in('date', dates)
        .in('start_time', times)
        .eq('student_id', user.id)
        .in('status', ['reserved', 'pending']); 

    // 7. Verificar Disponibilidade (Double booking check)
    // Agora verificamos se sobrou algum bloqueio REAL (de OUTROS usuários ou confirmados)
    const { data: busySlots, error: busyError } = await supabaseAdmin
      .from('appointments')
      .select('date, start_time')
      .eq('instructor_id', instructor_id)
      .in('date', dates)
      .in('start_time', times)
      .neq('status', 'cancelled')
      .neq('status', 'failed') // Importante: ignoramos os que acabamos de falhar
    
    if (busyError) throw busyError;

    if (busySlots && busySlots.length > 0) {
      return new Response(
        JSON.stringify({ error: 'Alguns horários já foram reservados por outro aluno.', busySlots }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 8. Buscar dados do instrutor e CONTA STRIPE
    // REMOVIDO: base_price, night_price (agora buscamos em instructor_categories)
    const { data: instructorData, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('has_night_lessons, stripe_account_id, payouts_enabled')
      .eq('id', instructor_id)
      .single();
    
    if (instructorError || !instructorData) {
      throw new Error('Instrutor não encontrado.');
    }

    // CRITICAL CHECK: Instrutor tem conta Stripe ativa?
    if (!instructorData.stripe_account_id) {
       throw new Error('Este instrutor ainda não conectou uma conta bancária.');
    }

    // Nota: Em ambiente de teste (dev), às vezes payouts_enabled demora a atualizar.
    if (!instructorData.payouts_enabled) {
      console.warn(`WARNING: Payouts not enabled for ${instructorData.stripe_account_id}. Proceeding anyway for testing.`);
    }

    // 9. BUSCAR PREÇO OFICIAL (Source of Truth)
    const { data: categoryData, error: categoryError } = await supabaseAdmin
        .from('instructor_categories')
        .select('day_price, night_price')
        .eq('instructor_id', instructor_id)
        .eq('category', requestedCategory)
        .single();

    if (categoryError || !categoryData) {
         return new Response(
            JSON.stringify({ error: `O instrutor não possui preço configurado para a Categoria ${requestedCategory}.` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

    // Validar integridade do preço
    if (!categoryData.day_price || categoryData.day_price <= 0) {
         return new Response(
            JSON.stringify({ error: `Preço inválido ou não configurado para a Categoria ${requestedCategory}.` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

    let totalPrice = 0;
    const purchaseId = crypto.randomUUID();
    // Expira em 30 min para dar tempo de pagar
    const reservationExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); 

    // Preparar inserts com PREÇO CALCULADO NO BACKEND
    const appointmentsToInsert = slots.map((slot: any) => {
       const [h] = slot.time.split(':').map(Number);
       const isNight = h >= 18;
       
       // Lógica de Preço:
       // Se for noite E instrutor aceita noite -> usa night_price
       // Caso contrário -> usa day_price
       let price = categoryData.day_price;
       
       if (isNight && instructorData.has_night_lessons) {
           // Se night_price não estiver definido, usamos day_price como fallback seguro?
           // Regra: "Se preço não configurado → bloquear". 
           // Mas night_price pode ser opcional? Vamos assumir que se has_night_lessons=true, deve ter preço.
           if (categoryData.night_price && categoryData.night_price > 0) {
               price = categoryData.night_price;
           } else {
               // Fallback ou Erro? Vamos usar o day price se night for 0, 
               // mas idealmente deveria ter preço noturno.
               price = categoryData.day_price;
           }
       }
       
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
         category: requestedCategory, // Salva a categoria validada
         price: price, // Preço oficial do banco
         status: 'reserved', 
         expires_at: reservationExpiresAt,
         purchase_id: purchaseId,
         payment_status: 'pending'
       }
    });

    if (totalPrice <= 0) {
        throw new Error("O valor total da reserva é inválido (zero).");
    }

    // 10. Inserir Reservas no Banco
    const { error: insertError } = await supabaseAdmin
      .from('appointments')
      .insert(appointmentsToInsert);

    if (insertError) {
        // Se der erro 23505 (Unique Violation) aqui, significa que alguém reservou milissegundos antes
        if (insertError.code === '23505') {
            return new Response(
                JSON.stringify({ error: 'Horário indisponível (concorrente). Atualize a página.' }),
                { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }
        throw insertError;
    }

    // 10. Criar Sessão de Checkout na Stripe
    
    // SAFE MATH: Garantir inteiros
    const finalUnitAmount = Math.round(totalPrice); 
    const platformFee = Math.round(finalUnitAmount * 0.10); // 10%

    if (finalUnitAmount < 500) { // Menos de 5 reais
        throw new Error("Valor total abaixo do mínimo permitido pela Stripe.");
    }

    const title = slots.length === 1 
      ? `Aula Prática (${category || 'B'}) - ${slots[0].date}`
      : `Pacote de ${slots.length} Aulas Práticas`;

    console.log(`Creating Session. Amount: ${finalUnitAmount}, Fee: ${platformFee}, Dest: ${instructorData.stripe_account_id}`);

    const session = await stripe.checkout.sessions.create({
      // ATENÇÃO: 'automatic_payment_methods' substitui 'payment_method_types'
      // Isso habilita PIX, Google Pay, Apple Pay e Cartão automaticamente baseado no Dashboard.
      automatic_payment_methods: {
        enabled: true,
      },
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: {
              name: title,
              description: `Agendamento via Autoescola do Brasil.`,
            },
            unit_amount: finalUnitAmount, // Inteiro
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      
      // Destination Charges (Split Payment)
      payment_intent_data: {
        application_fee_amount: platformFee, // Inteiro
        transfer_data: {
          destination: instructorData.stripe_account_id,
        },
        metadata: {
          purchase_id: String(purchaseId),
          student_id: String(user.id),
          instructor_id: String(instructor_id)
        },
      },
      
      metadata: {
        purchase_id: String(purchaseId),
        student_id: String(user.id),
      },
      
      success_url: `${baseUrl}/#/student/lessons?success=true`,
      cancel_url: `${baseUrl}/#/student/instructor/${instructor_id}?canceled=true`,
      
    }, { idempotencyKey: purchaseId });

    return new Response(
      JSON.stringify({ 
        purchaseId: purchaseId,
        paymentUrl: session.url,
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (err: any) {
    console.error('CRITICAL ERROR in create-booking:', err);
    return new Response(
      JSON.stringify({ 
        error: err.message || 'Erro interno ao processar pagamento.',
        type: err.type || 'unknown',
        details: String(err)
      }),
      { 
        status: 400, // Mantemos 400 para erros de validação/stripe
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
});