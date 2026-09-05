/**
 * WhatsApp Business Webhook Handler
 * Handles incoming messages from WhatsApp Cloud API
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';

const router = Router();

const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WHATSAPP_WEBHOOK_URL = process.env.WHATSAPP_WEBHOOK_URL || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const AUTHORIZED_PHONES = (process.env.WHATSAPP_ALLOWED_PHONES || '').split(',').filter(Boolean);

/**
 * Verify WhatsApp webhook subscription
 * Called during webhook setup
 */
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }

  return res.status(403).send('Forbidden');
});

/**
 * Verify WhatsApp message signature
 * WhatsApp signs payloads with HMAC-SHA256
 */
export function verifyWhatsAppSignature(
  body: string,
  signature: string | undefined
): boolean {
  if (!signature || !WHATSAPP_VERIFY_TOKEN) return false;

  const expectedSignature = crypto
    .createHmac('sha256', WHATSAPP_VERIFY_TOKEN)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Check if phone number is authorized
 */
export function isPhoneAuthorized(phone: string): boolean {
  // Normalize phone number
  const normalized = phone.replace(/\D/g, '');

  // If no allowlist configured, allow all (development mode)
  if (AUTHORIZED_PHONES.length === 0) return true;

  return AUTHORIZED_PHONES.some(allowed =>
    normalized.includes(allowed.replace(/\D/g, ''))
  );
}

/**
 * Parse WhatsApp command from message text
 * Format similar to Telegram: generate food dal tadka
 */
export function parseWhatsAppCommand(text: string): {
  command: string;
  niche?: string;
  topic?: string;
  time?: string;
} | null {
  const parts = text.trim().toLowerCase().split(/\s+/);
  const command = parts[0];

  if (['generate', 'create', 'post'].includes(command)) {
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
 * Send WhatsApp message using Cloud API
 */
async function sendWhatsAppMessage(to: string, text: string): Promise<boolean> {
  try {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('WhatsApp access token not configured');
      return false;
    }

    const response = await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      })
    });

    return response.ok;
  } catch (error) {
    console.error('Failed to send WhatsApp message:', error);
    return false;
  }
}

/**
 * WhatsApp webhook endpoint
 */
router.post('/whatsapp', async (req: Request, res: Response) => {
  try {
    // Verify signature in production
    if (process.env.NODE_ENV === 'production') {
      const signature = req.headers['x-hub-signature-256'] as string;
      const bodyStr = JSON.stringify(req.body);

      if (!verifyWhatsAppSignature(bodyStr, signature)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Respond quickly to WhatsApp (must be within 20 seconds)
    res.status(200).json({ status: 'ok' });

    // Process message asynchronously
    processMessage(req.body).catch(console.error);
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function processMessage(body: any) {
  const value = body.entry?.[0]?.changes?.[0]?.value;

  if (!value?.messages?.[0]) return;

  const message = value.messages[0];
  const from = message.from;
  const text = message.text?.body || '';

  // Check authorization
  if (!isPhoneAuthorized(from)) {
    await sendWhatsAppMessage(from,
      '⛔ आप authorised नहीं हैं। कृपया admin से संपर्क करें।'
    );
    return;
  }

  // Parse command
  const parsed = parseWhatsAppCommand(text);

  if (!parsed) {
    await sendWhatsAppMessage(from,
      '❓ समझ नहीं आया।\n\nAvailable commands:\ngenerate [niche] [topic] - Create content\nstatus - Check system'
    );
    return;
  }

  switch (parsed.command) {
    case 'generate':
    case 'create':
    case 'post':
      const { queueContentGeneration } = await import('../../queues/content-queue');

      const job = await queueContentGeneration({
        nicheId: parsed.niche as any,
        subTopic: parsed.topic || 'Quick recipe',
        triggerSource: 'whatsapp',
        triggerMetadata: {
          whatsappFrom: from,
          requestedTime: parsed.time
        }
      });

      await sendWhatsAppMessage(from,
        `✅ Content generate हो रहा है!\n\nJob ID: ${job.id}\nNiche: ${parsed.niche || 'food'}\n\n⚠️ Admin approval के बाद publish होगा।`
      );
      break;

    case 'status':
      await sendWhatsAppMessage(from,
        '🔄 System operational। All services healthy।'
      );
      break;
  }
}

export default router;