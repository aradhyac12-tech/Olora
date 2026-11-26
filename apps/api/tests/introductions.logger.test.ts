import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errFields, jsonLogger, noopLogger } from '../src/introductions/logger.ts';

test('jsonLogger writes one parseable JSON line per event with level, event and fields', () => {
  const lines: string[] = [];
  const log = jsonLogger((l) => lines.push(l), () => new Date('2026-11-25T00:00:00Z'));
  log.info('intro.created', { requestId: 'r1', n: 2, ok: true, none: null }); log.warn('w'); log.error('e', { code: 'X' });
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]!), { ts: '2026-11-25T00:00:00.000Z', level: 'info', event: 'intro.created', requestId: 'r1', n: 2, ok: true, none: null });
  assert.deepEqual(lines.map((l) => JSON.parse(l).level), ['info', 'warn', 'error']);
});

test('a throwing log sink never breaks the caller; noopLogger is inert', () => {
  const log = jsonLogger(() => { throw new Error('disk full'); });
  assert.doesNotThrow(() => { log.info('a'); log.warn('b'); log.error('c'); });
  assert.doesNotThrow(() => { noopLogger.info('a'); noopLogger.warn('b'); noopLogger.error('c'); });
});

test('errFields keeps only the error class and SQLSTATE — never the message (drivers embed row values in messages)', () => {
  const e = Object.assign(new Error('duplicate key value (email)=(alice@example.test)'), { code: '23505' });
  const f = errFields(e);
  assert.deepEqual(f, { errName: 'Error', errCode: '23505' });
  assert.ok(!JSON.stringify(f).includes('alice'));
  assert.deepEqual(errFields(undefined), { errName: 'unknown', errCode: null });
  assert.deepEqual(errFields('boom'), { errName: 'unknown', errCode: null });
});
