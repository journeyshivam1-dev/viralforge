/**
 * Post insights collector. For every published publication it reads counts at
 * 1h / 24h / 72h / 7d after the post went live and stores one post_insights
 * row per checkpoint. Only aggregate counts are stored, never viewer data.
 * A revoked token marks the account expired, same as publishing.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  EMPTY_METRICS,
  MediaProviderError,
  MetaGraphClient,
  TokenCryptoError,
  decryptSecret,
  minuteOfDayIst,
  type PostMetrics,
} from '@viralforge/domain';

interface DueCheckpoint {
  publication_attempt_id: string;
  organization_id: string;
  content_item_id: string;
  connected_account_id: string | null;
  niche_id: string;
  platform: 'instagram' | 'facebook';
  media_type: string;
  remote_post_id: string;
  posted_at: string;
  checkpoint: string;
  attempts: number;
}

const BATCH_SIZE = 25;

export async function insightsCollectorWorker(_job: Job) {
  const admin = requireSupabaseAdmin();
  const { data: due, error } = await admin.rpc('due_insight_checkpoints', { p_now: new Date().toISOString(), p_limit: BATCH_SIZE });
  if (error) throw new Error(`Failed to load due insight checkpoints: ${error.message}`);
  if (!due?.length) return { success: true, collected: 0 };

  const accountIds = [...new Set((due as DueCheckpoint[]).map((row) => row.connected_account_id).filter(Boolean))] as string[];
  const { data: accounts, error: accountError } = await admin
    .from('connected_accounts')
    .select('id, status, encrypted_access_token')
    .in('id', accountIds);
  if (accountError) throw new Error(`Failed to load accounts: ${accountError.message}`);
  const accountById = new Map((accounts || []).map((account) => [account.id, account]));
  const clients = new Map<string, MetaGraphClient>();
  const expired = new Set<string>();

  let collected = 0;
  let failed = 0;
  for (const row of due as DueCheckpoint[]) {
    const account = row.connected_account_id ? accountById.get(row.connected_account_id) : undefined;
    let metrics: PostMetrics = EMPTY_METRICS;
    let raw: Record<string, number> = {};
    let failure: string | null = null;
    try {
      if (!account || account.status !== 'active' || expired.has(account.id)) {
        throw Object.assign(new Error('Account is not active; reconnect it to collect insights'), { code: 'ACCOUNT_INACTIVE' });
      }
      let client = clients.get(account.id);
      if (!client) {
        client = new MetaGraphClient({ accessToken: decryptSecret(account.encrypted_access_token), graphVersion: process.env.META_GRAPH_VERSION, timeoutMs: 20_000 });
        clients.set(account.id, client);
      }
      ({ metrics, raw } = row.platform === 'instagram'
        ? await client.getInstagramInsights(row.remote_post_id)
        : await client.getFacebookInsights(row.remote_post_id, row.media_type === 'video_reel'));
    } catch (collectError) {
      failure = collectError instanceof Error ? collectError.message.slice(0, 1000) : String(collectError);
      const blocked = collectError instanceof TokenCryptoError || (collectError as MediaProviderError).classification === 'blocked';
      if (blocked && account && !expired.has(account.id)) {
        expired.add(account.id);
        await admin.from('connected_accounts').update({ status: 'expired' }).eq('id', account.id);
      }
    }

    const { error: writeError } = await admin.from('post_insights').upsert({
      organization_id: row.organization_id,
      publication_attempt_id: row.publication_attempt_id,
      content_item_id: row.content_item_id,
      connected_account_id: row.connected_account_id,
      niche_id: row.niche_id,
      platform: row.platform,
      media_type: row.media_type,
      checkpoint: row.checkpoint,
      posted_at: row.posted_at,
      posted_minute_ist: minuteOfDayIst(new Date(row.posted_at)),
      status: failure ? 'failed' : 'collected',
      attempts: (row.attempts || 0) + 1,
      ...metrics,
      metrics: raw,
      error: failure,
      collected_at: new Date().toISOString(),
    }, { onConflict: 'publication_attempt_id,checkpoint' });
    if (writeError) throw new Error(`Failed to store insights: ${writeError.message}`);
    if (failure) failed += 1; else collected += 1;
  }

  return { success: true, collected, failed };
}
