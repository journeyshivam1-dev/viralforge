/**
 * ViralForge Worker Service
 * BullMQ workers for parallel content processing
 */

import { Job } from 'bullmq';
import { createWorker, QUEUE_NAMES } from './queues/connection';
import { researchWorker } from './jobs/research';
import { generationWorker } from './jobs/generation';
import { mediaWorker } from './jobs/media';
import { renderingWorker } from './jobs/rendering';
import { validationWorker } from './jobs/validation';
import { publishingWorker } from './jobs/publishing';
import { schedulerWorker } from './jobs/scheduler';
import { outboxDispatcherWorker, reconciliationWorker } from './jobs/outbox-dispatcher';
import { notificationWorker } from './jobs/notifications';
import { plannerWorker } from './jobs/planner';
import { telegramPollWorker, telegramUpdateWorker } from './jobs/telegram-bot';
import { insightsCollectorWorker } from './jobs/insights';
import { slotTuningWorker } from './jobs/slot-tuning';
import { accountHealthWorker, dailyDigestWorker } from './jobs/operations';
import { withPipelineRuntime } from './pipeline/runtime';

const workers = [
  // Research worker - collects and validates input data
  createWorker(QUEUE_NAMES.RESEARCH, withPipelineRuntime('research', researchWorker), {
    concurrency: 5,
  }),

  // Generation worker - creates scripts, captions, hooks
  createWorker(QUEUE_NAMES.GENERATION, withPipelineRuntime('generation', generationWorker), {
    concurrency: 3,
  }),

  // Media worker - handles image/video generation via Omniroute
  createWorker(QUEUE_NAMES.MEDIA, withPipelineRuntime('media', mediaWorker), {
    concurrency: 2,
  }),

  // Rendering worker - composes final video with FFmpeg
  createWorker(QUEUE_NAMES.RENDERING, withPipelineRuntime('rendering', renderingWorker), {
    concurrency: 4,
  }),

  // Validation worker - checks content before publishing
  createWorker(QUEUE_NAMES.VALIDATION, withPipelineRuntime('validation', validationWorker), {
    concurrency: 2,
  }),

  // Publishing worker - publishes to Meta APIs
  createWorker(QUEUE_NAMES.PUBLISHING, withPipelineRuntime('publishing', publishingWorker), {
    concurrency: 1, // Sequential to respect rate limits
  }),

  // Scheduler worker - cron-like job for scheduled items
  createWorker(QUEUE_NAMES.SCHEDULER, schedulerWorker, {
    concurrency: 1,
  }),

  // Transactional outbox dispatcher and state reconciler.
  createWorker(QUEUE_NAMES.RECONCILIATION, async (job: Job) => {
    if (job.name === 'pipeline-reconcile') return reconciliationWorker(job);
    return outboxDispatcherWorker(job);
  }, { concurrency: 1 }),

  // Daily planner: topics + slots for every enabled niche.
  createWorker(QUEUE_NAMES.PLANNER, plannerWorker, { concurrency: 1, lockDuration: 10 * 60_000 }),

  // Telegram operator bot: long-poll (local) or webhook-enqueued updates (hosted).
  createWorker(QUEUE_NAMES.TELEGRAM, async (job: Job) => (
    job.name === 'telegram-update' ? telegramUpdateWorker(job) : telegramPollWorker(job)
  ), { concurrency: 1 }),

  // Operator alerts (Telegram / WhatsApp) from notification_outbox.
  createWorker(QUEUE_NAMES.NOTIFICATIONS, notificationWorker, { concurrency: 1 }),

  // Post insights, weekly slot tuning, account health and the daily digest.
  createWorker(QUEUE_NAMES.ANALYTICS, async (job: Job) => {
    switch (job.name) {
      case 'collect-insights': return insightsCollectorWorker(job);
      case 'tune-slots': return slotTuningWorker(job);
      case 'account-health': return accountHealthWorker(job);
      case 'daily-digest': return dailyDigestWorker(job);
      default: throw new Error(`Unknown analytics job ${job.name}`);
    }
  }, { concurrency: 1, lockDuration: 5 * 60_000 }),
];

async function ensureMaintenanceJobs() {
  const { getQueue } = await import('./queues/connection');
  const reconciliation = getQueue(QUEUE_NAMES.RECONCILIATION);
  const scheduler = getQueue(QUEUE_NAMES.SCHEDULER);
  const notifications = getQueue(QUEUE_NAMES.NOTIFICATIONS);
  const planner = getQueue(QUEUE_NAMES.PLANNER);
  const telegram = getQueue(QUEUE_NAMES.TELEGRAM);
  const analytics = getQueue(QUEUE_NAMES.ANALYTICS);
  await reconciliation.upsertJobScheduler('outbox-dispatcher', { every: 5_000 }, {
    name: 'outbox-dispatch', data: {}, opts: { removeOnComplete: 20, removeOnFail: 100 },
  });
  await reconciliation.upsertJobScheduler('pipeline-reconciler', { every: 60_000 }, {
    name: 'pipeline-reconcile', data: {}, opts: { removeOnComplete: 20, removeOnFail: 100 },
  });
  await scheduler.upsertJobScheduler('content-scheduler', { every: 60_000 }, {
    name: 'schedule-content', data: {}, opts: { removeOnComplete: 20, removeOnFail: 100 },
  });
  // Main run just after midnight IST; the 30-minute tick catches up if the
  // machine was off, and plans tomorrow after 20:00 IST. Both are idempotent.
  await planner.upsertJobScheduler('daily-planner', { pattern: '30 0 * * *', tz: 'Asia/Kolkata' }, {
    name: 'plan-day', data: {}, opts: { attempts: 4, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 50, removeOnFail: 100 },
  });
  await planner.upsertJobScheduler('planner-catch-up', { every: 30 * 60_000 }, {
    name: 'plan-day', data: {}, opts: { attempts: 1, removeOnComplete: 50, removeOnFail: 100 },
  });
  if ((process.env.TELEGRAM_MODE || 'polling') === 'polling' && process.env.TELEGRAM_BOT_TOKEN) {
    // Each poll long-waits up to 20s, so a 2s cadence gives near-instant replies.
    await telegram.upsertJobScheduler('telegram-poller', { every: 2_000 }, {
      name: 'telegram-poll', data: {}, opts: { removeOnComplete: 10, removeOnFail: 50 },
    });
  }
  const analyticsOpts = { attempts: 1, removeOnComplete: 20, removeOnFail: 100 };
  await analytics.upsertJobScheduler('insights-collector', { every: 15 * 60_000 }, { name: 'collect-insights', data: {}, opts: analyticsOpts });
  await analytics.upsertJobScheduler('slot-tuning', { pattern: '0 3 * * 1', tz: 'Asia/Kolkata' }, { name: 'tune-slots', data: {}, opts: analyticsOpts });
  await analytics.upsertJobScheduler('account-health', { pattern: '0 8 * * *', tz: 'Asia/Kolkata' }, { name: 'account-health', data: {}, opts: analyticsOpts });
  await analytics.upsertJobScheduler('daily-digest', { pattern: '30 22 * * *', tz: 'Asia/Kolkata' }, { name: 'daily-digest', data: {}, opts: analyticsOpts });
  await notifications.upsertJobScheduler('notification-dispatcher', { every: 10_000 }, {
    name: 'dispatch-notifications', data: {}, opts: { removeOnComplete: 20, removeOnFail: 100 },
  });
}

ensureMaintenanceJobs().catch((error) => {
  console.error('Failed to register maintenance schedulers:', error);
  process.exitCode = 1;
});

// Set up event handlers
workers.forEach((worker) => {
  worker.on('completed', (job) => {
    console.log(`Worker ${worker.name}: Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Worker ${worker.name}: Job ${job?.id} failed:`, err.message);
  });

  worker.on('stalled', (jobId) => {
    console.warn(`Worker ${worker.name}: Job ${jobId} stalled`);
  });

  worker.on('progress', (job, progress) => {
    console.log(`Worker ${worker.name}: Job ${job.id} progress: ${progress}%`);
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});

console.log('ViralForge workers started');
console.log(`Queues: ${QUEUE_NAMES.RESEARCH}, ${QUEUE_NAMES.GENERATION}, ${QUEUE_NAMES.MEDIA}, ${QUEUE_NAMES.RENDERING}, ${QUEUE_NAMES.VALIDATION}, ${QUEUE_NAMES.PUBLISHING}, ${QUEUE_NAMES.SCHEDULER}`);