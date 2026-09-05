/**
 * Supabase Client Configuration
 * Centralized Supabase client for the monorepo
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials not fully configured');
}

// Client for user-facing operations (with anon key)
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// Admin client for server-side operations (with service role key)
export const supabaseAdmin = supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

// Storage client
export const storage = supabase.storage;

// Database types for TypeScript
export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          email: string;
          stripe_customer_id: string | null;
          subscription_status: string;
          subscription_expires_at: string | null;
          settings: Record<string, any>;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['organizations']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['organizations']['Insert']>;
      };
      connected_accounts: {
        Row: {
          id: string;
          organization_id: string;
          niche_id: string;
          platform: string;
          account_name: string;
          account_id: string;
          account_type: string;
          encrypted_access_token: string;
          encrypted_refresh_token: string | null;
          token_expires_at: string | null;
          status: string;
          last_health_check: string | null;
          metadata: Record<string, any>;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['connected_accounts']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['connected_accounts']['Insert']>;
      };
      niche_profiles: {
        Row: {
          id: string;
          organization_id: string;
          niche_id: string;
          name: string;
          description: string | null;
          brand_logo_url: string | null;
          brand_colors: Record<string, any>;
          brand_fonts: Record<string, any>;
          voiceover_preference: string | null;
          default_music_track: string | null;
          target_audience: string | null;
          content_pillars: string[] | null;
          prompt_template: string | null;
          max_posts_per_day: number;
          auto_publish_enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['niche_profiles']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['niche_profiles']['Insert']>;
      };
      content_items: {
        Row: {
          id: string;
          organization_id: string;
          niche_id: string;
          niche_account_id: string | null;
          sub_topic: string;
          data_input_payload: Record<string, any>;
          hook_variation_a: string | null;
          script_body: string | null;
          visual_reference: string | null;
          background_music: string | null;
          cta_destination: string | null;
          media_type: string;
          ai_disclosure_required: boolean;
          status: string;
          trigger_source: string;
          trigger_metadata: Record<string, any>;
          scheduled_at: string | null;
          published_at: string | null;
          meta_post_id: string | null;
          insights_snapshot: Record<string, any> | null;
          validation_errors: string[] | null;
          validation_warnings: string[] | null;
          rendering_manifest: Record<string, any> | null;
          ai_generation_metadata: Record<string, any> | null;
          music_license_metadata: Record<string, any> | null;
          idempotency_key: string | null;
          created_at: string;
          updated_at: string;
          version: number;
        };
        Insert: Omit<Database['public']['Tables']['content_items']['Row'], 'id' | 'created_at' | 'updated_at' | 'version'>;
        Update: Partial<Database['public']['Tables']['content_items']['Insert']>;
      };
      jobs: {
        Row: {
          id: string;
          content_item_id: string;
          niche_id: string;
          type: string;
          status: string;
          attempts: number;
          max_attempts: number;
          progress: number;
          result: Record<string, any> | null;
          error: string | null;
          queue_name: string | null;
          worker_name: string | null;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['jobs']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['jobs']['Insert']>;
      };
      audit_logs: {
        Row: {
          id: string;
          organization_id: string;
          niche_id: string | null;
          content_item_id: string | null;
          job_id: string | null;
          action: string;
          actor: string;
          actor_type: string;
          metadata: Record<string, any>;
          ip_address: string | null;
          user_agent: string | null;
          timestamp: string;
        };
        Insert: Omit<Database['public']['Tables']['audit_logs']['Row'], 'id' | 'timestamp'>;
        Update: Partial<Database['public']['Tables']['audit_logs']['Insert']>;
      };
      authorized_triggers: {
        Row: {
          id: string;
          organization_id: string;
          platform: string;
          identity: string;
          permissions: string[] | null;
          active: boolean;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['authorized_triggers']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['authorized_triggers']['Insert']>;
      };
      niche_prompt_templates: {
        Row: {
          id: string;
          niche_id: string;
          version: number;
          prompt_text: string;
          description: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['niche_prompt_templates']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['niche_prompt_templates']['Insert']>;
      };
      music_library: {
        Row: {
          id: string;
          niche_id: string;
          track_name: string;
          file_path: string;
          duration_seconds: number | null;
          license_type: string | null;
          license_expiry: string | null;
          attribution_required: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['music_library']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['music_library']['Insert']>;
      };
    };
  };
};