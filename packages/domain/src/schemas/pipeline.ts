/**
 * Durable pipeline orchestration contracts.
 * PostgreSQL is the source of truth; BullMQ only transports commands.
 */

export const PIPELINE_STAGES = [
  'research',
  'generation',
  'media',
  'rendering',
  'validation',
  'publishing',
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

export type PipelineRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StageAttemptStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'retryable_failed'
  | 'permanent_failed'
  | 'blocked'
  | 'cancelled';

export type PublishMode = 'manual_approval' | 'immediate_auto' | 'scheduled';

export type QueueCommandType = 'execute_stage' | 'reconcile_pipeline';

export interface PipelineCommandPayload {
  schemaVersion: 1;
  commandType: 'execute_stage';
  outboxId: string;
  runId: string;
  stageAttemptId: string;
  contentItemId: string;
  organizationId: string;
  stage: PipelineStage;
  attemptNo: number;
  nicheId: string;
  triggerSource: string;
  notBefore?: string | null;
}

export interface StartPipelineInput {
  contentItemId: string;
  organizationId: string;
  requestedBy: string;
  startStage?: PipelineStage;
  configSnapshot?: Record<string, unknown>;
}

export const QUEUE_NAMES_BY_STAGE: Record<PipelineStage, string> = {
  research: 'viralforge-research',
  generation: 'viralforge-generation',
  media: 'viralforge-media',
  rendering: 'viralforge-rendering',
  validation: 'viralforge-validation',
  publishing: 'viralforge-publishing',
};

export const STAGE_RETRY_POLICY: Record<PipelineStage, { attempts: number; backoffMs: number }> = {
  research: { attempts: 3, backoffMs: 2_000 },
  generation: { attempts: 3, backoffMs: 5_000 },
  media: { attempts: 3, backoffMs: 10_000 },
  rendering: { attempts: 2, backoffMs: 10_000 },
  validation: { attempts: 2, backoffMs: 2_000 },
  // Remote publishing is reconciled before a new logical attempt is created.
  publishing: { attempts: 1, backoffMs: 0 },
};

export function getNextPipelineStage(stage: PipelineStage): PipelineStage | null {
  const index = PIPELINE_STAGES.indexOf(stage);
  return index >= 0 && index < PIPELINE_STAGES.length - 1
    ? PIPELINE_STAGES[index + 1]
    : null;
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && PIPELINE_STAGES.includes(value as PipelineStage);
}

export function isStageTerminal(status: StageAttemptStatus): boolean {
  return ['completed', 'permanent_failed', 'blocked', 'cancelled'].includes(status);
}

/** BullMQ custom IDs may not contain a colon. */
export function buildPipelineJobId(runId: string, stage: PipelineStage, attemptNo: number): string {
  return `pipeline-${sanitizeJobIdPart(runId)}-${stage}-${attemptNo}`;
}

export function buildOutboxDedupeKey(runId: string, stage: PipelineStage, attemptNo: number): string {
  return buildPipelineJobId(runId, stage, attemptNo);
}

function sanitizeJobIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
