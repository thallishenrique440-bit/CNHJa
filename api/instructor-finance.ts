import { createClient } from '@supabase/supabase-js';
import { InstructorFinanceReadService } from '../lib/payments/services/InstructorFinanceReadService.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const readService = new InstructorFinanceReadService();

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

  // Determine action from subpath (e.g. /api/instructor-finance/summary -> summary) or query parameter ?action=
  const urlPath = req.path || req.url || '';
  let action = req.query.action;

  if (!action) {
    if (urlPath.includes('/summary')) {
      action = 'summary';
    } else if (urlPath.includes('/statement')) {
      action = 'statement';
    } else if (urlPath.includes('/cashflow')) {
      action = 'cashflow';
    } else {
      action = 'summary';
    }
  }

  const instructorId = req.query.instructorId || user.id;

  try {
    if (action === 'summary') {
      const summary = await readService.getSummary(supabase, instructorId);
      return res.status(200).json({ success: true, summary });
    }

    if (action === 'statement') {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
      const status = req.query.status || undefined;

      const statement = await readService.getStatement(supabase, instructorId, { limit, offset, status });
      return res.status(200).json({ success: true, statement });
    }

    if (action === 'cashflow') {
      const startDate = req.query.startDate || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const endDate = req.query.endDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

      const cashFlow = await readService.getCashFlow(supabase, instructorId, startDate, endDate);
      return res.status(200).json({ success: true, cashFlow });
    }

    return res.status(400).json({ error: `Unknown action '${action}'` });
  } catch (err: any) {
    console.error('❌ [API /api/instructor-finance] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}
