import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { JWT } from 'https://esm.sh/google-auth-library@9'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  record: any
  old_record: any
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload: WebhookPayload = await req.json()
    
    // Only process updates to the appointments table
    if (payload.table !== 'appointments' || payload.type !== 'UPDATE') {
      return new Response(JSON.stringify({ message: 'Ignored: Not an appointment update' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    const oldStatus = payload.old_record?.status
    const newStatus = payload.record?.status

    // Only process if the status actually changed
    if (oldStatus === newStatus) {
      return new Response(JSON.stringify({ message: 'Ignored: Status did not change' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Determine who should receive the notification and what the message is
    let targetUserId: string | null = null
    let title = ''
    let body = ''

    if (newStatus === 'confirmed' && oldStatus === 'pending_approval') {
      // 1. Instructor approved -> Notify Student
      targetUserId = payload.record.student_id
      const category = payload.record.category
      
      if (category === 'A') {
        title = 'Aula Aprovada 🏍️'
        body = 'Seu instrutor aceitou a aula de moto. Nos vemos no horário combinado!'
      } else {
        title = 'Aula Aprovada 🚗'
        body = 'Seu instrutor aceitou a aula de carro. Nos vemos no horário combinado!'
      }
    } else if (newStatus === 'cancelled' && oldStatus === 'confirmed') {
      // 3. Instructor cancelled a confirmed class -> Notify Student
      targetUserId = payload.record.student_id
      title = 'Aula cancelada'
      body = 'Seu instrutor cancelou a aula. Verifique o motivo diretamente pelo WhatsApp com ele.'
    }

    if (!targetUserId) {
      return new Response(JSON.stringify({ message: 'Ignored: No notification needed for this status change' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Initialize Supabase client to fetch tokens
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Fetch FCM tokens for the target user
    const { data: tokensData, error: tokensError } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('user_id', targetUserId)

    if (tokensError) {
      throw new Error(`Error fetching tokens: ${tokensError.message}`)
    }

    if (!tokensData || tokensData.length === 0) {
      return new Response(JSON.stringify({ message: 'No tokens found for user' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    const tokens = tokensData.map(t => t.token)

    // Get Firebase Service Account from environment variables
    const serviceAccountStr = Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
    if (!serviceAccountStr) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set')
    }
    
    const serviceAccount = JSON.parse(serviceAccountStr)

    // Authenticate with Google to get an OAuth2 token for FCM HTTP v1 API
    const auth = new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    })

    const accessTokenObj = await auth.getAccessToken()
    const accessToken = accessTokenObj.token

    if (!accessToken) {
      throw new Error('Failed to get access token for Firebase')
    }

    // Send the notification via FCM HTTP v1 API
    const projectId = serviceAccount.project_id
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`

    const sendPromises = tokens.map(async (token) => {
      const message = {
        message: {
          token: token,
          notification: {
            title: title,
            body: body,
          },
          data: {
            appointmentId: payload.record.id,
            status: newStatus,
            url: targetUserId === payload.record.student_id ? '/student/lessons' : '/instructor/agenda'
          }
        }
      }

      const response = await fetch(fcmUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      })

      const responseData = await response.json()

      if (!response.ok) {
        console.error('FCM Error:', responseData)
        
        // Handle invalid tokens (cleanup)
        if (
          responseData.error?.status === 'NOT_FOUND' || 
          responseData.error?.status === 'INVALID_ARGUMENT' ||
          responseData.error?.details?.[0]?.errorCode === 'UNREGISTERED'
        ) {
          console.log(`Deleting invalid token: ${token}`)
          await supabase.from('fcm_tokens').delete().eq('token', token)
        }
        
        return { success: false, token, error: responseData.error }
      }

      return { success: true, token, messageId: responseData.name }
    })

    const results = await Promise.all(sendPromises)

    return new Response(JSON.stringify({ message: 'Notifications processed', results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error('Error processing webhook:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
