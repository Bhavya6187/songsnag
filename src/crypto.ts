import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption for Spotify tokens at rest: AES-256-GCM with a fresh nonce per
 * value. The key is TOKEN_ENCRYPTION_KEY, 32 random bytes in base64.
 */

const VERSION = 'v1';

export type TokenCipher = {
  encrypt(plain: string): string;
  /** Throws if the value was tampered with or encrypted under another key. */
  decrypt(sealed: string): string;
};

/** Returns the 32-byte key, or null if `text` is not 32 bytes of base64. */
export function parseEncryptionKey(text: string): Buffer | null {
  const key = Buffer.from(text, 'base64');
  return key.length === 32 ? key : null;
}

export function createTokenCipher(key: Buffer): TokenCipher {
  if (key.length !== 32) throw new Error('The token encryption key must be 32 bytes.');
  return {
    encrypt(plain) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [VERSION, nonce, cipher.getAuthTag(), body]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.');
    },
    decrypt(sealed) {
      const [version, nonce, tag, body] = sealed.split('.');
      if (version !== VERSION || nonce === undefined || tag === undefined || body === undefined) {
        throw new Error('Not a value sealed by this server.');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

/** A URL-safe random token with 256 bits of entropy. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Link tokens are stored as this hash, so a copy of the database cannot be used to link. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
