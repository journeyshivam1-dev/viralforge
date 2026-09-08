import { Router } from 'express';
import Redis from 'ioredis';
import { asyncRoute } from './_helpers';
import { supabase } from '@viralforge/supabase';
import { createOmnirouteAdapter } from '@viralforge/domain';

const router = Router();

router.get('/settings', asyncRoute(async (_req, res) => {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  let redisOk = false;
  let redisError: string | null = null;
  try {
    await redis.connect();
    const pong = await redis.ping();
    redisOk = pong === 'PONG';
  } catch (error) {
    redisError = error instanceof Error ? error.message : String(error);
  } finally {
    await redis.quit().catch(() => undefined);
  }

  let databaseOk = false;
  let databaseError: string | null = null;
  try {
    const { error } = await supabase.from('organizations').select('id', { count: 'exact', head: true });
    databaseOk = !error;
    databaseError = error?.message || null;
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error);
  }

  let omnirouteOk = false;
  let omnirouteError: string | null = null;
  let omnirouteModels: string[] = [];
  const omnirouteBaseUrl = process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128';
  const omniroute = createOmnirouteAdapter(
    omnirouteBaseUrl,
    process.env.OMNIROUTE_API_KEY || '',
    process.env.OMNIROUTE_WEBHOOK_SECRET || '',
    10000,
    { textModel: process.env.OMNIROUTE_TEXT_MODEL || 'auto/best-chat' },
  );
  try {
    const [healthy, models] = await Promise.all([
      omniroute.healthCheck(),
      omniroute.getModels(),
    ]);
    omnirouteOk = healthy && models.length > 0;
    omnirouteModels = models.slice(0, 20).map((model) => model.id);
    if (!healthy) omnirouteError = 'Omniroute /api/health is unavailable';
    else if (models.length === 0) omnirouteError = 'No models available for this API key';
  } catch (error) {
    omnirouteError = error instanceof Error ? error.message : String(error);
  }

  res.json({
    ok: true,
    environment: process.env.NODE_ENV || 'development',
    publishingDisabled: process.env.PUBLISHING_DISABLED !== 'false',
    services: {
      api: { ok: true, url: `http://localhost:${process.env.PORT || 3000}` },
      redis: { ok: redisOk, url: process.env.REDIS_URL || 'redis://localhost:6379', error: redisError },
      database: { ok: databaseOk, provider: 'supabase', error: databaseError },
      omniroute: {
        ok: omnirouteOk,
        url: omnirouteBaseUrl,
        error: omnirouteError,
        model: process.env.OMNIROUTE_TEXT_MODEL || 'auto/best-chat',
        availableModels: omnirouteModels,
      },
    },
    limits: {
      maxPostsPerDayPerAccount: Number(process.env.MAX_POSTS_PER_DAY_PER_ACCOUNT || 5),
      maxJobsPerHourPerOrg: Number(process.env.MAX_JOBS_PER_HOUR_PER_ORG || 50),
      publishingRetryMax: Number(process.env.PUBLISHING_RETRY_MAX || 3),
    },
  });
}));

router.patch('/settings', asyncRoute(async (_req, res) => {
  res.status(409).json({
    ok: false,
    error: 'Runtime settings are read-only in local safe mode. Change .env and restart services.',
  });
}));

export default router;
