/**
 * Database-authoritative scheduler. BullMQ repeatable jobs only wake it up;
 * content_items and pipeline state remain the source of truth.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';

const LOOKAHEAD_MINUTES = Number(process.env.SCHEDULE_LOOKAHEAD_MINUTES || 15);

export async function schedulerWorker(_job: Job) {
  const admin = requireSupabaseAdmin();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60_000);

  const { data: items, error } = await admin
    .from('content_items')
    .select('id, organization_id, scheduled_at, generation_lead_minutes, status')
    .not('scheduled_at', 'is', null)
    .in('status', ['draft', 'queued', 'failed'])
    .lte('scheduled_at', windowEnd.toISOString())
    .order('scheduled_at', { ascending: true });
  if (error) throw new Error(`Failed to query scheduled content: ${error.message}`);

  let started = 0;
  let skipped = 0;
  for (const item of items || []) {
    const scheduledAt = new Date(item.scheduled_at);
    const generationAt = new Date(scheduledAt.getTime() - Number(item.generation_lead_minutes || 120) * 60_000);
    if (generationAt > now) { skipped += 1; continue; }

    const { error: startError } = await admin.rpc('start_content_pipeline', {
      p_content_item_id: item.id,
      p_organization_id: item.organization_id,
      p_requested_by: 'scheduler',
      p_start_stage: 'research',
      p_config_snapshot: { scheduledAt: item.scheduled_at, generationLeadMinutes: item.generation_lead_minutes },
      p_available_at: now.toISOString(),
    });
    if (startError) {
      console.error(`[Scheduler] Could not start ${item.id}:`, startError.message);
      skipped += 1;
    } else {
      started += 1;
    }
  }

  const { data: reconciliation, error: reconcileError } = await admin.rpc('reconcile_pipeline_work');
  if (reconcileError) throw new Error(`Scheduler reconciliation failed: ${reconcileError.message}`);
  return { success: true, started, skipped, reconciliation };
}
