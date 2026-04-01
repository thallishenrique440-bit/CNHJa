import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkColumns() {
  console.log('Checking columns of appointments table:');

  const { data, error } = await supabase.rpc('get_table_columns', { table_name: 'appointments' });

  if (error) {
    // If RPC doesn't exist, try a simple query and check the keys of the first row
    const { data: firstRow, error: rowError } = await supabase.from('appointments').select('*').limit(1).single();
    if (rowError) {
      console.error('Error fetching row:', rowError);
      return;
    }
    console.log('Columns found in first row:', Object.keys(firstRow));
  } else {
    console.log('Columns:', data);
  }
}

checkColumns();
