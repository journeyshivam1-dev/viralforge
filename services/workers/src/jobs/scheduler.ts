/**
 * Database-authoritative scheduler. BullMQ repeatable jobs only wake it up;
 * content_items and pipeline state remain the source of truth.
 *
 * Only never-started drafts are started here. Failed runs are never restarted
 * from research: stage retries happen inside the run, and operator retries go
 * through retry_failed_pipelines, which resumes the failed stage only.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';

const LOOKAHEAD_MINUTES = Number(process.env.SCHEDULE_LOOKAHEAD_MINUTES || 15);

export async function schedulerWorker(_job: Job) {
  const admin = requireSupabaseAdmin();

  const { data: started, error } = await admin.rpc('start_due_scheduled_content', {
    p_now: new Date().toISOString(),
    p_lookahead: `${LOOKAHEAD_MINUTES} minutes`,
    p_limit: 50,
  });
  if (error) throw new Error(`Scheduler failed to start due content: ${error.message}`);
  for (const entry of started?.errors || []) {
    console.error(`[Scheduler] Could not start ${entry.contentItemId}: ${entry.reason}`);
  }

  const { data: autoApproved, error: approveError } = await admin.rpc('auto_approve_due_runs', { p_now: new Date().toISOString() });
  if (approveError) console.error(`[Scheduler] Auto-approve failed: ${approveError.message}`);

  const { data: reconciliation, error: reconcileError } = await admin.rpc('reconcile_pipeline_work');
  if (reconcileError) throw new Error(`Scheduler reconciliation failed: ${reconcileError.message}`);
  return { success: true, started: started?.started ?? 0, autoApproved: autoApproved ?? 0, reconciliation };
}
