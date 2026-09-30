import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { MediaManifestSchema, RenderManifestSchema, type SceneArtifact } from '@viralforge/domain';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);
const supabase = requireSupabaseAdmin();
const storage = supabase.storage;
const TEMP_DIR = process.env.TEMP_DIR || path.join(os.tmpdir(), 'viralforge');

export async function renderingWorker(job: Job) {
  const { contentItemId } = job.data as { contentItemId: string };
  const workDir = path.join(TEMP_DIR, `${contentItemId}-${job.id || Date.now()}`);

  try {
    const { data: contentItem, error } = await supabase
      .from('content_items')
      .select('*')
      .eq('id', contentItemId)
      .single();
    if (error || !contentItem) throw new Error(`Content item not found: ${contentItemId}`);

    const parsed = MediaManifestSchema.safeParse(contentItem.ai_generation_metadata?.mediaManifest);
    if (!parsed.success) throw new Error('Valid media manifest is required before rendering');
    const mediaManifest = parsed.data;
    const artifacts = [...mediaManifest.artifacts].sort((a, b) => a.sceneIndex - b.sceneIndex);
    if (artifacts.length === 0) throw new Error('Media manifest contains no artifacts');

    await fs.mkdir(workDir, { recursive: true });
    await job.updateProgress(10);

    const sourcePaths: string[] = [];
    for (const artifact of artifacts) {
      const storagePath = String(artifact.metadata?.storagePath || '');
      if (!storagePath) throw new Error(`Scene ${artifact.sceneIndex} has no private storage path`);
      const extension = artifact.kind === 'video' ? 'mp4' : mimeExtension(artifact.mimeType);
      const localPath = path.join(workDir, `scene-${artifact.sceneIndex}.${extension}`);
      const { data, error: downloadError } = await storage.from('viralforge-content').download(storagePath);
      if (downloadError || !data) throw new Error(`Failed to download scene ${artifact.sceneIndex}: ${downloadError?.message}`);
      await fs.writeFile(localPath, Buffer.from(await data.arrayBuffer()));
      sourcePaths.push(localPath);
    }

    const generatedScenes = contentItem.ai_generation_metadata?.generatedContent?.scenes
      || contentItem.ai_generation_metadata?.scenes
      || [];
    const durations = artifacts.map((artifact) => {
      const scene = generatedScenes.find((candidate: any) => Number(candidate.index) === artifact.sceneIndex);
      return Math.max(1, Number(artifact.durationSeconds || scene?.durationSeconds || 4));
    });
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);

    const subtitlePath = path.join(workDir, 'subtitles.srt');
    await writeSceneSubtitles(generatedScenes, contentItem.script_body || '', durations, subtitlePath);

    const outputPath = path.join(workDir, 'final.mp4');
    await renderSequence(sourcePaths, artifacts, durations, subtitlePath, outputPath);
    await job.updateProgress(85);

    const outputBuffer = await fs.readFile(outputPath);
    const finalStoragePath = `media/${contentItemId}/final.mp4`;
    const { error: uploadError } = await storage.from('viralforge-content').upload(
      finalStoragePath,
      outputBuffer,
      { contentType: 'video/mp4', cacheControl: '31536000', upsert: true },
    );
    if (uploadError) throw new Error(`Failed to upload rendered video: ${uploadError.message}`);

    const renderManifest = RenderManifestSchema.parse({
      schemaVersion: 1,
      contentItemId,
      mediaManifest,
      output: {
        url: `storage://viralforge-content/${finalStoragePath}`,
        mimeType: 'video/mp4',
        width: 1080,
        height: 1920,
        durationSeconds: totalDuration,
        sizeBytes: outputBuffer.length,
      },
      renderedAt: new Date().toISOString(),
      renderer: 'ffmpeg-scene-sequence-v1',
    });

    const { error: updateError } = await supabase.from('content_items').update({
      status: 'rendering',
      rendering_manifest: {
        ...renderManifest,
        finalMediaUrl: `storage://viralforge-content/${finalStoragePath}`,
        duration: totalDuration,
        codec: 'h264',
        resolution: '1080x1920',
      },
      validation_errors: [],
    }).eq('id', contentItemId);
    if (updateError) throw new Error(`Failed to persist render manifest: ${updateError.message}`);

    await job.updateProgress(100);
    await logAuditEvent(contentItemId, 'rendering.completed', {
      outputPath: finalStoragePath,
      sceneCount: artifacts.length,
      durationSeconds: totalDuration,
    });

    return { success: true, contentItemId, outputPath: finalStoragePath, renderManifest };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function renderSequence(
  sourcePaths: string[],
  artifacts: SceneArtifact[],
  durations: number[],
  subtitlePath: string,
  outputPath: string,
): Promise<void> {
  const args: string[] = ['-y'];
  sourcePaths.forEach((sourcePath, index) => {
    if (artifacts[index].kind === 'image') {
      args.push('-loop', '1', '-t', String(durations[index]), '-i', sourcePath);
    } else {
      args.push('-i', sourcePath);
    }
  });

  const filters = sourcePaths.map((_, index) =>
    `[${index}:v]scale=1080:1920:force_original_aspect_ratio=decrease,`+
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,`+
    `trim=duration=${durations[index]},setpts=PTS-STARTPTS[v${index}]`,
  );
  const inputs = sourcePaths.map((_, index) => `[v${index}]`).join('');
  filters.push(`${inputs}concat=n=${sourcePaths.length}:v=1:a=0[concatv]`);
  filters.push(`[concatv]subtitles=${escapeFilterPath(subtitlePath)}:`+
    `force_style='FontName=Noto Sans Devanagari,FontSize=24,PrimaryColour=&HFFFFFF,`+
    `OutlineColour=&H000000,BorderStyle=3,Outline=2,Alignment=2'[outv]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  );

  try {
    await execFileAsync('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 });
  } catch (error: any) {
    throw new Error(`Video rendering failed: ${error.stderr || error.message}`);
  }
}

async function writeSceneSubtitles(
  scenes: any[],
  fallbackScript: string,
  durations: number[],
  outputPath: string,
): Promise<void> {
  let cursor = 0;
  const lines: string[] = [];
  if (scenes.length > 0) {
    scenes.slice(0, durations.length).forEach((scene, index) => {
      const end = cursor + durations[index];
      const text = String(scene.onScreenText || scene.voiceover || '').trim();
      if (text) lines.push(`${index + 1}\n${formatSrtTime(cursor)} --> ${formatSrtTime(end)}\n${text}\n`);
      cursor = end;
    });
  }
  if (lines.length === 0) {
    lines.push(`1\n${formatSrtTime(0)} --> ${formatSrtTime(durations.reduce((a, b) => a + b, 0))}\n${fallbackScript}\n`);
  }
  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
}

function mimeExtension(mimeType?: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function formatSrtTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`+
    `${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

async function logAuditEvent(contentItemId: string, action: string, metadata: Record<string, unknown>) {
  await supabase.from('audit_logs').insert({
    content_item_id: contentItemId,
    action,
    actor: 'system',
    actor_type: 'system',
    metadata,
  });
}
