-- Phase 3: post insights, slot tuning, operations alerts.
-- Insights hold per-post counts only (no viewer/commenter data).

BEGIN;

-- ---------------------------------------------------------------------------
-- S1: post insights, one row per publication and checkpoint
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  publication_attempt_id UUID NOT NULL REFERENCES publication_attempts(id) ON DELETE CASCADE,
  content_item_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  connected_account_id UUID REFERENCES connected_accounts(id) ON DELETE SET NULL,
  niche_id niche_id NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook')),
  media_type media_type NOT NULL,
  checkpoint TEXT NOT NULL CHECK (checkpoint IN ('1h', '24h', '72h', '7d')),
  posted_at TIMESTAMPTZ NOT NULL,
  -- Minutes since midnight IST when the post went live; what slot tuning learns from.
  posted_minute_ist INTEGER NOT NULL CHECK (posted_minute_ist BETWEEN 0 AND 1439),
  status TEXT NOT NULL DEFAULT 'collected' CHECK (status IN ('collected', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  reach INTEGER,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,
  interactions INTEGER,
  metrics JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (publication_attempt_id, checkpoint)
);
CREATE INDEX IF NOT EXISTS idx_post_insights_tuning
  ON post_insights(organization_id, niche_id, checkpoint, posted_at DESC) WHERE status = 'collected';
ALTER TABLE post_insights ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS update_post_insights_updated_at ON post_insights;
CREATE TRIGGER update_post_insights_updated_at BEFORE UPDATE ON post_insights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Published publications whose checkpoint is due and not yet collected
-- (failed rows are retried up to 3 times, 30 minutes apart).
CREATE OR REPLACE FUNCTION due_insight_checkpoints(p_now TIMESTAMPTZ DEFAULT NOW(), p_limit INTEGER DEFAULT 25)
RETURNS TABLE (
  publication_attempt_id UUID,
  organization_id UUID,
  content_item_id UUID,
  connected_account_id UUID,
  niche_id niche_id,
  platform TEXT,
  media_type media_type,
  remote_post_id TEXT,
  posted_at TIMESTAMPTZ,
  checkpoint TEXT,
  attempts INTEGER
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH checkpoints(checkpoint, offset_interval) AS (
    VALUES ('1h', INTERVAL '1 hour'), ('24h', INTERVAL '24 hours'), ('72h', INTERVAL '72 hours'), ('7d', INTERVAL '7 days')
  )
  SELECT pa.id, pa.organization_id, pa.content_item_id, pa.connected_account_id, ci.niche_id,
    pa.platform, ci.media_type, pa.remote_post_id, pa.completed_at, c.checkpoint, COALESCE(pi.attempts, 0)
  FROM publication_attempts pa
  JOIN content_items ci ON ci.id = pa.content_item_id
  CROSS JOIN checkpoints c
  LEFT JOIN post_insights pi ON pi.publication_attempt_id = pa.id AND pi.checkpoint = c.checkpoint
  WHERE pa.status = 'published'
    AND pa.remote_post_id IS NOT NULL
    AND pa.platform IN ('instagram', 'facebook')
    AND pa.completed_at + c.offset_interval <= p_now
    -- Skip checkpoints that are long past (e.g. the collector was off for weeks).
    AND pa.completed_at + c.offset_interval > p_now - INTERVAL '3 days'
    AND (pi.id IS NULL OR (pi.status = 'failed' AND pi.attempts < 3 AND pi.updated_at < p_now - INTERVAL '30 minutes'))
  ORDER BY pa.completed_at + c.offset_interval
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- S2: slot tuning
-- ---------------------------------------------------------------------------
ALTER TABLE niche_schedule_settings
  ADD COLUMN IF NOT EXISTS slot_tuning TEXT NOT NULL DEFAULT 'suggest'
    CHECK (slot_tuning IN ('off', 'suggest', 'auto')),
  ADD COLUMN IF NOT EXISTS exploration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (exploration_minutes BETWEEN 0 AND 90);

CREATE TABLE IF NOT EXISTS slot_recommendations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  niche_id niche_id NOT NULL,
  window_days INTEGER NOT NULL,
  current_slots TEXT[] NOT NULL,
  recommended_slots TEXT[] NOT NULL,
  changes JSONB NOT NULL DEFAULT '[]',
  evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'superseded')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(recommended_slots) BETWEEN 1 AND 10),
  CHECK (array_to_string(recommended_slots, ',') ~ '^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$')
);
-- At most one open recommendation per niche.
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_recommendations_one_pending
  ON slot_recommendations(organization_id, niche_id) WHERE status = 'pending';
ALTER TABLE slot_recommendations ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS update_slot_recommendations_updated_at ON slot_recommendations;
CREATE TRIGGER update_slot_recommendations_updated_at BEFORE UPDATE ON slot_recommendations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Replaces any open recommendation for the niche with a new one.
CREATE OR REPLACE FUNCTION create_slot_recommendation(
  p_organization_id UUID,
  p_niche_id niche_id,
  p_window_days INTEGER,
  p_current_slots TEXT[],
  p_recommended_slots TEXT[],
  p_changes JSONB,
  p_evidence JSONB
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE slot_recommendations SET status = 'superseded', decided_by = 'system', decided_at = NOW()
  WHERE organization_id = p_organization_id AND niche_id = p_niche_id AND status = 'pending';
  INSERT INTO slot_recommendations (organization_id, niche_id, window_days, current_slots, recommended_slots, changes, evidence)
  VALUES (p_organization_id, p_niche_id, p_window_days, p_current_slots, p_recommended_slots,
    COALESCE(p_changes, '[]'), COALESCE(p_evidence, '{}'))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Applies a pending recommendation, but only if the niche's slots have not
-- changed since it was computed (otherwise it is superseded and
-- {"applied": false} is returned).
CREATE OR REPLACE FUNCTION apply_slot_recommendation(p_id UUID, p_decided_by TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rec slot_recommendations%ROWTYPE;
  v_current TEXT[];
BEGIN
  SELECT * INTO v_rec FROM slot_recommendations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Slot recommendation % not found', p_id; END IF;
  IF v_rec.status <> 'pending' THEN RAISE EXCEPTION 'Slot recommendation is %', v_rec.status; END IF;

  SELECT slots_ist INTO v_current FROM niche_schedule_settings
  WHERE organization_id = v_rec.organization_id AND niche_id = v_rec.niche_id FOR UPDATE;
  IF v_current IS DISTINCT FROM v_rec.current_slots THEN
    -- Returned rather than raised so the superseded status is kept.
    UPDATE slot_recommendations SET status = 'superseded', decided_by = 'system', decided_at = NOW() WHERE id = p_id;
    RETURN jsonb_build_object('applied', FALSE, 'nicheId', v_rec.niche_id,
      'reason', 'Slots changed since this recommendation was made; wait for the next one');
  END IF;

  UPDATE niche_schedule_settings SET slots_ist = v_rec.recommended_slots
  WHERE organization_id = v_rec.organization_id AND niche_id = v_rec.niche_id;
  UPDATE slot_recommendations SET status = 'applied', decided_by = LEFT(COALESCE(p_decided_by, 'operator'), 200), decided_at = NOW()
  WHERE id = p_id;
  INSERT INTO audit_logs (organization_id, niche_id, action, actor, actor_type, metadata)
  VALUES (v_rec.organization_id, v_rec.niche_id, 'slots.tuned', LEFT(COALESCE(p_decided_by, 'operator'), 200),
    CASE WHEN p_decided_by = 'system' THEN 'system' ELSE 'user' END,
    jsonb_build_object('recommendationId', p_id, 'from', v_rec.current_slots, 'to', v_rec.recommended_slots));
  RETURN jsonb_build_object('applied', TRUE, 'nicheId', v_rec.niche_id, 'slots', v_rec.recommended_slots);
END;
$$;

CREATE OR REPLACE FUNCTION dismiss_slot_recommendation(p_id UUID, p_decided_by TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE slot_recommendations SET status = 'dismissed', decided_by = LEFT(COALESCE(p_decided_by, 'operator'), 200), decided_at = NOW()
  WHERE id = p_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'No pending slot recommendation %', p_id; END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- S3: operations alerts
-- ---------------------------------------------------------------------------
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_event_type_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_event_type_check
  CHECK (event_type IN (
    'stage_permanent_failed', 'stage_blocked', 'approval_requested', 'published',
    'planner_failed', 'account_unhealthy', 'daily_digest', 'slot_recommendation'
  ));

REVOKE ALL ON FUNCTION due_insight_checkpoints(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_slot_recommendation(UUID, niche_id, INTEGER, TEXT[], TEXT[], JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_slot_recommendation(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION dismiss_slot_recommendation(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_insight_checkpoints(TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION create_slot_recommendation(UUID, niche_id, INTEGER, TEXT[], TEXT[], JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION apply_slot_recommendation(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION dismiss_slot_recommendation(UUID, TEXT) TO service_role;

COMMIT;
