import { Job, Processor } from 'bullmq';
import { PipelineCommandPayload, PipelineStage } from '@viralforge/domain';
import { requireSupabaseAdmin } from '@viralforge/supabase';

const WORKER_INSTANCE_ID = `${process.env.HOSTNAME || 'worker'}-${process.pid}`;
const LEASE_SECONDS = Number(process.env.PIPELINE_STAGE_LEASE_SECONDS || 900);

interface StageResult {
  success?: boolean;
  blocked?: boolean;
  [key: string]: unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableError(error: unknown): boolean {
  const value = error as { retryable?: boolean; code?: string; classification?: string };
  if (value?.classification === 'retryable') return true;
  if (value?.classification === 'blocked' || value?.classification === 'permanent') return false;
  if (value?.retryable === false) return false;
  return !['INVALID_INPUT', 'POLICY_BLOCKED', 'NOT_FOUND'].includes(value?.code || '');
}

/**
 * Adds durable claim/checkpoint/failure semantics around an existing stage
 * processor. Legacy jobs without a stageAttemptId continue to work during the
 * migration period, but all new pipeline jobs use the durable path.
 */
export function withPipelineRuntime(stage: PipelineStage, processor: Processor): Processor {
  return async (job: Job) => {
    const command = job.data as Partial<PipelineCommandPayload> & Record<string, unknown>;
    if (!command.stageAttemptId || !command.runId) {
      console.warn(`[Pipeline] Executing legacy ${stage} job ${job.id} without durable attempt metadata`);
      return processor(job);
    }
    if (command.stage !== stage) {
      throw new Error(`Pipeline command stage ${command.stage} cannot run on ${stage} worker`);
    }

    const admin = requireSupabaseAdmin();
    const workerId = `${WORKER_INSTANCE_ID}-${stage}-${job.id}`;
    const { data: attempt, error: claimError } = await admin.rpc('claim_stage_attempt', {
      p_attempt_id: command.stageAttemptId,
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (claimError) throw new Error(`Failed to claim ${stage} attempt: ${claimError.message}`);

    if (attempt?.status === 'completed') {
      return { success: true, skipped: true, reason: 'already_completed' };
    }
    if (attempt?.status !== 'processing' || attempt?.worker_id !== workerId) {
      throw new Error(`Cannot process ${stage}: attempt ${command.stageAttemptId} is in status ${attempt?.status || 'unavailable'} (expected processing)`);
    }

    try {
      const result = await processor(job) as StageResult | undefined;
      if (result?.blocked === true) {
        const { error: blockError } = await admin.rpc('block_stage_attempt', {
          p_attempt_id: command.stageAttemptId,
          p_worker_id: workerId,
          p_error: {
            message: String(result.reason || result.message || `${stage} is blocked`),
            code: String(result.code || 'STAGE_BLOCKED'),
            stage,
          },
          p_reason: String(result.reason || 'operator_intervention'),
        });
        if (blockError) throw new Error(`Failed to persist ${stage} block: ${blockError.message}`);
        return result;
      }
      if (result?.success === false) {
        const error = new Error(String(result.reason || result.message || `${stage} did not complete successfully`));
        (error as Error & { retryable?: boolean; code?: string }).retryable = false;
        (error as Error & { code?: string }).code = String(result.code || 'STAGE_FAILED');
        throw error;
      }
      const safeResult = (result || { success: true }) as Record<string, unknown>;
      const { error: completeError } = await admin.rpc('complete_stage_attempt', {
        p_attempt_id: command.stageAttemptId,
        p_worker_id: workerId,
        p_result: safeResult,
        p_checkpoint: { stage, completedAt: new Date().toISOString(), result: safeResult },
      });
      if (completeError) throw new Error(`Failed to checkpoint ${stage}: ${completeError.message}`);
      return safeResult;
    } catch (error) {
      if (error instanceof Error && (error as Error & { classification?: string }).classification === 'blocked') {
        const mediaError = error as Error & { classification?: string; providerCode?: string };
        const { error: blockError } = await admin.rpc('block_stage_attempt', {
          p_attempt_id: command.stageAttemptId,
          p_worker_id: workerId,
          p_error: {
            message: messageOf(error),
            code: mediaError.providerCode || 'MEDIA_PROVIDER_BLOCKED',
            stage,
          },
          p_reason: 'operator_intervention',
        });
        if (blockError) console.error(`[Pipeline] Failed to persist ${stage} block:`, blockError.message);
        return { success: false, blocked: true, reason: messageOf(error) };
      }
      const maxBullAttempts = Number(job.opts.attempts || 1);
      const bullWillRetry = isRetryableError(error) && job.attemptsMade + 1 < maxBullAttempts;
      const { error: failError } = await admin.rpc('fail_stage_attempt', {
        p_attempt_id: command.stageAttemptId,
        p_worker_id: workerId,
        p_error: {
          message: messageOf(error),
          code: (error as { code?: string })?.code || 'STAGE_FAILED',
          stage,
          bullAttempt: job.attemptsMade + 1,
        },
        p_retryable: bullWillRetry,
      });
      if (failError) console.error(`[Pipeline] Failed to persist ${stage} failure:`, failError.message);
      throw error;
    }
  };
}
