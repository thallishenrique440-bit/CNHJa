import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectSchema() {
  console.log('--- INSPECIONANDO COLUNAS DE INSTRUCTORS ---');
  const { data: instData, error: instError } = await supabase
    .from('instructors')
    .select('*')
    .limit(1);

  if (instError) {
    console.error('Erro ao ler instructors:', instError.message);
  } else if (instData && instData.length > 0) {
    console.log('Colunas de instructors:', Object.keys(instData[0]));
  } else {
    console.log('Tabela instructors vazia.');
  }

  console.log('\n--- INSPECIONANDO COLUNAS DE PLATFORM_FINANCIAL_SETTINGS ---');
  const { data: settingsData, error: settingsError } = await supabase
    .from('platform_financial_settings')
    .select('*')
    .limit(1);

  if (settingsError) {
    console.error('Erro ao ler platform_financial_settings:', settingsError.message);
  } else if (settingsData && settingsData.length > 0) {
    console.log('Colunas de platform_financial_settings:', Object.keys(settingsData[0]));
    console.log('Registro encontrado:', settingsData[0]);
  } else {
    console.log('Tabela platform_financial_settings vazia.');
  }
}

inspectSchema();
