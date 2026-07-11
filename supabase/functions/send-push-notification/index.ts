import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface WebhookPayload {
  notification_id?: string
  // Support standard webhook payload structure if needed
  record?: any
}

// --- Native JWT Generation Helpers for Deno ---
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

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload: WebhookPayload = await req.json()
    
    // Determine notification_id (could be passed directly or inside a webhook record)
    const notificationId = payload.notification_id || payload.record?.id
    
    if (!notificationId) {
      console.warn('[PUSH DISPATCHER] Ignored: No notification_id provided in the payload', payload);
      return new Response(JSON.stringify({ success: false, error: 'No notification_id provided' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    console.log(`[PUSH DISPATCHER] Starting dispatch for notification: ${notificationId}`);

    // Initialize Supabase Client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Fetch the notification row
    const { data: notification, error: notifError } = await supabase
      .from('notifications')
      .select('*')
      .eq('id', notificationId)
      .maybeSingle()

    if (notifError || !notification) {
      console.error(`[PUSH DISPATCHER] Failed to fetch notification ${notificationId}:`, notifError);
      return new Response(JSON.stringify({ success: false, error: 'Notification not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 404,
      })
    }

    const { user_id, title, message, type, group_id, appointment_id, entity_type, target_screen } = notification

    // Resolve all active FCM tokens for the recipient user
    const { data: tokensData, error: tokensError } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('user_id', user_id)

    if (tokensError) {
      console.error(`[PUSH DISPATCHER] Error fetching FCM tokens for user ${user_id}:`, tokensError);
      throw new Error(`Error fetching tokens: ${tokensError.message}`)
    }

    console.log(`[PUSH DISPATCHER] Found ${tokensData?.length || 0} active tokens for recipient user: ${user_id}`);

    if (!tokensData || tokensData.length === 0) {
      return new Response(JSON.stringify({ success: true, message: 'Notification exists, but no active FCM tokens found for the user.', results: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Authenticate with Google
    const serviceAccountStr = Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
    if (!serviceAccountStr) {
      console.error('[PUSH DISPATCHER] FIREBASE_SERVICE_ACCOUNT environment variable is not defined!');
      throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set')
    }
    const serviceAccount = JSON.parse(serviceAccountStr)
    const accessToken = await getFirebaseAccessToken(serviceAccount)

    if (!accessToken) {
      console.error('[PUSH DISPATCHER] Failed to generate Google OAuth2 token.');
      throw new Error('Failed to get access token for Firebase')
    }

    const projectId = serviceAccount.project_id
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`

    // Dispatch Push Notification to each active device
    const dispatchPromises = tokensData.map(async ({ token }) => {
      // Build semantic-only clean payload (payload_version = 1, NO URLs inside data, completely semantic-driven)
      const fcmPayload = {
        message: {
          token: token,
          notification: {
            title: title,
            body: message,
          },
          webpush: {
            notification: {
              icon: '/android-chrome-192x192.png',
              badge: '/android-chrome-192x192.png',
            }
          },
          data: {
            notification_id: String(notificationId || ''),
            group_id: String(group_id || ''),
            appointment_id: String(appointment_id || ''),
            notification_type: String(type || ''),
            entity_type: String(entity_type || ''),
            target_screen: String(target_screen || ''),
            payload_version: '1'
          }
        }
      }

      console.log(`[PUSH DISPATCHER] Sending semantic payload to device with token prefix: ${token.substring(0, 10)}...`);

      const response = await fetch(fcmUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fcmPayload),
      })

      const responseData = await response.json()

      if (!response.ok) {
        console.error(`[PUSH DISPATCHER ERROR] FCM responded with failure for token ${token.substring(0, 10)}...:`, responseData)
        
        // Auto-cleanup stale tokens
        if (
          responseData.error?.status === 'NOT_FOUND' || 
          responseData.error?.status === 'INVALID_ARGUMENT' ||
          responseData.error?.details?.[0]?.errorCode === 'UNREGISTERED'
        ) {
          console.log(`[PUSH DISPATCHER CLEANUP] Deleting unregistered/invalid token: ${token.substring(0, 10)}...`)
          await supabase.from('fcm_tokens').delete().eq('token', token)
        }
        
        return { success: false, error: responseData.error }
      }

      console.log(`[PUSH DISPATCHER SUCCESS] Push sent successfully! MessageID: ${responseData.name}`);
      return { success: true, messageId: responseData.name }
    })

    const results = await Promise.all(dispatchPromises)

    return new Response(JSON.stringify({ success: true, message: 'Push notifications dispatched successfully', results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error: any) {
    console.error('[PUSH DISPATCHER FATAL] Error during push dispatching process:', error)
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
