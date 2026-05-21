import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(encryptionKey: string): Buffer {
  return createHash('sha256').update(encryptionKey, 'utf8').digest();
}

/**
 * Encrypt a plaintext secret (e.g. a Jira PAT) and return a base64-encoded ref
 * that can be stored safely in the database. The raw PAT is never persisted.
 */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Layout: [iv (12)] + [tag (16)] + [ciphertext]
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a base64-encoded secret ref (as stored in encryptedSecretRef) back
 * to the original plaintext.
 */
export function decryptSecret(encryptedRef: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const buf = Buffer.from(encryptedRef, 'base64');

  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}

/**
 * Remove known credential fields from an object before logging or returning it
 * in an API response. Operates on a shallow copy; nested credential fields are
 * the caller's responsibility.
 */
export function redactCredentials<T extends Record<string, unknown>>(obj: T): Omit<T, 'pat' | 'token' | 'secret' | 'password'> {
  const copy = { ...obj };
  delete (copy as Record<string, unknown>)['pat'];
  delete (copy as Record<string, unknown>)['token'];
  delete (copy as Record<string, unknown>)['secret'];
  delete (copy as Record<string, unknown>)['password'];
  return copy;
}

/**
 * Return a log-safe representation of a secret value, showing only the last
 * `visibleChars` characters and replacing the rest with asterisks.
 *
 * Used to confirm a PAT was received without persisting the plaintext value in
 * application logs.
 *
 * @example maskSecret('mysecrettoken1234') → '****4'
 */
export function maskSecret(value: string, visibleChars = 4): string {
  if (value.length === 0) return '****';
  const visible = value.slice(-visibleChars);
  return `****${visible}`;
}
