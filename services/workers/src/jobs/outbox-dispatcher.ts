import { Job } from 'bullmq';
import { PipelineCommandPayload, STAGE_RETRY_POLICY, buildPipelineJobId, isPipelineStage } from '@viralforge/domain';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { getQueue } from '../queues/connection';

const DISPATCHER_ID = `${process.env.HOSTNAME || 'worker'}-${process.pid}`;

export async function outboxDispatcherWorker(_job: Job) {
  const admin = requireSupabaseAdmin();
  const { data: claimed, error } = await admin.rpc('claim_queue_outbox', {
    p_dispatcher_id: DISPATCHER_ID,
    p_limit: Number(process.env.OUTBOX_DISPATCH_BATCH_SIZE || 25),
  });
  if (error) throw new Error(`Failed to claim outbox: ${error.message}`);

  let dispatched = 0;
  let failed = 0;
  for (const row of claimed || []) {
    const claimToken = row.claim_token as string;
    try {
      const payload = row.payload as PipelineCommandPayload;
      if (!isPipelineStage(payload.stage)) throw new Error(`Invalid outbox stage: ${payload.stage}`);

      const { data: content, error: contentError } = await admin
        .from('content_items')
        .select('sub_topic, data_input_payload, trigger_metadata, scheduled_at')
        .eq('id', payload.contentItemId)
        .single();
      if (contentError || !content) throw new Error(`Content missing for outbox command: ${contentError?.message}`);

      const policy = STAGE_RETRY_POLICY[payload.stage];
      const jobId = buildPipelineJobId(payload.runId, payload.stage, payload.attemptNo);
      const delay = Math.max(0, new Date(row.available_at).getTime() - Date.now());
      await getQueue(row.queue_name).add(row.job_name, {
        ...payload,
        outboxId: row.id,
        subTopic: content.sub_topic,
        dataInputPayload: content.data_input_payload || {},
        triggerMetadata: content.trigger_metadata || {},
        scheduledAt: content.scheduled_at,
      }, {
        jobId,
        delay,
        attempts: policy.attempts,
        backoff: policy.backoffMs > 0 ? { type: 'exponential', delay: policy.backoffMs } : undefined,
      });

      const { error: markError } = await admin.rpc('mark_outbox_dispatched', {
        p_outbox_id: row.id,
        p_claim_token: claimToken,
      });
      if (markError) throw new Error(`Job queued but outbox could not be finalized: ${markError.message}`);
      dispatched += 1;
    } catch (dispatchError) {
      failed += 1;
      const message = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
      const { error: releaseError } = await admin.rpc('release_outbox_claim', {
        p_outbox_id: row.id,
        p_claim_token: claimToken,
        p_error: message,
      });
      if (releaseError) console.error('[Outbox] Failed to release claim:', releaseError.message);
      console.error(`[Outbox] Failed command ${row.id}:`, message);
    }
  }

  return { success: true, claimed: claimed?.length || 0, dispatched, failed };
}

export async function reconciliationWorker(_job: Job) {
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin.rpc('reconcile_pipeline_work');
  if (error) throw new Error(`Pipeline reconciliation failed: ${error.message}`);

  // Redis is disposable. Recreate missing jobs whose durable outbox command was
  // already marked dispatched but whose stage has not started/completed.
  const { data: recoverable, error: recoverableError } = await admin
    .from('queue_outbox')
    .select('*, stage_attempts!inner(status)')
    .eq('status', 'dispatched')
    .in('stage_attempts.status', ['pending', 'queued', 'retryable_failed'])
    .limit(100);
  if (recoverableError) throw new Error(`Failed to inspect dispatched commands: ${recoverableError.message}`);

  let redisJobsRecovered = 0;
  for (const row of recoverable || []) {
    const payload = row.payload as PipelineCommandPayload;
    if (!isPipelineStage(payload.stage)) continue;
    const queue = getQueue(row.queue_name);
    const jobId = buildPipelineJobId(payload.runId, payload.stage, payload.attemptNo);
    if (await queue.getJob(jobId)) continue;

    const { data: content, error: contentError } = await admin
      .from('content_items')
      .select('sub_topic, data_input_payload, trigger_metadata, scheduled_at')
      .eq('id', payload.contentItemId)
      .single();
    if (contentError || !content) continue;
    const policy = STAGE_RETRY_POLICY[payload.stage];
    const delay = Math.max(0, new Date(row.available_at).getTime() - Date.now());
    await queue.add(row.job_name, {
      ...payload,
      outboxId: row.id,
      subTopic: content.sub_topic,
      dataInputPayload: content.data_input_payload || {},
      triggerMetadata: content.trigger_metadata || {},
      scheduledAt: content.scheduled_at,
    }, {
      jobId,
      delay,
      attempts: policy.attempts,
      backoff: policy.backoffMs > 0 ? { type: 'exponential', delay: policy.backoffMs } : undefined,
    });
    redisJobsRecovered += 1;
  }

  return { success: true, ...data, redisJobsRecovered };
}
