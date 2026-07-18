import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: any, res: any) {
  // 1. Validate Method (GET for Cron, POST for manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Validate Authorization (CRON_SECRET)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('⏰ Starting complete-lessons job...');

    // Call RPC to auto-complete lessons
    const { data: updatedCount, error: rpcError } = await supabaseAdmin
      .rpc('auto_complete_lessons');

    if (rpcError) {
      console.error("❌ Error executing auto_complete_lessons RPC:", rpcError);
      throw rpcError;
    }

    const actualProcessedCount = updatedCount || 0;
    console.log(`Successfully completed ${actualProcessedCount} lessons.`);

    return res.status(200).json({ 
        message: 'Job completed', 
        processed: actualProcessedCount 
    });

  } catch (error: any) {
    console.error("🚨 Critical Job Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
