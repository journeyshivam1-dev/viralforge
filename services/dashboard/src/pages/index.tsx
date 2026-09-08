import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ContentItem, QueueSummary } from '../lib/api';

export default function HomePage() {
  const [content, setContent] = useState<ContentItem[]>([]);
  const [queues, setQueues] = useState<QueueSummary[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api<{ content: ContentItem[] }>('/api/content').then((value) => setContent(value.content)).catch(() => undefined),
      api<{ queues: QueueSummary[] }>('/api/queues').then((value) => setQueues(value.queues)).catch(() => undefined),
      api<any>('/api/settings').then(setSettings).catch(() => undefined),
    ]).finally(() => setLoading(false));
  }, []);

  const byStatus = (status: string) => content.filter((item) => item.status === status).length;
  const queuedJobs = queues.reduce((total, queue) => total + Object.entries(queue.counts || {}).filter(([key]) => ['waiting', 'active', 'delayed'].includes(key)).reduce((sum, [, value]) => sum + Number(value), 0), 0);

  return <>
    <div className="page-header"><div><h2>Good morning, creator</h2><p>Your Hindi content operation at a glance.</p></div><Link href="/content/new" className="button primary">＋ Create a content brief</Link></div>
    <div className="grid four">
      <div className="card stat-card"><div className="stat-label">All content</div><div className="stat-value">{loading ? '—' : content.length}</div><div className="stat-foot">Across your calendar</div></div>
      <div className="card stat-card"><div className="stat-label">Ready to publish</div><div className="stat-value">{loading ? '—' : byStatus('validated') + byStatus('scheduled')}</div><div className="stat-foot">Validated / scheduled</div></div>
      <div className="card stat-card"><div className="stat-label">In the pipeline</div><div className="stat-value">{loading ? '—' : queuedJobs}</div><div className="stat-foot">Waiting, active or delayed</div></div>
      <div className="card stat-card"><div className="stat-label">Published</div><div className="stat-value">{loading ? '—' : byStatus('published')}</div><div className="stat-foot">Safe-mode history</div></div>
    </div>
    <div className="grid two" style={{ marginTop: 28 }}>
      <div className="card"><div className="section-title" style={{ marginTop: 0 }}><h3>Recent content</h3><Link href="/calendar">View calendar →</Link></div>{content.length === 0 ? <div className="empty">No content yet. Create your first brief to start the pipeline.</div> : <div className="table-wrap"><table className="table"><thead><tr><th>Topic</th><th>Niche</th><th>Status</th></tr></thead><tbody>{content.slice(0, 6).map((item) => <tr key={item.id}><td><Link href={`/content/${item.id}`}><strong>{item.sub_topic}</strong></Link><div className="muted">{item.hook_variation_a || 'No hook yet'}</div></td><td>{item.niche_id}</td><td><span className={`status ${item.status}`}>{item.status}</span></td></tr>)}</tbody></table></div>}</div>
      <div className="card"><div className="section-title" style={{ marginTop: 0 }}><h3>System readiness</h3><Link href="/settings">Details →</Link></div>{settings ? <><div className="service-row"><span>API</span><span className="service-status ok">● Online</span></div><div className="service-row"><span>Redis queues</span><span className={`service-status ${settings.services?.redis?.ok ? 'ok' : 'off'}`}>● {settings.services?.redis?.ok ? 'Connected' : 'Offline'}</span></div><div className="service-row"><span>Database</span><span className={`service-status ${settings.services?.database?.ok ? 'ok' : 'off'}`}>● {settings.services?.database?.ok ? 'Connected' : 'Needs setup'}</span></div><div className="service-row"><span>Omniroute</span><span className={`service-status ${settings.services?.omniroute?.ok ? 'ok' : 'off'}`}>● {settings.services?.omniroute?.ok ? 'Ready' : 'Not detected'}</span></div><div className="notice warning" style={{ marginTop: 16, marginBottom: 0 }}>Publishing is protected by the global kill switch. You can build and queue content without sending anything to Meta.</div></> : <div className="empty">Loading service status…</div>}</div>
    </div>
    <div className="section-title"><h3>Pipeline snapshot</h3><Link href="/queues">Open queue monitor →</Link></div><div className="grid four">{['draft', 'queued', 'generated', 'validated'].map((status) => <div className="card" key={status}><div className="kicker">{status}</div><div className="stat-value" style={{ fontSize: 24 }}>{byStatus(status)}</div><div className="queue-bar"><div style={{ width: `${Math.min(100, byStatus(status) * 15 + 5)}%` }} /></div></div>)}</div>
  </>;
}
