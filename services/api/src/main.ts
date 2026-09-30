import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import telegramWebhook from './routes/webhooks/telegram';
import whatsappWebhook from './routes/webhooks/whatsapp';
import omnirouteWebhook from './routes/webhooks/omniroute';
import contentRoutes from './routes/content';
import queueRoutes from './routes/queues';
import nicheRoutes from './routes/niches';
import accountRoutes from './routes/accounts';
import auditRoutes from './routes/audit';
import settingsRoutes from './routes/settings';
import devRoutes from './routes/dev';
import pipelineRoutes from './routes/pipeline';
import plannerRoutes from './routes/planner';
import insightsRoutes from './routes/insights';
import { startMediaEdge } from './media-edge';

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(helmet());
app.use(cors());
// Keep the raw body so webhook HMAC signatures are verified over the exact bytes sent.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'viralforge-api',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'viralforge-api',
    omnirouteBaseUrl: process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128',
  });
});

app.use('/api/webhooks', telegramWebhook);
app.use('/api/webhooks', whatsappWebhook);
app.use('/api/webhooks', omnirouteWebhook);
app.use('/api', contentRoutes);
app.use('/api', queueRoutes);
app.use('/api', nicheRoutes);
app.use('/api', accountRoutes);
app.use('/api', auditRoutes);
app.use('/api', settingsRoutes);
app.use('/api', devRoutes);
app.use('/api', pipelineRoutes);
app.use('/api', plannerRoutes);
app.use('/api', insightsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
  console.log(`ViralForge API listening on http://localhost:${port}`);
  console.log(`Omniroute URL: ${process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128'}`);
});

// Separate listener so only signed media is ever exposed through a tunnel.
startMediaEdge(Number(process.env.MEDIA_EDGE_PORT || 3100));
