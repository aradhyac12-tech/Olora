// Small in-process fixed-window limiter used for the relationship API (per user, per IP, and failed-token lockouts).
// Single-process by design (one Render instance). With several instances each keeps its own counters, so the DB-backed quotas
// in the services (invitations/day, reports/day, open pending requests) remain the hard ceiling. Documented in docs/threat-model.md.
export interface RateDecision { ok: boolean; retryAfterMs: number }

export class RateLimiter {
  private readonly buckets = new Map<string, { n: number; resetAt: number }>();
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }

  /** Count one event for `key`. ok=false once more than `max` events happened in the current `windowMs` window. */
  hit(key: string, max: number, windowMs: number): RateDecision {
    const t = this.now();
    if (this.buckets.size > 50_000) this.prune(t);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= t) { this.buckets.set(key, { n: 1, resetAt: t + windowMs }); return { ok: max >= 1, retryAfterMs: 0 }; }
    b.n++;
    return b.n <= max ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: b.resetAt - t };
  }
  /** Read-only: is `key` already over `max`? (for lockouts that only COUNT failures) */
  blocked(key: string, max: number): boolean {
    const b = this.buckets.get(key);
    return !!b && b.resetAt > this.now() && b.n >= max;
  }
  private prune(t: number): void { for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k); }
  get size(): number { return this.buckets.size; }
}

export interface Limits {
  /** state-changing relationship calls, per user per minute */ mutateUser: number;
  /** token-bearing calls (preview/accept/decline/search-by-link/report-by-token), per user per minute */ tokenUser: number;
  /** same, per client IP per minute */ tokenIp: number;
  /** FAILED token lookups tolerated per user and per IP per 15 minutes before the caller is locked out */ tokenFailUser: number; tokenFailIp: number;
  /** invitation creation per user per hour */ createInvite: number;
  /** block/report/identity calls per user per minute */ safetyUser: number;
}
export const DEFAULT_LIMITS: Limits = { mutateUser: 60, tokenUser: 20, tokenIp: 60, tokenFailUser: 10, tokenFailIp: 40, createInvite: 20, safetyUser: 20 };
