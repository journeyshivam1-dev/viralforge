/**
 * Research Worker
 * Collects and validates content input data
 */

import { Job } from 'bullmq';
import { supabase } from '@viralforge/supabase';
import { validatePayload, NicheId } from '@viralforge/domain';
import { queueTextGeneration } from '../queues/content-queue';

export async function researchWorker(job: Job) {
  // Handle legacy jobs where contentItemId might be in triggerMetadata
  const { contentItemId: topLevelContentItemId, nicheId: topLevelNicheId, dataInputPayload: topLevelDataInputPayload, triggerMetadata } = job.data;
  const contentItemId = topLevelContentItemId || triggerMetadata?.contentItemId;
  const nicheId = topLevelNicheId || triggerMetadata?.nicheId;
  const dataInputPayload = topLevelDataInputPayload || triggerMetadata?.dataInputPayload || {};

  if (!contentItemId) {
    throw new Error('contentItemId is required in job.data or job.data.triggerMetadata');
  }

  // Log warning if we had to fall back to triggerMetadata
  if (topLevelContentItemId !== contentItemId || topLevelNicheId !== nicheId) {
    console.warn(`[Research] Using fallback values from triggerMetadata for content ${contentItemId}`);
  }

  console.log(`[Research] Starting research for content ${contentItemId}`);

  try {
    // Update job progress
    await job.updateProgress(10);

    // Validate payload for niche
    const validationErrors = validatePayload(nicheId as NicheId, dataInputPayload || {});

    if (validationErrors.length > 0) {
      // Update content item with validation errors
      await supabase
        .from('content_items')
        .update({
          status: 'blocked',
          validation_errors: validationErrors,
        })
        .eq('id', contentItemId);

      throw new Error(`Validation failed: ${validationErrors.join(', ')}`);
    }

    await job.updateProgress(30);

    // Enrich data with additional research (placeholder for actual research logic)
    const enrichedData = await performResearch(nicheId as NicheId, dataInputPayload || {});

    await job.updateProgress(60);

    // Update content item with researched data
    const { error: updateError } = await supabase
      .from('content_items')
      .update({
        status: 'researched',
        data_input_payload: {
          ...dataInputPayload,
          ...enrichedData,
        },
      })
      .eq('id', contentItemId);

    if (updateError) {
      throw new Error(`Failed to update content item: ${updateError.message}`);
    }

    await job.updateProgress(75);

    const generationJob = await queueTextGeneration({
      contentItemId,
      nicheId: nicheId as NicheId,
      dataInputPayload: {
        ...dataInputPayload,
        ...enrichedData,
      },
      triggerSource: job.data.triggerSource || 'manual',
      triggerMetadata: { researchJobId: String(job.id) },
      idempotencyKey: `generation-${contentItemId}`,
    });

    await job.updateProgress(90);

    const { data: contentItem } = await supabase
      .from('content_items')
      .select('organization_id')
      .eq('id', contentItemId)
      .single();

    // Log audit event
    await logAuditEvent(contentItem?.organization_id, contentItemId, 'research.completed', {
      nicheId,
      enrichedFields: Object.keys(enrichedData),
      generationJobId: generationJob.id,
    });

    await job.updateProgress(100);

    console.log(`[Research] Research completed for content ${contentItemId}`);

    return {
      success: true,
      contentItemId,
      enrichedData,
      generationJob,
    };
  } catch (error) {
    console.error(`[Research] Error for content ${contentItemId}:`, error);

    // Update content item status
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
 * Perform niche-specific research
 * This would connect to external APIs, databases, etc.
 */
async function performResearch(
  nicheId: NicheId,
  payload: Record<string, any>
): Promise<Record<string, any>> {
  switch (nicheId) {
    case 'food':
      return {
        regionalVariations: await getRegionalVariations(payload.dish),
        cookingTips: await getCookingTips(payload.dish),
        nutritionalInfo: await getNutritionalInfo(payload.dish),
      };

    case 'health':
      return {
        healthBenefits: await getHealthBenefits(payload.transformedDish),
        calorieInfo: await getCalorieInfo(payload.originalDish, payload.transformedDish),
        proteinInfo: await getProteinInfo(payload.transformedDish),
      };

    case 'tech':
      return {
        toolAlternatives: await getToolAlternatives(payload.toolName),
        pricingInfo: await getPricingInfo(payload.toolName),
        useCases: await getUseCases(payload.toolName),
      };

    case 'edtech':
      return {
        examPattern: await getExamPattern(payload.exam, payload.subject),
        previousYearQuestions: await getPYQs(payload.exam, payload.subject, payload.topic),
        preparationTips: await getPrepTips(payload.exam, payload.subject),
      };

    case 'travel':
      return {
        weatherInfo: await getWeatherInfo(payload.location),
        localAttractions: await getLocalAttractions(payload.location),
        budgetTips: await getBudgetTips(payload.location),
      };

    case 'cartoon':
      return {
        culturalContext: await getCulturalContext(payload.dialect),
        characterSuggestions: await getCharacterSuggestions(payload.theme),
      };

    default:
      return {};
  }
}

// Placeholder research functions - implement with actual APIs
async function getRegionalVariations(dish: string) {
  return [`${dish} - Punjabi style`, `${dish} - South Indian style`, `${dish} - Bengali style`];
}

async function getCookingTips(dish: string) {
  return ['Use fresh ingredients', 'Control flame for perfect texture', 'Add tempering at the end'];
}

async function getNutritionalInfo(dish: string) {
  return { calories: '~200 per serving', protein: '~8g', carbs: '~25g', fat: '~8g' };
}

async function getHealthBenefits(dish: string) {
  return ['Rich in protein', 'Low glycemic index', 'Good for gut health'];
}

async function getCalorieInfo(original: string, transformed: string) {
  return { original: 450, transformed: 280, saved: 170 };
}

async function getProteinInfo(dish: string) {
  return { perServing: '18g', dailyValue: '36%' };
}

async function getToolAlternatives(tool: string) {
  return [`Alternative 1 to ${tool}`, `Alternative 2 to ${tool}`];
}

async function getPricingInfo(tool: string) {
  return { free: true, premium: '$9/month' };
}

async function getUseCases(tool: string) {
  return ['Automation', 'Productivity', 'Time saving'];
}

async function getExamPattern(exam: string, subject: string) {
  return { totalMarks: 100, sections: 4, duration: '3 hours' };
}

async function getPYQs(exam: string, subject: string, topic: string) {
  return [`2023 - ${topic} question`, `2022 - ${topic} question`];
}

async function getPrepTips(exam: string, subject: string) {
  return ['Focus on concepts', 'Practice daily', 'Take mock tests'];
}

async function getWeatherInfo(location: string) {
  return { current: '25°C', best: 'October-March' };
}

async function getLocalAttractions(location: string) {
  return [`${location} Fort`, `${location} Temple`, `${location} Beach`];
}

async function getBudgetTips(location: string) {
  return ['Stay in hostels', 'Use local transport', 'Eat at local joints'];
}

async function getCulturalContext(dialect: string) {
  return { region: 'North India', style: 'Family comedy' };
}

async function getCharacterSuggestions(theme: string) {
  return ['Character A', 'Character B', 'Supporting cast'];
}

async function logAuditEvent(
  organizationId: string | undefined,
  contentItemId: string,
  action: string,
  metadata: Record<string, any>
) {
  await supabase.from('audit_logs').insert({
    organization_id: organizationId,
    content_item_id: contentItemId,
    action,
    actor: 'system',
    actor_type: 'system',
    metadata,
  });
}