/**
 * Daily Planner
 * Creates each enabled niche's posts for a date (default: today in IST):
 *   1. slots in IST with deterministic jitter, media types placed by time of day
 *   2. topics: operator calendar/backlog first, then LLM ideation grounded in
 *      Google Trends + YouTube trending, de-duplicated against 60 days of history
 *   3. content_items with scheduled_at + brief; the scheduler starts each pipeline
 *      generation_lead_minutes before its slot.
 * Idempotent: daily_plans (org, date, niche) and content idempotency keys.
 */
import { Job } from 'bullmq';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import {
  ContentBriefSchema,
  DAILY_NICHES,
  DEFAULT_CONTENT_MIX,
  DEFAULT_SLOTS_IST,
  UNTRUSTED_DATA_RULE,
  YOUTUBE_CATEGORIES,
  addDays,
  asDataBlock,
  buildSlotPlan,
  createAiProviderChainFromEnv,
  fetchGoogleTrends,
  fetchYouTubeTrending,
  filterTrendsForNiche,
  getNichePlaybook,
  isDuplicateTopic,
  isSlotPlannable,
  istDate,
  parseJsonObject,
  sanitizePromptText,
  topicFingerprint,
  type ContentBrief,
  type NicheScheduleSettings,
  type PlannedSlot,
  type TrendItem,
} from '@viralforge/domain';
import { enqueueOperationsAlert } from './operations';

const supabase = requireSupabaseAdmin();
const aiChain = createAiProviderChainFromEnv();
const TREND_CACHE_MINUTES = 180;
const HISTORY_DAYS = 60;
const DEFAULT_ORG_EMAIL = 'local@viralforge.dev';

interface PlannerJobData {
  date?: string;
  niches?: string[];
  organizationId?: string;
}

export async function plannerWorker(job: Job<PlannerJobData>) {
  const organizationId = job.data?.organizationId || await defaultOrganizationId();
  if (!organizationId) return { success: true, skipped: 'no organization; call POST /api/dev/bootstrap first' };

  const now = new Date();
  const today = istDate(now);
  // After 20:00 IST also plan tomorrow so early-morning slots get their full lead time.
  const istHour = Number(new Date(now.getTime() + 330 * 60_000).toISOString().slice(11, 13));
  const dates = job.data?.date ? [job.data.date] : istHour >= 20 ? [today, addDays(today, 1)] : [today];

  await supabase.rpc('expire_stale_calendar_topics', { p_today: today });
  const settings = await loadSettings(organizationId);
  const selected = settings.filter((entry) => entry.enabled && (!job.data?.niches || job.data.niches.includes(entry.niche_id)));

  const summary: Array<Record<string, unknown>> = [];
  let trends: TrendItem[] | null = null;
  for (const date of dates) {
    for (const nicheSettings of selected) {
      const claimed = await claimPlan(organizationId, date, nicheSettings.niche_id);
      if (!claimed) { summary.push({ date, niche: nicheSettings.niche_id, skipped: 'already planned' }); continue; }
      try {
        trends ??= await loadGeneralTrends();
        const result = await planNiche(organizationId, date, nicheSettings, trends, now);
        summary.push({ date, niche: nicheSettings.niche_id, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await supabase.from('daily_plans').update({ status: 'failed', error: message.slice(0, 2000) })
          .eq('organization_id', organizationId).eq('plan_date', date).eq('niche_id', nicheSettings.niche_id);
        summary.push({ date, niche: nicheSettings.niche_id, error: message });
        console.error(`[Planner] ${date} ${nicheSettings.niche_id} failed: ${message}`);
        // Once per niche and date; the 30-minute catch-up keeps retrying silently.
        await enqueueOperationsAlert(organizationId, 'planner_failed', `${date}-${nicheSettings.niche_id}`, {
          nicheId: nicheSettings.niche_id,
          lines: [`Could not plan ${date}. Retrying every 30 minutes.`],
          errorMessage: message.slice(0, 500),
          dashboardPath: '/today',
        });
      }
    }
  }
  const failures = summary.filter((entry) => entry.error);
  // Failed niches are retried by the next planner tick (every 30 min); BullMQ also retries.
  if (failures.length > 0 && failures.length === summary.filter((entry) => !entry.skipped).length) {
    throw new Error(`Planner failed for all niches: ${failures.map((entry) => `${entry.niche}: ${entry.error}`).join(' | ').slice(0, 1000)}`);
  }
  return { success: true, dates, summary };
}

async function defaultOrganizationId(): Promise<string | null> {
  const { data } = await supabase.from('organizations').select('id').eq('email', DEFAULT_ORG_EMAIL).maybeSingle();
  return data?.id ?? null;
}

async function loadSettings(organizationId: string): Promise<NicheScheduleSettings[]> {
  // Seed defaults for the daily niches the first time (one-tap approval by default).
  await supabase.from('niche_schedule_settings').upsert(
    DAILY_NICHES.map((nicheId) => ({ organization_id: organizationId, niche_id: nicheId })),
    { onConflict: 'organization_id,niche_id', ignoreDuplicates: true },
  );
  const { data, error } = await supabase.from('niche_schedule_settings').select('*').eq('organization_id', organizationId);
  if (error) throw new Error(`Failed to load niche schedule settings: ${error.message}`);
  return (data || []).map((row) => ({
    ...row,
    content_mix: row.content_mix || DEFAULT_CONTENT_MIX,
    slots_ist: row.slots_ist?.length ? row.slots_ist : DEFAULT_SLOTS_IST,
  }));
}

/** Returns true when this run owns the (org, date, niche) plan. Stale 'planning' rows are reclaimed. */
async function claimPlan(organizationId: string, date: string, nicheId: string): Promise<boolean> {
  const { data: inserted } = await supabase.from('daily_plans')
    .upsert({ organization_id: organizationId, plan_date: date, niche_id: nicheId, status: 'planning' },
      { onConflict: 'organization_id,plan_date,niche_id', ignoreDuplicates: true })
    .select('id');
  if (inserted && inserted.length > 0) return true;

  const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: reclaimed } = await supabase.from('daily_plans')
    .update({ status: 'planning', error: null })
    .eq('organization_id', organizationId).eq('plan_date', date).eq('niche_id', nicheId)
    .or(`status.eq.failed,and(status.eq.planning,updated_at.lt."${staleBefore}")`)
    .select('id');
  return Boolean(reclaimed && reclaimed.length > 0);
}

async function loadGeneralTrends(): Promise<TrendItem[]> {
  return cachedTrends('google_trends', () => fetchGoogleTrends('IN'));
}

async function cachedTrends(source: 'google_trends' | 'youtube_trending', fetcher: () => Promise<TrendItem[]>, cacheKey = 'IN'): Promise<TrendItem[]> {
  const since = new Date(Date.now() - TREND_CACHE_MINUTES * 60_000).toISOString();
  const { data: cached } = await supabase.from('trend_snapshots')
    .select('items').eq('source', source).eq('geo', cacheKey).is('error', null).gte('fetched_at', since)
    .order('fetched_at', { ascending: false }).limit(1).maybeSingle();
  if (cached?.items) return cached.items as TrendItem[];
  try {
    const items = await fetcher();
    await supabase.from('trend_snapshots').insert({ source, geo: cacheKey, items });
    return items;
  } catch (error) {
    // Trends are an input, not a dependency: plan with LLM ideation alone.
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from('trend_snapshots').insert({ source, geo: cacheKey, items: [], error: message.slice(0, 1000) });
    console.warn(`[Planner] ${source} unavailable: ${message}`);
    return [];
  }
}

async function planNiche(organizationId: string, date: string, settings: NicheScheduleSettings, generalTrends: TrendItem[], now: Date) {
  const playbook = getNichePlaybook(settings.niche_id);
  if (!playbook) throw new Error(`No playbook for niche ${settings.niche_id}`);

  const slots = buildSlotPlan(date, settings).filter((slot) => isSlotPlannable(slot, now));
  if (slots.length === 0) {
    await markPlanned(organizationId, date, settings.niche_id, [], { note: 'all slots already passed' });
    return { created: 0, note: 'all slots already passed' };
  }

  const history = await topicHistory(organizationId, settings.niche_id);
  const briefs: Array<{ brief: ContentBrief; mediaType?: string }> = [];

  const { data: backlog, error: backlogError } = await supabase.rpc('claim_backlog_topics', {
    p_organization_id: organizationId,
    p_niche_id: settings.niche_id,
    p_plan_date: date,
    p_limit: slots.length,
  });
  if (backlogError) throw new Error(`Failed to claim backlog topics: ${backlogError.message}`);
  for (const topic of backlog || []) {
    briefs.push({
      mediaType: topic.media_type || undefined,
      brief: ContentBriefSchema.parse({
        schemaVersion: 1,
        title: topic.title,
        angle: topic.angle || `Explain "${topic.title}" for ${playbook.audience}`,
        keyPoints: topic.key_points || [],
        keywords: topic.keywords || [],
        source: topic.scheduled_for ? 'calendar' : 'operator',
        sourceRef: topic.id,
      }),
    });
    history.push(topicFingerprint(topic.title));
  }

  try {
    return await completeNichePlan(organizationId, date, settings, slots, briefs, history, generalTrends, backlog?.length || 0);
  } catch (error) {
    // Give claimed backlog topics back so the next planner tick can use them.
    const claimedIds = (backlog || []).map((topic: { id: string }) => topic.id);
    if (claimedIds.length > 0) {
      await supabase.from('topic_backlog').update({ status: 'pending', used_at: null })
        .in('id', claimedIds).is('used_by_content_item_id', null);
    }
    throw error;
  }
}

async function completeNichePlan(
  organizationId: string,
  date: string,
  settings: NicheScheduleSettings,
  slots: PlannedSlot[],
  briefs: Array<{ brief: ContentBrief; mediaType?: string }>,
  history: string[],
  generalTrends: TrendItem[],
  backlogCount: number,
) {
  const playbook = getNichePlaybook(settings.niche_id)!;
  const needed = slots.length - briefs.length;
  let trendSources: Record<string, number> = {};
  if (needed > 0) {
    const youtube = await cachedTrends(
      'youtube_trending',
      () => fetchYouTubeTrending(process.env.YOUTUBE_API_KEY?.trim(), YOUTUBE_CATEGORIES[settings.niche_id] || []),
      `IN:${settings.niche_id}`,
    );
    const relevant = filterTrendsForNiche([...generalTrends, ...youtube], playbook.trendKeywords);
    const ideas = await ideate(settings.niche_id, needed, relevant, history);
    trendSources = ideas.reduce<Record<string, number>>((acc, idea) => ({ ...acc, [idea.source]: (acc[idea.source] || 0) + 1 }), {});
    briefs.push(...ideas.map((brief) => ({ brief })));
  }
  if (briefs.length < slots.length) {
    throw new Error(`Only ${briefs.length} unique topics for ${slots.length} slots`);
  }

  const createdIds = await createContentItems(organizationId, date, settings, slots, briefs, playbook.aiDisclosureRequired);
  // Link used backlog topics to the content they produced.
  for (const [index, entry] of briefs.entries()) {
    if (entry.brief.sourceRef && ['operator', 'calendar'].includes(entry.brief.source) && createdIds[index]) {
      await supabase.from('topic_backlog').update({ used_by_content_item_id: createdIds[index] }).eq('id', entry.brief.sourceRef);
    }
  }
  await markPlanned(organizationId, date, settings.niche_id, createdIds, { backlog: backlogCount, ...trendSources });
  return { created: createdIds.length, backlog: backlogCount, trendSources };
}

async function topicHistory(organizationId: string, nicheId: string): Promise<string[]> {
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60_000).toISOString();
  const { data } = await supabase.from('content_items')
    .select('topic_fingerprint, sub_topic')
    .eq('organization_id', organizationId).eq('niche_id', nicheId).gte('created_at', since)
    .limit(1000);
  return (data || []).map((row) => row.topic_fingerprint || topicFingerprint(row.sub_topic || '')).filter(Boolean);
}

async function ideate(nicheId: string, count: number, trends: TrendItem[], history: string[]): Promise<ContentBrief[]> {
  const playbook = getNichePlaybook(nicheId)!;
  const accepted: ContentBrief[] = [];
  const seen = [...history];
  for (let round = 0; round < 2 && accepted.length < count; round += 1) {
    const ask = count - accepted.length + 2; // ask for spares to survive de-duplication
    const trendBlock = trends.length
      ? trends.map((trend, index) => `${index + 1}. [${trend.source}] ${sanitizePromptText(trend.title, 150)}${trend.context ? ` — ${sanitizePromptText(trend.context, 200)}` : ''}${trend.traffic ? ` (${sanitizePromptText(trend.traffic, 40)})` : ''}`).join('\n')
      : 'No trend data available today.';
    const avoid = seen.slice(-80).map((fingerprint) => sanitizePromptText(fingerprint, 80)).join('; ') || '-';

    const result = await aiChain.generateText({
      json: true,
      temperature: 0.9,
      maxTokens: 3000,
      system: [
        `You plan daily posts for "${playbook.displayName}", a Hindi/Hinglish Instagram and Facebook channel.`,
        `Persona: ${playbook.persona}. Audience: ${playbook.audience}.`,
        `Content pillars: ${playbook.pillars.join(', ')}.`,
        `Safety rules: ${playbook.safetyRules.join('; ')}.`,
        'Return JSON only.',
        UNTRUSTED_DATA_RULE,
      ].join('\n'),
      user: [
        asDataBlock('trends_india_today', trendBlock),
        asDataBlock('recent_topics_to_avoid', avoid),
        '',
        `Propose ${ask} distinct post topics for today. Use a trend only if it genuinely fits this channel and is safe; otherwise use an evergreen idea from the pillars.`,
        'Vary pillars. Titles are short Hinglish (max 12 words). Never repeat or closely paraphrase a recent topic.',
        'Return exactly: {"topics":[{"title":"string","angle":"string","keyPoints":["string"],"keywords":["string"],"source":"google_trends|youtube_trending|llm","trendIndex":0,"trendContext":"string"}]}',
        'trendIndex is the 1-based number of the trend used, or 0 when source is llm.',
      ].join('\n'),
    });

    const raw = parseJsonObject(result.text);
    const topics = Array.isArray(raw.topics) ? raw.topics : [];
    for (const topic of topics as Array<Record<string, unknown>>) {
      if (accepted.length >= count) break;
      const trend = Number(topic.trendIndex) > 0 ? trends[Number(topic.trendIndex) - 1] : undefined;
      const source = trend ? trend.source : 'llm';
      const parsed = ContentBriefSchema.safeParse({
        schemaVersion: 1,
        title: sanitizePromptText(topic.title, 200),
        angle: sanitizePromptText(topic.angle, 500) || sanitizePromptText(topic.title, 200),
        keyPoints: Array.isArray(topic.keyPoints) ? topic.keyPoints.map((point) => sanitizePromptText(point, 300)).filter(Boolean).slice(0, 6) : [],
        keywords: Array.isArray(topic.keywords) ? topic.keywords.map((keyword) => sanitizePromptText(keyword, 60)).filter(Boolean).slice(0, 10) : [],
        source,
        sourceRef: trend?.url?.slice(0, 500),
        trendContext: trend ? sanitizePromptText(`${trend.title} ${trend.context || ''}`, 1000) : undefined,
      });
      if (!parsed.success) continue;
      const fingerprint = topicFingerprint(parsed.data.title);
      if (!fingerprint || isDuplicateTopic(fingerprint, seen)) continue;
      seen.push(fingerprint);
      accepted.push(parsed.data);
    }
  }
  return accepted;
}

async function createContentItems(
  organizationId: string,
  date: string,
  settings: NicheScheduleSettings,
  slots: PlannedSlot[],
  briefs: Array<{ brief: ContentBrief; mediaType?: string }>,
  aiDisclosureRequired: boolean,
): Promise<string[]> {
  const rows = slots.map((slot, index) => {
    const { brief } = briefs[index];
    return {
      organization_id: organizationId,
      niche_id: settings.niche_id,
      sub_topic: brief.title.slice(0, 255),
      data_input_payload: { brief },
      media_type: slot.mediaType,
      status: 'draft',
      trigger_source: 'calendar',
      trigger_metadata: { planner: true, planDate: date, slotIndex: slot.slotIndex, slotIst: slot.slotIst, explorationOffsetMinutes: slot.explorationOffsetMinutes, topicSource: brief.source },
      scheduled_at: slot.scheduledAt.toISOString(),
      generation_lead_minutes: settings.generation_lead_minutes,
      publish_mode: settings.publish_mode,
      approval_status: settings.publish_mode === 'manual_approval' ? 'pending' : 'not_required',
      ai_disclosure_required: aiDisclosureRequired,
      idempotency_key: `plan-${organizationId}-${date}-${settings.niche_id}-${slot.slotIndex}`,
      topic_fingerprint: topicFingerprint(brief.title),
      plan_date: date,
    };
  });
  const { error } = await supabase.from('content_items').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  if (error) throw new Error(`Failed to create planned content: ${error.message}`);
  const { data, error: readError } = await supabase.from('content_items')
    .select('id, idempotency_key').in('idempotency_key', rows.map((row) => row.idempotency_key));
  if (readError) throw new Error(`Failed to read planned content: ${readError.message}`);
  const byKey = new Map((data || []).map((row) => [row.idempotency_key, row.id]));
  return rows.map((row) => byKey.get(row.idempotency_key)).filter((id): id is string => Boolean(id));
}

async function markPlanned(organizationId: string, date: string, nicheId: string, ids: string[], sources: Record<string, unknown>) {
  const { error } = await supabase.from('daily_plans')
    .update({ status: 'planned', content_item_ids: ids, topic_sources: sources, error: null })
    .eq('organization_id', organizationId).eq('plan_date', date).eq('niche_id', nicheId);
  if (error) throw new Error(`Failed to mark plan complete: ${error.message}`);
}
