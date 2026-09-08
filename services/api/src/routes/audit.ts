import { Router } from 'express';
import { supabase } from '@viralforge/supabase';
import { asyncRoute, ensureDefaultOrganization, parseLimit, sendError } from './_helpers';

const router = Router();

router.get('/audit', asyncRoute(async (req, res) => {
  const orgId = await ensureDefaultOrganization();
  let query = supabase
    .from('audit_logs')
    .select('*')
    .eq('organization_id', orgId)
    .order('timestamp', { ascending: false })
    .limit(parseLimit(req.query.limit, 100));

  if (req.query.action) query = query.eq('action', String(req.query.action));
  if (req.query.contentItemId) query = query.eq('content_item_id', String(req.query.contentItemId));

  const { data, error } = await query;
  if (error) return sendError(res, 500, 'Failed to list audit logs', error.message);
  res.json({ ok: true, audit: data || [] });
}));

export default router;
