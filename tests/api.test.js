import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { requestRaw, readTextCapped, MAX_BODY_BYTES } from '../lib/api.js';

function fakeResponse(status, body, headers = {}) {
  return new Response(body, { status, headers });
}

/** 호출할 때마다 10ms씩 가는 가짜 시계 */
function tickingClock(start = 1000) {
  let t = start;
  return () => {
    t += 10;
    return t;
  };
}

describe('requestRaw', () => {
  test('solved.ac로 앱 자격 증명 헤더를 붙여, 쿠키·리디렉트 없이 요청한다', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return fakeResponse(200, '{"ok":1}', { 'content-type': 'application/json', date: 'Fri, 20 Nov 2026 15:05:45 GMT' });
    };
    const raw = await requestRaw('/api/v4/users/T/activity/days?from=2026-11-14&to=2026-11-20', {
      fetchImpl,
      headers: { 'x-client-id': 'id', 'x-client-secret': 'secret' },
      now: tickingClock(),
    });
    assert.equal(seen.url, 'https://solved.ac/api/v4/users/T/activity/days?from=2026-11-14&to=2026-11-20');
    assert.equal(seen.init.credentials, 'omit');
    assert.equal(seen.init.redirect, 'error');
    assert.equal(seen.init.cache, 'no-store');
    assert.equal(seen.init.referrerPolicy, 'no-referrer');
    assert.deepEqual(seen.init.headers, { Accept: 'application/json', 'x-client-id': 'id', 'x-client-secret': 'secret' });
    assert.deepEqual(raw, {
      status: 200,
      contentType: 'application/json',
      cfMitigated: null,
      retryAfter: null,
      date: 'Fri, 20 Nov 2026 15:05:45 GMT',
      sentAt: 1010,
      headersAt: 1020,
      bodyText: '{"ok":1}',
      truncated: false,
      receivedAt: 1030,
    });
  });

  test('본문을 읽다 실패해도 상태와 헤더(Retry-After)는 돌려준다', async () => {
    const body = new ReadableStream({
      pull(c) {
        c.error(new TypeError('network error while reading body'));
      },
    });
    const fetchImpl = async () => new Response(body, { status: 429, headers: { 'retry-after': '3600' } });
    const raw = await requestRaw('/api/x', { fetchImpl, now: tickingClock() });
    assert.equal(raw.status, 429);
    assert.equal(raw.retryAfter, '3600');
    assert.equal(raw.bodyError, true);
  });

  test('solved.ac API 경로가 아니면 요청하지 않는다', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return fakeResponse(200, '');
    };
    for (const path of ['https://evil.example/api/x', '//evil.example/api/x', '/u/T', 42]) {
      assert.deepEqual(await requestRaw(path, { fetchImpl }), { networkError: 'invalid-path' }, String(path));
    }
    assert.equal(called, false);
  });

  test('Cloudflare 헤더를 전달한다', async () => {
    const fetchImpl = async () =>
      fakeResponse(403, '<html>Just a moment...</html>', { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
    const raw = await requestRaw('/api/x', { fetchImpl });
    assert.equal(raw.status, 403);
    assert.equal(raw.cfMitigated, 'challenge');
  });

  test('네트워크 오류는 throw하지 않고 networkError로 돌려준다', async () => {
    const raw = await requestRaw('/api/x', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
      now: tickingClock(),
    });
    assert.deepEqual(raw, { networkError: 'Failed to fetch', sentAt: 1010, receivedAt: 1020 });
  });

  test('시간 초과', async () => {
    const fetchImpl = (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const raw = await requestRaw('/api/x', { fetchImpl, timeoutMs: 20, now: tickingClock() });
    assert.deepEqual(raw, { networkError: 'timeout', sentAt: 1010, receivedAt: 1020 });
  });
});

describe('readTextCapped', () => {
  test('작은 응답은 그대로 (멀티바이트 포함)', async () => {
    const r = await readTextCapped(fakeResponse(200, '스트릭 🔥 {"a":1}'));
    assert.deepEqual(r, { text: '스트릭 🔥 {"a":1}', truncated: false });
  });

  test('Content-Length가 크면 읽지 않고 취소한다', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(body, { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
    assert.deepEqual(await readTextCapped(res), { text: '', truncated: true });
    assert.equal(cancelled, true);
  });

  test('길이 정보 없이 끝없이 오는 응답도 한도에서 끊는다', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    assert.deepEqual(await readTextCapped(new Response(body)), { text: '', truncated: true });
    assert.equal(cancelled, true);
    assert.ok(pulled <= MAX_BODY_BYTES / (64 * 1024) + 2, `너무 많이 읽음: ${pulled}`);
  });
});

describe('헤더 먼저 처리', () => {
  test('본문을 받기 전에 헤더 콜백을 부르고 기다린다', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const body = new ReadableStream({
      async pull(c) {
        await gate;
        c.enqueue(new TextEncoder().encode('{}'));
        c.close();
      },
    });
    const fetchImpl = async () =>
      new Response(body, { status: 429, headers: { 'retry-after': '60', date: new Date().toUTCString(), 'content-type': 'application/json' } });
    let seen = null;
    const p = requestRaw('/api/v4/users/x/activity/days', {
      fetchImpl,
      onHeaders: async (meta) => {
        seen = meta;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen?.status, 429, '본문 전에 헤더 처리');
    assert.equal(seen.retryAfter, '60');
    release();
    const raw = await p;
    assert.equal(raw.status, 429);
  });
});
