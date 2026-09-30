# Meta setup: Instagram + Facebook publishing, WhatsApp alerts

ViralForge publishes each niche's posts to **one Facebook Page + its linked Instagram professional account**.
5 niches → 5 Pages and 5 Instagram accounts (10 connections).

## 0. Check your existing app first

If you already have an app with `instagram_content_publish` and `pages_manage_posts`, confirm:

1. **App Dashboard → App settings → Basic**: note the App ID and App Secret.
2. **Facebook Login for Business → Configurations** has a configuration that includes the permissions in step 3 below. Note its **Configuration ID**.
3. **Facebook Login for Business → Settings → Valid OAuth Redirect URIs** contains `http://localhost:3000/api/accounts/meta/callback`.
4. You (the operator) have an **app role** (Admin/Developer/Tester). In *Development* mode only people with a role can connect accounts, which is all you need to post to your own Pages.

If all four are true, skip to step 5.

## 1. Create the app (only if recreating)

1. <https://developers.facebook.com/apps> → **Create app**.
2. Use case: **Other** → app type **Business**. Attach it to your Business portfolio.
3. Add products: **Facebook Login for Business** and **Instagram** (choose *API setup with Facebook login*).

## 2. Prepare the accounts

For each niche:

1. A Facebook **Page** you admin.
2. An Instagram account switched to **Professional** (Creator or Business): Instagram → Settings → Account type.
3. Link them: Page → Settings → **Linked accounts → Instagram** (or Meta Accounts Center).

## 3. Login configuration

**Facebook Login for Business → Configurations → Create configuration**:

- Login variation: **General**
- Access token: **User access token**
- Assets: **Pages**, **Instagram accounts**
- Permissions:
  - `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
  - `instagram_basic`, `instagram_content_publish`
  - `business_management` (only if your Pages live in a Business portfolio)

Copy the **Configuration ID**.

## 4. `.env`

```
META_APP_ID=...
META_APP_SECRET=...
META_LOGIN_CONFIG_ID=...
META_OAUTH_REDIRECT_URI=http://localhost:3000/api/accounts/meta/callback
META_GRAPH_VERSION=v23.0
TOKEN_ENCRYPTION_KEY=...   # already generated locally; keep it stable or tokens become unreadable
```

## 5. Connect accounts

Dashboard → **Connected accounts → Connect Meta**. After login, pick the Page **and** the Instagram account for each niche.
Tokens are stored AES-256-GCM encrypted. Page tokens derived from a long-lived user token do not expire; if Meta revokes
one (password change, removed permission), publishing marks the account `expired`, blocks the run, and alerts you — reconnect it.

## 6. Public media URL (required for real posting)

Meta's servers download the media, so they need an **https** URL. ViralForge exposes only the signed media edge (port `3100`),
never the API or Supabase.

```bash
cloudflared tunnel --url http://localhost:3100
```

Put the printed `https://…trycloudflare.com` URL in `PUBLIC_MEDIA_BASE_URL`. Quick tunnels change URL on every start;
for a stable URL create a named Cloudflare tunnel (or `ngrok http 3100 --domain=<your-static-domain>`).
Links are HMAC-signed and expire after 2 hours.

Then flip the kill switch and restart workers:

```
PUBLISHING_DISABLED=false
```

## 7. WhatsApp alerts (optional; Telegram works without this)

1. Add the **WhatsApp** product to the app, register a sender number, note the **Phone number ID** → `WHATSAPP_PHONE_ID`.
2. Business settings → **System users** → create one, assign the app + WhatsApp account, generate a permanent token with
   `whatsapp_business_messaging` → `WHATSAPP_ACCESS_TOKEN`.
3. Free-form text only delivers inside the 24h customer-service window. For reliable alerts create a **Utility** template
   with one body variable, e.g. `ViralForge alert: {{1}}`, wait for approval, then set `WHATSAPP_ALERT_TEMPLATE=<name>`.
4. `WHATSAPP_ALERT_TO=91XXXXXXXXXX` (comma-separated, no `+`).

## Limits to keep in mind

- Instagram: 50 API-published posts per account per 24h (ViralForge plans 5). Captions ≤ 2,200 chars, ≤ 30 hashtags.
- Carousels: 2–10 items. Images must be JPEG. Reels: H.264/AAC, 3s–15min.
- Everything stays in Development mode unless you connect accounts owned by people without an app role — only then is App Review needed.
