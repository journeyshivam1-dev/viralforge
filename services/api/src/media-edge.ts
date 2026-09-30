/**
 * Public media edge: the ONLY surface meant to be exposed through a tunnel.
 * Serves rendered media objects for Meta to fetch, gated by short-lived HMAC
 * signatures. Runs on its own port so the unauthenticated local API and the
 * Supabase stack never need to be reachable from the internet.
 */
import express from 'express';
import helmet from 'helmet';
import { requireSupabaseAdmin } from '@viralforge/supabase';
import { verifyMediaSignature } from '@viralforge/domain';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function startMediaEdge(port: number) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  app.get('/m/media/:contentId/:file', async (req, res) => {
    const storagePath = `media/${req.params.contentId}/${req.params.file}`;
    const exp = typeof req.query.exp === 'string' ? req.query.exp : undefined;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : undefined;
    let valid = false;
    try {
      valid = verifyMediaSignature(storagePath, exp, sig);
    } catch (error) {
      console.error('[MediaEdge] Signing is not configured:', (error as Error).message);
      res.status(503).end();
      return;
    }
    if (!valid) {
      console.warn(`[MediaEdge] Rejected unsigned or expired request from ${req.ip}`);
      res.status(403).end();
      return;
    }
    const extension = storagePath.slice(storagePath.lastIndexOf('.')).toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (!contentType) {
      res.status(404).end();
      return;
    }
    const { data, error } = await requireSupabaseAdmin().storage.from('viralforge-content').download(storagePath);
    if (error || !data) {
      res.status(404).end();
      return;
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.end(buffer);
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => res.status(404).end());

  return app.listen(port, () => console.log(`ViralForge media edge listening on :${port} (expose only this port publicly)`));
}
