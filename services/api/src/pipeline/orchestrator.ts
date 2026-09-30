import { PipelineStage, StartPipelineInput, isPipelineStage } from '@viralforge/domain';
import { requireSupabaseAdmin } from '@viralforge/supabase';

export interface PipelineRunSummary {
  id: string;
  content_item_id: string;
  organization_id: string;
  status: string;
  current_stage: PipelineStage;
  created_at: string;
  updated_at: string;
}

export async function startPipeline(input: StartPipelineInput): Promise<PipelineRunSummary> {
  const admin = requireSupabaseAdmin();
  const startStage = input.startStage ?? 'research';
  const { data: runId, error } = await admin.rpc('start_content_pipeline', {
    p_content_item_id: input.contentItemId,
    p_organization_id: input.organizationId,
    p_requested_by: input.requestedBy,
    p_start_stage: startStage,
    p_config_snapshot: input.configSnapshot ?? {},
    p_available_at: new Date().toISOString(),
  });
  if (error || !runId) throw new Error(`Failed to start pipeline: ${error?.message || 'No run returned'}`);
  return getPipelineRun(String(runId));
}

export async function getPipelineRun(runId: string): Promise<PipelineRunSummary> {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin.from('pipeline_runs').select('*').eq('id', runId).single();
  if (error || !data) throw new Error(`Pipeline run not found: ${error?.message || runId}`);
  return data as PipelineRunSummary;
}

export async function getPipelineForContent(contentItemId: string) {
  const admin = requireSupabaseAdmin();
  const { data: runs, error } = await admin
    .from('pipeline_runs')
    .select('*, stage_attempts(*), pipeline_artifacts(*)')
    .eq('content_item_id', contentItemId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load pipeline: ${error.message}`);
  return runs ?? [];
}

export async function resumePipeline(runId: string, requestedBy: string) {
  const admin = requireSupabaseAdmin();
  const { data: attemptId, error } = await admin.rpc('resume_pipeline_run', {
    p_run_id: runId,
    p_requested_by: requestedBy,
  });
  if (error) throw new Error(`Failed to resume pipeline: ${error.message}`);
  return { runId, stageAttemptId: attemptId };
}

export async function retryPipelineFromStage(runId: string, stage: unknown, requestedBy: string) {
  if (!isPipelineStage(stage)) throw new Error('Invalid pipeline stage');
  const admin = requireSupabaseAdmin();
  const { data: run, error: runError } = await admin.from('pipeline_runs').select('*').eq('id', runId).single();
  if (runError || !run) throw new Error(`Pipeline run not found: ${runError?.message || runId}`);

  const { data: attemptId, error } = await admin.rpc('enqueue_pipeline_attempt', {
    p_run_id: runId,
    p_stage: stage,
    p_available_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Failed to retry stage: ${error.message}`);
  await admin.from('pipeline_runs').update({ requested_by: requestedBy }).eq('id', runId);
  return { runId, stage, stageAttemptId: attemptId };
}

export async function approveContent(runId: string, requestedBy: string) {
  const admin = requireSupabaseAdmin();
  const { data: run, error: runError } = await admin.from('pipeline_runs').select('content_item_id').eq('id', runId).single();
  if (runError || !run) throw new Error(`Pipeline run not found: ${runError?.message || runId}`);

  const { error: approvalError } = await admin.from('content_items').update({
    approval_status: 'approved',
    approved_at: new Date().toISOString(),
    approved_by: requestedBy,
  }).eq('id', run.content_item_id);
  if (approvalError) throw new Error(`Failed to approve content: ${approvalError.message}`);

  const { data: attemptId, error } = await admin.rpc('resume_pipeline_run', {
    p_run_id: runId,
    p_requested_by: requestedBy,
  });
  if (error) throw new Error(`Failed to resume pipeline after approval: ${error.message}`);
  return { runId, stageAttemptId: attemptId };
}

export async function rejectContent(runId: string, reason: string) {
  const admin = requireSupabaseAdmin();
  const { data: run, error: runError } = await admin.from('pipeline_runs').select('content_item_id').eq('id', runId).single();
  if (runError || !run) throw new Error(`Pipeline run not found: ${runError?.message || runId}`);

  const { error: rejectionError } = await admin.from('content_items').update({
    approval_status: 'rejected',
    validation_errors: [reason],
  }).eq('id', run.content_item_id);
  if (rejectionError) throw new Error(`Failed to reject content: ${rejectionError.message}`);

  const { error: cancelError } = await admin.from('pipeline_runs').update({
    status: 'cancelled',
    error: { code: 'rejected_by_operator', message: reason },
    cancelled_at: new Date().toISOString(),
  }).eq('id', runId);
  if (cancelError) throw new Error(`Failed to cancel pipeline run: ${cancelError.message}`);

  return { runId };
}
