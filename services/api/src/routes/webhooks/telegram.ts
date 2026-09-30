/**
 * Telegram Webhook (TELEGRAM_MODE=webhook, for hosted deployments).
 * Telegram does not sign updates; it echoes the secret_token given to
 * setWebhook in the X-Telegram-Bot-Api-Secret-Token header. Requests without
 * the exact secret are rejected, and the endpoint is disabled (fail closed)
 * unless TELEGRAM_WEBHOOK_SECRET is configured. Verified updates are handed to
 * the workers' bot handler, which enforces the user allowlist.
 * Locally the default TELEGRAM_MODE=polling needs no inbound webhook at all.
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getQueue, QUEUE_NAMES } from '../../queues/connection';

const router = Router();

export function verifyTelegramSecret(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(secret);
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

router.post('/telegram', async (req: Request, res: Response) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (process.env.TELEGRAM_MODE !== 'webhook' || !secret) {
    res.status(404).end();
    return;
  }
  if (!verifyTelegramSecret(req.header('x-telegram-bot-api-secret-token'), secret)) {
    console.warn(`[Telegram] Rejected webhook with invalid secret from ${req.ip}`);
    res.status(401).end();
    return;
  }
  const updateId = Number(req.body?.update_id);
  if (!Number.isInteger(updateId)) {
    res.status(400).end();
    return;
  }
  try {
    // jobId dedupes Telegram's redeliveries of the same update.
    await getQueue(QUEUE_NAMES.TELEGRAM).add('telegram-update', req.body, {
      jobId: `telegram-update-${updateId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 200,
      removeOnFail: 200,
    });
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Telegram] Failed to enqueue update:', (error as Error).message);
    // Non-2xx makes Telegram redeliver later.
    res.status(503).end();
  }
});

/**
 * Registers the webhook with a dedicated random secret (never the bot token).
 * Secret: 1-256 chars of A-Z, a-z, 0-9, _ and -.
 */
export async function setWebhook(webhookUrl: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) return false;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ['message', 'callback_query'] }),
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok;
}

export default router;
