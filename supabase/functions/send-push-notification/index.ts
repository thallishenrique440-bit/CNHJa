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

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload: WebhookPayload = await req.json()
    
    // Check if it is a tip notification insert
    const isTipNotification = payload.table === 'notifications' && payload.type === 'INSERT' && payload.record?.type === 'tip'

    // Only process UPDATE to the appointments table OR INSERT of a tip to the notifications table
    if (!isTipNotification && (payload.table !== 'appointments' || payload.type !== 'UPDATE')) {
      return new Response(JSON.stringify({ message: 'Ignored: Not a valid event' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    let targetUserId: string | null = null
    let title = ''
    let body = ''
    let notificationType: string = ''
    let appointmentId: string | null = null
    let newStatus = 'completed'

    // Initialize Supabase client early
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    if (isTipNotification) {
      targetUserId = payload.record.user_id
      title = payload.record.title
      body = payload.record.message
      notificationType = payload.record.type
      appointmentId = payload.record.metadata?.appointment_id || null
      newStatus = 'completed'

      // --- IDEMPOTÊNCIA INDIVIDUAL (INSERT-FIRST) ---
      // Para caixinha, registramos na notification_logs com status = 'tip_push'
      const { error: logInsertError } = await supabase
        .from('notification_logs')
        .insert({
          appointment_id: appointmentId,
          status: 'tip_push',
          target_user_id: targetUserId
        })

      if (logInsertError) {
        if (logInsertError.code === '23505') {
          console.log('[PUSH REQUEST] Ignored: Tip push notification already processed (idempotency constraint)');
          return new Response(JSON.stringify({ message: 'Ignored: Tip push notification already processed (idempotency)' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          })
        }
        console.error('[PUSH ERROR] Error inserting tip notification log:', logInsertError)
      }

    } else {
      const oldStatus = payload.old_record?.status
      const newStatusVal = payload.record?.status
      const actorId = payload.record?.updated_by
      const groupId = payload.record?.group_id
      const cancelledReason = payload.record?.cancelled_reason

      // Reschedule changes
      const oldReschedReq = payload.old_record?.reschedule_requested_at
      const newReschedReq = payload.record?.reschedule_requested_at
      const oldRescheduled = payload.old_record?.rescheduled_at
      const newRescheduled = payload.record?.rescheduled_at

      const isRescheduleRequested = !oldReschedReq && newReschedReq
      const isRescheduleApproved = !oldRescheduled && newRescheduled && oldReschedReq && !newReschedReq
      const isRescheduleRejected = oldReschedReq && !newReschedReq && !newRescheduled

      const isRescheduleEvent = isRescheduleRequested || isRescheduleApproved || isRescheduleRejected

      // Only process if the status actually changed (for UPDATE) OR if a reschedule event occurred
      if (oldStatus === newStatusVal && !isRescheduleEvent) {
        return new Response(JSON.stringify({ message: 'Ignored: Status did not change and no reschedule event' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }

      // --- LOG [PUSH REQUEST] ---
      console.log('[PUSH REQUEST] Received webhook event:', {
        table: payload.table,
        type: payload.type,
        oldStatus,
        newStatus: newStatusVal,
        appointmentId: payload.record?.id,
        groupId,
        actorId,
        cancelledReason
      });

      // Ignore technical cancellations for checkout retries to avoid confusing users
      if (newStatusVal === 'cancelled' && cancelledReason === 'user_retry_new_attempt') {
        console.log('[PUSH REQUEST] Ignored: Technical cancellation (user_retry_new_attempt)');
        return new Response(JSON.stringify({ message: 'Ignored: Technical cancellation for user retry' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }

      appointmentId = payload.record?.id
      newStatus = newStatusVal

      if (isRescheduleRequested) {
        targetUserId = payload.record.instructor_id
        notificationType = 'booking_request'
      } else if (isRescheduleApproved) {
        targetUserId = payload.record.student_id
        notificationType = 'booking_accepted'
      } else if (isRescheduleRejected) {
        targetUserId = payload.record.student_id
        notificationType = 'booking_rejected'
      } else if (newStatusVal === 'pending_approval' && oldStatus !== 'pending_approval') {
        targetUserId = payload.record.instructor_id
        notificationType = 'booking_request'
      } else if (newStatusVal === 'confirmed' && oldStatus === 'pending_approval') {
        targetUserId = payload.record.student_id
        notificationType = 'booking_accepted'
      } else if (newStatusVal === 'cancelled') {
        targetUserId = payload.record.cancelled_by === 'student' ? payload.record.instructor_id : payload.record.student_id
        notificationType = 'booking_cancelled'
      } else if (newStatusVal === 'rejected') {
        targetUserId = payload.record.student_id
        notificationType = 'booking_rejected'
      } else if (newStatusVal === 'expired') {
        targetUserId = payload.record.student_id
        notificationType = 'booking_cancelled'
      }

      if (!targetUserId) {
        console.log('[PUSH REQUEST] Ignored: No target user identified for status code change');
        return new Response(JSON.stringify({ message: 'Ignored: No notification needed for this status change' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }

      // --- PROTEÇÃO CONTRA AUTO-NOTIFICAÇÃO ---
      if (actorId && targetUserId === actorId) {
        console.log('[PUSH REQUEST] Ignored: Actor is the target user itself');
        return new Response(JSON.stringify({ message: 'Ignored: Actor is the target user' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }

      const notificationStatus = isRescheduleRequested
        ? 'reschedule_requested'
        : isRescheduleApproved
        ? 'reschedule_approved'
        : isRescheduleRejected
        ? 'reschedule_rejected'
        : newStatusVal;

      // --- IDEMPOTÊNCIA INDIVIDUAL (INSERT-FIRST) ---
      const { error: logInsertError } = await supabase
        .from('notification_logs')
        .insert({
          appointment_id: appointmentId,
          group_id: groupId,
          status: notificationStatus,
          target_user_id: targetUserId
        })

      if (logInsertError) {
        if (logInsertError.code === '23505') {
          console.log('[PUSH REQUEST] Ignored: Notification already processed (idempotency constraint)');
          return new Response(JSON.stringify({ message: 'Ignored: Notification already processed (idempotency)' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          })
        }
        console.error('[PUSH ERROR] Error inserting notification log:', logInsertError)
      }

      // Fetch student's full name to personalize title and body
      const studentId = payload.record.student_id
      let studentName = 'Um aluno'
      if (studentId) {
        const { data: studentProfile, error: studentError } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', studentId)
          .maybeSingle()
        if (!studentError && studentProfile?.full_name) {
          studentName = studentProfile.full_name
        }
      }

      const startTime = payload.record.start_time ? payload.record.start_time.substring(0, 5) : 'horário marcado'

      let isCombo = false
      let comboCount = 1

      // --- AGRUPAMENTO (DEBOUNCE POR GROUP_ID) ---
      if (groupId) {
        const twentySecondsAgo = new Date(Date.now() - 20000).toISOString()
        const { data: recentGroupLog, error: groupLogError } = await supabase
          .from('notification_logs')
          .select('id')
          .eq('group_id', groupId)
          .eq('status', notificationStatus)
          .eq('target_user_id', targetUserId)
          .neq('appointment_id', appointmentId) // Exclui o log que acabamos de criar
          .gt('created_at', twentySecondsAgo)
          .maybeSingle()

        if (groupLogError) {
          console.error('[PUSH ERROR] Error checking group notification log:', groupLogError)
        }

        if (recentGroupLog) {
          console.log('[PUSH REQUEST] Ignored: Group already notified recently (debounce check)');
          return new Response(JSON.stringify({ message: 'Ignored: Group already notified recently (debounce)' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          })
        }

        // --- AGREGAÇÃO (CONTAGEM DE AULAS NO GRUPO) ---
        const { count, error: countError } = await supabase
          .from('appointments')
          .select('id', { count: 'exact', head: true })
          .eq('group_id', groupId)
          .eq('status', newStatusVal)
          .eq('instructor_id', payload.record.instructor_id)
          .eq('student_id', payload.record.student_id)

        if (countError) {
          console.error('[PUSH ERROR] Error counting group appointments:', countError)
        }

        if (count && count > 1) {
          isCombo = true
          comboCount = count
        }
      }

      // Dynamic messaging formatting
      if (isRescheduleRequested) {
        title = 'Solicitação de remarcação'
        body = `${studentName} pediu para remarcar a aula das ${startTime}.`
      } else if (isRescheduleApproved) {
        title = 'Remarcação aceita'
        body = 'Seu instrutor aceitou a solicitação de remarcação.'
      } else if (isRescheduleRejected) {
        title = 'Remarcação recusada'
        body = 'O instrutor recusou o pedido de remarcação da aula.'
      } else if (newStatusVal === 'pending_approval') {
        if (isCombo) {
          title = 'Novo combo solicitado'
          body = `${studentName} solicitou um combo com ${comboCount} aulas.`
        } else {
          title = 'Nova solicitação de aula'
          body = `${studentName} solicitou uma aula às ${startTime}.`
        }
      } else if (newStatusVal === 'confirmed') {
        title = 'Aula confirmada'
        body = 'Seu instrutor confirmou sua aula.'
      } else if (newStatusVal === 'rejected') {
        title = 'Aula recusada'
        body = 'Sua solicitação de aula foi recusada.'
      } else if (newStatusVal === 'cancelled') {
        title = 'Aula cancelada'
        body = 'Uma aula foi cancelada.'
      } else if (newStatusVal === 'expired') {
        title = 'Agendamento expirado'
        body = 'O prazo para aceitar sua aula expirou.'
      }

      // --- INSERÇÃO NA TABELA DE NOTIFICAÇÕES (In-App) ---
      const { error: inAppError } = await supabase
        .from('notifications')
        .insert({
          user_id: targetUserId,
          title,
          message: body,
          type: notificationType,
          metadata: {
            appointment_id: appointmentId,
            status: newStatus
          }
        })

      if (inAppError) {
        console.error('[PUSH ERROR] Error inserting in-app notification:', inAppError)
      }
    }

    // --- ENVIO PUSH (FCM) ---
    // Fetch FCM tokens for the target user
    const { data: tokensData, error: tokensError } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('user_id', targetUserId)

    if (tokensError) {
      console.error('[PUSH ERROR] Error fetching token data:', tokensError)
      throw new Error(`Error fetching tokens: ${tokensError.message}`)
    }

    // --- LOG [PUSH TOKENS] ---
    console.log('[PUSH TOKENS] Found active tokens for target user:', {
      targetUserId,
      tokenCount: tokensData?.length || 0,
      tokenMasks: tokensData?.map(t => t.token.substring(0, 8) + '...' + t.token.substring(t.token.length - 8)) || []
    });

    if (!tokensData || tokensData.length === 0) {
      return new Response(JSON.stringify({ message: 'In-app notification sent, but no FCM tokens found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    const tokens = tokensData.map(t => t.token)

    // Get Firebase Service Account from environment variables
    const serviceAccountStr = Deno.env.get('FIREBASE_SERVICE_ACCOUNT')
    if (!serviceAccountStr) {
      console.error('[PUSH ERROR] FIREBASE_SERVICE_ACCOUNT environment variable is not defined!');
      throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set')
    }
    
    const serviceAccount = JSON.parse(serviceAccountStr)

    // Authenticate with Google to get an OAuth2 token for FCM HTTP v1 API using Deno Native Web Crypto
    const accessToken = await getFirebaseAccessToken(serviceAccount)

    if (!accessToken) {
      console.error('[PUSH ERROR] Failed to generate OAuth2 accessToken from Google APIs credentials');
      throw new Error('Failed to get access token for Firebase')
    }

    // Send the notification via FCM HTTP v1 API
    const projectId = serviceAccount.project_id
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`

    // --- SPECIAL HANDLING FOR EXPIRED BOOKINGS: NOTIFY INSTRUCTOR ---
    if (newStatus === 'expired' && payload.record?.instructor_id) {
      const instId = payload.record.instructor_id;
      const instTitle = 'Solicitação expirada';
      const instBody = 'A solicitação expirou porque não foi aceita até 20 minutos antes do horário da aula.';
      
      console.log(`[PUSH SPECIAL] Booking ${appointmentId} expired. Sending notification to instructor: ${instId}`);

      try {
        // 1. Insert In-App Notification for instructor
        const { error: instInAppError } = await supabase
          .from('notifications')
          .insert({
            user_id: instId,
            title: instTitle,
            message: instBody,
            type: 'booking_cancelled',
            metadata: {
              appointment_id: appointmentId,
              status: 'expired'
            }
          });
        if (instInAppError) {
          console.error('[PUSH ERROR] Error inserting instructor in-app notification:', instInAppError);
        } else {
          console.log('[PUSH SPECIAL] Instructor in-app notification inserted successfully.');
        }

        // 2. Fetch FCM tokens for instructor and send push
        const { data: instTokensData, error: instTokensErr } = await supabase
          .from('fcm_tokens')
          .select('token')
          .eq('user_id', instId);
        
        if (instTokensErr) {
          console.error('[PUSH ERROR] Error fetching instructor tokens:', instTokensErr);
        } else if (instTokensData && instTokensData.length > 0) {
          const instTokens = instTokensData.map(t => t.token);
          console.log(`[PUSH SPECIAL] Found ${instTokens.length} tokens for instructor. Dispatching FCM push messages.`);
          
          const instSendPromises = instTokens.map(async (token) => {
            const message = {
              message: {
                token: token,
                notification: {
                  title: instTitle,
                  body: instBody,
                },
                webpush: {
                  notification: {
                    icon: '/android-chrome-192x192.png',
                    badge: '/android-chrome-192x192.png',
                  }
                },
                data: {
                  appointmentId: appointmentId || '',
                  status: 'expired',
                  url: '/#/instructor/agenda'
                }
              }
            };
            try {
              const res = await fetch(fcmUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(message),
              });
              const resData = await res.json();
              if (!res.ok) {
                console.error(`[PUSH SPECIAL ERROR] FCM failed for instructor token:`, resData);
              } else {
                console.log(`[PUSH SPECIAL SUCCESS] FCM succeeded for instructor token:`, resData.name);
              }
            } catch (e) {
              console.error('Error sending instructor FCM:', e);
            }
          });
          await Promise.all(instSendPromises);
        } else {
          console.log('[PUSH SPECIAL] No FCM tokens found for instructor.');
        }
      } catch (e) {
        console.error('Error during special instructor notification:', e);
      }
    }

    const url = isTipNotification ? '/#/instructor/finance' : (targetUserId === payload.record?.student_id ? '/#/student/lessons' : '/#/instructor/agenda')

    const sendPromises = tokens.map(async (token) => {
      const message = {
        message: {
          token: token,
          notification: {
            title: title,
            body: body,
          },
          webpush: {
            notification: {
              icon: '/android-chrome-192x192.png',
              badge: '/android-chrome-192x192.png',
            }
          },
          data: {
            appointmentId: appointmentId || '',
            status: newStatus,
            url
          }
        }
      }

      // --- LOG [PUSH PAYLOAD] ---
      console.log('[PUSH PAYLOAD] Payload being dispatched to FCM API:', JSON.stringify(message, null, 2));

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
        // --- LOG [PUSH ERROR] ---
        console.error('[PUSH ERROR] FCM service responded with failure:', responseData)
        
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

      // --- LOG [PUSH RESPONSE] ---
      console.log('[PUSH RESPONSE] FCM success response:', responseData)

      return { success: true, token, messageId: responseData.name }
    })

    const results = await Promise.all(sendPromises)

    return new Response(JSON.stringify({ message: 'Notifications processed', results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error('[PUSH ERROR] Error processing webhook:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
