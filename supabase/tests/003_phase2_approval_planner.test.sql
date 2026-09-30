BEGIN;

SELECT plan(13);

-- Synthetic fixtures only.
INSERT INTO organizations (id, name, email)
VALUES ('00000000-0000-0000-0000-00000000b001', 'Approval Org', 'pgtap-s3@example.test');

INSERT INTO content_items (id, organization_id, niche_id, sub_topic, status, publish_mode, approval_status, scheduled_at)
VALUES
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000b001', 'food', 'Approve me', 'draft',
   'manual_approval', 'pending', NOW() + INTERVAL '3 hours'),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000b001', 'tech', 'Reject me', 'draft',
   'manual_approval', 'pending', NOW() + INTERVAL '3 hours'),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-00000000b001', 'health', 'Auto approve me', 'draft',
   'manual_approval', 'pending', NOW() - INTERVAL '1 minute');

-- Drive each item to the approval gate: start at validation, then complete it.
CREATE TEMP TABLE runs AS
SELECT c.id AS content_id,
  start_content_pipeline(c.id, c.organization_id, 'pgtap', 'validation', '{}', NOW()) AS run_id
FROM content_items c WHERE c.organization_id = '00000000-0000-0000-0000-00000000b001';

SELECT claim_stage_attempt(a.id, 'w-' || a.id, 60) FROM stage_attempts a JOIN runs r ON r.run_id = a.pipeline_run_id;
SELECT complete_stage_attempt(a.id, 'w-' || a.id, '{}', NULL) FROM stage_attempts a JOIN runs r ON r.run_id = a.pipeline_run_id;

SELECT is(
  (SELECT count(*)::integer FROM pipeline_runs r JOIN runs t ON t.run_id = r.id
    WHERE r.status = 'waiting' AND r.waiting_reason = 'approval_required'),
  3, 'validated manual-approval items wait for approval'
);
SELECT is(
  (SELECT count(*)::integer FROM notification_outbox
    WHERE content_item_id = '00000000-0000-0000-0000-00000000d001' AND event_type = 'approval_requested'),
  2, 'approval request is sent to telegram and whatsapp'
);
SELECT is(
  (SELECT payload->>'runId' FROM notification_outbox
    WHERE content_item_id = '00000000-0000-0000-0000-00000000d001' AND channel = 'telegram'),
  (SELECT run_id::text FROM runs WHERE content_id = '00000000-0000-0000-0000-00000000d001'),
  'approval payload carries the run id for one-tap buttons'
);

SELECT throws_ok(
  $$SELECT resume_pipeline_run((SELECT run_id FROM runs WHERE content_id = '00000000-0000-0000-0000-00000000d001'), 'pgtap')$$,
  'P0001', 'Pipeline requires approval before publishing',
  'resume cannot bypass the approval gate'
);

-- Approve early: publishing is enqueued for the planned slot, not now.
SELECT approve_pipeline_run((SELECT run_id FROM runs WHERE content_id = '00000000-0000-0000-0000-00000000d001'), 'pgtap-operator');
SELECT is(
  (SELECT approval_status FROM content_items WHERE id = '00000000-0000-0000-0000-00000000d001'),
  'approved', 'approve marks the content approved'
);
SELECT ok(
  (SELECT q.available_at >= c.scheduled_at - INTERVAL '1 second'
     FROM queue_outbox q JOIN stage_attempts a ON a.id = q.stage_attempt_id
     JOIN content_items c ON c.id = a.content_item_id
    WHERE a.content_item_id = '00000000-0000-0000-0000-00000000d001' AND a.stage = 'publishing'),
  'early approval publishes at the scheduled slot'
);
SELECT is(
  (SELECT waiting_reason FROM pipeline_runs WHERE id = (SELECT run_id FROM runs WHERE content_id = '00000000-0000-0000-0000-00000000d001')),
  'scheduled_release', 'run waits for its release time'
);
SELECT throws_ok(
  $$SELECT approve_pipeline_run((SELECT run_id FROM runs WHERE content_id = '00000000-0000-0000-0000-00000000d001'), 'again')$$,
  'P0001', NULL, 'a second approval is rejected'
);

-- Reject cancels the run and its pending work.
SELECT reject_pipeline_run((SELECT run_id FROM runs WHERE content_id = '00000000-0000-0000-0000-00000000d002'), 'pgtap-operator', 'off brand');
SELECT is(
  (SELECT status FROM pipeline_runs WHERE id = (SELECT run_id FROM runs WHERE content_id = '00000000-0000-0000-0000-00000000d002')),
  'cancelled', 'reject cancels the run'
);
SELECT is(
  (SELECT status::text FROM content_items WHERE id = '00000000-0000-0000-0000-00000000d002'),
  'cancelled', 'reject cancels the content'
);

-- Auto-approve only when the niche allows it and the slot has arrived.
INSERT INTO niche_schedule_settings (organization_id, niche_id, auto_approve_at_slot)
VALUES ('00000000-0000-0000-0000-00000000b001', 'health', TRUE);
SELECT is(auto_approve_due_runs(NOW()), 1, 'due item in an auto-approve niche is approved');

-- Backlog: dated entry for the plan date wins, then priority.
INSERT INTO topic_backlog (organization_id, niche_id, title, priority, scheduled_for) VALUES
  ('00000000-0000-0000-0000-00000000b001', 'food', 'Undated high priority', 9, NULL),
  ('00000000-0000-0000-0000-00000000b001', 'food', 'Calendar entry for today', 0, CURRENT_DATE),
  ('00000000-0000-0000-0000-00000000b001', 'food', 'Calendar entry for tomorrow', 0, CURRENT_DATE + 1);
SELECT is(
  (SELECT array_agg(title ORDER BY scheduled_for IS NULL, priority DESC)
     FROM claim_backlog_topics('00000000-0000-0000-0000-00000000b001', 'food', CURRENT_DATE, 5)),
  ARRAY['Calendar entry for today', 'Undated high priority'],
  'backlog claims dated entries first and never claims future dates'
);

SELECT throws_ok(
  $$INSERT INTO niche_schedule_settings (organization_id, niche_id, slots_ist)
    VALUES ('00000000-0000-0000-0000-00000000b001', 'tech', ARRAY['25:00'])$$,
  '23514', NULL, 'invalid IST slot times are rejected'
);

SELECT * FROM finish();
ROLLBACK;
