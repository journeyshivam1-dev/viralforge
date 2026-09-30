/**
 * Operator notification channels (Telegram Bot API, WhatsApp Cloud API).
 * Messages are sent as plain text (no parse_mode) so generated content can
 * never be interpreted as markup. Tokens are never included in errors.
 */

export type NotificationChannel = 'telegram' | 'whatsapp';

export interface NotificationResult {
  status: 'sent' | 'skipped';
  detail?: string;
}

export class NotificationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'NotificationError';
    this.retryable = retryable;
  }
}

export interface TelegramConfig {
  botToken?: string;
  chatIds: string[];
  timeoutMs?: number;
}

export interface WhatsAppConfig {
  accessToken?: string;
  phoneNumberId?: string;
  recipients: string[];
  graphVersion?: string;
  /** Approved template name. Required outside the 24h customer-service window. */
  templateName?: string;
  templateLanguage?: string;
  timeoutMs?: number;
}

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

function classifyHttp(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  buttons: TelegramInlineButton[][] = [],
): Promise<NotificationResult> {
  if (!config.botToken || config.chatIds.length === 0) {
    return { status: 'skipped', detail: 'Telegram is not configured' };
  }
  for (const chatId of config.chatIds) {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        ...(buttons.length > 0
          ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))) } }
          : {}),
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { description?: string };
      throw new NotificationError(
        `Telegram sendMessage failed (${response.status}): ${payload.description || response.statusText}`,
        classifyHttp(response.status),
      );
    }
  }
  return { status: 'sent' };
}

/** Sends a photo or video (as an upload, so no public URL is needed) with caption and buttons. */
export async function sendTelegramMedia(
  config: TelegramConfig,
  kind: 'photo' | 'video',
  file: { buffer: Buffer; fileName: string; mimeType: string },
  caption: string,
  buttons: TelegramInlineButton[][] = [],
): Promise<NotificationResult> {
  if (!config.botToken || config.chatIds.length === 0) {
    return { status: 'skipped', detail: 'Telegram is not configured' };
  }
  for (const chatId of config.chatIds) {
    const form = new FormData();
    form.set('chat_id', chatId);
    // Telegram media captions are limited to 1024 characters.
    form.set('caption', caption.slice(0, 1024));
    if (kind === 'video') form.set('supports_streaming', 'true');
    if (buttons.length > 0) {
      form.set('reply_markup', JSON.stringify({ inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))) }));
    }
    form.set(kind, new Blob([file.buffer], { type: file.mimeType }), file.fileName);
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${kind === 'photo' ? 'sendPhoto' : 'sendVideo'}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { description?: string };
      throw new NotificationError(
        `Telegram ${kind} upload failed (${response.status}): ${payload.description || response.statusText}`,
        classifyHttp(response.status),
      );
    }
  }
  return { status: 'sent' };
}

/** Calls any Bot API method with a JSON body (answerCallbackQuery, editMessageReplyMarkup, ...). */
export async function callTelegram<T = unknown>(botToken: string, method: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || !payload.ok) {
    throw new NotificationError(`Telegram ${method} failed (${response.status}): ${payload.description || response.statusText}`, classifyHttp(response.status));
  }
  return payload.result as T;
}

export async function sendWhatsAppMessage(config: WhatsAppConfig, text: string): Promise<NotificationResult> {
  if (!config.accessToken || !config.phoneNumberId || config.recipients.length === 0) {
    return { status: 'skipped', detail: 'WhatsApp is not configured' };
  }
  const version = config.graphVersion || 'v23.0';
  for (const to of config.recipients) {
    const body = config.templateName
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: config.templateName,
            language: { code: config.templateLanguage || 'en' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 1000) }] }],
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4000), preview_url: false } };

    const response = await fetch(`https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new NotificationError(
        `WhatsApp send failed (${response.status}): ${payload.error?.message || response.statusText}`,
        classifyHttp(response.status),
      );
    }
  }
  return { status: 'sent' };
}

export function splitList(value: string | undefined): string[] {
  return (value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  return { botToken: env.TELEGRAM_BOT_TOKEN?.trim(), chatIds: splitList(env.TELEGRAM_ALERT_CHAT_IDS) };
}

export function whatsAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig {
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN?.trim(),
    phoneNumberId: env.WHATSAPP_PHONE_ID?.trim(),
    recipients: splitList(env.WHATSAPP_ALERT_TO),
    graphVersion: env.META_GRAPH_VERSION?.trim(),
    templateName: env.WHATSAPP_ALERT_TEMPLATE?.trim() || undefined,
    templateLanguage: env.WHATSAPP_ALERT_TEMPLATE_LANGUAGE?.trim() || undefined,
  };
}

export interface NotificationPayload {
  stage?: string;
  attemptNo?: number;
  nicheId?: string;
  subTopic?: string;
  mediaType?: string;
  scheduledAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  runId?: string;
  hook?: string;
  caption?: string;
}

const EVENT_TITLES: Record<string, string> = {
  stage_permanent_failed: 'Pipeline stage failed permanently',
  stage_blocked: 'Pipeline blocked — needs attention',
  approval_requested: 'Content ready for approval',
  published: 'Content published',
};

export function formatNotificationText(
  eventType: string,
  payload: NotificationPayload,
  contentItemId: string | null,
  dashboardUrl?: string,
): string {
  const slot = payload.scheduledAt
    ? new Date(payload.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'
    : 'unscheduled';
  const lines = [
    `ViralForge: ${EVENT_TITLES[eventType] || eventType}`,
    `Niche: ${payload.nicheId || '-'} · ${payload.mediaType || '-'}`,
    `Topic: ${payload.subTopic || '-'}`,
    `Slot: ${slot}`,
  ];
  if (payload.hook) lines.push('', `Hook: ${payload.hook}`);
  if (payload.caption) lines.push(`Caption: ${payload.caption}`);
  if (payload.stage) lines.push(`Stage: ${payload.stage}${payload.attemptNo ? ` (attempt ${payload.attemptNo})` : ''}`);
  if (payload.errorMessage) lines.push(`Error: ${payload.errorCode ? `[${payload.errorCode}] ` : ''}${payload.errorMessage}`);
  if (dashboardUrl && contentItemId) lines.push(`Open: ${dashboardUrl.replace(/\/$/, '')}/content/${contentItemId}`);
  return lines.join('\n');
}
