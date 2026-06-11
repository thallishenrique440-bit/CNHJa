import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkProfiles() {
  const studentIds = [
    '9fa0a7f6-25d2-4d80-8722-b099b24574e3',
    'cc9f0edb-8dd3-4dde-9c3f-f6f185212e1a'
  ];

  console.log('--- AUDITORIA DE PROFILES ENVOLVIDOS ---');
  for (const id of studentIds) {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, phone, cpf, stripe_customer_id, provider_customer_id, provider_name')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error(`Erro ao buscar profile ${id}:`, error.message);
    } else if (!profile) {
      console.log(`Profile ${id} não encontrado.`);
    } else {
      console.log(`Profile do Aluno (${id}):`);
      console.log(`  Nome: "${profile.full_name}"`);
      console.log(`  E-mail: "${profile.email}"`);
      console.log(`  Telefone: "${profile.phone}"`);
      console.log(`  CPF: "${profile.cpf}"`);
      console.log(`  Stripe Customer ID: "${profile.stripe_customer_id}"`);
      console.log(`  Provider Customer ID (Asaas): "${profile.provider_customer_id}"`);
      console.log(`  Provider Name configurado: "${profile.provider_name}"`);
      console.log('-------------------------');
    }
  }

  // Buscar primeiro instrutor
  const { data: instructors, error: instError } = await supabase
    .from('instructors')
    .select('id, user_id, name, stripe_account_id, provider_account_id, provider_wallet_id, provider_name')
    .limit(3);

  if (instError) {
    console.error('Erro ao buscar instrutores:', instError.message);
  } else {
    console.log('--- DETALHES DOS INSTRUTORES ---');
    instructors.forEach(inst => {
      console.log(`Instrutor (${inst.id}):`);
      console.log(`  Nome: "${inst.name}"`);
      console.log(`  Stripe Account ID: "${inst.stripe_account_id}"`);
      console.log(`  Provider Account ID (Asaas): "${inst.provider_account_id}"`);
      console.log(`  Provider Wallet ID (Asaas): "${inst.provider_wallet_id}"`);
      console.log(`  Provider Name: "${inst.provider_name}"`);
      console.log('-------------------------');
    });
  }
}

checkProfiles();
