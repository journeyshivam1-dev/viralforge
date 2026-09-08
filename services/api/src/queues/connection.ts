/**
 * BullMQ Queue Connection Setup
 * Centralized Redis connection for all queues
 */

import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Singleton connection for workers
let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
    });

    connection.on('error', (err) => {
      console.error('Redis connection error:', err);
    });

    connection.on('connect', () => {
      console.log('Redis connected');
    });
  }

  return connection;
}

// Queue names
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

// Queue instances (singleton per name)
const queueInstances: Map<string, Queue> = new Map();

export function getQueue(name: string): Queue {
  if (!queueInstances.has(name)) {
    queueInstances.set(
      name,
      new Queue(name, {
        connection: getRedisConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: 100, // Keep last 100 completed
          removeOnFail: 1000, // Keep last 1000 failed
        },
      })
    );
  }

  return queueInstances.get(name)!;
}

// Create worker instance
export function createWorker(
  name: string,
  processor: any,
  options?: Partial<Worker>
): Worker {
  return new Worker(name, processor, {
    connection: getRedisConnection(),
    ...options,
  });
}

// Graceful shutdown
export async function closeAllQueues(): Promise<void> {
  const closePromises = Array.from(queueInstances.values()).map((q) => q.close());
  await Promise.all(closePromises);
  queueInstances.clear();

  if (connection) {
    await connection.quit();
    connection = null;
  }
}

export default { getQueue, createWorker, getRedisConnection, closeAllQueues, QUEUE_NAMES };