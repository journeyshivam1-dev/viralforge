BEGIN;

SELECT plan(14);

-- Synthetic fixtures only.
INSERT INTO organizations (id, name, email)
VALUES ('00000000-0000-0000-0000-00000000a001', 'Test Org', 'pgtap-s1@example.test');

INSERT INTO content_items (id, organization_id, niche_id, sub_topic, status)
VALUES
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', 'food', 'Failing item', 'draft'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000a001', 'tech', 'Due item', 'draft'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000a001', 'health', 'Future item', 'draft');

UPDATE content_items SET scheduled_at = NOW() + INTERVAL '60 minutes', generation_lead_minutes = 120
  WHERE id = '00000000-0000-0000-0000-00000000c002';
UPDATE content_items SET scheduled_at = NOW() + INTERVAL '10 hours', generation_lead_minutes = 120
  WHERE id = '00000000-0000-0000-0000-00000000c003';

SELECT is(pipeline_max_attempts('media'), 4, 'generative stages get four attempts');
SELECT is(pipeline_max_attempts('publishing'), 1, 'publishing keeps a single attempt');

-- Run a pipeline, advance research, then fail generation permanently.
SELECT start_content_pipeline(
  '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', 'pgtap', 'research', '{}', NOW()
);
SELECT claim_stage_attempt(
  (SELECT id FROM stage_attempts WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND stage = 'research'),
  'w1', 60
);
SELECT complete_stage_attempt(
  (SELECT id FROM stage_attempts WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND stage = 'research'),
  'w1', '{}', NULL
);
SELECT claim_stage_attempt(
  (SELECT id FROM stage_attempts WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND stage = 'generation'),
  'w2', 60
);
SELECT fail_stage_attempt(
  (SELECT id FROM stage_attempts WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND stage = 'generation'),
  'w2', '{"message": "provider down", "code": "PROVIDER_DOWN"}', FALSE
);

SELECT is(
  (SELECT status FROM pipeline_runs WHERE content_item_id = '00000000-0000-0000-0000-00000000c001'),
  'failed', 'permanent failure fails the run'
);
SELECT is(
  (SELECT count(*)::integer FROM notification_outbox
    WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND event_type = 'stage_permanent_failed'),
  2, 'permanent failure queues one telegram and one whatsapp alert'
);
SELECT is(
  (SELECT payload->>'errorCode' FROM notification_outbox
    WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND channel = 'telegram'),
  'PROVIDER_DOWN', 'alert payload carries the error code'
);

-- Bulk retry resumes the failed stage only.
SELECT is(
  (retry_failed_pipelines('00000000-0000-0000-0000-00000000a001', 'pgtap', 10)->>'retriedCount')::integer,
  1, 'retry_failed_pipelines resumes the failed run'
);
SELECT is(
  (SELECT count(*)::integer FROM stage_attempts
    WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND stage = 'research'),
  1, 'completed research is not re-run'
);
SELECT is(
  (SELECT status FROM stage_attempts
    WHERE content_item_id = '00000000-0000-0000-0000-00000000c001' AND stage = 'generation' AND attempt_no = 2),
  'pending', 'a new generation attempt is enqueued'
);
SELECT is(
  (SELECT count(*)::integer FROM pipeline_runs WHERE content_item_id = '00000000-0000-0000-0000-00000000c001'),
  1, 'retry reuses the existing run'
);
SELECT is(
  (SELECT count(*)::integer FROM notification_outbox
    WHERE content_item_id = '00000000-0000-0000-0000-00000000c001'),
  2, 'retry bookkeeping does not raise new alerts'
);

-- Scheduler only starts drafts whose generation window opened.
SELECT is(
  (start_due_scheduled_content(NOW(), INTERVAL '15 minutes', 50)->>'started')::integer,
  1, 'scheduler starts exactly the due draft'
);
SELECT is(
  (SELECT count(*)::integer FROM pipeline_runs WHERE content_item_id = '00000000-0000-0000-0000-00000000c003'),
  0, 'future draft is not started early'
);
SELECT is(
  (start_due_scheduled_content(NOW(), INTERVAL '15 minutes', 50)->>'started')::integer,
  0, 'scheduler never restarts content that already has a run'
);

SELECT function_privs_are(
  'public', 'retry_failed_pipelines', ARRAY['uuid', 'text', 'integer'],
  'service_role', ARRAY['EXECUTE'], 'service_role can bulk retry'
);

SELECT * FROM finish();
ROLLBACK;
