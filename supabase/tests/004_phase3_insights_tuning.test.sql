BEGIN;

SELECT plan(15);

-- Synthetic fixtures only.
INSERT INTO organizations (id, name, email)
VALUES ('00000000-0000-0000-0000-00000000e001', 'Insights Org', 'pgtap-p3@example.test');

INSERT INTO content_items (id, organization_id, niche_id, sub_topic, media_type, status)
VALUES ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000e001', 'food', 'Measured post', 'video_reel', 'published');

CREATE TEMP TABLE p3_run AS
SELECT start_content_pipeline('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000e001', 'pgtap', 'publishing', '{}', NOW()) AS run_id;

-- Published 25 hours ago: 1h and 24h checkpoints are due, 72h and 7d are not.
INSERT INTO publication_attempts (id, pipeline_run_id, stage_attempt_id, organization_id, content_item_id, platform, status, remote_post_id, completed_at)
SELECT '00000000-0000-0000-0000-00000000e201', r.run_id, a.id, '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-00000000e101', 'instagram', 'published', 'ig-media-1', NOW() - INTERVAL '25 hours'
FROM p3_run r JOIN stage_attempts a ON a.pipeline_run_id = r.run_id;

SELECT is(
  (SELECT array_agg(checkpoint ORDER BY checkpoint) FROM due_insight_checkpoints(NOW(), 25)
    WHERE publication_attempt_id = '00000000-0000-0000-0000-00000000e201'),
  ARRAY['1h', '24h'], 'only checkpoints that have passed are due'
);

INSERT INTO post_insights (organization_id, publication_attempt_id, content_item_id, niche_id, platform, media_type, checkpoint, posted_at, posted_minute_ist, reach, likes)
VALUES ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e101',
  'food', 'instagram', 'video_reel', '24h', NOW() - INTERVAL '25 hours', 1170, 500, 40);
INSERT INTO post_insights (organization_id, publication_attempt_id, content_item_id, niche_id, platform, media_type, checkpoint, posted_at, posted_minute_ist, status, attempts, error, updated_at)
VALUES ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e101',
  'food', 'instagram', 'video_reel', '1h', NOW() - INTERVAL '25 hours', 1170, 'failed', 1, 'timeout', NOW());

SELECT is(
  (SELECT count(*)::integer FROM due_insight_checkpoints(NOW(), 25) WHERE publication_attempt_id = '00000000-0000-0000-0000-00000000e201'),
  0, 'collected and recently failed checkpoints are not due'
);
SELECT is(
  (SELECT checkpoint FROM due_insight_checkpoints(NOW() + INTERVAL '31 minutes', 25) WHERE publication_attempt_id = '00000000-0000-0000-0000-00000000e201'),
  '1h', 'a failed checkpoint is retried after 30 minutes'
);
UPDATE post_insights SET attempts = 3 WHERE checkpoint = '1h' AND publication_attempt_id = '00000000-0000-0000-0000-00000000e201';
SELECT is(
  (SELECT count(*)::integer FROM due_insight_checkpoints(NOW() + INTERVAL '31 minutes', 25) WHERE checkpoint = '1h' AND publication_attempt_id = '00000000-0000-0000-0000-00000000e201'),
  0, 'a checkpoint gives up after 3 attempts'
);
SELECT throws_ok(
  $$INSERT INTO post_insights (organization_id, publication_attempt_id, content_item_id, niche_id, platform, media_type, checkpoint, posted_at, posted_minute_ist)
    VALUES ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000e101',
      'food', 'instagram', 'video_reel', '24h', NOW(), 1170)$$,
  '23505', NULL, 'one row per publication and checkpoint'
);

-- Slot recommendations
INSERT INTO niche_schedule_settings (organization_id, niche_id) VALUES ('00000000-0000-0000-0000-00000000e001', 'food');
SELECT is(
  (SELECT slot_tuning || ':' || exploration_minutes FROM niche_schedule_settings WHERE organization_id = '00000000-0000-0000-0000-00000000e001'),
  'suggest:30', 'tuning defaults to suggest with 30 minutes exploration'
);

CREATE TEMP TABLE p3_rec AS
SELECT create_slot_recommendation('00000000-0000-0000-0000-00000000e001', 'food', 28,
  ARRAY['07:30', '12:30', '17:30', '19:30', '21:30'], ARRAY['07:30', '12:30', '17:30', '19:30', '21:00'],
  '[{"from":"21:30","to":"21:00"}]', '{}') AS id;
SELECT create_slot_recommendation('00000000-0000-0000-0000-00000000e001', 'food', 28,
  ARRAY['07:30', '12:30', '17:30', '19:30', '21:30'], ARRAY['07:30', '12:30', '18:00', '19:30', '21:30'], '[]', '{}');
SELECT is(
  (SELECT status FROM slot_recommendations WHERE id = (SELECT id FROM p3_rec)),
  'superseded', 'a newer recommendation supersedes the open one'
);
SELECT is(
  (SELECT count(*)::integer FROM slot_recommendations WHERE organization_id = '00000000-0000-0000-0000-00000000e001' AND status = 'pending'),
  1, 'only one pending recommendation per niche'
);
SELECT throws_ok(
  $$SELECT apply_slot_recommendation((SELECT id FROM p3_rec), 'pgtap')$$,
  'P0001', 'Slot recommendation is superseded', 'superseded recommendations cannot be applied'
);

SELECT apply_slot_recommendation(
  (SELECT id FROM slot_recommendations WHERE organization_id = '00000000-0000-0000-0000-00000000e001' AND status = 'pending'), 'pgtap-operator');
SELECT is(
  (SELECT slots_ist FROM niche_schedule_settings WHERE organization_id = '00000000-0000-0000-0000-00000000e001'),
  ARRAY['07:30', '12:30', '18:00', '19:30', '21:30'], 'apply updates the niche slots'
);
SELECT is(
  (SELECT count(*)::integer FROM audit_logs WHERE organization_id = '00000000-0000-0000-0000-00000000e001' AND action = 'slots.tuned'),
  1, 'applying is audited'
);

-- A recommendation computed from old slots is stale once slots change.
SELECT create_slot_recommendation('00000000-0000-0000-0000-00000000e001', 'food', 28,
  ARRAY['07:30', '12:30', '17:30', '19:30', '21:30'], ARRAY['07:00', '12:30', '17:30', '19:30', '21:30'], '[]', '{}');
CREATE TEMP TABLE p3_stale AS
SELECT id FROM slot_recommendations WHERE organization_id = '00000000-0000-0000-0000-00000000e001' AND status = 'pending';
SELECT is(
  (SELECT (apply_slot_recommendation((SELECT id FROM p3_stale), 'pgtap'))->>'applied'),
  'false', 'stale recommendations are refused'
);
SELECT is(
  (SELECT status || ':' || (SELECT slots_ist[1] FROM niche_schedule_settings WHERE organization_id = '00000000-0000-0000-0000-00000000e001')
     FROM slot_recommendations WHERE id = (SELECT id FROM p3_stale)),
  'superseded:07:30', 'a stale recommendation is superseded and slots are untouched'
);
SELECT throws_ok(
  $$SELECT create_slot_recommendation('00000000-0000-0000-0000-00000000e001', 'food', 28, ARRAY['07:30'], ARRAY['25:00'], '[]', '{}')$$,
  '23514', NULL, 'invalid recommended slots are rejected'
);

SELECT ok(
  enqueue_notification('00000000-0000-0000-0000-00000000e001', NULL, NULL, NULL, 'daily_digest', '2026-10-01', '{"lines":["x"]}') = 2,
  'operations notifications are accepted without a content item'
);

SELECT * FROM finish();
ROLLBACK;
