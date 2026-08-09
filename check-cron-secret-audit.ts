import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

console.log('ENV KEYS:', Object.keys(process.env).filter(k => !k.startsWith('npm_')));
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('VITE_SUPABASE_URL:', process.env.VITE_SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY len:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length);
console.log('VITE_SUPABASE_ANON_KEY len:', process.env.VITE_SUPABASE_ANON_KEY?.length);

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || '';

console.log('Testing with SUPABASE_SERVICE_ROLE_KEY...');
const clientService = createClient(url, serviceKey);
clientService.from('appointments').select('id').limit(1).then(res => {
  console.log('clientService result error:', res.error);
});

console.log('Testing with VITE_SUPABASE_ANON_KEY...');
const clientAnon = createClient(url, anonKey);
clientAnon.from('appointments').select('id').limit(1).then(res => {
  console.log('clientAnon result error:', res.error);
});

