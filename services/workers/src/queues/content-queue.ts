/**
 * Worker-side stage helpers. Durable stage progression is performed by
 * complete_stage_attempt(); these exports remain for scheduler compatibility.
 */
import { PipelineStage } from '@viralforge/domain';
import { requireSupabaseAdmin } from '@viralforge/supabase';

async function enqueueStageForContent(contentItemId: string, stage: PipelineStage) {
  const admin = requireSupabaseAdmin();
  const { data: run, error } = await admin.from('pipeline_runs').select('id').eq('content_item_id', contentItemId)
    .in('status', ['pending', 'running', 'waiting', 'failed']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !run) throw new Error(`No pipeline run found for content ${contentItemId}`);
  const { data: attemptId, error: enqueueError } = await admin.rpc('enqueue_pipeline_attempt', {
    p_run_id: run.id,
    p_stage: stage,
    p_available_at: new Date().toISOString(),
  });
  if (enqueueError) throw new Error(`Failed to queue ${stage}: ${enqueueError.message}`);
  return { id: String(attemptId), contentItemId, runId: run.id, queue: 'database-outbox' };
}

export function queueTextGeneration(data: { contentItemId?: string }) {
  if (!data.contentItemId) throw new Error('contentItemId is required for generation');
  return enqueueStageForContent(data.contentItemId, 'generation');
}
export function queueMediaGeneration(contentItemId: string) { return enqueueStageForContent(contentItemId, 'media'); }
export function queueRendering(contentItemId: string) { return enqueueStageForContent(contentItemId, 'rendering'); }
export function queueValidation(contentItemId: string) { return enqueueStageForContent(contentItemId, 'validation'); }
export function queuePublishing(contentItemId: string) { return enqueueStageForContent(contentItemId, 'publishing'); }

export async function queueContentGeneration(data: { contentItemId?: string; organizationId?: string }) {
  if (!data.contentItemId) throw new Error('contentItemId is required; scheduler must use the existing content ID');
  const admin = requireSupabaseAdmin();
  let organizationId = data.organizationId;
  if (!organizationId) {
    const { data: item, error } = await admin.from('content_items').select('organization_id').eq('id', data.contentItemId).single();
    if (error || !item) throw new Error(`Content item not found: ${error?.message}`);
    organizationId = item.organization_id;
  }
  const { data: runId, error } = await admin.rpc('start_content_pipeline', {
    p_content_item_id: data.contentItemId,
    p_organization_id: organizationId,
    p_requested_by: 'scheduler',
    p_start_stage: 'research',
    p_config_snapshot: {},
    p_available_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Failed to start scheduled pipeline: ${error.message}`);
  return { id: String(runId), runId: String(runId), contentItemId: data.contentItemId, queue: 'database-outbox' };
}
