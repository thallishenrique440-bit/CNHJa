import { createClient } from 'jsr:@supabase/supabase-js@2'

// Declare Deno to resolve TypeScript errors in environments where Deno types are not automatically included
declare const Deno: any;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: any) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. TRAVA DE SEGURANÇA (Hardening)
    // Verifica se a requisição possui a Service Role Key no header Authorization.
    // Isso impede que usuários anônimos ou logados (com tokens normais) disparem a limpeza manualmente.
    const authHeader = req.headers.get('Authorization')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!authHeader || !authHeader.includes(serviceRoleKey ?? 'NO_KEY_FOUND')) {
      console.warn('[Cleanup] Tentativa de acesso não autorizado bloqueada.')
      return new Response(
        JSON.stringify({ error: 'Unauthorized. Requires Service Role Key.' }),
        { 
          status: 401, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // 2. Conexão Admin com o Banco
    // Usamos a Service Role Key para ter permissão de executar a RPC 'SECURITY DEFINER'
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log('[Cleanup] Iniciando limpeza de reservas expiradas...')

    // 3. Execução da RPC no Banco de Dados
    const { data, error } = await supabase.rpc('cleanup_expired_reservations')

    if (error) {
      console.error('[Cleanup] Erro RPC:', error)
      throw error
    }

    console.log('[Cleanup] Sucesso.')

    return new Response(
      JSON.stringify({ message: 'Cleanup executed successfully', data }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (err: any) {
    console.error('[Cleanup] Erro Crítico:', err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})