import { z } from 'zod';
import {
  MediaGenerationKind,
  MediaGenerationRequest,
  MediaProviderAdapter,
  MediaProviderError,
  MediaProviderErrorClassification,
} from './media-adapter';
import { SceneArtifact } from '../schemas/media';

const DEFAULT_API_BASE_URL = 'https://api.replicate.com/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INITIAL_POLL_DELAY_MS = 1_000;
const DEFAULT_MAX_POLL_DELAY_MS = 10_000;

const ReplicateErrorSchema = z.object({
  detail: z.unknown().optional(),
  error: z.unknown().optional(),
}).passthrough();

const PredictionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['starting', 'processing', 'succeeded', 'failed', 'canceled']),
  output: z.unknown().optional(),
  error: z.unknown().nullable().optional(),
  urls: z.object({
    get: z.string().url().optional(),
    cancel: z.string().url().optional(),
  }).passthrough().optional(),
}).passthrough();

type Prediction = z.infer<typeof PredictionSchema>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleep = (delayMs: number) => Promise<void>;

export interface ReplicateModelConfig {
  version: string;
  defaultInput?: Record<string, unknown>;
}

export interface ReplicateAdapterConfig {
  apiToken: string;
  image: ReplicateModelConfig;
  video?: ReplicateModelConfig;
  apiBaseUrl?: string;
  timeoutMs?: number;
  initialPollDelayMs?: number;
  maxPollDelayMs?: number;
}

export interface ReplicateAdapterDependencies {
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
}

export class ReplicateAdapter implements MediaProviderAdapter {
  readonly provider = 'replicate';

  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly initialPollDelayMs: number;
  private readonly maxPollDelayMs: number;
  private readonly fetch: FetchLike;
  private readonly sleep: Sleep;
  private readonly now: () => number;

  constructor(
    private readonly config: ReplicateAdapterConfig,
    dependencies: ReplicateAdapterDependencies = {},
  ) {
    if (!config.apiToken.trim()) {
      throw new MediaProviderError('REPLICATE_API_TOKEN is not configured', 'permanent');
    }
    if (!config.image.version.trim()) {
      throw new MediaProviderError('Replicate image model version is not configured', 'permanent');
    }
    if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
      throw new MediaProviderError('Replicate timeout must be positive', 'permanent');
    }
    if (config.initialPollDelayMs !== undefined && config.initialPollDelayMs <= 0) {
      throw new MediaProviderError('Replicate initial poll delay must be positive', 'permanent');
    }
    if (config.maxPollDelayMs !== undefined && config.maxPollDelayMs <= 0) {
      throw new MediaProviderError('Replicate maximum poll delay must be positive', 'permanent');
    }

    this.apiBaseUrl = (config.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.initialPollDelayMs = config.initialPollDelayMs ?? DEFAULT_INITIAL_POLL_DELAY_MS;
    this.maxPollDelayMs = Math.max(
      this.initialPollDelayMs,
      config.maxPollDelayMs ?? DEFAULT_MAX_POLL_DELAY_MS,
    );
    this.fetch = dependencies.fetch ?? fetch;
    this.sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.now = dependencies.now ?? Date.now;
  }

  async generate(request: MediaGenerationRequest): Promise<SceneArtifact[]> {
    const model = this.modelFor(request.kind);
    const startedAt = this.now();
    const prediction = await this.createPrediction(model, request, startedAt);
    const completed = await this.waitForPrediction(prediction, startedAt);

    if (completed.status === 'failed' || completed.status === 'canceled') {
      throw predictionFailure(completed);
    }

    return normalizeOutput(completed.output, request, completed.id);
  }

  private modelFor(kind: MediaGenerationKind): ReplicateModelConfig {
    if (kind === 'video' && !this.config.video) {
      throw new MediaProviderError('Replicate video generation is not configured', 'permanent');
    }
    return kind === 'video' ? this.config.video! : this.config.image;
  }

  private async createPrediction(
    model: ReplicateModelConfig,
    request: MediaGenerationRequest,
    startedAt: number,
  ): Promise<Prediction> {
    return this.requestPrediction(
      `${this.apiBaseUrl}/predictions`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          version: model.version,
          input: {
            ...model.defaultInput,
            prompt: request.prompt,
            ...(request.negativePrompt === undefined ? {} : { negative_prompt: request.negativePrompt }),
            ...(request.width === undefined ? {} : { width: request.width }),
            ...(request.height === undefined ? {} : { height: request.height }),
            ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
            ...(request.seed === undefined ? {} : { seed: request.seed }),
            ...request.input,
          },
        }),
      },
      startedAt,
    );
  }

  private async waitForPrediction(initial: Prediction, startedAt: number): Promise<Prediction> {
    let prediction = initial;
    let delayMs = this.initialPollDelayMs;

    while (prediction.status === 'starting' || prediction.status === 'processing') {
      const remainingMs = this.remainingMs(startedAt);
      if (remainingMs <= 0) {
        throw timeoutError(this.timeoutMs);
      }
      await this.sleep(Math.min(delayMs, remainingMs));
      if (this.remainingMs(startedAt) <= 0) {
        throw timeoutError(this.timeoutMs);
      }

      const predictionUrl = prediction.urls?.get || `${this.apiBaseUrl}/predictions/${encodeURIComponent(prediction.id)}`;
      prediction = await this.requestPrediction(
        predictionUrl,
        { method: 'GET', headers: this.headers() },
        startedAt,
      );
      delayMs = Math.min(delayMs * 2, this.maxPollDelayMs);
    }

    return prediction;
  }

  private async requestPrediction(url: string, init: RequestInit, startedAt: number): Promise<Prediction> {
    const remainingMs = this.remainingMs(startedAt);
    if (remainingMs <= 0) {
      throw timeoutError(this.timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch (error) {
      if (isAbortError(error) || this.remainingMs(startedAt) <= 0) {
        throw timeoutError(this.timeoutMs, error);
      }
      throw new MediaProviderError('Replicate request failed', 'retryable', { cause: error });
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const detail = errorDetail(payload) || response.statusText || 'Unknown provider error';
      throw new MediaProviderError(
        `Replicate API error (${response.status}): ${detail}`,
        classifyHttpStatus(response.status),
        { status: response.status },
      );
    }

    const parsed = PredictionSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MediaProviderError('Replicate returned an invalid prediction response', 'retryable', {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private remainingMs(startedAt: number): number {
    return Math.max(0, this.timeoutMs - (this.now() - startedAt));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }
}

export function createReplicateAdapter(
  config: ReplicateAdapterConfig,
  dependencies?: ReplicateAdapterDependencies,
): ReplicateAdapter {
  return new ReplicateAdapter(config, dependencies);
}

function normalizeOutput(
  output: unknown,
  request: MediaGenerationRequest,
  predictionId: string,
): SceneArtifact[] {
  const urls = extractHttpUrls(output);
  if (urls.length === 0) {
    throw new MediaProviderError('Replicate prediction succeeded without media output', 'permanent');
  }

  return urls.map((url) => ({
    sceneIndex: request.sceneIndex,
    kind: request.kind,
    url,
    provider: 'replicate',
    providerPredictionId: predictionId,
    ...(request.width === undefined ? {} : { width: request.width }),
    ...(request.height === undefined ? {} : { height: request.height }),
    ...(request.kind !== 'video' || request.durationSeconds === undefined
      ? {}
      : { durationSeconds: request.durationSeconds }),
    metadata: {},
  }));
}

function extractHttpUrls(output: unknown): string[] {
  const candidates: unknown[] = [];
  if (typeof output === 'string') {
    candidates.push(output);
  } else if (Array.isArray(output)) {
    candidates.push(...output);
  } else if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    for (const key of ['url', 'urls', 'output', 'image', 'video']) {
      const value = record[key];
      if (Array.isArray(value)) candidates.push(...value);
      else candidates.push(value);
    }
  }

  return [...new Set(candidates.filter((value): value is string => {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }))];
}

function predictionFailure(prediction: Prediction): MediaProviderError {
  const message = errorDetail(prediction.error) || `Prediction ${prediction.status}`;
  const classification = prediction.status === 'canceled'
    ? 'retryable'
    : classifyProviderMessage(message);
  return new MediaProviderError(
    `Replicate prediction ${prediction.status}: ${message}`,
    classification,
    { providerCode: prediction.status },
  );
}

function classifyHttpStatus(status: number): MediaProviderErrorClassification {
  if (status === 401 || status === 403) return 'blocked';
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return 'retryable';
  }
  return 'permanent';
}

function classifyProviderMessage(message: string): MediaProviderErrorClassification {
  const normalized = message.toLowerCase();
  if (/nsfw|safety|moderation|policy|content filter|blocked|prohibited/.test(normalized)) {
    return 'blocked';
  }
  if (/timeout|timed out|capacity|overload|temporar|try again|rate limit|unavailable/.test(normalized)) {
    return 'retryable';
  }
  return 'permanent';
}

function timeoutError(timeoutMs: number, cause?: unknown): MediaProviderError {
  return new MediaProviderError(
    `Replicate prediction timed out after ${timeoutMs}ms`,
    'retryable',
    { cause },
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    if (response.ok) {
      throw new MediaProviderError('Replicate returned a non-JSON response', 'retryable', { cause: error });
    }
    return text;
  }
}

function errorDetail(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  const parsed = ReplicateErrorSchema.safeParse(value);
  if (!parsed.success) return undefined;
  for (const candidate of [parsed.data.detail, parsed.data.error]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const message = (candidate as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
  }
  return undefined;
}
