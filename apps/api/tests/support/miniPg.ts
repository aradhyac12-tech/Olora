// Minimal PostgreSQL wire-protocol client (extended query protocol, text format, trust/cleartext auth) used ONLY by tests
// when the real `pg` package cannot be installed (offline sandbox). CI and production use the real `pg`; see tests/support/db.ts.
// It implements just the surface the app uses: Pool.connect()/query()/end(), client.query()/release(err).
import net from 'node:net';

type Row = Record<string, unknown>;
export interface QueryResult { rows: Row[]; rowCount: number }
export class PgError extends Error {
  code?: string; severity?: string; constraint?: string; detail?: string;
}

const OID = { bool: 16, int8: 20, int2: 21, int4: 23, oid: 26, json: 114, float4: 700, float8: 701, timestamp: 1114, timestamptz: 1184, numeric: 1700, jsonb: 3802 };
const ARRAY_OIDS = new Set([1000, 1005, 1007, 1009, 1015, 1016, 1021, 1022, 2951, 199, 3807]);

function parseArray(s: string): unknown[] {
  let i = 0;
  const parseLevel = (): unknown[] => {
    const out: unknown[] = [];
    i++; // {
    while (i < s.length && s[i] !== '}') {
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '{') { out.push(parseLevel()); continue; }
      if (s[i] === '"') {
        i++; let v = '';
        while (s[i] !== '"') { if (s[i] === '\\') i++; v += s[i++]; }
        i++; out.push(v);
      } else {
        let v = ''; while (i < s.length && s[i] !== ',' && s[i] !== '}') v += s[i++];
        out.push(v === 'NULL' ? null : v);
      }
    }
    i++; // }
    return out;
  };
  return s.startsWith('{') ? parseLevel() : [];
}

function convert(oid: number, text: string): unknown {
  switch (oid) {
    case OID.bool: return text === 't';
    case OID.int2: case OID.int4: case OID.oid: case OID.float4: case OID.float8: return Number(text);
    case OID.int8: { const n = Number(text); return Number.isSafeInteger(n) ? n : text; }
    case OID.json: case OID.jsonb: return JSON.parse(text);
    case OID.timestamptz: return new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case OID.timestamp: return new Date(text.replace(' ', 'T') + 'Z');
    default: return ARRAY_OIDS.has(oid) ? parseArray(text) : text;
  }
}

function toParam(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (Array.isArray(v)) return '{' + v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const msg = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]); };

export class MiniClient {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private fatal: Error | null = null;
  private auth: { user: string; password: string; database: string; host: string; port: number };

  constructor(connectionString: string) {
    const u = new URL(connectionString);
    this.auth = { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), host: u.hostname || '127.0.0.1', port: Number(u.port || 5432) };
  }

  async connect(): Promise<void> {
    this.sock = net.connect({ host: this.auth.host, port: this.auth.port });
    this.sock.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d as Uint8Array]); this.waiter?.(); });
    this.sock.on('error', (e) => { this.fatal = e; this.waiter?.(); });
    this.sock.on('close', () => { this.closed = true; this.fatal ??= new Error('connection closed'); this.waiter?.(); });
    await new Promise<void>((res, rej) => { this.sock.once('connect', res); this.sock.once('error', rej); });
    const params = Buffer.concat([cstr('user'), cstr(this.auth.user), cstr('database'), cstr(this.auth.database), Buffer.from([0])]);
    this.sock.write(Buffer.concat([i32(8 + params.length), i32(196608), params]));
    for (;;) {
      const m = await this.next();
      if (m.t === 'R') {
        const code = m.b.readInt32BE(0);
        if (code === 3) this.sock.write(msg('p', cstr(this.auth.password)));
        else if (code !== 0) throw new Error(`unsupported auth method ${code} (mini client supports trust/cleartext only)`);
      } else if (m.t === 'E') throw this.toError(m.b);
      else if (m.t === 'Z') return;
    }
  }

  private async next(): Promise<{ t: string; b: Buffer }> {
    for (;;) {
      if (this.buf.length >= 5) {
        const len = this.buf.readInt32BE(1);
        if (this.buf.length >= len + 1) {
          const t = String.fromCharCode(this.buf[0]!); const b = this.buf.subarray(5, len + 1);
          this.buf = this.buf.subarray(len + 1);
          return { t, b: Buffer.from(b) };
        }
      }
      if (this.fatal) throw this.fatal;
      await new Promise<void>((res) => { this.waiter = () => { this.waiter = null; res(); }; });
    }
  }

  private toError(b: Buffer): PgError {
    const f: Record<string, string> = {}; let i = 0;
    while (i < b.length && b[i] !== 0) { const k = String.fromCharCode(b[i]!); i++; const e = b.indexOf(0, i); f[k] = b.toString('utf8', i, e); i = e + 1; }
    const e = new PgError(f.M ?? 'error'); e.code = f.C; e.severity = f.S; e.constraint = f.n; e.detail = f.D; return e;
  }

  query(text: string, params?: unknown[]): Promise<QueryResult> {
    const run = () => this.exec(text, params);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async exec(text: string, params?: unknown[]): Promise<QueryResult> {
    if (this.closed) throw new Error('client is closed');
    if (params === undefined || params.length === 0) this.sock.write(msg('Q', cstr(text)));
    else {
      const vals = params.map(toParam);
      const bind = Buffer.concat([cstr(''), cstr(''), i16(0), i16(vals.length),
        ...vals.map((v) => (v === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(v)), Buffer.from(v, 'utf8')]))), i16(0)]);
      this.sock.write(Buffer.concat([msg('P', cstr(''), cstr(text), i16(0)), msg('B', bind), msg('D', Buffer.from('P'), cstr('')), msg('E', cstr(''), i32(0)), msg('S')]));
    }
    let cols: Array<{ name: string; oid: number }> = []; let rows: Row[] = []; let err: PgError | null = null; let count = 0;
    for (;;) {
      const m = await this.next();
      if (m.t === 'T') {
        cols = []; rows = []; let o = 2; const n = m.b.readInt16BE(0);
        for (let k = 0; k < n; k++) { const e = m.b.indexOf(0, o); const name = m.b.toString('utf8', o, e); o = e + 1; const oid = m.b.readInt32BE(o + 6); o += 18; cols.push({ name, oid }); }
      } else if (m.t === 'D') {
        const n = m.b.readInt16BE(0); let o = 2; const row: Row = {};
        for (let k = 0; k < n; k++) { const len = m.b.readInt32BE(o); o += 4; if (len < 0) row[cols[k]!.name] = null; else { row[cols[k]!.name] = convert(cols[k]!.oid, m.b.toString('utf8', o, o + len)); o += len; } }
        rows.push(row);
      } else if (m.t === 'C') { const tag = m.b.toString('utf8', 0, m.b.length - 1); const last = Number(tag.split(' ').pop()); count = Number.isFinite(last) ? last : 0; }
      else if (m.t === 'E') err = this.toError(m.b);
      else if (m.t === 'Z') { if (err) throw err; return { rows, rowCount: count }; }
    }
  }

  release(err?: unknown): void { (this as unknown as { _release?: (e?: unknown) => void })._release?.(err); }
  async end(): Promise<void> { if (!this.closed) { try { this.sock.write(msg('X')); } catch { /* closed */ } this.sock.end(); this.closed = true; } }
}

export class Pool {
  private readonly url: string; private readonly max: number;
  private idle: MiniClient[] = []; private total = 0; private waiters: Array<(c: MiniClient) => void> = [];
  private ended = false;
  constructor(o: { connectionString: string; max?: number }) { this.url = o.connectionString; this.max = o.max ?? 10; }

  on(_ev: string, _fn: unknown): this { return this; }

  async connect(): Promise<MiniClient> {
    if (this.ended) throw new Error('pool ended');
    let c = this.idle.pop();
    if (c) clearTimeout((c as unknown as { _idle?: NodeJS.Timeout })._idle);
    if (!c && this.total < this.max) {
      this.total++;
      try { c = new MiniClient(this.url); await c.connect(); } catch (e) { this.total--; throw e; }
    }
    if (!c) c = await new Promise<MiniClient>((res) => this.waiters.push(res));
    const client = c;
    (client as unknown as { _release: (e?: unknown) => void })._release = (e?: unknown) => {
      (client as unknown as { _release?: unknown })._release = undefined;
      if (e || this.ended) { this.total--; void client.end(); const w = this.waiters.shift(); if (w) { this.total++; const n = new MiniClient(this.url); void n.connect().then(() => w(n)); } return; }
      const w = this.waiters.shift();
      if (w) { w(client); return; }
      this.idle.push(client);
      // like pg's idleTimeoutMillis: idle sockets must not keep the process alive
      (client as unknown as { _idle?: NodeJS.Timeout })._idle = setTimeout(() => { const i = this.idle.indexOf(client); if (i >= 0) { this.idle.splice(i, 1); this.total--; void client.end(); } }, 2000);
    };
    return client;
  }

  async query(text: string, params?: unknown[]): Promise<QueryResult> {
    const c = await this.connect(); let err: unknown;
    try { return await c.query(text, params); } catch (e) { err = e; throw e; } finally { c.release(err && !(err instanceof PgError) ? err : undefined); }
  }

  async end(): Promise<void> { this.ended = true; for (const c of this.idle) await c.end(); this.idle = []; }
}
