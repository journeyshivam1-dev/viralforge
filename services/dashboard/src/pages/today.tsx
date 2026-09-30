import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';

type PlanItem = {
  id: string;
  niche_id: string;
  sub_topic: string;
  media_type: string;
  status: string;
  scheduled_at: string | null;
  publish_mode: string;
  approval_status: string;
  trigger_metadata?: { topicSource?: string } | null;
  pipeline_runs?: Array<{ id: string; status: string; current_stage: string; waiting_reason?: string | null; updated_at: string }>;
};

type DailyPlan = { niche_id: string; status: string; error?: string | null; topic_sources?: Record<string, number> };

const NICHES = ['cartoon', 'food', 'health', 'tech', 'edtech'];
const MEDIA_LABEL: Record<string, string> = { video_reel: 'Reel', image_carousel: 'Carousel', image_single: 'Image' };

function istToday(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

function istTime(value: string | null): string {
  return value ? new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—';
}

function latestRun(item: PlanItem) {
  return item.pipeline_runs?.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

export default function TodayPage() {
  const [date, setDate] = useState(istToday());
  const [items, setItems] = useState<PlanItem[]>([]);
  const [plans, setPlans] = useState<DailyPlan[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => api<{ items: PlanItem[]; plans: DailyPlan[] }>(`/api/planner/day?date=${date}`)
    .then((value) => { setItems(value.items); setPlans(value.plans); setError(''); })
    .catch((e) => setError(e.message)), [date]);

  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, [load]);

  const run = async (label: string, request: () => Promise<{ message?: string }>) => {
    setBusy(true);
    setNotice('');
    try { const result = await request(); setNotice(result.message || `${label} requested`); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const failed = items.filter((item) => ['failed', 'blocked'].includes(latestRun(item)?.status || ''));
  const waiting = items.filter((item) => latestRun(item)?.waiting_reason === 'approval_required' && latestRun(item)?.status === 'waiting');
  const published = items.filter((item) => item.status === 'published');

  return <>
    <div className="page-header">
      <div><h2>Today&apos;s plan</h2><p>Every slot the planner scheduled, with its live pipeline state. Times are IST.</p></div>
      <div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ marginRight: 8 }} />
        <button className="button secondary" disabled={busy} onClick={() => run('Planner', () => api('/api/planner/run', { method: 'POST', body: JSON.stringify({ date }) }))}>Run planner now</button>
        <button className="button primary" disabled={busy || failed.length === 0} onClick={() => run('Retry', () => api('/api/pipeline-runs/retry-failed', { method: 'POST', body: JSON.stringify({}) }))}>Retry all failed ({failed.length})</button>
      </div>
    </div>
    {notice && <div className="notice info">{notice}</div>}
    {error && <div className="notice warning">{error}</div>}

    <div className="grid four">
      <div className="card stat-card"><div className="stat-label">Planned</div><div className="stat-value">{items.length}</div><div className="stat-foot">of {NICHES.length * 5} target</div></div>
      <div className="card stat-card"><div className="stat-label">Waiting approval</div><div className="stat-value">{waiting.length}</div><div className="stat-foot">Approve here or in Telegram</div></div>
      <div className="card stat-card"><div className="stat-label">Failed / blocked</div><div className="stat-value" style={{ color: failed.length ? '#ae4e4e' : undefined }}>{failed.length}</div><div className="stat-foot">Retry resumes the failed step only</div></div>
      <div className="card stat-card"><div className="stat-label">Published</div><div className="stat-value">{published.length}</div><div className="stat-foot">Instagram + Facebook</div></div>
    </div>

    {NICHES.map((niche) => {
      const plan = plans.find((entry) => entry.niche_id === niche);
      const rows = items.filter((item) => item.niche_id === niche);
      return <div key={niche}>
        <div className="section-title"><h3>{niche}</h3><span className="muted">{plan ? `plan ${plan.status}${plan.error ? ` — ${plan.error}` : ''}` : 'not planned yet'}</span></div>
        <div className="card"><div className="table-wrap"><table className="table">
          <thead><tr><th>Slot</th><th>Format</th><th>Topic</th><th>Pipeline</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5}><div className="empty">No posts planned for {niche} on {date}.</div></td></tr>}
            {rows.map((item) => {
              const pipeline = latestRun(item);
              const awaiting = pipeline?.status === 'waiting' && pipeline.waiting_reason === 'approval_required';
              return <tr key={item.id}>
                <td className="mono">{istTime(item.scheduled_at)}</td>
                <td>{MEDIA_LABEL[item.media_type] || item.media_type}</td>
                <td><Link href={`/content/${item.id}`}><strong>{item.sub_topic}</strong></Link><div className="muted" style={{ fontSize: 11 }}>{item.trigger_metadata?.topicSource || 'manual'} · {item.publish_mode === 'manual_approval' ? 'needs approval' : 'auto-publish'}</div></td>
                <td><span className={`status ${item.status}`}>{item.status}</span><div className="muted" style={{ fontSize: 11 }}>{pipeline ? `${pipeline.current_stage} · ${pipeline.status}${pipeline.waiting_reason ? ` · ${pipeline.waiting_reason.replace(/_/g, ' ')}` : ''}` : 'starts before slot'}</div></td>
                <td>
                  {awaiting && pipeline && <>
                    <button className="button primary" disabled={busy} onClick={() => run('Approve', () => api(`/api/pipeline-runs/${pipeline.id}/approve`, { method: 'POST', body: JSON.stringify({}) }))}>Approve</button>
                    <button className="button danger" disabled={busy} onClick={() => run('Reject', () => api(`/api/pipeline-runs/${pipeline.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'Rejected from Today view' }) }))}>Reject</button>
                  </>}
                  {pipeline && ['failed', 'blocked'].includes(pipeline.status) && <button className="button secondary" disabled={busy} onClick={() => run('Resume', () => api(`/api/pipeline-runs/${pipeline.id}/resume`, { method: 'POST', body: JSON.stringify({}) }))}>Retry {pipeline.current_stage}</button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table></div></div>
      </div>;
    })}
  </>;
}
