import { z } from 'zod';

const NonEmptyTextSchema = z.string().trim().min(1);
const HttpUrlSchema = z.string().url().refine(
  (value) => value.startsWith('https://') || value.startsWith('http://'),
  'Expected an HTTP(S) URL',
);
const MediaLocationSchema = z.string().refine((value) => {
  if (value.startsWith('storage://')) return value.length > 'storage://'.length;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}, 'Expected an HTTP(S) or storage URL');

export const SceneArtifactSchema = z.object({
  sceneIndex: z.number().int().positive(),
  kind: z.enum(['image', 'video', 'audio']),
  url: HttpUrlSchema,
  provider: NonEmptyTextSchema,
  providerPredictionId: NonEmptyTextSchema.optional(),
  mimeType: NonEmptyTextSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  metadata: z.record(z.unknown()).default({}),
}).strict();

export type SceneArtifact = z.infer<typeof SceneArtifactSchema>;

export const MediaManifestSchema = z.object({
  schemaVersion: z.literal(1),
  contentItemId: NonEmptyTextSchema,
  artifacts: z.array(SceneArtifactSchema).min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((manifest, context) => {
  const keys = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const key = `${artifact.sceneIndex}:${artifact.kind}`;
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: `Duplicate artifact for scene ${artifact.sceneIndex} and kind ${artifact.kind}`,
      });
    }
    keys.add(key);
  }
});

export type MediaManifest = z.infer<typeof MediaManifestSchema>;

const RenderedOutputSchema = z.object({
  url: MediaLocationSchema,
  mimeType: NonEmptyTextSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  // Required for video; absent for still images.
  durationSeconds: z.number().positive().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
}).strict();

export type RenderedOutput = z.infer<typeof RenderedOutputSchema>;

export const RenderManifestSchema = z.object({
  schemaVersion: z.literal(1),
  contentItemId: NonEmptyTextSchema,
  mediaManifest: MediaManifestSchema,
  /** Primary output: the reel video, or the first slide of an image post. */
  output: RenderedOutputSchema,
  /** Every slide of an image post, in publishing order. */
  slides: z.array(RenderedOutputSchema).optional(),
  renderedAt: z.string().datetime({ offset: true }),
  renderer: NonEmptyTextSchema,
}).strict();

export type RenderManifest = z.infer<typeof RenderManifestSchema>;
