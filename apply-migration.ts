import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Client } = pg;
const database = 'postgres';
const user = 'postgres';

async function runMigration() {
  const passwords = ['sb_secret_mhpmjq_1FjZ0h6U0ZNy13w_hINym_mc', 'mhpmjq_1FjZ0h6U0ZNy13w_hINym_mc'];
  const host = 'db.ohftsqsxymtrclnpadam.supabase.co';
  const port = 5432;

  const migrationPath = path.join(process.cwd(), 'supabase/migrations/20260719_default_instructor_prices.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  for (const password of passwords) {
    console.log(`Trying database password: ${password.startsWith('sb_secret') ? 'with' : 'without'} prefix...`);
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
      console.log(`SUCCESS! Connected to PostgreSQL.`);
      
      console.log('Applying migration 20260719_default_instructor_prices.sql...');
      await client.query(sql);
      console.log('Migration applied successfully!');
      
      await client.end();
      return;
    } catch (err: any) {
      console.log(`Failed to connect/execute with password:`, err.message);
    }
  }
}

runMigration();
