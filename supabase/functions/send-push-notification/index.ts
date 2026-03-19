import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

// --- Funções Utilitárias para Geração de JWT Nativo no Deno ---

function encodeBase64Url(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeBase64UrlBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.substring(
    pem.indexOf(pemHeader) + pemHeader.length,
    pem.indexOf(pemFooter)
  ).replace(/\s/g, '');

  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    true,
    ["sign"]
  );
}

async function getFirebaseAccessToken(serviceAccount: any): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedClaimSet = encodeBase64Url(JSON.stringify(claimSet));
  const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

  const privateKey = await importPrivateKey(serviceAccount.private_key);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(signatureInput)
  );

  const encodedSignature = encodeBase64UrlBuffer(signature);
  const jwt = `${signatureInput}.${encodedSignature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

// --- Fim das Funções Utilitárias ---

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload: WebhookPayload = await req.json()
    
    // Only process UPDATE to the appointments table
    if (payload.table !== 'appointments' || payload.type !== 'UPDATE') {
      return new Response(JSON.stringify({ message: 'Ignored: Not an appointment update' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    const oldStatus = payload.old_record?.status
    const newStatus = payload.record?.status

    // Only process if the status actually changed (for UPDATE)
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

    if (newStatus === 'pending_approval' && oldStatus !== 'pending_approval') {
      // 1. Student requested a class (payment confirmed) -> Notify Instructor
      targetUserId = payload.record.instructor_id
      title = 'Novo agendamento'
      body = 'Um aluno solicitou uma nova aula.'
    } else if (newStatus === 'confirmed' && oldStatus === 'pending_approval') {
      // 2. Instructor approved -> Notify Student
      targetUserId = payload.record.student_id
      const category = payload.record.category
      
      if (category === 'A') {
        title = 'Aula Aprovada 🏍️'
        body = 'Seu instrutor aceitou a aula de moto. Nos vemos no horário combinado!'
      } else {
        title = 'Aula Aprovada 🚗'
        body = 'Seu instrutor aceitou a aula de carro. Nos vemos no horário combinado!'
      }
    } else if (payload.type === 'UPDATE' && newStatus === 'cancelled') {
      // 3. Someone cancelled -> Notify the other party
      targetUserId = payload.record.cancelled_by === 'student' ? payload.record.instructor_id : payload.record.student_id
      title = 'Aula cancelada'
      body = `A aula foi cancelada pelo ${payload.record.cancelled_by === 'student' ? 'aluno' : 'instrutor'}.`
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

    // Authenticate with Google to get an OAuth2 token for FCM HTTP v1 API using Deno Native Web Crypto
    const accessToken = await getFirebaseAccessToken(serviceAccount)

    if (!accessToken) {
      throw new Error('Failed to get access token for Firebase')
    }

    // Send the notification via FCM HTTP v1 API
    const projectId = serviceAccount.project_id
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`

    const url = targetUserId === payload.record.student_id ? '/student/lessons' : '/instructor/agenda'

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
            url
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
