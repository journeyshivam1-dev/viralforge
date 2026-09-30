/**
 * AES-256-GCM encryption for third-party access tokens at rest.
 * Key: TOKEN_ENCRYPTION_KEY, 32 random bytes, base64. Locally it lives in .env;
 * in hosted environments it comes from the secret manager.
 * Format: v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>
 */
import crypto from 'crypto';

const VERSION = 'v1';

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

export function loadTokenKey(raw: string | undefined = process.env.TOKEN_ENCRYPTION_KEY): Buffer {
  if (!raw) throw new TokenCryptoError('TOKEN_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new TokenCryptoError('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer = loadTokenKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}

export function decryptSecret(value: string, key: Buffer = loadTokenKey()): string {
  if (!isEncryptedSecret(value)) {
    // Fail closed: plaintext tokens from older builds must be reconnected.
    throw new TokenCryptoError('Stored token is not encrypted; reconnect the account');
  }
  const [, iv, tag, data] = value.split('.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenCryptoError('Stored token could not be decrypted (wrong key or tampered value)');
  }
}
