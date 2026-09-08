import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '@viralforge/supabase';
import { createMetaOAuth } from '@viralforge/domain';
import { asyncRoute, ensureDefaultOrganization, sendError } from './_helpers';

const router = Router();
const stateTtlMs = 10 * 60 * 1000;
interface MetaCandidate {
  platform: 'instagram' | 'facebook';
  account_id: string;
  account_name: string;
  page_id?: string;
  access_token: string;
}

interface OAuthState {
  organizationId: string;
  expiresAt: number;
  connection?: {
    candidates: MetaCandidate[];
    accessToken: string;
    expiresIn?: number;
  };
}

const oauthStates = new Map<string, OAuthState>();

const chooseAccountSchema = z.object({
  state: z.string().min(20),
  niche_id: z.enum(['food', 'health', 'tech', 'edtech', 'travel', 'cartoon']),
  platform: z.enum(['instagram', 'facebook']),
  account_id: z.string().min(1),
});

function getOAuthConfig() {
  const appId = process.env.META_APP_ID || '';
  const appSecret = process.env.META_APP_SECRET || '';
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI || '';
  if (!appId || appId.startsWith('your-') || !appSecret || appSecret.startsWith('your-') || !redirectUri) {
    throw new Error('Meta OAuth is not configured. Set META_APP_ID, META_APP_SECRET, and META_OAUTH_REDIRECT_URI.');
  }
  return { appId, appSecret, redirectUri };
}

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of oauthStates.entries()) {
    if (entry.expiresAt <= now) oauthStates.delete(state);
  }
}

router.get('/accounts', asyncRoute(async (_req, res) => {
  const orgId = await ensureDefaultOrganization();
  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, organization_id, niche_id, platform, account_name, account_id, account_type, token_expires_at, status, last_health_check, metadata, created_at, updated_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return sendError(res, 500, 'Failed to list accounts', error.message);
  res.json({ ok: true, accounts: data || [] });
}));

router.get('/accounts/meta/connect-url', asyncRoute(async (_req, res) => {
  const organizationId = await ensureDefaultOrganization();
  const { appId, appSecret, redirectUri } = getOAuthConfig();
  cleanupExpiredStates();
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { organizationId, expiresAt: Date.now() + stateTtlMs });
  const oauth = createMetaOAuth(appId, appSecret, redirectUri);
  res.json({
    ok: true,
    authorizationUrl: oauth.getAuthorizationUrl(state),
    expiresAt: new Date(Date.now() + stateTtlMs).toISOString(),
  });
}));

router.get('/accounts/meta/callback', asyncRoute(async (req, res): Promise<void> => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const entry = oauthStates.get(state);
  oauthStates.delete(state);

  if (!code || !entry || entry.expiresAt < Date.now()) {
    res.status(400).send('Meta account connection expired or was rejected. Return to ViralForge and try again.');
    return;
  }

  const { appId, appSecret, redirectUri } = getOAuthConfig();
  const oauth = createMetaOAuth(appId, appSecret, redirectUri);
  const shortLived = await oauth.exchangeCodeForToken(code);
  const longLived = await oauth.getLongLivedToken(shortLived.accessToken);
  const pages = await oauth.getUserPages(longLived.accessToken);

  const candidates: MetaCandidate[] = [];
  for (const page of pages) {
    const pageId = String(page.id || '');
    if (!pageId) continue;
    const pageAccessToken = String(page.access_token || longLived.accessToken);
    candidates.push({
      platform: 'facebook',
      account_id: pageId,
      account_name: String(page.name || `Facebook Page ${pageId}`),
      access_token: pageAccessToken,
    });
    const instagram = await oauth.getInstagramAccount(pageId, pageAccessToken);
    if (instagram?.id) {
      candidates.push({
        platform: 'instagram',
        account_id: String(instagram.id),
        account_name: String(instagram.username || page.name || `Instagram ${instagram.id}`),
        page_id: pageId,
        access_token: pageAccessToken,
      });
    }
  }

  const connectState = crypto.randomBytes(32).toString('hex');
  oauthStates.set(connectState, {
    organizationId: entry.organizationId,
    expiresAt: Date.now() + stateTtlMs,
    connection: {
      candidates,
      accessToken: longLived.accessToken,
      expiresIn: longLived.expiresIn,
    },
  });
  const selectableAccounts = Buffer.from(JSON.stringify(candidates.map(({ access_token, ...candidate }) => candidate)), 'utf8').toString('base64url');
  res.redirect(`/accounts?meta_connection=${encodeURIComponent(selectableAccounts)}&state=${connectState}`);
}));

router.post('/accounts/meta/select', asyncRoute(async (req: Request, res: Response) => {
  const parsed = chooseAccountSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'Invalid Meta account selection', parsed.error.flatten());
  const entry = oauthStates.get(parsed.data.state);
  oauthStates.delete(parsed.data.state);
  if (!entry || entry.expiresAt < Date.now() || !entry.connection) {
    return sendError(res, 400, 'Meta account selection expired. Start the connection again.');
  }

  const connection = entry.connection;
  const selected = connection.candidates.find((candidate) =>
    candidate.platform === parsed.data.platform && candidate.account_id === parsed.data.account_id,
  );
  if (!selected) return sendError(res, 400, 'Selected Meta account was not discovered during OAuth');

  const expiresAt = connection.expiresIn
    ? new Date(Date.now() + connection.expiresIn * 1000).toISOString()
    : null;

  const { data, error } = await supabase.from('connected_accounts').upsert({
    organization_id: entry.organizationId,
    niche_id: parsed.data.niche_id,
    platform: parsed.data.platform,
    account_name: String(selected.account_name),
    account_id: parsed.data.account_id,
    account_type: parsed.data.platform === 'instagram' ? 'professional' : 'business',
    // Token encryption is introduced with the production KMS migration. It stays server-only.
    encrypted_access_token: selected.access_token,
    token_expires_at: expiresAt,
    status: 'active',
    last_health_check: new Date().toISOString(),
    metadata: {
      source: 'meta-oauth',
      pageId: selected.page_id || null,
      connectedAt: new Date().toISOString(),
      localDev: false,
    },
  }, { onConflict: 'organization_id,niche_id,platform' }).select('*').single();

  if (error || !data) return sendError(res, 500, 'Failed to store connected Meta account', error?.message);
  res.status(201).json({ ok: true, account: data });
}));

router.post('/accounts/:id/health', asyncRoute(async (req, res) => {
  const orgId = await ensureDefaultOrganization();
  const { data: account, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', req.params.id)
    .eq('organization_id', orgId)
    .single();
  if (error || !account) return sendError(res, 404, 'Connected account not found', error?.message);
  if (account.metadata?.localDev) return sendError(res, 409, 'Local development accounts cannot be used for Meta health checks');

  const response = await fetch(`https://graph.facebook.com/v21.0/${account.account_id}?fields=id,name,username&access_token=${encodeURIComponent(account.encrypted_access_token)}`);
  const json = await response.json().catch(() => ({}));
  const body = json as { id?: string; name?: string; username?: string; error?: { message?: string } };
  const status = response.ok ? 'active' : 'expired';
  await supabase.from('connected_accounts').update({
    status,
    last_health_check: new Date().toISOString(),
    metadata: { ...account.metadata, lastHealthResponse: response.ok ? { id: body.id, name: body.name, username: body.username } : { error: body.error?.message || `HTTP ${response.status}` } },
  }).eq('id', account.id);

  res.json({ ok: response.ok, status, accountId: account.id, details: response.ok ? body : body.error || body });
}));

router.delete('/accounts/:id', asyncRoute(async (req, res) => {
  const orgId = await ensureDefaultOrganization();
  const { error } = await supabase.from('connected_accounts').delete().eq('id', req.params.id).eq('organization_id', orgId);
  if (error) return sendError(res, 500, 'Failed to disconnect account', error.message);
  res.json({ ok: true });
}));

export default router;
