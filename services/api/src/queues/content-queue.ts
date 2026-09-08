/**
 * Content queue entry points. Every job carries the canonical content item ID,
 * so workers never create detached pipeline records.
 */

import { getQueue, QUEUE_NAMES } from './connection';
import { v4 as uuidv4 } from 'uuid';
import { NicheId, TriggerSource } from '@viralforge/domain';

interface ContentJobData {
  contentItemId?: string;
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
}

async function addContentJob(
  queueName: string,
  name: string,
  data: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Promise<JobResult> {
  const jobId = uuidv4();
  const contentItemId = String(data.contentItemId);
  const job = await getQueue(queueName).add(name, { ...data, jobId }, {
    jobId,
    ...options,
  });

  return { id: job.id!, contentItemId, queue: queueName };
}

export async function queueContentGeneration(data: ContentJobData): Promise<JobResult> {
  const contentItemId = data.contentItemId || uuidv4();
  return addContentJob(QUEUE_NAMES.RESEARCH, 'research', {
    ...data,
    contentItemId,
    idempotencyKey: data.idempotencyKey || `research-${contentItemId}`,
  }, { delay: calculateDelay(data) });
}

export async function queueTextGeneration(
  contentItemId: string,
  nicheId: NicheId,
  dataInputPayload: Record<string, unknown> = {},
  triggerSource: TriggerSource = 'manual',
): Promise<JobResult> {
  return addContentJob(QUEUE_NAMES.GENERATION, 'generate-text', {
    contentItemId,
    nicheId,
    dataInputPayload,
    triggerSource,
    idempotencyKey: `generation-${contentItemId}`,
  });
}

export async function queueMediaGeneration(
  contentItemId: string,
  nicheId: NicheId,
): Promise<JobResult> {
  return addContentJob(QUEUE_NAMES.MEDIA, 'generate-media', {
    contentItemId,
    nicheId,
    idempotencyKey: `media-${contentItemId}`,
  });
}

export async function queueRendering(contentItemId: string): Promise<JobResult> {
  return addContentJob(QUEUE_NAMES.RENDERING, 'render', {
    contentItemId,
    idempotencyKey: `render-${contentItemId}`,
  }, { attempts: 2, priority: 1 });
}

export async function queueValidation(contentItemId: string): Promise<JobResult> {
  return addContentJob(QUEUE_NAMES.VALIDATION, 'validate', {
    contentItemId,
    idempotencyKey: `validate-${contentItemId}`,
  }, { priority: 2 });
}

export async function queuePublishing(contentItemId: string, scheduledAt?: Date): Promise<JobResult> {
  const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
  return addContentJob(QUEUE_NAMES.PUBLISHING, 'publish', {
    contentItemId,
    idempotencyKey: `publish-${contentItemId}`,
  }, { delay, attempts: 1 });
}

function calculateDelay(data: ContentJobData): number {
  if (data.triggerSource !== 'calendar' || !data.scheduledAt) return 0;
  return Math.max(0, data.scheduledAt.getTime() - Date.now());
}

export default {
  queueContentGeneration,
  queueTextGeneration,
  queueMediaGeneration,
  queueRendering,
  queueValidation,
  queuePublishing,
};
