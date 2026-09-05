/**
 * Jobs Queue - Job Tracking and Status Management
 */

import { Queue, Job } from 'bullmq';
import { getQueue, QUEUE_NAMES } from './connection';
import { supabase } from '@viralforge/supabase';

/**
 * Get job by Omniroute ID
 */
export async function getJobFromOmnirouteId(omnirouteJobId: string): Promise<any | null> {
  // Query the database for a job with matching Omniroute ID
  // This would be stored in job.result or job.metadata
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .contains('result', { omnirouteJobId })
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Update job progress
 */
export async function updateJobProgress(
  jobId: string,
  progress: number,
  metadata?: Record<string, any>
): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({
      progress,
      ...(metadata && { metadata }),
    })
    .eq('id', jobId);

  if (error) {
    console.error(`Failed to update job progress for ${jobId}:`, error);
  }
}

/**
 * Complete a job successfully
 */
export async function completeJob(
  jobId: string,
  result: Record<string, any>
): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({
      status: 'completed',
      progress: 100,
      result,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) {
    console.error(`Failed to complete job ${jobId}:`, error);
  }
}

/**
 * Mark a job as failed
 */
export async function failJob(
  jobId: string,
  error: string,
  attempts?: number
): Promise<void> {
  const updates: any = {
    status: 'failed',
    error,
  };

  if (attempts !== undefined) {
    updates.attempts = attempts;
  }

  const { error: dbError } = await supabase
    .from('jobs')
    .update(updates)
    .eq('id', jobId);

  if (dbError) {
    console.error(`Failed to mark job ${jobId} as failed:`, dbError);
  }
}

/**
 * Get job status from queue
 */
export async function getQueueJobStatus(queueName: string, jobId: string): Promise<string | null> {
  const queue = getQueue(queueName);

  try {
    const job = await queue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    return state;
  } catch (error) {
    console.error(`Failed to get job status from ${queueName}:`, error);
    return null;
  }
}

/**
 * Retry a failed job
 */
export async function retryJob(queueName: string, jobId: string): Promise<boolean> {
  const queue = getQueue(queueName);

  try {
    const job = await queue.getJob(jobId);
    if (!job) return false;

    await job.retry();
    return true;
  } catch (error) {
    console.error(`Failed to retry job ${jobId}:`, error);
    return false;
  }
}

/**
 * Get failed jobs count
 */
export async function getFailedJobsCount(queueName: string): Promise<number> {
  const queue = getQueue(queueName);
  return queue.getFailedCount();
}

/**
 * Get waiting jobs count
 */
export async function getWaitingJobsCount(queueName: string): Promise<number> {
  const queue = getQueue(queueName);
  return queue.getWaitingCount();
}

/**
 * Get active jobs
 */
export async function getActiveJobs(queueName: string, start: number = 0, end: number = 99): Promise<Job[]> {
  const queue = getQueue(queueName);
  return queue.getJobs(['active'], start, end);
}

export default {
  getJobFromOmnirouteId,
  updateJobProgress,
  completeJob,
  failJob,
  getQueueJobStatus,
  retryJob,
  getFailedJobsCount,
  getWaitingJobsCount,
  getActiveJobs,
};