/**
 * Media Worker
 * Generates per-scene images (all media types) and per-scene Hindi voiceover
 * (reels) through the AI provider chain: Omniroute, then Gemini, then Replicate
 * when configured. Every artifact is checkpointed into
 * ai_generation_metadata.sceneArtifacts as soon as it is stored, so a retry only
 * generates what is still missing.
 */

import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  GeneratedContentPackageSchema,
  MediaManifestSchema,
  SceneArtifactSchema,
  createAiProviderChainFromEnv,
  type BinaryOutput,
  type MediaManifest,
  type MediaType,
  type SceneArtifact,
  type ScenePlan,
} from '@viralforge/domain';

const supabase = requireSupabaseAdmin();
const storage = supabase.storage;
const aiChain = createAiProviderChainFromEnv();
const BUCKET = 'viralforge-content';

const MAX_CONCURRENT_SCENES = Math.max(1, Number(process.env.MEDIA_MAX_CONCURRENT_SCENES || 2));
const MAX_ARTIFACT_BYTES = Number(process.env.MEDIA_DOWNLOAD_MAX_BYTES || 50 * 1024 * 1024);
const TTS_LANGUAGE = process.env.TTS_LANGUAGE || 'hi-IN';
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/aac', 'audio/mp4']);
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 30;

type ArtifactKind = 'image' | 'audio';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
};

export async function mediaWorker(job: Job) {
  const { contentItemId } = job.data as { contentItemId: string };

  const { data: item, error } = await supabase
    .from('content_items')
    .select('id, organization_id, niche_id, media_type, ai_generation_metadata')
    .eq('id', contentItemId)
    .single();
  if (error || !item) throw Object.assign(new Error(`Content item not found: ${contentItemId}`), { code: 'NOT_FOUND' });

  const metadata = (item.ai_generation_metadata || {}) as Record<string, any>;
  const parsed = GeneratedContentPackageSchema.safeParse(metadata.generatedContent);
  if (!parsed.success) {
    // Generation output is missing: the operator must retry generation, not media.
    return { success: false, blocked: true, code: 'GENERATED_CONTENT_MISSING', reason: 'Generated content package is missing or invalid; retry from generation' };
  }
  const generated = parsed.data;
  const mediaType = (item.media_type || 'video_reel') as MediaType;
  const aspectRatio = mediaType === 'video_reel' ? '9:16' : '4:5';

  const artifacts = new Map<string, SceneArtifact>();
  for (const candidate of Array.isArray(metadata.sceneArtifacts) ? metadata.sceneArtifacts : []) {
    const valid = SceneArtifactSchema.safeParse(candidate);
    if (valid.success && valid.data.metadata?.storagePath) artifacts.set(key(valid.data.sceneIndex, valid.data.kind as ArtifactKind), valid.data);
  }

  const work: Array<{ scene: ScenePlan; kind: ArtifactKind }> = [];
  for (const scene of generated.scenes) {
    if (!artifacts.has(key(scene.index, 'image'))) work.push({ scene, kind: 'image' });
    if (mediaType === 'video_reel' && scene.voiceover && !artifacts.has(key(scene.index, 'audio'))) work.push({ scene, kind: 'audio' });
  }

  let completed = 0;
  const freshUsage: Array<Record<string, unknown>> = [];
  // Serialize checkpoint writes so concurrent scenes never overwrite each other.
  let checkpoint = Promise.resolve();
  const persist = () => {
    checkpoint = checkpoint.then(() => saveMetadata(contentItemId, { ...metadata, sceneArtifacts: sorted(artifacts) }));
    return checkpoint;
  };

  for (let index = 0; index < work.length; index += MAX_CONCURRENT_SCENES) {
    const batch = work.slice(index, index + MAX_CONCURRENT_SCENES);
    const results = await Promise.allSettled(batch.map(async ({ scene, kind }) => {
      const output = kind === 'image'
        ? await aiChain.generateImage({
            prompt: [generated.visualStyle, scene.visualPrompt, 'No text, letters, watermarks or logos.'].filter(Boolean).join(' '),
            negativePrompt: scene.negativePrompt,
            aspectRatio,
          })
        : await aiChain.generateSpeech({ text: scene.voiceover, language: TTS_LANGUAGE });
      const artifact = await storeArtifact(contentItemId, scene.index, kind, output);
      artifacts.set(key(scene.index, kind), artifact);
      freshUsage.push({ stage: 'media', kind, sceneIndex: scene.index, provider: output.provider, model: output.model });
      await persist();
    }));
    completed += batch.length;
    await job.updateProgress(10 + Math.round((completed / Math.max(1, work.length)) * 80));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    // Successful siblings are already checkpointed; the retry resumes from here.
    if (failure) throw failure.reason;
  }
  await checkpoint;

  const mediaManifest: MediaManifest = MediaManifestSchema.parse({
    schemaVersion: 1,
    contentItemId,
    artifacts: sorted(artifacts),
    createdAt: new Date().toISOString(),
  });
  await saveMetadata(contentItemId, {
    ...metadata,
    sceneArtifacts: mediaManifest.artifacts,
    mediaManifest,
    usage: [...(metadata.usage || []), ...freshUsage],
  });

  await job.updateProgress(100);
  return {
    success: true,
    contentItemId,
    images: mediaManifest.artifacts.filter((artifact) => artifact.kind === 'image').length,
    audioClips: mediaManifest.artifacts.filter((artifact) => artifact.kind === 'audio').length,
    generated: work.length,
  };
}

async function storeArtifact(contentItemId: string, sceneIndex: number, kind: ArtifactKind, output: BinaryOutput & { fallbackAttempts?: unknown[] }): Promise<SceneArtifact> {
  const allowed = kind === 'image' ? ALLOWED_IMAGE_MIME : ALLOWED_AUDIO_MIME;
  if (!allowed.has(output.mimeType)) {
    throw Object.assign(new Error(`${output.provider} returned unsupported ${kind} type ${output.mimeType}`), { code: 'UNSUPPORTED_MEDIA' });
  }
  if (output.buffer.length === 0 || output.buffer.length > MAX_ARTIFACT_BYTES) {
    throw Object.assign(new Error(`${kind} for scene ${sceneIndex} has invalid size ${output.buffer.length}`), { code: 'INVALID_MEDIA_SIZE' });
  }

  const storagePath = `media/${contentItemId}/scene-${sceneIndex}-${kind}.${EXTENSIONS[output.mimeType] || 'bin'}`;
  // upsert keeps retries idempotent when a previous attempt uploaded but did not checkpoint.
  const { error } = await storage.from(BUCKET).upload(storagePath, output.buffer, { contentType: output.mimeType, upsert: true });
  if (error) throw new Error(`Upload failed for scene ${sceneIndex} ${kind}: ${error.message}`);
  const { data: signed, error: signError } = await storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  if (signError || !signed?.signedUrl) throw new Error(`Could not sign scene ${sceneIndex} ${kind}: ${signError?.message}`);

  return SceneArtifactSchema.parse({
    sceneIndex,
    kind,
    url: signed.signedUrl,
    provider: output.provider,
    mimeType: output.mimeType,
    metadata: {
      storagePath,
      model: output.model,
      sizeBytes: output.buffer.length,
      fallbackAttempts: output.fallbackAttempts || [],
      generatedAt: new Date().toISOString(),
    },
  });
}

async function saveMetadata(contentItemId: string, metadata: Record<string, unknown>) {
  const { error } = await supabase.from('content_items').update({ ai_generation_metadata: metadata }).eq('id', contentItemId);
  if (error) throw new Error(`Failed to checkpoint media: ${error.message}`);
}

function key(sceneIndex: number, kind: ArtifactKind): string {
  return `${sceneIndex}:${kind}`;
}

function sorted(artifacts: Map<string, SceneArtifact>): SceneArtifact[] {
  return [...artifacts.values()].sort((a, b) => a.sceneIndex - b.sceneIndex || a.kind.localeCompare(b.kind));
}
