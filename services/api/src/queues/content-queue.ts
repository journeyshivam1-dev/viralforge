/**
 * Backward-compatible queue entry points backed by the durable pipeline.
 * New work is persisted in PostgreSQL first and dispatched by the outbox worker.
 */

import { NicheId, PipelineStage, TriggerSource } from '@viralforge/domain';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { startPipeline, retryPipelineFromStage } from '../pipeline/orchestrator';

export interface ContentJobData {
  contentItemId?: string;
  organizationId?: string;
  nicheId: NicheId;
  subTopic: string;
  dataInputPayload?: Record<string, unknown>;
  triggerSource: TriggerSource;
  triggerMetadata?: Record<string, unknown>;
  scheduledAt?: Date;
  idempotencyKey?: string;
}

interface JobResult {
  id: string;
  contentItemId: string;
  queue: string;
  runId: string;
}

export async function createContentAndStartPipeline(data: ContentJobData): Promise<JobResult> {
  const admin = requireSupabaseAdmin();
  if (!data.organizationId) throw new Error('organizationId is required when creating content from a trigger');
  const idempotencyKey = data.idempotencyKey || `${data.triggerSource}-${data.nicheId}-${Date.now()}`;
  const { data: existing } = await admin.from('content_items').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
  let content = existing;
  if (!content) {
    const { data: inserted, error } = await admin.from('content_items').insert({
      organization_id: data.organizationId,
      niche_id: data.nicheId,
      sub_topic: data.subTopic,
      data_input_payload: data.dataInputPayload || {},
      trigger_source: data.triggerSource,
      trigger_metadata: data.triggerMetadata || {},
      scheduled_at: data.scheduledAt?.toISOString() || null,
      status: 'draft',
      idempotency_key: idempotencyKey,
    }).select('*').single();
    if (error || !inserted) throw new Error(`Failed to persist triggered content: ${error?.message}`);
    content = inserted;
  }
  return queueContentGeneration({ ...data, contentItemId: content.id, organizationId: content.organization_id });
}

export async function queueContentGeneration(data: ContentJobData): Promise<JobResult> {
  if (!data.contentItemId) throw new Error('contentItemId is required; persist content before starting a pipeline');
  const admin = requireSupabaseAdmin();
  let organizationId = data.organizationId;
  if (!organizationId) {
    const { data: content, error } = await admin.from('content_items').select('organization_id').eq('id', data.contentItemId).single();
    if (error || !content) throw new Error(`Content item not found: ${error?.message || data.contentItemId}`);
    organizationId = content.organization_id;
  }
  if (!organizationId) throw new Error('Content item has no organization');
  const run = await startPipeline({
    contentItemId: data.contentItemId,
    organizationId,
    requestedBy: data.triggerSource,
    configSnapshot: { idempotencyKey: data.idempotencyKey, triggerMetadata: data.triggerMetadata || {} },
  });
  return { id: run.id, runId: run.id, contentItemId: data.contentItemId, queue: 'database-outbox' };
}

async function queueStage(contentItemId: string, stage: PipelineStage): Promise<JobResult> {
  const admin = requireSupabaseAdmin();
  const { data: run, error } = await admin.from('pipeline_runs').select('id').eq('content_item_id', contentItemId)
    .in('status', ['pending', 'running', 'waiting', 'failed']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !run) throw new Error(`No resumable pipeline found for content ${contentItemId}`);
  const queued = await retryPipelineFromStage(run.id, stage, 'manual');
  return { id: String(queued.stageAttemptId), runId: run.id, contentItemId, queue: 'database-outbox' };
}

export function queueTextGeneration(contentItemId: string): Promise<JobResult> { return queueStage(contentItemId, 'generation'); }
export function queueMediaGeneration(contentItemId: string): Promise<JobResult> { return queueStage(contentItemId, 'media'); }
export function queueRendering(contentItemId: string): Promise<JobResult> { return queueStage(contentItemId, 'rendering'); }
export function queueValidation(contentItemId: string): Promise<JobResult> { return queueStage(contentItemId, 'validation'); }
export function queuePublishing(contentItemId: string): Promise<JobResult> { return queueStage(contentItemId, 'publishing'); }
