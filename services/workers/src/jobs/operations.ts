/**
 * Operations: daily account health check and the evening digest. Both only
 * enqueue notifications; delivery and retries belong to notificationWorker.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  DAILY_NICHES,
  MediaProviderError,
  MetaGraphClient,
  TokenCryptoError,
  addDays,
  decryptSecret,
  engagementRate,
  istDate,
  istToUtc,
} from '@viralforge/domain';

const DEFAULT_ORG_EMAIL = 'local@viralforge.dev';
const EXPIRY_WARNING_DAYS = 7;

async function defaultOrganizationId(): Promise<string | null> {
  const { data } = await requireSupabaseAdmin().from('organizations').select('id').eq('email', DEFAULT_ORG_EMAIL).maybeSingle();
  return data?.id ?? null;
}

export async function enqueueOperationsAlert(
  organizationId: string,
  eventType: 'planner_failed' | 'account_unhealthy' | 'daily_digest',
  dedupeSuffix: string,
  payload: Record<string, unknown>,
) {
  const { error } = await requireSupabaseAdmin().rpc('enqueue_notification', {
    p_organization_id: organizationId,
    p_content_item_id: null,
    p_run_id: null,
    p_attempt_id: null,
    p_event_type: eventType,
    p_dedupe_suffix: dedupeSuffix,
    p_payload: payload,
  });
  if (error) console.error(`[Operations] Could not enqueue ${eventType}: ${error.message}`);
}

/**
 * Proves each stored token still works with one cheap Graph read. Revoked
 * tokens mark the account expired; expired or soon-expiring accounts alert
 * once per day until reconnected.
 */
export async function accountHealthWorker(_job: Job) {
  const admin = requireSupabaseAdmin();
  const organizationId = await defaultOrganizationId();
  if (!organizationId) return { success: true, skipped: 'no organization' };

  const { data: accounts, error } = await admin.from('connected_accounts')
    .select('id, niche_id, platform, account_id, account_name, status, token_expires_at, encrypted_access_token, metadata')
    .eq('organization_id', organizationId)
    .in('status', ['active', 'expired']);
  if (error) throw new Error(`Failed to load accounts: ${error.message}`);

  const today = istDate();
  const results: Array<Record<string, unknown>> = [];
  for (const account of accounts || []) {
    if (account.metadata?.localDev) continue;
    const label = `${account.platform} "${account.account_name}"`;
    let problem: string | null = account.status === 'expired' ? 'Token is expired or revoked — reconnect it in Connected accounts' : null;

    if (!problem) {
      try {
        await new MetaGraphClient({ accessToken: decryptSecret(account.encrypted_access_token), graphVersion: process.env.META_GRAPH_VERSION, timeoutMs: 20_000 })
          .verifyAccount(account.account_id);
        await admin.from('connected_accounts').update({ last_health_check: new Date().toISOString() }).eq('id', account.id);
      } catch (checkError) {
        const blocked = checkError instanceof TokenCryptoError || (checkError as MediaProviderError).classification === 'blocked';
        if (blocked) {
          await admin.from('connected_accounts').update({ status: 'expired', last_health_check: new Date().toISOString() }).eq('id', account.id);
          problem = `Meta rejected the token (${(checkError as Error).message.slice(0, 200)}) — reconnect it`;
        } else {
          // Transient Graph errors are not the account's fault; tomorrow's check retries.
          results.push({ account: account.id, transient: (checkError as Error).message.slice(0, 200) });
          continue;
        }
      }
    }

    const expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : null;
    if (!problem && expiresAt && expiresAt.getTime() - Date.now() < EXPIRY_WARNING_DAYS * 24 * 60 * 60_000) {
      problem = `Token expires ${expiresAt.toISOString().slice(0, 10)} — reconnect before then`;
    }
    if (problem) {
      await enqueueOperationsAlert(organizationId, 'account_unhealthy', `${account.id}-${today}`, {
        nicheId: account.niche_id,
        lines: [`${label}: ${problem}`],
        dashboardPath: '/accounts',
      });
    }
    results.push({ account: account.id, ok: !problem });
  }
  return { success: true, checked: results.length, results };
}

/** Evening summary: today's plan per niche and yesterday's best post. */
export async function dailyDigestWorker(_job: Job) {
  const admin = requireSupabaseAdmin();
  const organizationId = await defaultOrganizationId();
  if (!organizationId) return { success: true, skipped: 'no organization' };

  const today = istDate();
  const { data: items, error } = await admin.from('content_items')
    .select('niche_id, status, approval_status')
    .eq('organization_id', organizationId)
    .eq('plan_date', today);
  if (error) throw new Error(`Failed to load today's content: ${error.message}`);

  const lines: string[] = [`Date: ${today}`];
  for (const niche of DAILY_NICHES) {
    const rows = (items || []).filter((item) => item.niche_id === niche);
    if (!rows.length) { lines.push(`${niche}: nothing planned`); continue; }
    const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
    const published = count((row) => row.status === 'published');
    const awaiting = count((row) => row.approval_status === 'pending' && row.status !== 'cancelled');
    const failed = count((row) => row.status === 'failed' || row.status === 'blocked');
    const cancelled = count((row) => row.status === 'cancelled');
    const inProgress = rows.length - published - failed - cancelled - awaiting;
    lines.push(`${niche}: ${published}/${rows.length} published · ${awaiting} awaiting approval · ${failed} failed · ${Math.max(0, inProgress)} in progress`);
  }

  const yesterday = addDays(today, -1);
  const { data: insights } = await admin.from('post_insights')
    .select('platform, media_type, niche_id, reach, likes, comments, shares, saves, interactions, views, content_items(sub_topic)')
    .eq('organization_id', organizationId)
    .eq('checkpoint', '24h')
    .eq('status', 'collected')
    .gte('posted_at', istToUtc(yesterday, '00:00').toISOString())
    .lt('posted_at', istToUtc(today, '00:00').toISOString())
    .limit(500);
  const best = (insights || [])
    .map((row: any) => ({ row, rate: engagementRate(row) }))
    .filter((entry) => entry.rate !== null)
    .sort((a, b) => (b.rate as number) - (a.rate as number))[0];
  if (best) {
    const topic = String(best.row.content_items?.sub_topic || '').slice(0, 80);
    lines.push('', `Yesterday's best: ${best.row.niche_id} ${best.row.media_type} on ${best.row.platform} — "${topic}" · reach ${best.row.reach ?? '-'} · engagement ${((best.rate as number) * 100).toFixed(1)}%`);
  }

  await enqueueOperationsAlert(organizationId, 'daily_digest', today, { lines, dashboardPath: '/today' });
  return { success: true, date: today };
}
