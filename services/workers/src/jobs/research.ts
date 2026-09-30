/**
 * Research Worker
 * Produces grounded research notes for a content item via the AI provider chain
 * (Omniroute, then Gemini). Notes are checkpointed on the content row and reused
 * on retry, so a later-stage retry never re-runs research.
 */

import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  NicheId,
  ResearchNotesSchema,
  UNTRUSTED_DATA_RULE,
  asDataBlock,
  createAiProviderChainFromEnv,
  getNichePlaybook,
  parseJsonObject,
  readBrief,
  sanitizePromptList,
  sanitizePromptText,
  validatePayload,
  type ResearchNotes,
} from '@viralforge/domain';

const supabase = requireSupabaseAdmin();
const aiChain = createAiProviderChainFromEnv();

export async function researchWorker(job: Job) {
  const contentItemId = job.data?.contentItemId || job.data?.triggerMetadata?.contentItemId;
  if (!contentItemId) throw new Error('contentItemId is required in job.data');

  const { data: item, error } = await supabase
    .from('content_items')
    .select('id, organization_id, niche_id, sub_topic, media_type, data_input_payload')
    .eq('id', contentItemId)
    .single();
  if (error || !item) throw Object.assign(new Error(`Content item not found: ${contentItemId}`), { code: 'NOT_FOUND' });

  const payload = (item.data_input_payload || {}) as Record<string, any>;
  const existing = ResearchNotesSchema.safeParse(payload.research);
  if (existing.success) {
    return { success: true, contentItemId, reused: true, nextStage: 'generation' };
  }

  const brief = readBrief(payload);
  if (!brief) {
    // Legacy hand-made items must carry their niche-specific fields.
    const validationErrors = validatePayload(item.niche_id as NicheId, payload);
    if (validationErrors.length > 0) {
      return { success: false, blocked: true, code: 'INVALID_INPUT', reason: validationErrors.join('; ') };
    }
  }

  await job.updateProgress(20);
  const playbook = getNichePlaybook(item.niche_id);
  const topic = sanitizePromptText(brief?.title || item.sub_topic, 200);
  const context = brief
    ? [
        `Angle: ${sanitizePromptText(brief.angle, 500)}`,
        `Key points: ${sanitizePromptList(brief.keyPoints).join('; ') || '-'}`,
        `Trend context: ${sanitizePromptText(brief.trendContext, 1000) || '-'}`,
      ].join('\n')
    : `Operator input: ${sanitizePromptText(JSON.stringify(stripInternal(payload)), 2000)}`;

  const result = await aiChain.generateText({
    json: true,
    temperature: 0.4,
    maxTokens: 2000,
    system: `You are a careful research assistant for a Hindi/Hinglish ${playbook?.displayName || item.niche_id} social media channel. `
      + 'Only state facts you are confident are true. If unsure, leave it out. Return JSON only. '
      + UNTRUSTED_DATA_RULE,
    user: [
      asDataBlock('topic', `Topic: ${topic}\n${context}`),
      `Audience: ${playbook?.audience || 'Hindi-speaking Indian viewers'}`,
      `Safety rules: ${(playbook?.safetyRules || []).join('; ') || '-'}`,
      '',
      'Return exactly: {"summary": "string", "facts": ["string"], "audiencePainPoints": ["string"], "hookIdeas": ["string"], "cautions": ["string"]}',
      'facts: 3-8 short verifiable facts. hookIdeas: 3-5 scroll-stopping Hinglish hooks. cautions: anything the writer must not claim.',
    ].join('\n'),
  });

  await job.updateProgress(70);
  const raw = parseJsonObject(result.text);
  const notes: ResearchNotes = ResearchNotesSchema.parse({
    schemaVersion: 1,
    summary: String(raw.summary || '').slice(0, 1500),
    facts: stringArray(raw.facts, 12, 400),
    audiencePainPoints: stringArray(raw.audiencePainPoints, 8, 300),
    hookIdeas: stringArray(raw.hookIdeas, 8, 200),
    cautions: stringArray(raw.cautions, 8, 300),
    provider: result.provider,
    model: result.model,
    researchedAt: new Date().toISOString(),
  });

  const { error: updateError } = await supabase
    .from('content_items')
    .update({ status: 'researched', data_input_payload: { ...payload, research: notes } })
    .eq('id', contentItemId);
  if (updateError) throw new Error(`Failed to save research notes: ${updateError.message}`);

  await supabase.from('audit_logs').insert({
    organization_id: item.organization_id,
    content_item_id: contentItemId,
    niche_id: item.niche_id,
    action: 'research.completed',
    actor: 'system',
    actor_type: 'system',
    metadata: { provider: result.provider, model: result.model, factCount: notes.facts.length, fallbacks: result.fallbackAttempts },
  });

  await job.updateProgress(100);
  return { success: true, contentItemId, provider: result.provider, factCount: notes.facts.length, nextStage: 'generation' };
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, maxLength))
    .slice(0, maxItems);
}

function stripInternal(payload: Record<string, any>): Record<string, any> {
  const { research: _research, brief: _brief, ...rest } = payload;
  return rest;
}
