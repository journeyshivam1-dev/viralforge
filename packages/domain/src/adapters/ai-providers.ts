/**
 * AI provider chain: Omniroute first, Gemini fallback (Replicate optional for images).
 * Every capability returns bytes, not provider URLs, so storage and rendering
 * never depend on short-lived provider links.
 *
 * Errors use MediaProviderError classifications:
 *   blocked   - provider not configured / auth rejected -> try next, block if all blocked
 *   retryable - timeout, 429, 5xx, network              -> try next, stage retries later
 *   permanent - request rejected (400/404/422, safety)  -> try next, fail if all permanent
 */
import { MediaProviderError, MediaProviderErrorClassification } from './media-adapter';
import { ReplicateAdapter } from './replicate-adapter';

export type AiCapability = 'text' | 'image' | 'speech' | 'video';

export interface TextGenerationInput {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

export interface TextGenerationOutput {
  text: string;
  provider: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface ImageGenerationInput {
  prompt: string;
  negativePrompt?: string;
  /** Target aspect; providers map to their closest supported size. */
  aspectRatio: '9:16' | '4:5' | '1:1';
}

export interface SpeechGenerationInput {
  text: string;
  /** BCP-47, e.g. hi-IN. */
  language: string;
  voice?: string;
}

export interface VideoGenerationInput {
  prompt: string;
  durationSeconds: number;
  aspectRatio: '9:16';
}

export interface BinaryOutput {
  buffer: Buffer;
  mimeType: string;
  provider: string;
  model: string;
}

export interface AiProvider {
  readonly name: string;
  supports(capability: AiCapability): boolean;
  generateText?(input: TextGenerationInput): Promise<TextGenerationOutput>;
  generateImage?(input: ImageGenerationInput): Promise<BinaryOutput>;
  generateSpeech?(input: SpeechGenerationInput): Promise<BinaryOutput>;
  generateVideo?(input: VideoGenerationInput): Promise<BinaryOutput>;
}

const MAX_BINARY_BYTES = 50 * 1024 * 1024;

export function classifyHttpStatus(status: number): MediaProviderErrorClassification {
  if (status === 401 || status === 403) return 'blocked';
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return 'retryable';
  return 'permanent';
}

function classifyThrown(error: unknown): MediaProviderError {
  if (error instanceof MediaProviderError) return error;
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new MediaProviderError(`Request timed out: ${message}`, 'retryable', { providerCode: 'TIMEOUT', cause: error });
  }
  // fetch() network failures surface as TypeError('fetch failed').
  return new MediaProviderError(message, 'retryable', { providerCode: 'NETWORK', cause: error });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

async function httpError(provider: string, response: Response): Promise<MediaProviderError> {
  const body = await readJson<{ error?: { message?: string; status?: string } | string; message?: string }>(response);
  const detail = typeof body.error === 'string' ? body.error : body.error?.message || body.message || response.statusText;
  return new MediaProviderError(
    `${provider} request failed (${response.status}): ${String(detail).slice(0, 300)}`,
    classifyHttpStatus(response.status),
    { status: response.status, providerCode: `${provider.toUpperCase()}_HTTP_${response.status}` },
  );
}

/** Downloads a provider-hosted binary with size and scheme limits. */
export async function downloadBinary(url: string, timeoutMs = 60_000, maxBytes = MAX_BINARY_BYTES): Promise<{ buffer: Buffer; mimeType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new MediaProviderError(`Unsupported download scheme ${parsed.protocol}`, 'permanent');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw await httpError('download', response);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new MediaProviderError('Download exceeds size limit', 'permanent');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new MediaProviderError('Download exceeds size limit', 'permanent');
  const mimeType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  return { buffer, mimeType };
}

/** Wraps raw 16-bit little-endian mono PCM in a WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate = 24_000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function notConfigured(provider: string, capability: AiCapability, setting: string): MediaProviderError {
  return new MediaProviderError(
    `${provider} ${capability} is not configured: set ${setting}`,
    'blocked',
    { providerCode: `${provider.toUpperCase()}_${capability.toUpperCase()}_NOT_CONFIGURED` },
  );
}

// ---------------------------------------------------------------------------
// Omniroute (OpenAI-compatible gateway)
// ---------------------------------------------------------------------------

export interface OmnirouteProviderConfig {
  baseUrl: string;
  apiKey?: string;
  textModel?: string;
  imageModel?: string;
  speechModel?: string;
  speechVoice?: string;
  videoModel?: string;
  /** Path under baseUrl for video generation, e.g. /v1/videos/generations. */
  videoPath?: string;
  textTimeoutMs?: number;
  imageTimeoutMs?: number;
  speechTimeoutMs?: number;
  videoTimeoutMs?: number;
  videoPollIntervalMs?: number;
}

const OMNIROUTE_SIZES: Record<ImageGenerationInput['aspectRatio'], string> = {
  '9:16': '1024x1792',
  '4:5': '1024x1280',
  '1:1': '1024x1024',
};

export class OmnirouteProvider implements AiProvider {
  readonly name = 'omniroute';

  constructor(private readonly config: OmnirouteProviderConfig) {}

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' };
  }

  supports(capability: AiCapability): boolean {
    if (!this.config.apiKey) return false;
    if (capability === 'text') return true;
    if (capability === 'image') return Boolean(this.config.imageModel);
    if (capability === 'speech') return Boolean(this.config.speechModel);
    return Boolean(this.config.videoModel && this.config.videoPath);
  }

  async generateText(input: TextGenerationInput): Promise<TextGenerationOutput> {
    if (!this.config.apiKey) throw notConfigured(this.name, 'text', 'OMNIROUTE_API_KEY');
    const model = this.config.textModel || 'auto/best-chat';
    try {
      const response = await fetch(this.url('/v1/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }],
          temperature: input.temperature ?? 0.7,
          max_tokens: input.maxTokens ?? 4000,
          ...(input.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(this.config.textTimeoutMs ?? 300_000),
      });
      if (!response.ok) throw await httpError(this.name, response);
      const payload = await readJson<{
        model?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      }>(response);
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) throw new MediaProviderError('Omniroute returned an empty completion', 'retryable', { providerCode: 'EMPTY_COMPLETION' });
      return {
        text,
        provider: this.name,
        model: payload.model || model,
        usage: payload.usage && {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
        },
      };
    } catch (error) {
      throw classifyThrown(error);
    }
  }

  async generateImage(input: ImageGenerationInput): Promise<BinaryOutput> {
    if (!this.supports('image')) throw notConfigured(this.name, 'image', 'OMNIROUTE_API_KEY and OMNIROUTE_IMAGE_MODEL');
    const model = this.config.imageModel as string;
    try {
      const response = await fetch(this.url('/v1/images/generations'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model,
          prompt: input.negativePrompt ? `${input.prompt}\n\nAvoid: ${input.negativePrompt}` : input.prompt,
          n: 1,
          size: OMNIROUTE_SIZES[input.aspectRatio],
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(this.config.imageTimeoutMs ?? 180_000),
      });
      if (!response.ok) throw await httpError(this.name, response);
      const payload = await readJson<{ data?: Array<{ b64_json?: string; url?: string }> }>(response);
      const first = payload.data?.[0];
      if (first?.b64_json) {
        return { buffer: Buffer.from(first.b64_json, 'base64'), mimeType: 'image/png', provider: this.name, model };
      }
      if (first?.url) {
        const { buffer, mimeType } = await downloadBinary(first.url);
        return { buffer, mimeType, provider: this.name, model };
      }
      throw new MediaProviderError('Omniroute image response contained no image', 'retryable', { providerCode: 'EMPTY_IMAGE' });
    } catch (error) {
      throw classifyThrown(error);
    }
  }

  async generateSpeech(input: SpeechGenerationInput): Promise<BinaryOutput> {
    if (!this.supports('speech')) throw notConfigured(this.name, 'speech', 'OMNIROUTE_API_KEY and OMNIROUTE_TTS_MODEL');
    const model = this.config.speechModel as string;
    try {
      const response = await fetch(this.url('/v1/audio/speech'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model,
          input: input.text,
          voice: input.voice || this.config.speechVoice || 'alloy',
          response_format: 'mp3',
          language: input.language,
        }),
        signal: AbortSignal.timeout(this.config.speechTimeoutMs ?? 120_000),
      });
      if (!response.ok) throw await httpError(this.name, response);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new MediaProviderError('Omniroute returned empty audio', 'retryable', { providerCode: 'EMPTY_AUDIO' });
      const mimeType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
      return { buffer, mimeType, provider: this.name, model };
    } catch (error) {
      throw classifyThrown(error);
    }
  }

  /**
   * Video endpoints on the gateway are slow; a synchronous request is what timed
   * out before. This supports both shapes: an immediate result, or a job id that
   * is polled at `${videoPath}/{id}` until completed or videoTimeoutMs elapses.
   */
  async generateVideo(input: VideoGenerationInput): Promise<BinaryOutput> {
    if (!this.supports('video')) throw notConfigured(this.name, 'video', 'OMNIROUTE_VIDEO_MODEL and OMNIROUTE_VIDEO_PATH');
    const model = this.config.videoModel as string;
    const path = this.config.videoPath as string;
    const deadline = Date.now() + (this.config.videoTimeoutMs ?? 600_000);
    try {
      const response = await fetch(this.url(path), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, prompt: input.prompt, duration: input.durationSeconds, aspect_ratio: input.aspectRatio }),
        // Submission itself should be quick; polling carries the long wait.
        signal: AbortSignal.timeout(Math.min(120_000, this.config.videoTimeoutMs ?? 600_000)),
      });
      if (!response.ok) throw await httpError(this.name, response);
      let job = await readJson<VideoJobPayload>(response);
      while (!videoUrlOf(job) && !isVideoFailed(job)) {
        if (!job.id) throw new MediaProviderError('Omniroute video response had neither a result nor a job id', 'permanent', { providerCode: 'VIDEO_SHAPE' });
        if (Date.now() > deadline) throw new MediaProviderError('Omniroute video generation timed out while polling', 'retryable', { providerCode: 'VIDEO_TIMEOUT' });
        await new Promise((resolve) => setTimeout(resolve, this.config.videoPollIntervalMs ?? 10_000));
        const poll = await fetch(this.url(`${path.replace(/\/$/, '')}/${encodeURIComponent(job.id)}`), {
          headers: this.headers(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!poll.ok) throw await httpError(this.name, poll);
        job = await readJson<VideoJobPayload>(poll);
      }
      if (isVideoFailed(job)) {
        throw new MediaProviderError(`Omniroute video failed: ${job.error?.message || job.status}`, 'retryable', { providerCode: 'VIDEO_FAILED' });
      }
      const { buffer, mimeType } = await downloadBinary(videoUrlOf(job) as string, 120_000);
      return { buffer, mimeType, provider: this.name, model };
    } catch (error) {
      throw classifyThrown(error);
    }
  }
}

interface VideoJobPayload {
  id?: string;
  status?: string;
  url?: string;
  video_url?: string;
  data?: Array<{ url?: string }>;
  output?: { url?: string } | string;
  error?: { message?: string };
}

function videoUrlOf(job: VideoJobPayload): string | undefined {
  if (typeof job.output === 'string') return job.output;
  return job.url || job.video_url || job.data?.[0]?.url || job.output?.url;
}

function isVideoFailed(job: VideoJobPayload): boolean {
  return ['failed', 'error', 'cancelled', 'canceled'].includes(String(job.status || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// Gemini (Google Generative Language API)
// ---------------------------------------------------------------------------

export interface GeminiProviderConfig {
  apiKey?: string;
  textModel?: string;
  imageModel?: string;
  speechModel?: string;
  speechVoice?: string;
  timeoutMs?: number;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';

  constructor(private readonly config: GeminiProviderConfig) {}

  supports(capability: AiCapability): boolean {
    if (!this.config.apiKey) return false;
    return capability !== 'video';
  }

  private async call(model: string, method: 'generateContent' | 'predict', body: unknown, timeoutMs?: number): Promise<GeminiResponse> {
    if (!this.config.apiKey) throw notConfigured(this.name, 'text', 'GEMINI_API_KEY');
    try {
      const response = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:${method}`, {
        method: 'POST',
        // Key in a header, never in the URL, so it cannot leak into logs.
        headers: { 'x-goog-api-key': this.config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs ?? 180_000),
      });
      if (!response.ok) throw await httpError(this.name, response);
      const payload = await readJson<GeminiResponse>(response);
      if (payload.promptFeedback?.blockReason) {
        throw new MediaProviderError(`Gemini blocked the prompt: ${payload.promptFeedback.blockReason}`, 'permanent', { providerCode: 'GEMINI_SAFETY' });
      }
      return payload;
    } catch (error) {
      throw classifyThrown(error);
    }
  }

  async generateText(input: TextGenerationInput): Promise<TextGenerationOutput> {
    const model = this.config.textModel || 'gemini-2.5-flash';
    const payload = await this.call(model, 'generateContent', {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: 'user', parts: [{ text: input.user }] }],
      generationConfig: {
        temperature: input.temperature ?? 0.7,
        maxOutputTokens: input.maxTokens ?? 8000,
        ...(input.json ? { responseMimeType: 'application/json' } : {}),
      },
    });
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
    if (!text) throw new MediaProviderError('Gemini returned an empty completion', 'retryable', { providerCode: 'EMPTY_COMPLETION' });
    return {
      text,
      provider: this.name,
      model,
      usage: {
        promptTokens: payload.usageMetadata?.promptTokenCount,
        completionTokens: payload.usageMetadata?.candidatesTokenCount,
        totalTokens: payload.usageMetadata?.totalTokenCount,
      },
    };
  }

  async generateImage(input: ImageGenerationInput): Promise<BinaryOutput> {
    const model = this.config.imageModel || 'gemini-2.5-flash-image';
    const prompt = input.negativePrompt ? `${input.prompt}\n\nAvoid: ${input.negativePrompt}` : input.prompt;
    if (model.startsWith('imagen')) {
      const payload = await this.call(model, 'predict', {
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: input.aspectRatio === '4:5' ? '3:4' : input.aspectRatio },
      });
      const prediction = payload.predictions?.[0];
      if (!prediction?.bytesBase64Encoded) throw new MediaProviderError('Imagen returned no image', 'retryable', { providerCode: 'EMPTY_IMAGE' });
      return { buffer: Buffer.from(prediction.bytesBase64Encoded, 'base64'), mimeType: prediction.mimeType || 'image/png', provider: this.name, model };
    }
    const payload = await this.call(model, 'generateContent', {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: input.aspectRatio } },
    });
    const image = payload.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
    if (!image?.inlineData?.data) throw new MediaProviderError('Gemini returned no image', 'retryable', { providerCode: 'EMPTY_IMAGE' });
    return { buffer: Buffer.from(image.inlineData.data, 'base64'), mimeType: image.inlineData.mimeType || 'image/png', provider: this.name, model };
  }

  async generateSpeech(input: SpeechGenerationInput): Promise<BinaryOutput> {
    const model = this.config.speechModel || 'gemini-2.5-flash-preview-tts';
    const payload = await this.call(model, 'generateContent', {
      contents: [{ role: 'user', parts: [{ text: input.text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: input.language,
          voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice || this.config.speechVoice || 'Kore' } },
        },
      },
    });
    const audio = payload.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
    if (!audio?.inlineData?.data) throw new MediaProviderError('Gemini returned no audio', 'retryable', { providerCode: 'EMPTY_AUDIO' });
    const raw = Buffer.from(audio.inlineData.data, 'base64');
    const mime = audio.inlineData.mimeType || '';
    // Gemini TTS returns raw PCM (audio/L16;rate=24000); wrap it so ffmpeg can read it.
    if (mime.startsWith('audio/L16') || mime.includes('pcm')) {
      const rate = Number(/rate=(\d+)/.exec(mime)?.[1] || 24_000);
      return { buffer: pcmToWav(raw, rate), mimeType: 'audio/wav', provider: this.name, model };
    }
    return { buffer: raw, mimeType: mime || 'audio/wav', provider: this.name, model };
  }
}

// ---------------------------------------------------------------------------
// Replicate (optional last-resort image provider)
// ---------------------------------------------------------------------------

const REPLICATE_SIZES: Record<ImageGenerationInput['aspectRatio'], { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
};

export class ReplicateImageProvider implements AiProvider {
  readonly name = 'replicate';

  constructor(private readonly adapter: ReplicateAdapter, private readonly model: string) {}

  supports(capability: AiCapability): boolean {
    return capability === 'image';
  }

  async generateImage(input: ImageGenerationInput): Promise<BinaryOutput> {
    const artifacts = await this.adapter.generate({
      sceneIndex: 1,
      kind: 'image',
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      ...REPLICATE_SIZES[input.aspectRatio],
    });
    const first = artifacts[0];
    if (!first) throw new MediaProviderError('Replicate returned no image', 'retryable', { providerCode: 'EMPTY_IMAGE' });
    const { buffer, mimeType } = await downloadBinary(first.url);
    return { buffer, mimeType, provider: this.name, model: this.model };
  }
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export interface ChainAttempt {
  provider: string;
  classification: MediaProviderErrorClassification;
  message: string;
}

export class ProviderChainError extends MediaProviderError {
  readonly attempts: ChainAttempt[];

  constructor(capability: AiCapability, attempts: ChainAttempt[]) {
    const classification: MediaProviderErrorClassification = attempts.some((a) => a.classification === 'retryable')
      ? 'retryable'
      : attempts.every((a) => a.classification === 'blocked') ? 'blocked' : 'permanent';
    const summary = attempts.length === 0
      ? `No provider is configured for ${capability}`
      : attempts.map((a) => `${a.provider}: ${a.message}`).join(' | ');
    super(`All ${capability} providers failed: ${summary}`, attempts.length === 0 ? 'blocked' : classification, {
      providerCode: `${capability.toUpperCase()}_PROVIDERS_EXHAUSTED`,
    });
    this.attempts = attempts;
  }
}

export class AiProviderChain {
  constructor(private readonly providers: AiProvider[]) {}

  providersFor(capability: AiCapability): string[] {
    return this.providers.filter((provider) => provider.supports(capability)).map((provider) => provider.name);
  }

  private async run<T>(capability: AiCapability, call: (provider: AiProvider) => Promise<T> | undefined): Promise<T & { fallbackAttempts: ChainAttempt[] }> {
    const attempts: ChainAttempt[] = [];
    for (const provider of this.providers) {
      if (!provider.supports(capability)) continue;
      try {
        const result = await call(provider);
        if (result === undefined) continue;
        return Object.assign(result as object, { fallbackAttempts: attempts }) as T & { fallbackAttempts: ChainAttempt[] };
      } catch (error) {
        const classified = classifyThrown(error);
        attempts.push({ provider: provider.name, classification: classified.classification, message: classified.message.slice(0, 300) });
      }
    }
    throw new ProviderChainError(capability, attempts);
  }

  generateText(input: TextGenerationInput) {
    return this.run('text', (provider) => provider.generateText?.(input));
  }

  generateImage(input: ImageGenerationInput) {
    return this.run('image', (provider) => provider.generateImage?.(input));
  }

  generateSpeech(input: SpeechGenerationInput) {
    return this.run('speech', (provider) => provider.generateSpeech?.(input));
  }

  generateVideo(input: VideoGenerationInput) {
    return this.run('video', (provider) => provider.generateVideo?.(input));
  }
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createAiProviderChainFromEnv(env: NodeJS.ProcessEnv = process.env): AiProviderChain {
  const replicateToken = env.REPLICATE_API_TOKEN?.trim();
  const replicateImage = env.REPLICATE_IMAGE_MODEL_VERSION?.trim();
  const replicate = replicateToken && replicateImage
    ? [new ReplicateImageProvider(
        new ReplicateAdapter({ apiToken: replicateToken, image: { version: replicateImage }, timeoutMs: numberEnv(env.REPLICATE_TIMEOUT_MS, 120_000) }),
        replicateImage,
      )]
    : [];
  return new AiProviderChain([
    new OmnirouteProvider({
      baseUrl: env.OMNIROUTE_BASE_URL || 'http://localhost:20128',
      apiKey: env.OMNIROUTE_API_KEY?.trim() || undefined,
      textModel: env.OMNIROUTE_TEXT_MODEL?.trim() || undefined,
      imageModel: env.OMNIROUTE_IMAGE_MODEL?.trim() || undefined,
      speechModel: env.OMNIROUTE_TTS_MODEL?.trim() || undefined,
      speechVoice: env.OMNIROUTE_TTS_VOICE?.trim() || undefined,
      videoModel: env.OMNIROUTE_VIDEO_MODEL?.trim() || undefined,
      videoPath: env.OMNIROUTE_VIDEO_PATH?.trim() || undefined,
      textTimeoutMs: numberEnv(env.OMNIROUTE_TIMEOUT_MS, 300_000),
      imageTimeoutMs: numberEnv(env.OMNIROUTE_IMAGE_TIMEOUT_MS, 180_000),
      speechTimeoutMs: numberEnv(env.OMNIROUTE_TTS_TIMEOUT_MS, 120_000),
      videoTimeoutMs: numberEnv(env.OMNIROUTE_VIDEO_TIMEOUT_MS, 600_000),
    }),
    new GeminiProvider({
      apiKey: env.GEMINI_API_KEY?.trim() || undefined,
      textModel: env.GEMINI_TEXT_MODEL?.trim() || undefined,
      imageModel: env.GEMINI_IMAGE_MODEL?.trim() || undefined,
      speechModel: env.GEMINI_TTS_MODEL?.trim() || undefined,
      speechVoice: env.GEMINI_TTS_VOICE?.trim() || undefined,
      timeoutMs: numberEnv(env.GEMINI_TIMEOUT_MS, 180_000),
    }),
    ...replicate,
  ]);
}
