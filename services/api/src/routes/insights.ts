import { Router } from 'express';
import { z } from 'zod';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { DAILY_NICHES, engagementRate, minuteToSlot } from '@viralforge/domain';
import { getQueue, QUEUE_NAMES } from '../queues/connection';
import { asyncRoute, ensureDefaultOrganization, sendError } from './_helpers';

const supabase = requireSupabaseAdmin();
const router = Router();

const idSchema = z.string().uuid();
const nicheSchema = z.enum(DAILY_NICHES as [string, ...string[]]);
const tuningRunSchema = z.object({ niches: z.array(nicheSchema).min(1).max(DAILY_NICHES.length).optional() }).strict();

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

router.get('/insights/summary', asyncRoute(async (req, res) => {
  const days = Number(req.query.days ?? 28);
  if (!Number.isInteger(days) || days < 1 || days > 90) return sendError(res, 400, 'days must be an integer between 1 and 90');
  const organizationId = await ensureDefaultOrganization();
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const { data, error } = await supabase.from('post_insights')
    .select('publication_attempt_id, content_item_id, niche_id, platform, media_type, checkpoint, posted_at, posted_minute_ist, reach, views, likes, comments, shares, saves, interactions, content_items(sub_topic), publication_attempts(permalink)')
    .eq('organization_id', organizationId)
    .eq('status', 'collected')
    .in('checkpoint', ['24h', '72h'])
    .gte('posted_at', since)
    .limit(5000);
  if (error) return sendError(res, 500, 'Failed to load insights', error.message);

  // One row per publication: 24h, else 72h.
  const byPublication = new Map<string, any>();
  for (const row of data || []) {
    const existing = byPublication.get(row.publication_attempt_id);
    if (!existing || (existing.checkpoint !== '24h' && row.checkpoint === '24h')) byPublication.set(row.publication_attempt_id, row);
  }
  const rows = [...byPublication.values()].map((row) => ({ ...row, rate: engagementRate(row) }));

  const niches = DAILY_NICHES.map((niche) => {
    const nicheRows = rows.filter((row) => row.niche_id === niche);
    const rated = nicheRows.filter((row) => row.rate !== null);
    const hours = new Map<number, number[]>();
    for (const row of rated) {
      const hour = Math.floor(row.posted_minute_ist / 60);
      hours.set(hour, [...(hours.get(hour) || []), row.rate]);
    }
    return {
      nicheId: niche,
      posts: nicheRows.length,
      medianReach: median(nicheRows.map((row) => row.reach).filter((value): value is number => typeof value === 'number')),
      medianEngagementRate: median(rated.map((row) => row.rate)),
      byHourIst: [...hours].sort((a, b) => a[0] - b[0]).map(([hour, rates]) => ({ hour: minuteToSlot(hour * 60), posts: rates.length, medianEngagementRate: median(rates) })),
      topPosts: rated.sort((a, b) => b.rate - a.rate).slice(0, 5).map((row) => ({
        contentItemId: row.content_item_id,
        platform: row.platform,
        mediaType: row.media_type,
        topic: row.content_items?.sub_topic || null,
        postedAt: row.posted_at,
        reach: row.reach,
        engagementRate: row.rate,
        permalink: row.publication_attempts?.permalink || null,
      })),
    };
  });
  res.json({ ok: true, days, niches });
}));

router.get('/slot-recommendations', asyncRoute(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  if (!['pending', 'applied', 'dismissed', 'superseded'].includes(status)) return sendError(res, 400, 'Invalid status');
  const organizationId = await ensureDefaultOrganization();
  const { data, error } = await supabase.from('slot_recommendations')
    .select('*').eq('organization_id', organizationId).eq('status', status)
    .order('created_at', { ascending: false }).limit(50);
  if (error) return sendError(res, 500, 'Failed to load slot recommendations', error.message);
  res.json({ ok: true, recommendations: data || [] });
}));

router.post('/slot-recommendations/:id/:decision', asyncRoute(async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  const decision = req.params.decision;
  if (!id.success || !['apply', 'dismiss'].includes(decision)) return sendError(res, 400, 'Invalid recommendation request');
  const organizationId = await ensureDefaultOrganization();
  // Ownership check before the RPC, which acts on the id alone.
  const { data: owned } = await supabase.from('slot_recommendations').select('id').eq('id', id.data).eq('organization_id', organizationId).maybeSingle();
  if (!owned) return sendError(res, 404, 'Slot recommendation not found');
  const { data, error } = decision === 'apply'
    ? await supabase.rpc('apply_slot_recommendation', { p_id: id.data, p_decided_by: 'dashboard' })
    : await supabase.rpc('dismiss_slot_recommendation', { p_id: id.data, p_decided_by: 'dashboard' });
  if (error) return sendError(res, 409, `Could not ${decision} recommendation`, error.message);
  if (decision === 'apply' && !data?.applied) return sendError(res, 409, String(data?.reason || 'Recommendation was not applied'));
  res.json({ ok: true, result: data ?? null });
}));

router.post('/slot-tuning/run', asyncRoute(async (req, res) => {
  const parsed = tuningRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, 400, 'Invalid slot tuning request', parsed.error.flatten());
  const organizationId = await ensureDefaultOrganization();
  const job = await getQueue(QUEUE_NAMES.ANALYTICS).add('tune-slots', { ...parsed.data, organizationId }, { attempts: 1, removeOnComplete: 20, removeOnFail: 100 });
  res.status(202).json({ ok: true, jobId: job.id, message: 'Slot tuning queued' });
}));

export default router;
