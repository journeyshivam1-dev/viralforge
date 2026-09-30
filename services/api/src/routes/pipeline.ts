import { Router } from 'express';
import { z } from 'zod';
import { getPipelineForContent, getPipelineRun, resumePipeline, retryPipelineFromStage, approveContent, rejectContent } from '../pipeline/orchestrator';
import { asyncRoute, sendError } from './_helpers';

const router = Router();
const runIdSchema = z.string().uuid();
const retrySchema = z.object({
  stage: z.enum(['research', 'generation', 'media', 'rendering', 'validation', 'publishing']),
});

router.get('/content/:id/pipeline', asyncRoute(async (req, res) => {
  if (!runIdSchema.safeParse(req.params.id).success) return sendError(res, 400, 'Invalid content ID');
  const runs = await getPipelineForContent(req.params.id);
  res.json({ ok: true, runs });
}));

router.get('/pipeline-runs/:id', asyncRoute(async (req, res) => {
  if (!runIdSchema.safeParse(req.params.id).success) return sendError(res, 400, 'Invalid run ID');
  const run = await getPipelineRun(req.params.id);
  res.json({ ok: true, run });
}));

router.post('/pipeline-runs/:id/resume', asyncRoute(async (req, res) => {
  if (!runIdSchema.safeParse(req.params.id).success) return sendError(res, 400, 'Invalid run ID');
  const result = await resumePipeline(req.params.id, 'dashboard');
  res.json({ ok: true, ...result, message: 'Pipeline resume requested' });
}));

router.post('/pipeline-runs/:id/retry', asyncRoute(async (req, res) => {
  if (!runIdSchema.safeParse(req.params.id).success) return sendError(res, 400, 'Invalid run ID');
  const parsed = retrySchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'Invalid retry request', parsed.error.flatten());
  const result = await retryPipelineFromStage(req.params.id, parsed.data.stage, 'dashboard');
  res.json({ ok: true, ...result, message: `${parsed.data.stage} retry requested` });
}));

router.post('/pipeline-runs/:id/approve', asyncRoute(async (req, res) => {
  if (!runIdSchema.safeParse(req.params.id).success) return sendError(res, 400, 'Invalid run ID');
  const result = await approveContent(req.params.id, req.body.approvedBy || 'dashboard');
  res.json({ ok: true, ...result, message: 'Content approved for publishing' });
}));

router.post('/pipeline-runs/:id/reject', asyncRoute(async (req, res) => {
  if (!runIdSchema.safeParse(req.params.id).success) return sendError(res, 400, 'Invalid run ID');
  const result = await rejectContent(req.params.id, req.body.reason || 'rejected_by_operator');
  res.json({ ok: true, ...result, message: 'Content rejected' });
}));

export default router;
