import { FormEvent, useState } from 'react';
import { useRouter } from 'next/router';
import { api } from '../../lib/api';

const fields: Record<string, { key: string; label: string; placeholder: string }[]> = {
  food: [{ key: 'dish', label: 'Dish', placeholder: 'Aloo paratha' }, { key: 'region', label: 'Region', placeholder: 'Punjab' }, { key: 'cookTime', label: 'Cook time (minutes)', placeholder: '30' }, { key: 'difficulty', label: 'Difficulty', placeholder: 'easy' }],
  health: [{ key: 'originalDish', label: 'Original dish', placeholder: 'Regular poha' }, { key: 'transformedDish', label: 'Healthy transformation', placeholder: 'Protein poha' }, { key: 'healthGoal', label: 'Health goal', placeholder: 'Balanced breakfast' }],
  tech: [{ key: 'toolName', label: 'Tool name', placeholder: 'Notion AI' }, { key: 'feature', label: 'Feature', placeholder: 'Meeting summaries' }, { key: 'painPoint', label: 'Pain point', placeholder: 'Too many notes' }],
  edtech: [{ key: 'exam', label: 'Exam', placeholder: 'UPSC' }, { key: 'subject', label: 'Subject', placeholder: 'History' }, { key: 'topic', label: 'Topic', placeholder: 'Modern India' }, { key: 'cheatCode', label: 'Shortcut or mnemonic', placeholder: 'Your memory trick' }],
  travel: [{ key: 'location', label: 'Location', placeholder: 'Lonavala' }, { key: 'baseCity', label: 'Base city', placeholder: 'Mumbai' }, { key: 'budgetPerHead', label: 'Budget per head (INR)', placeholder: '1500' }],
  cartoon: [{ key: 'dialect', label: 'Dialect', placeholder: 'Delhi Hindi' }, { key: 'theme', label: 'Theme', placeholder: 'Family WhatsApp group' }, { key: 'characters', label: 'Characters', placeholder: 'Mummy, beta, papa' }],
};

export default function NewContentPage() {
  const router = useRouter();
  const [niche, setNiche] = useState('food');
  const [topic, setTopic] = useState('Quick ghar-ka-khana');
  const [mediaType, setMediaType] = useState('video_reel');
  const [schedule, setSchedule] = useState('');
  const [payload, setPayload] = useState<Record<string, string>>({ dish: 'Aloo Paratha', region: 'Punjab' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const updateNiche = (value: string) => { setNiche(value); setPayload({}); };
  const updatePayload = (key: string, value: string) => setPayload((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent, queue = false) => { event.preventDefault(); setSaving(true); setError(''); try { const result = await api<{ content: { id: string } }>('/api/content', { method: 'POST', body: JSON.stringify({ niche_id: niche, sub_topic: topic, data_input_payload: payload, media_type: mediaType, scheduled_at: schedule ? new Date(schedule).toISOString() : null }) }); if (queue) await api(`/api/content/${result.content.id}/queue`, { method: 'POST' }); router.push(`/content/${result.content.id}`); } catch (e: any) { setError(e.message); } finally { setSaving(false); } };
  return <><div className="page-header"><div><h2>Create a content brief</h2><p>Turn a simple idea into a structured, reviewable pipeline item.</p></div></div>{error && <div className="notice warning">{error}</div>}<form className="card" onSubmit={(e) => submit(e)}><div className="form-grid"><div className="field"><label>Niche</label><select value={niche} onChange={(e) => updateNiche(e.target.value)}>{['food','health','tech','edtech','travel','cartoon'].map((value) => <option key={value}>{value}</option>)}</select></div><div className="field"><label>Content pillar / topic</label><input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Quick recipes" required /></div><div className="field"><label>Media format</label><select value={mediaType} onChange={(e) => setMediaType(e.target.value)}><option value="video_reel">Vertical video reel</option><option value="image_carousel">Image carousel</option><option value="image_single">Single image</option></select></div><div className="field"><label>Schedule (optional)</label><input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} /></div><div className="field full"><label>Niche details</label><div className="form-grid" style={{ padding: 15, background: '#f7f8f5', borderRadius: 9 }}>{fields[niche].map((field) => <div className="field" key={field.key}><label>{field.label}</label><input value={payload[field.key] || ''} placeholder={field.placeholder} onChange={(e) => updatePayload(field.key, e.target.value)} required={['dish','region','originalDish','transformedDish','toolName','exam','location','dialect'].includes(field.key)} /></div>)}</div></div><div className="field full"><label>Editorial notes (optional)</label><textarea placeholder="Add constraints, source notes or a specific CTA…" value={payload.notes || ''} onChange={(e) => updatePayload('notes', e.target.value)} /></div></div><div className="form-actions"><button type="submit" className="button secondary" disabled={saving}>Save draft</button><button type="button" className="button primary" disabled={saving} onClick={(e) => submit(e, true)}>{saving ? 'Creating…' : 'Create and queue generation'}</button></div></form></>;
}
