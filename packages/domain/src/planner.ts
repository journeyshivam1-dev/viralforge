/**
 * Pure daily-planning logic: slot assignment in IST, deterministic jitter,
 * media-type placement, and topic fingerprints for de-duplication.
 */
import crypto from 'crypto';
import type { MediaType } from './schemas/content-item';

export const IST_OFFSET_MINUTES = 330;

export interface NicheScheduleSettings {
  niche_id: string;
  enabled: boolean;
  posts_per_day: number;
  content_mix: Partial<Record<MediaType, number>>;
  slots_ist: string[];
  jitter_minutes: number;
  publish_mode: 'manual_approval' | 'scheduled';
  auto_approve_at_slot: boolean;
  generation_lead_minutes: number;
}

export const DEFAULT_SLOTS_IST = ['07:30', '12:30', '17:30', '19:30', '21:30'];
export const DEFAULT_CONTENT_MIX: Record<MediaType, number> = { video_reel: 3, image_carousel: 1, image_single: 1 };

export interface PlannedSlot {
  slotIndex: number;
  mediaType: MediaType;
  scheduledAt: Date;
  /** HH:MM IST after jitter, for display. */
  slotIst: string;
}

/** Current calendar date in IST as YYYY-MM-DD. */
export function istDate(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Converts an IST wall-clock time on a date to a UTC instant. */
export function istToUtc(date: string, hhmm: string, offsetMinutes = 0): Date {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const utcMs = Date.UTC(
    Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)),
    hours, minutes,
  ) - IST_OFFSET_MINUTES * 60_000 + offsetMinutes * 60_000;
  return new Date(utcMs);
}

function formatIst(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(11, 16);
}

/** Deterministic jitter in [-max, +max] so re-runs produce identical schedules. */
export function jitterFor(seed: string, maxMinutes: number): number {
  if (maxMinutes <= 0) return 0;
  const value = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  return (value % (maxMinutes * 2 + 1)) - maxMinutes;
}

/**
 * Orders media types across the day: single image in the morning, carousel at
 * midday, reels in the evening peaks (highest reach on IG/FB in India).
 */
export function mediaTypeSequence(mix: Partial<Record<MediaType, number>>, count: number): MediaType[] {
  const sequence: MediaType[] = [
    ...Array(Math.max(0, mix.image_single ?? 0)).fill('image_single'),
    ...Array(Math.max(0, mix.image_carousel ?? 0)).fill('image_carousel'),
    ...Array(Math.max(0, mix.video_reel ?? 0)).fill('video_reel'),
  ];
  while (sequence.length < count) sequence.push('video_reel');
  return sequence.slice(0, count);
}

export function buildSlotPlan(
  date: string,
  settings: Pick<NicheScheduleSettings, 'niche_id' | 'posts_per_day' | 'content_mix' | 'slots_ist' | 'jitter_minutes'>,
): PlannedSlot[] {
  const slots = [...(settings.slots_ist.length ? settings.slots_ist : DEFAULT_SLOTS_IST)].sort();
  const count = Math.min(settings.posts_per_day, slots.length);
  const types = mediaTypeSequence(settings.content_mix, count);
  // Spread the chosen slots across the day when there are more slots than posts.
  const chosen = count === slots.length
    ? slots
    : Array.from({ length: count }, (_, i) => slots[Math.round((i * (slots.length - 1)) / Math.max(1, count - 1))]);
  return chosen.map((slot, slotIndex) => {
    const scheduledAt = istToUtc(date, slot, jitterFor(`${date}:${settings.niche_id}:${slotIndex}`, settings.jitter_minutes));
    return { slotIndex, mediaType: types[slotIndex], scheduledAt, slotIst: formatIst(scheduledAt) };
  });
}

/**
 * Slots are only planned if there is still enough time to generate them.
 * A late planner run (machine was off) compresses the lead time down to minLead.
 */
export function isSlotPlannable(slot: PlannedSlot, now: Date, minLeadMinutes = 45): boolean {
  return slot.scheduledAt.getTime() - now.getTime() >= minLeadMinutes * 60_000;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'on', 'is', 'how', 'kaise', 'ke', 'ki', 'ka', 'se', 'me', 'mein', 'aur', 'ko', 'hai']);

/** Order-insensitive fingerprint of a topic title for de-duplication. */
export function topicFingerprint(title: string): string {
  const tokens = title
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return [...new Set(tokens)].sort().join(' ');
}

/** Jaccard similarity of two fingerprints (0..1). */
export function fingerprintSimilarity(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function isDuplicateTopic(fingerprint: string, history: string[], threshold = 0.6): boolean {
  return history.some((existing) => existing === fingerprint || fingerprintSimilarity(existing, fingerprint) >= threshold);
}
