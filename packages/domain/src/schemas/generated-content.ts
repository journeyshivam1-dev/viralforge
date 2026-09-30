import { z } from 'zod';

const NonEmptyTextSchema = z.string().trim().min(1);

export const ScenePlanSchema = z.object({
  index: z.number().int().positive(),
  durationSeconds: z.number().positive().max(300),
  voiceover: NonEmptyTextSchema,
  onScreenText: z.string().trim(),
  visualPrompt: NonEmptyTextSchema,
  negativePrompt: z.string().trim().optional(),
  mediaType: z.enum(['image', 'video']).default('image'),
}).strict();

export type ScenePlan = z.infer<typeof ScenePlanSchema>;

export const GeneratedContentPackageSchema = z.object({
  schemaVersion: z.literal(1),
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
