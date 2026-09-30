import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { api, ContentItem, PipelineRun } from '../../lib/api';

type GeneratedMetadata = { caption?: string; hashtags?: string[]; scenes?: Array<{ index: number; durationSeconds: number; voiceover: string; onScreenText: string; visualPrompt: string }>; alternateHooks?: string[]; disclosures?: string[]; model?: string; mediaUrl?: string; mediaType?: string };

export default function ContentDetailPage() {
  const router = useRouter();
  const [item, setItem] = useState<ContentItem | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineRun | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const load = async () => {
    if (typeof router.query.id !== 'string') return;
    try {
      const [contentResult, pipelineResult] = await Promise.all([
        api<{ content: ContentItem }>(`/api/content/${router.query.id}`),
        api<{ runs: PipelineRun[] }>(`/api/content/${router.query.id}/pipeline`),
      ]);
      setItem(contentResult.content);
      setPipeline(pipelineResult.runs[0] || null);
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => { void load(); }, [router.query.id]);
  useEffect(() => {
    if (!pipeline || !['pending', 'running', 'waiting', 'blocked'].includes(pipeline.status)) return;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [pipeline?.id, pipeline?.status, router.query.id]);

  const action = async (endpoint: string, body?: Record<string, unknown>) => {
    if (!item) return;
    setBusy(true);
    try {
      const result = await api<any>(`/api/content/${item.id}/${endpoint}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      setMessage(result.message || `Queued ${endpoint} job ${result.job?.id || ''}`);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const uploadMedia = (file: File) => {
    if (!item) return;
    setBusy(true);
    setError('');
    setMessage('');
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result || '').split(',')[1] || String(reader.result || '');
      try {
        const result = await api<any>(`/api/content/${item.id}/upload-media`, {
          method: 'POST',
          body: JSON.stringify({ file: base64, mimeType: file.type || 'application/octet-stream' }),
        });
        setMessage(result.message || `Media uploaded (${Math.round(result.size / 1024)} KB)`);
        load();
      } catch (e: any) { setError(e.message); } finally { setBusy(false); }
    };
    reader.onerror = () => { setError('Failed to read file'); setBusy(false); };
    reader.readAsDataURL(file);
  };

  if (!item) return <div className="card">{error ? <div className="notice warning">{error}</div> : 'Loading content…'}</div>;
  const metadata = (item.ai_generation_metadata || {}) as GeneratedMetadata & {
    sceneArtifacts?: Array<{ sceneIndex: number; kind: string; url: string; mimeType?: string }>;
    mediaManifest?: { artifacts?: Array<{ sceneIndex: number; kind: string; url: string; mimeType?: string }> };
  };
  const sceneArtifacts = metadata.mediaManifest?.artifacts || metadata.sceneArtifacts || [];
  const failedAttempt = pipeline?.stage_attempts
    ?.slice()
    .sort((a, b) => b.attempt_no - a.attempt_no)
    .find((attempt) => ['permanent_failed', 'retryable_failed', 'blocked'].includes(attempt.status));

  const awaitingApproval = pipeline?.status === 'waiting' && pipeline.waiting_reason === 'approval_required';
  const pipelineAction = async (kind: 'resume' | 'retry' | 'approve' | 'reject') => {
    if (!pipeline) return;
    let reason: string | null = null;
    if (kind === 'reject') {
      reason = prompt('Why are you rejecting this post? (optional)', '');
      if (reason === null) return;
    }
    setBusy(true);
    try {
      const body = kind === 'retry'
        ? JSON.stringify({ stage: failedAttempt?.stage || pipeline.current_stage })
        : kind === 'reject' ? JSON.stringify({ reason: reason || 'Rejected from dashboard' }) : undefined;
      const result = await api<any>(`/api/pipeline-runs/${pipeline.id}/${kind}`, {
        method: 'POST',
        body,
      });
      setMessage(result.message || 'Pipeline action requested');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <Link href="/calendar" className="muted">← Back to calendar</Link>
          <h2 style={{ marginTop: 8 }}>{item.sub_topic}</h2>
          <p>{item.niche_id} · {item.media_type.replace('_', ' ')}</p>
        </div>
        <span className={`status ${item.status}`}>{item.status}</span>
      </div>
      {message && <div className="notice info">{message}</div>}
      {error && <div className="notice warning">{error}</div>}

      <div className="grid two">
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}><h3>Editorial brief</h3></div>
          <div className="kicker">Hook</div>
          <p>{item.hook_variation_a || 'Not generated yet.'}</p>
          <div className="kicker">Input details</div>
          <pre style={{ whiteSpace: 'pre-wrap', font: '12px ui-monospace', background: '#f7f8f5', padding: 13, borderRadius: 8 }}>{JSON.stringify(item.data_input_payload, null, 2)}</pre>
          <div className="kicker">Schedule</div>
          <p>{item.scheduled_at ? new Date(item.scheduled_at).toLocaleString() : 'Not scheduled'}</p>
        </div>

        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}><h3>Generated package</h3></div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>{metadata.model ? `Generated by ${metadata.model}` : 'No generation run yet'}</div>
          <div className="kicker">Script</div>
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{item.script_body || 'Start research to generate copy with Omniroute.'}</p>
          {metadata.caption && <><div className="kicker">Caption</div><p>{metadata.caption}</p></>}
          {metadata.hashtags?.length ? <><div className="kicker">Hashtags</div><p>{metadata.hashtags.join(' ')}</p></> : null}
          {metadata.scenes?.length ? <><div className="kicker">Scenes</div>{metadata.scenes.map((scene) => (
            <div className="service-row" key={scene.index}>
              <div>
                <strong>Scene {scene.index}</strong>
                <div className="muted">{scene.voiceover}</div>
                <div className="muted" style={{ fontSize: 11 }}>{scene.visualPrompt}</div>
              </div>
              <span>{scene.durationSeconds}s</span>
            </div>
          ))}</> : null}
          {sceneArtifacts.length > 0 ? <>
            <div className="kicker" style={{ marginTop: 12 }}>Generated scene media</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
              {sceneArtifacts.map((artifact) => (
                <div key={`${artifact.sceneIndex}-${artifact.kind}`}>
                  {artifact.kind === 'video'
                    ? <video controls src={artifact.url} style={{ width: '100%', borderRadius: 8 }} />
                    : <img src={artifact.url} alt={`Scene ${artifact.sceneIndex}`} style={{ width: '100%', borderRadius: 8 }} />}
                  <div className="muted" style={{ fontSize: 11 }}>Scene {artifact.sceneIndex} · {artifact.kind}</div>
                </div>
              ))}
            </div>
          </> : null}
          {item.rendering_manifest?.finalMediaUrl ? <>
            <div className="kicker" style={{ marginTop: 12 }}>Rendered package</div>
            <p className="muted">{item.rendering_manifest.finalMediaUrl}</p>
          </> : null}
          {item.validation_errors?.length ? <div className="notice warning"><strong>Validation blocks</strong><ul>{item.validation_errors.map((e) => <li key={e}>{e}</li>)}</ul></div> : null}
          {item.validation_warnings?.length ? <div className="notice info"><strong>Warnings</strong><ul>{item.validation_warnings.map((e) => <li key={e}>{e}</li>)}</ul></div> : null}

          {pipeline && <div className="notice info">
            <strong>Pipeline: {pipeline.status}</strong> · {pipeline.current_stage}
            {pipeline.waiting_reason ? ` · ${pipeline.waiting_reason.replace(/_/g, ' ')}` : ''}
            {pipeline.error?.message ? <div>{pipeline.error.message}</div> : null}
            {pipeline.stage_attempts?.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).map((attempt) => (
              <div key={attempt.id} className="muted" style={{ fontSize: 11 }}>
                {attempt.stage} #{attempt.attempt_no}: {attempt.status}{attempt.error?.message ? ` — ${attempt.error.message}` : ''}
              </div>
            ))}
          </div>}

          <div className="form-actions">
            {item.status === 'draft' && !pipeline && <button className="button primary" onClick={() => action('queue')} disabled={busy}>Start pipeline</button>}
            {pipeline?.status === 'failed' && <button className="button primary" onClick={() => pipelineAction('retry')} disabled={busy}>Retry {failedAttempt?.stage || pipeline.current_stage} (keeps earlier steps)</button>}
            {pipeline?.status === 'blocked' && <button className="button secondary" onClick={() => pipelineAction('resume')} disabled={busy}>Resume after configuration</button>}
            {item.status === 'researched' && !pipeline && <button className="button primary" onClick={() => action('generate')} disabled={busy}>Generate with Omniroute</button>}
            {item.status === 'generated' && !sceneArtifacts.length && !pipeline && <button className="button primary" onClick={() => action('media')} disabled={busy}>Generate media</button>}
            {item.status === 'generated' && !sceneArtifacts.length && !pipeline && <button className="button secondary" onClick={() => action('media/force')} disabled={busy}>Force media retry</button>}
            {item.status === 'generated' && !sceneArtifacts.length && !pipeline && (
              <>
                <button className="button secondary" onClick={() => fileInputRef.current?.click()} disabled={busy}>Upload my own media</button>
                <input ref={fileInputRef} type="file" accept="video/*,image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadMedia(f); }} />
              </>
            )}
            {item.status === 'rendering' && <button className="button secondary" onClick={() => action('render')} disabled={busy}>Render final video</button>}
            {awaitingApproval && <button className="button primary" onClick={() => pipelineAction('approve')} disabled={busy}>✅ Approve for {item.scheduled_at ? new Date(item.scheduled_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST' : 'publishing'}</button>}
            {awaitingApproval && <button className="button danger" onClick={() => pipelineAction('reject')} disabled={busy}>Reject</button>}
            {item.status === 'published' && <span className="muted">Published successfully</span>}
            {['queued'].includes(item.status) && <span className="muted">Pipeline job is running…</span>}
          </div>
        </div>
      </div>
    </>
  );
}