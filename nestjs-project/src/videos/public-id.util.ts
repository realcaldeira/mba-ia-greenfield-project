import { randomBytes } from 'node:crypto';

const PUBLIC_ID_BYTES = 8;

// 8 random bytes encode to exactly 11 base64url characters, without padding.
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
