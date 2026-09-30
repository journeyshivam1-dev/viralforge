/**
 * Generation Worker
 * Writes the full post package (hooks, script, caption, hashtags, CTA, scenes)
 * via the AI provider chain (Omniroute, then Gemini). The package shape depends
 * on media_type: reel scenes with voiceover, carousel slides, or a single image.
 * A valid package already on the row is reused, so retries never regenerate it.
 */

import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  ResearchNotesSchema,
  UNTRUSTED_DATA_RULE,
  asDataBlock,
  createAiProviderChainFromEnv,
  getNichePlaybook,
  parseJsonObject,
  readBrief,
  sanitizePromptList,
  sanitizePromptText,
  GeneratedContentPackageSchema,
  normalizeGeneratedPackage,
  validatePackageForMediaType,
  type MediaType,
} from '@viralforge/domain';

const supabase = requireSupabaseAdmin();
const aiChain = createAiProviderChainFromEnv();

const SHAPES: Record<MediaType, { scenes: string; rules: string }> = {
  video_reel: {
    scenes: '5-8 scenes, 3-6 seconds each, total 20-40 seconds',
    rules: 'Every scene needs voiceover (spoken Hinglish, Hindi words in Devanagari, English words in Latin script, 8-20 words, natural for TTS) and onScreenText (max 7 words). The first scene is the hook.',
  },
  image_carousel: {
    scenes: '5-7 slides; durationSeconds is always 5',
    rules: 'Slide 1 is a bold hook headline. Each slide has onScreenText (headline, max 8 words) and bodyText (1-2 short lines, max 160 characters). Last slide is the CTA. voiceover is an empty string.',
  },
  image_single: {
    scenes: 'exactly 1 scene; durationSeconds is 5',
    rules: 'onScreenText is a punchy headline (max 8 words); bodyText is one supporting line (max 120 characters). voiceover is an empty string.',
  },
};

export async function generationWorker(job: Job) {
  const contentItemId = job.data?.contentItemId || job.data?.triggerMetadata?.contentItemId;
  if (!contentItemId) throw new Error('contentItemId is required in job.data');

  const { data: item, error } = await supabase
    .from('content_items')
    .select('*')
    .eq('id', contentItemId)
    .single();
  if (error || !item) throw Object.assign(new Error(`Content item not found: ${contentItemId}`), { code: 'NOT_FOUND' });

  const mediaType = (item.media_type || 'video_reel') as MediaType;
  const existing = GeneratedContentPackageSchema.safeParse(item.ai_generation_metadata?.generatedContent);
  if (existing.success && validatePackageForMediaType(existing.data, mediaType).length === 0) {
    return { success: true, contentItemId, reused: true, scenes: existing.data.scenes.length };
  }

  await job.updateProgress(15);
  const playbook = getNichePlaybook(item.niche_id);
  const payload = (item.data_input_payload || {}) as Record<string, any>;
  const brief = readBrief(payload);
  const research = ResearchNotesSchema.safeParse(payload.research);
  const { data: template } = await supabase
    .from('niche_prompt_templates')
    .select('prompt_text')
    .eq('niche_id', item.niche_id)
    .eq('is_active', true)
    .maybeSingle();

  const shape = SHAPES[mediaType];
  const topicBlock = [
    `Topic: ${sanitizePromptText(brief?.title || item.sub_topic, 200)}`,
    brief ? `Angle: ${sanitizePromptText(brief.angle, 500)}` : `Operator input: ${sanitizePromptText(JSON.stringify(legacyFields(payload)), 1500)}`,
    brief?.keyPoints.length ? `Key points: ${sanitizePromptList(brief.keyPoints).join('; ')}` : '',
    brief?.trendContext ? `Trend context: ${sanitizePromptText(brief.trendContext, 800)}` : '',
  ].filter(Boolean).join('\n');
  const researchBlock = research.success
    ? [
        `Summary: ${sanitizePromptText(research.data.summary, 1200)}`,
        `Facts: ${sanitizePromptList(research.data.facts, 12, 300).join(' | ')}`,
        `Pain points: ${sanitizePromptList(research.data.audiencePainPoints).join(' | ')}`,
        `Hook ideas: ${sanitizePromptList(research.data.hookIdeas).join(' | ')}`,
        `Do not claim: ${sanitizePromptList(research.data.cautions).join(' | ') || '-'}`,
      ].join('\n')
    : 'No research notes available; stay general and avoid specific numbers.';

  const result = await aiChain.generateText({
    json: true,
    temperature: 0.8,
    maxTokens: 4000,
    system: [
      `You are the lead writer for "${playbook?.displayName || item.niche_id}", a Hindi/Hinglish Instagram and Facebook channel.`,
      `Persona: ${playbook?.persona || 'Helpful creator'}. Tone: ${playbook?.tone || 'Friendly Hinglish'}.`,
      `Audience: ${playbook?.audience || 'Hindi-speaking Indian viewers'}.`,
      `Safety rules: ${(playbook?.safetyRules || []).join('; ') || 'No unverified claims'}.`,
      'Use only facts from the research notes. Return JSON only.',
      UNTRUSTED_DATA_RULE,
      template?.prompt_text ? `House style notes: ${sanitizePromptText(template.prompt_text, 1500)}` : '',
    ].filter(Boolean).join('\n'),
    user: [
      asDataBlock('topic', topicBlock),
      asDataBlock('research', researchBlock),
      '',
      `Format: ${mediaType} (${shape.scenes}). ${shape.rules}`,
      `visualStyle: one sentence of art direction; base it on: ${playbook?.visualStyle || 'clean, bright, realistic'}.`,
      'visualPrompt per scene: detailed English image prompt describing subject, composition and lighting. Never ask for text, letters or logos in the image.',
      'caption: 2-4 short Hinglish lines (hook, value, CTA) with 1-3 emojis; no hashtags inside the caption.',
      `hashtags: 12-20 lowercase tags starting with #, mix broad, niche and topic tags; include some of: ${(playbook?.hashtagSeeds || []).join(' ')}.`,
      'alternateHooks: 2 alternative opening lines. cta: one line (save / share / follow).',
      '',
      'Return exactly this JSON shape:',
      '{"primaryHook":"string","alternateHooks":["string"],"script":"string","caption":"string","hashtags":["#tag"],"cta":"string","visualStyle":"string","scenes":[{"index":1,"durationSeconds":4,"voiceover":"string","onScreenText":"string","bodyText":"string","visualPrompt":"string"}],"disclosures":["string"]}',
    ].join('\n'),
  });

  await job.updateProgress(60);
  let generated;
  try {
    generated = normalizeGeneratedPackage(parseJsonObject(result.text), mediaType);
  } catch (parseError) {
    // Malformed model output is transient: the next attempt re-asks the model.
    throw Object.assign(new Error(`Generated package is invalid: ${(parseError as Error).message.slice(0, 300)}`), { code: 'INVALID_MODEL_OUTPUT' });
  }
  const problems = validatePackageForMediaType(generated, mediaType);
  if (problems.length > 0) {
    throw Object.assign(new Error(`Generated package is invalid: ${problems.join('; ')}`), { code: 'INVALID_MODEL_OUTPUT' });
  }

  const aiDisclosure = Boolean(playbook?.aiDisclosureRequired || item.ai_disclosure_required);
  const { error: updateError } = await supabase
    .from('content_items')
    .update({
      status: 'generated',
      hook_variation_a: generated.primaryHook,
      script_body: generated.script,
      cta_destination: generated.cta,
      ai_disclosure_required: aiDisclosure,
      ai_generation_metadata: {
        ...(item.ai_generation_metadata || {}),
        provider: result.provider,
        model: result.model,
        generatedAt: new Date().toISOString(),
        usage: [...(item.ai_generation_metadata?.usage || []), { stage: 'generation', provider: result.provider, model: result.model, ...result.usage }],
        fallbackAttempts: result.fallbackAttempts,
        generatedContent: generated,
        // Flattened copies kept for existing dashboard views.
        alternateHooks: generated.alternateHooks,
        caption: generated.caption,
        hashtags: generated.hashtags,
        scenes: generated.scenes,
        disclosures: generated.disclosures,
      },
      validation_errors: [],
      validation_warnings: [],
    })
    .eq('id', contentItemId);
  if (updateError) throw new Error(`Failed to save generated package: ${updateError.message}`);

  await supabase.from('audit_logs').insert({
    organization_id: item.organization_id,
    content_item_id: contentItemId,
    niche_id: item.niche_id,
    action: 'generation.completed',
    actor: 'system',
    actor_type: 'system',
    metadata: { provider: result.provider, model: result.model, mediaType, sceneCount: generated.scenes.length },
  });

  await job.updateProgress(100);
  return { success: true, contentItemId, provider: result.provider, mediaType, scenes: generated.scenes.length };
}

function legacyFields(payload: Record<string, any>): Record<string, any> {
  const { research: _research, brief: _brief, ...rest } = payload;
  return rest;
}
