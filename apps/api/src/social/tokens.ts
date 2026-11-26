// Opaque invitation tokens: 256 random bits (base64url, 43 chars). Only SHA-256(token) is ever stored or logged.
import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_BYTES = 32;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const newToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
export const looksLikeToken = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v);
