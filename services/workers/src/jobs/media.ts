/**
 * Media Worker
 * Generates per-scene images via Replicate, checkpoints artifacts, and builds a MediaManifest.
 * Replaces the legacy Omniroute-based media generation.
 */

import { Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  GeneratedContentPackageSchema,
  SceneArtifactSchema,
  MediaManifestSchema,
  type GeneratedContentPackage,
  type SceneArtifact,
  type MediaManifest,
  type ScenePlan,
} from '@viralforge/domain';
import { createReplicateAdapter, MediaProviderError, MediaProviderErrorClassification } from '@viralforge/domain';

const supabase = requireSupabaseAdmin();
const storage = supabase.storage;

// Initialize Replicate adapter from environment
let replicateAdapter: ReturnType<typeof createReplicateAdapter> | null = null;

function getReplicateAdapter() {
  if (replicateAdapter) return replicateAdapter;

  const apiToken = process.env.REPLICATE_API_TOKEN?.trim();
  const imageModelVersion = process.env.REPLICATE_IMAGE_MODEL_VERSION?.trim();
  const videoModelVersion = process.env.REPLICATE_VIDEO_MODEL_VERSION?.trim() || undefined;
  const timeoutMs = parseInt(process.env.REPLICATE_TIMEOUT_MS || '120000', 10);

  if (!apiToken || !imageModelVersion) {
    throw new MediaProviderError(
      'Replicate is not configured: set REPLICATE_API_TOKEN and REPLICATE_IMAGE_MODEL_VERSION',
      'blocked' as MediaProviderErrorClassification,
    );
  }

  replicateAdapter = createReplicateAdapter({
    apiToken,
    image: { version: imageModelVersion },
    video: videoModelVersion ? { version: videoModelVersion } : undefined,
    timeoutMs,
  });
  return replicateAdapter;
}

const MAX_CONCURRENT_SCENES = Number(process.env.MEDIA_MAX_CONCURRENT_SCENES || 2);
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

async function downloadWithLimits(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    const contentType = response.headers.get('content-type') || '';
    const mimeType = contentType.split(';')[0].trim();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds size limit');
        chunks.push(value);
      }
    }
    const buffer = Buffer.concat(chunks);
    return { buffer, mimeType };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getStoragePath(contentItemId: string, sceneIndex: number, kind: 'image' | 'video', attemptNo: number): string {
  const ext = kind === 'video' ? 'mp4' : 'jpg';
  return `media/${contentItemId}/scene-${sceneIndex}-attempt-${attemptNo}.${ext}`;
}

async function uploadArtifact(
  contentItemId: string,
  sceneIndex: number,
  kind: 'image' | 'video',
  attemptNo: number,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const path = getStoragePath(contentItemId, sceneIndex, kind, attemptNo);
  const { error } = await storage.from('viralforge-content').upload(path, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

function validateSceneArtifact(artifact: unknown): SceneArtifact {
  const result = SceneArtifactSchema.safeParse(artifact);
  if (!result.success) {
    throw new Error(`Invalid SceneArtifact: ${result.error.flatten().formErrors.join(', ')}`);
  }
  return result.data;
}

function validateMediaManifest(manifest: unknown): MediaManifest {
  const result = MediaManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new Error(`Invalid MediaManifest: ${result.error.flatten().formErrors.join(', ')}`);
  }
  return result.data;
}

async function getContentItem(contentItemId: string) {
  const { data, error } = await supabase
    .from('content_items')
    .select('*, ai_generation_metadata')
    .eq('id', contentItemId)
    .single();
  if (error || !data) throw new Error(`Content item not found: ${contentItemId}`);
  return data;
}

async function updateContentItemAiMetadata(contentItemId: string, metadata: Record<string, unknown>) {
  const { error } = await supabase
    .from('content_items')
    .update({ ai_generation_metadata: metadata })
    .eq('id', contentItemId);
  if (error) throw new Error(`Failed to update content item: ${error.message}`);
}

export async function mediaWorker(job: Job) {
  const { contentItemId } = job.data as { contentItemId: string };
  const workerId = `${process.env.HOSTNAME || 'worker'}-media-${job.id}`;

  console.log(`[Media] Starting per-scene media generation for ${contentItemId}`);

  try {
    await job.updateProgress(5);

    // Fetch content item and validate generated content
    const contentItem = await getContentItem(contentItemId);
    const genMeta = contentItem.ai_generation_metadata || {};

    const genResult = GeneratedContentPackageSchema.safeParse(genMeta.generatedContent || genMeta);
    if (!genResult.success) {
      throw new Error(`Generated content missing or invalid: ${genResult.error.flatten().formErrors.join(', ')}`);
    }
    const generatedContent: GeneratedContentPackage = genResult.data;

    const existingArtifacts: SceneArtifact[] = Array.isArray(genMeta.sceneArtifacts)
      ? genMeta.sceneArtifacts.filter((a: unknown) => SceneArtifactSchema.safeParse(a).success)
      : [];

    const scenes: ScenePlan[] = generatedContent.scenes;
    if (scenes.length === 0) throw new Error('No scenes found in generated content');

    // Initialize adapter (throws blocked if not configured)
    const adapter = getReplicateAdapter();

    // Generate missing scene artifacts
    const allArtifacts: SceneArtifact[] = [...existingArtifacts];
    const generatedSceneIndices = new Set(existingArtifacts.map((a) => a.sceneIndex));

    for (let i = 0; i < scenes.length; i += MAX_CONCURRENT_SCENES) {
      const batch = scenes.slice(i, i + MAX_CONCURRENT_SCENES);
      await Promise.all(
        batch.map(async (scene) => {
          if (generatedSceneIndices.has(scene.index)) return;

          const attemptNo = 1; // For simplicity; could track per-scene retries later

          const result = await adapter.generate({
            sceneIndex: scene.index,
            kind: 'image', // image-only first; video fallback gated by config
            prompt: scene.visualPrompt,
            negativePrompt: scene.negativePrompt,
            width: 1080,
            height: 1920,
          });

          // Take first returned artifact for this scene
          const artifact = result[0];
          if (!artifact) throw new Error(`No artifact returned for scene ${scene.index}`);

          const validatedArtifact = validateSceneArtifact(artifact);

          // Download and upload
          const { buffer, mimeType } = await downloadWithLimits(validatedArtifact.url);
          if (!ALLOWED_IMAGE_MIME.has(mimeType)) throw new Error(`Unsupported MIME type: ${mimeType}`);

          const storagePath = await uploadArtifact(contentItemId, scene.index, 'image', attemptNo, buffer, mimeType);

          // Construct a signed URL for the artifact record (uses service-role, so accessible)
          const { data: signed } = await storage.from('viralforge-content').createSignedUrl(storagePath, 60 * 60 * 24 * 365);
          const artifactUrl = signed?.signedUrl || storagePath;

          const finalArtifact: SceneArtifact = {
            ...validatedArtifact,
            url: artifactUrl,
            mimeType,
            width: 1080,
            height: 1920,
            metadata: {
              ...validatedArtifact.metadata,
              storagePath,
              downloadSizeBytes: buffer.length,
            },
          };

          allArtifacts.push(finalArtifact);
          generatedSceneIndices.add(scene.index);

          // Persist partial progress
          const updatedMeta = { ...genMeta, sceneArtifacts: allArtifacts };
          await updateContentItemAiMetadata(contentItemId, updatedMeta);
        }),
      );

      await job.updateProgress(20 + Math.round((i + batch.length) / scenes.length * 70));
    }

    // Build MediaManifest
    const mediaManifest: MediaManifest = validateMediaManifest({
      schemaVersion: 1,
      contentItemId,
      artifacts: allArtifacts.sort((a, b) => a.sceneIndex - b.sceneIndex),
      createdAt: new Date().toISOString(),
    });

    // Persist final manifest
    const finalMeta = { ...genMeta, sceneArtifacts: allArtifacts, mediaManifest };
    await updateContentItemAiMetadata(contentItemId, finalMeta);

    await job.updateProgress(100);
    console.log(`[Media] Completed ${allArtifacts.length} scene artifacts for ${contentItemId}`);

    return { success: true, contentItemId, artifactCount: allArtifacts.length };
  } catch (error) {
    console.error(`[Media] Error for ${contentItemId}:`, error);
    if (error instanceof MediaProviderError) {
      // Attach classification for runtime to handle correctly
      throw error;
    }
    throw error;
  }
}