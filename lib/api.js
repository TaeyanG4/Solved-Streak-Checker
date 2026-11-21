// lib/api.js — solved.ac API 요청 (fetch와 시계를 주입받으므로 Node 테스트 가능)

import { SOLVED_ORIGIN } from './core.js';

export const REQUEST_TIMEOUT_MS = 15000;
/** 응답 본문은 이 크기까지만 읽는다 (정상 응답은 수 KB) */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * 응답 본문을 최대 maxBytes까지만 스트리밍으로 읽는다. 넘으면 읽기를 취소하고 truncated=true.
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
export async function readTextCapped(res, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { text: '', truncated: true };
  }
  if (!res.body) return { text: '', truncated: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      return { text: '', truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated: false };
}

/**
 * solved.ac API 경로를 요청하고 classifyResponse가 이해하는 원시 응답 형태로 돌려준다.
 * 연결 자체가 실패하면 {networkError} 를, 헤더는 받았는데 본문을 읽다 실패하면 상태/헤더와 함께
 * bodyError: true 를 돌려준다(429의 Retry-After 같은 정보를 잃지 않도록). throw하지 않는다.
 * sentAt/headersAt/receivedAt(내 시계)은 시계 차이와 06:00 경계 판정에 쓴다.
 *
 * @param {string} path '/api/v4/...' 형태 (항상 https://solved.ac 로만 보낸다)
 * @param {{headers?: object, fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number,
 *          onHeaders?: (meta: object) => Promise<void>|void}} [opts]
 *   onHeaders: 헤더를 받는 즉시(본문을 읽기 전에) 호출하고 끝날 때까지 기다린다 — 429 대기·시계 정보를 본문을 받는 사이
 *   브라우저가 닫혀도 잃지 않도록 먼저 저장하는 데 쓴다. 실패해도 요청은 계속한다.
 */
export async function requestRaw(
  path,
  { headers = {}, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, now = Date.now, onHeaders = null } = {},
) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) return { networkError: 'invalid-path' };
  const url = new URL(path, SOLVED_ORIGIN);
  if (url.origin !== SOLVED_ORIGIN) return { networkError: 'invalid-path' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sentAt = now();
  try {
    let res;
    try {
      res = await fetchImpl(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        // 쿠키는 필요 없다(앱 자격 증명으로 인증). 리디렉트는 따라가지 않는다(시크릿이 다른 곳으로 가지 않도록).
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch (e) {
      return { networkError: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e), sentAt, receivedAt: now() };
    }
    const headersAt = now();
    const meta = {
      status: res.status,
      contentType: res.headers.get('content-type'),
      cfMitigated: res.headers.get('cf-mitigated'),
      retryAfter: res.headers.get('retry-after'),
      date: res.headers.get('date'),
      sentAt,
      headersAt,
    };
    if (onHeaders) {
      try {
        await onHeaders(meta);
      } catch {
        // 헤더 처리 실패는 요청 결과에 영향을 주지 않는다(본문을 받은 뒤 다시 기록한다).
      }
    }
    try {
      const { text, truncated } = await readTextCapped(res);
      return { ...meta, bodyText: text, truncated, receivedAt: now() };
    } catch {
      return { ...meta, bodyText: '', truncated: false, bodyError: true, receivedAt: now() };
    }
  } finally {
    clearTimeout(timer);
  }
}
