/**
 * Publishing Worker
 * Publishes a validated item to every active Instagram and Facebook account of
 * its niche. One publication_attempts row per account makes this idempotent:
 * - accounts already published are skipped on retry,
 * - an IG container id is stored before media_publish, so a crash resumes that
 *   container instead of creating a second post,
 * - a timeout on the final publish call is recorded as `uncertain` and alerted
 *   instead of being retried blindly (it may have gone live).
 * PUBLISHING_DISABLED (default true) is checked first and always wins.
 */

import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  MediaProviderError,
  MetaGraphClient,
  RenderManifestSchema,
  TokenCryptoError,
  decryptSecret,
  signMediaPath,
  storagePathFromUrl,
  type MediaType,
  type PublishOutcome,
} from '@viralforge/domain';
import { composeCaption } from './validation';

const supabase = requireSupabaseAdmin();
const MEDIA_URL_TTL_SECONDS = 2 * 60 * 60;

interface Account {
  id: string;
  platform: 'instagram' | 'facebook';
  account_id: string;
  account_name: string;
  encrypted_access_token: string;
  status: string;
}

interface Publication {
  accountId: string;
  platform: string;
  status: 'published' | 'failed' | 'uncertain' | 'skipped';
  remoteId?: string;
  permalink?: string;
  error?: string;
  classification?: string;
}

export async function publishingWorker(job: Job) {
  const { contentItemId, runId, stageAttemptId } = job.data as { contentItemId: string; runId?: string; stageAttemptId?: string };

  if (process.env.PUBLISHING_DISABLED !== 'false') {
    return { success: false, blocked: true, code: 'PUBLISHING_DISABLED', reason: 'Publishing is disabled (PUBLISHING_DISABLED); package is ready and waiting' };
  }
  if (!runId || !stageAttemptId) throw Object.assign(new Error('Publishing requires a durable pipeline attempt'), { code: 'INVALID_INPUT' });

  const { data: item, error } = await supabase.from('content_items').select('*').eq('id', contentItemId).single();
  if (error || !item) throw Object.assign(new Error(`Content item not found: ${contentItemId}`), { code: 'NOT_FOUND' });
  if (!['validated', 'scheduled', 'publishing'].includes(item.status)) {
    throw Object.assign(new Error(`Cannot publish content in status ${item.status}`), { code: 'INVALID_INPUT' });
  }
  if (item.publish_mode === 'manual_approval' && item.approval_status !== 'approved') {
    return { success: false, blocked: true, code: 'APPROVAL_REQUIRED', reason: 'Content is not approved for publishing' };
  }

  const { data: accounts, error: accountError } = await supabase
    .from('connected_accounts')
    .select('id, platform, account_id, account_name, encrypted_access_token, status')
    .eq('organization_id', item.organization_id)
    .eq('niche_id', item.niche_id)
    .eq('status', 'active');
  if (accountError) throw new Error(`Failed to load accounts: ${accountError.message}`);
  if (!accounts?.length) {
    return { success: false, blocked: true, code: 'NO_ACCOUNTS', reason: `No active Instagram/Facebook account connected for ${item.niche_id}` };
  }

  const render = RenderManifestSchema.safeParse(stripRenderExtras(item.rendering_manifest));
  if (!render.success) return { success: false, blocked: true, code: 'RENDER_MISSING', reason: 'Rendering manifest is missing; retry from rendering' };

  let mediaUrls: string[];
  try {
    const outputs = item.media_type === 'video_reel' ? [render.data.output] : (render.data.slides || [render.data.output]);
    mediaUrls = outputs.map((output) => signMediaPath(storagePathFromUrl(output.url), MEDIA_URL_TTL_SECONDS));
  } catch (signError) {
    return { success: false, blocked: true, code: 'PUBLIC_MEDIA_NOT_CONFIGURED', reason: (signError as Error).message };
  }

  await supabase.from('content_items').update({ status: 'publishing' }).eq('id', contentItemId);
  const caption = composeCaption(item);
  const results: Publication[] = [];
  await job.updateProgress(10);

  for (const account of accounts as Account[]) {
    results.push(await publishToAccount(item, account, mediaUrls, caption, runId, stageAttemptId));
    await job.updateProgress(10 + Math.round((results.length / accounts.length) * 85));
  }

  const published = results.filter((result) => result.status === 'published');
  const uncertain = results.filter((result) => result.status === 'uncertain');
  const failed = results.filter((result) => result.status === 'failed');

  await supabase.from('audit_logs').insert({
    organization_id: item.organization_id,
    content_item_id: contentItemId,
    niche_id: item.niche_id,
    action: failed.length || uncertain.length ? 'publishing.partial' : 'publishing.completed',
    actor: 'system',
    actor_type: 'system',
    metadata: { results: results.map(({ error: message, ...rest }) => ({ ...rest, error: message?.slice(0, 300) })) },
  });

  if (failed.length === 0 && uncertain.length === 0) {
    await supabase.from('content_items').update({
      status: 'published',
      published_at: new Date().toISOString(),
      meta_post_id: published[0]?.remoteId || null,
      insights_snapshot: { publications: results },
    }).eq('id', contentItemId);
    return { success: true, contentItemId, publications: results };
  }

  await supabase.from('content_items').update({ insights_snapshot: { publications: results } }).eq('id', contentItemId);
  if (uncertain.length > 0 || failed.every((result) => result.classification === 'blocked')) {
    // Needs a human: token reconnect, or checking whether an uncertain post went live.
    return {
      success: false,
      blocked: true,
      code: uncertain.length ? 'PUBLISH_UNCERTAIN' : 'ACCOUNT_BLOCKED',
      reason: [...uncertain, ...failed].map((result) => `${result.platform}: ${result.error}`).join(' | ').slice(0, 1000),
    };
  }
  // Retry-all re-runs this stage; accounts already published are skipped.
  throw new MediaProviderError(
    `Publishing failed for ${failed.map((result) => result.platform).join(', ')}: ${failed.map((result) => result.error).join(' | ')}`.slice(0, 1000),
    failed.some((result) => result.classification === 'retryable') ? 'retryable' : 'permanent',
    { providerCode: 'PUBLISH_FAILED' },
  );
}

async function publishToAccount(
  item: any,
  account: Account,
  mediaUrls: string[],
  caption: string,
  runId: string,
  stageAttemptId: string,
): Promise<Publication> {
  const base = { accountId: account.id, platform: account.platform };
  const { data: attempt, error } = await supabase
    .from('publication_attempts')
    .upsert({
      pipeline_run_id: runId,
      stage_attempt_id: stageAttemptId,
      organization_id: item.organization_id,
      content_item_id: item.id,
      connected_account_id: account.id,
      platform: account.platform,
      content_revision: item.version || 1,
      schedule_revision: item.schedule_revision || 1,
    }, { onConflict: 'content_item_id,connected_account_id,content_revision,schedule_revision', ignoreDuplicates: true })
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Failed to record publication attempt: ${error.message}`);
  const current = attempt || (await supabase
    .from('publication_attempts')
    .select('*')
    .eq('content_item_id', item.id)
    .eq('connected_account_id', account.id)
    .eq('content_revision', item.version || 1)
    .eq('schedule_revision', item.schedule_revision || 1)
    .single()).data;
  if (!current) throw new Error('Publication attempt row is missing');

  if (current.status === 'published') return { ...base, status: 'published', remoteId: current.remote_post_id, permalink: current.permalink };
  if (current.status === 'uncertain') return { ...base, status: 'uncertain', error: 'Previous attempt may have published; verify on the platform, then mark resolved' };

  await supabase.from('publication_attempts').update({
    status: 'processing',
    stage_attempt_id: stageAttemptId,
    started_at: new Date().toISOString(),
    error: null,
  }).eq('id', current.id);

  const saveContainer = async (containerId: string) => {
    await supabase.from('publication_attempts').update({ remote_container_id: containerId }).eq('id', current.id);
  };

  let finalCallStarted = false;
  try {
    const client = new MetaGraphClient({ accessToken: decryptSecret(account.encrypted_access_token), graphVersion: process.env.META_GRAPH_VERSION });
    const mediaType = item.media_type as MediaType;
    let outcome: PublishOutcome;
    if (account.platform === 'instagram') {
      if (current.remote_container_id) {
        finalCallStarted = true;
        outcome = await client.resumeInstagramContainer(account.account_id, current.remote_container_id);
      } else {
        const onContainer = async (id: string) => { await saveContainer(id); finalCallStarted = true; };
        outcome = mediaType === 'video_reel'
          ? await client.publishInstagramReel(account.account_id, mediaUrls[0], caption, onContainer)
          : mediaType === 'image_carousel'
            ? await client.publishInstagramCarousel(account.account_id, mediaUrls, caption, onContainer)
            : await client.publishInstagramImage(account.account_id, mediaUrls[0], caption, onContainer);
      }
    } else {
      finalCallStarted = true;
      outcome = mediaType === 'video_reel'
        ? await client.publishFacebookReel(account.account_id, mediaUrls[0], caption, saveContainer)
        : mediaType === 'image_carousel'
          ? await client.publishFacebookMultiPhoto(account.account_id, mediaUrls, caption)
          : await client.publishFacebookPhoto(account.account_id, mediaUrls[0], caption);
    }

    await supabase.from('publication_attempts').update({
      status: 'published',
      remote_post_id: outcome.remoteId,
      remote_container_id: outcome.containerId || current.remote_container_id,
      permalink: outcome.permalink || null,
      completed_at: new Date().toISOString(),
    }).eq('id', current.id);
    return { ...base, status: 'published', remoteId: outcome.remoteId, permalink: outcome.permalink };
  } catch (publishError) {
    const message = publishError instanceof Error ? publishError.message : String(publishError);
    const classification = publishError instanceof TokenCryptoError
      ? 'blocked'
      : (publishError as MediaProviderError).classification || 'retryable';
    // IG retries resume the saved container (publishable once), so only a
    // Facebook network failure after the final call started is ambiguous.
    const ambiguous = account.platform === 'facebook' && finalCallStarted
      && (publishError as MediaProviderError).providerCode === 'META_NETWORK';
    const status = ambiguous ? 'uncertain' : 'failed';
    await supabase.from('publication_attempts').update({
      status,
      error: { message: message.slice(0, 1000), classification },
      completed_at: new Date().toISOString(),
      // A failed IG container cannot be reused; clear it so the retry creates a new one.
      ...(status === 'failed' && classification === 'permanent' ? { remote_container_id: null } : {}),
    }).eq('id', current.id);
    if (classification === 'blocked') {
      await supabase.from('connected_accounts').update({ status: 'expired' }).eq('id', account.id);
    }
    return { ...base, status, error: message, classification };
  }
}

function stripRenderExtras(manifest: Record<string, unknown> | null): Record<string, unknown> {
  const { finalMediaUrl: _f, duration: _d, codec: _c, resolution: _r, slideCount: _s, ...rest } = manifest || {};
  return rest;
}
