/**
 * Meta Graph API publishing for Instagram (professional accounts) and Facebook Pages.
 * - Access tokens are sent only in the Authorization header, never in URLs.
 * - Errors are classified like MediaProviderError so the pipeline can block
 *   (token/permission), retry (rate limit / transient) or fail (bad media).
 * - `onContainer` lets the caller persist a container/video id *before* the
 *   final publish call, so a crash never causes a duplicate post.
 */
import { MediaProviderError, MediaProviderErrorClassification } from './media-adapter';
import { facebookMetrics, flattenGraphInsights, instagramMetrics, type PostMetrics } from '../insights';

export interface MetaGraphConfig {
  accessToken: string;
  graphVersion?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Max time to wait for IG containers / FB video processing. */
  processingTimeoutMs?: number;
}

export interface PublishOutcome {
  remoteId: string;
  containerId?: string;
  permalink?: string;
}

export type ContainerCallback = (containerId: string) => Promise<void>;

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean; type?: string };
}

const BLOCKING_CODES = new Set([10, 102, 190, 200, 210, 230, 294]);
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 9004, 80001, 80002, 80004]);

export function classifyGraphError(status: number, body: GraphErrorBody): MediaProviderErrorClassification {
  const code = body.error?.code;
  if (code !== undefined && BLOCKING_CODES.has(code)) return 'blocked';
  if (body.error?.is_transient || (code !== undefined && RETRYABLE_CODES.has(code))) return 'retryable';
  if (status === 401 || status === 403) return 'blocked';
  if (status === 429 || status >= 500) return 'retryable';
  return 'permanent';
}

export class MetaGraphClient {
  private readonly base: string;

  constructor(private readonly config: MetaGraphConfig) {
    this.base = `https://graph.facebook.com/${config.graphVersion || 'v23.0'}`;
  }

  async request<T>(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}, baseOverride?: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${baseOverride || this.base}/${path.replace(/^\//, '')}`);
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.config.accessToken}`, ...extraHeaders },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
    };
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    } else {
      init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' };
      init.body = JSON.stringify(params);
    }
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new MediaProviderError(`Graph API network error on ${path}: ${(error as Error).message}`, 'retryable', { providerCode: 'META_NETWORK', cause: error });
    }
    const body = (await response.json().catch(() => ({}))) as T & GraphErrorBody;
    if (!response.ok || body.error) {
      const classification = classifyGraphError(response.status, body);
      throw new MediaProviderError(
        `Graph API ${path} failed (${response.status}${body.error?.code ? `, code ${body.error.code}` : ''}): ${body.error?.message || response.statusText}`,
        classification,
        { status: response.status, providerCode: `META_${body.error?.code ?? response.status}` },
      );
    }
    return body;
  }

  private async sleep() {
    await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs ?? 5_000));
  }

  // ------------------------------------------------------------------ Instagram

  private async waitForContainer(containerId: string): Promise<void> {
    const deadline = Date.now() + (this.config.processingTimeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      const status = await this.request<{ status_code?: string; status?: string }>('GET', containerId, { fields: 'status_code,status' });
      if (status.status_code === 'FINISHED') return;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new MediaProviderError(`Instagram container ${status.status_code}: ${status.status || 'unknown'}`, 'permanent', { providerCode: 'IG_CONTAINER_ERROR' });
      }
      await this.sleep();
    }
    throw new MediaProviderError('Instagram container processing timed out', 'retryable', { providerCode: 'IG_CONTAINER_TIMEOUT' });
  }

  private async publishContainer(igUserId: string, containerId: string): Promise<PublishOutcome> {
    await this.waitForContainer(containerId);
    const published = await this.request<{ id: string }>('POST', `${igUserId}/media_publish`, { creation_id: containerId });
    const permalink = await this.request<{ permalink?: string }>('GET', published.id, { fields: 'permalink' })
      .then((value) => value.permalink)
      .catch(() => undefined);
    return { remoteId: published.id, containerId, permalink };
  }

  /**
   * Resume a container created by an earlier attempt instead of creating a new
   * one. A container can be published only once, so this never double-posts;
   * if it already went live, the container id is returned as the remote id.
   */
  async resumeInstagramContainer(igUserId: string, containerId: string): Promise<PublishOutcome> {
    const status = await this.request<{ status_code?: string }>('GET', containerId, { fields: 'status_code' });
    if (status.status_code === 'PUBLISHED') return { remoteId: containerId, containerId };
    return this.publishContainer(igUserId, containerId);
  }

  async publishInstagramImage(igUserId: string, imageUrl: string, caption: string, onContainer?: ContainerCallback): Promise<PublishOutcome> {
    const container = await this.request<{ id: string }>('POST', `${igUserId}/media`, { image_url: imageUrl, caption });
    await onContainer?.(container.id);
    return this.publishContainer(igUserId, container.id);
  }

  async publishInstagramCarousel(igUserId: string, imageUrls: string[], caption: string, onContainer?: ContainerCallback): Promise<PublishOutcome> {
    if (imageUrls.length < 2 || imageUrls.length > 10) {
      throw new MediaProviderError('Instagram carousels need 2-10 items', 'permanent', { providerCode: 'IG_CAROUSEL_SIZE' });
    }
    const children: string[] = [];
    for (const imageUrl of imageUrls) {
      const child = await this.request<{ id: string }>('POST', `${igUserId}/media`, { image_url: imageUrl, is_carousel_item: true });
      await this.waitForContainer(child.id);
      children.push(child.id);
    }
    const parent = await this.request<{ id: string }>('POST', `${igUserId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
    await onContainer?.(parent.id);
    return this.publishContainer(igUserId, parent.id);
  }

  async publishInstagramReel(igUserId: string, videoUrl: string, caption: string, onContainer?: ContainerCallback, coverUrl?: string): Promise<PublishOutcome> {
    const container = await this.request<{ id: string }>('POST', `${igUserId}/media`, {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: true,
      ...(coverUrl ? { cover_url: coverUrl } : {}),
    });
    await onContainer?.(container.id);
    return this.publishContainer(igUserId, container.id);
  }

  // ------------------------------------------------------------------- Facebook

  async publishFacebookPhoto(pageId: string, imageUrl: string, message: string): Promise<PublishOutcome> {
    const photo = await this.request<{ id: string; post_id?: string }>('POST', `${pageId}/photos`, { url: imageUrl, message, published: true });
    return { remoteId: photo.post_id || photo.id };
  }

  async publishFacebookMultiPhoto(pageId: string, imageUrls: string[], message: string): Promise<PublishOutcome> {
    const media: string[] = [];
    for (const url of imageUrls) {
      const photo = await this.request<{ id: string }>('POST', `${pageId}/photos`, { url, published: false });
      media.push(photo.id);
    }
    const post = await this.request<{ id: string }>('POST', `${pageId}/feed`, {
      message,
      attached_media: media.map((id) => ({ media_fbid: id })),
    });
    return { remoteId: post.id };
  }

  /** Page Reels: start -> hosted-file upload (file_url) -> finish/publish -> wait. */
  async publishFacebookReel(pageId: string, videoUrl: string, description: string, onContainer?: ContainerCallback): Promise<PublishOutcome> {
    const started = await this.request<{ video_id: string }>('POST', `${pageId}/video_reels`, { upload_phase: 'start' });
    await onContainer?.(started.video_id);
    await this.request<{ success?: boolean }>(
      'POST',
      started.video_id,
      {},
      `https://rupload.facebook.com/video-upload/${this.config.graphVersion || 'v23.0'}`,
      { file_url: videoUrl },
    );
    await this.request<{ success?: boolean }>('POST', `${pageId}/video_reels`, {
      upload_phase: 'finish',
      video_id: started.video_id,
      video_state: 'PUBLISHED',
      description,
    });
    const deadline = Date.now() + (this.config.processingTimeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      const status = await this.request<{ status?: { video_status?: string; publishing_phase?: { status?: string } } }>('GET', started.video_id, { fields: 'status' });
      if (status.status?.video_status === 'error') {
        throw new MediaProviderError('Facebook reel processing failed', 'permanent', { providerCode: 'FB_REEL_ERROR' });
      }
      if (status.status?.video_status === 'ready' || status.status?.publishing_phase?.status === 'complete') break;
      await this.sleep();
    }
    const permalink = await this.request<{ permalink_url?: string }>('GET', started.video_id, { fields: 'permalink_url' })
      .then((value) => value.permalink_url ? `https://www.facebook.com${value.permalink_url}` : undefined)
      .catch(() => undefined);
    return { remoteId: started.video_id, containerId: started.video_id, permalink };
  }

  // ------------------------------------------------------------------- Insights

  /**
   * Instagram media insights. Meta renames/retires metrics between versions,
   * so an "invalid metric" rejection (code 100) falls back to a smaller set.
   */
  async getInstagramInsights(mediaId: string): Promise<{ metrics: PostMetrics; raw: Record<string, number> }> {
    let flat: Record<string, number>;
    try {
      flat = flattenGraphInsights(await this.request('GET', `${mediaId}/insights`, { metric: IG_METRICS.join(',') }));
    } catch (error) {
      if ((error as MediaProviderError).providerCode !== 'META_100') throw error;
      flat = flattenGraphInsights(await this.request('GET', `${mediaId}/insights`, { metric: IG_FALLBACK_METRICS.join(',') }));
    }
    return { metrics: instagramMetrics(flat), raw: flat };
  }

  /**
   * Facebook post or reel counts from object fields (stable across versions);
   * reach/plays come from insights on a best-effort basis.
   */
  async getFacebookInsights(remoteId: string, isReel: boolean): Promise<{ metrics: PostMetrics; raw: Record<string, number> }> {
    const fields = await this.request<Record<string, unknown>>('GET', remoteId, {
      fields: isReel
        ? 'likes.summary(true).limit(0),comments.summary(true).limit(0)'
        : 'reactions.summary(true).limit(0),comments.summary(true).limit(0),shares',
    });
    const flat = await this.request(
      'GET',
      isReel ? `${remoteId}/video_insights` : `${remoteId}/insights`,
      { metric: isReel ? 'blue_reels_play_count,post_impressions_unique' : 'post_impressions_unique' },
    ).then(flattenGraphInsights).catch((error: MediaProviderError) => {
      if (error.classification === 'blocked') throw error;
      return {} as Record<string, number>;
    });
    const metrics = facebookMetrics(fields, flat);
    const raw: Record<string, number> = { ...flat };
    for (const [key, value] of Object.entries(metrics)) if (typeof value === 'number') raw[`fields.${key}`] = value;
    return { metrics, raw };
  }

  /** Cheapest call that proves the stored token can still act on the account. */
  async verifyAccount(accountId: string): Promise<void> {
    await this.request<{ id: string }>('GET', accountId, { fields: 'id' });
  }
}

const IG_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];
const IG_FALLBACK_METRICS = ['reach', 'likes', 'comments', 'saved', 'shares'];
