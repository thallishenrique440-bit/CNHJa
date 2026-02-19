import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://ohftsqsxymtrclnpadam.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oZnRzcXN4eW10cmNsbnBhZGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0NzU0NDMsImV4cCI6MjA4NjA1MTQ0M30.4Jf7EmSpBXhtB0ev6cpFgTk88s2MjSAumy2AMGnmjxw';

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});