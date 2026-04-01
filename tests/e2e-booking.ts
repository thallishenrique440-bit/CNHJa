
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const APP_URL = 'http://localhost:3000';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function logStatus(appointmentId: string, label: string) {
  const { data, error } = await supabase
    .from('appointments')
    .select('status, payment_status')
    .eq('id', appointmentId)
    .single();
  
  if (error) console.error(`Error fetching status for ${label}:`, error.message);
  else console.log(`[${label}] Status: ${data.status}, Payment: ${data.payment_status}`);
  return data;
}

async function sendWebhook(payload: any, endpoint: string) {
  const isEdge = endpoint.startsWith('/functions/v1/');
  const baseUrl = isEdge ? SUPABASE_URL : APP_URL;
  const url = `${baseUrl}${endpoint}`;
  
  console.log(`Sending ${payload.type} to ${url}...`);
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-bypass': STRIPE_WEBHOOK_SECRET,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` // Required for Edge Functions
    },
    body: JSON.stringify(payload)
  });
  
  if (!res.ok) {
    const text = await res.text();
    let errorMsg = text;
    try {
      const json = JSON.parse(text);
      errorMsg = JSON.stringify(json, null, 2);
    } catch (e) {}
    console.error(`❌ Webhook failed [${res.status}]: ${errorMsg}`);
    throw new Error(`Webhook failed [${res.status}]: ${errorMsg}`);
  }
  const json = await res.json();
  console.log(`✅ Webhook ${payload.type} sent successfully. Response:`, JSON.stringify(json));
}

async function runTests() {
  console.log('🚀 Starting E2E Booking Tests...');

  // Test both endpoints
  const endpoints = ['/api/stripe-webhook', '/functions/v1/stripe-webhook-platform'];

  for (const endpoint of endpoints) {
    console.log(`\n\n========================================`);
    console.log(`🧪 TESTING ENDPOINT: ${endpoint}`);
    console.log(`========================================`);

    const instructorId = 'f3244e03-fc36-4fa4-8b6b-e2bb5f7b6b6f';
    const studentId = 'f3244e03-fc36-4fa4-8b6b-e2bb5f7b6b6f';
    const groupId = uuidv4();
    const piId = `pi_test_${Date.now()}`;

    const randomMonth = Math.floor(Math.random() * 6) + 6; // 6 to 11
    const randomDay = Math.floor(Math.random() * 28) + 1;
    const date = `2026-${randomMonth.toString().padStart(2, '0')}-${randomDay.toString().padStart(2, '0')}`;
    const randomHour = Math.floor(Math.random() * 10) + 8; // 8 to 17
    const startTime = `${randomHour.toString().padStart(2, '0')}:00:00`;
    const endTime = `${(randomHour + 1).toString().padStart(2, '0')}:00:00`;

    // 1. Create Appointment (Reserved)
    const { data: appointment, error: createError } = await supabase
      .from('appointments')
      .insert({
        instructor_id: instructorId,
        student_id: studentId,
        group_id: groupId,
        status: 'reserved',
        payment_status: 'pending',
        date: date,
        start_time: startTime,
        end_time: endTime,
        category: 'B',
        price: 10000
      })
      .select()
      .single();

    if (createError) throw createError;
    const appointmentId = appointment.id;
    console.log(`Created appointment: ${appointmentId} with GroupID: ${groupId}`);
    
    // Verify it exists by group_id
    const { data: verifyApt } = await supabase
      .from('appointments')
      .select('id')
      .eq('group_id', groupId)
      .single();
    
    if (!verifyApt) {
      console.error(`❌ ERROR: Could not find appointment by GroupID: ${groupId}`);
    } else {
      console.log(`✅ Verified appointment exists by GroupID.`);
    }

    await logStatus(appointmentId, 'Initial');

    // --- SCENARIO 1: Normal Flow ---
    console.log('\n--- Scenario 1: Normal Flow ---');
    await sendWebhook({
      id: `evt_auth_${Date.now()}`,
      type: 'payment_intent.amount_capturable_updated',
      data: {
        object: {
          id: piId,
          amount: 10000,
          metadata: { group_id: groupId, instructor_id: instructorId, student_id: studentId }
        }
      }
    }, endpoint);
    await logStatus(appointmentId, 'After Auth');

    await sendWebhook({
      id: `evt_succ_${Date.now()}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: piId,
          amount: 10000,
          metadata: { group_id: groupId, instructor_id: instructorId, student_id: studentId }
        }
      }
    }, endpoint);
    await logStatus(appointmentId, 'After Succeeded');

    // --- SCENARIO 2: Out of Order ---
    console.log('\n--- Scenario 2: Out of Order ---');
    const groupId2 = uuidv4();
    const piId2 = `pi_test_ooo_${Date.now()}`;
    
    const startTime2 = `${(randomHour + 2).toString().padStart(2, '0')}:00:00`;
    const endTime2 = `${(randomHour + 3).toString().padStart(2, '0')}:00:00`;

    const { data: apt2 } = await supabase
      .from('appointments')
      .insert({
        instructor_id: instructorId,
        student_id: studentId,
        group_id: groupId2,
        status: 'reserved',
        payment_status: 'pending',
        date: date,
        start_time: startTime2,
        end_time: endTime2,
        category: 'B',
        price: 10000
      })
      .select().single();

    await sendWebhook({
      id: `evt_succ_2_${Date.now()}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: piId2,
          amount: 10000,
          metadata: { group_id: groupId2, instructor_id: instructorId, student_id: studentId }
        }
      }
    }, endpoint);
    await logStatus(apt2.id, 'After Succeeded (OOO)');

    await sendWebhook({
      id: `evt_auth_2_${Date.now()}`,
      type: 'payment_intent.amount_capturable_updated',
      data: {
        object: {
          id: piId2,
          amount: 10000,
          metadata: { group_id: groupId2, instructor_id: instructorId, student_id: studentId }
        }
      }
    }, endpoint);
    const finalApt2 = await logStatus(apt2.id, 'After Late Auth');
    
    if (finalApt2.status === 'confirmed') {
      console.log('✅ Success: Status remained confirmed despite late auth event.');
    } else {
      console.error('❌ Failure: Status was downgraded!');
    }

    // --- SCENARIO 3: Idempotency ---
    console.log('\n--- Scenario 3: Idempotency ---');
    await sendWebhook({
      id: `evt_succ_2_dup_${Date.now()}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: piId2,
          amount: 10000,
          metadata: { group_id: groupId2, instructor_id: instructorId, student_id: studentId }
        }
      }
    }, endpoint);
    await logStatus(apt2.id, 'After Duplicate Succeeded');

    // --- SCENARIO 4: Cancellation ---
    console.log('\n--- Scenario 4: Cancellation ---');
    const groupId3 = uuidv4();
    const piId3 = `pi_test_can_${Date.now()}`;
    
    const startTime3 = `${(randomHour + 4).toString().padStart(2, '0')}:00:00`;
    const endTime3 = `${(randomHour + 5).toString().padStart(2, '0')}:00:00`;

    const { data: apt3 } = await supabase
      .from('appointments')
      .insert({
        instructor_id: instructorId,
        student_id: studentId,
        group_id: groupId3,
        status: 'reserved',
        payment_status: 'pending',
        date: date,
        start_time: startTime3,
        end_time: endTime3,
        category: 'B',
        price: 10000
      })
      .select().single();

    await sendWebhook({
      type: 'payment_intent.amount_capturable_updated',
      data: { object: { id: piId3, metadata: { group_id: groupId3 } } }
    }, endpoint);
    await logStatus(apt3.id, 'After Auth (Cancellation Test)');

    await sendWebhook({
      type: 'payment_intent.canceled',
      data: { object: { id: piId3, metadata: { group_id: groupId3 } } }
    }, endpoint);
    await logStatus(apt3.id, 'After Canceled');
  }

  console.log('\n🏁 E2E Tests Completed.');
}

runTests().catch(err => {
  console.error('❌ Test Suite Failed:', err);
  process.exit(1);
});
