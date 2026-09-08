import { Router } from 'express';
import { QUEUE_NAMES, getQueue } from '../queues/connection';
import { retryJob, discardJob } from '../queues/jobs-queue';
import { asyncRoute, sendError } from './_helpers';

const router = Router();
const queueValues = Object.values(QUEUE_NAMES);

router.get('/queues', asyncRoute(async (_req, res) => {
  const queues = await Promise.all(queueValues.map(async (name) => {
    const queue = getQueue(name);
    const [counts, failed, active, waiting, delayed, completed] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      queue.getJobs(['failed'], 0, 9, true),
      queue.getJobs(['active'], 0, 9, true),
      queue.getJobs(['waiting'], 0, 9, true),
      queue.getJobs(['delayed'], 0, 9, true),
      queue.getJobs(['completed'], 0, 9, true),
    ]);

    return {
      name,
      counts,
      jobs: {
        failed: failed.map(serializeJob),
        active: active.map(serializeJob),
        waiting: waiting.map(serializeJob),
        delayed: delayed.map(serializeJob),
        completed: completed.map(serializeJob),
      },
    };
  }));

  res.json({ ok: true, queues });
}));

router.get('/queues/:name/jobs', asyncRoute(async (req, res) => {
  if (!queueValues.includes(req.params.name as typeof queueValues[number])) {
    return sendError(res, 404, 'Unknown queue');
  }
  const queue = getQueue(req.params.name);
  const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'failed', 'completed'], 0, 99, true);
  res.json({ ok: true, jobs: jobs.map(serializeJob) });
}));

router.post('/queues/:name/jobs/:id/retry', asyncRoute(async (req, res) => {
  if (!queueValues.includes(req.params.name as typeof queueValues[number])) {
    return sendError(res, 404, 'Unknown queue');
  }
  const retried = await retryJob(req.params.name, req.params.id);
  if (!retried) return sendError(res, 404, 'Job not found or could not be retried');
  res.json({ ok: true, retried: true });
}));

router.delete('/queues/:name/jobs/:id', asyncRoute(async (req, res) => {
  if (!queueValues.includes(req.params.name as typeof queueValues[number])) {
    return sendError(res, 404, 'Unknown queue');
  }
  const discarded = await discardJob(req.params.name, req.params.id);
  if (!discarded) return sendError(res, 404, 'Job not found or could not be discarded');
  res.json({ ok: true, discarded: true });
}));

function serializeJob(job: any) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    progress: job.progress,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
  };
}

export default router;
