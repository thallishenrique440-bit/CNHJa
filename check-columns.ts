import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectSchema() {
  console.log('--- INSPECIONANDO COLUNAS DE PROFILES ---');
  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .limit(1);

  if (profileError) {
    console.error('Erro ao ler profiles:', profileError.message);
  } else if (profileData && profileData.length > 0) {
    console.log('Colunas de profiles:', Object.keys(profileData[0]));
  } else {
    console.log('Tabela profiles vazia.');
  }

  console.log('\n--- INSPECIONANDO COLUNAS DE INSTRUCTORS ---');
  const { data: instructorData, error: instructorError } = await supabase
    .from('instructors')
    .select('*')
    .limit(1);

  if (instructorError) {
    console.error('Erro ao ler instructors:', instructorError.message);
  } else if (instructorData && instructorData.length > 0) {
    console.log('Colunas de instructors:', Object.keys(instructorData[0]));
  } else {
    console.log('Tabela instructors vazia.');
  }
}

inspectSchema();
