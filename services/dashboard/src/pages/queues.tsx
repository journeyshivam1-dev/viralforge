import { useEffect, useState } from 'react';
import { api, QueueSummary, JobDetail } from '../lib/api';

export default function QueuesPage() {
  const [queues, setQueues] = useState<QueueSummary[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<{ queue: string; job: JobDetail } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ queues: QueueSummary[] }>('/api/queues').then((value) => setQueues(value.queues)).catch((e) => setError(e.message));
  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, []);

  const retry = async (queue: string, id: string) => {
    setBusy(true);
    try { await api(`/api/queues/${queue}/jobs/${id}/retry`, { method: 'POST' }); load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const discard = async (queue: string, id: string) => {
    if (!confirm('Remove this job from the queue? It cannot be undone.')) return;
    setBusy(true);
    try { await api(`/api/queues/${queue}/jobs/${id}`, { method: 'DELETE' }); load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const openJob = async (queue: string, id: string) => {
    try {
      const result = await api<{ job: JobDetail }>(`/api/queues/${queue}/jobs/${id}`);
      setSelected({ queue, job: result.job });
    } catch (e: any) { setError(e.message); }
  };

  const stateClass = (state?: string) => {
    if (state === 'failed') return 'failed';
    if (state === 'active' || state === 'waiting' || state === 'delayed') return 'queued';
    if (state === 'completed') return 'published';
    return 'draft';
  };

  return (
    <>
      <div className="page-header">
        <div><h2>Queue monitor</h2><p>Watch the content pipeline as jobs move from research to publishing.</p></div>
        <button className="button secondary" onClick={load} disabled={busy}>↻ Refresh</button>
      </div>
      {error && <div className="notice warning">{error}</div>}
      <div className="grid three">
        {queues.map((queue) => {
          const active = Number(queue.counts?.active || 0);
          const waiting = Number(queue.counts?.waiting || 0);
          const failed = Number(queue.counts?.failed || 0);
          return (
            <div className="card" key={queue.name}>
              <div className="kicker">{queue.name.replace('viralforge-', '')}</div>
              <div style={{ display: 'flex', gap: 17, marginTop: 16 }}>
                <div><div className="stat-value" style={{ fontSize: 24 }}>{waiting}</div><small className="muted">waiting</small></div>
                <div><div className="stat-value" style={{ fontSize: 24 }}>{active}</div><small className="muted">active</small></div>
                <div><div className="stat-value" style={{ fontSize: 24, color: failed ? '#ae4e4e' : undefined }}>{failed}</div><small className="muted">failed</small></div>
              </div>
              <div className="queue-bar"><div style={{ width: `${Math.min(100, active * 20 + waiting * 5)}%` }} /></div>
            </div>
          );
        })}
      </div>

      <div className="section-title"><h3>Failed jobs</h3></div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Queue</th><th>Job</th><th>Reason</th><th /></tr>
            </thead>
            <tbody>
              {queues.flatMap((queue) =>
                (queue.jobs?.failed || []).map((job) => (
                  <tr key={`${queue.name}-${job.id}`}>
                    <td>{queue.name.replace('viralforge-', '')}</td>
                    <td className="mono"><a href="#" onClick={(e) => { e.preventDefault(); openJob(queue.name, job.id); }}>{job.id}</a></td>
                    <td>{job.failedReason || 'Unknown error'}</td>
                    <td>
                      <button className="button secondary" onClick={() => openJob(queue.name, job.id)}>Details</button>
                      <button className="button secondary" onClick={() => retry(queue.name, job.id)}>Retry</button>
                      <button className="button danger" onClick={() => discard(queue.name, job.id)}>Discard</button>
                    </td>
                  </tr>
                ))
              )}
              {queues.every((queue) => !queue.jobs?.failed?.length) && (
                <tr><td colSpan={4}><div className="empty">No failed jobs. Your pipeline is clear.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="section-title" style={{ marginTop: 0 }}>
            <h3>Job detail — {selected.queue.replace('viralforge-', '')}</h3>
            <button className="button secondary" onClick={() => setSelected(null)}>Close</button>
          </div>
          <div className="grid two">
            <div>
              <div className="kicker">Job ID</div>
              <p className="mono">{selected.job.id}</p>
              <div className="kicker">Type</div>
              <p>{selected.job.name}</p>
              <div className="kicker">State</div>
              <p><span className={`status ${stateClass(selected.job.state)}`}>{selected.job.state || 'unknown'}</span></p>
              <div className="kicker">Progress</div>
              <p>{selected.job.progress ?? 0}%</p>
            </div>
            <div>
              <div className="kicker">Failed reason</div>
              <p className="muted">{selected.job.failedReason || 'None'}</p>
              <div className="kicker">Timestamp</div>
              <p className="muted">{selected.job.timestamp ? new Date(selected.job.timestamp).toLocaleString() : 'n/a'}</p>
              <div className="kicker">Processed / finished</div>
              <p className="muted">
                {selected.job.processedOn ? new Date(selected.job.processedOn).toLocaleString() : '—'}
                {' / '}
                {selected.job.finishedOn ? new Date(selected.job.finishedOn).toLocaleString() : '—'}
              </p>
              <div className="form-actions">
                <button className="button secondary" onClick={() => retry(selected.queue, selected.job.id)} disabled={busy}>Retry</button>
                <button className="button danger" onClick={() => discard(selected.queue, selected.job.id)} disabled={busy}>Discard</button>
              </div>
            </div>
          </div>
          <div className="kicker" style={{ marginTop: 16 }}>Job payload</div>
          <pre style={{ whiteSpace: 'pre-wrap', font: '12px ui-monospace', background: '#f7f8f5', padding: 13, borderRadius: 8 }}>{JSON.stringify(selected.job.data, null, 2)}</pre>
        </div>
      )}
    </>
  );
}