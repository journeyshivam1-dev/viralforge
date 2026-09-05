/**
 * Content Queue - Job Enqueueing Functions
 * High-level API for queuing content generation jobs
 */

import { getQueue, QUEUE_NAMES } from './connection';
import { v4 as uuidv4 } from 'uuid';
import { NicheId, TriggerSource } from '@viralforge/domain';

interface ContentJobData {
  nicheId: NicheId;
  subTopic: string;
  dataInputPayload?: Record<string, any>;
  triggerSource: TriggerSource;
  triggerMetadata?: Record<string, any>;
  scheduledAt?: Date;
  idempotencyKey?: string;
}

interface JobResult {
  id: string;
  contentItemId: string;
  queue: string;
}

/**
 * Queue content generation job
 * This is the main entry point for content creation
 */
export async function queueContentGeneration(data: ContentJobData): Promise<JobResult> {
  const queue = getQueue(QUEUE_NAMES.RESEARCH);

  const jobId = uuidv4();
  const idempotencyKey = data.idempotencyKey || `${data.triggerSource}-${data.nicheId}-${data.subTopic}-${Date.now()}`;

  const job = await queue.add(
    'research',
    {
      jobId,
      ...data,
      idempotencyKey,
    },
    {
      jobId,
      // Delay based on trigger source
      delay: calculateDelay(data),
    }
  );

  return {
    id: job.id!,
    contentItemId: jobId,
    queue: QUEUE_NAMES.RESEARCH,
  };
}

/**
 * Queue rendering job (called after generation completes)
 */
export async function queueRendering(contentItemId: string): Promise<JobResult> {
  const queue = getQueue(QUEUE_NAMES.RENDERING);

  const job = await queue.add(
    'render',
    {
      contentItemId,
      jobId: uuidv4(),
    },
    {
      attempts: 2,
      priority: 1,
    }
  );

  return {
    id: job.id!,
    contentItemId,
    queue: QUEUE_NAMES.RENDERING,
  };
}

/**
 * Queue validation job
 */
export async function queueValidation(contentItemId: string): Promise<JobResult> {
  const queue = getQueue(QUEUE_NAMES.VALIDATION);

  const job = await queue.add(
    'validate',
    {
      contentItemId,
      jobId: uuidv4(),
    },
    {
      priority: 2, // Run after rendering
    }
  );

  return {
    id: job.id!,
    contentItemId,
    queue: QUEUE_NAMES.VALIDATION,
  };
}

/**
 * Queue publishing job
 */
export async function queuePublishing(
  contentItemId: string,
  scheduledAt?: Date
): Promise<JobResult> {
  const queue = getQueue(QUEUE_NAMES.PUBLISHING);

  const delay = scheduledAt
    ? scheduledAt.getTime() - Date.now()
    : 0;

  const job = await queue.add(
    'publish',
    {
      contentItemId,
      jobId: uuidv4(),
    },
    {
      delay: Math.max(0, delay),
      // Only attempt once for publishing (no retries after final post)
      attempts: 1,
    }
  );

  return {
    id: job.id!,
    contentItemId,
    queue: QUEUE_NAMES.PUBLISHING,
  };
}

/**
 * Queue scheduled items for the next interval
 * Called by the scheduler cron job
 */
export async function queueScheduledItems(): Promise<number> {
  // This would query the database for items scheduled within the next interval
  // For now, return 0 - implemented in the scheduler service
  return 0;
}

/**
 * Calculate job delay based on trigger source and time
 */
function calculateDelay(data: ContentJobData): number {
  // Telegram/WhatsApp triggers process immediately
  if (data.triggerSource === 'telegram' || data.triggerSource === 'whatsapp') {
    return 0;
  }

  // Manual triggers process immediately
  if (data.triggerSource === 'manual') {
    return 0;
  }

  // Calendar triggers respect scheduled time
  if (data.scheduledAt) {
    const delay = data.scheduledAt.getTime() - Date.now();
    return Math.max(0, delay);
  }

  // Default: process immediately
  return 0;
}

export default {
  queueContentGeneration,
  queueRendering,
  queueValidation,
  queuePublishing,
  queueScheduledItems,
};