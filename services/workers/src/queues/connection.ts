import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
    });

    connection.on('error', (error) => {
      console.error('Redis connection error:', error);
    });

    connection.on('connect', () => {
      console.log('Redis connected');
    });
  }

  return connection;
}

export const QUEUE_NAMES = {
  RESEARCH: 'viralforge-research',
  GENERATION: 'viralforge-generation',
  MEDIA: 'viralforge-media',
  RENDERING: 'viralforge-rendering',
  VALIDATION: 'viralforge-validation',
  PUBLISHING: 'viralforge-publishing',
  RECONCILIATION: 'viralforge-reconciliation',
  SCHEDULER: 'viralforge-scheduler',
} as const;

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  let queue = queues.get(name);

  if (!queue) {
    queue = new Queue(name, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    });

    queues.set(name, queue);
  }

  return queue;
}

export function createWorker(
  name: string,
  processor: any,
  options: Record<string, unknown> = {},
): Worker {
  return new Worker(name, processor, {
    connection: getRedisConnection(),
    ...options,
  });
}
