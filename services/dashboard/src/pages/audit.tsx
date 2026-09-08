import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function AuditPage() {
  const [entries, setEntries] = useState<any[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<any>('/api/audit').then((value) => setEntries(value.audit)).catch((e) => setError(e.message)); }, []);
  return <><div className="page-header"><div><h2>Audit history</h2><p>A traceable record of content and workflow actions.</p></div></div>{error && <div className="notice warning">{error}</div>}<div className="card"><div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Content</th><th>Metadata</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleString()}</td><td><span className="chip">{entry.action}</span></td><td>{entry.actor}</td><td className="mono">{entry.content_item_id || '—'}</td><td className="mono">{JSON.stringify(entry.metadata || {})}</td></tr>)}{entries.length === 0 && <tr><td colSpan={5}><div className="empty">No audit events yet. Actions will appear here as you use the workflows.</div></td></tr>}</tbody></table></div></div></>;
}
