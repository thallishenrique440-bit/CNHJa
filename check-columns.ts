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
  const { data: appointmentsData, error: appointmentsError } = await supabase.from('appointments').select('*').limit(1).single();
  if (appointmentsError) {
    console.error('Error fetching appointments row:', appointmentsError);
  } else {
    console.log('Appointments Columns:', Object.keys(appointmentsData));
  }

  console.log('\nChecking columns of instructors table:');
  const { data: instructorsData, error: instructorsError } = await supabase.from('instructors').select('*').limit(1).single();
  if (instructorsError) {
    console.error('Error fetching instructors row:', instructorsError);
  } else {
    console.log('Instructors Columns:', Object.keys(instructorsData));
  }
}

checkColumns();
