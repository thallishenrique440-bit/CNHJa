import { createClient } from '@supabase/supabase-js';

console.log('--- Environment Check ---');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL || 'UNDEFINED');
console.log('SUPABASE_SERVICE_ROLE_KEY exists:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('SUPABASE_SERVICE_ROLE_KEY prefix:', process.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 10) + '...');
}

try {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  console.log('Supabase client initialized successfully.');
} catch (error: any) {
  console.error('Supabase initialization failed:', error.message);
}
