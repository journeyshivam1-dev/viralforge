-- ViralForge Initial Database Schema
-- Supports 5 niches with multi-account, multi-niche scheduling

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enum types
CREATE TYPE niche_id AS ENUM ('food', 'health', 'tech', 'edtech', 'travel', 'cartoon');
CREATE TYPE content_status AS ENUM (
  'draft', 'queued', 'researched', 'generated', 'rendering',
  'validated', 'scheduled', 'publishing', 'published',
  'blocked', 'failed', 'cancelled'
);
CREATE TYPE media_type AS ENUM ('video_reel', 'image_carousel', 'image_single');
CREATE TYPE trigger_source AS ENUM ('calendar', 'telegram', 'whatsapp', 'manual', 'omniroute');
CREATE TYPE platform AS ENUM ('instagram', 'facebook');
CREATE TYPE account_status AS ENUM ('active', 'expired', 'revoked', 'pending');
CREATE TYPE job_type AS ENUM ('research', 'generation', 'media', 'rendering', 'validation', 'publishing', 'reconciliation');
CREATE TYPE job_status AS ENUM ('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');

-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255),
  subscription_status VARCHAR(50) DEFAULT 'free',
  subscription_expires_at TIMESTAMP,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connected Accounts (Instagram/Facebook per niche)
CREATE TABLE connected_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  niche_id niche_id NOT NULL,
  platform platform NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) NOT NULL, -- Platform-specific ID
  account_type VARCHAR(50) NOT NULL, -- 'personal', 'professional', 'business'
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMP,
  status account_status DEFAULT 'active',
  last_health_check TIMESTAMP WITH TIME ZONE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(organization_id, niche_id, platform)
);

-- Niche Profiles (branding per niche)
CREATE TABLE niche_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  niche_id niche_id NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  brand_logo_url TEXT, -- Separate logo per niche
  brand_colors JSONB DEFAULT '{"primary": "#FF6B35", "secondary": "#004E89", "accent": "#F7F7FF"}',
  brand_fonts JSONB DEFAULT '{"title": "Poppins", "body": "Inter"}',
  voiceover_preference VARCHAR(100),
  default_music_track VARCHAR(255),
  target_audience TEXT,
  content_pillars TEXT[] DEFAULT '{}',
  prompt_template TEXT, -- Niche-specific LLM prompt
  max_posts_per_day INTEGER DEFAULT 5,
  auto_publish_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(organization_id, niche_id)
);

-- Content Calendar Items (supports multiple per day, different niches)
CREATE TABLE content_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  niche_id niche_id NOT NULL,
  niche_account_id UUID REFERENCES connected_accounts(id),
  sub_topic VARCHAR(255) NOT NULL, -- Content pillar
  data_input_payload JSONB DEFAULT '{}', -- Niche-specific raw data
  hook_variation_a TEXT, -- High-retention opening
  script_body TEXT, -- Full narrative
  visual_reference TEXT, -- Stock tags, URLs
  background_music VARCHAR(255), -- Licensed track ID
  cta_destination TEXT, -- Monetized link
  media_type media_type DEFAULT 'video_reel',
  ai_disclosure_required BOOLEAN DEFAULT false,
  status content_status DEFAULT 'draft',
  trigger_source trigger_source DEFAULT 'calendar',
  trigger_metadata JSONB DEFAULT '{}',
  scheduled_at TIMESTAMP WITH TIME ZONE,
  published_at TIMESTAMP WITH TIME ZONE,
  meta_post_id VARCHAR(255),
  insights_snapshot JSONB,
  validation_errors TEXT[],
  validation_warnings TEXT[],
  rendering_manifest JSONB,
  ai_generation_metadata JSONB,
  music_license_metadata JSONB,
  idempotency_key VARCHAR(255) UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1 -- Optimistic locking
);

-- Index for efficient scheduling queries (multiple items per day per niche)
CREATE INDEX idx_content_items_scheduled_at ON content_items(scheduled_at);
CREATE INDEX idx_content_items_status ON content_items(status);
CREATE INDEX idx_content_items_niche_id ON content_items(niche_id);
CREATE INDEX idx_content_items_niche_account_id ON content_items(niche_account_id);
CREATE INDEX idx_content_items_org_scheduled ON content_items(organization_id, scheduled_at);

-- Jobs (BullMQ tracking)
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_item_id UUID REFERENCES content_items(id) ON DELETE CASCADE,
  niche_id niche_id NOT NULL,
  type job_type NOT NULL,
  status job_status DEFAULT 'waiting',
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  result JSONB,
  error TEXT,
  queue_name VARCHAR(255),
  worker_name VARCHAR(255),
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_jobs_content_item ON jobs(content_item_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);

-- Audit Logs (immutable)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  niche_id niche_id,
  content_item_id UUID,
  job_id UUID,
  action VARCHAR(255) NOT NULL,
  actor VARCHAR(255) NOT NULL,
  actor_type VARCHAR(50) DEFAULT 'user',
  metadata JSONB DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);

-- Authorized Triggers (Telegram/WhatsApp/Omniroute allowlists)
CREATE TABLE authorized_triggers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL, -- 'telegram', 'whatsapp', 'omniroute'
  identity VARCHAR(255) NOT NULL, -- User ID, phone number, or chat ID
  permissions TEXT[] DEFAULT '{}', -- Array of permissions
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(organization_id, platform, identity)
);

-- Niche Prompt Templates (versioned)
CREATE TABLE niche_prompt_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  niche_id niche_id NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  prompt_text TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(niche_id, version)
);

-- Music Library (royalty-free tracks per niche)
CREATE TABLE music_library (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  niche_id niche_id NOT NULL,
  track_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  duration_seconds INTEGER,
  license_type VARCHAR(100), -- 'royalty-free', 'cc-by', etc.
  license_expiry DATE,
  attribution_required TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Row-Level Security Policies
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorized_triggers ENABLE ROW LEVEL SECURITY;

-- RLS: Users can only see their own organization data
CREATE POLICY "Users can view own organization" ON organizations
  FOR SELECT USING (true); -- Add proper auth check

CREATE POLICY "Users can manage own organization" ON organizations
  FOR ALL USING (true); -- Add proper auth check

CREATE POLICY "Accounts scoped to organization" ON connected_accounts
  FOR ALL USING (organization_id IN (SELECT organization_id FROM organizations)); -- Add proper auth

CREATE POLICY "Profiles scoped to organization" ON niche_profiles
  FOR ALL USING (organization_id IN (SELECT organization_id FROM organizations));

CREATE POLICY "Content scoped to organization" ON content_items
  FOR ALL USING (organization_id IN (SELECT organization_id FROM organizations));

CREATE POLICY "Jobs scoped to organization" ON jobs
  FOR ALL USING (content_item_id IN (
    SELECT id FROM content_items WHERE organization_id IN (
      SELECT organization_id FROM organizations
    )
  ));

-- Seed default prompt templates for all niches
INSERT INTO niche_prompt_templates (niche_id, version, prompt_text, description) VALUES
('food', 1,
 'System: You are a friendly, accessible Hindi home-cooking instructor.
Input: Dish: [DISH], Region: [REGION], Cook Time: [TIME], Difficulty: [LEVEL].
Task: Write a 45-second Instagram Reel script with hook, step-by-step breakdown, and CTA.
Constraints: Start with a relatable opening. Use simple Hindi/Hinglish. Show dish in first frame. Break into 3–5 visible steps. End with "Save this recipe!"',
 'Default Hindi food recipe script template'),

('health', 1,
 'System: You are an evidence-based Indian fitness coach with empathy.
Input: Original Dish: [DISH], Transformed Dish: [NEW], Calorie Delta: [CAL], Protein Target: [PRO].
Task: Generate a 50-second video script.
Constraints: Call out a widespread habit first. Replace vague terms with exact calorie numbers. Maintain authentic, encouraging tone. No medical claims.',
 'Default health/diet transformation script template'),

('tech', 1,
 'System: You are an expert growth marketer for Indian tech freelancers.
Input: Tool Name: [TOOL], Feature: [FEATURE], Pain Point: [PAIN], Time Saved: [TIME].
Task: Write a 45-second energetic Reel script.
Constraints: Lead with hard-hitting hook. Use Hinglish (Boss, Jugaad). Keep sentences short for TTS. Direct CTA to bio link.',
 'Default AI tools/productivity script template'),

('edtech', 1,
 'System: You are an elite, results-driven EdTech academic mentor in India.
Input: Exam: [EXAM], Subject/Topic: [TOPIC], Cheat Code/Mnemonic: [HACK], Resource Link: [LINK].
Task: Write a 45-second high-energy educational short script.
Constraints: Lead with urgency. Deliver formula or shortcut with clean steps for overlay. Direct to download cheat sheet.',
 'Default exam prep script template'),

('travel', 1,
 'System: You are a hyper-organized travel curator who values secret spots over mainstream traps.
Input: Location: [PLACE], Base City: [CITY], Travel Duration: [TIME], Per Head Budget: [BUDGET].
Task: Write a highly shareable 50-second travel voiceover script.
Constraints: Heavy curiosity anchor. Exact path and optimal time. Realistic expense breakdown. Drive saves and shares.',
 'Default travel guide script template'),

('cartoon', 1,
 'System: You are a creative animation writer specializing in witty, localized Indian family humor.
Input: Language/Dialect: [DIALECT], Core Theme: [THEME], Characters: [CHARS], Comedic Twist: [TWIST].
Task: Generate a 45-second animated script with visual prompt directions and voiceover dialogue.
Constraints: Precise phonetic local phrasing. Clean, family-friendly humor. Include exact visual descriptions in brackets.',
 'Default AI cartoon/animation script template');

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_connected_accounts_updated_at BEFORE UPDATE ON connected_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_niche_profiles_updated_at BEFORE UPDATE ON niche_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_content_items_updated_at BEFORE UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();