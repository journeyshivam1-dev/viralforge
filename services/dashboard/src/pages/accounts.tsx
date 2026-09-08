import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Account = { id: string; account_name: string; platform: string; niche_id: string; status: string; metadata?: { localDev?: boolean } };
type Candidate = { platform: 'instagram' | 'facebook'; account_id: string; account_name: string; page_id?: string };

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [niche, setNiche] = useState('food');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [oauthState, setOauthState] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = () => api<{ accounts: Account[] }>('/api/accounts').then((result) => setAccounts(result.accounts || [])).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get('meta_connection');
    const state = params.get('state');
    if (encoded && state) {
      try { setCandidates(JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')))); setOauthState(state); setMessage('Meta accounts discovered. Select an account and niche to finish connection.'); } catch { setError('Meta returned an invalid account selection payload.'); }
    }
  }, []);
  const connect = async () => {
    try { const result = await api<{ authorizationUrl: string }>('/api/accounts/meta/connect-url'); window.location.assign(result.authorizationUrl); }
    catch (e: any) { setError(e.message); }
  };
  const select = async (candidate: Candidate) => {
    try { await api('/api/accounts/meta/select', { method: 'POST', body: JSON.stringify({ state: oauthState, niche_id: niche, platform: candidate.platform, account_id: candidate.account_id }) }); setCandidates([]); setOauthState(''); setMessage(`${candidate.account_name} connected successfully.`); load(); }
    catch (e: any) { setError(e.message); }
  };
  return <><div className="page-header"><div><h2>Connected accounts</h2><p>Connect real Facebook Pages and Instagram professional accounts through Meta OAuth.</p></div><button className="button primary" onClick={connect}>Connect Meta account</button></div>{message && <div className="notice info">{message}</div>}{error && <div className="notice warning">{error}</div>}{candidates.length > 0 && <div className="card" style={{ marginBottom: 17 }}><div className="section-title" style={{ marginTop: 0 }}><h3>Select a discovered Meta account</h3></div><div className="field"><label>Assign niche</label><select value={niche} onChange={(e) => setNiche(e.target.value)}>{['food','health','tech','edtech','travel','cartoon'].map((value) => <option key={value}>{value}</option>)}</select></div>{candidates.map((candidate) => <div className="service-row" key={`${candidate.platform}-${candidate.account_id}`}><div><strong>{candidate.account_name}</strong><div className="muted">{candidate.platform}{candidate.page_id ? ` · Page ${candidate.page_id}` : ''}</div></div><button className="button secondary" onClick={() => select(candidate)}>Connect</button></div>)}</div>}<div className="card"><div className="section-title" style={{ marginTop: 0 }}><h3>Connected Meta assets</h3></div>{accounts.length === 0 ? <div className="empty">No real Meta accounts connected. Use “Connect Meta account” to begin the official OAuth flow.</div> : accounts.map((account) => <div className="service-row" key={account.id}><div><strong>{account.account_name}</strong><div className="muted">{account.platform} · {account.niche_id}</div></div><span className={`status ${account.metadata?.localDev ? 'draft' : account.status}`}>{account.metadata?.localDev ? 'not publishable' : account.status}</span></div>)}</div></>;
}
