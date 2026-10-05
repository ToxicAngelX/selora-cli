import { describe, expect, it } from 'vitest';
import { redact } from '../src/api/redact.js';

describe('redact()', () => {
  it('redacts sk-gw- keys', () => {
    expect(redact('key sk-gw-AbCdEf123 sent')).toBe('key sk-gw-…redacted sent');
    expect(redact('sk-gw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe('sk-gw-…redacted');
  });

  it('redacts Bearer tokens (including fake session JWTs)', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer …redacted');
    expect(redact('Bearer testsession.TESTfakejwt0000')).toBe('Bearer …redacted');
  });

  it('redacts password fields in JSON body snippets', () => {
    expect(redact('{"email":"a@b.c","password":"hunter2"}')).toBe(
      '{"email":"a@b.c","password":"…redacted"}',
    );
  });

  it('redacts session tokens in login response bodies (debug logs response bodies)', () => {
    expect(redact('{"user":{"id":"usr_1"},"token":"testsession.TESTfakejwt","expires_at":123}')).toBe(
      '{"user":{"id":"usr_1"},"token":"…redacted","expires_at":123}',
    );
  });

  it('handles multiple occurrences and mixed content', () => {
    // Bearer pass runs first, so a key inside a Bearer header collapses to one
    // placeholder; a bare key later in the string still gets its own.
    const out = redact('Bearer sk-gw-TESTAAAA then sk-gw-TESTBBBB');
    expect(out).toBe('Bearer …redacted then sk-gw-…redacted');
  });

  it('leaves ordinary text untouched', () => {
    expect(redact('hello world 123')).toBe('hello world 123');
  });
});
