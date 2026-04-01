import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function listRecentAppointments() {
  console.log('Listing 10 most recent appointments by created_at:');

  const { data, error } = await supabase
    .from('appointments')
    .select('id, created_at, date, start_time, start_time_utc, status, group_id')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error fetching appointments:', error);
    return;
  }

  if (!data || data.length === 0) {
    console.log('No appointments found.');
    return;
  }

  console.table(data);
}

listRecentAppointments();
