/**
 * Omniroute Webhook Handler
 * Receives generation completion callbacks from local Omniroute instance
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';

const router = Router();

const OMNIROUTE_WEBHOOK_SECRET = process.env.OMNIROUTE_WEBHOOK_SECRET || '';

/**
 * Verify Omniroute webhook signature
 */
export function verifyOmnirouteSignature(
  body: any,
  signature: string | undefined,
  timestamp: string | undefined
): boolean {
  if (!signature || !timestamp || !OMNIROUTE_WEBHOOK_SECRET) return false;

  // Check timestamp to prevent replay attacks (5 minute window)
  const requestTime = parseInt(timestamp, 10);
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - requestTime) > 300) {
    console.warn('Omniroute webhook timestamp expired');
    return false;
  }

  const payload = `${timestamp}.${JSON.stringify(body)}`;
  const expectedSignature = crypto
    .createHmac('sha256', OMNIROUTE_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

interface OmnirouteWebhookPayload {
  jobId: string;
  status: 'completed' | 'failed' | 'processing';
  result?: {
    text?: string;
    imageUrl?: string;
    videoUrl?: string;
    audioUrl?: string;
    metadata?: Record<string, any>;
  };
  error?: string;
  processingTimeMs?: number;
}

/**
 * Omniroute webhook endpoint
 * Receives async generation results
 */
router.post('/omniroute', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;

    // Verify signature
    if (!verifyOmnirouteSignature(req.body, signature, timestamp)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body as OmnirouteWebhookPayload;

    console.log(`Omniroute webhook received:`, {
      jobId: payload.jobId,
      status: payload.status
    });

    // Import job queue to update status
    const { getJobFromOmnirouteId } = await import('../../queues/jobs-queue');
    const job = await getJobFromOmnirouteId(payload.jobId);

    if (!job) {
      console.warn(`Job not found for Omniroute ID: ${payload.jobId}`);
      return res.status(404).json({ error: 'Job not found' });
    }

    // Update job based on status
    const { updateJobProgress, completeJob, failJob } = await import('../../queues/jobs-queue');

    switch (payload.status) {
      case 'completed':
        await completeJob(job.id, {
          result: payload.result,
          processingTimeMs: payload.processingTimeMs
        });

        // If this was a generation job, trigger next step
        if (job.type === 'generation') {
          const { queueRendering } = await import('../../queues/content-queue');
          await queueRendering(job.contentItemId);
        } else if (job.type === 'media') {
          const { queueValidation } = await import('../../queues/content-queue');
          await queueValidation(job.contentItemId);
        }
        break;

      case 'failed':
        await failJob(job.id, payload.error || 'Unknown error');

        // Update content item status
        const { updateContentItemStatus } = await import('../../services/content-service');
        await updateContentItemStatus(job.contentItemId, 'failed', {
          error: payload.error
        });
        break;

      case 'processing':
        await updateJobProgress(job.id, 50, { status: 'processing' });
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Omniroute webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;