import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '@viralforge/supabase';
import { validatePayload } from '@viralforge/domain';
import {
  queueContentGeneration,
  queueMediaGeneration,
  queuePublishing,
  queueRendering,
  queueTextGeneration,
  queueValidation,
} from '../queues/content-queue';
import { asyncRoute, ensureDefaultOrganization, parseLimit, sendError } from './_helpers';

const router = Router();

const contentSchema = z.object({
  niche_id: z.enum(['food', 'health', 'tech', 'edtech', 'travel', 'cartoon']),
  niche_account_id: z.string().uuid().optional().nullable(),
  sub_topic: z.string().min(1),
  data_input_payload: z.record(z.any()).default({}),
  hook_variation_a: z.string().optional().nullable(),
  script_body: z.string().optional().nullable(),
  visual_reference: z.string().optional().nullable(),
  background_music: z.string().optional().nullable(),
  cta_destination: z.string().optional().nullable(),
  media_type: z.enum(['video_reel', 'image_carousel', 'image_single']).default('video_reel'),
  ai_disclosure_required: z.boolean().default(false),
  status: z.enum(['draft', 'queued', 'researched', 'generated', 'rendering', 'validated', 'scheduled', 'publishing', 'published', 'blocked', 'failed', 'cancelled']).default('draft'),
  scheduled_at: z.string().datetime().optional().nullable(),
});

router.get('/content', asyncRoute(async (req, res) => {
  const orgId = await ensureDefaultOrganization();
  let query = supabase
    .from('content_items')
    .select('*')
    .eq('organization_id', orgId)
    .order('scheduled_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(parseLimit(req.query.limit, 100));

  if (req.query.status) query = query.eq('status', String(req.query.status));
  if (req.query.niche) query = query.eq('niche_id', String(req.query.niche));
  if (req.query.from) query = query.gte('scheduled_at', String(req.query.from));
  if (req.query.to) query = query.lte('scheduled_at', String(req.query.to));

  const { data, error } = await query;
  if (error) return sendError(res, 500, 'Failed to list content items', error.message);
  res.json({ ok: true, content: data || [] });
}));

router.get('/content/:id', asyncRoute(async (req, res) => {
  const { data, error } = await supabase
    .from('content_items')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return sendError(res, 404, 'Content item not found', error?.message);
  res.json({ ok: true, content: data });
}));

router.post('/content', asyncRoute(async (req, res) => {
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'Invalid content payload', parsed.error.flatten());

  const payloadErrors = validatePayload(parsed.data.niche_id, parsed.data.data_input_payload);
  if (payloadErrors.length > 0) return sendError(res, 400, 'Invalid niche payload', payloadErrors);

  const orgId = await ensureDefaultOrganization();
  const { data, error } = await supabase
    .from('content_items')
    .insert({
      organization_id: orgId,
      trigger_source: 'manual',
      trigger_metadata: { createdFrom: 'dashboard' },
      ...parsed.data,
      idempotency_key: `dashboard-${parsed.data.niche_id}-${Date.now()}`,
    })
    .select('*')
    .single();

  if (error || !data) return sendError(res, 500, 'Failed to create content item', error?.message);

  await supabase.from('audit_logs').insert({
    organization_id: orgId,
    niche_id: data.niche_id,
    content_item_id: data.id,
    action: 'content.created',
    actor: 'dashboard',
    actor_type: 'user',
    metadata: { status: data.status, subTopic: data.sub_topic },
  });

  res.status(201).json({ ok: true, content: data });
}));

router.patch('/content/:id', asyncRoute(async (req, res) => {
  const patch = contentSchema.partial().safeParse(req.body);
  if (!patch.success) return sendError(res, 400, 'Invalid content update', patch.error.flatten());

  const { data, error } = await supabase
    .from('content_items')
    .update({ ...patch.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error || !data) return sendError(res, 500, 'Failed to update content item', error?.message);

  await supabase.from('audit_logs').insert({
    organization_id: data.organization_id,
    niche_id: data.niche_id,
    content_item_id: data.id,
    action: 'content.updated',
    actor: 'dashboard',
    actor_type: 'user',
    metadata: { fields: Object.keys(patch.data) },
  });

  res.json({ ok: true, content: data });
}));

router.post('/content/:id/queue', asyncRoute(async (req, res) => {
  const { data: content, error } = await supabase
    .from('content_items')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !content) return sendError(res, 404, 'Content item not found', error?.message);

  const queued = await queueContentGeneration({
    contentItemId: content.id,
    nicheId: content.niche_id,
    subTopic: content.sub_topic,
    dataInputPayload: content.data_input_payload,
    triggerSource: 'manual',
    triggerMetadata: { contentItemId: content.id, source: 'dashboard' },
    idempotencyKey: content.idempotency_key || `dashboard-queue-${content.id}`,
  });

  await supabase
    .from('content_items')
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('id', content.id);

  await supabase.from('audit_logs').insert({
    organization_id: content.organization_id,
    niche_id: content.niche_id,
    content_item_id: content.id,
    action: 'content.queued',
    actor: 'dashboard',
    actor_type: 'user',
    metadata: queued,
  });

  res.json({ ok: true, job: queued });
}));

router.post('/content/:id/generate', asyncRoute(async (req, res) => {
  const { data: content, error } = await supabase.from('content_items').select('*').eq('id', req.params.id).single();
  if (error || !content) return sendError(res, 404, 'Content item not found', error?.message);
  if (!['researched', 'failed', 'blocked'].includes(content.status)) {
    return sendError(res, 409, `Generation requires researched content; current status is ${content.status}`);
  }

  const job = await queueTextGeneration(content.id, content.niche_id, content.data_input_payload, 'manual');
  await supabase.from('content_items').update({ status: 'queued', validation_errors: [], updated_at: new Date().toISOString() }).eq('id', content.id);
  res.json({ ok: true, job, message: 'Omniroute text generation queued' });
}));

router.post('/content/:id/media', asyncRoute(async (req, res) => {
  const { data: content, error } = await supabase.from('content_items').select('*').eq('id', req.params.id).single();
  if (error || !content) return sendError(res, 404, 'Content item not found', error?.message);
  if (content.status !== 'generated') return sendError(res, 409, `Media generation requires generated content; current status is ${content.status}`);
  const job = await queueMediaGeneration(content.id, content.niche_id);
  res.json({ ok: true, job, message: 'Media generation queued' });
}));

router.post('/content/:id/upload-media', asyncRoute(async (req, res) => {
  const { data: content, error } = await supabase.from('content_items').select('*').eq('id', req.params.id).single();
  if (error || !content) return sendError(res, 404, 'Content item not found', error?.message);
  if (content.status !== 'generated') return sendError(res, 409, `Media upload requires generated content; current status is ${content.status}`);
  if (content.ai_generation_metadata?.mediaUrl) return sendError(res, 409, 'Media has already been uploaded');

  // Parse multipart form data
  const formData = req.body as any;
  if (!formData || !formData.file) {
    return sendError(res, 400, 'No file provided in request body');
  }

  // Extract file from formData (this might need adjustment based on actual implementation)
  const fileBuffer = formData.file instanceof Buffer ? formData.file : Buffer.from(formData.file);
  const mimeType = formData.mimeType || 'application/octet-stream';
  const fileName = `media-${Date.now()}.${mimeType.split('/')[1]}`;

  // Upload to Supabase storage
  const { data: uploadData, error: uploadError } = await supabase
    .from('viralforge-content')
    .upload(fileName, fileBuffer, {
      contentType: mimeType,
      cacheControl: '31536000',
    });

  if (uploadError) {
    return sendError(res, 500, 'Failed to upload media', uploadError.message);
  }

  // Update content item with media URL
  const { error: updateError } = await supabase
    .from('content_items')
    .update({
      status: 'validated',
      ai_generation_metadata: {
        ...content.ai_generation_metadata,
        mediaUrl: uploadData.path,
        mediaType: mimeType,
      },
    })
    .eq('id', content.id);

  if (updateError) {
    return sendError(res, 500, 'Failed to update content item with media URL', updateError.message);
  }

  // Log audit event
  await supabase.from('audit_logs').insert({
    organization_id: content.organization_id,
    niche_id: content.niche_id,
    content_item_id: content.id,
    action: 'content.media.uploaded',
    actor: 'dashboard',
    actor_type: 'user',
    metadata: { fileName, mimeType },
  });

  res.json({ ok: true, message: 'Media uploaded successfully', fileName });
}));

router.post('/content/:id/render', asyncRoute(async (req, res) => {
  const { data: content, error } = await supabase.from('content_items').select('*').eq('id', req.params.id).single();
  if (error || !content) return sendError(res, 404, 'Content item not found', error?.message);
  if (content.status !== 'rendering') return sendError(res, 409, `Rendering requires generated media; current status is ${content.status}`);
  const job = await queueRendering(content.id);
  res.json({ ok: true, job, message: 'Rendering queued' });
}));

router.post('/content/:id/validate', asyncRoute(async (req, res) => {
  const { data: content, error } = await supabase.from('content_items').select('*').eq('id', req.params.id).single();
  if (error || !content) return sendError(res, 404, 'Content item not found', error?.message);
  if (!['validated', 'rendering'].includes(content.status)) return sendError(res, 409, `Validation requires rendered content; current status is ${content.status}`);
  const job = await queueValidation(content.id);
  res.json({ ok: true, job, message: 'Validation queued' });
}));

router.post('/content/:id/publish', asyncRoute(async (req, res) => {
  if (process.env.PUBLISHING_DISABLED !== 'false') {
    return sendError(res, 409, 'Publishing is disabled by PUBLISHING_DISABLED=true');
  }

  const { data: content, error } = await supabase
    .from('content_items')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !content) return sendError(res, 404, 'Content item not found', error?.message);
  if (!['validated', 'scheduled'].includes(content.status)) {
    return sendError(res, 409, `Cannot publish content in status ${content.status}`);
  }

  const job = await queuePublishing(content.id, content.scheduled_at ? new Date(content.scheduled_at) : undefined);
  res.json({ ok: true, job });
}));

export default router;
