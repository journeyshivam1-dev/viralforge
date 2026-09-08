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
  ai_disclosure_required: boolean;
};

export type QueueSummary = {
  name: string;
  counts: Record<string, number>;
  jobs: Record<string, any[]>;
};
