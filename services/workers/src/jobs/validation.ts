/**
 * Validation Worker
 * Checks copy, policy, publishing readiness and the rendered media contract.
 * Validation errors block the run (operator fixes and resumes); they are not
 * worker failures. Unexpected exceptions are rethrown for the runtime to retry.
 */

import { Job } from 'bullmq';
import {
  GeneratedContentPackageSchema,
  MediaManifestSchema,
  RenderManifestSchema,
  readBrief,
  validatePackageForMediaType,
  type MediaType,
  type RenderedOutput,
} from '@viralforge/domain';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const supabase = requireSupabaseAdmin();
const execFileAsync = promisify(execFile);

const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);
const REEL = { width: 1080, height: 1920 };
const POST = { width: 1080, height: 1350 };
const ALLOW_SILENT_VIDEO = process.env.ALLOW_SILENT_VIDEO === 'true';
// Instagram limits (the stricter platform): JPEG <= 8MB; reels 3s-15min, <= 300MB for API upload.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MIN_REEL_SECONDS = 3;
const MAX_REEL_SECONDS = 90;
const MAX_CAPTION_CHARS = 2200;

type ValidationResult = { errors: string[]; warnings: string[] };

export async function validationWorker(job: Job) {
  const { contentItemId } = job.data;

  const { data: item, error } = await supabase
    .from('content_items')
    .select('*')
    .eq('id', contentItemId)
    .single();
  if (error || !item) throw Object.assign(new Error(`Content item not found: ${contentItemId}`), { code: 'NOT_FOUND' });

  const errors: string[] = [];
  const warnings: string[] = [];
  const mediaType = (item.media_type || 'video_reel') as MediaType;
  await job.updateProgress(10);

  const copy = validateCopy(item, mediaType);
  errors.push(...copy.errors);
  warnings.push(...copy.warnings);
  await job.updateProgress(30);

  const readiness = await validatePublishingReadiness(item);
  errors.push(...readiness.errors);
  warnings.push(...readiness.warnings);
  await job.updateProgress(50);

  if (await isDuplicate(item)) warnings.push('A very similar post was published in this niche in the last 14 days');
  await job.updateProgress(60);

  const media = await validateMedia(item, mediaType);
  errors.push(...media.errors);
  warnings.push(...media.warnings);
  await job.updateProgress(95);

  const status = errors.length > 0 ? 'blocked' : 'validated';
  const { error: updateError } = await supabase
    .from('content_items')
    .update({ status, validation_errors: errors, validation_warnings: warnings })
    .eq('id', contentItemId);
  if (updateError) throw new Error(`Failed to save validation result: ${updateError.message}`);

  await supabase.from('audit_logs').insert({
    organization_id: item.organization_id,
    content_item_id: contentItemId,
    niche_id: item.niche_id,
    action: 'validation.completed',
    actor: 'system',
    actor_type: 'system',
    metadata: { status, errors, warningCount: warnings.length },
  });

  await job.updateProgress(100);
  return {
    success: true,
    blocked: errors.length > 0,
    code: errors.length > 0 ? 'VALIDATION_FAILED' : undefined,
    reason: errors.length > 0 ? errors.join('; ').slice(0, 1000) : undefined,
    contentItemId,
    errors,
    warnings,
    status,
  };
}

/** Composes the final caption exactly as it will be published. */
export function composeCaption(item: any): string {
  const generated = item.ai_generation_metadata?.generatedContent || {};
  const hashtags: string[] = generated.hashtags || item.ai_generation_metadata?.hashtags || [];
  const parts = [
    generated.caption || item.hook_variation_a || '',
    generated.cta || item.cta_destination || '',
    item.ai_disclosure_required ? 'AI-generated visuals.' : '',
    hashtags.join(' '),
  ].map((part: string) => part.trim()).filter(Boolean);
  return parts.join('\n\n').slice(0, MAX_CAPTION_CHARS);
}

function validateCopy(item: any, mediaType: MediaType): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = GeneratedContentPackageSchema.safeParse(item.ai_generation_metadata?.generatedContent);
  if (!parsed.success) {
    errors.push('Generated content package is missing or invalid');
    return { errors, warnings };
  }
  const generated = parsed.data;
  errors.push(...validatePackageForMediaType(generated, mediaType));
  if (!item.hook_variation_a) errors.push('Hook is missing');
  if (generated.hashtags.length > 30) errors.push('Instagram allows at most 30 hashtags');

  const caption = composeCaption(item);
  if (caption.length >= MAX_CAPTION_CHARS) warnings.push(`Caption was truncated to ${MAX_CAPTION_CHARS} characters`);

  const text = [generated.script, generated.caption, ...generated.scenes.map((scene) => `${scene.voiceover} ${scene.onScreenText} ${scene.bodyText || ''}`)]
    .join(' ')
    .toLowerCase();

  // Hard policy lines. Word boundaries avoid matching inside other words.
  const blocked: Record<string, string[]> = {
    health: ['\\bcure[sd]?\\b', '\\bguaranteed\\b', '\\b100% (?:safe|result)', 'इलाज पक्का', 'गारंटी'],
    cartoon: ['\\balcohol\\b', '\\bdrugs?\\b', '\\bweapons?\\b', '\\bgore\\b'],
    edtech: ['\\bleak(?:ed)? paper\\b', 'पेपर लीक'],
    tech: ['\\bcrack(?:ed)? version\\b', '\\bpirat', '\\bhack (?:wifi|account)'],
  };
  for (const pattern of blocked[item.niche_id] || []) {
    if (new RegExp(pattern, 'iu').test(text)) errors.push(`Policy: content matches a blocked phrase for ${item.niche_id} (${pattern.replace(/\\b/g, '')})`);
  }
  if (item.niche_id === 'health' && /\b(diabetes|bp|blood pressure|thyroid|pcos|cholesterol)\b/i.test(text) && !/doctor|डॉक्टर/i.test(text)) {
    warnings.push('Health condition mentioned without a "consult a doctor" note');
  }
  if (item.niche_id === 'edtech' && !readBrief(item.data_input_payload) && !item.data_input_payload?.topic) {
    warnings.push('No specific topic identified for educational content');
  }
  return { errors, warnings };
}

async function validatePublishingReadiness(item: any): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const publishingEnabled = process.env.PUBLISHING_DISABLED === 'false';

  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id, platform, status, token_expires_at')
    .eq('organization_id', item.organization_id)
    .eq('niche_id', item.niche_id);
  const active = (accounts || []).filter((account) => account.status === 'active'
    && (!account.token_expires_at || new Date(account.token_expires_at) > new Date()));

  // Missing accounts only matter when this validation can lead to a real publish.
  const target = publishingEnabled && item.publish_mode !== 'manual_approval' ? errors : warnings;
  if (active.length === 0) target.push(`No active Instagram/Facebook account connected for ${item.niche_id}`);
  for (const platform of ['instagram', 'facebook']) {
    if (active.length > 0 && !active.some((account) => account.platform === platform)) {
      warnings.push(`No active ${platform} account for ${item.niche_id}; it will be skipped`);
    }
  }

  const { data: profile } = await supabase
    .from('niche_profiles')
    .select('max_posts_per_day')
    .eq('organization_id', item.organization_id)
    .eq('niche_id', item.niche_id)
    .maybeSingle();
  const maxPerDay = profile?.max_posts_per_day || Number(process.env.MAX_POSTS_PER_DAY_PER_ACCOUNT || 5);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('content_items')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', item.organization_id)
    .eq('niche_id', item.niche_id)
    .eq('status', 'published')
    .gte('published_at', since);
  if ((count || 0) >= maxPerDay) target.push(`Daily publishing limit reached for ${item.niche_id} (${maxPerDay} per 24h)`);

  return { errors, warnings };
}

async function isDuplicate(item: any): Promise<boolean> {
  const { data: recent } = await supabase
    .from('content_items')
    .select('id, script_body')
    .eq('organization_id', item.organization_id)
    .eq('niche_id', item.niche_id)
    .eq('status', 'published')
    .gte('published_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
    .neq('id', item.id)
    .limit(200);
  const current = new Set((item.script_body || '').toLowerCase().split(/\s+/).filter(Boolean));
  if (current.size === 0) return false;
  return (recent || []).some((other) => {
    const words = (other.script_body || '').toLowerCase().split(/\s+/).filter(Boolean);
    const overlap = words.filter((word: string) => current.has(word)).length;
    return words.length > 0 && overlap / words.length > 0.7;
  });
}

async function validateMedia(item: any, mediaType: MediaType): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const media = MediaManifestSchema.safeParse(item.ai_generation_metadata?.mediaManifest);
  if (!media.success) errors.push('Media manifest is missing or invalid');
  else if (media.data.contentItemId !== item.id) errors.push('Media manifest belongs to a different content item');

  const { finalMediaUrl, duration: _d, codec: _c, resolution: _r, slideCount: _s, ...candidate } = (item.rendering_manifest || {}) as Record<string, unknown>;
  const render = RenderManifestSchema.safeParse(candidate);
  if (!render.success) {
    errors.push('Rendering manifest is missing or invalid');
    return { errors, warnings };
  }
  if (render.data.contentItemId !== item.id) errors.push('Rendering manifest belongs to a different content item');
  if (render.data.output.url !== finalMediaUrl) errors.push('rendering_manifest.finalMediaUrl must match output.url');

  if (mediaType === 'video_reel') {
    const output = render.data.output;
    if (!VIDEO_MIME_TYPES.has(output.mimeType)) errors.push(`Reel has unsupported MIME type ${output.mimeType}`);
    if (output.width !== REEL.width || output.height !== REEL.height) errors.push(`Reel must be ${REEL.width}x${REEL.height}`);
    if (!output.sizeBytes || output.sizeBytes > MAX_VIDEO_BYTES) errors.push('Reel size is missing or above 300MB');
    const probe = await probeVideo(output.url);
    errors.push(...probe.errors);
    warnings.push(...probe.warnings);
    return { errors, warnings };
  }

  const slides = render.data.slides || [];
  const expected = item.ai_generation_metadata?.generatedContent?.scenes?.length || 0;
  if (mediaType === 'image_single' && slides.length !== 1) errors.push('Single image posts need exactly 1 rendered image');
  if (mediaType === 'image_carousel' && (slides.length < 2 || slides.length > 10)) errors.push('Carousels need 2-10 rendered slides');
  if (expected && slides.length !== expected) errors.push(`Rendered ${slides.length} slides but the package has ${expected}`);
  slides.forEach((slide: RenderedOutput, index: number) => {
    if (slide.mimeType !== 'image/jpeg') errors.push(`Slide ${index + 1} must be JPEG (Instagram requirement)`);
    if (slide.width !== POST.width || slide.height !== POST.height) errors.push(`Slide ${index + 1} must be ${POST.width}x${POST.height}`);
    if (!slide.sizeBytes || slide.sizeBytes > MAX_IMAGE_BYTES) errors.push(`Slide ${index + 1} size is missing or above 8MB`);
  });
  return { errors, warnings };
}

async function downloadMedia(url: string): Promise<Buffer> {
  const storagePath = url.startsWith('storage://viralforge-content/') ? url.slice('storage://viralforge-content/'.length) : url;
  const { data, error } = await supabase.storage.from('viralforge-content').download(storagePath);
  if (error || !data) throw new Error(error?.message || 'Storage object not found');
  return Buffer.from(await data.arrayBuffer());
}

async function probeVideo(url: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tempPath = path.join(tmpdir(), `validate-${randomUUID()}.mp4`);
  try {
    await fs.writeFile(tempPath, await downloadMedia(url));
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', tempPath]);
    const metadata = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const video = metadata.streams?.find((stream) => stream.codec_type === 'video');
    const audio = metadata.streams?.find((stream) => stream.codec_type === 'audio');
    if (!video) errors.push('ffprobe found no video stream');
    else if (video.codec_name !== 'h264') errors.push(`Reel video codec must be h264, got ${video.codec_name}`);
    if (!audio) {
      if (ALLOW_SILENT_VIDEO) warnings.push('Reel has no audio track; silent video is allowed by config');
      else errors.push('Reel has no audio track (voiceover missing)');
    } else if (audio.codec_name !== 'aac') {
      errors.push(`Reel audio codec must be aac, got ${audio.codec_name}`);
    }
    if (video && (video.width !== REEL.width || video.height !== REEL.height)) errors.push(`ffprobe dimensions must be ${REEL.width}x${REEL.height}`);
    const duration = Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration < MIN_REEL_SECONDS || duration > MAX_REEL_SECONDS) {
      errors.push(`Reel duration must be ${MIN_REEL_SECONDS}-${MAX_REEL_SECONDS}s, got ${Number.isFinite(duration) ? duration.toFixed(1) : 'unknown'}`);
    }
  } catch (error) {
    // Storage/ffprobe hiccups are transient: let the runtime retry the stage.
    throw Object.assign(new Error(`Rendered media probe failed: ${error instanceof Error ? error.message : String(error)}`), { code: 'PROBE_FAILED' });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
  return { errors, warnings };
}

