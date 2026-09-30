/**
 * Validation Worker
 * Validates content before publishing
 */

import { Job } from 'bullmq';
import { MediaManifestSchema, RenderManifestSchema, type MediaManifest } from '@viralforge/domain';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const supabase = requireSupabaseAdmin();
const execFileAsync = promisify(execFile);

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const REQUIRED_WIDTH = 1080;
const REQUIRED_HEIGHT = 1920;
const ALLOW_SILENT_VIDEO = process.env.ALLOW_SILENT_VIDEO === 'true';

const PLATFORM_SIZE_LIMITS: Record<string, { image: number; video: number }> = {
  instagram: { image: 8 * 1024 * 1024, video: 4 * 1024 * 1024 * 1024 },
  facebook: { image: 30 * 1024 * 1024, video: 4 * 1024 * 1024 * 1024 },
};
const DEFAULT_SIZE_LIMITS = PLATFORM_SIZE_LIMITS.instagram;

export async function validationWorker(job: Job) {
  const { contentItemId } = job.data;

  console.log(`[Validation] Starting validation for content ${contentItemId}`);

  try {
    await job.updateProgress(10);

    // Get content item
    const { data: contentItem, error: fetchError } = await supabase
      .from('content_items')
      .select('*, connected_accounts!content_items_niche_account_id_fkey(*)')
      .eq('id', contentItemId)
      .single();

    if (fetchError || !contentItem) {
      throw new Error(`Content item not found: ${contentItemId}`);
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    await job.updateProgress(20);

    // 1. Validate required fields
    if (!contentItem.script_body || contentItem.script_body.length < 50) {
      errors.push('Script body is missing or too short');
    }

    if (!contentItem.hook_variation_a) {
      errors.push('Hook variation A is missing');
    }

    await job.updateProgress(40);

    // 2. Publishing readiness is irrelevant while media awaits manual approval.
    if (contentItem.publish_mode !== 'manual_approval') {
      if (!contentItem.niche_account_id || !contentItem.connected_accounts) {
        errors.push('No connected account for this content');
      } else {
        if (contentItem.connected_accounts.status !== 'active') {
          errors.push(`Account is ${contentItem.connected_accounts.status}, not active`);
        }

        if (contentItem.connected_accounts.token_expires_at) {
          const expiresAt = new Date(contentItem.connected_accounts.token_expires_at);
          if (expiresAt < new Date()) {
            errors.push('Account access token has expired');
          }
        }
      }
    }

    await job.updateProgress(60);

    // 3. Validate content (no copyrighted text, no medical claims for health, etc.)
    const contentValidation = validateContentByNiche(contentItem);
    errors.push(...contentValidation.errors);
    warnings.push(...contentValidation.warnings);

    await job.updateProgress(70);

    // 4. Check for duplicate content
    const isDuplicate = await checkDuplicateContent(contentItem);
    if (isDuplicate) {
      warnings.push('Similar content was published in the last 7 days');
    }

    await job.updateProgress(80);

    // 5. Publishing limits only apply when validation can lead directly to publishing.
    if (contentItem.publish_mode !== 'manual_approval' && contentItem.niche_account_id) {
      const dailyCount = await getDailyPublishingCount(contentItem.niche_account_id);
      const { data: nicheProfile } = await supabase.from('niche_profiles')
        .select('max_posts_per_day')
        .eq('organization_id', contentItem.organization_id)
        .eq('niche_id', contentItem.niche_id)
        .maybeSingle();
      const maxPerDay = nicheProfile?.max_posts_per_day || 5;

      if (dailyCount >= maxPerDay) {
        errors.push(`Daily publishing limit reached (${maxPerDay} posts per day)`);
      }
    }

    await job.updateProgress(90);

    // 6. Validate the media contract for the requested media type.
    const mediaValidation = await validateMedia(contentItem);
    errors.push(...mediaValidation.errors);
    warnings.push(...mediaValidation.warnings);

    await job.updateProgress(100);

    // A validation failure is an expected terminal outcome, not a worker failure.
    const status = errors.length > 0 ? 'blocked' : 'validated';

    const { error: updateError } = await supabase
      .from('content_items')
      .update({
        status,
        validation_errors: errors,
        validation_warnings: warnings,
      })
      .eq('id', contentItemId);
    if (updateError) {
      throw new Error(`Failed to save validation result: ${updateError.message}`);
    }

    // Log audit event
    await logAuditEvent(contentItemId, 'validation.completed', {
      status,
      errorCount: errors.length,
      warningCount: warnings.length,
    });

    console.log(`[Validation] Validation ${errors.length > 0 ? 'failed' : 'passed'} for content ${contentItemId}`);

    return {
      success: true,
      blocked: errors.length > 0,
      contentItemId,
      errors,
      warnings,
      status,
    };
  } catch (error) {
    console.error(`[Validation] Error for content ${contentItemId}:`, error);

    await supabase
      .from('content_items')
      .update({
        status: 'failed',
        validation_errors: [error instanceof Error ? error.message : String(error)],
      })
      .eq('id', contentItemId);

    throw error;
  }
}

/**
 * Validate content by niche
 */
function validateContentByNiche(contentItem: any): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const script = (contentItem.script_body || '').toLowerCase();
  const caption = ''; // TODO: extract from generated content

  switch (contentItem.niche_id) {
    case 'health':
      // No medical claims allowed
      const medicalClaims = ['cure', 'guaranteed', 'doctor recommended', 'medicine', 'disease', 'diagnosis'];
      for (const claim of medicalClaims) {
        if (script.includes(claim)) {
          errors.push(`Medical claim detected: "${claim}". Health content must avoid medical claims.`);
        }
      }
      break;

    case 'tech':
      // Warn on vague time savings claims
      if (script.includes('100%') || script.includes('guaranteed')) {
        warnings.push('Vague claims detected - consider specific metrics');
      }
      break;

    case 'edtech':
      // Educational content should have specific topics
      if (!contentItem.data_input_payload?.topic) {
        warnings.push('No specific topic identified for educational content');
      }
      break;

    case 'travel':
      // No unverified locations
      if (script.includes('secret') || script.includes('unknown place')) {
        warnings.push('Verify location claims before publishing');
      }
      break;

    case 'cartoon':
      // Family-friendly check
      const adultContent = ['alcohol', 'drugs', 'violence', 'weapon'];
      for (const item of adultContent) {
        if (script.includes(item)) {
          errors.push(`Adult content detected: "${item}"`);
        }
      }
      break;
  }

  // Check for AI disclosure if required
  if (contentItem.ai_disclosure_required) {
    if (!script.includes('ai') && !script.includes('generated')) {
      warnings.push('AI disclosure may be required but not detected in content');
    }
  }

  return { errors, warnings };
}

/**
 * Check for duplicate content
 */
async function checkDuplicateContent(contentItem: any): Promise<boolean> {
  const { data: similarItems } = await supabase
    .from('content_items')
    .select('id, script_body, hook_variation_a')
    .eq('niche_account_id', contentItem.niche_account_id)
    .eq('status', 'published')
    .gte('published_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .neq('id', contentItem.id);

  if (!similarItems || similarItems.length === 0) return false;

  // Simple similarity check (word overlap)
  const currentWords = new Set(
    (contentItem.script_body || '').toLowerCase().split(/\s+/)
  );

  for (const item of similarItems) {
    const itemWords = (item.script_body || '').toLowerCase().split(/\s+/);
    const overlap = itemWords.filter((w: string) => currentWords.has(w)).length;
    const similarity = overlap / Math.max(itemWords.length, 1);

    if (similarity > 0.7) {
      return true;
    }
  }

  return false;
}

/**
 * Get daily publishing count for an account
 */
async function getDailyPublishingCount(accountId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('content_items')
    .select('*', { count: 'exact', head: true })
    .eq('niche_account_id', accountId)
    .gte('published_at', startOfDay.toISOString());

  return count || 0;
}

type ValidationResult = { errors: string[]; warnings: string[] };
type MediaArtifact = MediaManifest['artifacts'][number];

function formatSchemaErrors(prefix: string, issues: Array<{ path: (string | number)[]; message: string }>): string[] {
  return issues.map((issue) => {
    const location = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    return `${prefix}${location}: ${issue.message}`;
  });
}

function sizeLimitFor(platform: string | undefined, kind: 'image' | 'video'): number {
  return (platform && PLATFORM_SIZE_LIMITS[platform] || DEFAULT_SIZE_LIMITS)[kind];
}

function artifactSizeBytes(artifact: MediaArtifact): number | undefined {
  const value = artifact.metadata?.sizeBytes ?? artifact.metadata?.downloadSizeBytes;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validateImageArtifact(
  artifact: MediaArtifact,
  index: number,
  platform: string | undefined,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const label = `Media artifact ${index + 1}`;

  if (artifact.kind !== 'image') errors.push(`${label} must be an image`);
  if (!artifact.mimeType || !IMAGE_MIME_TYPES.has(artifact.mimeType.toLowerCase())) {
    errors.push(`${label} has unsupported MIME type ${artifact.mimeType || 'missing'}`);
  }
  if (artifact.width !== REQUIRED_WIDTH || artifact.height !== REQUIRED_HEIGHT) {
    errors.push(`${label} must be ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}`);
  }

  const sizeBytes = artifactSizeBytes(artifact);
  const maxBytes = sizeLimitFor(platform, 'image');
  if (sizeBytes === undefined) {
    errors.push(`${label} size is missing`);
  } else if (sizeBytes <= 0 || sizeBytes > maxBytes) {
    errors.push(`${label} size must be greater than 0 and at most ${maxBytes} bytes`);
  }

  return { errors, warnings };
}

async function validateMedia(contentItem: any): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mediaManifestResult = MediaManifestSchema.safeParse(
    contentItem.ai_generation_metadata?.mediaManifest,
  );

  if (!mediaManifestResult.success) {
    errors.push(...formatSchemaErrors('Invalid media manifest', mediaManifestResult.error.issues));
  } else if (mediaManifestResult.data.contentItemId !== contentItem.id) {
    errors.push('Media manifest belongs to a different content item');
  }

  if (contentItem.media_type === 'video_reel') {
    const renderingManifest = contentItem.rendering_manifest;
    if (!renderingManifest || typeof renderingManifest !== 'object' || Array.isArray(renderingManifest)) {
      errors.push('Rendering manifest is missing');
      return { errors, warnings };
    }

    const { finalMediaUrl, ...renderManifestCandidate } = renderingManifest as Record<string, unknown>;
    if (typeof finalMediaUrl !== 'string' || finalMediaUrl.trim().length === 0) {
      errors.push('rendering_manifest.finalMediaUrl is required');
    }

    const renderManifestResult = RenderManifestSchema.safeParse(renderManifestCandidate);
    if (!renderManifestResult.success) {
      errors.push(...formatSchemaErrors('Invalid rendering manifest', renderManifestResult.error.issues));
      return { errors, warnings };
    }

    const renderManifest = renderManifestResult.data;
    if (renderManifest.contentItemId !== contentItem.id) {
      errors.push('Rendering manifest belongs to a different content item');
    }
    if (renderManifest.output.url !== finalMediaUrl) {
      errors.push('rendering_manifest.finalMediaUrl must match rendering_manifest.output.url');
    }
    if (!VIDEO_MIME_TYPES.has(renderManifest.output.mimeType.toLowerCase())) {
      errors.push(`Rendered video has unsupported MIME type ${renderManifest.output.mimeType}`);
    }
    if (renderManifest.output.width !== REQUIRED_WIDTH || renderManifest.output.height !== REQUIRED_HEIGHT) {
      errors.push(`Rendered video must be ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}`);
    }
    if (renderManifest.output.durationSeconds <= 0) {
      errors.push('Rendered video duration must be greater than 0 seconds');
    }

    const maxBytes = sizeLimitFor(contentItem.connected_accounts?.platform, 'video');
    if (renderManifest.output.sizeBytes === undefined) {
      errors.push('Rendered video size is missing');
    } else if (renderManifest.output.sizeBytes <= 0 || renderManifest.output.sizeBytes > maxBytes) {
      errors.push(`Rendered video size must be greater than 0 and at most ${maxBytes} bytes`);
    }

    const probeResult = await probeVideo(renderManifest.output.url);
    errors.push(...probeResult.errors);
    warnings.push(...probeResult.warnings);
    return { errors, warnings };
  }

  if (!mediaManifestResult.success) return { errors, warnings };

  const artifacts = mediaManifestResult.data.artifacts;
  if (contentItem.media_type === 'image_carousel' && artifacts.length < 2) {
    errors.push('Image carousel requires at least 2 media artifacts');
  } else if (contentItem.media_type === 'image_single' && artifacts.length !== 1) {
    errors.push('Single image content requires exactly 1 media artifact');
  } else if (!['image_carousel', 'image_single'].includes(contentItem.media_type)) {
    errors.push(`Unsupported media type: ${contentItem.media_type}`);
  }

  for (const [index, artifact] of artifacts.entries()) {
    const result = validateImageArtifact(artifact, index, contentItem.connected_accounts?.platform);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return { errors, warnings };
}

async function downloadMedia(url: string): Promise<Buffer> {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  }

  const storagePath = url.startsWith('storage://viralforge-content/')
    ? url.slice('storage://viralforge-content/'.length)
    : url;
  const { data, error } = await supabase.storage.from('viralforge-content').download(storagePath);
  if (error || !data) throw new Error(error?.message || 'Storage object not found');
  return Buffer.from(await data.arrayBuffer());
}

async function probeVideo(url: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tempPath = path.join(tmpdir(), `validate-${randomUUID()}.media`);

  try {
    await fs.writeFile(tempPath, await downloadMedia(url));
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', tempPath,
    ]);
    const metadata = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
      format?: { duration?: string; size?: string };
    };
    const video = metadata.streams?.find((stream) => stream.codec_type === 'video');
    const hasAudio = metadata.streams?.some((stream) => stream.codec_type === 'audio') ?? false;

    if (!video) errors.push('ffprobe found no video stream');
    if (!hasAudio) {
      if (ALLOW_SILENT_VIDEO) warnings.push('ffprobe found no audio stream; silent video is allowed');
      else errors.push('ffprobe found no audio stream');
    }
    if (video && (video.width !== REQUIRED_WIDTH || video.height !== REQUIRED_HEIGHT)) {
      errors.push(`ffprobe dimensions must be ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}`);
    }

    const duration = Number(video?.duration ?? metadata.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push('ffprobe duration must be greater than 0 seconds');
    }
  } catch (error) {
    errors.push(`Rendered media probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }

  return { errors, warnings };
}

async function logAuditEvent(
  contentItemId: string,
  action: string,
  metadata: Record<string, any>
) {
  await supabase.from('audit_logs').insert({
    content_item_id: contentItemId,
    action,
    actor: 'system',
    actor_type: 'system',
    metadata,
  });
}
