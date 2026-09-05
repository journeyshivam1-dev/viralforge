/**
 * Telegram Webhook Handler
 * Handles incoming updates from Telegram Bot with signature verification and allowlist
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';

const router = Router();

// Environment configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const AUTHORIZED_USERS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').filter(Boolean);

/**
 * Verify Telegram webhook signature
 * Telegram signs all updates using HMAC-SHA256
 */
export function verifyTelegramSignature(body: any, signature: string | undefined): boolean {
  if (!signature || !TELEGRAM_BOT_TOKEN) return false;

  const secretKey = crypto
    .createHash('sha256')
    .update(TELEGRAM_BOT_TOKEN)
    .digest();

  const dataCheckString = JSON.stringify(body);
  const expectedSignature = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Check if user is authorized to trigger content
 */
export function isUserAuthorized(userId: number | string): boolean {
  // If no allowlist configured, allow all (development mode)
  if (AUTHORIZED_USERS.length === 0) return true;

  return AUTHORIZED_USERS.includes(String(userId));
}

/**
 * Parse Telegram command from message
 * Format: /generate [niche] [topic] [time]
 * Example: /generate food dal tadka 6pm
 */
export function parseTelegramCommand(text: string): {
  command: string;
  niche?: string;
  topic?: string;
  time?: string;
} | null {
  const parts = text.trim().split(/\s+/);
  const command = parts[0].replace('/', '');

  if (['generate', 'create', 'post'].includes(command.toLowerCase())) {
    return {
      command,
      niche: parts[1] || undefined,
      topic: parts.slice(2, -1).join(' ') || undefined,
      time: parts[parts.length - 1] || undefined
    };
  }

  return { command };
}

/**
 * Telegram webhook endpoint
 */
router.post('/telegram', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-telegram-signature'] as string;

    // Verify signature in production
    if (process.env.NODE_ENV === 'production') {
      if (!verifyTelegramSignature(req.body, signature)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'No message in update' });
    }

    const chatId = message.chat?.id;
    const userId = message.from?.id;
    const text = message.text || '';

    // Check authorization
    if (!isUserAuthorized(userId)) {
      return res.json({
        method: 'sendMessage',
        chat_id: chatId,
        text: '⛔ आप authorised नहीं हैं। कृपया admin से संपर्क करें।'
      });
    }

    // Parse command
    const parsed = parseTelegramCommand(text);

    if (!parsed) {
      return res.json({
        method: 'sendMessage',
        chat_id: chatId,
        text: '❓ समझ नहीं आया। कृपया valid command भेजें।\n\nउदाहरण:\n/generate food dal tadka 6pm'
      });
    }

    switch (parsed.command.toLowerCase()) {
      case 'generate':
      case 'create':
      case 'post':
        // Queue content generation job
        const { queueContentGeneration } = await import('../../queues/content-queue');

        const job = await queueContentGeneration({
          nicheId: parsed.niche as any,
          subTopic: parsed.topic || 'Quick recipe',
          triggerSource: 'telegram',
          triggerMetadata: {
            telegramChatId: chatId,
            telegramUserId: userId,
            requestedTime: parsed.time
          }
        });

        return res.json({
          method: 'sendMessage',
          chat_id: chatId,
          text: `✅ Content generate हो रहा है!\n\nJob ID: ${job.id}\nNiche: ${parsed.niche || 'food'}\nTopic: ${parsed.topic || 'Quick recipe'}\n\n⚠️ Admin approval के बाद publish होगा।`
        });

      case 'status':
        return res.json({
          method: 'sendMessage',
          chat_id: chatId,
          text: '🔄 System operational। All services healthy।'
        });

      case 'pause':
        return res.json({
          method: 'sendMessage',
          chat_id: chatId,
          text: '⏸️ Publishing paused। /resume to continue।'
        });

      case 'resume':
        return res.json({
          method: 'sendMessage',
          chat_id: chatId,
          text: '▶️ Publishing resumed। /pause to pause।'
        });

      default:
        return res.json({
          method: 'sendMessage',
          chat_id: chatId,
          text: '❓ Unknown command।\n\nAvailable:\n/generate [niche] [topic] - Create content\n/status - Check system status\n/pause - Pause publishing\n/resume - Resume publishing'
        });
    }
  } catch (error) {
    console.error('Telegram webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Set Telegram webhook URL
 * Call this during bot setup
 */
export async function setWebhook(webhookUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: TELEGRAM_BOT_TOKEN
      })
    });

    return response.ok;
  } catch (error) {
    console.error('Failed to set Telegram webhook:', error);
    return false;
  }
}

export default router;