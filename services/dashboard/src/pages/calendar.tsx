import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ContentItem } from '../lib/api';

export default function CalendarPage() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [status, setStatus] = useState('');
  const [niche, setNiche] = useState('');
  const [error, setError] = useState('');
  const load = () => api<{ content: ContentItem[] }>(`/api/content?limit=100${status ? `&status=${status}` : ''}${niche ? `&niche=${niche}` : ''}`).then((value) => setItems(value.content)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [status, niche]);
  const action = async (id: string, endpoint: string) => { try { await api(`/api/content/${id}/${endpoint}`, { method: 'POST' }); load(); } catch (e: any) { setError(e.message); } };
  const nextAction = (item: ContentItem) => {
    if (['draft', 'failed', 'blocked'].includes(item.status)) return <button className="button secondary" onClick={() => action(item.id, 'queue')}>Start research</button>;
    if (item.status === 'researched') return <button className="button secondary" onClick={() => action(item.id, 'generate')}>Generate with Omniroute</button>;
    if (item.status === 'generated') return <button className="button secondary" onClick={() => action(item.id, 'media')}>Generate media</button>;
    if (item.status === 'validated') return <button className="button primary" onClick={() => action(item.id, 'publish')}>Publish</button>;
    return <Link className="button secondary" href={`/content/${item.id}`}>Review</Link>;
  };
  return <><div className="page-header"><div><h2>Content calendar</h2><p>Every brief, generation job and publishing state in one view.</p></div><Link href="/content/new" className="button primary">＋ New content</Link></div>{error && <div className="notice warning">{error}</div>}<div className="card"><div className="grid two" style={{ marginBottom: 18 }}><div className="field"><label>Status</label><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['draft','queued','researched','generated','rendering','validated','scheduled','published','blocked','failed'].map((value) => <option key={value}>{value}</option>)}</select></div><div className="field"><label>Niche</label><select value={niche} onChange={(e) => setNiche(e.target.value)}><option value="">All niches</option>{['food','health','tech','edtech','travel','cartoon'].map((value) => <option key={value}>{value}</option>)}</select></div></div>{items.length === 0 ? <div className="empty">No content matches these filters. Create a real brief to begin.</div> : <div className="table-wrap"><table className="table"><thead><tr><th>Content brief</th><th>Niche</th><th>Format</th><th>Scheduled</th><th>Status</th><th>Next action</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><Link href={`/content/${item.id}`}><strong>{item.sub_topic}</strong></Link><div className="muted">{item.hook_variation_a || 'Draft without generated hook'}</div></td><td><span className="chip">{item.niche_id}</span></td><td>{item.media_type.replace('_', ' ')}</td><td>{item.scheduled_at ? new Date(item.scheduled_at).toLocaleString() : 'Unscheduled'}</td><td><span className={`status ${item.status}`}>{item.status}</span></td><td>{nextAction(item)}</td></tr>)}</tbody></table></div>}</div></>;
}
