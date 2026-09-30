-- Phase 2 Slices 3, 5, 6: daily planner, multi-account publishing, one-tap approval.

BEGIN;

-- ---------------------------------------------------------------------------
-- Planner configuration per niche
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS niche_schedule_settings (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  niche_id niche_id NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  posts_per_day INTEGER NOT NULL DEFAULT 5 CHECK (posts_per_day BETWEEN 0 AND 10),
  -- Count per media type; must sum to posts_per_day (enforced by the planner).
  content_mix JSONB NOT NULL DEFAULT '{"video_reel": 3, "image_carousel": 1, "image_single": 1}',
  -- HH:MM in Asia/Kolkata. Reels take evening peaks, carousel midday, image morning.
  slots_ist TEXT[] NOT NULL DEFAULT ARRAY['07:30', '12:30', '17:30', '19:30', '21:30'],
  jitter_minutes INTEGER NOT NULL DEFAULT 10 CHECK (jitter_minutes BETWEEN 0 AND 30),
  -- manual_approval = one-tap approve; scheduled = fully automatic at the slot.
  publish_mode TEXT NOT NULL DEFAULT 'manual_approval' CHECK (publish_mode IN ('manual_approval', 'scheduled')),
  auto_approve_at_slot BOOLEAN NOT NULL DEFAULT FALSE,
  generation_lead_minutes INTEGER NOT NULL DEFAULT 150 CHECK (generation_lead_minutes BETWEEN 30 AND 720),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, niche_id),
  -- Only valid HH:MM values, at most 10 slots.
  CHECK (cardinality(slots_ist) BETWEEN 1 AND 10),
  CHECK (array_to_string(slots_ist, ',') ~ '^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$')
);

-- Operator topic list and dated content calendar.
CREATE TABLE IF NOT EXISTS topic_backlog (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  niche_id niche_id NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  angle TEXT CHECK (char_length(angle) <= 500),
  key_points TEXT[] NOT NULL DEFAULT '{}',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  -- Dated entries (calendar) win on their date; undated entries are consumed by priority, then FIFO.
  scheduled_for DATE,
  media_type media_type,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'skipped')),
  used_by_content_item_id UUID REFERENCES content_items(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  created_by TEXT NOT NULL DEFAULT 'operator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_topic_backlog_pick
  ON topic_backlog(organization_id, niche_id, status, scheduled_for, priority DESC, created_at);

-- Cached trend fetches (one row per source per fetch).
CREATE TABLE IF NOT EXISTS trend_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL CHECK (source IN ('google_trends', 'youtube_trending')),
  geo TEXT NOT NULL DEFAULT 'IN',
  items JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trend_snapshots_recent ON trend_snapshots(source, geo, fetched_at DESC);

-- One planner run per org/date/niche; makes the daily job safe to re-run.
CREATE TABLE IF NOT EXISTS daily_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_date DATE NOT NULL,
  niche_id niche_id NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'planned', 'failed')),
  content_item_ids UUID[] NOT NULL DEFAULT '{}',
  topic_sources JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, plan_date, niche_id)
);

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS topic_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS plan_date DATE;
CREATE INDEX IF NOT EXISTS idx_content_items_topic_history
  ON content_items(organization_id, niche_id, created_at DESC) WHERE topic_fingerprint IS NOT NULL;

ALTER TABLE publication_attempts
  ADD COLUMN IF NOT EXISTS platform TEXT CHECK (platform IN ('instagram', 'facebook')),
  ADD COLUMN IF NOT EXISTS permalink TEXT;

ALTER TABLE niche_schedule_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_backlog ENABLE ROW LEVEL SECURITY;
ALTER TABLE trend_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_plans ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_niche_schedule_settings_updated_at ON niche_schedule_settings;
CREATE TRIGGER update_niche_schedule_settings_updated_at BEFORE UPDATE ON niche_schedule_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_topic_backlog_updated_at ON topic_backlog;
CREATE TRIGGER update_topic_backlog_updated_at BEFORE UPDATE ON topic_backlog
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_daily_plans_updated_at ON daily_plans;
CREATE TRIGGER update_daily_plans_updated_at BEFORE UPDATE ON daily_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Claims backlog topics atomically so concurrent planners never reuse one.
CREATE OR REPLACE FUNCTION claim_backlog_topics(
  p_organization_id UUID,
  p_niche_id niche_id,
  p_plan_date DATE,
  p_limit INTEGER
) RETURNS SETOF topic_backlog
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM topic_backlog
    WHERE organization_id = p_organization_id AND niche_id = p_niche_id AND status = 'pending'
      AND (scheduled_for IS NULL OR scheduled_for = p_plan_date)
    ORDER BY (scheduled_for IS NULL), priority DESC, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(0, LEAST(p_limit, 10))
  )
  UPDATE topic_backlog t SET status = 'used', used_at = NOW()
  FROM picked WHERE t.id = picked.id
  RETURNING t.*;
END;
$$;

-- Dated calendar entries whose date passed without being used are skipped.
CREATE OR REPLACE FUNCTION expire_stale_calendar_topics(p_today DATE)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE topic_backlog SET status = 'skipped'
  WHERE status = 'pending' AND scheduled_for IS NOT NULL AND scheduled_for < p_today;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Resume honours the planned slot: approving early still publishes on time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resume_pipeline_run(p_run_id UUID, p_requested_by TEXT DEFAULT 'system')
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run pipeline_runs%ROWTYPE; v_attempt stage_attempts%ROWTYPE; v_item content_items%ROWTYPE; v_stage TEXT;
  v_available TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_run FROM pipeline_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pipeline run not found'; END IF;
  IF v_run.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'Cannot resume a % pipeline', v_run.status; END IF;
  SELECT * INTO v_item FROM content_items WHERE id = v_run.content_item_id FOR UPDATE;

  IF v_run.waiting_reason = 'approval_required' AND v_item.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Pipeline requires approval before publishing';
  END IF;
  IF v_run.waiting_reason = 'schedule_required' AND v_item.scheduled_at IS NULL THEN
    RAISE EXCEPTION 'Pipeline requires scheduled_at before publishing';
  END IF;

  v_stage := v_run.current_stage;
  SELECT * INTO v_attempt FROM stage_attempts
    WHERE pipeline_run_id = p_run_id AND stage = v_stage ORDER BY attempt_no DESC LIMIT 1;
  IF v_attempt.status IN ('pending', 'queued') THEN RETURN v_attempt.id; END IF;
  IF v_attempt.status = 'processing' AND v_attempt.lease_expires_at >= NOW() THEN RETURN v_attempt.id; END IF;
  IF v_attempt.status = 'blocked' THEN
    UPDATE stage_attempts SET status = 'permanent_failed', completed_at = NOW()
      WHERE id = v_attempt.id;
  ELSIF v_attempt.status = 'retryable_failed' AND v_attempt.attempt_no < v_attempt.max_attempts THEN
    DELETE FROM queue_outbox
    WHERE stage_attempt_id = v_attempt.id AND status IN ('failed', 'cancelled');
  ELSIF v_attempt.status = 'completed' THEN
    v_stage := pipeline_next_stage(v_stage);
  END IF;
  IF v_stage IS NULL THEN
    UPDATE pipeline_runs SET status = 'completed', completed_at = NOW(), waiting_reason = NULL WHERE id = p_run_id;
    RETURN NULL;
  END IF;

  IF v_stage = 'publishing' AND v_item.scheduled_at IS NOT NULL AND v_item.scheduled_at > NOW() THEN
    v_available := v_item.scheduled_at;
    UPDATE content_items SET status = 'scheduled' WHERE id = v_item.id;
  END IF;

  UPDATE pipeline_runs SET requested_by = p_requested_by, status = 'pending', error = NULL,
    waiting_reason = CASE WHEN v_available > NOW() THEN 'scheduled_release' ELSE NULL END
    WHERE id = p_run_id;
  RETURN enqueue_pipeline_attempt(p_run_id, v_stage, v_available);
END;
$$;

-- Approve and resume in one transaction (dashboard button and Telegram callback).
CREATE OR REPLACE FUNCTION approve_pipeline_run(p_run_id UUID, p_approved_by TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run pipeline_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM pipeline_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pipeline run not found'; END IF;
  IF v_run.status <> 'waiting' OR v_run.waiting_reason IS DISTINCT FROM 'approval_required' THEN
    RAISE EXCEPTION 'Pipeline run is not waiting for approval (status %, reason %)', v_run.status, v_run.waiting_reason;
  END IF;
  UPDATE content_items
  SET approval_status = 'approved', approved_at = NOW(), approved_by = LEFT(p_approved_by, 200)
  WHERE id = v_run.content_item_id;
  RETURN resume_pipeline_run(p_run_id, p_approved_by);
END;
$$;

CREATE OR REPLACE FUNCTION reject_pipeline_run(p_run_id UUID, p_rejected_by TEXT, p_reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run pipeline_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM pipeline_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pipeline run not found'; END IF;
  IF v_run.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'Pipeline run is already %', v_run.status; END IF;
  UPDATE content_items
  SET approval_status = 'rejected', status = 'cancelled',
      validation_errors = ARRAY['Rejected by ' || LEFT(p_rejected_by, 100) || ': ' || LEFT(COALESCE(p_reason, 'no reason'), 400)]
  WHERE id = v_run.content_item_id;
  UPDATE stage_attempts SET status = 'cancelled', completed_at = NOW()
  WHERE pipeline_run_id = p_run_id AND status IN ('pending', 'queued', 'retryable_failed');
  UPDATE queue_outbox SET status = 'cancelled' WHERE pipeline_run_id = p_run_id AND status IN ('pending', 'claimed');
  UPDATE pipeline_runs SET status = 'cancelled', cancelled_at = NOW(), waiting_reason = NULL,
    error = jsonb_build_object('code', 'rejected_by_operator', 'message', LEFT(COALESCE(p_reason, ''), 400))
  WHERE id = p_run_id;
  RETURN p_run_id;
END;
$$;

-- Auto-approve items whose niche allows it once their slot arrives.
CREATE OR REPLACE FUNCTION auto_approve_due_runs(p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run RECORD; v_count INTEGER := 0;
BEGIN
  FOR v_run IN
    SELECT r.id FROM pipeline_runs r
    JOIN content_items c ON c.id = r.content_item_id
    JOIN niche_schedule_settings s ON s.organization_id = c.organization_id AND s.niche_id = c.niche_id
    WHERE r.status = 'waiting' AND r.waiting_reason = 'approval_required'
      AND s.auto_approve_at_slot AND c.scheduled_at IS NOT NULL AND c.scheduled_at <= p_now
    FOR UPDATE OF r SKIP LOCKED
  LOOP
    PERFORM approve_pipeline_run(v_run.id, 'auto-approve-at-slot');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Approval request notification when a run starts waiting for approval.
CREATE OR REPLACE FUNCTION notify_approval_requested()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item content_items%ROWTYPE;
BEGIN
  IF NEW.status = 'waiting' AND NEW.waiting_reason = 'approval_required'
     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.waiting_reason IS DISTINCT FROM NEW.waiting_reason) THEN
    SELECT * INTO v_item FROM content_items WHERE id = NEW.content_item_id;
    PERFORM enqueue_notification(
      NEW.organization_id, NEW.content_item_id, NEW.id, NULL, 'approval_requested', NEW.id::TEXT,
      jsonb_build_object(
        'runId', NEW.id,
        'nicheId', v_item.niche_id,
        'subTopic', v_item.sub_topic,
        'mediaType', v_item.media_type,
        'scheduledAt', v_item.scheduled_at,
        'hook', LEFT(COALESCE(v_item.hook_variation_a, ''), 300),
        'caption', LEFT(COALESCE(v_item.ai_generation_metadata->'generatedContent'->>'caption', ''), 600)
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pipeline_run_approval_notification ON pipeline_runs;
CREATE TRIGGER pipeline_run_approval_notification
  AFTER UPDATE OF status, waiting_reason ON pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION notify_approval_requested();

REVOKE ALL ON FUNCTION claim_backlog_topics(UUID, niche_id, DATE, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_stale_calendar_topics(DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_pipeline_run(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_pipeline_run(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auto_approve_due_runs(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION notify_approval_requested() FROM PUBLIC;
REVOKE ALL ON FUNCTION resume_pipeline_run(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_backlog_topics(UUID, niche_id, DATE, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION expire_stale_calendar_topics(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION approve_pipeline_run(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reject_pipeline_run(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION auto_approve_due_runs(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION resume_pipeline_run(UUID, TEXT) TO service_role;

COMMIT;
