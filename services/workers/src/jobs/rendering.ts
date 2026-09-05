/**
 * Rendering Worker
 * Composes final video with FFmpeg - adds subtitles, logo, music
 */

import { Job } from 'bullmq';
import { supabase, storage } from '@viralforge/supabase';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

const TEMP_DIR = process.env.TEMP_DIR || '/tmp/viralforge';

export async function renderingWorker(job: Job) {
  const { contentItemId } = job.data;

  console.log(`[Rendering] Starting rendering for content ${contentItemId}`);

  try {
    await job.updateProgress(10);

    // Get content item with all data
    const { data: contentItem, error: fetchError } = await supabase
      .from('content_items')
      .select('*, niche_profiles(*)')
      .eq('id', contentItemId)
      .single();

    if (fetchError || !contentItem) {
      throw new Error(`Content item not found: ${contentItemId}`);
    }

    await job.updateProgress(20);

    // Ensure temp directory exists
    await fs.mkdir(TEMP_DIR, { recursive: true });

    // Download source media
    const mediaUrl = contentItem.ai_generation_metadata?.mediaUrl;
    if (!mediaUrl) {
      throw new Error('No source media URL found');
    }

    const sourcePath = path.join(TEMP_DIR, `source-${contentItemId}.mp4`);
    const { data: mediaData, error: downloadError } = await storage
      .from('viralforge-content')
      .download(mediaUrl);

    if (downloadError) {
      throw new Error(`Failed to download source media: ${downloadError.message}`);
    }

    await fs.writeFile(sourcePath, Buffer.from(await mediaData.arrayBuffer()));

    await job.updateProgress(40);

    // Download music if specified
    let musicPath: string | null = null;
    if (contentItem.background_music) {
      musicPath = path.join(TEMP_DIR, `music-${contentItemId}.mp3`);
      const { data: musicData } = await storage
        .from('viralforge-content')
        .download(`music/${contentItem.background_music}.mp3`);

      if (musicData) {
        await fs.writeFile(musicPath, Buffer.from(await musicData.arrayBuffer()));
      } else {
        musicPath = null;
      }
    }

    await job.updateProgress(50);

    // Download logo
    const logoPath = path.join(TEMP_DIR, `logo-${contentItemId}.png`);
    const logoUrl = contentItem.niche_profiles?.brand_logo_url;

    if (logoUrl) {
      try {
        const { data: logoData } = await storage
          .from('viralforge-content')
          .download(logoUrl);

        if (logoData) {
          await fs.writeFile(logoPath, Buffer.from(await logoData.arrayBuffer()));
        }
      } catch (e) {
        console.warn('Logo download failed, skipping watermark');
      }
    }

    await job.updateProgress(60);

    // Generate subtitle file from script
    const subtitlePath = path.join(TEMP_DIR, `subs-${contentItemId}.srt`);
    await generateSubtitles(contentItem.script_body, subtitlePath);

    await job.updateProgress(70);

    // Render final video with FFmpeg
    const outputPath = path.join(TEMP_DIR, `output-${contentItemId}.mp4`);
    await renderVideo({
      sourcePath,
      outputPath,
      subtitlePath,
      musicPath,
      logoPath: fs.existsSync(logoPath) ? logoPath : null,
      contentItem,
    });

    await job.updateProgress(90);

    // Upload rendered video
    const outputBuffer = await fs.readFile(outputPath);
    const finalPath = `${contentItem.niche_id}/${contentItemId}/final-${Date.now()}.mp4`;

    const { data: uploadData, error: uploadError } = await storage
      .from('viralforge-content')
      .upload(finalPath, outputBuffer, {
        contentType: 'video/mp4',
        cacheControl: '31536000',
      });

    if (uploadError) {
      throw new Error(`Failed to upload rendered video: ${uploadError.message}`);
    }

    await job.updateProgress(100);

    // Update content item
    await supabase
      .from('content_items')
      .update({
        status: 'validated',
        rendering_manifest: {
          finalMediaUrl: uploadData.path,
          duration: contentItem.data_input_payload?.duration || 30,
          codec: 'h264',
          resolution: '1080x1920',
          renderedAt: new Date().toISOString(),
        },
      })
      .eq('id', contentItemId);

    // Clean up temp files
    await cleanupFiles([sourcePath, subtitlePath, outputPath, musicPath, logoPath].filter(Boolean) as string[]);

    // Log audit event
    await logAuditEvent(contentItemId, 'rendering.completed', {
      outputPath: uploadData.path,
    });

    console.log(`[Rendering] Rendering completed for content ${contentItemId}`);

    return {
      success: true,
      contentItemId,
      outputPath: uploadData.path,
    };
  } catch (error) {
    console.error(`[Rendering] Error for content ${contentItemId}:`, error);

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
 * Render video with FFmpeg
 */
async function renderVideo(params: {
  sourcePath: string;
  outputPath: string;
  subtitlePath: string;
  musicPath: string | null;
  logoPath: string | null;
  contentItem: any;
}) {
  const { sourcePath, outputPath, subtitlePath, musicPath, logoPath, contentItem } = params;

  // Build FFmpeg command
  let command = `ffmpeg -y -i "${sourcePath}" `;

  // Add music if available (mixed at 25% volume)
  if (musicPath) {
    command += `-i "${musicPath}" `;
  }

  // Add logo if available
  if (logoPath) {
    command += `-i "${logoPath}" `;
  }

  // Build filter complex for compositing
  const filters: string[] = [];

  // Base video settings: 9:16 vertical, 1080x1920
  filters.push('[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[v0]');

  // Add subtitles
  filters.push(`[v0]subtitles=${subtitlePath}:force_style='FontName=Noto Sans Devanagari,FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,BorderStyle=3,Outline=2,Alignment=2'[v1]`);

  let lastVideo = '[v1]';

  // Add logo overlay
  if (logoPath) {
    const logoIndex = musicPath ? 2 : 1;
    filters.push(`[${logoIndex}:v]scale=120:-1[logo]`);
    filters.push(`${lastVideo}[logo]overlay=30:30[outv]`);
    lastVideo = '[outv]';
  } else {
    filters.push(`${lastVideo}null[outv]`);
  }

  command += `-filter_complex "${filters.join(';')}" -map "${lastVideo}" `;

  // Audio mixing
  if (musicPath) {
    // Mix original audio (voiceover) with music at 25% volume
    command += `-map 0:a -map 1:a -filter_complex "[0:a]volume=1.0[vo];[1:a]volume=0.25[music];[vo][music]amix=inputs=2:duration=longest[outa]" -map "[outa]" `;
  } else {
    command += `-map 0:a `;
  }

  // Output settings
  command += `-c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`;

  console.log(`[Rendering] FFmpeg command: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });

    if (stderr) {
      console.log('[FFmpeg stderr]:', stderr.substring(stderr.length - 500));
    }
  } catch (error: any) {
    console.error('[FFmpeg] Rendering failed:', error.message);
    throw new Error(`Video rendering failed: ${error.message}`);
  }
}

/**
 * Generate SRT subtitle file from script text
 */
async function generateSubtitles(script: string, outputPath: string): Promise<void> {
  // Split script into words and time them
  const words = script.split(/\s+/).filter(w => w.length > 0);
  const totalWords = words.length;
  const totalDuration = 45; // seconds
  const secondsPerWord = totalDuration / totalWords;

  // Group words into subtitle chunks (4-5 words each)
  const chunkSize = 5;
  const chunks: string[][] = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize));
  }

  let srtContent = '';
  chunks.forEach((chunk, index) => {
    const startTime = index * chunkSize * secondsPerWord;
    const endTime = (index + 1) * chunkSize * secondsPerWord;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatSrtTime(startTime)} --> ${formatSrtTime(Math.min(endTime, totalDuration))}\n`;
    srtContent += `${chunk.join(' ')}\n\n`;
  });

  await fs.writeFile(outputPath, srtContent, 'utf-8');
}

/**
 * Format seconds to SRT time format
 */
function formatSrtTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

/**
 * Clean up temporary files
 */
async function cleanupFiles(files: string[]): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      try {
        await fs.unlink(file);
      } catch (e) {
        // File might not exist, ignore
      }
    })
  );
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

export { renderingWorker };