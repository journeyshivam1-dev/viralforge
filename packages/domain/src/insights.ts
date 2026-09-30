/**
 * Pure post-insights logic: Graph response normalisation, engagement scoring,
 * and slot tuning (move posting times toward what performs better).
 * Only aggregate per-post counts are handled here, never viewer data.
 */
import { IST_OFFSET_MINUTES } from './planner';
import type { MediaType } from './schemas/content-item';

export const INSIGHT_CHECKPOINTS = [
  { key: '1h', minutes: 60 },
  { key: '24h', minutes: 24 * 60 },
  { key: '72h', minutes: 72 * 60 },
  { key: '7d', minutes: 7 * 24 * 60 },
] as const;
export type InsightCheckpoint = (typeof INSIGHT_CHECKPOINTS)[number]['key'];

export interface PostMetrics {
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  interactions: number | null;
}

export const EMPTY_METRICS: PostMetrics = { reach: null, views: null, likes: null, comments: null, shares: null, saves: null, interactions: null };

function toCount(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/**
 * Flattens a Graph `/insights` response (`data: [{ name, values: [{ value }] }]`
 * or `total_value: { value }`) into name -> number. Non-numeric values are dropped.
 */
export function flattenGraphInsights(body: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data as Array<{ name?: unknown; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }>) {
    if (typeof entry?.name !== 'string') continue;
    const raw = entry.total_value?.value ?? entry.values?.[entry.values.length - 1]?.value;
    const count = toCount(raw);
    if (count !== null) out[entry.name] = count;
  }
  return out;
}

export function instagramMetrics(flat: Record<string, number>): PostMetrics {
  return {
    reach: flat.reach ?? null,
    views: flat.views ?? flat.plays ?? flat.impressions ?? null,
    likes: flat.likes ?? null,
    comments: flat.comments ?? null,
    shares: flat.shares ?? null,
    saves: flat.saved ?? null,
    interactions: flat.total_interactions ?? null,
  };
}

/** Facebook post/video object fields (reactions/likes, comments, shares) plus optional insights. */
export function facebookMetrics(fields: unknown, flat: Record<string, number> = {}): PostMetrics {
  const body = (fields || {}) as {
    reactions?: { summary?: { total_count?: unknown } };
    likes?: { summary?: { total_count?: unknown } };
    comments?: { summary?: { total_count?: unknown } };
    shares?: { count?: unknown };
  };
  const likes = toCount(body.reactions?.summary?.total_count) ?? toCount(body.likes?.summary?.total_count);
  const comments = toCount(body.comments?.summary?.total_count);
  const shares = toCount(body.shares?.count);
  const counted = [likes, comments, shares].filter((value): value is number => value !== null);
  return {
    reach: flat.post_impressions_unique ?? flat.post_total_media_view_unique ?? null,
    views: flat.blue_reels_play_count ?? flat.post_video_views ?? null,
    likes,
    comments,
    shares,
    saves: null,
    interactions: counted.length ? counted.reduce((sum, value) => sum + value, 0) : null,
  };
}

/**
 * Weighted interactions per reached account. Comments, shares and saves count
 * more than likes because they drive distribution. Null when reach is unknown.
 */
export function engagementRate(metrics: PostMetrics): number | null {
  if (!metrics.reach || metrics.reach <= 0) return null;
  const parts = [metrics.likes, metrics.comments, metrics.shares, metrics.saves];
  const weighted = parts.every((value) => value === null)
    ? metrics.interactions ?? 0
    : (metrics.likes ?? 0) + 2 * (metrics.comments ?? 0) + 3 * (metrics.shares ?? 0) + 3 * (metrics.saves ?? 0);
  return weighted / metrics.reach;
}

export function minuteOfDayIst(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function slotToMinute(slot: string): number {
  const [hours, minutes] = slot.split(':').map(Number);
  return hours * 60 + minutes;
}

export function minuteToSlot(minute: number): string {
  const value = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ slot tuning

export interface TuningSample {
  platform: string;
  mediaType: MediaType;
  postedMinuteIst: number;
  rate: number;
}

export interface SlotTuningOptions {
  /** How far a slot moves per recommendation (and the exploration distance). */
  stepMinutes: number;
  minSamples: number;
  /** Required relative improvement of the neighbour over the current slot. */
  minLift: number;
  /** Bayesian shrinkage weight toward the overall mean. */
  priorWeight: number;
  minGapMinutes: number;
  earliestMinute: number;
  latestMinute: number;
  maxMoves: number;
}

export const DEFAULT_TUNING_OPTIONS: SlotTuningOptions = {
  stepMinutes: 30,
  minSamples: 4,
  minLift: 0.1,
  priorWeight: 5,
  minGapMinutes: 90,
  earliestMinute: 6 * 60,
  latestMinute: 23 * 60 + 30,
  maxMoves: 2,
};

export interface BucketStats { n: number; mean: number | null; shrunk: number | null }
export interface SlotEvidence { slot: string; earlier: BucketStats; on: BucketStats; later: BucketStats }
export interface SlotChange { from: string; to: string; lift: number; samples: { on: number; neighbour: number } }
export interface SlotRecommendation { slots: string[]; changes: SlotChange[]; evidence: SlotEvidence[]; sampleCount: number }

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Normalises each rate by the median of its platform + media type, so reels
 * and images (and IG vs FB) are comparable, then compares posts made on each
 * slot with posts made one exploration step earlier/later.
 */
export function recommendSlots(
  currentSlots: string[],
  samples: TuningSample[],
  overrides: Partial<SlotTuningOptions> = {},
): SlotRecommendation {
  const options = { ...DEFAULT_TUNING_OPTIONS, ...overrides };
  const slotMinutes = [...currentSlots].map(slotToMinute).sort((a, b) => a - b);

  const groups = new Map<string, number[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.rate) || sample.rate < 0) continue;
    const key = `${sample.platform}:${sample.mediaType}`;
    groups.set(key, [...(groups.get(key) || []), sample.rate]);
  }
  const medians = new Map([...groups].map(([key, rates]) => [key, median(rates)]));
  const normalised = samples
    .map((sample) => {
      const base = medians.get(`${sample.platform}:${sample.mediaType}`);
      return base && base > 0 && Number.isFinite(sample.rate) && sample.rate >= 0
        ? { minute: sample.postedMinuteIst, value: sample.rate / base }
        : null;
    })
    .filter((value): value is { minute: number; value: number } => value !== null);

  const overall = normalised.length ? normalised.reduce((sum, entry) => sum + entry.value, 0) / normalised.length : 1;
  const half = options.stepMinutes / 2;
  const buckets = slotMinutes.map(() => ({ earlier: [] as number[], on: [] as number[], later: [] as number[] }));
  for (const entry of normalised) {
    let nearest = -1;
    let distance = Infinity;
    slotMinutes.forEach((minute, index) => {
      if (Math.abs(entry.minute - minute) < Math.abs(distance)) { nearest = index; distance = entry.minute - minute; }
    });
    if (nearest < 0) continue;
    if (Math.abs(distance) <= half) buckets[nearest].on.push(entry.value);
    else if (distance < 0 && distance >= -(options.stepMinutes + half)) buckets[nearest].earlier.push(entry.value);
    else if (distance > 0 && distance <= options.stepMinutes + half) buckets[nearest].later.push(entry.value);
  }

  const stats = (values: number[]): BucketStats => ({
    n: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    shrunk: values.length ? (values.reduce((sum, value) => sum + value, 0) + options.priorWeight * overall) / (values.length + options.priorWeight) : null,
  });

  const evidence: SlotEvidence[] = slotMinutes.map((minute, index) => ({
    slot: minuteToSlot(minute),
    earlier: stats(buckets[index].earlier),
    on: stats(buckets[index].on),
    later: stats(buckets[index].later),
  }));

  const candidates: Array<{ index: number; to: number; lift: number; on: number; neighbour: number }> = [];
  evidence.forEach((entry, index) => {
    if (entry.on.n < options.minSamples || !entry.on.shrunk) return;
    for (const [side, direction] of [['earlier', -1], ['later', 1]] as const) {
      const neighbour = entry[side];
      if (neighbour.n < options.minSamples || neighbour.shrunk === null) continue;
      const lift = neighbour.shrunk / entry.on.shrunk - 1;
      if (lift >= options.minLift) {
        candidates.push({ index, to: slotMinutes[index] + direction * options.stepMinutes, lift, on: entry.on.n, neighbour: neighbour.n });
      }
    }
  });

  const next = [...slotMinutes];
  const moved = new Set<number>();
  const changes: SlotChange[] = [];
  for (const candidate of candidates.sort((a, b) => b.lift - a.lift)) {
    if (changes.length >= options.maxMoves || moved.has(candidate.index)) continue;
    if (candidate.to < options.earliestMinute || candidate.to > options.latestMinute) continue;
    const clashes = next.some((minute, index) => index !== candidate.index && Math.abs(minute - candidate.to) < options.minGapMinutes);
    if (clashes) continue;
    changes.push({
      from: minuteToSlot(next[candidate.index]),
      to: minuteToSlot(candidate.to),
      lift: Math.round(candidate.lift * 1000) / 1000,
      samples: { on: candidate.on, neighbour: candidate.neighbour },
    });
    next[candidate.index] = candidate.to;
    moved.add(candidate.index);
  }

  return { slots: next.sort((a, b) => a - b).map(minuteToSlot), changes, evidence, sampleCount: normalised.length };
}
