# ViralForge Setup Guide

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Docker Desktop, running with Linux containers
- Git

## 1. Install dependencies

```bash
npm install
```

The repository pins the Supabase CLI, so use the npm scripts instead of installing a global CLI.

## 2. Start local Supabase

```bash
npm run supabase:start
```

Local endpoints:

- Data API and Storage: http://127.0.0.1:54321
- PostgreSQL: 127.0.0.1:54322
- Studio: http://127.0.0.1:54323
- Local email viewer: http://127.0.0.1:54324

## 3. Configure environment variables

Copy `.env.example` to `.env`. Get the current local credentials with:

```bash
npm run supabase:status
```

Set `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to the reported local values. Do not commit `.env`.

For Replicate-backed media generation, set `REPLICATE_API_TOKEN` and `REPLICATE_IMAGE_MODEL_VERSION`. `REPLICATE_VIDEO_MODEL_VERSION` is optional and enables video generation. `REPLICATE_TIMEOUT_MS` bounds prediction creation and polling together. Store real tokens only in `.env` or your deployment secret manager; never commit them.

Keep `PUBLISHING_DISABLED=true` in local development. Meta cannot fetch media from local signed URLs.

### Phase 2 keys (daily automation)

| Variable | Needed for |
|---|---|
| `OMNIROUTE_API_KEY` | Primary text/image/TTS provider (`OMNIROUTE_BASE_URL=http://192.168.31.13:20128`). Set `OMNIROUTE_IMAGE_MODEL` / `OMNIROUTE_TTS_MODEL` to ids from `GET /v1/models`; leave empty to use Gemini for that capability. |
| `GEMINI_API_KEY` | Fallback for every capability (Google AI Studio key). |
| `YOUTUBE_API_KEY` | YouTube trending topics (optional; Google Trends RSS needs no key). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALERT_CHAT_IDS` | One-tap approvals, bot commands, failure alerts. Get your numeric id from @userinfobot. Empty allowlist = nobody can act. |
| `WHATSAPP_*` | Optional alert channel, see `docs/META_SETUP.md`. |
| `TOKEN_ENCRYPTION_KEY`, `MEDIA_URL_SIGNING_SECRET` | Generate once (commands in `.env.example`); keep stable. |

After adding keys restart `npm run dev`. The planner runs at 00:30 IST and every 30 minutes (idempotent);
trigger it now from **Today's plan → Run planner now** or Telegram `/plan`.

## 4. Apply migrations

```bash
npm run supabase:reset
```

This recreates the local database from `supabase/migrations`, provisions the private `viralforge-content` bucket, and runs `supabase/seed.sql`.

## 5. Start Redis

```bash
docker compose up -d redis
```

PostgreSQL and Storage are intentionally not in `docker-compose.yml`; the Supabase CLI owns those services.

## 6. Start the application

```bash
npm run dev
```

Services:

- Dashboard: http://localhost:3001
- API: http://localhost:3000
- Omniroute: http://localhost:20128

To create the local organization, niche profiles, and sample content, call `POST /api/dev/bootstrap` after the API starts.

## Run in application containers

Start Supabase first, copy its keys into `.env`, then run:

```bash
docker compose --profile app up -d --build
```

Application containers reach the CLI stack through `host.docker.internal:54321`.

## Verification

```bash
npm test -- --runInBand
```

```bash
npm run build
```

```bash
npm run test:db
```

(`npm run supabase:test` also works where Docker can pull the `pg_prove` image.)

```bash
npx supabase db lint --local --fail-on error
```

## Shutdown

```bash
docker compose down
```

```bash
npm run supabase:stop
```

## Hosted deployment

Hosted Supabase uses the same migrations, but production secrets, public media delivery, authentication, tenant policies, and encrypted Meta credentials must be configured before enabling publishing.
