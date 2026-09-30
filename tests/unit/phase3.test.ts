import {
  buildSlotPlan,
  engagementRate,
  explorationShift,
  facebookMetrics,
  flattenGraphInsights,
  formatNotificationText,
  instagramMetrics,
  minuteOfDayIst,
  minuteToSlot,
  recommendSlots,
  slotToMinute,
  type TuningSample,
} from '../../packages/domain';

const settings = {
  niche_id: 'food',
  posts_per_day: 5,
  content_mix: { video_reel: 3, image_carousel: 1, image_single: 1 },
  slots_ist: ['07:30', '12:30', '17:30', '19:30', '21:30'],
  jitter_minutes: 0,
};

function samplesAt(minute: number, count: number, rate: number, platform = 'instagram'): TuningSample[] {
  return Array.from({ length: count }, (_, i) => ({ platform, mediaType: 'video_reel' as const, postedMinuteIst: minute + (i % 3) - 1, rate }));
}

describe('Phase 3 insights normalisation', () => {
  it('flattens both Graph insight shapes and drops non-numeric values', () => {
    const flat = flattenGraphInsights({
      data: [
        { name: 'reach', values: [{ value: 1200 }] },
        { name: 'likes', total_value: { value: 80 } },
        { name: 'saved', values: [{ value: '12' }] },
        { name: 'bogus', values: [{ value: { nested: 1 } }] },
      ],
    });
    expect(flat).toEqual({ reach: 1200, likes: 80, saved: 12 });
    expect(instagramMetrics(flat)).toMatchObject({ reach: 1200, likes: 80, saves: 12, views: null });
    expect(flattenGraphInsights({ error: { message: 'x' } })).toEqual({});
  });

  it('reads Facebook counts from object fields', () => {
    const metrics = facebookMetrics(
      { reactions: { summary: { total_count: 40 } }, comments: { summary: { total_count: 5 } }, shares: { count: 3 } },
      { post_impressions_unique: 900 },
    );
    expect(metrics).toMatchObject({ reach: 900, likes: 40, comments: 5, shares: 3, interactions: 48 });
    expect(facebookMetrics({ likes: { summary: { total_count: 7 } } }).likes).toBe(7);
  });

  it('weights comments/shares/saves above likes and needs reach', () => {
    expect(engagementRate({ reach: 100, views: null, likes: 10, comments: 1, shares: 1, saves: 1, interactions: null })).toBeCloseTo(0.18);
    expect(engagementRate({ reach: 100, views: null, likes: null, comments: null, shares: null, saves: null, interactions: 9 })).toBeCloseTo(0.09);
    expect(engagementRate({ reach: 0, views: null, likes: 5, comments: 0, shares: 0, saves: 0, interactions: 5 })).toBeNull();
    expect(engagementRate({ reach: null, views: null, likes: 5, comments: 0, shares: 0, saves: 0, interactions: 5 })).toBeNull();
  });

  it('converts instants and slots to IST minutes', () => {
    expect(minuteOfDayIst(new Date('2026-10-01T14:00:00Z'))).toBe(19 * 60 + 30);
    expect(slotToMinute('07:05')).toBe(425);
    expect(minuteToSlot(1410)).toBe('23:30');
    expect(minuteToSlot(-30)).toBe('23:30');
  });
});

describe('Phase 3 exploration', () => {
  it('shifts exactly one slot per day, deterministically, and never bunches slots', () => {
    const plan = buildSlotPlan('2026-10-05', { ...settings, slot_tuning: 'suggest', exploration_minutes: 30 });
    const explored = plan.filter((slot) => slot.explorationOffsetMinutes !== 0);
    expect(explored).toHaveLength(1);
    expect(Math.abs(explored[0].explorationOffsetMinutes)).toBe(30);
    expect(buildSlotPlan('2026-10-05', { ...settings, slot_tuning: 'suggest', exploration_minutes: 30 })).toEqual(plan);
    const minutes = plan.map((slot) => minuteOfDayIst(slot.scheduledAt)).sort((a, b) => a - b);
    for (let i = 1; i < minutes.length; i += 1) expect(minutes[i] - minutes[i - 1]).toBeGreaterThanOrEqual(45);
  });

  it('does not explore when tuning is off or exploration is 0', () => {
    expect(buildSlotPlan('2026-10-05', { ...settings, slot_tuning: 'off', exploration_minutes: 30 }).every((s) => s.explorationOffsetMinutes === 0)).toBe(true);
    expect(buildSlotPlan('2026-10-05', { ...settings, slot_tuning: 'auto', exploration_minutes: 0 }).every((s) => s.explorationOffsetMinutes === 0)).toBe(true);
    expect(buildSlotPlan('2026-10-05', settings).every((s) => s.explorationOffsetMinutes === 0)).toBe(true);
  });

  it('flips direction or skips when a shift would clash with another slot or leave the day', () => {
    const tightSlots = ['12:00', '12:40', '13:20'];
    for (let day = 1; day <= 28; day += 1) {
      const shift = explorationShift(`2026-10-${String(day).padStart(2, '0')}`, 'food', tightSlots, 30);
      const target = slotToMinute(tightSlots[shift.slotIndex]) + shift.offsetMinutes;
      // The middle slot has no room either way, so it is never shifted.
      if (shift.slotIndex === 1) expect(shift.offsetMinutes).toBe(0);
      tightSlots.forEach((slot, index) => {
        if (shift.offsetMinutes !== 0 && index !== shift.slotIndex) expect(Math.abs(slotToMinute(slot) - target)).toBeGreaterThanOrEqual(45);
      });
    }
    const edge = explorationShift('2026-10-05', 'tech', ['23:50'], 30);
    expect(edge.offsetMinutes).toBe(-30);
  });

  it('spreads exploration across slots over many days', () => {
    const seen = new Set<number>();
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-10-${String(day).padStart(2, '0')}`;
      seen.add(explorationShift(date, 'food', settings.slots_ist, 30).slotIndex);
    }
    expect(seen.size).toBe(5);
  });
});

describe('Phase 3 slot recommendations', () => {
  const slots = ['07:30', '12:30', '17:30', '19:30', '21:30'];

  it('moves a slot toward a clearly better neighbour', () => {
    const samples = [
      ...samplesAt(slotToMinute('21:30'), 10, 0.05),
      ...samplesAt(slotToMinute('21:00'), 8, 0.09),
      ...samplesAt(slotToMinute('12:30'), 10, 0.06),
    ];
    const result = recommendSlots(slots, samples);
    expect(result.changes).toEqual([expect.objectContaining({ from: '21:30', to: '21:00' })]);
    expect(result.slots).toEqual(['07:30', '12:30', '17:30', '19:30', '21:00']);
  });

  it('needs enough samples on both sides and a real lift', () => {
    expect(recommendSlots(slots, [...samplesAt(1290, 10, 0.05), ...samplesAt(1260, 3, 0.2)]).changes).toHaveLength(0);
    expect(recommendSlots(slots, [...samplesAt(1290, 10, 0.05), ...samplesAt(1260, 10, 0.051)]).changes).toHaveLength(0);
    expect(recommendSlots(slots, []).changes).toHaveLength(0);
  });

  it('keeps 90 minutes between slots and stays within 06:00-23:30', () => {
    // 17:30 -> 18:00 would sit 90 min from 19:30 (allowed); 19:30 -> 19:00 would be 90 from 17:30 (allowed),
    // but moving both would put them 60 min apart, so only the stronger move is kept.
    const samples = [
      ...samplesAt(slotToMinute('17:30'), 8, 0.05),
      ...samplesAt(slotToMinute('18:00'), 8, 0.1),
      ...samplesAt(slotToMinute('19:30'), 8, 0.05),
      ...samplesAt(slotToMinute('19:00'), 8, 0.08),
    ];
    const result = recommendSlots(slots, samples);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ from: '17:30', to: '18:00' });

    const early = recommendSlots(['06:00', '12:00'], [...samplesAt(360, 8, 0.05), ...samplesAt(330, 8, 0.2)]);
    expect(early.changes).toHaveLength(0);
  });

  it('normalises by platform so a stronger platform does not bias the slot', () => {
    // Facebook rates are 10x lower overall, but within each platform the neighbour is equal.
    const samples = [
      ...samplesAt(1290, 6, 0.05, 'instagram'),
      ...samplesAt(1260, 6, 0.05, 'facebook').map((s) => ({ ...s, rate: 0.005 })),
      ...samplesAt(1290, 6, 0.005, 'facebook'),
      ...samplesAt(1260, 6, 0.05, 'instagram'),
    ];
    expect(recommendSlots(slots, samples).changes).toHaveLength(0);
  });
});

describe('Phase 3 notifications', () => {
  it('formats operations events with bounded lines and safe dashboard paths', () => {
    const text = formatNotificationText('daily_digest', { lines: ['food: 5/5 published'], dashboardPath: '/today' }, null, 'http://localhost:3001');
    expect(text).toBe('ViralForge: Daily digest\nfood: 5/5 published\nOpen: http://localhost:3001/today');
    const unsafe = formatNotificationText('account_unhealthy', { lines: ['x'], dashboardPath: '//evil.example' }, null, 'http://localhost:3001');
    expect(unsafe).not.toContain('evil');
  });
});
