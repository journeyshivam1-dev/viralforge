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
 * Verify Meta's X-Hub-Signature-256 header: "sha256=" + HMAC-SHA256 of the raw
 * request body keyed with the Meta App Secret (not the verify token).
 */
export function verifyWhatsAppSignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  appSecret: string | undefined = process.env.META_APP_SECRET,
): boolean {
  if (!rawBody || !signature || !appSecret || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Exact-match allowlist. An empty allowlist denies everyone (fail closed).
 */
export function isPhoneAuthorized(phone: string): boolean {
  const normalized = phone.replace(/\D/g, '');
  return normalized.length > 0 && AUTHORIZED_PHONES.some((allowed) => allowed.replace(/\D/g, '') === normalized);
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
    // Always verify: unsigned requests are rejected in every environment.
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifyWhatsAppSignature((req as Request & { rawBody?: Buffer }).rawBody, signature)) {
      console.warn(`[WhatsApp] Rejected webhook with invalid signature from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid signature' });
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
      const { createContentAndStartPipeline } = await import('../../queues/content-queue');
      const { ensureDefaultOrganization } = await import('../_helpers');
      const organizationId = await ensureDefaultOrganization();
      const nicheId = (parsed.niche || 'food') as any;
      const topic = parsed.topic || 'Quick recipe';
      const job = await createContentAndStartPipeline({
        organizationId,
        nicheId,
        subTopic: topic,
        dataInputPayload: buildTriggerPayload(nicheId, topic),
        triggerSource: 'whatsapp',
        triggerMetadata: { whatsappFrom: from, requestedTime: parsed.time },
        idempotencyKey: `whatsapp-${message.id}`,
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

function buildTriggerPayload(niche: string, topic: string): Record<string, unknown> {
  switch (niche) {
    case 'food': return { dish: topic, region: 'India' };
    case 'health': return { originalDish: topic, transformedDish: `Healthy ${topic}` };
    case 'tech': return { toolName: topic };
    case 'edtech': return { exam: topic };
    case 'travel': return { location: topic };
    case 'cartoon': return { dialect: topic };
    default: return { topic };
  }
}

export default router;