import { Router } from 'express';
import { supabase } from '@viralforge/supabase';
import { asyncRoute, ensureDefaultOrganization, sendError, SUPPORTED_NICHES } from './_helpers';

const router = Router();

router.post('/dev/bootstrap', asyncRoute(async (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return sendError(res, 403, 'Development bootstrap is disabled in production');
  }

  const organizationId = await ensureDefaultOrganization();
  const profiles = SUPPORTED_NICHES.map((niche) => ({
    organization_id: organizationId,
    niche_id: niche.id,
    name: `${niche.name} Studio`,
    description: niche.description,
    target_audience: 'Hindi-speaking Indian viewers',
    content_pillars: niche.pillars,
    prompt_template: null,
    max_posts_per_day: 5,
    auto_publish_enabled: false,
    brand_colors: { primary: '#ff6b35', secondary: '#004e89', accent: '#f7f7ff' },
    brand_fonts: { title: 'Poppins', body: 'Inter' },
  }));

  const { error: profileError } = await supabase
    .from('niche_profiles')
    .upsert(profiles, { onConflict: 'organization_id,niche_id' });
  if (profileError) return sendError(res, 500, 'Failed to bootstrap niche profiles', profileError.message);

  const { data: existingContent } = await supabase
    .from('content_items')
    .select('id')
    .eq('organization_id', organizationId)
    .limit(1);

  let sampleCreated = false;
  if (!existingContent || existingContent.length === 0) {
    const { error: contentError } = await supabase.from('content_items').insert({
      organization_id: organizationId,
      niche_id: 'food',
      sub_topic: 'Quick ghar-ka-khana',
      data_input_payload: {
        dish: 'Aloo Paratha',
        region: 'Punjab',
        cookTime: 30,
        difficulty: 'easy',
        ingredients: ['Aata', 'Aloo', 'Masala'],
      },
      hook_variation_a: '5 minute mein crispy aloo paratha ka secret!',
      media_type: 'video_reel',
      status: 'draft',
      trigger_source: 'manual',
      trigger_metadata: { seeded: true },
      ai_disclosure_required: false,
      idempotency_key: `seed-food-${organizationId}`,
    });
    if (contentError) return sendError(res, 500, 'Failed to bootstrap sample content', contentError.message);
    sampleCreated = true;
  }

  res.json({ ok: true, organizationId, profilesCreated: profiles.length, sampleCreated });
}));

export default router;
