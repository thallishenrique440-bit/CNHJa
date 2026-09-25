// AP-01 / C-08 — create-booking DESATIVADA (fail-closed).
//
// Esta Edge Function criava appointments com SUPABASE_SERVICE_ROLE_KEY, com
// verify_jwt=false, sem validar data passada, domingo ou grade do instrutor, e
// sem nenhum chamador no produto (o unico caminho vivo de compra e'
// api/create-booking-intent.ts). Como usa service_role, nenhuma regra de banco
// do AP-01 a alcanca: deixa-la ativa manteria um bypass da autoridade de
// criacao. A implementacao anterior esta no historico do git (F4-07 decide a
// remocao definitiva do diretorio e do deploy).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      error: 'Endpoint desativado. Use o fluxo de compra do aplicativo.',
      reason_code: 'ENDPOINT_GONE',
    }),
    { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
