/**
 * Rendering Worker
 * - video_reel: Ken Burns slideshow of scene images, each scene lasting as long
 *   as its Hindi voiceover clip, with burned-in captions -> 1080x1920 H.264/AAC.
 * - image_carousel / image_single: 1080x1350 slides with headline/body overlay.
 * Composition lives in render/compose.ts; this worker handles storage and state.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  GeneratedContentPackageSchema,
  MediaManifestSchema,
  RenderManifestSchema,
  getNichePlaybook,
  type MediaType,
  type RenderedOutput,
  type SceneArtifact,
} from '@viralforge/domain';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { POST, REEL, SceneFiles, composeReel, composeSlide } from '../render/compose';

const supabase = requireSupabaseAdmin();
const storage = supabase.storage;
const BUCKET = 'viralforge-content';
const TEMP_DIR = process.env.TEMP_DIR || path.join(os.tmpdir(), 'viralforge');

export async function renderingWorker(job: Job) {
  const { contentItemId } = job.data as { contentItemId: string };
  const workDir = path.resolve(TEMP_DIR, `${contentItemId}-${job.id || Date.now()}`);

  const { data: item, error } = await supabase
    .from('content_items')
    .select('id, organization_id, niche_id, media_type, ai_generation_metadata')
    .eq('id', contentItemId)
    .single();
  if (error || !item) throw Object.assign(new Error(`Content item not found: ${contentItemId}`), { code: 'NOT_FOUND' });

  const manifestResult = MediaManifestSchema.safeParse(item.ai_generation_metadata?.mediaManifest);
  const packageResult = GeneratedContentPackageSchema.safeParse(item.ai_generation_metadata?.generatedContent);
  if (!manifestResult.success || !packageResult.success) {
    return { success: false, blocked: true, code: 'MEDIA_MISSING', reason: 'Media manifest or generated package is missing; retry from media' };
  }
  const mediaManifest = manifestResult.data;
  const scenes = [...packageResult.data.scenes].sort((a, b) => a.index - b.index);
  const mediaType = (item.media_type || 'video_reel') as MediaType;

  await fs.mkdir(workDir, { recursive: true });
  try {
    await job.updateProgress(10);
    const files = await downloadArtifacts(mediaManifest.artifacts, workDir);
    await job.updateProgress(35);

    let output: RenderedOutput;
    let slides: RenderedOutput[] | undefined;
    if (mediaType === 'video_reel') {
      const durationSeconds = await composeReel(scenes, files, workDir, 'final.mp4');
      const buffer = await fs.readFile(path.join(workDir, 'final.mp4'));
      const storagePath = `media/${contentItemId}/final.mp4`;
      await upload(storagePath, buffer, 'video/mp4');
      output = { url: `storage://${BUCKET}/${storagePath}`, mimeType: 'video/mp4', ...REEL, durationSeconds, sizeBytes: buffer.length };
    } else {
      const brand = getNichePlaybook(item.niche_id)?.displayName || item.niche_id;
      slides = [];
      for (const [position, scene] of scenes.entries()) {
        const image = files.images.get(scene.index);
        if (!image) throw new Error(`Slide ${scene.index} has no image`);
        const outName = `slide-${scene.index}.jpg`;
        await composeSlide(scene, image, position + 1, scenes.length, brand, workDir, outName);
        const buffer = await fs.readFile(path.join(workDir, outName));
        const storagePath = `media/${contentItemId}/${outName}`;
        await upload(storagePath, buffer, 'image/jpeg');
        slides.push({ url: `storage://${BUCKET}/${storagePath}`, mimeType: 'image/jpeg', ...POST, sizeBytes: buffer.length });
      }
      output = slides[0];
    }
    await job.updateProgress(85);

    const renderManifest = RenderManifestSchema.parse({
      schemaVersion: 1,
      contentItemId,
      mediaManifest,
      output,
      ...(slides ? { slides } : {}),
      renderedAt: new Date().toISOString(),
      renderer: mediaType === 'video_reel' ? 'ffmpeg-kenburns-tts-v2' : 'ffmpeg-ass-slides-v1',
    });

    const { error: updateError } = await supabase.from('content_items').update({
      status: 'rendering',
      rendering_manifest: {
        ...renderManifest,
        finalMediaUrl: output.url,
        ...(mediaType === 'video_reel'
          ? { duration: output.durationSeconds, codec: 'h264', resolution: `${REEL.width}x${REEL.height}` }
          : { resolution: `${POST.width}x${POST.height}`, slideCount: slides?.length }),
      },
      validation_errors: [],
    }).eq('id', contentItemId);
    if (updateError) throw new Error(`Failed to persist render manifest: ${updateError.message}`);

    await supabase.from('audit_logs').insert({
      organization_id: item.organization_id,
      content_item_id: contentItemId,
      niche_id: item.niche_id,
      action: 'rendering.completed',
      actor: 'system',
      actor_type: 'system',
      metadata: { mediaType, output: output.url, slides: slides?.length, durationSeconds: output.durationSeconds },
    });
    await job.updateProgress(100);
    return { success: true, contentItemId, mediaType, output: output.url, slides: slides?.length };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadArtifacts(artifacts: SceneArtifact[], workDir: string): Promise<SceneFiles> {
  const files: SceneFiles = { images: new Map(), audio: new Map() };
  for (const artifact of artifacts) {
    if (artifact.kind !== 'image' && artifact.kind !== 'audio') continue;
    const storagePath = String(artifact.metadata?.storagePath || '');
    if (!storagePath) throw new Error(`Scene ${artifact.sceneIndex} ${artifact.kind} has no storage path`);
    const { data, error } = await storage.from(BUCKET).download(storagePath);
    if (error || !data) throw new Error(`Failed to download scene ${artifact.sceneIndex} ${artifact.kind}: ${error?.message}`);
    const name = `scene-${artifact.sceneIndex}-${artifact.kind}${path.extname(storagePath) || '.bin'}`;
    await fs.writeFile(path.join(workDir, name), Buffer.from(await data.arrayBuffer()));
    (artifact.kind === 'image' ? files.images : files.audio).set(artifact.sceneIndex, name);
  }
  return files;
}

async function upload(storagePath: string, buffer: Buffer, contentType: string) {
  const { error } = await storage.from(BUCKET).upload(storagePath, buffer, { contentType, cacheControl: '31536000', upsert: true });
  if (error) throw new Error(`Failed to upload ${storagePath}: ${error.message}`);
}
