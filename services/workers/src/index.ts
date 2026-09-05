/**
 * ViralForge Worker Service
 * BullMQ workers for parallel content processing
 */

import { createWorker } from '../queues/connection';
import { QUEUE_NAMES } from '../queues/connection';
import { researchWorker } from './jobs/research';
import { generationWorker } from './jobs/generation';
import { mediaWorker } from './jobs/media';
import { renderingWorker } from './jobs/rendering';
import { validationWorker } from './jobs/validation';
import { publishingWorker } from './jobs/publishing';
import { schedulerWorker } from './jobs/scheduler';

const workers = [
  // Research worker - collects and validates input data
  createWorker(QUEUE_NAMES.RESEARCH, researchWorker, {
    concurrency: 5,
  }),

  // Generation worker - creates scripts, captions, hooks
  createWorker(QUEUE_NAMES.GENERATION, generationWorker, {
    concurrency: 3,
  }),

  // Media worker - handles image/video generation via Omniroute
  createWorker(QUEUE_NAMES.MEDIA, mediaWorker, {
    concurrency: 2,
  }),

  // Rendering worker - composes final video with FFmpeg
  createWorker(QUEUE_NAMES.RENDERING, renderingWorker, {
    concurrency: 4,
  }),

  // Validation worker - checks content before publishing
  createWorker(QUEUE_NAMES.VALIDATION, validationWorker, {
    concurrency: 2,
  }),

  // Publishing worker - publishes to Meta APIs
  createWorker(QUEUE_NAMES.PUBLISHING, publishingWorker, {
    concurrency: 1, // Sequential to respect rate limits
  }),

  // Scheduler worker - cron-like job for scheduled items
  createWorker(QUEUE_NAMES.SCHEDULER, schedulerWorker, {
    concurrency: 1,
  }),
];

// Set up event handlers
workers.forEach((worker) => {
  worker.on('completed', (job) => {
    console.log(`Worker ${worker.name}: Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Worker ${worker.name}: Job ${job?.id} failed:`, err.message);
  });

  worker.on('stalled', (job) => {
    console.warn(`Worker ${worker.name}: Job ${job?.id} stalled`);
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