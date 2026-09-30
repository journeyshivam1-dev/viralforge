import { z } from 'zod';

const NonEmptyTextSchema = z.string().trim().min(1);

export const TOPIC_SOURCES = ['operator', 'calendar', 'google_trends', 'youtube_trending', 'llm'] as const;
export type TopicSource = typeof TOPIC_SOURCES[number];

/**
 * Planner-produced brief stored at content_items.data_input_payload.brief.
 * Items without a brief are legacy hand-made items with niche-specific fields.
 */
export const ContentBriefSchema = z.object({
  schemaVersion: z.literal(1),
  title: NonEmptyTextSchema.max(200),
  angle: NonEmptyTextSchema.max(500),
  keyPoints: z.array(NonEmptyTextSchema.max(300)).max(10).default([]),
  keywords: z.array(NonEmptyTextSchema.max(60)).max(20).default([]),
  source: z.enum(TOPIC_SOURCES),
  sourceRef: z.string().trim().max(500).optional(),
  trendContext: z.string().trim().max(1000).optional(),
  language: z.enum(['hinglish', 'hindi']).default('hinglish'),
}).strict();

export type ContentBrief = z.infer<typeof ContentBriefSchema>;

export const ResearchNotesSchema = z.object({
  schemaVersion: z.literal(1),
  summary: NonEmptyTextSchema.max(1500),
  facts: z.array(NonEmptyTextSchema.max(400)).max(12).default([]),
  audiencePainPoints: z.array(NonEmptyTextSchema.max(300)).max(8).default([]),
  hookIdeas: z.array(NonEmptyTextSchema.max(200)).max(8).default([]),
  cautions: z.array(NonEmptyTextSchema.max(300)).max(8).default([]),
  provider: NonEmptyTextSchema,
  model: NonEmptyTextSchema,
  researchedAt: z.string().datetime({ offset: true }),
}).strict();

export type ResearchNotes = z.infer<typeof ResearchNotesSchema>;

export function readBrief(payload: unknown): ContentBrief | null {
  const candidate = (payload as { brief?: unknown } | null)?.brief;
  if (!candidate) return null;
  const parsed = ContentBriefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
