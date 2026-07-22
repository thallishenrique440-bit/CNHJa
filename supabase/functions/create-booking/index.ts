import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: any;

class PaymentProviderResolver {
  static resolveProviderForStudent(_studentId: string): string {
    return 'asaas';
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("== INÍCIO REQUEST CREATE-BOOKING (ASAAS) ==");

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Header Authorization ausente.');
    }
    const token = authHeader.replace('Bearer ', '');

    const supabaseAuthClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: { user }, error: userError } = await supabaseAuthClient.auth.getUser(token)
    
    if (userError || !user) {
      throw new Error('Token de usuário inválido ou expirado.');
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('full_name, provider_customer_id, provider_name')
      .eq('id', user.id)
      .single();

    if (profileError) throw profileError;

    const providerName = PaymentProviderResolver.resolveProviderForStudent(user.id);

    const body = await req.json();
    const { instructor_id, slots, category } = body;

    if (!instructor_id || !slots || slots.length === 0) {
      throw new Error('Dados incompletos: instrutor ou horários faltando.')
    }

    const requestedCategory = category;
    if (!requestedCategory || !['A', 'B'].includes(requestedCategory)) {
        throw new Error('Categoria da aula (A ou B) é obrigatória.');
    }

    const dates = slots.map((s: any) => s.date)
    const times = slots.map((s: any) => s.time)

    const nowISO = new Date().toISOString();

    await supabaseAdmin
      .from('appointments')
      .update({
        status: 'cancelled',
        payment_status: 'failed',
        cancelled_reason: 'system_cleanup_expired',
        updated_by: user.id
      })
      .eq('instructor_id', instructor_id)
      .in('date', dates)
      .in('start_time', times)
      .eq('status', 'reserved')
      .lt('expires_at', nowISO);

    await supabaseAdmin
        .from('appointments')
        .update({
            status: 'cancelled',
            payment_status: 'failed',
            cancelled_reason: 'user_retry_new_attempt',
            updated_by: user.id
        })
        .eq('instructor_id', instructor_id)
        .in('date', dates)
        .in('start_time', times)
        .eq('student_id', user.id)
        .in('status', ['reserved', 'pending', 'awaiting_payment']); 

    const { data: busySlots, error: busyError } = await supabaseAdmin
      .from('appointments')
      .select('date, start_time')
      .eq('instructor_id', instructor_id)
      .in('date', dates)
      .in('start_time', times)
      .not('status', 'in', '("cancelled","failed","rejected","expired")')
    
    if (busyError) throw busyError;

    if (busySlots && busySlots.length > 0) {
      return new Response(
        JSON.stringify({ error: 'Alguns horários já foram reservados por outro aluno.', busySlots }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: studentBusySlots, error: studentBusyError } = await supabaseAdmin
      .from('appointments')
      .select('date, start_time')
      .eq('student_id', user.id)
      .in('date', dates)
      .in('start_time', times)
      .not('status', 'in', '("cancelled","failed","rejected","expired")');
    
    if (studentBusyError) throw studentBusyError;

    if (studentBusySlots && studentBusySlots.length > 0) {
      return new Response(
        JSON.stringify({ error: 'Você já possui uma aula agendada neste mesmo horário.', busySlots: studentBusySlots }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: instructorData, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('has_night_lessons, payouts_enabled, provider_account_id, provider_wallet_id')
      .eq('id', instructor_id)
      .single();
    
    if (instructorError || !instructorData) {
      throw new Error('Instrutor não encontrado.');
    }

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

    if (!categoryData.day_price || categoryData.day_price <= 0) {
         return new Response(
            JSON.stringify({ error: `Preço inválido ou não configurado para a Categoria ${requestedCategory}.` }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

    let totalPrice = 0;
    const groupId = crypto.randomUUID();
    const reservationExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); 

    const appointmentsToInsert = slots.map((slot: any) => {
       const [h] = slot.time.split(':').map(Number);
       const isNight = h >= 18;
       let price = categoryData.day_price;
       
       if (isNight && instructorData.has_night_lessons) {
           if (categoryData.night_price && categoryData.night_price > 0) {
               price = categoryData.night_price;
           } else {
               price = categoryData.day_price;
           }
       }
       
       totalPrice += price;

       const [year, month, day] = slot.date.split('-').map(Number);
       const [hour, minute] = slot.time.split(':').map(Number);
       const d = new Date(year, month - 1, day, hour, minute);
       d.setMinutes(d.getMinutes() + 60);
       const end_time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

       return {
         student_id: user.id,
         instructor_id: instructor_id,
         date: slot.date,
         start_time: slot.time,
         end_time: end_time,
         category: requestedCategory,
         price: price,
         status: 'reserved', 
         expires_at: reservationExpiresAt,
         group_id: groupId,
         payment_status: 'pending',
         provider_name: 'asaas',
         updated_by: user.id
       }
    });

    if (totalPrice <= 0) {
        throw new Error("O valor total da reserva é inválido (zero).");
    }

    const { error: insertError } = await supabaseAdmin
      .from('appointments')
      .insert(appointmentsToInsert);

    if (insertError) {
        if (insertError.code === '23505') {
            return new Response(
                JSON.stringify({ error: 'Horário indisponível (concorrente). Atualize a página.' }),
                { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            )
        }
        throw insertError;
    }

    return new Response(
      JSON.stringify({ 
        groupId: groupId,
        providerName: 'asaas'
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
        error: err.message || 'Erro interno ao processar agendamento.',
        type: err.type || 'unknown',
        details: String(err)
      }),
      { 
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
});
