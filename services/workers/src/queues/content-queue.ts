import { v4 as uuidv4 } from 'uuid';
import { getQueue, QUEUE_NAMES } from './connection';
import type { NicheId, TriggerSource } from '@viralforge/domain';

export interface ContentJobData {
  contentItemId?: string;
  nicheId: NicheId;
  subTopic?: string;
  dataInputPayload?: Record<string, unknown>;
  triggerSource: TriggerSource;
  triggerMetadata?: Record<string, unknown>;
  scheduledAt?: Date;
  idempotencyKey?: string;
}

export async function queueContentGeneration(data: ContentJobData) {
  const contentItemId = data.contentItemId || uuidv4();
  const job = await getQueue(QUEUE_NAMES.RESEARCH).add('research', {
    ...data,
    contentItemId,
    idempotencyKey: data.idempotencyKey ?? `research-${contentItemId}`,
  }, { jobId: uuidv4() });

  return { id: job.id!, contentItemId, queue: QUEUE_NAMES.RESEARCH };
}

export async function queueTextGeneration(data: ContentJobData) {
  if (!data.contentItemId) throw new Error('contentItemId is required for generation');
  const job = await getQueue(QUEUE_NAMES.GENERATION).add('generate-text', {
    ...data,
    idempotencyKey: data.idempotencyKey ?? `generation-${data.contentItemId}`,
  }, { jobId: uuidv4() });

  return { id: job.id!, contentItemId: data.contentItemId, queue: QUEUE_NAMES.GENERATION };
}

export async function queueMediaGeneration(contentItemId: string, nicheId: NicheId) {
  const job = await getQueue(QUEUE_NAMES.MEDIA).add('generate-media', {
    contentItemId,
    nicheId,
    idempotencyKey: `media-${contentItemId}`,
  }, { jobId: uuidv4() });

  return { id: job.id!, contentItemId, queue: QUEUE_NAMES.MEDIA };
}

export async function queueRendering(contentItemId: string) {
  const job = await getQueue(QUEUE_NAMES.RENDERING).add('render', {
    contentItemId,
    jobId: uuidv4(),
  });

  return { id: job.id!, contentItemId, queue: QUEUE_NAMES.RENDERING };
}

export async function queueValidation(contentItemId: string) {
  const job = await getQueue(QUEUE_NAMES.VALIDATION).add('validate', {
    contentItemId,
    jobId: uuidv4(),
  });

  return { id: job.id!, contentItemId, queue: QUEUE_NAMES.VALIDATION };
}

export async function queuePublishing(contentItemId: string, scheduledAt?: Date) {
  const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
  const job = await getQueue(QUEUE_NAMES.PUBLISHING).add('publish', {
    contentItemId,
    jobId: uuidv4(),
  }, { delay, attempts: 1 });

  return { id: job.id!, contentItemId, queue: QUEUE_NAMES.PUBLISHING };
}
