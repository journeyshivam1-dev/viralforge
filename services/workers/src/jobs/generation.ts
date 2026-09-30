/**
 * Generation Worker
 * Creates scripts, captions, hooks using Omniroute
 */

import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';

const supabase = requireSupabaseAdmin();
import { OmnirouteAdapter } from '@viralforge/domain';
import { createOmnirouteAdapter } from '@viralforge/domain';
import { NicheId } from '@viralforge/domain';

// Initialize Omniroute adapter
const omnirouteAdapter: OmnirouteAdapter = createOmnirouteAdapter(
  process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128',
  process.env.OMNIROUTE_API_KEY || '',
  process.env.OMNIROUTE_WEBHOOK_SECRET || '',
  parseInt(process.env.OMNIROUTE_TIMEOUT_MS || '300000')
);

export async function generationWorker(job: Job) {
  const triggerMetadata = job.data?.triggerMetadata || {};
  const contentItemId = job.data?.contentItemId || triggerMetadata.contentItemId;
  const nicheId = job.data?.nicheId || triggerMetadata.nicheId;
  const dataInputPayload = job.data?.dataInputPayload || triggerMetadata.dataInputPayload;
  const triggerSource = job.data?.triggerSource || 'manual';

  if (!contentItemId) {
    throw new Error('contentItemId is required in job.data or job.data.triggerMetadata');
  }
  if (!nicheId) {
    throw new Error(`nicheId is required for content ${contentItemId}`);
  }

  console.log(`[Generation] Starting generation for content ${contentItemId}`);

  try {
    await job.updateProgress(10);

    // Get content item with researched data
    const { data: contentItem, error: fetchError } = await supabase
      .from('content_items')
      .select('*')
      .eq('id', contentItemId)
      .single();

    if (fetchError || !contentItem) {
      throw new Error(`Content item not found: ${contentItemId}`);
    }

    await job.updateProgress(20);

    // Get niche prompt template
    const { data: promptTemplate } = await supabase
      .from('niche_prompt_templates')
      .select('prompt_text')
      .eq('niche_id', nicheId)
      .eq('is_active', true)
      .single();

    await job.updateProgress(30);

    const inputPayload = dataInputPayload || contentItem.data_input_payload || {};
    const prompt = buildPrompt(nicheId as NicheId, inputPayload, promptTemplate?.prompt_text);

    const generation = await omnirouteAdapter.generateText({
      model: process.env.OMNIROUTE_TEXT_MODEL || 'auto/best-chat',
      responseFormat: 'json_object',
      temperature: 0.7,
      maxTokens: 4000,
      messages: [
        {
          role: 'system',
          content: `You are ViralForge's editorial generator for Hindi/Hinglish ${nicheId} social content. Return JSON only. Do not make unverified claims.`,
        },
        {
          role: 'user',
          content: `${prompt}\n\nReturn exactly this JSON object shape:\n{\n  "primaryHook": "string",\n  "alternateHooks": ["string", "string"],\n  "script": "string",\n  "caption": "string",\n  "hashtags": ["string"],\n  "cta": "string",\n  "scenes": [{"index": 1, "durationSeconds": 4, "voiceover": "string", "onScreenText": "string", "visualPrompt": "string"}],\n  "disclosures": ["string"]\n}\nUse Devanagari Hindi or natural Hinglish as appropriate. The script must be at least 80 characters and scenes must be a non-empty array.`,
        },
      ],
    });

    console.log(`[Generation] Raw Omniroute response for ${contentItemId}:`, generation.content.substring(0, 500));
    await job.updateProgress(60);

    const generatedContent = parseStructuredContent(generation.content, contentItemId);

    await job.updateProgress(80);

    // Update content item only after the real Omniroute response passes validation.
    const { error: updateError } = await supabase
      .from('content_items')
      .update({
        status: 'generated',
        hook_variation_a: generatedContent.primaryHook,
        script_body: generatedContent.script,
        cta_destination: generatedContent.cta,
        ai_generation_metadata: {
          provider: 'omniroute',
          omnirouteJobId: generation.id,
          generatedAt: new Date().toISOString(),
          model: generation.model,
          usage: generation.usage,
          generatedContent: {
            schemaVersion: 1,
            ...generatedContent,
          },
          alternateHooks: generatedContent.alternateHooks,
          caption: generatedContent.caption,
          hashtags: generatedContent.hashtags,
          scenes: generatedContent.scenes,
          disclosures: generatedContent.disclosures,
        },
        validation_errors: [],
        validation_warnings: [],
      })
      .eq('id', contentItemId);

    if (updateError) {
      throw new Error(`Failed to update content item: ${updateError.message}`);
    }

    await job.updateProgress(100);

    await logAuditEvent(contentItemId, 'generation.completed', {
      nicheId,
      triggerSource,
      hookVariation: generatedContent.primaryHook.substring(0, 50),
      scriptLength: generatedContent.script.length,
      sceneCount: generatedContent.scenes.length,
      model: generation.model,
    });

    console.log(`[Generation] Generation completed for content ${contentItemId}`);

    return {
      success: true,
      contentItemId,
      hook: generatedContent.primaryHook,
      script: generatedContent.script,
      alternativeHooks: generatedContent.alternateHooks,
      scenes: generatedContent.scenes.length,
    };
  } catch (error) {
    console.error(`[Generation] Error for content ${contentItemId}:`, error);

    await supabase
      .from('content_items')
      .update({
        status: 'failed',
        validation_errors: [error instanceof Error ? error.message : String(error)],
      })
      .eq('id', contentItemId);

    throw error;
  }
}

/**
 * Build the generation prompt for Omniroute
 */
function buildPrompt(
  nicheId: NicheId,
  dataInput: Record<string, any>,
  template?: string
): string {
  // If we have a custom template, use it
  if (template) {
    return interpolateTemplate(template, dataInput);
  }

  // Default prompts per niche
  const prompts: Record<NicheId, string> = {
    food: `Write a 45-second Instagram Reel script for "${dataInput.dish}" (${dataInput.region} cuisine).
Cooking time: ${dataInput.cookTime || 30} minutes.
Difficulty: ${dataInput.difficulty || 'medium'}.
Language: Hindi/Hinglish.

Requirements:
- Start with a relatable hook (something about the dish that makes people want to cook it)
- Show the dish in the first 2 seconds
- Break into 3-5 visible steps
- End with "Save this recipe!" CTA
- Use simple Hindi words mixed with English
- Total duration: 45 seconds`,

    health: `Write a 50-second video script transforming "${dataInput.originalDish}" into "${dataInput.transformedDish}".
Calorie difference: ${dataInput.calorieDelta || 100} calories saved.
Protein target: ${dataInput.proteinTarget || 20}g.
Health goal: ${dataInput.healthGoal || 'weight loss'}.
Language: Hindi/Hinglish.

Requirements:
- Start by calling out a common unhealthy habit
- Give exact calorie numbers (no vague terms)
- Maintain encouraging, supportive tone
- End with a simple swap anyone can make
- No medical claims or promises`,

    tech: `Write a 45-second Reel script about ${dataInput.toolName}.
Feature: ${dataInput.feature || 'productivity'}.
Pain point solved: ${dataInput.painPoint || 'time management'}.
Time saved: ${dataInput.timeSaved || 2} hours.
Language: Hindi/Hinglish with words like "Boss", "Jugaad".

Requirements:
- Lead with a hard-hitting hook
- Keep sentences short for TTS
- End with CTA to bio link
- Energetic, growth-focused tone`,

    edtech: `Write a 45-second educational short about ${dataInput.exam} ${dataInput.subject}.
Topic: ${dataInput.topic}.
Cheat code: ${dataInput.cheatCode}.
Language: Hindi/Hinglish.

Requirements:
- Start with urgency ("यह trick जानने से पहले..." or similar)
- Deliver the formula/shortcut with clean visual steps
- End with CTA to download cheat sheet
- High energy, results-driven tone`,

    travel: `Write a 50-second travel script for "${dataInput.location}" near ${dataInput.baseCity}.
Duration: ${dataInput.travelDuration || 2} hours from city.
Budget: ₹${dataInput.budgetPerHead || 500} per head.
Language: Hindi/Hinglish.

Requirements:
- Heavy curiosity hook ("नहीं जाना तो क्या करेंगे...")
- Give exact path and best time to visit
- Realistic expense breakdown
- Drive saves and shares
- Adventure/exploration tone`,

    cartoon: `Write a 45-second animated script in ${dataInput.dialect || 'Mumbai Bambaiya'} Hindi.
Theme: ${dataInput.theme}.
Characters: ${dataInput.characters?.join(', ') || 'typical Indian family'}.
Twist: ${dataInput.comedicTwist || 'relatable everyday situation'}.
Style: ${dataInput.animationStyle || '2D family comedy'}.

Requirements:
- Clean, family-friendly humor
- Local dialect phrasing
- Include visual descriptions in brackets
- Relatable Indian family situations`,
  };

  return prompts[nicheId] || prompts.food;
}

/**
 * Interpolate template variables with data
 */
function interpolateTemplate(template: string, data: Record<string, any>): string {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\[${key.toUpperCase()}\\]`, 'g'), String(value));
  }
  return result;
}

interface GeneratedScene {
  index: number;
  durationSeconds: number;
  voiceover: string;
  onScreenText: string;
  visualPrompt: string;
}

interface StructuredGeneratedContent {
  primaryHook: string;
  alternateHooks: string[];
  script: string;
  caption: string;
  hashtags: string[];
  cta: string;
  scenes: GeneratedScene[];
  disclosures: string[];
}

function parseStructuredContent(text: string, contentItemId?: string): StructuredGeneratedContent {
  let parseableText = text.trim();

  // Pass 1: strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = parseableText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    parseableText = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(parseableText);
  } catch {
    // Pass 2: tolerate gateways that wrap JSON in markdown or prose.
    const jsonObject = extractJsonObject(parseableText);
    if (jsonObject) {
      try {
        parsed = JSON.parse(jsonObject);
      } catch {
        // Fall through to the descriptive error below.
      }
    }

    if (parsed === undefined) {
      console.error(`[Generation] Failed to parse JSON for content ${contentItemId}. Raw response (first 1000 chars):`, text.substring(0, 1000));
      throw new Error(`Omniroute returned invalid JSON instead of the requested structured content package. Raw response preview: ${text.substring(0, 200)}`);
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Omniroute returned an invalid content package');
  }

  const value = parsed as Record<string, unknown>;
  const primaryHook = typeof value.primaryHook === 'string' ? value.primaryHook.trim() : '';
  const script = typeof value.script === 'string' ? value.script.trim() : '';
  const caption = typeof value.caption === 'string' ? value.caption.trim() : '';
  const cta = typeof value.cta === 'string' ? value.cta.trim() : '';
  const alternateHooks = Array.isArray(value.alternateHooks)
    ? value.alternateHooks.filter((hook): hook is string => typeof hook === 'string' && hook.trim().length > 0)
    : [];
  const hashtags = Array.isArray(value.hashtags)
    ? value.hashtags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  const disclosures = Array.isArray(value.disclosures)
    ? value.disclosures.filter((disclosure): disclosure is string => typeof disclosure === 'string')
    : [];
  const scenes = Array.isArray(value.scenes)
    ? value.scenes.map((scene, index): GeneratedScene => {
        const entry = scene as Record<string, unknown>;
        return {
          index: typeof entry.index === 'number' ? entry.index : index + 1,
          durationSeconds: typeof entry.durationSeconds === 'number' ? entry.durationSeconds : 0,
          voiceover: typeof entry.voiceover === 'string' ? entry.voiceover.trim() : '',
          onScreenText: typeof entry.onScreenText === 'string' ? entry.onScreenText.trim() : '',
          visualPrompt: typeof entry.visualPrompt === 'string' ? entry.visualPrompt.trim() : '',
        };
      })
    : [];

  if (!primaryHook || !caption || script.length < 80 || !cta || scenes.length === 0) {
    throw new Error('Omniroute content package is incomplete: hook, script, caption, CTA, and at least one scene are required');
  }

  if (scenes.some((scene) => !scene.voiceover || !scene.visualPrompt || scene.durationSeconds <= 0)) {
    throw new Error('Omniroute content package contains an invalid scene');
  }

  return { primaryHook, alternateHooks, script, caption, hashtags, cta, scenes, disclosures };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1).trim();
    }
  }

  return null;
}

async function logAuditEvent(
  contentItemId: string,
  action: string,
  metadata: Record<string, any>
) {
  await supabase.from('audit_logs').insert({
    content_item_id: contentItemId,
    action,
    actor: 'system',
    actor_type: 'system',
    metadata,
  });
}
