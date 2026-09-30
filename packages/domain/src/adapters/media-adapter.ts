import { SceneArtifact } from '../schemas/media';

export type MediaGenerationKind = 'image' | 'video';

export interface MediaGenerationRequest {
  sceneIndex: number;
  kind: MediaGenerationKind;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  seed?: number;
  input?: Record<string, unknown>;
}

export interface MediaProviderAdapter {
  readonly provider: string;
  generate(request: MediaGenerationRequest): Promise<SceneArtifact[]>;
}

export type MediaProviderErrorClassification = 'blocked' | 'retryable' | 'permanent';

export interface MediaProviderErrorOptions {
  status?: number;
  providerCode?: string;
  cause?: unknown;
}

export class MediaProviderError extends Error {
  readonly classification: MediaProviderErrorClassification;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(
    message: string,
    classification: MediaProviderErrorClassification,
    options: MediaProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'MediaProviderError';
    this.classification = classification;
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}
