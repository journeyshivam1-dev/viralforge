import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function NichesPage() {
  const [niches, setNiches] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [message, setMessage] = useState('');
  const load = () => Promise.all([api<any>('/api/niches'), api<any>('/api/niche-profiles')]).then(([n, p]) => { setNiches(n.niches); setProfiles(p.profiles); }).catch((e) => setMessage(e.message));
  useEffect(() => { load(); }, []);
  const bootstrap = async () => { try { const result = await api<any>('/api/dev/bootstrap', { method: 'POST' }); setMessage(`Local studio ready. ${result.profilesCreated} niche profiles available.`); load(); } catch (e: any) { setMessage(e.message); } };
  return <><div className="page-header"><div><h2>Niche profiles</h2><p>Shape the voice, pillars and publishing limits for each channel.</p></div><button className="button primary" onClick={bootstrap}>Set up local studio</button></div>{message && <div className="notice info">{message}</div>}<div className="grid three">{niches.map((niche) => { const profile = profiles.find((p) => p.niche_id === niche.id); return <div className="card niche-card" key={niche.id}><div className="kicker">{niche.id}</div><h3>{profile?.name || niche.name}</h3><p>{profile?.description || niche.description}</p><div>{(profile?.content_pillars || niche.pillars).map((pillar: string) => <span className="chip" key={pillar}>{pillar}</span>)}</div><div className="service-row"><span>Daily limit</span><strong>{profile?.max_posts_per_day || 5} posts</strong></div><div className="service-row"><span>Auto-publish</span><span className="service-status off">Disabled</span></div></div> })}</div></>;
}
