import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function listRecentTransactions() {
  console.log('Listing 15 most recent transactions by created_at:');

  const { data, error } = await supabase
    .from('transactions')
    .select('id, appointment_id, student_id, instructor_id, created_at, type, amount, gross_amount, platform_fee, net_amount, status, provider_name, provider_payment_id')
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) {
    console.error('Error fetching transactions:', error);
    return;
  }

  if (!data || data.length === 0) {
    console.log('No transactions found.');
    return;
  }

  console.table(data);
}

listRecentTransactions();
