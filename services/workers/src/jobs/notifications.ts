/**
 * Notification dispatcher. Drains notification_outbox (filled by DB triggers on
 * permanent failures, blocks and approval requests) to Telegram and WhatsApp.
 * Approval requests go to Telegram with a media preview and one-tap
 * Approve / Reject buttons. Unconfigured channels are marked skipped.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  NotificationError,
  formatNotificationText,
  sendTelegramMedia,
  sendTelegramMessage,
  sendWhatsAppMessage,
  storagePathFromUrl,
  telegramConfigFromEnv,
  whatsAppConfigFromEnv,
  type NotificationPayload,
  type NotificationResult,
  type TelegramInlineButton,
} from '@viralforge/domain';

const MAX_PREVIEW_BYTES = 45 * 1024 * 1024; // Telegram bot uploads are capped at 50MB.

export async function notificationWorker(_job: Job) {
  const admin = requireSupabaseAdmin();
  const { data: claimed, error } = await admin.rpc('claim_notification_outbox', { p_limit: 20 });
  if (error) throw new Error(`Failed to claim notifications: ${error.message}`);

  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3001';
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of claimed || []) {
    const payload = row.payload as NotificationPayload;
    const text = formatNotificationText(row.event_type, payload, row.content_item_id, dashboardUrl);
    try {
      const result = row.channel === 'telegram'
        ? await sendTelegram(row.event_type, payload, row.content_item_id, text)
        : await sendWhatsAppMessage(whatsAppConfigFromEnv(), text);
      await admin.rpc('complete_notification', { p_id: row.id, p_status: result.status, p_error: result.detail ?? null });
      if (result.status === 'sent') sent += 1; else skipped += 1;
    } catch (sendError) {
      failed += 1;
      const message = sendError instanceof Error ? sendError.message : String(sendError);
      const retryable = sendError instanceof NotificationError ? sendError.retryable : true;
      // Permanent API rejections (bad chat id, template not approved) are not retried.
      await admin.rpc('complete_notification', { p_id: row.id, p_status: retryable ? 'retry' : 'failed', p_error: message });
      console.error(`[Notifications] ${row.channel} ${row.event_type} failed: ${message}`);
    }
  }

  return { success: true, claimed: claimed?.length || 0, sent, skipped, failed };
}

async function sendTelegram(eventType: string, payload: NotificationPayload, contentItemId: string | null, text: string): Promise<NotificationResult> {
  const config = telegramConfigFromEnv();
  if (eventType !== 'approval_requested' || !payload.runId || !contentItemId) {
    return sendTelegramMessage(config, text);
  }
  const buttons: TelegramInlineButton[][] = [[
    { text: '✅ Approve', callbackData: `approve:${payload.runId}` },
    { text: '❌ Reject', callbackData: `reject:${payload.runId}` },
  ]];
  const preview = await loadPreview(contentItemId);
  if (!preview) return sendTelegramMessage(config, text, buttons);
  return sendTelegramMedia(config, preview.kind, preview, text, buttons);
}

async function loadPreview(contentItemId: string): Promise<{ kind: 'photo' | 'video'; buffer: Buffer; fileName: string; mimeType: string } | null> {
  const admin = requireSupabaseAdmin();
  const { data: item } = await admin.from('content_items').select('media_type, rendering_manifest').eq('id', contentItemId).maybeSingle();
  const url = item?.rendering_manifest?.output?.url;
  if (typeof url !== 'string') return null;
  const storagePath = storagePathFromUrl(url);
  const { data, error } = await admin.storage.from('viralforge-content').download(storagePath);
  if (error || !data) return null;
  const buffer = Buffer.from(await data.arrayBuffer());
  if (buffer.length > MAX_PREVIEW_BYTES) return null;
  const isVideo = item?.media_type === 'video_reel';
  return {
    kind: isVideo ? 'video' : 'photo',
    buffer,
    fileName: storagePath.split('/').pop() || (isVideo ? 'reel.mp4' : 'post.jpg'),
    mimeType: isVideo ? 'video/mp4' : 'image/jpeg',
  };
}
