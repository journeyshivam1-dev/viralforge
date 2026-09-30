# ViralForge — Phase 3 Plan: learn from results, run unattended

Phase 2 made the daily loop run by itself. Phase 3 closes the loop: measure how each post does, move posting
times toward what works, and tell the operator only what needs them.

Source of this scope: "Not in Phase 2" (analytics-driven slot optimisation) and the Phase 2 leftovers in `HANDOFF.md`
(planner-failure alerts, token expiry alerts). Music licensing and multi-org auth stay out (see bottom).

## Rules (unchanged)
Postgres is the source of truth; Redis only wakes workers. Publishing kill switch stays authoritative. Tokens only in
headers. No personal data in insights or logs: we store per-post counts only, never commenter or viewer data.

## S1 — Post insights
- `post_insights`: one row per (publication, checkpoint) for checkpoints **1h, 24h, 72h, 7d** after the post went live.
  Stores reach, views, likes, comments, shares, saves, interactions and the IST minute the post went live.
- `due_insight_checkpoints()` finds work; the collector runs every 15 min, 25 rows per tick (well under Graph rate limits).
- Instagram: `/{media-id}/insights` (`reach,views,likes,comments,shares,saved,total_interactions`), falling back to a
  smaller metric set if Meta rejects one. Facebook: object fields for reactions/comments/shares, reach best-effort.
- Failures retry 3 times, 30 min apart; a revoked token marks the account `expired` (same as publishing).
- Does nothing while nothing is published, so it is safe with `PUBLISHING_DISABLED=true`.

## S2 — Slot tuning (the system picks the best IST times)
- Per niche setting `slot_tuning`: `off` | `suggest` (default) | `auto`, and `exploration_minutes` (default 30).
- Exploration: each day one slot per niche (chosen deterministically) is shifted ±`exploration_minutes`, so the system
  collects evidence just before and after every slot without big schedule jumps.
- Weekly (Mon 03:00 IST) per niche: score each post = weighted interactions ÷ reach at 24h (72h fallback), normalised
  against the median for the same platform + media type. For every slot compare "on-slot" posts with the earlier/later
  exploration posts, shrunk toward the average (Bayesian, k=5). Move a slot 30 min toward a neighbour only with
  ≥4 samples on both sides and ≥10% lift; keep ≥90 min between slots, 06:00–23:30 IST, max 2 moves per week.
- `suggest`: store a `slot_recommendations` row, alert on Telegram with **Apply / Dismiss** buttons, show it on the
  Insights page. `auto`: apply it and send an FYI. Changes affect the next planned day only.

## S3 — Operations alerts
- Planner failure alert (once per niche per day) — previously silent.
- Daily account health check (08:00 IST): cheap Graph read with each stored token; revoked → `expired` + alert;
  token expiring within 7 days → alert.
- Daily digest (22:30 IST) on Telegram/WhatsApp: per niche planned / published / awaiting approval / failed today,
  plus yesterday's best post.

## S4 — Dashboard + API
- `GET /api/insights/summary`, `GET /api/slot-recommendations`, `POST /api/slot-recommendations/:id/apply|dismiss`,
  `POST /api/slot-tuning/run`. Automation page gets the tuning mode and exploration fields.
- New **Insights** page: per niche posts, median reach, engagement rate, best slot, top posts, pending recommendations.

## Not in Phase 3
- Music licensing catalogue (legal review needed first).
- Multi-org / multi-user auth — must use the central OAuth2/JWT auth server; needs its own design.
- Caption/hook A/B tests driven by insights (next candidate once there is a month of data).
