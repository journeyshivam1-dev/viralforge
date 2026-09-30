export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export type ContentItem = {
  id: string;
  niche_id: string;
  sub_topic: string;
  status: string;
  media_type: string;
  scheduled_at: string | null;
  created_at: string;
  hook_variation_a: string | null;
  script_body: string | null;
  data_input_payload: Record<string, any>;
  validation_errors: string[] | null;
  validation_warnings: string[] | null;
  ai_generation_metadata: Record<string, any> | null;
  rendering_manifest?: Record<string, any> | null;
  publish_mode?: 'manual_approval' | 'immediate_auto' | 'scheduled';
  approval_status?: 'not_required' | 'pending' | 'approved' | 'rejected';
  ai_disclosure_required: boolean;
};

export type PipelineAttempt = {
  id: string;
  stage: string;
  attempt_no: number;
  status: string;
  error?: { message?: string; code?: string } | null;
  created_at: string;
};

export type PipelineArtifact = {
  id: string;
  stage: string;
  artifact_type: string;
  storage_path?: string | null;
  metadata?: Record<string, any>;
};

export type PipelineRun = {
  id: string;
  status: string;
  current_stage: string;
  waiting_reason?: string | null;
  error?: { message?: string; code?: string } | null;
  stage_attempts: PipelineAttempt[];
  pipeline_artifacts: PipelineArtifact[];
  created_at: string;
};

export type QueueSummary = {
  name: string;
  counts: Record<string, number>;
  jobs: Record<string, any[]>;
};

export type JobDetail = {
  id: string;
  name: string;
  data: Record<string, any>;
  progress: number;
  failedReason?: string;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
  state?: string;
};
