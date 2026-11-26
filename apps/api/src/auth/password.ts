// Password hashing with Node's built-in scrypt (no native dependency). Format: scrypt$N$r$p$saltB64$hashB64 — parameters travel with the hash so they can be raised later.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;
const run = (pw: string, salt: Buffer, n: number, r: number, p: number, len: number) =>
  new Promise<Buffer>((res, rej) => scrypt(pw.normalize('NFKC'), salt, len, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${(await run(pw, salt, N, R, P, KEYLEN)).toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [tag, n, r, p, salt, hash] = stored.split('$');
  if (tag !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const N2 = Number(n), R2 = Number(r), P2 = Number(p);
  if (![N2, R2, P2].every(Number.isInteger) || N2 > 1 << 20 || R2 > 32 || P2 > 16) return false; // never let a stored value drive unbounded work
  const want = Buffer.from(hash, 'base64'); if (want.length < 16) return false;
  const got = await run(pw, Buffer.from(salt, 'base64'), N2, R2, P2, want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}
