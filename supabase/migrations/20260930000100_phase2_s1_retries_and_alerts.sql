-- Phase 2 Slice 1: retry budget, resume-only bulk retry, scheduler start RPC,
-- and a durable notification outbox for permanent-failure / blocked alerts.

BEGIN;

-- 1. Four attempts for every generative stage. Publishing stays at one BullMQ
-- attempt; remote publication is reconciled before a new logical attempt.
CREATE OR REPLACE FUNCTION pipeline_max_attempts(p_stage TEXT)
RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN p_stage = 'publishing' THEN 1 ELSE 4 END
$$;

-- 2. Bulk retry. Resumes each failed/blocked run from its current (failed)
-- stage only. Completed stage outputs stay on content_items and are reused.
CREATE OR REPLACE FUNCTION retry_failed_pipelines(
  p_organization_id UUID,
  p_requested_by TEXT DEFAULT 'dashboard',
  p_limit INTEGER DEFAULT 100
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run RECORD;
  v_retried JSONB := '[]'::JSONB;
  v_skipped JSONB := '[]'::JSONB;
BEGIN
  FOR v_run IN
    SELECT r.id, r.current_stage, r.content_item_id
    FROM pipeline_runs r
    JOIN content_items c ON c.id = r.content_item_id
    WHERE r.organization_id = p_organization_id
      AND r.status IN ('failed', 'blocked')
      AND c.approval_status <> 'rejected'
      -- Only the newest run per content item is authoritative.
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_runs newer
        WHERE newer.content_item_id = r.content_item_id AND newer.created_at > r.created_at
      )
    ORDER BY r.updated_at
    LIMIT GREATEST(1, LEAST(p_limit, 500))
  LOOP
    BEGIN
      PERFORM resume_pipeline_run(v_run.id, p_requested_by);
      v_retried := v_retried || jsonb_build_object('runId', v_run.id, 'stage', v_run.current_stage);
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('runId', v_run.id, 'reason', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'retried', v_retried,
    'skipped', v_skipped,
    'retriedCount', jsonb_array_length(v_retried),
    'skippedCount', jsonb_array_length(v_skipped)
  );
END;
$$;

-- 3. Scheduler start. Only never-started drafts are started; items that already
-- have a run are resumed through retry paths, never restarted from research.
CREATE OR REPLACE FUNCTION start_due_scheduled_content(
  p_now TIMESTAMPTZ DEFAULT NOW(),
  p_lookahead INTERVAL DEFAULT INTERVAL '15 minutes',
  p_limit INTEGER DEFAULT 50
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item RECORD;
  v_started INTEGER := 0;
  v_errors JSONB := '[]'::JSONB;
BEGIN
  FOR v_item IN
    SELECT c.id, c.organization_id, c.scheduled_at, c.generation_lead_minutes
    FROM content_items c
    WHERE c.status = 'draft'
      AND c.scheduled_at IS NOT NULL
      -- Start once the generation lead window opens (lookahead absorbs tick jitter).
      AND c.scheduled_at - make_interval(mins => c.generation_lead_minutes) <= p_now + p_lookahead
      -- Slots missed by more than an hour (machine was off) are left for the planner to reslot.
      AND c.scheduled_at >= p_now - INTERVAL '60 minutes'
      AND NOT EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.content_item_id = c.id)
    ORDER BY c.scheduled_at
    LIMIT GREATEST(1, LEAST(p_limit, 200))
    FOR UPDATE OF c SKIP LOCKED
  LOOP
    BEGIN
      PERFORM start_content_pipeline(
        v_item.id, v_item.organization_id, 'scheduler', 'research',
        jsonb_build_object('scheduledAt', v_item.scheduled_at, 'generationLeadMinutes', v_item.generation_lead_minutes),
        p_now
      );
      v_started := v_started + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object('contentItemId', v_item.id, 'reason', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('started', v_started, 'errors', v_errors);
END;
$$;

-- 4. Durable notification outbox.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_item_id UUID REFERENCES content_items(id) ON DELETE CASCADE,
  pipeline_run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_attempt_id UUID REFERENCES stage_attempts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('stage_permanent_failed', 'stage_blocked', 'approval_requested', 'published')),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_dispatch
  ON notification_outbox(status, available_at);
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_notification_outbox_updated_at ON notification_outbox;
CREATE TRIGGER update_notification_outbox_updated_at BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION enqueue_notification(
  p_organization_id UUID,
  p_content_item_id UUID,
  p_run_id UUID,
  p_attempt_id UUID,
  p_event_type TEXT,
  p_dedupe_suffix TEXT,
  p_payload JSONB
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  INSERT INTO notification_outbox (
    organization_id, content_item_id, pipeline_run_id, stage_attempt_id,
    channel, event_type, dedupe_key, payload
  )
  SELECT p_organization_id, p_content_item_id, p_run_id, p_attempt_id,
    ch, p_event_type, p_event_type || '-' || p_dedupe_suffix || '-' || ch, COALESCE(p_payload, '{}')
  FROM unnest(ARRAY['telegram', 'whatsapp']) AS ch
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Alert whenever an attempt becomes permanently failed or blocked.
CREATE OR REPLACE FUNCTION notify_stage_attempt_terminal()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item content_items%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('permanent_failed', 'blocked') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  -- resume_pipeline_run converts blocked -> permanent_failed as bookkeeping; not a new failure.
  IF OLD.status = 'blocked' AND NEW.status = 'permanent_failed' THEN RETURN NEW; END IF;

  SELECT * INTO v_item FROM content_items WHERE id = NEW.content_item_id;
  PERFORM enqueue_notification(
    NEW.organization_id, NEW.content_item_id, NEW.pipeline_run_id, NEW.id,
    CASE WHEN NEW.status = 'blocked' THEN 'stage_blocked' ELSE 'stage_permanent_failed' END,
    NEW.id::TEXT,
    jsonb_build_object(
      'stage', NEW.stage,
      'attemptNo', NEW.attempt_no,
      'nicheId', v_item.niche_id,
      'subTopic', v_item.sub_topic,
      'mediaType', v_item.media_type,
      'scheduledAt', v_item.scheduled_at,
      'errorCode', NEW.error->>'code',
      'errorMessage', LEFT(COALESCE(NEW.error->>'message', ''), 500)
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stage_attempt_terminal_notification ON stage_attempts;
CREATE TRIGGER stage_attempt_terminal_notification
  AFTER UPDATE OF status ON stage_attempts
  FOR EACH ROW EXECUTE FUNCTION notify_stage_attempt_terminal();

CREATE OR REPLACE FUNCTION claim_notification_outbox(p_limit INTEGER DEFAULT 20)
RETURNS SETOF notification_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE notification_outbox SET status = 'pending', claimed_at = NULL
  WHERE status = 'claimed' AND claimed_at < NOW() - INTERVAL '5 minutes';

  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM notification_outbox
    WHERE status = 'pending' AND available_at <= NOW()
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(1, LEAST(p_limit, 100))
  )
  UPDATE notification_outbox n
  SET status = 'claimed', claimed_at = NOW(), attempts = attempts + 1
  FROM candidates c WHERE n.id = c.id
  RETURNING n.*;
END;
$$;

CREATE OR REPLACE FUNCTION complete_notification(
  p_id UUID,
  p_status TEXT,
  p_error TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated INTEGER;
BEGIN
  IF p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
    RAISE EXCEPTION 'Invalid notification status %', p_status;
  END IF;
  UPDATE notification_outbox
  SET status = CASE
        WHEN p_status = 'retry' AND attempts >= 5 THEN 'failed'
        WHEN p_status = 'retry' THEN 'pending'
        ELSE p_status END,
      sent_at = CASE WHEN p_status = 'sent' THEN NOW() ELSE sent_at END,
      claimed_at = NULL,
      last_error = LEFT(p_error, 2000),
      available_at = CASE WHEN p_status = 'retry'
        THEN NOW() + (POWER(2, LEAST(attempts, 6)) * INTERVAL '30 seconds') ELSE available_at END
  WHERE id = p_id AND status = 'claimed';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION retry_failed_pipelines(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION start_due_scheduled_content(TIMESTAMPTZ, INTERVAL, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_notification(UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION notify_stage_attempt_terminal() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_notification_outbox(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_notification(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retry_failed_pipelines(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION start_due_scheduled_content(TIMESTAMPTZ, INTERVAL, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION enqueue_notification(UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION claim_notification_outbox(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION complete_notification(UUID, TEXT, TEXT) TO service_role;

COMMIT;
