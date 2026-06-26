import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    console.log("== INÍCIO REQUEST CREATE-TIP (ASAAS PIX) ==");

    // 1. Autenticação (Hardening)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Header Authorization ausente.');
    }
    const token = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const supabaseAuthClient = createClient(supabaseUrl, supabaseAnonKey);

    const { data: { user }, error: userError } = await supabaseAuthClient.auth.getUser(token);
    if (userError || !user) {
      throw new Error('Token de usuário inválido ou expirado.');
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // 2. Ler corpo da requisição
    const body = await req.json();
    const { appointment_id, amount } = body;

    if (!appointment_id || typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100) {
      throw new Error('Valor inválido. Use centavos inteiros (mínimo R$ 1,00).');
    }

    // 3. Validar Aula (Appointment)
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
    const [h, m] = apt.start_time.split(':');
    const startTime = new Date(`${apt.date}T${h}:${m}:00-03:00`);
    const nowMs = Date.now();
    
    // Permitir se concluída OU se confirmada/agendada/pendente e o horário de início já passou
    const isPastOrCurrent = ['confirmed', 'scheduled', 'pending_approval'].includes(apt.status) && 
                            (startTime.getTime() <= nowMs);

    if (!isCompleted && !isPastOrCurrent) {
      throw new Error('A caixinha só pode ser enviada para aulas concluídas ou que já iniciaram.');
    }

    // Validação de Prazo (24 horas após o início da aula)
    const diffInHours = (nowMs - startTime.getTime()) / (1000 * 60 * 60);
    
    if (diffInHours > 24) {
      throw new Error('O prazo para enviar caixinha já expirou.');
    }

    // 4. Regra de Negócio: Verificar se já existe caixinha para esta aula
    const { data: existingTip, error: tipCheckError } = await supabaseAdmin
      .from('transactions')
      .select('id, status')
      .eq('appointment_id', appointment_id)
      .eq('type', 'tip')
      .eq('status', 'completed')
      .maybeSingle();

    if (tipCheckError) throw tipCheckError;
    if (existingTip) {
      throw new Error('Já foi enviada uma caixinha para esta aula.');
    }

    // 5. Buscar dados do instrutor (Asaas Wallet)
    const { data: instructor, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('provider_wallet_id, provider_account_id, payouts_enabled')
      .eq('id', apt.instructor_id)
      .single();

    if (instructorError || !instructor) {
      throw new Error('Instrutor não encontrado.');
    }

    if (!instructor.provider_wallet_id) {
      throw new Error('Este instrutor ainda não conectou uma conta bancária Asaas.');
    }

    if (instructor.payouts_enabled !== true) {
      throw new Error('Instrutor ainda não está habilitado para receber pagamentos.');
    }

    // 6. Obter ou Criar Cliente Asaas para o Aluno
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('full_name, phone, cpf, provider_customer_id, provider_name')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      throw new Error('Perfil do aluno não encontrado.');
    }

    if (!profile.cpf || profile.cpf.trim() === '') {
      throw new Error('O CPF é obrigatório para prosseguir com o pagamento.');
    }
    if (!profile.phone || profile.phone.trim() === '') {
      throw new Error('O Telefone é obrigatório para prosseguir com o pagamento.');
    }

    const asaasKey = Deno.env.get("ASAAS_API_KEY");
    if (!asaasKey) {
      throw new Error('ASAAS_API_KEY não configurada no servidor.');
    }
    const asaasUrl = Deno.env.get("ASAAS_API_URL") || 'https://sandbox.asaas.com/api/v3';

    let providerCustomerId = profile.provider_customer_id;
    if (!providerCustomerId || profile.provider_name !== 'asaas') {
      console.log(`Criando novo cliente Asaas para o estudante ${user.id}`);
      const custResponse = await fetch(`${asaasUrl}/customers`, {
        method: 'POST',
        headers: {
          'access_token': asaasKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: profile.full_name || 'Estudante',
          email: user.email,
          phone: profile.phone,
          cpfCnpj: profile.cpf,
          notificationDisabled: true
        })
      });

      if (!custResponse.ok) {
        const errText = await custResponse.text();
        console.error('Erro Asaas Customer API:', errText);
        throw new Error(`Falha ao registrar cliente no Asaas.`);
      }

      const custData = await custResponse.json();
      providerCustomerId = custData.id;

      await supabaseAdmin
        .from('profiles')
        .update({
          provider_customer_id: providerCustomerId,
          provider_name: 'asaas'
        })
        .eq('id', user.id);
    }

    // 7. Upsert transação 'pending' para idempotência e geração do ID
    const { data: tx, error: txError } = await supabaseAdmin
      .from('transactions')
      .upsert({
        appointment_id: appointment_id,
        student_id: user.id,
        instructor_id: apt.instructor_id,
        type: 'tip',
        amount: amount,
        gross_amount: amount,
        platform_fee: 0,
        net_amount: amount,
        status: 'pending',
        provider_name: 'asaas',
        event_date: new Date().toISOString(),
        description: 'Caixinha via Asaas'
      }, { onConflict: 'appointment_id,type' })
      .select('id')
      .single();

    if (txError || !tx) {
      throw new Error(`Erro ao registrar transação financeira: ${txError?.message}`);
    }
    const txId = tx.id;

    // 8. Criar Pagamento PIX no Asaas com Split para o Instrutor
    const todayStr = new Date(Date.now() - 3 * 3600 * 1000).toISOString().split('T')[0];
    const paymentPayload = {
      customer: providerCustomerId,
      billingType: 'PIX',
      value: amount / 100,
      dueDate: todayStr,
      description: `Caixinha • Aula ${appointment_id}`,
      externalReference: `tip:${appointment_id}:${txId}`,
      split: [
        {
          walletId: instructor.provider_wallet_id,
          percentualValue: 100
        }
      ]
    };

    console.log(`[ASAAS TIP] Payload:`, JSON.stringify(paymentPayload));

    const payResponse = await fetch(`${asaasUrl}/payments`, {
      method: 'POST',
      headers: {
        'access_token': asaasKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentPayload)
    });

    if (!payResponse.ok) {
      const errText = await payResponse.text();
      console.error('Erro Asaas Payment API:', errText);
      throw new Error(`Falha ao gerar cobrança PIX no Asaas.`);
    }

    const paymentData = await payResponse.json();
    const asaasPaymentId = paymentData.id;
    const invoiceUrl = paymentData.invoiceUrl;

    // 9. Obter QR Code e Chave Copia e Cola do PIX
    const qrResponse = await fetch(`${asaasUrl}/payments/${asaasPaymentId}/pixQrCode`, {
      method: 'GET',
      headers: {
        'access_token': asaasKey,
        'Content-Type': 'application/json'
      }
    });

    if (!qrResponse.ok) {
      const errText = await qrResponse.text();
      console.error('Erro Asaas QR Code API:', errText);
      throw new Error(`Falha ao obter QR Code PIX do Asaas.`);
    }

    const qrData = await qrResponse.json();
    const encodedImage = qrData.encodedImage;
    const copiaCola = qrData.payload;

    // 10. Atualizar transação com o provider_payment_id
    await supabaseAdmin
      .from('transactions')
      .update({
        provider_payment_id: asaasPaymentId
      })
      .eq('id', txId);

    console.log(`✅ Caixinha PIX gerada com sucesso! Asaas ID: ${asaasPaymentId}`);

    return new Response(
      JSON.stringify({
        paymentId: asaasPaymentId,
        invoiceUrl: invoiceUrl,
        qrCodeImage: encodedImage,
        copiaColaCode: copiaCola,
        amount: amount / 100
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (err: any) {
    console.error('CRITICAL ERROR in create-tip:', err);
    return new Response(
      JSON.stringify({
        error: err.message || 'Erro interno ao processar caixinha.'
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
