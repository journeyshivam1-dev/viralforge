/**
 * Weekly slot tuning. Uses the last WINDOW_DAYS of post insights to move each
 * niche's posting times toward better-performing neighbours (see
 * recommendSlots). `suggest` stores a recommendation and asks the operator;
 * `auto` applies it and sends an FYI. Changes affect the next planned day.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  DEFAULT_SLOTS_IST,
  engagementRate,
  recommendSlots,
  type MediaType,
  type TuningSample,
} from '@viralforge/domain';

const WINDOW_DAYS = 28;
const DEFAULT_ORG_EMAIL = 'local@viralforge.dev';

interface TuningJobData { organizationId?: string; niches?: string[] }

export async function slotTuningWorker(job: Job<TuningJobData>) {
  const admin = requireSupabaseAdmin();
  const organizationId = job.data?.organizationId
    || (await admin.from('organizations').select('id').eq('email', DEFAULT_ORG_EMAIL).maybeSingle()).data?.id;
  if (!organizationId) return { success: true, skipped: 'no organization' };

  const { data: settings, error } = await admin.from('niche_schedule_settings')
    .select('niche_id, enabled, slots_ist, slot_tuning')
    .eq('organization_id', organizationId)
    .neq('slot_tuning', 'off');
  if (error) throw new Error(`Failed to load niche settings: ${error.message}`);

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
  const summary: Array<Record<string, unknown>> = [];
  for (const entry of settings || []) {
    if (!entry.enabled || (job.data?.niches && !job.data.niches.includes(entry.niche_id))) continue;
    const samples = await loadSamples(organizationId, entry.niche_id, since);
    const currentSlots: string[] = entry.slots_ist?.length ? entry.slots_ist : DEFAULT_SLOTS_IST;
    const result = recommendSlots(currentSlots, samples);
    if (result.changes.length === 0) {
      summary.push({ niche: entry.niche_id, samples: result.sampleCount, changes: 0 });
      continue;
    }

    const { data: recommendationId, error: createError } = await admin.rpc('create_slot_recommendation', {
      p_organization_id: organizationId,
      p_niche_id: entry.niche_id,
      p_window_days: WINDOW_DAYS,
      p_current_slots: currentSlots,
      p_recommended_slots: result.slots,
      p_changes: result.changes,
      p_evidence: { sampleCount: result.sampleCount, slots: result.evidence },
    });
    if (createError) throw new Error(`Failed to store slot recommendation: ${createError.message}`);

    const changeLines = result.changes.map((change) => `${change.from} → ${change.to} IST (+${Math.round(change.lift * 100)}% engagement, ${change.samples.neighbour} vs ${change.samples.on} posts)`);
    let applied = false;
    if (entry.slot_tuning === 'auto') {
      const { data: outcome, error: applyError } = await admin.rpc('apply_slot_recommendation', { p_id: recommendationId, p_decided_by: 'system' });
      if (applyError || !outcome?.applied) {
        console.error(`[SlotTuning] Auto-apply failed for ${entry.niche_id}: ${applyError?.message || outcome?.reason}`);
        summary.push({ niche: entry.niche_id, samples: result.sampleCount, changes: result.changes.length, applied: false });
        continue;
      }
      applied = true;
    }
    await admin.rpc('enqueue_notification', {
      p_organization_id: organizationId,
      p_content_item_id: null,
      p_run_id: null,
      p_attempt_id: null,
      p_event_type: 'slot_recommendation',
      p_dedupe_suffix: String(recommendationId),
      p_payload: {
        nicheId: entry.niche_id,
        recommendationId: applied ? undefined : recommendationId,
        lines: [
          applied ? 'Applied automatically from the next planned day:' : 'Suggested change (tap Apply or Dismiss):',
          ...changeLines,
          `New slots: ${result.slots.join(', ')}`,
          `Based on ${result.sampleCount} posts in the last ${WINDOW_DAYS} days.`,
        ],
        dashboardPath: '/insights',
      },
    });
    summary.push({ niche: entry.niche_id, samples: result.sampleCount, changes: result.changes.length, applied });
  }
  return { success: true, summary };
}

/** One sample per publication: the 24h checkpoint, or 72h when 24h is missing. */
async function loadSamples(organizationId: string, nicheId: string, since: string): Promise<TuningSample[]> {
  const { data, error } = await requireSupabaseAdmin().from('post_insights')
    .select('publication_attempt_id, checkpoint, platform, media_type, posted_minute_ist, reach, likes, comments, shares, saves, interactions, views')
    .eq('organization_id', organizationId)
    .eq('niche_id', nicheId)
    .eq('status', 'collected')
    .in('checkpoint', ['24h', '72h'])
    .gte('posted_at', since)
    .limit(5000);
  if (error) throw new Error(`Failed to load insights: ${error.message}`);
  const byPublication = new Map<string, any>();
  for (const row of data || []) {
    const existing = byPublication.get(row.publication_attempt_id);
    if (!existing || (existing.checkpoint !== '24h' && row.checkpoint === '24h')) byPublication.set(row.publication_attempt_id, row);
  }
  const samples: TuningSample[] = [];
  for (const row of byPublication.values()) {
    const rate = engagementRate(row);
    if (rate === null) continue;
    samples.push({ platform: row.platform, mediaType: row.media_type as MediaType, postedMinuteIst: row.posted_minute_ist, rate });
  }
  return samples;
}
