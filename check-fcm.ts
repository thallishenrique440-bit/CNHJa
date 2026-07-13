import { createClient } from '@supabase/supabase-js';
import { NotificationService } from './lib/NotificationService';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkFcm() {
  console.log('--- FORENSIC ID CHECK FOR ALL PROFILES ---');
  const { data: pList } = await supabase.from('profiles').select('id, full_name, email, role').order('created_at', { ascending: false });
  console.log('All Profiles in DB:', pList);

  const { data: tList } = await supabase.from('fcm_tokens').select('user_id, token, device_type, created_at');
  console.log('FCM tokens present:', tList);

  const { data: apptList } = await supabase.from('appointments').select('id, student_id, status, created_at').order('created_at', { ascending: false }).limit(5);
  console.log('Recent appointments student IDs:', apptList);

  console.log('--- AUDITORIA DE TOKENS FCM ---');
  const { data: tokens, error: tokenError } = await supabase
    .from('fcm_tokens')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (tokenError) {
    console.error('Erro ao buscar fcm_tokens:', tokenError.message);
  } else if (tokens) {
    console.log(`Encontrados ${tokens.length} fcm_tokens no total:`);
    for (const token of tokens) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('email, full_name, is_profile_complete')
        .eq('id', token.user_id)
        .maybeSingle();

      const { data: userRole } = await supabase
        .from('instructors')
        .select('id')
        .eq('id', token.user_id)
        .maybeSingle();

      const role = userRole ? 'instructor' : 'student';

      console.log(`User: ${token.user_id} (${profile?.full_name || 'No Name'}, Email: ${profile?.email || 'N/A'}, Role: ${role}), Device: ${token.device_type}, Created: ${token.created_at}, Token prefix: ${token.token.substring(0, 15)}...`);
    }
  }

  console.log('\n--- NOTIFICAÇÕES DE OUTROS TIPOS (ACEITAS, REJEITADAS, ETC.) ---');
  const { data: otherNotifs, error: otherNotifError } = await supabase
    .from('notifications')
    .select('id, user_id, title, message, type, created_at')
    .in('type', ['booking_accepted', 'booking_rejected', 'booking_cancelled', 'booking_expired', 'tip', 'reschedule_requested', 'rescheduled'])
    .order('created_at', { ascending: false })
    .limit(30);

  if (otherNotifError) {
    console.error('Erro ao buscar other notifications:', otherNotifError.message);
  } else if (otherNotifs) {
    console.log(`Encontradas ${otherNotifs.length} notificações de outros tipos:`);
    for (const notif of otherNotifs) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', notif.user_id)
        .maybeSingle();
      
      const { data: userRole } = await supabase
        .from('instructors')
        .select('id')
        .eq('id', notif.user_id)
        .maybeSingle();

      const role = userRole ? 'instructor' : 'student';

      console.log(`ID: ${notif.id} [${notif.type}] To: ${notif.user_id} (${profile?.full_name || 'No Name'}, Role: ${role}), Title: "${notif.title}", Msg: "${notif.message}", Created: ${notif.created_at}`);
    }
  }
  console.log('\n--- ÚLTIMOS 10 AGENDAMENTOS (APPOINTMENTS) ---');
  const { data: appts, error: apptError } = await supabase
    .from('appointments')
    .select('id, student_id, instructor_id, status, payment_status, created_at, date, start_time, payment_intent_id, payment_id, updated_by, provider_name')
    .order('created_at', { ascending: false })
    .limit(10);

  if (apptError) {
    console.error('Erro ao buscar appointments:', apptError.message);
  } else if (appts) {
    for (const appt of appts) {
      const { data: student } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', appt.student_id)
        .maybeSingle();

      const { data: instructor } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', appt.instructor_id)
        .maybeSingle();

      console.log(`Appt ID: ${appt.id}, Student: ${student?.full_name || appt.student_id}, Instructor: ${instructor?.full_name || appt.instructor_id}, Status: ${appt.status}, Payment: ${appt.payment_status}, Class Date: ${appt.date} ${appt.start_time}, Provider: ${appt.provider_name || 'N/A'}, PI ID: ${appt.payment_intent_id || 'N/A'}, Pay ID: ${appt.payment_id || 'N/A'}, UpdatedBy: ${appt.updated_by || 'N/A'}, Created: ${appt.created_at}`);
    }
  }
  console.log('\n--- CONTAS DE JOBS EM NOTIFICATION_JOBS ---');
  const statuses = ['pending', 'processing', 'sent', 'failed', 'retry', 'dead'];
  for (const status of statuses) {
    const { count, error } = await supabase
      .from('notification_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);
    
    if (error) {
      console.error(`Erro ao buscar jobs do status ${status}:`, error.message);
    } else {
      console.log(`Status "${status}": ${count || 0} jobs`);
    }
  }

  console.log('\n--- TODOS OS JOBS DE NOTIFICAÇÃO COM DETALHES ---');
  const { data: allJobs, error: allJobsError } = await supabase
    .from('notification_jobs')
    .select('notification_id, status, attempts, next_run_at, completed_at, last_error, updated_at')
    .order('updated_at', { ascending: false });

  if (allJobsError) {
    console.error('Erro ao buscar todos os jobs:', allJobsError.message);
  } else if (allJobs) {
    for (const job of allJobs) {
      const { data: notif } = await supabase
        .from('notifications')
        .select('title, message, type, user_id, created_at')
        .eq('id', job.notification_id)
        .maybeSingle();

      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', notif?.user_id)
        .maybeSingle();

      console.log(`Job ID: ${job.notification_id} [${job.status}], Attempts: ${job.attempts}, To: ${profile?.full_name || notif?.user_id || 'N/A'}, Type: ${notif?.type || 'N/A'}, Title: "${notif?.title || 'N/A'}", Msg: "${notif?.message || 'N/A'}", CreatedNotif: ${notif?.created_at || 'N/A'}, UpdatedJob: ${job.updated_at}`);
    }
  }
  console.log('\n--- TESTE DE ENVIO DE NOTIFICAÇÃO ---');
  try {
    const { data: luanaProfile, error: luanaErr } = await supabase
      .from('profiles')
      .select('id, full_name')
      .ilike('full_name', '%Luana%')
      .maybeSingle();

    if (luanaErr) {
      console.error('Erro ao buscar perfil de Luana:', luanaErr.message);
    } else if (!luanaProfile) {
      console.error('Perfil de Luana não encontrado!');
    } else {
      console.log(`Perfil de Luana encontrado: ID=${luanaProfile.id}, Nome="${luanaProfile.full_name}"`);
      const testResult = await NotificationService.sendBookingAccepted({
        studentId: luanaProfile.id,
        comboCount: 1,
        groupId: '00000000-0000-0000-0000-000000000000'
      });
      console.log('✅ sendBookingAccepted executado com sucesso! ID retornado:', testResult);
    }
  } catch (err: any) {
    console.error('❌ Erro ao executar sendBookingAccepted:', err.message || err);
  }
}

checkFcm();
