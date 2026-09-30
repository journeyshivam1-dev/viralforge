# ViralForge — Handoff (continue on another machine)

**Date:** 2026-09-30
**Repo:** https://github.com/journeyshivam1-dev/viralforge.git
**Branch:** `main`
**Local path on previous machine:** `D:\contentAutomation`

This file is the source of truth for what exists, what Phase 1 shipped, what is still broken, and what to build next. Read it before writing code.

---

## Phase 3 status (2026-10-01) — read this first

Plan: `docs/PHASE3_PLAN.md`. Closes the loop: measure posts, move posting times toward what works, alert on ops problems.

| Slice | What | Where |
|---|---|---|
| S1 | `post_insights` at 1h/24h/72h/7d per publication (counts only, no viewer data); collector every 15 min, 25/tick, 3 retries; IG metric fallback when Meta rejects one; FB counts from object fields | migration `20261001000100_*`, `jobs/insights.ts`, `MetaGraphClient.getInstagramInsights/getFacebookInsights` |
| S2 | Slot tuning: `slot_tuning` off/suggest(default)/auto + `exploration_minutes` (default 30: one slot/day shifted ±30). Weekly Mon 03:00 IST, platform+media normalised, Bayesian-shrunk, ≥4 samples both sides, ≥10% lift, 90-min gap, max 2 moves. Stale recommendations are superseded, never applied | `packages/domain/src/insights.ts` (`recommendSlots`), `planner.ts` (`explorationShift`), `jobs/slot-tuning.ts` |
| S3 | Alerts: planner failure (once per niche/day), account health 08:00 IST (revoked → `expired`), daily digest 22:30 IST; Telegram Apply/Dismiss for slot recommendations | `jobs/operations.ts`, `jobs/notifications.ts`, `jobs/telegram-bot.ts` |
| S4 | API `/insights/summary`, `/slot-recommendations(/:id/apply|dismiss)`, `/slot-tuning/run`; dashboard **Insights** page; tuning fields on Automation | `services/api/src/routes/insights.ts`, `services/dashboard/src/pages/insights.tsx` |

**Checks:** unit 50/50 · pgTAP 53/53 · db lint (2 known warnings) · builds + dashboard typecheck. Smoke-tested locally with
synthetic insights (removed afterwards): tuning proposed 21:30 → 21:00, Apply via API changed the slots, a second Apply was refused.
Nothing here posts anything; insights only start once real publishing is on.

**Not done:** real Graph insight calls are unverified until accounts are connected and publishing is enabled — metric names
are the risky part (fallback set exists). The API still has no user auth (single local operator); multi-user needs the
central OAuth2/JWT server.

## Phase 2 status (2026-09-30) — read this first

Plan and operator decisions: `docs/PHASE2_PLAN.md`. Meta/WhatsApp/tunnel setup: `docs/META_SETUP.md`.
Target: 5 niches (cartoon, food, health, tech, edtech) × 5 posts/day (3 reels, 1 carousel, 1 image) → IG + FB, IST slots,
one-tap approval by default (fully automatic per niche), zero-touch otherwise.

**Shipped in code, verified locally:**

| Slice | What | Where |
|---|---|---|
| S1 | 4 attempts + exponential backoff; `retry_failed_pipelines` resumes only the failed stage; scheduler never restarts a run from research; Telegram + WhatsApp alerts on permanent failure / block via `notification_outbox` trigger | `supabase/migrations/20260930000100_*`, `jobs/scheduler.ts`, `jobs/notifications.ts` |
| S2 | `AiProviderChain`: Omniroute → Gemini → Replicate(images). Text, image, TTS, video (async poll for the timing-out Omniroute video endpoint). Real LLM research replaced the hardcoded placeholder "facts". Prompt data sanitized + fenced as `<data>` | `packages/domain/src/adapters/ai-providers.ts`, `jobs/research.ts`, `jobs/generation.ts` |
| S3 | Daily planner (00:30 IST cron + 30-min catch-up, plans tomorrow after 20:00 IST): IST slots with deterministic jitter, operator backlog/calendar first, then LLM ideation over Google Trends RSS + YouTube mostPopular, 60-day de-dup | `packages/domain/src/planner.ts`, `adapters/trends.ts`, `jobs/planner.ts`, migration `…000200_*` |
| S4 | Media per type: scene images (9:16 reels, 4:5 posts) + per-scene Hindi TTS, checkpointed per artifact. Rendering: Ken Burns + voiceover-fitted scene length + libass captions (`ass` filter, `shaping=complex` — the `subtitles` filter mis-places Devanagari matras); 1080×1350 slides | `jobs/media.ts`, `render/compose.ts`, `jobs/rendering.ts`, `jobs/validation.ts` |
| S5 | New Graph client (tokens in headers only): IG image/carousel/reel, FB photo/multi-photo/reel (old FB reel code never uploaded the file). Fan-out to every active account of the niche via `publication_attempts`; IG container saved before publish → no double posts; AES-256-GCM token encryption; HMAC-signed public media edge on its own port | `adapters/meta-graph.ts`, `jobs/publishing.ts`, `security/*`, `services/api/src/media-edge.ts` |
| S6 | `approve_pipeline_run` / `reject_pipeline_run` / `auto_approve_due_runs`; resume respects `scheduled_at` (early approval still posts at the slot); Telegram bot (long-polling by default) with preview + Approve/Reject buttons, `/today /pending /retryfailed /plan /topic` | migration `…000200_*`, `jobs/telegram-bot.ts` |
| S7 | Dashboard: **Today's plan**, **Automation** (niche settings + topic CSV import), Approve/Reject on content page, Retry-all on queue monitor | `services/dashboard/src/pages/today.tsx`, `automation.tsx` |

**Security fixes made along the way:** Telegram webhook verified a signature Telegram never sends and failed open with an
empty allowlist; `setWebhook` used the bot token as `secret_token`; WhatsApp webhook HMAC used the verify token over
re-serialized JSON, only in production, and failed open; Meta tokens were stored in plaintext and sent in query strings.

**Checks (this machine):** `npm test -- --runInBand` 37/37 · `npm run test:db` 38/38 · `npx supabase db lint --local --fail-on error` pass (2 known warnings) · build all workspaces.
Use `npm run test:db` instead of `supabase test db` on low-memory Docker hosts — pulling the `pg_prove` image hung Docker Desktop here.
Supabase `[analytics]` is disabled in `config.toml` for the same reason (vector crash-looped).

**Not yet verified end to end (needs operator keys in `.env`):** `OMNIROUTE_API_KEY` (+ `OMNIROUTE_IMAGE_MODEL` / `OMNIROUTE_TTS_MODEL` once
their model ids are known from `/v1/models`), `GEMINI_API_KEY`, `YOUTUBE_API_KEY`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` +
`TELEGRAM_ALERT_CHAT_IDS`. Without them the planner fails cleanly with "No provider is configured for text" and retries every 30 min.

**Next:** live run with keys → tune prompts per niche → tunnel + `PUBLISHING_DISABLED=false` for one niche → insights-driven slot tuning.

---

## What this project is

ViralForge is a **Hindi / Hinglish Instagram + Facebook content automation platform**.

Goal: operator picks a niche (currently food / regional Indian cooking), the system researches, writes a reel package, generates per-scene images, renders a 1080×1920 vertical video, validates, then (optionally, never in local) publishes to Meta.

It is **not** a chatbot. It is a **durable pipeline**. PostgreSQL is the source of truth. BullMQ/Redis only transports commands. If Redis dies, the database still knows which stage each piece of content is on.

Target output: 15–45s vertical reels with scene images, on-screen text, captions, hashtags, hook variants. Local default: `PUBLISHING_DISABLED=true` because Meta cannot fetch local signed URLs.

---

## Architecture (what is actually running)

```
Dashboard (Next.js pages, :3001)
    → Express API (:3000)
        → PostgreSQL RPCs (Supabase local CLI, :54322 / API :54321)
        → queue_outbox rows
            → outbox-dispatcher worker → BullMQ (Redis :6379)
                → stage workers: research → generation → media → rendering → validation → publishing
```

Monorepo workspaces:

| Workspace | Role |
|---|---|
| `packages/domain` | Schemas, pipeline types, Omniroute adapter, Replicate adapter, Meta publisher |
| `packages/supabase` | Shared admin client (`requireSupabaseAdmin()`) |
| `services/api` | Express. Content, niches, accounts, pipeline, webhooks, `/api/dev/bootstrap` |
| `services/workers` | BullMQ workers + `withPipelineRuntime` claim/complete/fail/block |
| `services/dashboard` | Next.js pages router dashboard |

Infra:

- **Supabase CLI** owns Postgres, Auth, Storage, Studio. Project id: `viralforge-local`.
- **Docker Compose** owns Redis + optional `app` profile (api / worker / dashboard images).
- Omniroute (`http://localhost:20128`) is the local LLM gateway for research + generation.
- Replicate is the image (and optional video) generator for the media stage.

Pipeline stages, in order (`packages/domain/src/schemas/pipeline.ts`):

```
research → generation → media → rendering → validation → publishing
```

Stage attempt statuses: `pending | queued | processing | completed | retryable_failed | permanent_failed | blocked | cancelled`

Run statuses: `pending | running | waiting | blocked | completed | failed | cancelled`

`waiting` is for approval / schedule gates. `blocked` is for operator intervention (missing Replicate token, policy, validation failure).

---

## How to run on a new machine

Prereqs: Node 22+, npm 10+, Docker Desktop (Linux containers), Git.

```bash
git clone https://github.com/journeyshivam1-dev/viralforge.git
cd viralforge
npm install
npm run supabase:start
npm run supabase:status          # copy anon + service_role keys
cp .env.example .env             # fill keys; never commit .env
npm run supabase:reset           # applies supabase/migrations + seed
docker compose up -d redis
npm run dev                      # API :3000, dashboard :3001, workers
```

Then `POST /api/dev/bootstrap` to seed org / niches / sample content.

Checks that must stay green:

```bash
npm test -- --runInBand          # 13 unit tests
npm run supabase:test            # 11 pgTAP tests
npx supabase db lint --local --fail-on error
npm run build                    # all 5 workspaces
```

Docker app profile (after Supabase is up and `.env` has keys):

```bash
docker compose --profile app up -d --build
```

Local URLs:

- Dashboard http://localhost:3001
- API http://localhost:3000 (`/api/health`)
- Supabase API http://127.0.0.1:54321
- Studio http://127.0.0.1:54323
- Redis 6379
- Omniroute http://localhost:20128

Required `.env` for a full media run (keep real tokens out of git):

```
REPLICATE_API_TOKEN=...
REPLICATE_IMAGE_MODEL_VERSION=...   # required for media stage
REPLICATE_VIDEO_MODEL_VERSION=...   # optional
PUBLISHING_DISABLED=true            # required locally
```

Without Replicate, media stage **blocks** the run (`MediaProviderError` classification `blocked`). That is intentional, not a crash. Dashboard should show **Resume after configuration**, not **Start research**.

---

## What is done (Phase 1)

Phase 1 = durable pipeline state machine + Replicate media + scene rendering + media-aware validation + dashboard that reflects real state.

### Database (`supabase/migrations/`)

Canonical migrations live here, **not** in `packages/supabase/migrations/` (that old `001_initial_schema.sql` was deleted).

1. `20260920000100_initial_schema.sql` — core tables
2. `20260920000200_reliable_pipeline_foundation.sql` — `pipeline_runs`, `stage_attempts`, `queue_outbox`, `enqueue_pipeline_attempt`, `claim_stage_attempt`, `start_content_pipeline`
3. `20260920000300_local_security_and_storage.sql` — RLS + private `viralforge-content` bucket
4. `20260924000100_phase1_slice1_pipeline_state_machine_hardening.sql` — **Phase 1 hardening**

Hardening migration added:

- `pipeline_runs.status` includes `blocked`; `waiting_reason` (`approval_required | schedule_required | scheduled_release | retry_backoff | operator_intervention`)
- `stage_attempts.status` includes `blocked`; `failure_class`
- `block_stage_attempt(p_attempt_id, p_worker_id, p_error, p_reason)` — marks attempt + run + content `blocked`
- `fail_stage_attempt` — **run stays `running` on retryable failure** (this was the frozen-pipeline root cause)
- `complete_stage_attempt` — approval gate (`manual_approval` → `waiting`) and schedule gate
- `resume_pipeline_run` — **refuses to enqueue publishing if approval_status ≠ approved**
- `reconcile_pipeline_work` — expired leases → `retryable_failed`; rearms `failed`/`cancelled` outbox rows so retries are not stranded behind a dispatched-but-stale outbox row

### Workers

- `services/workers/src/pipeline/runtime.ts` — `withPipelineRuntime` wraps every stage. Claims lease, then complete / block / fail.
- `services/workers/src/jobs/media.ts` — Replicate per-scene images, incremental checkpoint into `ai_generation_metadata.sceneArtifacts`, builds `MediaManifest`.
- `services/workers/src/jobs/rendering.ts` — downloads scene images, assembles 1080×1920 vertical video + subtitles.
- `services/workers/src/jobs/validation.ts` — media-type-aware (image vs video), returns `{ success: true, blocked: errors.length > 0 }`. Runtime sees `blocked: true` and calls `block_stage_attempt` (does **not** advance to publishing).
- `services/workers/src/jobs/outbox-dispatcher.ts` — claims `queue_outbox`, pushes BullMQ jobs.
- Research / generation still go through Omniroute.

### API

- `services/api/src/pipeline/orchestrator.ts` — `startPipeline`, `resumePipeline`, `retryPipelineFromStage`, **`approveContent`**, **`rejectContent`**
- `services/api/src/routes/pipeline.ts`
  - `GET /api/content/:id/pipeline`
  - `GET /api/pipeline-runs/:id`
  - `POST /api/pipeline-runs/:id/resume`
  - `POST /api/pipeline-runs/:id/retry`
  - `POST /api/pipeline-runs/:id/approve`
  - `POST /api/pipeline-runs/:id/reject`

### Dashboard

- `services/dashboard/src/pages/content/[id].tsx` polls every 3s while run is `pending|running|waiting|blocked`.
- Context-aware buttons:
  - no pipeline + draft → **Start pipeline**
  - `pipeline.status === failed` → **Retry from {stage}**
  - `pipeline.status === blocked` → **Resume after configuration**
- Stage timeline from `pipeline.stage_attempts`.
- This replaced the old bug where every failed item showed **Start research**, which looked like a reset and hid generated scripts/scenes.

### Domain

- `packages/domain/src/schemas/pipeline.ts` — stages, statuses, job ids (no colons — BullMQ forbids them)
- `packages/domain/src/schemas/media.ts` — `SceneArtifact`, `MediaManifest`
- `packages/domain/src/schemas/generated-content.ts` — `GeneratedContentPackage` (scenes, hooks, captions)
- `packages/domain/src/adapters/media-adapter.ts` — `MediaProviderError` with `classification: blocked | retryable | permanent` and `providerCode`
- `packages/domain/src/adapters/replicate-adapter.ts` — Replicate predictions, poll, download

### Tests that were green on the previous machine

- `npm test -- --runInBand` → 13/13
- `npm run supabase:test` → 11/11 pgTAP
- `npx supabase db lint --local --fail-on error` → pass (2 unused-param warnings: `p_dispatcher_id`, `p_reason`)
- `npm run build` → all workspaces

---

## Bugs found late in Phase 1, and what was fixed

Root complaint: **"pipeline frozen / Start research after failure, generated script gone."**

Real causes (not a deleted script):

1. Dashboard hardcoded **Start research** for every failed/blocked item.
2. `fail_stage_attempt` used to mark the **run** failed on retryable errors, so resume looked like a new pipeline.
3. `resume_pipeline_run` could enqueue publishing while `approval_status` was not approved.
4. Reconciliation ignored `retryable_failed` if a `dispatched` outbox row still existed → stage never re-queued.
5. Omniroute adapter advertised `image/video = false`, so media never generated real assets.

Late runtime bugs (fixed in `services/workers/src/pipeline/runtime.ts`, commit `239f118` plus the commit that includes this file):

6. **Pending/queued attempts were silently skipped.** `claim_stage_attempt` returning anything other than `processing` used to `return { success: true, skipped: true }`. The job succeeded, the stage never ran, the pipeline looked frozen. Now it **throws**.
7. **Blocked-error code was hardcoded** to `MEDIA_PROVIDER_NOT_CONFIGURED`. `MediaProviderError` stores the code in `providerCode`, not `code`. Runtime now uses `providerCode` and falls back to `MEDIA_PROVIDER_BLOCKED`.

False alarm (do not "fix" this):

- Validation returns `{ success: true, blocked: true }` on expected content failures. Runtime **already** checks `result.blocked === true` *before* `complete_stage_attempt` and calls `block_stage_attempt`. That path is correct.

---

## What is NOT done (Phase 2 and leftover)

Phase 2 was never started. There is no Phase 2 plan file in the repo. Treat the list below as the backlog unless the operator says otherwise.

### Must do before calling the pipeline "working end-to-end"

1. **Live E2E with Replicate.** Set `REPLICATE_API_TOKEN` + `REPLICATE_IMAGE_MODEL_VERSION` in `.env`, `POST /api/dev/bootstrap`, start a food reel, watch:
   - research writes `script_body` / research payload
   - generation writes `GeneratedContentPackage` with scenes
   - media writes scene JPEGs into `viralforge-content` and a `MediaManifest`
   - rendering writes an mp4
   - validation passes or blocks with a real reason
   - publishing **must not** fire locally (`PUBLISHING_DISABLED=true`)
2. **Rebuild worker container** after the runtime.ts fix. Previous Docker images were 2 days old relative to the last source change. `docker compose --profile app up -d --build` or just `npm run dev`.
3. Confirm Omniroute is actually running on `:20128`. Research/generation fail without it.
4. Confirm Redis is up. API logs `ECONNREFUSED :6379` if it is not.

### Likely Phase 2 (product, not just hardening)

These are the natural next slices. Confirm with the operator before building a large one.

- **TTS / voiceover** so rendered reels are not silent. `ALLOW_SILENT_VIDEO=true` currently papers over this.
- **Real Meta publishing path** against reachable storage (not local signed URLs). Keep the local kill switch.
- **Scheduler** actually releasing `publish_mode = scheduled` items (`waiting_reason = scheduled_release`).
- **Approve / Reject UI** on the content detail page (API exists, dashboard buttons for approve/reject were not wired as first-class actions last time).
- **Idempotent media retries** that resume from the last checkpointed scene instead of regenerating everything.
- **Cost / token / Replicate usage accounting** per content item.
- **Multi-niche** beyond food (schema supports it; prompts and validation rules are food-heavy).
- **Operator audit trail** that is readable in `/audit` for every stage transition.
- **pgTAP coverage** for `block_stage_attempt`, approval-gate resume refusal, and outbox rearming. Foundation tests exist; hardening functions are under-tested.
- **Remove leftover `packages/supabase/migrations/001_initial_schema.sql`** (already deleted in the working tree). Do not resurrect it.

### Known sharp edges to re-check, not assumed fixed

- `claim_stage_attempt` on a `pending` attempt: dispatcher is supposed to move pending → queued → processing. If a job lands on pending, the worker now throws (good) — confirm reconciliation re-queues it.
- `complete_stage_attempt` only applies the approval waiting-gate when `publish_mode = 'manual_approval'`. For `immediate_auto`, a validation **block** is handled in the worker runtime, not in SQL. Keep both paths.
- Publishing worker rejects anything whose `content_items.status` is not `scheduled` or `validated`. That is correct. Do not loosen it.
- Dashboard still has leftover per-stage buttons (`Generate with Omniroute`, `Generate media`, `Render final video`) for items **without** a pipeline run. Fine for recovery; the happy path is **Start pipeline**.
- BullMQ `attempts` for publishing is 1. DB is authoritative for retries. Do not raise BullMQ attempts and double-fire publish.
- `.env` is gitignored. A new machine has no tokens until the operator pastes them.

---

## Key files (do not hunt)

| Path | Why |
|---|---|
| `supabase/migrations/20260924000100_phase1_slice1_pipeline_state_machine_hardening.sql` | Block/wait/retry/resume/reconcile |
| `supabase/migrations/20260920000200_reliable_pipeline_foundation.sql` | enqueue/claim/start |
| `services/workers/src/pipeline/runtime.ts` | Durable wrapper around every stage |
| `services/workers/src/jobs/media.ts` | Replicate scene generation |
| `services/workers/src/jobs/rendering.ts` | ffmpeg vertical assemble |
| `services/workers/src/jobs/validation.ts` | Contract + policy validation |
| `services/workers/src/jobs/outbox-dispatcher.ts` | DB → Redis |
| `services/api/src/pipeline/orchestrator.ts` | start/resume/retry/approve/reject |
| `services/api/src/routes/pipeline.ts` | HTTP for the above |
| `services/api/src/routes/dev.ts` | `POST /api/dev/bootstrap` |
| `services/dashboard/src/pages/content/[id].tsx` | Live pipeline UI |
| `packages/domain/src/schemas/pipeline.ts` | Stage contract |
| `packages/domain/src/adapters/replicate-adapter.ts` | Replicate client |
| `docs/SETUP.md` | Operator setup |
| `.env.example` | Required env names |

---

## Rules for the next session

- PostgreSQL is source of truth. Do not add "just enqueue a BullMQ job" shortcuts that skip `enqueue_pipeline_attempt`.
- All server-side Supabase access goes through `requireSupabaseAdmin()`.
- Keep `PUBLISHING_DISABLED=true` locally.
- Do not write exploits, do not weaken auth, do not commit `.env`.
- Match existing comment density and naming.
- New SQL goes in `supabase/migrations/` with a timestamped filename. Reset local DB with `npm run supabase:reset` after.
- If a stage cannot proceed because of missing config, **block** it. Do not fail the run. The operator resumes.
- If you think the dashboard "reset", look at `pipeline_runs` + `stage_attempts` first. The script is almost certainly still on the content row.

---

## Git notes from the machine this was written on

Working tree before this commit had ~175 dirty paths: Phase 1 source, supabase CLI project, tests, Dockerfiles, dashboard, plus a pile of **unrelated SSC exam-paper analysis** under `.claude/pdf-work/` and `EXPECTED_PAPER_1_ANALYSIS.md`. Those exam files are **not** part of ViralForge and were not committed.

`services/dashboard/.next-dev/` had been tracked earlier (build cache). It is now gitignored and removed from the index.

Remote: `origin` → `https://github.com/journeyshivam1-dev/viralforge.git`
Previous HEAD before this handoff commit: `239f118` (`fix: pipeline runtime throw on non-processing attempts, use providerCode`) which was already 1 commit ahead of `origin/main`.
