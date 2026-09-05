/**
 * Generation Worker
 * Creates scripts, captions, hooks using Omniroute
 */

import { Job } from 'bullmq';
import { supabase } from '@viralforge/supabase';
import { OmnirouteAdapter } from '@viralforge/domain';
import { createOmnirouteAdapter } from '@viralforge/domain';
import { NicheId } from '@viralforge/domain';

// Initialize Omniroute adapter
const omnirouteAdapter: OmnirouteAdapter = createOmnirouteAdapter(
  process.env.OMNIROUTE_BASE_URL || 'http://localhost:3001',
  process.env.OMNIROUTE_API_KEY || '',
  process.env.OMNIROUTE_WEBHOOK_SECRET || '',
  parseInt(process.env.OMNIROUTE_TIMEOUT_MS || '300000')
);

export async function generationWorker(job: Job) {
  const { contentItemId, nicheId, dataInputPayload, triggerSource } = job.data;

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

    // Build the generation prompt
    const prompt = buildPrompt(nicheId as NicheId, dataInputPayload || contentItem.data_input_payload, promptTemplate?.prompt_text);

    // Call Omniroute for text generation
    const omnirouteResponse = await omnirouteAdapter.generateContent({
      type: 'text',
      prompt,
      niche: nicheId as NicheId,
      callbackUrl: process.env.API_URL ? `${process.env.API_URL}/webhooks/omniroute` : undefined,
    });

    await job.updateProgress(60);

    // Parse generated content
    const generatedContent = parseGeneratedContent(omnirouteResponse.result?.text || '', nicheId as NicheId);

    // Generate hooks (multiple variations for A/B testing)
    const hooks = await generateHooks(nicheId as NicheId, dataInputPayload, promptTemplate?.prompt_text);

    await job.updateProgress(80);

    // Update content item with generated content
    const { error: updateError } = await supabase
      .from('content_items')
      .update({
        status: 'generated',
        hook_variation_a: hooks.primary,
        script_body: generatedContent.script,
        ai_generation_metadata: {
          omnirouteJobId: omnirouteResponse.id,
          generatedAt: new Date().toISOString(),
          model: 'omniroute',
        },
        validation_warnings: generatedContent.warnings,
      })
      .eq('id', contentItemId);

    if (updateError) {
      throw new Error(`Failed to update content item: ${updateError.message}`);
    }

    await job.updateProgress(100);

    // Log audit event
    await logAuditEvent(contentItemId, 'generation.completed', {
      nicheId,
      triggerSource,
      hookVariation: hooks.primary.substring(0, 50),
      scriptLength: generatedContent.script.length,
    });

    console.log(`[Generation] Generation completed for content ${contentItemId}`);

    return {
      success: true,
      contentItemId,
      hook: hooks.primary,
      script: generatedContent.script,
      alternativeHooks: hooks.alternatives,
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

/**
 * Parse generated content based on niche
 */
function parseGeneratedContent(
  text: string,
  nicheId: NicheId
): { script: string; warnings: string[] } {
  const warnings: string[] = [];

  // Basic parsing - in production, use structured JSON output
  if (!text || text.length < 50) {
    warnings.push('Generated script is very short');
  }

  return {
    script: text,
    warnings,
  };
}

/**
 * Generate multiple hook variations for A/B testing
 */
async function generateHooks(
  nicheId: NicheId,
  dataInput: Record<string, any>,
  template?: string
): Promise<{ primary: string; alternatives: string[] }> {
  const hooks: Record<NicheId, { primary: string; alternatives: string[] }> = {
    food: {
      primary: `Kya aapko ${dataInput.dish || 'ye dish'} banana aata hai? 🤔`,
      alternatives: [
        `Is tarike se ${dataInput.dish || 'ye dish'} banaye toh family bolengi "ek aur!"`,
        `Har ghar mein banne wali ${dataInput.dish || 'ye dish'} ka ultimate version!`,
      ],
    },
    health: {
      primary: `Is dish ko ${dataInput.calorieDelta || 100} calories kam karke banao!`,
      alternatives: [
        `Har day ${dataInput.originalDish || 'ye dish'} khate ho? Yeh swap zaroor try karo!`,
        `Weight loss ke liye bas yahi ek chij change karo!`,
      ],
    },
    tech: {
      primary: `${dataInput.toolName || 'Yeh tool'} aapki ${dataInput.timeSaved || 2} hours bachayega!`,
      alternatives: [
        `Boss, agar aap yeh tool nahi use karte toh time waste hai!`,
        `${dataInput.feature || 'Productivity'} ke liye yeh tool hai game-changer!`,
      ],
    },
    edtech: {
      primary: `${dataInput.cheatCode || 'Yeh trick'} ${dataInput.exam || 'exam'} mein 10 marks laayegi!`,
      alternatives: [
        `Agar yeh ${dataInput.topic || 'topic'} aapne nahi padha toh regret hoga!`,
        `${dataInput.exam} crack karne ka sabse easy tarika - yeh dekh lo!`,
      ],
    },
    travel: {
      primary: `${dataInput.location || 'Yeh jagah'} ${dataInput.baseCity || 'shahar'} ke bahut kareeb hai, but log nahi jaate!`,
      alternatives: [
        `₹${dataInput.budgetPerHead || 500} mein ${dataInput.location || 'yeh place'} explore karo!`,
        `Most people don't know about this hidden gem near ${dataInput.baseCity || 'your city'}!`,
      ],
    },
    cartoon: {
      primary: `Aapke ghar mein bhi ${dataInput.theme || 'yeh situation'} hota hai na? 😂`,
      alternatives: [
        `Yeh ${dataInput.dialect || 'Bambaiya'} style comedy aapki mummy ko bhi hasayegi!`,
        `Indian family problems ka ultimate compilation - relatable hai toh share karo!`,
      ],
    },
  };

  return hooks[nicheId] || hooks.food;
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

export { generationWorker };