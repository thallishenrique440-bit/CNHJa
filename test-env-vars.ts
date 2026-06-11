console.log('--- DIAGNÓSTICO DE VARIÁVEIS DE AMBIENTE ---');
console.log('ASAAS_API_KEY definida:', !!process.env.ASAAS_API_KEY);
if (process.env.ASAAS_API_KEY) {
  console.log('ASAAS_API_KEY length:', process.env.ASAAS_API_KEY.length);
  console.log('ASAAS_API_KEY prefix/suffix:', process.env.ASAAS_API_KEY.substring(0, 10) + '...' + process.env.ASAAS_API_KEY.slice(-5));
}
console.log('ASAAS_API_URL definida:', !!process.env.ASAAS_API_URL);
if (process.env.ASAAS_API_URL) {
  console.log('ASAAS_API_URL value:', process.env.ASAAS_API_URL);
}
console.log('SUPABASE_URL definida:', !!process.env.SUPABASE_URL);
console.log('-------------------------------------------');
