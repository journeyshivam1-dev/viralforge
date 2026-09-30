import { Router } from 'express';
import { z } from 'zod';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { DAILY_NICHES, istDate } from '@viralforge/domain';
import { getQueue, QUEUE_NAMES } from '../queues/connection';
import { asyncRoute, ensureDefaultOrganization, sendError } from './_helpers';

const supabase = requireSupabaseAdmin();
const router = Router();

const nicheSchema = z.enum(DAILY_NICHES as [string, ...string[]]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Invalid date');
const slotSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const mediaTypeSchema = z.enum(['video_reel', 'image_carousel', 'image_single']);

const runSchema = z.object({
  date: dateSchema.optional(),
  niches: z.array(nicheSchema).min(1).max(DAILY_NICHES.length).optional(),
}).strict();

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  posts_per_day: z.number().int().min(0).max(10).optional(),
  content_mix: z.object({
    video_reel: z.number().int().min(0).max(10),
    image_carousel: z.number().int().min(0).max(10),
    image_single: z.number().int().min(0).max(10),
  }).strict().optional(),
  slots_ist: z.array(slotSchema).min(1).max(10).optional(),
  jitter_minutes: z.number().int().min(0).max(30).optional(),
  publish_mode: z.enum(['manual_approval', 'scheduled']).optional(),
  auto_approve_at_slot: z.boolean().optional(),
  generation_lead_minutes: z.number().int().min(30).max(720).optional(),
  slot_tuning: z.enum(['off', 'suggest', 'auto']).optional(),
  exploration_minutes: z.number().int().min(0).max(90).optional(),
}).strict();

const topicSchema = z.object({
  niche_id: nicheSchema,
  title: z.string().trim().min(3).max(200),
  angle: z.string().trim().max(500).optional(),
  key_points: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  scheduled_for: dateSchema.optional(),
  media_type: mediaTypeSchema.optional(),
  priority: z.number().int().min(-10).max(10).default(0),
}).strict();

const topicsSchema = z.object({ topics: z.array(topicSchema).min(1).max(200) }).strict();

router.post('/planner/run', asyncRoute(async (req, res) => {
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, 400, 'Invalid planner request', parsed.error.flatten());
  const organizationId = await ensureDefaultOrganization();
  const job = await getQueue(QUEUE_NAMES.PLANNER).add('plan-day', { ...parsed.data, organizationId }, { attempts: 1, removeOnComplete: 50, removeOnFail: 100 });
  res.status(202).json({ ok: true, jobId: job.id, message: 'Planner run queued' });
}));

router.get('/planner/day', asyncRoute(async (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : istDate();
  if (!dateSchema.safeParse(date).success) return sendError(res, 400, 'Invalid date');
  const organizationId = await ensureDefaultOrganization();
  const [{ data: plans, error: planError }, { data: items, error: itemError }] = await Promise.all([
    supabase.from('daily_plans').select('*').eq('organization_id', organizationId).eq('plan_date', date),
    supabase.from('content_items')
      .select('id, niche_id, sub_topic, media_type, status, scheduled_at, publish_mode, approval_status, hook_variation_a, trigger_metadata, pipeline_runs(id, status, current_stage, waiting_reason, updated_at)')
      .eq('organization_id', organizationId).eq('plan_date', date)
      .order('scheduled_at', { ascending: true }),
  ]);
  if (planError || itemError) return sendError(res, 500, 'Failed to load day plan', planError?.message || itemError?.message);
  res.json({ ok: true, date, plans: plans || [], items: items || [] });
}));

router.get('/niche-settings', asyncRoute(async (_req, res) => {
  const organizationId = await ensureDefaultOrganization();
  await supabase.from('niche_schedule_settings').upsert(
    DAILY_NICHES.map((nicheId) => ({ organization_id: organizationId, niche_id: nicheId })),
    { onConflict: 'organization_id,niche_id', ignoreDuplicates: true },
  );
  const { data, error } = await supabase.from('niche_schedule_settings').select('*').eq('organization_id', organizationId).order('niche_id');
  if (error) return sendError(res, 500, 'Failed to load niche settings', error.message);
  res.json({ ok: true, settings: data || [] });
}));

router.put('/niche-settings/:niche', asyncRoute(async (req, res) => {
  const niche = nicheSchema.safeParse(req.params.niche);
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!niche.success || !parsed.success) return sendError(res, 400, 'Invalid niche settings', parsed.success ? 'Unknown niche' : parsed.error.flatten());
  const update = parsed.data;
  if (update.content_mix && update.posts_per_day !== undefined) {
    const total = Object.values(update.content_mix).reduce((sum, value) => sum + value, 0);
    if (total !== update.posts_per_day) return sendError(res, 400, `content_mix adds up to ${total} but posts_per_day is ${update.posts_per_day}`);
  }
  const organizationId = await ensureDefaultOrganization();
  const { data, error } = await supabase.from('niche_schedule_settings')
    .upsert({ organization_id: organizationId, niche_id: niche.data, ...update }, { onConflict: 'organization_id,niche_id' })
    .select('*').single();
  if (error) return sendError(res, 400, 'Failed to save niche settings', error.message);
  res.json({ ok: true, settings: data });
}));

router.get('/topics', asyncRoute(async (req, res) => {
  const organizationId = await ensureDefaultOrganization();
  let query = supabase.from('topic_backlog').select('*').eq('organization_id', organizationId)
    .order('scheduled_for', { ascending: true, nullsFirst: false }).order('priority', { ascending: false }).limit(500);
  if (typeof req.query.niche === 'string') {
    if (!nicheSchema.safeParse(req.query.niche).success) return sendError(res, 400, 'Invalid niche');
    query = query.eq('niche_id', req.query.niche);
  }
  if (typeof req.query.status === 'string') {
    if (!['pending', 'used', 'skipped'].includes(req.query.status)) return sendError(res, 400, 'Invalid status');
    query = query.eq('status', req.query.status);
  }
  const { data, error } = await query;
  if (error) return sendError(res, 500, 'Failed to load topics', error.message);
  res.json({ ok: true, topics: data || [] });
}));

router.post('/topics', asyncRoute(async (req, res) => {
  const parsed = topicsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, 400, 'Invalid topics', parsed.error.flatten());
  const organizationId = await ensureDefaultOrganization();
  const { data, error } = await supabase.from('topic_backlog')
    .insert(parsed.data.topics.map((topic) => ({ ...topic, organization_id: organizationId, created_by: 'dashboard' })))
    .select('id');
  if (error) return sendError(res, 400, 'Failed to save topics', error.message);
  res.status(201).json({ ok: true, created: data?.length || 0 });
}));

router.delete('/topics/:id', asyncRoute(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return sendError(res, 400, 'Invalid topic ID');
  const organizationId = await ensureDefaultOrganization();
  const { error } = await supabase.from('topic_backlog').delete()
    .eq('id', req.params.id).eq('organization_id', organizationId).eq('status', 'pending');
  if (error) return sendError(res, 500, 'Failed to delete topic', error.message);
  res.json({ ok: true });
}));

export default router;
