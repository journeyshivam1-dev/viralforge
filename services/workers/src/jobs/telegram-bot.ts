/**
 * Telegram operator bot.
 * - TELEGRAM_MODE=polling (default): long-polls getUpdates, so a local machine
 *   never has to expose an inbound webhook.
 * - TELEGRAM_MODE=webhook: the API verifies the secret header and enqueues
 *   updates for telegramUpdateWorker.
 * Only user ids in TELEGRAM_ALLOWED_USER_IDS may act; an empty list denies all.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { DAILY_NICHES, callTelegram, istDate, splitList } from '@viralforge/domain';
import { getQueue, getRedisConnection, QUEUE_NAMES } from '../queues/connection';

const OFFSET_KEY = 'viralforge:telegram:offset';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ORG_EMAIL = 'local@viralforge.dev';

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
}

function botToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
}

function isAuthorized(userId: number | undefined): boolean {
  const allowed = splitList(process.env.TELEGRAM_ALLOWED_USER_IDS);
  return userId !== undefined && allowed.includes(String(userId));
}

export async function telegramPollWorker(_job: Job) {
  const token = botToken();
  if (!token || (process.env.TELEGRAM_MODE || 'polling') !== 'polling') return { success: true, skipped: true };
  const redis = getRedisConnection();
  const offset = Number(await redis.get(OFFSET_KEY) || 0);
  const updates = await callTelegram<TelegramUpdate[]>(token, 'getUpdates', {
    offset: offset || undefined,
    timeout: 20,
    allowed_updates: ['message', 'callback_query'],
  }, 30_000);
  for (const update of updates) {
    // Advance first: a poison update must not block the bot forever.
    await redis.set(OFFSET_KEY, String(update.update_id + 1));
    await handleUpdate(token, update).catch((error) => console.error(`[Telegram] Update ${update.update_id} failed:`, (error as Error).message));
  }
  return { success: true, processed: updates.length };
}

export async function telegramUpdateWorker(job: Job<TelegramUpdate>) {
  const token = botToken();
  if (!token) return { success: true, skipped: true };
  await handleUpdate(token, job.data);
  return { success: true };
}

async function handleUpdate(token: string, update: TelegramUpdate) {
  if (update.callback_query) return handleCallback(token, update.callback_query);
  const message = update.message;
  if (!message?.text) return;
  const chatId = message.chat.id;
  if (!isAuthorized(message.from?.id)) {
    console.warn(`[Telegram] Unauthorized command from user ${message.from?.id ?? 'unknown'}`);
    await reply(token, chatId, 'Not authorised. Ask the admin to add your Telegram user id.');
    return;
  }
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, '');
  const admin = requireSupabaseAdmin();
  const organizationId = await orgId();
  if (!organizationId) return reply(token, chatId, 'No organization yet. Run POST /api/dev/bootstrap first.');

  switch (command) {
    case '/today': {
      const { data } = await admin.from('content_items').select('status, niche_id').eq('organization_id', organizationId).eq('plan_date', istDate());
      const counts = (data || []).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: (acc[row.status] || 0) + 1 }), {});
      const lines = Object.entries(counts).map(([status, count]) => `${status}: ${count}`);
      return reply(token, chatId, `Today (${istDate()}): ${data?.length || 0} planned\n${lines.join('\n') || 'Nothing planned yet — /plan'}`);
    }
    case '/pending': {
      const { data } = await admin.from('pipeline_runs')
        .select('id, content_items(sub_topic, niche_id, media_type, scheduled_at)')
        .eq('organization_id', organizationId).eq('status', 'waiting').eq('waiting_reason', 'approval_required')
        .order('created_at').limit(10);
      if (!data?.length) return reply(token, chatId, 'Nothing is waiting for approval.');
      for (const run of data as any[]) {
        const item = run.content_items;
        await callTelegram(token, 'sendMessage', {
          chat_id: chatId,
          text: `${item?.niche_id} · ${item?.media_type}\n${item?.sub_topic}`,
          reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve:${run.id}` }, { text: '❌ Reject', callback_data: `reject:${run.id}` }]] },
        });
      }
      return;
    }
    case '/retryfailed': {
      const { data, error } = await admin.rpc('retry_failed_pipelines', { p_organization_id: organizationId, p_requested_by: `telegram:${message.from?.id}`, p_limit: 100 });
      if (error) return reply(token, chatId, `Retry failed: ${error.message}`);
      return reply(token, chatId, `Resumed ${data?.retriedCount ?? 0} failed pipeline(s) from their failed stage. Skipped: ${data?.skippedCount ?? 0}.`);
    }
    case '/plan': {
      await getQueue(QUEUE_NAMES.PLANNER).add('plan-day', { organizationId }, { attempts: 1, removeOnComplete: 50, removeOnFail: 100 });
      return reply(token, chatId, 'Planner run queued for today.');
    }
    case '/topic': {
      // /topic <niche> <title...>  -> adds to today's calendar with high priority
      const niche = (args[0] || '').toLowerCase();
      const title = args.slice(1).join(' ').trim().slice(0, 200);
      if (!(DAILY_NICHES as string[]).includes(niche) || title.length < 3) {
        return reply(token, chatId, `Usage: /topic <${DAILY_NICHES.join('|')}> <topic title>`);
      }
      const { error } = await admin.from('topic_backlog').insert({
        organization_id: organizationId, niche_id: niche, title, priority: 5, created_by: `telegram:${message.from?.id}`,
      });
      return reply(token, chatId, error ? `Could not add topic: ${error.message}` : `Added to ${niche} backlog; the next plan will use it.`);
    }
    default:
      return reply(token, chatId, [
        'ViralForge bot',
        '/today — today\'s plan status',
        '/pending — posts waiting for approval',
        '/retryfailed — resume all failed pipelines (failed step only)',
        '/plan — run the planner now',
        `/topic <niche> <title> — add a topic (${DAILY_NICHES.join(', ')})`,
      ].join('\n'));
  }
}

async function handleCallback(token: string, query: NonNullable<TelegramUpdate['callback_query']>) {
  const answer = (text: string) => callTelegram(token, 'answerCallbackQuery', { callback_query_id: query.id, text: text.slice(0, 200) }).catch(() => undefined);
  if (!isAuthorized(query.from.id)) {
    console.warn(`[Telegram] Unauthorized callback from user ${query.from.id}`);
    return answer('Not authorised');
  }
  const [action, runId] = (query.data || '').split(':');
  if (!['approve', 'reject', 'slots_apply', 'slots_dismiss'].includes(action) || !UUID.test(runId || '')) return answer('Unknown action');

  const admin = requireSupabaseAdmin();
  const actor = `telegram:${query.from.id}`;
  if (action === 'slots_apply' || action === 'slots_dismiss') {
    const { data: outcome, error: slotError } = action === 'slots_apply'
      ? await admin.rpc('apply_slot_recommendation', { p_id: runId, p_decided_by: actor })
      : await admin.rpc('dismiss_slot_recommendation', { p_id: runId, p_decided_by: actor });
    if (slotError) return answer(`Could not update: ${slotError.message}`);
    if (action === 'slots_apply' && !outcome?.applied) return answer(String(outcome?.reason || 'Not applied'));
    await answer(action === 'slots_apply' ? 'Applied from the next planned day' : 'Dismissed');
    if (query.message) {
      await callTelegram(token, 'editMessageReplyMarkup', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
      await reply(token, query.message.chat.id, action === 'slots_apply' ? '✅ New slots applied' : '✖ Kept current slots');
    }
    return;
  }
  const { error } = action === 'approve'
    ? await admin.rpc('approve_pipeline_run', { p_run_id: runId, p_approved_by: actor })
    : await admin.rpc('reject_pipeline_run', { p_run_id: runId, p_rejected_by: actor, p_reason: 'Rejected from Telegram' });
  if (error) return answer(`Could not ${action}: ${error.message}`);

  await answer(action === 'approve' ? 'Approved — it will publish at its slot' : 'Rejected');
  if (query.message) {
    // Remove the buttons so the decision cannot be sent twice.
    await callTelegram(token, 'editMessageReplyMarkup', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => undefined);
    await reply(token, query.message.chat.id, action === 'approve' ? '✅ Approved' : '❌ Rejected');
  }
}

async function reply(token: string, chatId: number, text: string) {
  await callTelegram(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
}

async function orgId(): Promise<string | null> {
  const { data } = await requireSupabaseAdmin().from('organizations').select('id').eq('email', DEFAULT_ORG_EMAIL).maybeSingle();
  return data?.id ?? null;
}
