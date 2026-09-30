import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Settings = {
  niche_id: string;
  enabled: boolean;
  posts_per_day: number;
  content_mix: { video_reel: number; image_carousel: number; image_single: number };
  slots_ist: string[];
  jitter_minutes: number;
  publish_mode: 'manual_approval' | 'scheduled';
  auto_approve_at_slot: boolean;
  generation_lead_minutes: number;
  slot_tuning: 'off' | 'suggest' | 'auto';
  exploration_minutes: number;
};

type Topic = { id: string; niche_id: string; title: string; angle?: string | null; scheduled_for?: string | null; status: string; priority: number; media_type?: string | null };

const NICHES = ['cartoon', 'food', 'health', 'tech', 'edtech'];

/** Parses "niche,title,YYYY-MM-DD(optional),angle(optional)" lines. Quoted fields are not supported. */
function parseCsv(text: string) {
  const topics: Array<Record<string, unknown>> = [];
  const problems: string[] = [];
  text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line, index) => {
    if (index === 0 && /^niche\s*,/i.test(line)) return;
    const [niche, title, date, ...angle] = line.split(',').map((part) => part.trim());
    if (!NICHES.includes(niche) || !title || title.length < 3) { problems.push(`Line ${index + 1}: needs a valid niche and title`); return; }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { problems.push(`Line ${index + 1}: date must be YYYY-MM-DD`); return; }
    topics.push({ niche_id: niche, title: title.slice(0, 200), ...(date ? { scheduled_for: date } : {}), ...(angle.length ? { angle: angle.join(',').slice(0, 500) } : {}) });
  });
  return { topics, problems };
}

export default function AutomationPage() {
  const [settings, setSettings] = useState<Settings[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [csv, setCsv] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([
    api<{ settings: Settings[] }>('/api/niche-settings').then((value) => setSettings(value.settings)),
    api<{ topics: Topic[] }>('/api/topics?status=pending').then((value) => setTopics(value.topics)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const update = (niche: string, patch: Partial<Settings>) => setSettings((current) => current.map((entry) => entry.niche_id === niche ? { ...entry, ...patch } : entry));

  const save = async (entry: Settings) => {
    setBusy(true); setError(''); setNotice('');
    const posts = entry.content_mix.video_reel + entry.content_mix.image_carousel + entry.content_mix.image_single;
    try {
      await api(`/api/niche-settings/${entry.niche_id}`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: entry.enabled,
          posts_per_day: posts,
          content_mix: entry.content_mix,
          slots_ist: entry.slots_ist,
          publish_mode: entry.publish_mode,
          auto_approve_at_slot: entry.auto_approve_at_slot,
          generation_lead_minutes: entry.generation_lead_minutes,
          slot_tuning: entry.slot_tuning,
          exploration_minutes: entry.exploration_minutes,
        }),
      });
      setNotice(`${entry.niche_id} saved. Changes apply from the next planned day.`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const importCsv = async () => {
    const { topics: parsed, problems } = parseCsv(csv);
    if (problems.length) { setError(problems.join('; ')); return; }
    if (!parsed.length) { setError('Nothing to import'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ created: number }>('/api/topics', { method: 'POST', body: JSON.stringify({ topics: parsed }) });
      setNotice(`${result.created} topic(s) added`); setCsv(''); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const removeTopic = async (id: string) => {
    setBusy(true);
    try { await api(`/api/topics/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return <>
    <div className="page-header"><div><h2>Automation</h2><p>How many posts each niche makes, when they go out (IST), and whether they need your approval.</p></div></div>
    {notice && <div className="notice info">{notice}</div>}
    {error && <div className="notice warning">{error}</div>}

    <div className="grid two">
      {settings.filter((entry) => NICHES.includes(entry.niche_id)).map((entry) => (
        <div className="card" key={entry.niche_id}>
          <div className="section-title" style={{ marginTop: 0 }}><h3>{entry.niche_id}</h3>
            <label><input type="checkbox" checked={entry.enabled} onChange={(e) => update(entry.niche_id, { enabled: e.target.checked })} /> enabled</label>
          </div>
          <div className="form-grid">
            <div className="field"><label>Publishing</label>
              <select value={entry.publish_mode} onChange={(e) => update(entry.niche_id, { publish_mode: e.target.value as Settings['publish_mode'] })}>
                <option value="manual_approval">One-tap approval</option>
                <option value="scheduled">Fully automatic</option>
              </select>
            </div>
            <div className="field"><label>If not approved by slot time</label>
              <select value={entry.auto_approve_at_slot ? 'auto' : 'wait'} disabled={entry.publish_mode !== 'manual_approval'} onChange={(e) => update(entry.niche_id, { auto_approve_at_slot: e.target.value === 'auto' })}>
                <option value="wait">Keep waiting</option>
                <option value="auto">Auto-approve and publish</option>
              </select>
            </div>
            {(['video_reel', 'image_carousel', 'image_single'] as const).map((kind) => (
              <div className="field" key={kind}><label>{kind === 'video_reel' ? 'Reels / day' : kind === 'image_carousel' ? 'Carousels / day' : 'Images / day'}</label>
                <input type="number" min={0} max={10} value={entry.content_mix[kind]} onChange={(e) => update(entry.niche_id, { content_mix: { ...entry.content_mix, [kind]: Math.max(0, Number(e.target.value) || 0) } })} />
              </div>
            ))}
            <div className="field"><label>Generation lead (minutes)</label>
              <input type="number" min={30} max={720} value={entry.generation_lead_minutes} onChange={(e) => update(entry.niche_id, { generation_lead_minutes: Number(e.target.value) || 150 })} />
            </div>
            <div className="field"><label>Posting-time tuning</label>
              <select value={entry.slot_tuning} onChange={(e) => update(entry.niche_id, { slot_tuning: e.target.value as Settings['slot_tuning'] })}>
                <option value="suggest">Suggest better times</option>
                <option value="auto">Apply better times automatically</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className="field"><label>Exploration (± minutes, one slot a day)</label>
              <input type="number" min={0} max={90} disabled={entry.slot_tuning === 'off'} value={entry.exploration_minutes} onChange={(e) => update(entry.niche_id, { exploration_minutes: Math.min(90, Math.max(0, Number(e.target.value) || 0)) })} />
            </div>
            <div className="field full"><label>Slots (IST, comma separated)</label>
              <input value={entry.slots_ist.join(', ')} onChange={(e) => update(entry.niche_id, { slots_ist: e.target.value.split(',').map((slot) => slot.trim()).filter(Boolean) })} placeholder="07:30, 12:30, 17:30, 19:30, 21:30" />
            </div>
          </div>
          <div className="form-actions"><button className="button primary" disabled={busy} onClick={() => save(entry)}>Save {entry.niche_id}</button></div>
        </div>
      ))}
    </div>

    <div className="section-title"><h3>Topic list &amp; content calendar</h3><span className="muted">{topics.length} pending</span></div>
    <div className="grid two">
      <div className="card">
        <div className="kicker">Bulk add (CSV)</div>
        <p className="muted">One per line: <span className="mono">niche,title,date(optional YYYY-MM-DD),angle(optional)</span>. Dated topics are used on that date; undated ones fill the next plans before AI ideas and trends.</p>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} placeholder={'food,Monsoon special pakode 3 tarah,2026-10-02\ntech,Free AI tools for students\nedtech,SSC CGL maths shortcut: percentage'} style={{ width: '100%' }} />
        <div className="form-actions"><button className="button primary" disabled={busy || !csv.trim()} onClick={importCsv}>Add topics</button></div>
      </div>
      <div className="card"><div className="table-wrap"><table className="table">
        <thead><tr><th>Niche</th><th>Topic</th><th>Date</th><th /></tr></thead>
        <tbody>
          {topics.length === 0 && <tr><td colSpan={4}><div className="empty">No pending topics. The planner will use trends and AI ideas.</div></td></tr>}
          {topics.map((topic) => <tr key={topic.id}>
            <td>{topic.niche_id}</td>
            <td><strong>{topic.title}</strong>{topic.angle ? <div className="muted">{topic.angle}</div> : null}</td>
            <td className="mono">{topic.scheduled_for || 'next free'}</td>
            <td><button className="button danger" disabled={busy} onClick={() => removeTopic(topic.id)}>Remove</button></td>
          </tr>)}
        </tbody>
      </table></div></div>
    </div>
  </>;
}
