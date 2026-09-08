import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '@viralforge/supabase';
import { asyncRoute, ensureDefaultOrganization, sendError, SUPPORTED_NICHES } from './_helpers';

const router = Router();

const profileSchema = z.object({
  niche_id: z.enum(['food', 'health', 'tech', 'edtech', 'travel', 'cartoon']),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  target_audience: z.string().optional().nullable(),
  content_pillars: z.array(z.string()).optional(),
  max_posts_per_day: z.number().int().min(1).max(20).optional(),
  auto_publish_enabled: z.boolean().optional(),
});

router.get('/niches', asyncRoute(async (_req, res) => {
  res.json({ ok: true, niches: SUPPORTED_NICHES });
}));

router.get('/niche-profiles', asyncRoute(async (_req, res) => {
  const orgId = await ensureDefaultOrganization();
  const { data, error } = await supabase
    .from('niche_profiles')
    .select('*')
    .eq('organization_id', orgId)
    .order('niche_id');

  if (error) return sendError(res, 500, 'Failed to list niche profiles', error.message);
  res.json({ ok: true, profiles: data || [] });
}));

router.post('/niche-profiles', asyncRoute(async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'Invalid profile payload', parsed.error.flatten());

  const orgId = await ensureDefaultOrganization();
  const { data, error } = await supabase
    .from('niche_profiles')
    .upsert({
      organization_id: orgId,
      ...parsed.data,
      brand_colors: { primary: '#ff6b35', secondary: '#004e89', accent: '#f7f7ff' },
      brand_fonts: { title: 'Poppins', body: 'Inter' },
    }, { onConflict: 'organization_id,niche_id' })
    .select('*')
    .single();

  if (error) return sendError(res, 500, 'Failed to save niche profile', error.message);
  res.status(201).json({ ok: true, profile: data });
}));

router.patch('/niche-profiles/:id', asyncRoute(async (req, res) => {
  const patch = profileSchema.partial().safeParse(req.body);
  if (!patch.success) return sendError(res, 400, 'Invalid profile update', patch.error.flatten());

  const { data, error } = await supabase
    .from('niche_profiles')
    .update(patch.data)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error) return sendError(res, 500, 'Failed to update niche profile', error.message);
  res.json({ ok: true, profile: data });
}));

export default router;
