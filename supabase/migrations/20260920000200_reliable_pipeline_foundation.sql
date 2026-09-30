-- Milestone 1: durable, resumable pipeline foundation.
-- Additive migration: preserves existing content and can be applied to hosted Supabase.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_item_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_stage TEXT NOT NULL DEFAULT 'research'
    CHECK (current_stage IN ('research', 'generation', 'media', 'rendering', 'validation', 'publishing')),
  requested_start_stage TEXT NOT NULL DEFAULT 'research'
    CHECK (requested_start_stage IN ('research', 'generation', 'media', 'rendering', 'validation', 'publishing')),
  requested_by TEXT NOT NULL DEFAULT 'system',
  config_snapshot JSONB NOT NULL DEFAULT '{}',
  error JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_one_active_content
  ON pipeline_runs(content_item_id)
  WHERE status IN ('pending', 'running', 'waiting');
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_org_created
  ON pipeline_runs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
  ON pipeline_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS stage_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_item_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  stage TEXT NOT NULL
    CHECK (stage IN ('research', 'generation', 'media', 'rendering', 'validation', 'publishing')),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'retryable_failed', 'permanent_failed', 'blocked', 'cancelled')),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pipeline_run_id, stage, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_attempts_one_live_stage
  ON stage_attempts(pipeline_run_id, stage)
  WHERE status IN ('pending', 'queued', 'processing');
CREATE INDEX IF NOT EXISTS idx_stage_attempts_run_created
  ON stage_attempts(pipeline_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stage_attempts_lease
  ON stage_attempts(status, lease_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS pipeline_artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_attempt_id UUID REFERENCES stage_attempts(id) ON DELETE SET NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_item_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  storage_path TEXT,
  checksum TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  is_checkpoint BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_artifacts_run_stage
  ON pipeline_artifacts(pipeline_run_id, stage, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_artifacts_checkpoint
  ON pipeline_artifacts(stage_attempt_id, artifact_type)
  WHERE is_checkpoint = TRUE;

CREATE TABLE IF NOT EXISTS queue_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_attempt_id UUID REFERENCES stage_attempts(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL DEFAULT 'execute_stage'
    CHECK (command_type IN ('execute_stage', 'reconcile_pipeline')),
  queue_name TEXT NOT NULL,
  job_name TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'dispatched', 'failed', 'cancelled')),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_queue_outbox_dispatch
  ON queue_outbox(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS publication_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_attempt_id UUID NOT NULL REFERENCES stage_attempts(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_item_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  connected_account_id UUID REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  content_revision INTEGER NOT NULL DEFAULT 1,
  schedule_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'uncertain', 'published', 'failed', 'cancelled')),
  remote_container_id TEXT,
  remote_post_id TEXT,
  error JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(content_item_id, connected_account_id, content_revision, schedule_revision)
);

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS publish_mode TEXT NOT NULL DEFAULT 'manual_approval'
    CHECK (publish_mode IN ('manual_approval', 'immediate_auto', 'scheduled')),
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS generation_lead_minutes INTEGER NOT NULL DEFAULT 120
    CHECK (generation_lead_minutes >= 0),
  ADD COLUMN IF NOT EXISTS schedule_revision INTEGER NOT NULL DEFAULT 1
    CHECK (schedule_revision > 0);

-- Existing future-dated calendar entries retain scheduled behavior.
UPDATE content_items
SET publish_mode = 'scheduled', approval_status = 'not_required'
WHERE scheduled_at IS NOT NULL
  AND publish_mode = 'manual_approval';

DROP TRIGGER IF EXISTS update_pipeline_runs_updated_at ON pipeline_runs;
CREATE TRIGGER update_pipeline_runs_updated_at BEFORE UPDATE ON pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_stage_attempts_updated_at ON stage_attempts;
CREATE TRIGGER update_stage_attempts_updated_at BEFORE UPDATE ON stage_attempts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_queue_outbox_updated_at ON queue_outbox;
CREATE TRIGGER update_queue_outbox_updated_at BEFORE UPDATE ON queue_outbox
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_publication_attempts_updated_at ON publication_attempts;
CREATE TRIGGER update_publication_attempts_updated_at BEFORE UPDATE ON publication_attempts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_attempts ENABLE ROW LEVEL SECURITY;

-- These orchestration tables intentionally have no anon/authenticated policies.
-- Server processes access them with the service-role client, which bypasses RLS.

CREATE OR REPLACE FUNCTION pipeline_queue_name(p_stage TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_stage
    WHEN 'research' THEN 'viralforge-research'
    WHEN 'generation' THEN 'viralforge-generation'
    WHEN 'media' THEN 'viralforge-media'
    WHEN 'rendering' THEN 'viralforge-rendering'
    WHEN 'validation' THEN 'viralforge-validation'
    WHEN 'publishing' THEN 'viralforge-publishing'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION pipeline_max_attempts(p_stage TEXT)
RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN p_stage = 'publishing' THEN 1 WHEN p_stage = 'rendering' THEN 2 ELSE 3 END
$$;

CREATE OR REPLACE FUNCTION pipeline_next_stage(p_stage TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_stage
    WHEN 'research' THEN 'generation'
    WHEN 'generation' THEN 'media'
    WHEN 'media' THEN 'rendering'
    WHEN 'rendering' THEN 'validation'
    WHEN 'validation' THEN 'publishing'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION enqueue_pipeline_attempt(
  p_run_id UUID,
  p_stage TEXT,
  p_available_at TIMESTAMPTZ DEFAULT NOW()
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run pipeline_runs%ROWTYPE;
  v_item content_items%ROWTYPE;
  v_attempt_id UUID;
  v_attempt_no INTEGER;
  v_dedupe TEXT;
  v_outbox_id UUID;
BEGIN
  SELECT * INTO v_run FROM pipeline_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pipeline run % not found', p_run_id; END IF;
  IF v_run.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Pipeline run % is %', p_run_id, v_run.status;
  END IF;
  IF pipeline_queue_name(p_stage) IS NULL THEN RAISE EXCEPTION 'Invalid pipeline stage %', p_stage; END IF;

  SELECT * INTO v_item FROM content_items WHERE id = v_run.content_item_id;
  SELECT COALESCE(MAX(attempt_no), 0) + 1 INTO v_attempt_no
    FROM stage_attempts WHERE pipeline_run_id = p_run_id AND stage = p_stage;

  INSERT INTO stage_attempts (
    pipeline_run_id, organization_id, content_item_id, stage, attempt_no, max_attempts, status
  ) VALUES (
    p_run_id, v_run.organization_id, v_run.content_item_id, p_stage, v_attempt_no,
    pipeline_max_attempts(p_stage), 'pending'
  ) RETURNING id INTO v_attempt_id;

  v_dedupe := 'pipeline-' || REPLACE(p_run_id::TEXT, ':', '-') || '-' || p_stage || '-' || v_attempt_no;
  INSERT INTO queue_outbox (
    organization_id, pipeline_run_id, stage_attempt_id, queue_name, job_name,
    dedupe_key, available_at, payload
  ) VALUES (
    v_run.organization_id, p_run_id, v_attempt_id, pipeline_queue_name(p_stage),
    'execute-' || p_stage, v_dedupe, COALESCE(p_available_at, NOW()),
    jsonb_build_object(
      'schemaVersion', 1, 'commandType', 'execute_stage', 'runId', p_run_id,
      'stageAttemptId', v_attempt_id, 'contentItemId', v_run.content_item_id,
      'organizationId', v_run.organization_id, 'stage', p_stage,
      'attemptNo', v_attempt_no, 'nicheId', v_item.niche_id,
      'triggerSource', v_item.trigger_source, 'notBefore', p_available_at
    )
  ) RETURNING id INTO v_outbox_id;

  UPDATE queue_outbox
  SET payload = payload || jsonb_build_object('outboxId', v_outbox_id)
  WHERE id = v_outbox_id;

  UPDATE pipeline_runs
  SET status = 'running', current_stage = p_stage, started_at = COALESCE(started_at, NOW()), error = NULL
  WHERE id = p_run_id;
  RETURN v_attempt_id;
END;
$$;

CREATE OR REPLACE FUNCTION start_content_pipeline(
  p_content_item_id UUID,
  p_organization_id UUID,
  p_requested_by TEXT DEFAULT 'system',
  p_start_stage TEXT DEFAULT 'research',
  p_config_snapshot JSONB DEFAULT '{}',
  p_available_at TIMESTAMPTZ DEFAULT NOW()
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run_id UUID;
  v_existing UUID;
BEGIN
  PERFORM 1 FROM content_items
    WHERE id = p_content_item_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Content item not found in organization'; END IF;

  SELECT id INTO v_existing FROM pipeline_runs
    WHERE content_item_id = p_content_item_id AND status IN ('pending', 'running', 'waiting')
    ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  INSERT INTO pipeline_runs (
    organization_id, content_item_id, requested_by, requested_start_stage,
    current_stage, config_snapshot, status
  ) VALUES (
    p_organization_id, p_content_item_id, p_requested_by, p_start_stage,
    p_start_stage, COALESCE(p_config_snapshot, '{}'), 'pending'
  ) RETURNING id INTO v_run_id;

  PERFORM enqueue_pipeline_attempt(v_run_id, p_start_stage, p_available_at);
  UPDATE content_items SET status = 'queued' WHERE id = p_content_item_id;
  RETURN v_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION claim_queue_outbox(
  p_dispatcher_id TEXT,
  p_limit INTEGER DEFAULT 25,
  p_stale_after INTERVAL DEFAULT INTERVAL '2 minutes'
) RETURNS SETOF queue_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE queue_outbox
  SET status = 'pending', claim_token = NULL, claimed_at = NULL,
      last_error = COALESCE(last_error, 'stale dispatcher claim recovered')
  WHERE status = 'claimed' AND claimed_at < NOW() - p_stale_after;

  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM queue_outbox
    WHERE status = 'pending' AND available_at <= NOW()
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(1, LEAST(p_limit, 100))
  )
  UPDATE queue_outbox q
  SET status = 'claimed', claim_token = gen_random_uuid(), claimed_at = NOW(),
      dispatch_attempts = dispatch_attempts + 1,
      last_error = NULL
  FROM candidates c WHERE q.id = c.id
  RETURNING q.*;
END;
$$;

CREATE OR REPLACE FUNCTION mark_outbox_dispatched(p_outbox_id UUID, p_claim_token UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE queue_outbox SET status = 'dispatched', dispatched_at = NOW()
  WHERE id = p_outbox_id AND status = 'claimed' AND claim_token = p_claim_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 1 THEN
    UPDATE stage_attempts SET status = 'queued'
    WHERE id = (SELECT stage_attempt_id FROM queue_outbox WHERE id = p_outbox_id)
      AND status = 'pending';
  END IF;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION release_outbox_claim(p_outbox_id UUID, p_claim_token UUID, p_error TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated INTEGER;
BEGIN
  UPDATE queue_outbox
  SET status = CASE WHEN dispatch_attempts >= 10 THEN 'failed' ELSE 'pending' END,
      claim_token = NULL, claimed_at = NULL, last_error = LEFT(p_error, 4000),
      available_at = NOW() + (LEAST(dispatch_attempts, 10) * INTERVAL '10 seconds')
  WHERE id = p_outbox_id AND status = 'claimed' AND claim_token = p_claim_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION claim_stage_attempt(
  p_attempt_id UUID,
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 900
) RETURNS stage_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_attempt stage_attempts%ROWTYPE;
BEGIN
  UPDATE stage_attempts
  SET status = 'processing', worker_id = p_worker_id,
      lease_expires_at = NOW() + make_interval(secs => GREATEST(30, p_lease_seconds)),
      started_at = COALESCE(started_at, NOW()), error = NULL
  WHERE id = p_attempt_id
    AND (status IN ('pending', 'queued', 'retryable_failed')
      OR (status = 'processing' AND lease_expires_at < NOW()))
  RETURNING * INTO v_attempt;
  IF NOT FOUND THEN SELECT * INTO v_attempt FROM stage_attempts WHERE id = p_attempt_id; END IF;
  RETURN v_attempt;
END;
$$;

CREATE OR REPLACE FUNCTION complete_stage_attempt(
  p_attempt_id UUID,
  p_worker_id TEXT,
  p_result JSONB DEFAULT '{}',
  p_checkpoint JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt stage_attempts%ROWTYPE;
  v_run pipeline_runs%ROWTYPE;
  v_item content_items%ROWTYPE;
  v_next TEXT;
  v_available TIMESTAMPTZ := NOW();
BEGIN
  UPDATE stage_attempts SET status = 'completed', result = COALESCE(p_result, '{}'),
    completed_at = NOW(), lease_expires_at = NULL
  WHERE id = p_attempt_id AND status = 'processing' AND worker_id = p_worker_id
  RETURNING * INTO v_attempt;
  IF NOT FOUND THEN
    SELECT * INTO v_attempt FROM stage_attempts WHERE id = p_attempt_id;
    IF v_attempt.status = 'completed' THEN RETURN v_attempt.pipeline_run_id; END IF;
    RAISE EXCEPTION 'Stage attempt is not owned by worker or is not processing';
  END IF;

  SELECT * INTO v_run FROM pipeline_runs WHERE id = v_attempt.pipeline_run_id FOR UPDATE;
  SELECT * INTO v_item FROM content_items WHERE id = v_attempt.content_item_id;

  IF p_checkpoint IS NOT NULL THEN
    INSERT INTO pipeline_artifacts (
      pipeline_run_id, stage_attempt_id, organization_id, content_item_id,
      stage, artifact_type, metadata, is_checkpoint
    ) VALUES (
      v_attempt.pipeline_run_id, v_attempt.id, v_attempt.organization_id,
      v_attempt.content_item_id, v_attempt.stage, 'stage_checkpoint', p_checkpoint, TRUE
    ) ON CONFLICT (stage_attempt_id, artifact_type) WHERE is_checkpoint = TRUE
      DO UPDATE SET metadata = EXCLUDED.metadata;
  END IF;

  v_next := pipeline_next_stage(v_attempt.stage);
  IF v_next IS NULL THEN
    UPDATE pipeline_runs SET status = 'completed', completed_at = NOW(), error = NULL
      WHERE id = v_run.id;
    RETURN v_run.id;
  END IF;

  IF v_attempt.stage = 'validation' AND v_item.publish_mode = 'manual_approval'
     AND v_item.approval_status <> 'approved' THEN
    UPDATE content_items SET status = 'validated', approval_status = 'pending'
      WHERE id = v_item.id;
    UPDATE pipeline_runs SET status = 'waiting', current_stage = 'publishing'
      WHERE id = v_run.id;
    RETURN v_run.id;
  END IF;

  IF v_next = 'publishing' AND v_item.publish_mode = 'scheduled' THEN
    IF v_item.scheduled_at IS NULL THEN
      UPDATE pipeline_runs SET status = 'waiting', current_stage = 'publishing',
        error = jsonb_build_object('code', 'scheduled_at_required') WHERE id = v_run.id;
      RETURN v_run.id;
    END IF;
    v_available := GREATEST(NOW(), v_item.scheduled_at);
    UPDATE content_items SET status = 'scheduled' WHERE id = v_item.id;
  END IF;

  PERFORM enqueue_pipeline_attempt(v_run.id, v_next, v_available);
  RETURN v_run.id;
END;
$$;

CREATE OR REPLACE FUNCTION fail_stage_attempt(
  p_attempt_id UUID,
  p_worker_id TEXT,
  p_error JSONB,
  p_retryable BOOLEAN DEFAULT TRUE
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_attempt stage_attempts%ROWTYPE; v_status TEXT;
BEGIN
  SELECT * INTO v_attempt FROM stage_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage attempt not found'; END IF;
  IF v_attempt.status = 'completed' THEN RETURN v_attempt.pipeline_run_id; END IF;
  IF v_attempt.worker_id IS DISTINCT FROM p_worker_id AND v_attempt.status = 'processing' THEN
    RAISE EXCEPTION 'Stage attempt is owned by another worker';
  END IF;
  v_status := CASE WHEN p_retryable AND v_attempt.attempt_no < v_attempt.max_attempts
    THEN 'retryable_failed' ELSE 'permanent_failed' END;
  UPDATE stage_attempts SET status = v_status, error = p_error, completed_at = NOW(), lease_expires_at = NULL
    WHERE id = p_attempt_id;
  UPDATE pipeline_runs SET status = 'failed', current_stage = v_attempt.stage, error = p_error
    WHERE id = v_attempt.pipeline_run_id;
  UPDATE content_items SET status = 'failed', validation_errors = ARRAY[COALESCE(p_error->>'message', 'Pipeline stage failed')]
    WHERE id = v_attempt.content_item_id;
  RETURN v_attempt.pipeline_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION resume_pipeline_run(p_run_id UUID, p_requested_by TEXT DEFAULT 'system')
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run pipeline_runs%ROWTYPE; v_attempt stage_attempts%ROWTYPE; v_stage TEXT;
BEGIN
  SELECT * INTO v_run FROM pipeline_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pipeline run not found'; END IF;
  IF v_run.status = 'completed' OR v_run.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot resume a % pipeline', v_run.status;
  END IF;
  v_stage := v_run.current_stage;
  SELECT * INTO v_attempt FROM stage_attempts
    WHERE pipeline_run_id = p_run_id AND stage = v_stage ORDER BY attempt_no DESC LIMIT 1;
  IF v_attempt.status IN ('pending', 'queued') THEN RETURN v_attempt.id; END IF;
  IF v_attempt.status = 'processing' AND v_attempt.lease_expires_at >= NOW() THEN RETURN v_attempt.id; END IF;
  IF v_attempt.status = 'retryable_failed' AND v_attempt.attempt_no < v_attempt.max_attempts THEN
    DELETE FROM queue_outbox WHERE stage_attempt_id = v_attempt.id AND status IN ('failed', 'cancelled');
  END IF;
  IF v_attempt.status = 'completed' THEN v_stage := pipeline_next_stage(v_stage); END IF;
  IF v_stage IS NULL THEN
    UPDATE pipeline_runs SET status = 'completed', completed_at = NOW() WHERE id = p_run_id;
    RETURN NULL;
  END IF;
  UPDATE pipeline_runs SET requested_by = p_requested_by, status = 'pending', error = NULL WHERE id = p_run_id;
  RETURN enqueue_pipeline_attempt(p_run_id, v_stage, NOW());
END;
$$;

CREATE OR REPLACE FUNCTION reconcile_pipeline_work()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_stale INTEGER := 0; v_outbox INTEGER := 0;
BEGIN
  UPDATE stage_attempts SET status = 'retryable_failed', worker_id = NULL, lease_expires_at = NULL,
    error = jsonb_build_object('code', 'lease_expired', 'message', 'Worker lease expired')
  WHERE status = 'processing' AND lease_expires_at < NOW();
  GET DIAGNOSTICS v_stale = ROW_COUNT;

  UPDATE queue_outbox SET status = 'pending', claim_token = NULL, claimed_at = NULL
  WHERE status = 'claimed' AND claimed_at < NOW() - INTERVAL '2 minutes';

  INSERT INTO queue_outbox (
    organization_id, pipeline_run_id, stage_attempt_id, queue_name, job_name,
    dedupe_key, payload, available_at
  )
  SELECT a.organization_id, a.pipeline_run_id, a.id, pipeline_queue_name(a.stage),
    'execute-' || a.stage,
    'pipeline-' || REPLACE(a.pipeline_run_id::TEXT, ':', '-') || '-' || a.stage || '-' || a.attempt_no,
    jsonb_build_object(
      'schemaVersion', 1, 'commandType', 'execute_stage', 'runId', a.pipeline_run_id,
      'stageAttemptId', a.id, 'contentItemId', a.content_item_id,
      'organizationId', a.organization_id, 'stage', a.stage, 'attemptNo', a.attempt_no,
      'nicheId', c.niche_id, 'triggerSource', c.trigger_source
    ), NOW()
  FROM stage_attempts a JOIN content_items c ON c.id = a.content_item_id
  WHERE a.status IN ('pending', 'retryable_failed')
    AND NOT EXISTS (SELECT 1 FROM queue_outbox q WHERE q.stage_attempt_id = a.id AND q.status <> 'cancelled')
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_outbox = ROW_COUNT;
  RETURN jsonb_build_object('staleAttemptsRecovered', v_stale, 'outboxCommandsCreated', v_outbox);
END;
$$;

REVOKE ALL ON FUNCTION enqueue_pipeline_attempt(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION start_content_pipeline(UUID, UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_queue_outbox(TEXT, INTEGER, INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_outbox_dispatched(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_outbox_claim(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_stage_attempt(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_stage_attempt(UUID, TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_stage_attempt(UUID, TEXT, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION resume_pipeline_run(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_pipeline_work() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION enqueue_pipeline_attempt(UUID, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION start_content_pipeline(UUID, UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION claim_queue_outbox(TEXT, INTEGER, INTERVAL) TO service_role;
GRANT EXECUTE ON FUNCTION mark_outbox_dispatched(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION release_outbox_claim(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION claim_stage_attempt(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION complete_stage_attempt(UUID, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION fail_stage_attempt(UUID, TEXT, JSONB, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION resume_pipeline_run(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reconcile_pipeline_work() TO service_role;
