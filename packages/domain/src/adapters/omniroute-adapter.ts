import { NicheId } from '../schemas/content-item';

export interface OmnirouteConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
  timeoutMs: number;
  textModel?: string;
  imageModel?: string;
  videoModel?: string;
}

export interface OmnirouteMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OmnirouteTextRequest {
  messages: OmnirouteMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
}

export interface OmnirouteTextResponse {
  id: string;
  model: string;
  content: string;
  finishReason: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  raw: Record<string, unknown>;
}

interface OpenAICompatibleResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

export interface OmnirouteRequest {
  type: 'text' | 'image' | 'video';
  prompt: string;
  niche: NicheId;
  parameters?: Record<string, unknown>;
  callbackUrl?: string;
}

export interface OmnirouteResponse {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: {
    text?: string;
    imageUrl?: string;
    videoUrl?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OmnirouteModel {
  id: string;
  ownedBy?: string;
  capabilities?: Record<string, boolean>;
}

export class OmnirouteAdapter {
  private readonly config: OmnirouteConfig;

  constructor(config: OmnirouteConfig) {
    this.config = config;
  }

  private get apiBase(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async generateText(request: OmnirouteTextRequest): Promise<OmnirouteTextResponse> {
    if (!this.config.apiKey) {
      throw new Error('OMNIROUTE_API_KEY is not configured');
    }

    const response = await fetch(`${this.apiBase}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: request.model || this.config.textModel || 'auto/best-chat',
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 4000,
        ...(request.responseFormat === 'json_object'
          ? { response_format: { type: 'json_object' } }
          : {}),
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    const payload = (await response.json().catch(() => ({}))) as OpenAICompatibleResponse;
    if (!response.ok) {
      throw new Error(`Omniroute API error (${response.status}): ${payload.error?.message || response.statusText}`);
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      throw new Error('Omniroute returned an empty completion');
    }

    return {
      id: payload.id || `omniroute-${Date.now()}`,
      model: payload.model || request.model || this.config.textModel || 'auto/best-chat',
      content,
      finishReason: choice?.finish_reason || null,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
      raw: payload as Record<string, unknown>,
    };
  }

  /**
   * Backward-compatible entry point. Text generation uses the verified
   * OpenAI-compatible Omniroute API. Image/video calls require configured
   * provider endpoints and deliberately fail instead of returning fake media.
   */
  async generateContent(request: OmnirouteRequest): Promise<OmnirouteResponse> {
    const now = new Date().toISOString();

    if (request.type !== 'text') {
      return {
        id: `unsupported-${Date.now()}`,
        status: 'failed',
        error: `The running Omniroute gateway has not advertised a verified ${request.type} generation endpoint`,
        createdAt: now,
        updatedAt: now,
      };
    }

    try {
      const result = await this.generateText({
        model: typeof request.parameters?.model === 'string' ? request.parameters.model : undefined,
        messages: [
          {
            role: 'system',
            content: `You create accurate, engaging ${request.niche} content for an Indian audience.`,
          },
          { role: 'user', content: request.prompt },
        ],
        temperature: typeof request.parameters?.temperature === 'number'
          ? request.parameters.temperature
          : undefined,
        maxTokens: typeof request.parameters?.maxTokens === 'number'
          ? request.parameters.maxTokens
          : undefined,
      });

      return {
        id: result.id,
        status: 'completed',
        result: {
          text: result.content,
          metadata: { model: result.model, usage: result.usage },
        },
        createdAt: now,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        id: `error-${Date.now()}`,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        createdAt: now,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async getModels(): Promise<OmnirouteModel[]> {
    if (!this.config.apiKey) return [];

    const response = await fetch(`${this.apiBase}/v1/models`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 10000)),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Omniroute models (${response.status})`);
    }

    const payload = (await response.json()) as {
      data?: Array<{
        id: string;
        owned_by?: string;
        capabilities?: Record<string, boolean>;
      }>;
    };

    return (payload.data || []).map((model) => ({
      id: model.id,
      ownedBy: model.owned_by,
      capabilities: model.capabilities,
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBase}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getCapabilities(_niche: NicheId): Promise<Record<string, unknown>> {
    try {
      const models = await this.getModels();
      return {
        text: models.length > 0,
        image: false,
        video: false,
        models,
      };
    } catch {
      return {};
    }
  }
}

export function createOmnirouteAdapter(
  baseUrl: string,
  apiKey: string,
  webhookSecret: string,
  timeoutMs = 300000,
  options: Pick<OmnirouteConfig, 'textModel' | 'imageModel' | 'videoModel'> = {},
): OmnirouteAdapter {
  return new OmnirouteAdapter({
    baseUrl,
    apiKey,
    webhookSecret,
    timeoutMs,
    ...options,
  });
}

export default OmnirouteAdapter;
