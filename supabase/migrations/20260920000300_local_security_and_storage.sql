-- Phase 0: secure server-mediated access and provision local Storage.

-- Remove unsafe policies from databases that previously applied migration 001.
DROP POLICY IF EXISTS "Users can view own organization" ON organizations;
DROP POLICY IF EXISTS "Users can manage own organization" ON organizations;
DROP POLICY IF EXISTS "Accounts scoped to organization" ON connected_accounts;
DROP POLICY IF EXISTS "Profiles scoped to organization" ON niche_profiles;
DROP POLICY IF EXISTS "Content scoped to organization" ON content_items;
DROP POLICY IF EXISTS "Jobs scoped to organization" ON jobs;

-- Keep all application tables protected until authenticated organization membership
-- and user-scoped policies are introduced.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorized_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE music_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_attempts ENABLE ROW LEVEL SECURITY;

-- Generated videos can exceed the global 50 MiB default. The bucket is private;
-- API and worker services use the service-role client and publishing uses signed URLs.
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) VALUES (
  'viralforge-content',
  'viralforge-content',
  FALSE,
  524288000,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
