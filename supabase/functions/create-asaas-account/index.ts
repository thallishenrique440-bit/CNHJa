import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { asaasFetch } from '../_shared/asaasClient.ts';

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
    // PASSO 1: Validar Authorization Header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing Authorization header');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // PASSO 2: Executar auth.getUser() & PASSO 3: Recuperar user.id autenticado
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) throw new Error('Invalid user token');

    // Inicializar Supabase Admin Client para operações persistentes na DB
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // PASSO 4: Consultar instructors
    const { data: instructor, error: instructorError } = await supabaseAdmin
      .from('instructors')
      .select('provider_account_id, provider_wallet_id, provider_status, provider_onboarding_completed, whatsapp')
      .eq('id', user.id)
      .maybeSingle();

    if (instructorError) throw instructorError;

    // PASSO 5: Se provider_account_id existir: retornar sucesso imediatamente
    if (instructor?.provider_account_id) {
      console.log(`Instructor ${user.id} already has an Asaas account: ${instructor.provider_account_id}`);
      return new Response(
        JSON.stringify({
          success: true,
          provider_account_id: instructor.provider_account_id,
          provider_wallet_id: instructor.provider_wallet_id,
          provider_status: instructor.provider_status || 'APPROVED',
          provider_onboarding_completed: instructor.provider_onboarding_completed || false,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // PASSO 6: Receber payload
    let body: any = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch {
      throw new Error('Payload JSON inválido');
    }

    const {
      cpfCnpj,
      companyType,
      postalCode,
      address,
      addressNumber,
      complement,
      province,
      city,
      state,
      birthDate,
      incomeValue
    } = body;

    if (!cpfCnpj) throw new Error('O CPF/CNPJ é obrigatório para o cadastro no Asaas.');
    if (!companyType) throw new Error('O tipo de empresa (companyType) é obrigatório.');
    if (companyType === 'INDIVIDUAL' && !birthDate) {
      throw new Error('A data de nascimento é obrigatória para o cadastro de Pessoa Física.');
    }
    const parsedIncomeValue = Number(incomeValue);
    if (incomeValue === undefined || isNaN(parsedIncomeValue) || parsedIncomeValue <= 0) {
      throw new Error('A renda/faturamento estimado (incomeValue) é obrigatório e deve ser maior que zero.');
    }
    if (!postalCode) throw new Error('O CEP é obrigatório para o cadastro no Asaas.');
    if (!address) throw new Error('O Endereço (Logradouro) é obrigatório.');
    if (!addressNumber) throw new Error('O Número do endereço é obrigatório.');
    if (!province) throw new Error('O Bairro é obrigatório.');

    // PASSO 7: Buscar no banco profiles recuperando full_name, email, phone
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('full_name, email, phone, cpf')
      .eq('id', user.id)
      .single();

    if (profileError) throw profileError;

    const name = profile?.full_name;
    const email = profile?.email || user.email;
    const profilePhone = profile?.phone || '';
    const instructorWhatsapp = instructor?.whatsapp || '';

    if (!name) throw new Error('Nome completo não cadastrado no perfil.');
    if (!email) throw new Error('E-mail do instrutor não encontrado.');

    // PASSO 8: Sanitizar cpfCnpj, postalCode, phone removendo caracteres não numéricos.
    const cleanCpfCnpj = cpfCnpj.replace(/\D/g, '');
    const cleanPostalCode = postalCode.replace(/\D/g, '');

    // Validação de tamanho
    if (cleanCpfCnpj.length !== 11 && cleanCpfCnpj.length !== 14) {
      throw new Error('CPF/CNPJ inválido. Informe um documento com 11 ou 14 dígitos.');
    }

    // Validação de coerência do companyType
    if (cleanCpfCnpj.length === 11) {
      if (companyType !== 'INDIVIDUAL') {
        throw new Error('Inconsistência de cadastro: CPF exige o tipo de empresa INDIVIDUAL.');
      }
    } else if (cleanCpfCnpj.length === 14) {
      if (companyType !== 'MEI' && companyType !== 'LIMITED') {
        throw new Error('Inconsistência de cadastro: CNPJ exige o tipo de empresa MEI ou LIMITED.');
      }
    }
    
    // Preferir telefone do input, depois profiles.phone, e por último instructors.whatsapp
    const inputPhone = body.phone || profilePhone || instructorWhatsapp || '';
    const cleanPhone = inputPhone.replace(/\D/g, '');

    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Número de celular ou telefone válido é obrigatório para cadastro no Asaas.');
    }

    // Obter as credenciais da API do Asaas a partir do Deno env
    const asaasApiUrl = Deno.env.get('ASAAS_API_URL') || 'https://sandbox.asaas.com/api/v3';
    const asaasApiKey = Deno.env.get('ASAAS_API_KEY');

    if (!asaasApiKey) {
      throw new Error('Chave de API do Asaas (ASAAS_API_KEY) não está configurada neste ambiente.');
    }

    // PASSO 9: Executar POST /accounts
    const asaasPayload: any = {
      name,
      email,
      cpfCnpj: cleanCpfCnpj,
      phone: cleanPhone,
      mobilePhone: cleanPhone,
      address,
      addressNumber,
      complement: complement || undefined,
      province,
      postalCode: cleanPostalCode,
      companyType: companyType,
      incomeValue: parsedIncomeValue
    };

    if (companyType === 'INDIVIDUAL' && birthDate) {
      asaasPayload.birthDate = birthDate;
    }

    console.log(`Sending subaccount request to Asaas API for instructor ${user.id}`);
    const asaasResponse = await asaasFetch(`${asaasApiUrl}/accounts`, {
      method: 'POST',
      body: JSON.stringify(asaasPayload),
    });

    // TRATAMENTO DE ERROS da API do Asaas
    if (!asaasResponse.ok) {
      const errorText = await asaasResponse.text();
      let friendlyMessage = 'Erro desconhecido na API do Asaas ao criar conta';
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.errors && Array.isArray(errorJson.errors)) {
          friendlyMessage = errorJson.errors.map((err: any) => err.description).join(', ');
        } else if (errorJson.message) {
          friendlyMessage = errorJson.message;
        }
      } catch {
        friendlyMessage = errorText;
      }
      throw new Error(`Asaas [${asaasResponse.status}]: ${friendlyMessage}`);
    }

    // PASSO 10: Capturar id, walletId, status retornados pelo Asaas
    const asaasData = await asaasResponse.json();
    const { id, walletId, status } = asaasData;

    // PASSO 11: Atualizar instructors
    const { error: updateInstructorError } = await supabaseAdmin
      .from('instructors')
      .update({
        provider_name: 'asaas',
        provider_account_id: id,
        provider_wallet_id: walletId,
        provider_status: 'approved',
        provider_onboarding_completed: true,
        payouts_enabled: true
      })
      .eq('id', user.id);

    if (updateInstructorError) throw updateInstructorError;

    // PASSO 12: Atualizar profiles: cpf = cpfCnpj informado somente se estiver NULL
    if (!profile?.cpf) {
      const { error: updateProfileError } = await supabaseAdmin
        .from('profiles')
        .update({ cpf: cleanCpfCnpj })
        .eq('id', user.id);

      if (updateProfileError) {
        console.error(`Erro ao atualizar o CPF/CNPJ do professor id=${user.id}:`, updateProfileError);
      }
    }

    // PASSO 13: Retornar sucesso
    return new Response(
      JSON.stringify({
        success: true,
        provider_account_id: id,
        provider_wallet_id: walletId,
        provider_status: 'approved',
        provider_onboarding_completed: true,
        payouts_enabled: true
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Error in create-asaas-account:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
