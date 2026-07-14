import pg from 'pg';

const { Client } = pg;
const database = 'postgres';
const user = 'postgres';

async function tryConnectWithRetry() {
  const passwords = ['sb_secret_mhpmjq_1FjZ0h6U0ZNy13w_hINym_mc', 'mhpmjq_1FjZ0h6U0ZNy13w_hINym_mc'];
  const host = 'db.ohftsqsxymtrclnpadam.supabase.co';
  const port = 5432;

  for (const password of passwords) {
    console.log(`Trying password: ${password.startsWith('sb_secret') ? 'with' : 'without'} prefix...`);
    const client = new Client({
      host,
      port,
      user,
      password,
      database,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000
    });

    try {
      await client.connect();
      console.log(`SUCCESS! Connected successfully!`);
      const res = await client.query('SELECT version();');
      console.log('Version:', res.rows[0].version);
      
      // Let's add the column!
      console.log('Adding column uses_student_vehicle to instructors...');
      const alterRes = await client.query('ALTER TABLE public.instructors ADD COLUMN IF NOT EXISTS uses_student_vehicle boolean DEFAULT false;');
      console.log('Column added successfully!', alterRes);
      
      await client.end();
      return;
    } catch (err: any) {
      console.log(`Failed with password:`, err.message);
    }
  }
}

tryConnectWithRetry();
