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

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
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

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
  console.log(`ViralForge API listening on http://localhost:${port}`);
  console.log(`Omniroute URL: ${process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128'}`);
});
