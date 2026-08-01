import { createClient } from '@supabase/supabase-js';
import { StudentFinanceReadService } from '../lib/payments/services/StudentFinanceReadService.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const readService = new StudentFinanceReadService();

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const urlPath = req.path || req.url || '';
  let action = req.query.action;

  if (!action) {
    if (urlPath.includes('/summary')) {
      action = 'summary';
    } else if (urlPath.includes('/history')) {
      action = 'history';
    } else {
      action = 'all';
    }
  }

  const studentId = req.query.studentId || user.id;

  try {
    if (action === 'summary') {
      const summary = await readService.getSummary(supabase, studentId);
      return res.status(200).json({ success: true, summary });
    }

    if (action === 'history') {
      const history = await readService.getHistory(supabase, studentId);
      return res.status(200).json({ success: true, history });
    }

    if (action === 'all') {
      const financeData = await readService.getFinanceData(supabase, studentId);
      return res.status(200).json({ success: true, summary: financeData.summary, history: financeData.history });
    }

    return res.status(400).json({ error: `Unknown action '${action}'` });
  } catch (err: any) {
    console.error('❌ [API /api/student-finance] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}
