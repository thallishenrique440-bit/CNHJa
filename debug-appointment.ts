import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAppointment() {
  const appointmentId = '3e2ffede-603b-453d-adff-554b7a480aad';
  console.log(`Checking appointment: ${appointmentId}`);

  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', appointmentId)
    .single();

  if (error) {
    console.error('Error fetching appointment:', error);
    return;
  }

  if (!data) {
    console.error('Appointment not found');
    return;
  }

  console.log('Appointment Data:', JSON.stringify(data, null, 2));
  console.log(`Status: '${data.status}'`);
  console.log(`Group ID: '${data.group_id}'`);
  console.log(`Payment Intent ID: '${data.payment_intent_id}'`);
}

checkAppointment();
