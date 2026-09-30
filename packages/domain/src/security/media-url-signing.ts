/**
 * Short-lived HMAC-signed URLs for the public media edge. Meta's servers fetch
 * rendered media from PUBLIC_MEDIA_BASE_URL (a tunnel or hosted edge); only
 * objects under media/ with a valid, unexpired signature are served.
 */
import crypto from 'crypto';

const PATH_PATTERN = /^media\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}$/;

export class MediaUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUrlError';
  }
}

function signingKey(secret: string | undefined): Buffer {
  if (!secret || secret.length < 32) throw new MediaUrlError('MEDIA_URL_SIGNING_SECRET must be at least 32 characters');
  return Buffer.from(secret, 'utf8');
}

export function isAllowedMediaPath(storagePath: string): boolean {
  return PATH_PATTERN.test(storagePath);
}

function signature(storagePath: string, expiresAt: number, secret: string | undefined): string {
  return crypto.createHmac('sha256', signingKey(secret)).update(`${storagePath}\n${expiresAt}`).digest('base64url');
}

export function signMediaPath(
  storagePath: string,
  ttlSeconds: number,
  options: { baseUrl?: string; secret?: string; now?: number } = {},
): string {
  const baseUrl = options.baseUrl ?? process.env.PUBLIC_MEDIA_BASE_URL;
  if (!baseUrl) throw new MediaUrlError('PUBLIC_MEDIA_BASE_URL is not configured');
  if (!baseUrl.startsWith('https://')) throw new MediaUrlError('PUBLIC_MEDIA_BASE_URL must be https (Meta rejects http media)');
  if (!isAllowedMediaPath(storagePath)) throw new MediaUrlError(`Refusing to sign path outside media/: ${storagePath}`);
  const expiresAt = Math.floor((options.now ?? Date.now()) / 1000) + ttlSeconds;
  const sig = signature(storagePath, expiresAt, options.secret ?? process.env.MEDIA_URL_SIGNING_SECRET);
  return `${baseUrl.replace(/\/$/, '')}/m/${storagePath}?exp=${expiresAt}&sig=${sig}`;
}

export function verifyMediaSignature(
  storagePath: string,
  expiresAt: string | undefined,
  sig: string | undefined,
  options: { secret?: string; now?: number } = {},
): boolean {
  if (!isAllowedMediaPath(storagePath) || !expiresAt || !sig || !/^\d{1,12}$/.test(expiresAt)) return false;
  if (Number(expiresAt) < Math.floor((options.now ?? Date.now()) / 1000)) return false;
  const expected = Buffer.from(signature(storagePath, Number(expiresAt), options.secret ?? process.env.MEDIA_URL_SIGNING_SECRET));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function storagePathFromUrl(url: string, bucket = 'viralforge-content'): string {
  const prefix = `storage://${bucket}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : url;
}
