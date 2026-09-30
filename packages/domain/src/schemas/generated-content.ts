import { z } from 'zod';

const NonEmptyTextSchema = z.string().trim().min(1);

export const ScenePlanSchema = z.object({
  index: z.number().int().positive(),
  durationSeconds: z.number().positive().max(300),
  // Required for reels (validated per media type); carousels and single images have none.
  voiceover: z.string().trim().default(''),
  onScreenText: z.string().trim(),
  /** Carousel slide body copy rendered under the headline. */
  bodyText: z.string().trim().max(400).optional(),
  visualPrompt: NonEmptyTextSchema,
  negativePrompt: z.string().trim().optional(),
  mediaType: z.enum(['image', 'video']).default('image'),
}).strict();

export type ScenePlan = z.infer<typeof ScenePlanSchema>;

export const GeneratedContentPackageSchema = z.object({
  schemaVersion: z.literal(1),
  /** Shared art direction prepended to every scene prompt for visual consistency. */
  visualStyle: z.string().trim().max(600).optional(),
  primaryHook: NonEmptyTextSchema,
  alternateHooks: z.array(NonEmptyTextSchema).default([]),
  script: NonEmptyTextSchema,
  caption: NonEmptyTextSchema,
  hashtags: z.array(NonEmptyTextSchema).default([]),
  cta: NonEmptyTextSchema,
  scenes: z.array(ScenePlanSchema).min(1),
  disclosures: z.array(NonEmptyTextSchema).default([]),
}).strict().superRefine((content, context) => {
  const indexes = new Set<number>();
  for (const scene of content.scenes) {
    if (indexes.has(scene.index)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenes'],
        message: `Scene index ${scene.index} is duplicated`,
      });
    }
    indexes.add(scene.index);
  }
});

export type GeneratedContentPackage = z.infer<typeof GeneratedContentPackageSchema>;

export type PackageMediaType = 'video_reel' | 'image_carousel' | 'image_single';

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.map((entry) => cleanText(entry, maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}

/** Lowercase, de-duplicated, '#'-prefixed tags; capped below Instagram's 30-tag limit. */
export function normalizeHashtags(value: unknown, max = 25): string[] {
  const seen = new Set<string>();
  for (const raw of cleanTextList(value, 60, 60)) {
    const tag = `#${raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase()}`;
    if (tag.length > 2) seen.add(tag);
  }
  return [...seen].slice(0, max);
}

/**
 * Coerces untrusted model JSON into a GeneratedContentPackage. Scene indexes are
 * renumbered and durations clamped; throws if required fields are missing.
 */
export function normalizeGeneratedPackage(raw: Record<string, unknown>, mediaType: PackageMediaType): GeneratedContentPackage {
  const scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
  const limit = mediaType === 'image_single' ? 1 : mediaType === 'image_carousel' ? 7 : 8;
  return GeneratedContentPackageSchema.parse({
    schemaVersion: 1,
    primaryHook: cleanText(raw.primaryHook, 200),
    alternateHooks: cleanTextList(raw.alternateHooks, 3, 200),
    script: cleanText(raw.script, 4000)
      || scenes.map((scene: any) => cleanText(scene?.voiceover || scene?.onScreenText, 300)).filter(Boolean).join(' '),
    caption: cleanText(raw.caption, 1500),
    hashtags: normalizeHashtags(raw.hashtags),
    cta: cleanText(raw.cta, 200),
    visualStyle: cleanText(raw.visualStyle, 600) || undefined,
    scenes: scenes.slice(0, limit).map((scene: any, index: number) => ({
      index: index + 1,
      durationSeconds: mediaType === 'video_reel' ? Math.min(8, Math.max(2, Number(scene?.durationSeconds) || 4)) : 5,
      voiceover: mediaType === 'video_reel' ? cleanText(scene?.voiceover, 400) : '',
      onScreenText: cleanText(scene?.onScreenText, 120),
      bodyText: mediaType === 'video_reel' ? undefined : cleanText(scene?.bodyText, 400) || undefined,
      visualPrompt: cleanText(scene?.visualPrompt, 1500),
      mediaType: 'image',
    })),
    disclosures: cleanTextList(raw.disclosures, 5, 300),
  });
}

export function validatePackageForMediaType(content: GeneratedContentPackage, mediaType: PackageMediaType): string[] {
  const problems: string[] = [];
  if (content.hashtags.length < 5) problems.push('at least 5 hashtags are required');
  if (mediaType === 'video_reel') {
    if (content.scenes.length < 3) problems.push('reels need at least 3 scenes');
    if (content.scenes.some((scene) => !scene.voiceover)) problems.push('every reel scene needs voiceover');
  } else if (mediaType === 'image_carousel') {
    if (content.scenes.length < 3) problems.push('carousels need at least 3 slides');
    if (content.scenes.some((scene) => !scene.onScreenText)) problems.push('every slide needs a headline');
  } else if (content.scenes.length !== 1) {
    problems.push('single image posts need exactly 1 scene');
  }
  return problems;
}
