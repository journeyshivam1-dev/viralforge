import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';

type TopPost = { contentItemId: string; platform: string; mediaType: string; topic: string | null; postedAt: string; reach: number | null; engagementRate: number; permalink: string | null };
type NicheInsights = {
  nicheId: string;
  posts: number;
  medianReach: number | null;
  medianEngagementRate: number | null;
  byHourIst: Array<{ hour: string; posts: number; medianEngagementRate: number | null }>;
  topPosts: TopPost[];
};
type SlotChange = { from: string; to: string; lift: number; samples: { on: number; neighbour: number } };
type Recommendation = { id: string; niche_id: string; current_slots: string[]; recommended_slots: string[]; changes: SlotChange[]; evidence: { sampleCount?: number }; created_at: string };

const MEDIA_LABEL: Record<string, string> = { video_reel: 'Reel', image_carousel: 'Carousel', image_single: 'Image' };
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

function safeLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(instagram|facebook)\.com$/.test(url.hostname) ? url.toString() : null;
  } catch { return null; }
}

export default function InsightsPage() {
  const [days, setDays] = useState(28);
  const [niches, setNiches] = useState<NicheInsights[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([
    api<{ niches: NicheInsights[] }>(`/api/insights/summary?days=${days}`).then((value) => setNiches(value.niches)),
    api<{ recommendations: Recommendation[] }>('/api/slot-recommendations').then((value) => setRecommendations(value.recommendations)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [days]);

  const decide = async (id: string, decision: 'apply' | 'dismiss') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/slot-recommendations/${id}/${decision}`, { method: 'POST' });
      setNotice(decision === 'apply' ? 'New slots saved. They apply from the next planned day.' : 'Recommendation dismissed.');
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const runTuning = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/slot-tuning/run', { method: 'POST', body: JSON.stringify({}) });
      setNotice('Slot tuning queued. New recommendations appear here and on Telegram.');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const totalPosts = niches.reduce((sum, niche) => sum + niche.posts, 0);

  return <>
    <div className="page-header">
      <div><h2>Insights</h2><p>How published posts perform (24h after posting) and which posting times work best.</p></div>
      <div className="form-actions">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={28}>Last 28 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button className="button" disabled={busy} onClick={runTuning}>Check posting times now</button>
      </div>
    </div>
    {notice && <div className="notice info">{notice}</div>}
    {error && <div className="notice warning">{error}</div>}

    <div className="section-title"><h3>Posting-time recommendations</h3><span className="muted">{recommendations.length} pending</span></div>
    {recommendations.length === 0
      ? <div className="card"><div className="empty">No pending recommendations. Tuning runs every Monday 03:00 IST once there are enough posts (4+ on a slot and 4+ just before or after it).</div></div>
      : <div className="grid two">{recommendations.map((rec) => (
        <div className="card" key={rec.id}>
          <div className="kicker">{rec.niche_id}</div>
          {rec.changes.map((change) => (
            <p key={`${change.from}-${change.to}`}><strong>{change.from} → {change.to} IST</strong> · +{Math.round(change.lift * 100)}% engagement ({change.samples.neighbour} vs {change.samples.on} posts)</p>
          ))}
          <p className="muted mono">{rec.current_slots.join(', ')} → {rec.recommended_slots.join(', ')}</p>
          <div className="form-actions">
            <button className="button primary" disabled={busy} onClick={() => decide(rec.id, 'apply')}>Apply</button>
            <button className="button" disabled={busy} onClick={() => decide(rec.id, 'dismiss')}>Dismiss</button>
          </div>
        </div>
      ))}</div>}

    <div className="section-title"><h3>By niche</h3><span className="muted">{totalPosts} posts measured</span></div>
    {totalPosts === 0 && <div className="card"><div className="empty">No insights yet. They are collected 1h, 24h, 72h and 7 days after each post goes live, so this fills in once publishing is enabled.</div></div>}
    <div className="grid two">
      {niches.filter((niche) => niche.posts > 0).map((niche) => (
        <div className="card" key={niche.nicheId}>
          <div className="section-title" style={{ marginTop: 0 }}><h3>{niche.nicheId}</h3>
            <span className="muted">{niche.posts} posts · median reach {niche.medianReach ?? '—'} · engagement {percent(niche.medianEngagementRate)}</span>
          </div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Hour (IST)</th><th>Posts</th><th>Median engagement</th></tr></thead>
            <tbody>{niche.byHourIst.map((row) => <tr key={row.hour}><td className="mono">{row.hour}</td><td>{row.posts}</td><td>{percent(row.medianEngagementRate)}</td></tr>)}</tbody>
          </table></div>
          <div className="kicker" style={{ marginTop: 12 }}>Top posts</div>
          <div className="table-wrap"><table className="table">
            <tbody>{niche.topPosts.map((post) => {
              const link = safeLink(post.permalink);
              return <tr key={`${post.contentItemId}-${post.platform}`}>
                <td><Link href={`/content/${post.contentItemId}`}>{post.topic || 'Untitled'}</Link><div className="muted">{MEDIA_LABEL[post.mediaType] || post.mediaType} · {post.platform}</div></td>
                <td>{percent(post.engagementRate)}</td>
                <td>{link ? <a href={link} target="_blank" rel="noopener noreferrer">View</a> : null}</td>
              </tr>;
            })}</tbody>
          </table></div>
        </div>
      ))}
    </div>
  </>;
}
