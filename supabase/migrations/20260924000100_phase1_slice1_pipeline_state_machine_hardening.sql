-- Phase 1 Slice 1: Durable Pipeline State Machine Hardening
-- Adds blocked/waiting semantics, improved retry handling, and safer reconciliation.

BEGIN;

-- 1. Add waiting_reason and blocked status to pipeline_runs
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS waiting_reason TEXT CHECK (waiting_reason IN ('approval_required', 'schedule_required', 'scheduled_release', 'retry_backoff', 'operator_intervention')),
  DROP CONSTRAINT IF EXISTS pipeline_runs_status_check,
  ADD CONSTRAINT pipeline_runs_status_check CHECK (status IN ('pending', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'));

-- 2. Add failure_class to stage_attempts
ALTER TABLE stage_attempts
  ADD COLUMN IF NOT EXISTS failure_class TEXT CHECK (failure_class IN ('transient', 'permanent', 'blocked', 'cancelled', 'uncertain')),
  DROP CONSTRAINT IF EXISTS stage_attempts_status_check,
  ADD CONSTRAINT stage_attempts_status_check CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'retryable_failed', 'permanent_failed', 'blocked', 'cancelled'));

-- 3. Add explicit block_stage_attempt function
CREATE OR REPLACE FUNCTION block_stage_attempt(
  p_attempt_id UUID,
  p_worker_id TEXT,
  p_error JSONB,
  p_reason TEXT DEFAULT 'policy_blocked'
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_attempt stage_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt FROM stage_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage attempt not found'; END IF;

  IF v_attempt.worker_id IS DISTINCT FROM p_worker_id AND v_attempt.status = 'processing' THEN
    RAISE EXCEPTION 'Stage attempt is owned by another worker';
  END IF;

  UPDATE stage_attempts
  SET status = 'blocked',
      failure_class = 'blocked',
      error = p_error,
      completed_at = NOW(),
      lease_expires_at = NULL
  WHERE id = p_attempt_id;

  UPDATE pipeline_runs
  SET status = 'blocked',
      error = p_error
  WHERE id = v_attempt.pipeline_run_id;

  UPDATE content_items
  SET status = 'blocked',
      validation_errors = ARRAY[COALESCE(p_error->>'message', 'Pipeline stage blocked')]
  WHERE id = v_attempt.content_item_id;

  RETURN v_attempt.pipeline_run_id;
END;
$$;

-- 4. Update fail_stage_attempt to handle retryable failures without marking run failed
CREATE OR REPLACE FUNCTION fail_stage_attempt(
  p_attempt_id UUID,
  p_worker_id TEXT,
  p_error JSONB,
  p_retryable BOOLEAN DEFAULT TRUE
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt stage_attempts%ROWTYPE;
  v_status TEXT;
  v_run_status TEXT;
BEGIN
  SELECT * INTO v_attempt FROM stage_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage attempt not found'; END IF;

  IF v_attempt.status = 'completed' THEN RETURN v_attempt.pipeline_run_id; END IF;

  IF v_attempt.worker_id IS DISTINCT FROM p_worker_id AND v_attempt.status = 'processing' THEN
    RAISE EXCEPTION 'Stage attempt is owned by another worker';
  END IF;

  v_status := CASE
    WHEN p_retryable AND v_attempt.attempt_no < v_attempt.max_attempts THEN 'retryable_failed'
    ELSE 'permanent_failed'
  END;

  v_run_status := CASE
    WHEN v_status = 'retryable_failed' THEN 'running' -- Keep run active while waiting for BullMQ retry
    ELSE 'failed'
  END;

  UPDATE stage_attempts
  SET status = v_status,
      failure_class = CASE WHEN v_status = 'permanent_failed' THEN 'permanent' ELSE 'transient' END,
      error = p_error,
      completed_at = NOW(),
      lease_expires_at = NULL
  WHERE id = p_attempt_id;

  UPDATE pipeline_runs
  SET status = v_run_status,
      current_stage = v_attempt.stage,
      error = p_error,
      waiting_reason = CASE WHEN v_status = 'retryable_failed' THEN 'retry_backoff' ELSE NULL END
  WHERE id = v_attempt.pipeline_run_id;

  -- Only mark content failed if it's a permanent failure
  IF v_status = 'permanent_failed' THEN
    UPDATE content_items
    SET status = 'failed',
        validation_errors = ARRAY[COALESCE(p_error->>'message', 'Pipeline stage failed')]
    WHERE id = v_attempt.content_item_id;
  ELSE
    UPDATE content_items
    SET status = CASE v_attempt.stage
      WHEN 'research' THEN 'queued'::content_status
      WHEN 'generation' THEN 'researched'::content_status
      WHEN 'media' THEN 'generated'::content_status
      WHEN 'rendering' THEN 'rendering'::content_status
      WHEN 'validation' THEN 'rendering'::content_status
      WHEN 'publishing' THEN 'publishing'::content_status
      ELSE status
    END
    WHERE id = v_attempt.content_item_id;
  END IF;

  RETURN v_attempt.pipeline_run_id;
END;
$$;

-- 5. Preserve an authoritative waiting reason at approval/schedule gates.
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
    completed_at = NOW(), lease_expires_at = NULL, failure_class = NULL
  WHERE id = p_attempt_id AND status = 'processing' AND worker_id = p_worker_id
  RETURNING * INTO v_attempt;
  IF NOT FOUND THEN
    SELECT * INTO v_attempt FROM stage_attempts WHERE id = p_attempt_id;
    IF v_attempt.status = 'completed' THEN RETURN v_attempt.pipeline_run_id; END IF;
    RAISE EXCEPTION 'Stage attempt is not owned by worker or is not processing';
  END IF;

  SELECT * INTO v_run FROM pipeline_runs WHERE id = v_attempt.pipeline_run_id FOR UPDATE;
  IF v_run.current_stage IS DISTINCT FROM v_attempt.stage OR v_run.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Stage attempt is no longer authoritative for pipeline run';
  END IF;
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
    UPDATE pipeline_runs SET status = 'completed', completed_at = NOW(), error = NULL, waiting_reason = NULL
      WHERE id = v_run.id;
    RETURN v_run.id;
  END IF;

  IF v_attempt.stage = 'validation' AND v_item.publish_mode = 'manual_approval'
     AND v_item.approval_status <> 'approved' THEN
    UPDATE content_items SET status = 'validated', approval_status = 'pending' WHERE id = v_item.id;
    UPDATE pipeline_runs SET status = 'waiting', current_stage = 'publishing',
      waiting_reason = 'approval_required', error = NULL WHERE id = v_run.id;
    RETURN v_run.id;
  END IF;

  IF v_next = 'publishing' AND v_item.publish_mode = 'scheduled' THEN
    IF v_item.scheduled_at IS NULL THEN
      UPDATE pipeline_runs SET status = 'waiting', current_stage = 'publishing',
        waiting_reason = 'schedule_required',
        error = jsonb_build_object('code', 'scheduled_at_required') WHERE id = v_run.id;
      RETURN v_run.id;
    END IF;
    v_available := GREATEST(NOW(), v_item.scheduled_at);
    UPDATE content_items SET status = 'scheduled' WHERE id = v_item.id;
    UPDATE pipeline_runs SET waiting_reason = CASE WHEN v_available > NOW() THEN 'scheduled_release' ELSE NULL END
      WHERE id = v_run.id;
  END IF;

  PERFORM enqueue_pipeline_attempt(v_run.id, v_next, v_available);
  RETURN v_run.id;
END;
$$;

-- Generic resume cannot bypass approval or schedule gates.
CREATE OR REPLACE FUNCTION resume_pipeline_run(p_run_id UUID, p_requested_by TEXT DEFAULT 'system')
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run pipeline_runs%ROWTYPE; v_attempt stage_attempts%ROWTYPE; v_item content_items%ROWTYPE; v_stage TEXT;
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
  UPDATE pipeline_runs SET requested_by = p_requested_by, status = 'pending', error = NULL, waiting_reason = NULL
    WHERE id = p_run_id;
  RETURN enqueue_pipeline_attempt(p_run_id, v_stage, NOW());
END;
$$;

-- 6. Fix reconcile_pipeline_work to recover retryable_failed and failed outbox rows
CREATE OR REPLACE FUNCTION reconcile_pipeline_work()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_stale INTEGER := 0;
  v_outbox INTEGER := 0;
BEGIN
  -- Mark expired leases as retryable_failed
  UPDATE stage_attempts
  SET status = 'retryable_failed',
      failure_class = 'transient',
      worker_id = NULL,
      lease_expires_at = NULL,
      error = jsonb_build_object('code', 'lease_expired', 'message', 'Worker lease expired')
  WHERE status = 'processing' AND lease_expires_at < NOW();
  GET DIAGNOSTICS v_stale = ROW_COUNT;

  -- Recover stale outbox claims
  UPDATE queue_outbox SET status = 'pending', claim_token = NULL, claimed_at = NULL
  WHERE status = 'claimed' AND claimed_at < NOW() - INTERVAL '2 minutes';

  -- Rearm any outbox command that can no longer be executed by the attempt it references.
  DELETE FROM queue_outbox
  WHERE stage_attempt_id IN (
    SELECT id FROM stage_attempts WHERE status IN ('pending', 'queued', 'retryable_failed')
  )
  AND status IN ('failed', 'cancelled', 'dispatched');

  INSERT INTO queue_outbox (
    organization_id, pipeline_run_id, stage_attempt_id, queue_name, job_name,
    dedupe_key, payload, available_at
  )
  SELECT
    a.organization_id,
    a.pipeline_run_id,
    a.id,
    pipeline_queue_name(a.stage),
    'execute-' || a.stage,
    'pipeline-' || REPLACE(a.pipeline_run_id::TEXT, ':', '-') || '-' || a.stage || '-' || a.attempt_no,
    jsonb_build_object(
      'schemaVersion', 1,
      'commandType', 'execute_stage',
      'runId', a.pipeline_run_id,
      'stageAttemptId', a.id,
      'contentItemId', a.content_item_id,
      'organizationId', a.organization_id,
      'stage', a.stage,
      'attemptNo', a.attempt_no,
      'nicheId', c.niche_id,
      'triggerSource', c.trigger_source
    ),
    NOW()
  FROM stage_attempts a
  JOIN content_items c ON c.id = a.content_item_id
  WHERE a.status IN ('pending', 'retryable_failed')
    AND NOT EXISTS (SELECT 1 FROM queue_outbox q WHERE q.stage_attempt_id = a.id AND q.status IN ('pending', 'claimed'))
  ON CONFLICT (dedupe_key) DO NOTHING;

  GET DIAGNOSTICS v_outbox = ROW_COUNT;

  RETURN jsonb_build_object(
    'staleAttemptsRecovered', v_stale,
    'outboxCommandsCreated', v_outbox
  );
END;
$$;

-- 7. Restrict orchestration functions to service role.
REVOKE ALL ON FUNCTION block_stage_attempt(UUID, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_stage_attempt(UUID, TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION resume_pipeline_run(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION block_stage_attempt(UUID, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION complete_stage_attempt(UUID, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION resume_pipeline_run(UUID, TEXT) TO service_role;

COMMIT;
