// lib/core.js — 순수 로직 모음 (Chrome API를 쓰지 않으므로 Node 테스트로 검증 가능)
//
// 서비스 워커(background.js)와 팝업(popup.js)이 같은 규칙을 공유하도록
// 날짜 계산, API 응답 해석, 상태 판정, 알림/재시도 판단, 설정 정규화를 모두 여기에 둔다.

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

export const SOLVED_ORIGIN = 'https://solved.ac';
export const API_PATH_PREFIX = '/api/v4/users/';
/** solved.ac 공식 API 앱 등록/문서 (2026-11-17 공개) */
export const DEVELOPER_APPS_URL = 'https://backstage.solved.ac/developer/apps';
export const DEVELOPER_DOCS_URL = 'https://backstage.solved.ac/developer/docs';
/**
 * 핸들별 상태(이 기기의 로컬 저장소): 핸들이 바뀌면 지운다. stateHandle이 지금 핸들이 아니면(핸들을 바꾸는 쓰기가 아직
 * 끝나지 않음) 이 값들은 다른 핸들의 것이므로 쓰지 않는다(ownedState).
 */
export const HANDLE_SCOPED_KEYS = Object.freeze([
  'lastError',
  'notifHistory',
  'shownId',
  'notifPending',
  'snoozeDayKey',
  'reimportWatch',
  'consecutiveFailures',
  'codeFailures',
  'failingSince',
  'backoffUntil',
  'lastAttemptAt',
  'expectedRetryAt',
]);

/** 저장된 핸들별 상태가 이 핸들의 것인지(대소문자만 다른 핸들은 같은 사용자) */
export function ownsState(stateHandle, handle) {
  return stateHandle === handle || (!!handle && sameHandle(stateHandle, handle));
}

/** 핸들별 상태가 다른 핸들의 것이면 그 값들을 뺀 사본, 아니면 그대로 */
export function ownedState(local, handle) {
  if (!local || ownsState(local.stateHandle, handle)) return local;
  const out = { ...local };
  for (const k of HANDLE_SCOPED_KEYS) delete out[k];
  return out;
}

/** solved.ac 채점 사이트 연동 설정('채점 사이트에서 다시 불러오기' 버튼이 있는 곳, 로그인 필요) */
export const INTEGRATIONS_URL = 'https://solved.ac/settings/integrations';

/** solved.ac의 하루는 한국 시간(KST, UTC+9, 서머타임 없음) 오전 6시에 시작한다. */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_START_HOUR_KST = 6;
export const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_SHIFT_MS = KST_OFFSET_MS - DAY_START_HOUR_KST * 60 * 60 * 1000; // +3시간

/** 팝업에 보여줄 최근 기록 일수 */
export const RECENT_DAYS = 7;

/** 일시적인 오류는 처음 실패부터 마지막 실패까지 이만큼 이어지고 2번 이상 실패해야 알린다(절전 복귀 직후 오탐 방지). */
export const TRANSIENT_ERROR_GRACE_MS = 10 * MINUTE_MS;
export const TRANSIENT_ERROR_MIN_FAILURES = 2;
/** 확인 실패가 이어질 때 '아직 안 풀었어요'라는 예전 정보를 이 시간까지만 믿는다. */
export const STALE_UNSOLVED_MS = 20 * MINUTE_MS;
/** 새 미해결 알림은 이 시간 안에 확인한 정보로만 띄운다(그 사이 다른 기기에서 풀었을 수 있으므로). */
export const FRESH_REMINDER_MS = 2 * MINUTE_MS;
/** 실패 뒤 자동 재시도 간격의 상한 */
export const RETRY_CADENCE_MS = 5 * MINUTE_MS;
/**
 * 재시도가 예정 시각(재시도 간격 또는 서버가 정한 대기 끝)보다 이만큼 넘게 늦게 일어났다면 그 사이 절전/종료가
 * 있었던 것으로 보고 연속 실패를 새로 센다. 대기 없이 실패했다면 마지막 시도 후 5+3=8분이 기준이다
 * (10분 유예보다 짧아야 '절전 전 1번 + 깬 뒤 1번'이 장애로 보이지 않는다).
 */
export const STREAK_LATE_TOLERANCE_MS = 3 * MINUTE_MS;
export const STREAK_RESET_GAP_MS = RETRY_CADENCE_MS + STREAK_LATE_TOLERANCE_MS;
/** 내 시계와 서버 시계가 이보다 많이 다르면 날짜를 정할 수 없다. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** 같은 날 이미 해결/휴가 상태면 자동 확인은 이 간격으로만 한다. */
export const SETTLED_RECHECK_MS = 30 * MINUTE_MS;
/** 자동 확인 최소 간격 */
export const AUTO_THROTTLE_MS = 30 * 1000;
/** solved.ac 페이지 방문/팝업 열기로 인한 확인 최소 간격 */
export const PAGE_THROTTLE_MS = 60 * 1000;
/** Retry-After가 없을 때 429 이후 쉬는 시간 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * MINUTE_MS;
/** Retry-After를 믿는 최대 길이 */
export const MAX_RETRY_AFTER_SEC = 7 * 24 * 60 * 60;
/** 보안 확인/인증 오류가 반복될 때 자동 재시도 간격(15 → 30 → 60분) */
export const HARD_ERROR_BACKOFF_BASE_MS = 15 * MINUTE_MS;
export const HARD_ERROR_BACKOFF_MAX_MS = 60 * MINUTE_MS;
/** 이 시간 이하로 남았을 때만 "끊기기 직전" 같은 급한 문구를 쓴다. */
export const URGENT_REMAINING_MS = 3 * 60 * 60 * 1000;

/** 새 solved.ac 가입 규칙은 [A-Za-z0-9_]{3,20}이지만, 이전 핸들을 위해 길이 제한은 넉넉히 둔다. */
const HANDLE_RE = /^[A-Za-z0-9_]{1,64}$/;
/** 클라이언트 ID/시크릿 형식은 공개되어 있지 않으므로 공백·제어문자만 막는다. */
const CREDENTIAL_RE = /^[\x21-\x7E]{1,512}$/;

/** chrome.storage.sync에 저장하는 설정 (기기 간 동기화) */
export const SETTINGS_KEYS = [
  'handle',
  'checkIntervalMin',
  'notifyUnsolved',
  'notifyStartHours',
  'remindIntervalMin',
  'notifyError',
];
/** 핸들을 뺀 알림/주기 설정 (API 키 없이도 저장할 수 있다) */
export const PREFERENCE_KEYS = SETTINGS_KEYS.filter((k) => k !== 'handle');
/** chrome.storage.local에만 저장하는 API 자격 증명 키 (동기화하지 않음) */
export const CREDENTIALS_KEY = 'apiCredentials';

/**
 * v1.x에서 쓰던 sync 키. 아직 v1을 쓰는 다른 기기와 다른 v2 기기의 '예전 아이디 제안'을 위해
 * 지우지 않고 그대로 둔다('모든 데이터 지우기'에서만 지운다).
 */
export const LEGACY_SYNC_KEYS = ['targetUsername', 'alarmInterval', 'notifyOnNotSolved', 'notifyOnUnknown'];
/** v1.x에서 쓰던 local 키 */
export const LEGACY_LOCAL_KEYS = ['lastStreakStatus', 'lastStreakCount', 'lastCheckTimestamp', 'lastResetDate'];

export const DEFAULT_SETTINGS = Object.freeze({
  handle: '',
  checkIntervalMin: 5,
  notifyUnsolved: true,
  notifyStartHours: 12, // 마감 12시간 전(18:00 KST)부터. 24 = 하루 종일(06:00 KST부터)
  remindIntervalMin: 60, // 0 = 하루에 한 번만
  notifyError: true,
});

export const CHECK_INTERVAL_MIN = 1;
export const CHECK_INTERVAL_MAX = 1440;
export const NOTIFY_START_HOURS_OPTIONS = [24, 12, 6, 3, 1];
export const REMIND_INTERVAL_OPTIONS = [0, 10, 30, 60, 120, 180];

export const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'not-found',
  AUTH: 'auth',
  BLOCKED: 'blocked',
  RATE_LIMITED: 'rate-limited',
  NETWORK: 'network',
  HTTP: 'http',
  PARSE: 'parse',
  CLOCK: 'clock',
  REJECTED: 'rejected',
});
/** 잠시 후 저절로 해결될 수 있는 오류 */
const TRANSIENT_ERRORS = new Set([ERROR_CODES.NETWORK, ERROR_CODES.HTTP, ERROR_CODES.RATE_LIMITED]);
/** 사용자가 고치거나 오래 기다려야 하는 오류: 자동 재시도를 늦춘다 */
const HARD_ERRORS = new Set([ERROR_CODES.BLOCKED, ERROR_CODES.AUTH, ERROR_CODES.CLOCK, ERROR_CODES.REJECTED]);

export function isTransientError(code) {
  return TRANSIENT_ERRORS.has(code);
}

// ---------------------------------------------------------------------------
// 날짜 계산 (solved.ac 기준 하루)
// ---------------------------------------------------------------------------

/** 주어진 시각이 속한 solved.ac 날짜(YYYY-MM-DD). 06:00 KST 이전이면 전날로 계산된다. */
export function solvedDayKey(nowMs) {
  return new Date(nowMs + DAY_SHIFT_MS).toISOString().slice(0, 10);
}

/** 주어진 시각 이후 처음 오는 하루 경계(다음 06:00 KST)의 epoch ms. */
export function nextDayBoundary(nowMs) {
  const shifted = nowMs + DAY_SHIFT_MS;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return dayStartShifted + DAY_MS - DAY_SHIFT_MS;
}

/**
 * 하루 경계 + delayMs 시각 중 아직 오지 않은 가장 가까운 시각.
 * 경계 직후(delay 안)에 계산해도 오늘 경계의 알람을 내일로 미루지 않는다.
 */
export function nextRolloverAt(nowMs, delayMs) {
  return nextDayBoundary(nowMs - delayMs) + delayMs;
}

/** YYYY-MM-DD 날짜에 n일을 더한다. */
export function addDays(dayKey, n) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 실제로 존재하는 YYYY-MM-DD 날짜인지 (2026-13-15, 2026-02-30 같은 값은 거부) */
export function isDayString(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 서버 시계와의 차이를 반영한 현재 시각 (차이는 ±1일 이내만 신뢰) */
export function effectiveNow(nowMs, clockSkewMs) {
  if (typeof clockSkewMs !== 'number' || !Number.isFinite(clockSkewMs) || Math.abs(clockSkewMs) > DAY_MS) {
    return nowMs;
  }
  return nowMs + clockSkewMs;
}

/**
 * HTTP Date 헤더로 서버-클라이언트 시계 차이를 구한다. 계산할 수 없으면 null.
 * Date는 초 단위로 잘린 서버 시각이므로, 요청을 보낸 시각~응답 헤더를 받은 시각 사이(±1초)에 들어오면
 * 시계는 맞는 것이다(0). 그래야 느린 응답의 전송 시간을 시계 차이로 착각하지 않는다.
 * @param {string|null} dateHeader
 * @param {number} sentAtMs 요청을 보낸 시각(내 시계)
 * @param {number} [headersAtMs] 응답 헤더를 받은 시각(내 시계)
 */
export function computeClockSkew(dateHeader, sentAtMs, headersAtMs = sentAtMs) {
  if (!dateHeader) return null;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) return null;
  if (serverMs + 1000 >= sentAtMs - 1000 && serverMs <= headersAtMs + 1000) return 0;
  const skew = Math.round(serverMs + 500 - (sentAtMs + headersAtMs) / 2);
  return Math.abs(skew) > DAY_MS ? null : skew;
}

// ---------------------------------------------------------------------------
// 핸들 / 자격 증명 / URL
// ---------------------------------------------------------------------------

/**
 * 사용자가 입력한 값을 solved.ac 핸들로 정규화한다.
 * "Taeyang", "@Taeyang", "https://solved.ac/u/Taeyang", "solved.ac/ko/u/Taeyang",
 * "https://solved.ac/profile/Taeyang" 모두 "Taeyang"이 된다.
 * @returns {{ok: true, handle: string} | {ok: false, reason: 'empty' | 'invalid'}}
 */
export function normalizeHandleInput(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: 'empty' };

  const urlMatch = value.match(
    /^(?:https?:\/\/)?(?:www\.)?solved\.ac\/(?:(?:ko|en|ja)\/)?(?:u|profile)\/([^/?#\s]+)/i,
  );
  if (urlMatch) {
    try {
      value = decodeURIComponent(urlMatch[1]);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }
  value = value.replace(/^@/, '');
  if (!HANDLE_RE.test(value)) return { ok: false, reason: 'invalid' };
  return { ok: true, handle: value };
}

export function isValidHandle(handle) {
  return typeof handle === 'string' && HANDLE_RE.test(handle);
}

/** solved.ac 핸들은 대소문자를 구분하지 않는다(Taeyang = taeyang). */
export function sameHandle(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function isValidCredential(value) {
  return typeof value === 'string' && CREDENTIAL_RE.test(value);
}

/** 저장소 값을 {clientId, clientSecret}로 정규화한다. 형식이 맞지 않으면 빈 문자열. */
export function normalizeCredentials(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    clientId: isValidCredential(r.clientId) ? r.clientId : '',
    clientSecret: isValidCredential(r.clientSecret) ? r.clientSecret : '',
  };
}

export function hasCredentials(creds) {
  return !!creds && isValidCredential(creds.clientId) && isValidCredential(creds.clientSecret);
}

/** API 요청 헤더 (solved.ac API는 모든 요청에 앱 자격 증명을 요구한다) */
export function credentialHeaders(creds) {
  return { 'x-client-id': creds.clientId, 'x-client-secret': creds.clientSecret };
}

export function profileUrl(handle) {
  return `${SOLVED_ORIGIN}/u/${encodeURIComponent(handle)}`;
}

/** dayKey(오늘) 포함 최근 RECENT_DAYS일의 활동 API 경로 */
export function activityPath(handle, dayKey) {
  const from = addDays(dayKey, -(RECENT_DAYS - 1));
  return `${API_PATH_PREFIX}${encodeURIComponent(handle)}/activity/days?from=${from}&to=${dayKey}`;
}

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

function toNumber(value) {
  return typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
}

function clampInt(value, min, max, fallback) {
  const n = toNumber(value);
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pickOption(value, options, fallback) {
  const n = toNumber(value);
  return options.includes(n) ? n : fallback;
}

/** 저장소 값(일부 누락/이상값 가능)을 완전한 설정 객체로 만든다. */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    handle: isValidHandle(r.handle) ? r.handle : '',
    checkIntervalMin: clampInt(r.checkIntervalMin, CHECK_INTERVAL_MIN, CHECK_INTERVAL_MAX, DEFAULT_SETTINGS.checkIntervalMin),
    notifyUnsolved: typeof r.notifyUnsolved === 'boolean' ? r.notifyUnsolved : DEFAULT_SETTINGS.notifyUnsolved,
    notifyStartHours: pickOption(r.notifyStartHours, NOTIFY_START_HOURS_OPTIONS, DEFAULT_SETTINGS.notifyStartHours),
    remindIntervalMin: pickOption(r.remindIntervalMin, REMIND_INTERVAL_OPTIONS, DEFAULT_SETTINGS.remindIntervalMin),
    notifyError: typeof r.notifyError === 'boolean' ? r.notifyError : DEFAULT_SETTINGS.notifyError,
  };
}

/**
 * 저장소 값을 실제로 쓸 설정으로 만든다. v2 값이 없으면 v1 값을 대신 쓴다 — 동기화로 v1 설정이 늦게 와서
 * 아직 옮겨 적지 않았어도(예: v1에서 끈 알림) 곧바로 따른다.
 */
export function effectiveSettings(syncRaw) {
  const r = syncRaw && typeof syncRaw === 'object' ? syncRaw : {};
  return normalizeSettings({ ...migrateLegacySettings(r), ...r });
}

/**
 * v1 사용자의 예전 아이디(백준 아이디) — 아직 v2 핸들을 저장하지 않았을 때만 '제안값'으로 쓴다.
 * 새 solved.ac 핸들은 백준 아이디와 다를 수 있고, 같은 문자열이 다른 사람의 핸들일 수도 있으므로
 * 자동으로 추적하지 않는다. 사용자가 팝업에서 확인하고 저장해야 한다.
 * @param {object} syncRaw chrome.storage.sync 값 (handle, targetUsername 포함)
 */
export function legacyHandleFrom(syncRaw) {
  const r = syncRaw && typeof syncRaw === 'object' ? syncRaw : {};
  if (isValidHandle(r.handle) || typeof r.targetUsername !== 'string') return null;
  const parsed = normalizeHandleInput(r.targetUsername);
  return parsed.ok ? parsed.handle : null;
}

/**
 * v1.x 설정(sync)에서 v2에 아직 없는 알림/주기 설정을 옮길 값을 만든다. 이미 v2 값이 있으면 덮어쓰지 않는다.
 * v1 키는 지우지 않는다(LEGACY_SYNC_KEYS 참고).
 * @param {object} raw chrome.storage.sync 값
 * @returns {object} chrome.storage.sync에 쓸 값 (없으면 {})
 */
export function migrateLegacySettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const values = {};
  if (!('checkIntervalMin' in r) && r.alarmInterval !== undefined) {
    values.checkIntervalMin = clampInt(r.alarmInterval, CHECK_INTERVAL_MIN, CHECK_INTERVAL_MAX, DEFAULT_SETTINGS.checkIntervalMin);
  }
  if (!('notifyUnsolved' in r) && typeof r.notifyOnNotSolved === 'boolean') {
    values.notifyUnsolved = r.notifyOnNotSolved;
  }
  if (!('notifyError' in r) && typeof r.notifyOnUnknown === 'boolean') {
    values.notifyError = r.notifyOnUnknown;
  }
  return values;
}

// ---------------------------------------------------------------------------
// API 응답 해석
// ---------------------------------------------------------------------------

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * /api/v4/users/{handle}/activity/days 응답 JSON을 검증하고 필요한 값만 꺼낸다.
 * 공식 문서상 필수인 필드 중 이 확장이 쓰는 것(days와 각 행, vacation 포함)이 하나라도 없거나
 * 형식이 다르면 null — 일부만 온 응답으로 '안 풀었어요' 같은 정보를 지어내지 않기 위해서다.
 * @returns {object | null}
 */
export function parseActivity(json) {
  if (!json || typeof json !== 'object') return null;
  const { currentStreak, maxStreak, countedToday, frozenYesterday, vacation, days } = json;
  if (!isNonNegInt(currentStreak) || !isNonNegInt(maxStreak) || typeof countedToday !== 'boolean') return null;
  if (typeof frozenYesterday !== 'boolean' || !Array.isArray(days) || !('vacation' in json)) return null;

  let vac = null;
  if (vacation !== null) {
    if (typeof vacation !== 'object' || !isDayString(vacation.fromDay)) return null;
    vac = { fromDay: vacation.fromDay }; // source(item|launch)는 쓰지 않는다
  }

  const rows = [];
  for (const d of days) {
    if (
      !d ||
      !isDayString(d.day) ||
      !isNonNegInt(d.solvedCount) ||
      typeof d.freezeUsed !== 'boolean' ||
      typeof d.streakRepaired !== 'boolean'
    ) {
      return null;
    }
    rows.push({ day: d.day, solvedCount: d.solvedCount, freezeUsed: d.freezeUsed, streakRepaired: d.streakRepaired });
  }

  return {
    currentStreak,
    maxStreak: Math.max(maxStreak, currentStreak),
    countedToday,
    frozenYesterday,
    vacation: vac,
    days: rows,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 원시 HTTP 응답을 분류한다.
 * @param {{status: number, contentType?: string|null, cfMitigated?: string|null, retryAfter?: string|null,
 *          date?: string|null, bodyText?: string, truncated?: boolean}} raw
 * @param {number} [nowMs] Retry-After가 날짜일 때 기준 시각(서버 Date가 있으면 그것을 쓴다)
 * @returns {{ok: true, data: object} |
 *           {ok: false, code: string, httpStatus?: number, retryAfterSec?: number, serverCode?: string}}
 */
export function classifyResponse(raw, nowMs = Date.now()) {
  const status = Number(raw?.status) || 0;
  const contentType = String(raw?.contentType ?? '').toLowerCase();
  const isJson = contentType.includes('application/json');
  const bodyText = typeof raw?.bodyText === 'string' ? raw.bodyText : '';
  const json = isJson && !raw?.truncated ? safeJsonParse(bodyText) : null;
  const serverCode = typeof json?.error?.code === 'string' ? json.error.code : undefined;
  const withServerCode = (o) => (serverCode ? { ...o, serverCode } : o);

  // 429는 어떤 형식으로 오든(챌린지 표시가 붙어도) 요청 제한으로 보고 Retry-After를 지킨다.
  if (status === 429) {
    const serverNow = raw?.date ? Date.parse(raw.date) : Number.NaN;
    const retryAfterSec = parseRetryAfter(raw?.retryAfter, Number.isFinite(serverNow) ? serverNow : nowMs);
    return withServerCode({
      ok: false,
      code: ERROR_CODES.RATE_LIMITED,
      httpStatus: status,
      ...(retryAfterSec !== null && { retryAfterSec }),
    });
  }

  // Cloudflare 챌린지나 차단(1020 등)은 API의 JSON이 아닌 HTML 403으로 온다.
  const looksLikeChallenge =
    String(raw?.cfMitigated ?? '').toLowerCase() === 'challenge' ||
    (!isJson && status === 403) ||
    (!isJson && status === 503 && /just a moment|challenge-platform|cf-chl/i.test(bodyText));
  if (looksLikeChallenge) return { ok: false, code: ERROR_CODES.BLOCKED, httpStatus: status };

  // 앱 자격 증명이 없거나 틀림 (예: 401 MISSING_CLIENT_CREDENTIALS). 401은 본문 형식과 상관없이 인증 실패다.
  // (HTML 403은 위에서 보안 확인으로 분류했다.)
  if (status === 401 || (status === 403 && isJson)) {
    return withServerCode({ ok: false, code: ERROR_CODES.AUTH, httpStatus: status });
  }

  if (status === 404) {
    // 존재하지 않는 사용자는 JSON {error:{code:'NOT_FOUND'}}로 온다. 라우팅 404(text/plain)는 경로 문제다.
    if (serverCode === 'NOT_FOUND') return withServerCode({ ok: false, code: ERROR_CODES.NOT_FOUND, httpStatus: status });
    return withServerCode({ ok: false, code: ERROR_CODES.HTTP, httpStatus: status });
  }

  // 그 밖의 4xx(예: 400 VALIDATION_FAILED)는 같은 요청을 되풀이해도 바뀌지 않는다: 일시 오류(서버 점검)가 아니라
  // 거절로 보고, 저장을 막고, 보안 확인/인증 오류처럼 15 → 30 → 60분 간격으로만 다시 시도한다. 408(요청 시간 초과)은 일시 오류다.
  if (status >= 400 && status < 500 && status !== 408) {
    return withServerCode({ ok: false, code: ERROR_CODES.REJECTED, httpStatus: status });
  }
  if (status < 200 || status >= 300) return withServerCode({ ok: false, code: ERROR_CODES.HTTP, httpStatus: status });

  // 본문을 받다 끊긴 것은 응답 형식 문제가 아니라 일시적인 연결 문제다.
  if (raw?.bodyError) return { ok: false, code: ERROR_CODES.NETWORK, httpStatus: status };
  if (!isJson || raw?.truncated) return { ok: false, code: ERROR_CODES.PARSE, httpStatus: status };
  const data = parseActivity(json);
  if (!data) return { ok: false, code: ERROR_CODES.PARSE, httpStatus: status };
  return { ok: true, data };
}

/** Retry-After(초 또는 HTTP 날짜) → 초 (최대 7일). 알 수 없으면 null */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(Math.ceil(Number(s)), MAX_RETRY_AFTER_SEC);
  const at = Date.parse(s);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(Math.ceil((at - nowMs) / 1000), MAX_RETRY_AFTER_SEC));
}

/**
 * 응답이 요청한 날(dayKey)의 결과라고 믿을 수 없는지. 요청과 응답 사이에 06:00 KST가 지났으면
 * countedToday가 어느 날 기준인지 알 수 없다. 서버 Date 헤더(서버가 응답을 만든 시각)와
 * 수신 시각의 여러 추정치(새로 잰 시계 차이, 이전 시계 차이)를 모두 본다.
 */
export function responseDayChanged(dayKey, dateHeader, ...receiptEstimatesMs) {
  for (const t of receiptEstimatesMs) {
    if (typeof t === 'number' && Number.isFinite(t) && solvedDayKey(t) !== dayKey) return true;
  }
  const serverMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(serverMs) && solvedDayKey(serverMs) !== dayKey;
}

/**
 * 성공한 응답으로 저장할 스냅샷을 만든다.
 * @param {string} handle 요청한 핸들
 * @param {object} data parseActivity 결과
 * @param {string} dayKey 요청한 solved.ac 날짜(=오늘)
 * @param {number} fetchedAtMs 서버 시계 기준(=effectiveNow) 수신 시각
 */
export function buildSnapshot(handle, data, dayKey, fetchedAtMs) {
  const byDay = new Map(data.days.map((d) => [d.day, d]));
  const recent = [];
  for (let i = RECENT_DAYS - 1; i >= 0; i--) {
    const day = addDays(dayKey, -i);
    const d = byDay.get(day);
    recent.push({
      day,
      solvedCount: d?.solvedCount ?? 0,
      freezeUsed: d?.freezeUsed ?? false,
      streakRepaired: d?.streakRepaired ?? false,
    });
  }
  return {
    handle,
    dayKey,
    fetchedAt: fetchedAtMs,
    currentStreak: data.currentStreak,
    maxStreak: data.maxStreak,
    countedToday: data.countedToday,
    frozenYesterday: data.frozenYesterday,
    vacation: data.vacation,
    todaySolvedCount: byDay.get(dayKey)?.solvedCount ?? 0,
    recent,
  };
}

// ---------------------------------------------------------------------------
// 재시도 / 확인 간격
// ---------------------------------------------------------------------------

/**
 * 보안 확인/인증 오류 뒤 자동 확인을 쉬는 시간(ms). 쉬지 않아도 되면 0.
 * (429는 클라이언트 단위 rateLimit으로 따로 관리한다)
 * @param {string} code 오류 코드
 * @param {number} sameCodeFailures 같은 원인으로 연속 실패한 횟수(이번 포함)
 */
export function backoffMsFor(code, sameCodeFailures) {
  if (!HARD_ERRORS.has(code)) return 0;
  const n = Math.max(1, sameCodeFailures || 1);
  return Math.min(HARD_ERROR_BACKOFF_MAX_MS, HARD_ERROR_BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** 429 응답 뒤 다시 요청해도 되는 시각(내 시계) */
export function rateLimitUntil(retryAfterSec, receivedAtMs) {
  return receivedAtMs + (typeof retryAfterSec === 'number' ? retryAfterSec * 1000 : DEFAULT_RATE_LIMIT_BACKOFF_MS);
}

/**
 * 429 대기 기록: 받은 시각(내 시계) at, 그때의 서버 시각 server(Date 헤더, 초 단위로 잘려 있으므로 +1초), 대기 길이 ms.
 * 끝나는 시각은 rateLimitEnd가 이 근거로 그때그때 계산한다(시계를 고치거나, 데이터를 지우거나, 키를 바꿔도 대기를 지키도록).
 */
export function rateLimitEntry(retryAfterSec, receivedAtMs, dateHeader) {
  const ms =
    typeof retryAfterSec === 'number' ? Math.min(retryAfterSec, MAX_RETRY_AFTER_SEC) * 1000 : DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const server = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  // at(받은 시각)·server는 바꾸지 않는다. 내 시계가 뒤로 가면 shift만 바뀐다(rebaseRateLimits).
  return { at: receivedAtMs, server: Number.isFinite(server) ? server + 1000 : null, ms, shift: 0, seen: receivedAtMs };
}

/**
 * 429 대기가 끝나는 시각(내 시계 기준). 배열(지우기 뒤 남긴 대기들)이면 그중 가장 늦은 끝.
 * - 받을 때 내 시계가 하루 넘게 느렸다면(시계 오류) 앞으로 고친 것은 알 수 없으므로 서버 기준 끝까지 기다린다
 *   (시계가 틀린 동안에는 어차피 날짜를 정할 수 없어 확인할 수 없으므로 더 기다려도 잃는 것이 없다).
 * - 그 밖에는 내 시계 기준(받은 시각 + 대기 길이). 내 시계가 뒤로 가면 rebaseRateLimits가 옮긴 만큼(shift)을 더한다.
 *   '받을 때 하루 넘게 느렸는지'는 바뀌지 않는 받은 시각(at)으로만 판단한다.
 * - 숫자(예전 형식)는 내 시계 기준의 끝이다.
 */
export function rateLimitEnd(entry, nowMs) {
  if (Array.isArray(entry)) return Math.max(0, ...entry.map((e) => rateLimitEnd(e, nowMs)));
  if (typeof entry === 'number') return entry;
  if (!entry || typeof entry !== 'object' || typeof entry.at !== 'number' || typeof entry.ms !== 'number') return 0;
  const localEnd = entry.at + (typeof entry.shift === 'number' ? entry.shift : 0) + entry.ms;
  if (typeof entry.server === 'number' && entry.server - entry.at > MAX_CLOCK_SKEW_MS) {
    return Math.max(localEnd, entry.server + entry.ms);
  }
  return localEnd;
}

/**
 * 내 시계가 뒤로 간 것을 대기 기록마다 따로 확인해 받은 시각을 옮긴다. 대기마다 '마지막으로 본 내 시각'(seen)을 적어 두고,
 * 지금이 그보다 1분 넘게 이르면 그만큼 끝을 옮긴다(shift) — 시계를 일부만 고쳤어도 남은 대기를 그대로 지키고,
 * 한 번 옮긴 뒤에는 시간이 지나도 끝이 다시 바뀌지 않는다. 데이터를 지우거나 키를 바꿔도 기록과 함께 남는다.
 * 끝난 대기는 지운다. 바뀐 것이 없으면 같은 객체를 돌려준다.
 */
export function rebaseRateLimits(rateLimits, nowMs) {
  if (!rateLimits || typeof rateLimits !== 'object') return rateLimits;
  const fix = (e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.at !== 'number') return e;
    const seen = typeof e.seen === 'number' ? e.seen : e.at;
    const shift = typeof e.shift === 'number' ? e.shift : 0;
    // 앞서 뒤로 옮긴 기록인데 지금 내 시계가 받을 때의 서버 시각 이후라면(시계를 원래대로 되돌림 등) 서버 기준 끝보다
    // 앞당기지 않는다(받을 때 시계가 맞았다면 그 끝이 진짜 끝이다). 더 기다리는 쪽으로만 바뀐다.
    const serverFloor =
      typeof e.server === 'number' && nowMs >= e.server - MINUTE_MS ? e.server - 1000 - e.at : Number.NEGATIVE_INFINITY;
    if (shift < 0 && serverFloor > shift && seen <= nowMs + MINUTE_MS) {
      return { ...e, shift: Math.min(0, serverFloor), seen: Math.max(seen, nowMs) };
    }
    if (seen > nowMs + MINUTE_MS) {
      // 지금 내 시계가 받을 때의 서버 시각보다 뒤가 아니면(시계가 맞을 수 있다) 서버 기준 끝보다 앞당기지 않는다:
      // 맞던 시계가 잠깐 앞으로 갔다가 돌아온 경우 대기가 짧아지지 않도록. 지금이 그 서버 시각보다 앞이면(시계가 확실히
      // 늦다) 본 만큼 그대로 옮긴다. 정한 값은 저장되어 나중에 바뀌지 않는다.
      const floor =
        typeof e.server === 'number' && nowMs >= e.server - MINUTE_MS ? e.server - 1000 - e.at : Number.NEGATIVE_INFINITY;
      return { ...e, shift: Math.max(shift + (nowMs - seen), floor), seen: nowMs };
    }
    return nowMs > seen ? { ...e, seen: nowMs } : e;
  };
  const entries = [];
  for (const [id, entry] of Object.entries(rateLimits)) {
    const next = Array.isArray(entry) ? entry.map(fix).filter((e) => rateLimitEnd(e, nowMs) > nowMs) : fix(entry);
    if (Array.isArray(next) ? next.length : rateLimitEnd(next, nowMs) > nowMs) entries.push([id, next]);
  }
  // Object.fromEntries는 '__proto__' 같은 키도 일반 속성으로 만든다.
  const out = Object.fromEntries(entries);
  return JSON.stringify(out) === JSON.stringify(rateLimits) ? rateLimits : out;
}

/**
 * 429 대기 기록 중 마지막으로 확인한 내 시각(seen)이 지금보다 marginMs 넘게 앞인 것이 있는지(시계가 뒤로 감).
 * 익명으로 남긴 대기(배열)도 본다. seen은 확인할 때마다 지금으로 바뀌므로 한 번 되돌림은 한 번만 보인다.
 */
export function rateLimitsSeenAhead(rateLimits, nowMs, marginMs = MINUTE_MS) {
  if (!rateLimits || typeof rateLimits !== 'object') return false;
  return Object.values(rateLimits)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .some((e) => !!e && typeof e === 'object' && typeof e.seen === 'number' && e.seen > nowMs + marginMs);
}

/**
 * 이 응답으로 API 키가 solved.ac에 확인되었는지: 429·보안 확인·서버 오류(5xx)·응답 없음은 키를 확인해 주지 않는다.
 * 2xx와 그 밖의 4xx(인증 실패, 사용자 없음 등)는 확인된 것이다.
 */
export function responseVerifiesKey(raw, classified) {
  if (!raw || raw.networkError || typeof raw.status !== 'number') return false;
  if (raw.status === 429 || classified?.code === ERROR_CODES.BLOCKED) return false;
  return raw.status >= 200 && raw.status < 500;
}

/**
 * '모든 데이터 지우기' 뒤에도 남기는 429 대기의 키. 어느 클라이언트(키)였는지는 남기지 않고 모든 클라이언트에 적용한다.
 * 클라이언트 ID는 1자 이상이므로 빈 문자열과 겹치지 않는다.
 */
export const ANY_CLIENT_WAIT_KEY = '';

function entryOf(rateLimits, key) {
  return rateLimits && typeof rateLimits === 'object' && Object.hasOwn(rateLimits, key) ? rateLimits[key] : undefined;
}

/**
 * 이 클라이언트(앱)가 아직 429 대기 중이면 끝나는 시각, 아니면 null.
 * @param {Record<string, object|number>|undefined} rateLimits 클라이언트 ID별 대기 기록(rateLimitEntry)
 */
export function activeRateLimit(rateLimits, clientId, nowMs) {
  const until = Math.max(
    clientId ? rateLimitEnd(entryOf(rateLimits, clientId), nowMs) : 0,
    rateLimitEnd(entryOf(rateLimits, ANY_CLIENT_WAIT_KEY), nowMs),
  );
  return nowMs < until ? until : null;
}

/** 끝난 429 대기를 지운 맵 */
export function pruneRateLimits(rateLimits, nowMs) {
  return Object.fromEntries(
    Object.entries(rateLimits && typeof rateLimits === 'object' ? rateLimits : {}).filter(
      ([, entry]) => rateLimitEnd(entry, nowMs) > nowMs,
    ),
  );
}

/**
 * 지우기 뒤에 남길 429 대기: 클라이언트 ID 없이, 아직 끝나지 않은 대기 기록 전부(어느 쪽이 나중에 끝날지는 시계를
 * 고치면 바뀔 수 있으므로 하나만 고르지 않는다). 남길 것이 없으면 null.
 */
export function anonymousRateLimits(rateLimits, nowMs) {
  const live = Object.values(pruneRateLimits(rateLimits, nowMs)).flatMap((e) => (Array.isArray(e) ? e : [e]));
  const kept = live.filter((e) => rateLimitEnd(e, nowMs) > nowMs);
  return kept.length ? { [ANY_CLIENT_WAIT_KEY]: kept } : null;
}

/** 429 대기를 기록하고 끝난 항목은 지운 새 맵을 돌려준다(더 늦게 끝나는 대기가 이미 있으면 그대로 둔다). */
export function withRateLimit(rateLimits, clientId, entry, nowMs) {
  const live = pruneRateLimits(rateLimits, nowMs);
  const prev = entryOf(live, clientId);
  const keep = prev !== undefined && rateLimitEnd(prev, nowMs) >= rateLimitEnd(entry, nowMs) ? prev : entry;
  // Object.fromEntries는 '__proto__' 같은 키도 일반 속성으로 만든다.
  return Object.fromEntries([...Object.entries(live).filter(([id]) => id !== clientId), [clientId, keep]]);
}

/**
 * 실패를 기록할 때 연속 실패 횟수와 시작 시각을 계산한다. 직전 시도와의 간격이 STREAK_RESET_GAP_MS보다
 * 길면(절전, 브라우저 종료 등) 새로 센다 — 절전 전 1번 + 깬 직후 1번을 '10분 넘게 이어진 장애'로 보지 않도록.
 */
export function nextFailureStreak({ consecutiveFailures, failingSince, lastAttemptAt, expectedRetryAt, receivedAt, at }) {
  // 예정된 재시도 시각: 서버/백오프 대기 끝(기록된 경우) 또는 마지막 시도 + 재시도 간격
  const expected =
    typeof expectedRetryAt === 'number'
      ? expectedRetryAt
      : typeof lastAttemptAt === 'number'
        ? lastAttemptAt + RETRY_CADENCE_MS
        : null;
  const late = expected !== null && receivedAt - expected > STREAK_LATE_TOLERANCE_MS;
  // 시작 시각이 지금보다 뒤라면 시계가 뒤로 간 것이다: 예전 시계의 기록이므로 새로 센다.
  const fromOtherClock = typeof failingSince === 'number' && failingSince > at;
  if (!consecutiveFailures || late || fromOtherClock || typeof failingSince !== 'number') {
    return { consecutiveFailures: 1, failingSince: at };
  }
  return { consecutiveFailures: consecutiveFailures + 1, failingSince };
}

/**
 * 실패(code) 뒤 다음 자동 재시도 시각(내 시계). wake 알람과 '예정된 재시도 시각' 기록이 같은 값을 쓰도록 한 곳에서 계산한다.
 * 429 대기/백오프(보안 확인·인증·시계·요청 거절) 중이면 그 끝, 일시 오류면 min(확인 주기, 5분) 뒤.
 * 대기/백오프가 끝난 사용자 없음/해석 실패/요청 거절은 주기 확인 때만 다시 시도한다(null).
 */
export function retryAtAfterFailure({ settings, code, attemptAt, backoffUntil, rateLimitedUntil }) {
  const cadence = attemptAt + Math.min(settings.checkIntervalMin * MINUTE_MS, RETRY_CADENCE_MS);
  const waits = [backoffUntil, rateLimitedUntil].filter((t) => typeof t === 'number' && t > attemptAt);
  // 429가 이어지면 Retry-After가 짧아도 재시도 간격(확인 주기, 최대 5분)보다 자주 자동으로 요청하지 않는다
  // (이미 한도를 넘은 앱의 요청을 늘리지 않도록). "지금 확인"은 서버가 정한 대기만 지킨다.
  if (code === ERROR_CODES.RATE_LIMITED) return Math.max(cadence, ...waits);
  if (waits.length) return Math.max(...waits);
  if (code === ERROR_CODES.NOT_FOUND || code === ERROR_CODES.PARSE || code === ERROR_CODES.REJECTED) return null;
  return cadence;
}

/** 실패 뒤 다음 자동 확인이 일어날 예정 시각(내 시계) — 절전 감지용. 재시도가 없으면 다음 주기 확인. */
export function expectedRetryAfterFailure({ settings, code, receivedAt, backoffUntil, rateLimitedUntil }) {
  return (
    retryAtAfterFailure({ settings, code, attemptAt: receivedAt, backoffUntil, rateLimitedUntil }) ??
    receivedAt + settings.checkIntervalMin * MINUTE_MS
  );
}

/**
 * 이 핸들의 마지막 시도가 실패였는지. 성공하면 lastError를 지우므로, 이 핸들의 lastError가 남아 있다면
 * 그것이 스냅샷보다 나중 일이다(시각 비교는 시계 보정이 바뀌면 틀릴 수 있어 쓰지 않는다).
 */
function failedLastFor(handle, lastError) {
  return !!lastError && sameHandle(lastError.handle, handle);
}

/**
 * 이번 확인을 건너뛸지 결정한다.
 * @param {{policy: 'auto'|'page'|'force', handle: string, snapshot?: object|null, lastError?: object|null,
 *          backoffUntil?: number|null, rateLimitedUntil?: number|null, lastAttemptAt?: number|null,
 *          nowMs: number, eNowMs: number}} p
 *   nowMs는 내 시계, eNowMs는 서버 시계로 보정한 시각. backoffUntil/rateLimitedUntil/lastAttemptAt은 내 시계 기준.
 */
export function shouldSkipRefresh({
  policy,
  handle,
  snapshot,
  lastError,
  backoffUntil,
  rateLimitedUntil,
  lastAttemptAt,
  verifyPending = false,
  dayUncertain: uncertainDay = false,
  retryOwed = false,
  reimportDue: reimportCheckDue = false,
  retryGapMs = RETRY_CADENCE_MS,
  nowMs,
  eNowMs,
}) {
  // 서버가 정한 대기 시간(429 Retry-After)은 사용자가 직접 눌러도 지킨다.
  if (typeof rateLimitedUntil === 'number' && nowMs < rateLimitedUntil) return true;
  if (policy === 'force') return false;
  if (typeof backoffUntil === 'number' && nowMs < backoffUntil) return true;
  const minGap = policy === 'page' ? PAGE_THROTTLE_MS : AUTO_THROTTLE_MS;

  if (failedLastFor(handle, lastError)) {
    // 실패 직후에는 페이지 방문/알람이 겹쳐도 연달아 요청하지 않는다(시계가 뒤로 갔으면 막지 않는다).
    // 마지막이 429였다면 팝업 열기·페이지 방문으로도 재시도 간격보다 자주 요청하지 않는다("지금 확인"은 force).
    const gap = lastError.code === ERROR_CODES.RATE_LIMITED ? Math.max(minGap, retryGapMs) : minGap;
    const since = typeof lastAttemptAt === 'number' ? nowMs - lastAttemptAt : Number.POSITIVE_INFINITY;
    return since >= 0 && since < gap;
  }
  // 아직 확인하지 못한 새 API 키, 오늘이 어느 날인지 확신할 수 없음, 또는 429로 미룬 확인이 남음(그 사이 핸들을 바꿨다
  // 돌아와 실패 기록이 없어진 경우 등): 최근 정보가 있어도 바로 확인한다.
  // '채점 사이트에서 다시 불러오기'를 기다리는 중 확인할 때가 됐다면(오늘 이미 풀었어도) 확인한다.
  if (verifyPending || uncertainDay || retryOwed || reimportCheckDue) return false;
  const snap = snapshot && sameHandle(snapshot.handle, handle) ? snapshot : null;
  if (!snap || snap.dayKey !== solvedDayKey(eNowMs)) return false;
  // 06:00 직후 서버 반영 여유(ROLLOVER_GRACE_MS) 안에 받은 정보는 어제의 countedToday가 남아 있었을 수 있으므로,
  // 여유가 지나면 다시 확인한다(그 안에 다른 알람이 먼저 확인했어도 06:00:15 확인을 건너뛰지 않도록).
  const graceEnd = nextDayBoundary(eNowMs) - DAY_MS + ROLLOVER_GRACE_MS;
  // 서버 시각으로 여유 안에서 만들어진 응답(provisional)은 여유가 끝나면 반드시 다시 확인한다.
  if (snap.provisional) return eNowMs < graceEnd;
  if (snap.fetchedAt < graceEnd && eNowMs >= graceEnd) return false;

  const age = eNowMs - snap.fetchedAt;
  if (age < 0) return false; // 시계가 뒤로 갔다: 미래 시각의 정보는 믿지 않고 다시 확인
  if (policy === 'page') return age < PAGE_THROTTLE_MS;
  const settled = snap.countedToday || !!snap.vacation;
  return age < (settled ? SETTLED_RECHECK_MS : AUTO_THROTTLE_MS);
}

/**
 * 마지막 시도가 실패했을 때 다음 자동 재시도 시각(내 시계). 대기/백오프 중이면 그 끝,
 * 일시 오류면 min(확인 주기, 5분) 뒤. 실패 상태가 아니면 null.
 */
export function nextRetryAt({ settings, handle, snapshot, lastError, backoffUntil, rateLimitedUntil, lastAttemptAt }) {
  if (!failedLastFor(handle, lastError) || typeof lastAttemptAt !== 'number') return null;
  return retryAtAfterFailure({ settings, code: lastError.code, attemptAt: lastAttemptAt, backoffUntil, rateLimitedUntil });
}

// ---------------------------------------------------------------------------
// 상태 판정
// ---------------------------------------------------------------------------

/**
 * 저장된 값으로 현재 상태를 판정한다.
 * kind: 'setup' | 'checking' | 'solved' | 'unsolved' | 'vacation' | 'error'
 * @param {{settings: object, credentialsReady?: boolean, legacyHandle?: string|null,
 *          snapshot?: object|null, lastError?: object|null, nowMs: number}} p
 *   nowMs는 effectiveNow로 보정된 시각이어야 한다.
 */
export function deriveStatus({
  settings,
  credentialsReady = true,
  legacyHandle = null,
  snapshot,
  lastError,
  rateLimited = false,
  clockProblem = false,
  dayUncertain: uncertainDay = false,
  nowMs,
}) {
  const handle = settings?.handle;
  // v1에서 업데이트한 사용자: 예전 아이디를 확인받기 전까지는 추적하지 않는다.
  if (!handle) return { kind: 'setup', missing: 'handle', migrated: !!legacyHandle };
  if (!credentialsReady) return { kind: 'setup', missing: 'credentials', migrated: false };

  const dayKey = solvedDayKey(nowMs);
  // 오늘이 어느 날인지 확신할 수 없으면(시계를 고친 뒤 아직 서버 응답이 없음) 마지막 정보를 '오늘'로 쓰지 않는다(uncertainDay).
  const snap = snapshot && sameHandle(snapshot.handle, handle) ? snapshot : null;
  // 서버가 내 시계가 하루 넘게 틀렸다고 보여 줬고 아직 고친 것으로 보이지 않으면(그 뒤 응답 없이 실패했어도) 시계 오류다.
  // 시계는 기기 단위이므로 핸들과 상관없다. 그 기록이 풀렸다면(고침/정상 응답) 예전 시계 오류는 더 보여주지 않는다.
  const err =
    lastError && sameHandle(lastError.handle, handle) && lastError.code !== ERROR_CODES.CLOCK ? lastError : null;
  // 성공하면 lastError를 지우므로, 남아 있는 이 핸들의 오류는 항상 스냅샷보다 나중 일이다.
  const errIsNewer = !!err;

  // 사용자 없음/자격 증명 오류는 날짜와 상관없고 사용자가 설정에서 고쳐야 하므로 가장 먼저 알린다(시계가 틀려도).
  if (err && [ERROR_CODES.NOT_FOUND, ERROR_CODES.AUTH].includes(err.code)) {
    return { kind: 'error', code: err.code, dayKey, lastSnapshot: snap };
  }
  // 그다음 시계 오류(시계가 틀리면 '오늘'도 믿을 수 없다).
  if (clockProblem) return { kind: 'error', code: ERROR_CODES.CLOCK, dayKey, lastSnapshot: snap };

  // 06:00 직후 서버 반영 여유 안에 만들어진 응답(provisional)은 어제의 정보가 남아 있을 수 있으므로 '오늘'로 쓰지 않는다
  // (여유 뒤의 응답이 성공할 때까지 — 그 사이 429 등으로 확인하지 못하면 그 원인을 보여준다).
  if (snap && snap.dayKey === dayKey && !uncertainDay && !snap.provisional) {
    // 마지막 확인이 실패했거나, 이 앱이 429 대기 중이라 확인할 수 없으면 정보가 낡아 간다.
    const stale = errIsNewer || rateLimited;
    // 해결은 그날 안에 되돌아가지 않으므로 확인이 실패해도 그대로 믿는다. 휴가는 '마지막으로 확인한' 상태다.
    if (snap.vacation) return { kind: 'vacation', dayKey, snapshot: snap, stale };
    if (snap.countedToday) return { kind: 'solved', dayKey, snapshot: snap, stale };
    // '아직 안 풀었어요'는 그사이 풀었을 수 있으므로, 실패가 길어지거나 막힌 경우 오류로 보여준다.
    const code = failureCause(err, rateLimited);
    // 0~20분 전 정보만 믿는다. 미래 시각(시계가 뒤로 감)의 정보는 확인이 실패하는 동안 믿지 않는다.
    const age = nowMs - snap.fetchedAt;
    if (stale && (!isTransientError(code) || age < 0 || age > STALE_UNSOLVED_MS)) {
      return { kind: 'error', code, dayKey, lastSnapshot: snap };
    }
    return { kind: 'unsolved', dayKey, snapshot: snap, stale, atRisk: snap.currentStreak > 0 };
  }

  // 오늘 정보가 없다(06:00이 지났거나 핸들이 막 바뀜). 확인이 실패했거나 이 앱이 429 대기 중이면 그 원인을 보여준다.
  const code = failureCause(err, rateLimited);
  if (code) return { kind: 'error', code, dayKey, lastSnapshot: snap };
  return { kind: 'checking', dayKey, lastSnapshot: snap };
}

/**
 * 확인할 수 없는 원인. 막힘/해석 실패 > 지금 이어지는 429 대기 > 예전 일시 오류
 * (대기가 길면 예전 네트워크 오류가 아니라 그 대기를 알려야 한다). 없으면 null.
 */
function failureCause(err, rateLimited) {
  if (err && !isTransientError(err.code)) return err.code;
  if (rateLimited) return ERROR_CODES.RATE_LIMITED;
  return err ? err.code : null;
}

// ---------------------------------------------------------------------------
// 알림 판단
// ---------------------------------------------------------------------------

function notificationKindFor(status) {
  if (status.kind === 'unsolved') return 'unsolved';
  if (status.kind === 'error') return 'error';
  // 설정을 마치지 않은 채 남은 경우(v1에서 업데이트, API 키 없음): 설정이 필요하다고 알린다.
  // 막 설치한 사용자(아무 설정도 없음)에게는 알리지 않는다(설정 탭이 이미 열린다).
  if (status.kind === 'setup' && (status.missing === 'credentials' || status.migrated)) return 'setup';
  return null;
}

/** 알림 기록에 쓰는 원인 이름: 'error:blocked', 'setup:credentials' 등 */
export function notificationCause(status) {
  if (status.kind === 'error') return `error:${status.code}`;
  if (status.kind === 'setup') return `setup:${status.missing}${status.migrated ? ':migrated' : ''}`;
  return null;
}

function unsolvedWindowStart(settings, nowMs) {
  return nextDayBoundary(nowMs) - settings.notifyStartHours * 60 * 60 * 1000;
}

/** 일시적 오류가 알림을 띄울 만큼 오래 계속되었는지: 실제로 관찰한 첫 실패~마지막 실패 기준 */
function transientErrorMature(failingSince, lastFailureAt, consecutiveFailures) {
  return (
    (consecutiveFailures ?? 0) >= TRANSIENT_ERROR_MIN_FAILURES &&
    typeof failingSince === 'number' &&
    typeof lastFailureAt === 'number' &&
    lastFailureAt - failingSince >= TRANSIENT_ERROR_GRACE_MS
  );
}

/**
 * 지금 알림을 띄울지/지울지/그대로 둘지 결정한다.
 *
 * 알림 기록(history)은 화면에 떠 있는 알림(shownKind/shownCause)과 따로 관리해서, 알림을 닫거나 다른 알림으로
 * 바꿔도 기록이 지워지지 않게 한다.
 *  - history.reminder {dayKey, shownAt, displaced}: 미해결 알림을 마지막으로 띄운 때 → '다시 알림' 간격을 지킨다.
 *    displaced는 확장이 스스로(오류 등으로) 그 알림을 닫거나 바꿨다는 표시 → 미해결로 돌아오면 다시 띄운다.
 *  - history.alerts {dayKey, causes[]}: 그날 띄운 오류 알림 원인들 → 같은 원인은 하루 한 번.
 *  - history.setup causes[]: 띄운 설정 알림 원인들 → 같은 원인은 한 번만.
 *
 * - unsolved: 알림 시작 시각 이후. 새로 띄울 때는 방금(2분 안에) 확인한 정보여야 한다. 바로 이번 확인 요청이
 *   실패한 경우(refreshJustFailed)에만 20분까지 마지막 정보로 알린다(알림에 '최근 확인 실패' 표시).
 * - error: 일시 오류는 관찰한 실패가 2번 이상, 10분 이상 이어졌을 때만. 429는 남은 대기가 10분 이상이면 알린다.
 * 'keep'은 화면의 알림을 그대로 둔다는 뜻이다(없으면 없는 대로).
 * @returns {{action: 'show'|'clear'|'keep', kind?: 'unsolved'|'error'|'setup', restore?: boolean}}
 */
export function decideNotification({
  status,
  settings,
  history,
  shownKind,
  shownCause,
  snoozeDayKey,
  consecutiveFailures,
  failingSince,
  lastFailureAt,
  rateLimitRemainingMs,
  refreshJustFailed = false,
  nowMs,
}) {
  const kind = notificationKindFor(status);
  const dayKey = solvedDayKey(nowMs);
  if (!kind) return { action: 'clear' };
  if (snoozeDayKey && snoozeDayKey === dayKey) return { action: 'clear' };

  if (kind === 'unsolved') {
    if (!settings.notifyUnsolved || nowMs < unsolvedWindowStart(settings, nowMs)) return { action: 'clear' };
    // 20분 예외는 '방금 이 확인에서 요청이 실패한' 경우에만. 예전 실패 기록만으로는 오래된 정보로 알리지 않는다.
    const age = nowMs - status.snapshot.fetchedAt;
    const fresh = age >= 0 && age <= (refreshJustFailed && status.stale ? STALE_UNSOLVED_MS : FRESH_REMINDER_MS);
    const r = history?.reminder;
    const reminded = r?.dayKey === dayKey && typeof r.shownAt === 'number';
    // 다시 알림 간격: 마지막 알림 시각이 미래(시계가 뒤로 감)라면 간격이 지난 것으로 본다.
    const due =
      !reminded ||
      (settings.remindIntervalMin > 0 &&
        (r.shownAt > nowMs || nowMs - r.shownAt >= settings.remindIntervalMin * MINUTE_MS));
    if (shownKind === 'unsolved' && !due) return { action: 'keep' };
    if (due || (r.displaced && shownKind !== 'unsolved')) {
      // 새로 띄우거나(간격이 지남) 확장이 닫았던 알림을 되살린다. 둘 다 방금 확인한 정보일 때만.
      if (!fresh) return { action: 'keep' };
      return due ? { action: 'show', kind } : { action: 'show', kind, restore: true };
    }
    // 간격 전이고 사용자가 닫은 경우: 그대로. 사이에 띄운 오류/설정 알림이 남아 있으면 닫는다.
    return shownKind ? { action: 'clear' } : { action: 'keep' };
  }

  // 오류/설정: 더 이상 믿을 수 없는 미해결 알림이나 지난 오류 알림은 닫는다(기록은 남는다).
  if (!settings.notifyError) return { action: 'clear' };
  if (kind === 'error' && isTransientError(status.code)) {
    const longRateLimit =
      status.code === ERROR_CODES.RATE_LIMITED && (rateLimitRemainingMs ?? 0) >= TRANSIENT_ERROR_GRACE_MS;
    if (!longRateLimit && !transientErrorMature(failingSince, lastFailureAt, consecutiveFailures)) {
      return { action: 'clear' };
    }
  }
  const cause = notificationCause(status);
  const alerted =
    kind === 'setup'
      ? (history?.setup ?? []).includes(cause)
      : history?.alerts?.dayKey === dayKey && (history.alerts.causes ?? []).includes(cause);
  if (alerted) return shownKind === kind && shownCause === cause ? { action: 'keep' } : { action: 'clear' };
  return { action: 'show', kind };
}

/**
 * 결정을 실행한 뒤의 알림 기록을 만든다(불변 갱신).
 * - 확장이 떠 있던 미해결 알림을 닫거나 다른 알림으로 바꾸면 reminder.displaced = true.
 *   shownKind에는 '확장이 실제로 닫았다고 확인된' 알림의 종류만 넘긴다(그 사이 사용자가 닫았으면 null).
 * - show(restore)는 shownAt을 바꾸지 않는다('다시 알림' 간격 유지).
 * - 알림 표시가 실패해도 기록한다(실패할 때마다 곧바로 다시 시도하지 않도록, 다음 시도는 정상 간격 뒤).
 */
export function applyDecisionToHistory(history, decision, status, shownKind, nowMs) {
  let h = history && typeof history === 'object' ? { ...history } : {};
  const displacing =
    shownKind === 'unsolved' &&
    (decision.action === 'clear' || (decision.action === 'show' && decision.kind !== 'unsolved'));
  if (displacing && h.reminder) h = { ...h, reminder: { ...h.reminder, displaced: true } };
  if (decision.action !== 'show') return h;
  if (decision.kind === 'unsolved' && decision.restore && h.reminder) {
    return { ...h, reminder: { ...h.reminder, displaced: false } };
  }
  return recordNotification(h, decision.kind, status, nowMs);
}

/** 알림을 띄운 뒤의 기록을 만든다(불변 갱신). */
export function recordNotification(history, kind, status, nowMs) {
  const h = history && typeof history === 'object' ? history : {};
  const dayKey = solvedDayKey(nowMs);
  if (kind === 'unsolved') return { ...h, reminder: { dayKey, shownAt: nowMs } };
  const cause = notificationCause(status);
  if (kind === 'setup') return { ...h, setup: [...new Set([...(h.setup ?? []), cause])] };
  const causes = h.alerts?.dayKey === dayKey ? h.alerts.causes ?? [] : [];
  return { ...h, alerts: { dayKey, causes: [...new Set([...causes, cause])] } };
}

/**
 * 알림/표시가 바뀔 수 있는 다음 시각(서버 시계 기준). 확인 주기와 상관없이 제때 깨어나기 위해 쓴다.
 * 예: 알림 시작 시각, '다시 알림' 시각, 묵은 '미해결' 정보를 더 믿지 않게 되는 시각. 없으면 null.
 */
export function nextNotificationCheckAt({ status, settings, history, snoozeDayKey, nowMs }) {
  const deadline = nextDayBoundary(nowMs);
  if (status.kind !== 'unsolved') return null;
  const candidates = [];
  // 실패가 이어지는 중이면, 미해결 정보를 믿는 시간이 끝날 때 오류 표시로 바꿔야 한다.
  if (status.stale) candidates.push(status.snapshot.fetchedAt + STALE_UNSOLVED_MS + 1000);
  if (settings.notifyUnsolved && !(snoozeDayKey && snoozeDayKey === solvedDayKey(nowMs))) {
    const windowStart = unsolvedWindowStart(settings, nowMs);
    const r = history?.reminder;
    if (nowMs < windowStart) candidates.push(windowStart);
    else if (settings.remindIntervalMin > 0 && r?.dayKey === solvedDayKey(nowMs) && typeof r.shownAt === 'number') {
      candidates.push(r.shownAt + settings.remindIntervalMin * MINUTE_MS);
    }
  }
  // 이미 지난 시각은 빼다: 지금 결정에서 이미 반영됐고, 남은 일은 재시도/주기 확인이 맡는다(30초마다 깨는 일 방지).
  const valid = candidates.filter((t) => t > nowMs && t < deadline);
  return valid.length ? Math.min(...valid) : null;
}

// ---------------------------------------------------------------------------
// 표시용 텍스트
// ---------------------------------------------------------------------------

export function formatNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
}

/** 남은 시간 "3시간 5분", "45분", "1분 미만" */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0분';
  const totalMin = Math.floor(ms / MINUTE_MS);
  if (totalMin < 1) return '1분 미만';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

/** 사용자의 로컬 시간대로 "오전 6:00" 형식 */
export function formatClock(ms, timeZone) {
  return new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', ...(timeZone && { timeZone }) }).format(
    new Date(ms),
  );
}

/** 마감 같은 solved.ac 기준 시각을 한국 시간으로: "오전 6:00(한국 시간)" */
export function formatKstClock(ms) {
  return `${formatClock(ms, 'Asia/Seoul')}(한국 시간)`;
}

/** 오늘이면 "오후 3:20", 다른 날이면 "11월 23일 오후 3:20" (사용자 시간대) */
export function formatWhen(ms, nowMs, timeZone) {
  const opts = timeZone ? { timeZone } : {};
  const day = (t) => new Intl.DateTimeFormat('en-CA', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  if (day(ms) === day(nowMs)) return formatClock(ms, timeZone);
  return new Intl.DateTimeFormat('ko-KR', { ...opts, month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms),
  );
}

/** "11월 21일 (토)" — solved.ac 날짜 문자열을 사람이 읽기 좋게 */
export function formatDayKey(dayKey) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${dayKey}T00:00:00Z`),
  );
}

export const ERROR_TEXT = Object.freeze({
  [ERROR_CODES.NOT_FOUND]: {
    title: '사용자를 찾을 수 없어요',
    detail: 'solved.ac 핸들을 확인해주세요. 새 solved.ac에서는 핸들이 백준 아이디와 다를 수 있어요.',
  },
  [ERROR_CODES.AUTH]: {
    title: 'API 키를 확인해주세요',
    detail: 'solved.ac가 클라이언트 ID/시크릿을 받아주지 않았어요. 설정에서 다시 입력해주세요.',
  },
  [ERROR_CODES.BLOCKED]: {
    title: 'solved.ac 보안 확인에 막혔어요',
    detail: 'Cloudflare 보안 확인 때문에 요청이 거부됐어요. 잠시 뒤 자동으로 다시 시도해요.',
  },
  [ERROR_CODES.RATE_LIMITED]: {
    title: '요청이 너무 많아요',
    detail: 'solved.ac가 정한 시간이 지나면 자동으로 다시 확인해요.',
  },
  [ERROR_CODES.NETWORK]: {
    title: 'solved.ac에 연결할 수 없어요',
    detail: '네트워크 상태를 확인해주세요. 자동으로 다시 시도해요.',
  },
  [ERROR_CODES.HTTP]: {
    title: 'solved.ac가 응답하지 않아요',
    detail: '서버 점검 중일 수 있어요. 자동으로 다시 시도해요.',
  },
  [ERROR_CODES.PARSE]: {
    title: 'solved.ac 응답을 해석하지 못했어요',
    detail: 'solved.ac가 바뀌었을 수 있어요. 확장 프로그램 업데이트를 확인해주세요.',
  },
  [ERROR_CODES.REJECTED]: {
    title: 'solved.ac가 요청을 거절했어요',
    detail: '핸들이 올바른지 설정에서 확인해주세요. 핸들이 맞는데도 계속되면 확장 프로그램 업데이트를 확인해주세요.',
  },
  [ERROR_CODES.CLOCK]: {
    title: '컴퓨터 시계를 확인해주세요',
    detail: '컴퓨터 시계가 하루 넘게 틀려서 solved.ac의 오늘 날짜를 정할 수 없어요. 시간을 자동으로 맞추도록 설정해주세요.',
  },
});

/**
 * 내 시계와 서버 시계 보정값(clockSkewMs)이 서로 다른 solved.ac 날을 가리키는 동안(06:00 무렵 시계 차이만큼의 구간),
 * 그 구간이 시작된 뒤로 서버 응답으로 시계 차이를 다시 잰 적이 없으면 '오늘'을 확신할 수 없다
 * (그 사이 시계를 고쳤다면 예전 보정값이 어제를 오늘로 보이게 할 수 있다).
 * 이 구간에서는 시계 차이를 잰 지 DAY_EVIDENCE_FRESH_MS(2분)가 지나면 다시 불확실해지고(절전 중에 시계를 고쳤을 수 있다),
 * 마지막 확인 요청이 시각 정보 없이 끝났다면(오프라인 등) 그 전의 측정도 믿지 않는다.
 * 배지·팝업·자동 확인·'오늘은 그만 알림'이 모두 이 규칙 하나를 쓴다.
 * @param {{nowMs: number, clockSkewMs?: number|null, skewCheckedAt?: number|null, lastAttemptTimed?: boolean}} p
 *   nowMs, skewCheckedAt은 내 시계. lastAttemptTimed: 마지막 확인 요청의 응답에 Date가 있었는지(같은 쓰기로 저장)
 */
export function dayUncertain({
  nowMs,
  clockSkewMs,
  skewCheckedAt,
  lastAttemptTimed,
  serverSeenAt,
  evidenceLost = false,
  localSeenAt = null,
  lastAttemptAt = null,
}) {
  // 시계가 뒤로 간 것을 감지한 뒤 아직 시각 정보가 있는 응답을 받지 못했다(그 전의 정보로는 오늘을 정할 수 없다).
  if (evidenceLost === true) return true;
  // 이 확장이 이미 본 내 시각보다 1분 넘게 앞이거나, 이미 본 solved.ac 날보다 앞의 날로 돌아갔다(1분 안쪽의 되돌림도
  // 06:00을 거꾸로 넘으면): 시계가 뒤로 갔다(서비스 워커가 아직 알아채지 못했어도 같게 본다).
  if (typeof localSeenAt === 'number') {
    if (localSeenAt > nowMs + MINUTE_MS) return true;
    if (solvedDayKey(effectiveNow(localSeenAt, clockSkewMs)) > solvedDayKey(effectiveNow(nowMs, clockSkewMs))) return true;
  }
  // 마지막 요청이 이미 지금보다 뒤의 solved.ac 날에 있었다(그 뒤 시계가 06:00을 거꾸로 넘어 돌아감).
  if (
    typeof lastAttemptAt === 'number' &&
    solvedDayKey(effectiveNow(lastAttemptAt, clockSkewMs)) > solvedDayKey(effectiveNow(nowMs, clockSkewMs))
  ) {
    return true;
  }
  const eNow = effectiveNow(nowMs, clockSkewMs);
  // 서버가 이미 더 뒤의 날을 보여 줬다면(그 뒤 시계가 뒤로 감) 지금 날짜는 믿을 수 없다.
  if (typeof serverSeenAt === 'number' && solvedDayKey(eNow) < solvedDayKey(serverSeenAt)) return true;
  if (solvedDayKey(nowMs) === solvedDayKey(eNow)) return false;
  const skew = eNow - nowMs;
  // 두 시계 중 나중에 날이 바뀐 시각(내 시계 기준) = 두 날짜가 갈라지기 시작한 때
  const since = Math.max(nextDayBoundary(nowMs) - DAY_MS, nextDayBoundary(eNow) - DAY_MS - skew);
  const fresh =
    typeof skewCheckedAt === 'number' &&
    skewCheckedAt >= since &&
    nowMs - skewCheckedAt <= dayEvidenceFreshMs(skew) &&
    nowMs >= skewCheckedAt; // 미래 시각의 측정(그 뒤 시계가 뒤로 감)은 믿지 않는다
  return !(fresh && lastAttemptTimed !== false);
}

/** 두 시계가 다른 날을 가리킬 때 시계 차이 측정을 믿는 시간(내 시계가 서버보다 빠를 때) */
export const DAY_EVIDENCE_FRESH_MS = 2 * MINUTE_MS;

/**
 * 측정을 믿는 시간. 내 시계가 서버보다 빠르면(보정 시계가 뒤) 그 사이 시계를 고쳤을 때 어제를 오늘로 볼 수 있으므로 2분,
 * 느리면(보정 시계가 앞; 예: 듀얼 부팅으로 9시간 느림) 고치더라도 보정 시계가 앞서 있어 어제를 오늘로 보지 않으므로
 * 평소처럼 30분(해결 뒤 다시 확인하는 간격)이다 — 시계 차이가 큰 사용자가 매일 몇 시간씩 2분마다 확인하지 않도록.
 */
export function dayEvidenceFreshMs(skewMs) {
  return skewMs > 0 ? SETTLED_RECHECK_MS : DAY_EVIDENCE_FRESH_MS;
}

/**
 * '오늘을 확신할 수 있는지'가 다음에 바뀌는 시각(내 시계): 두 시계 중 하나의 날이 바뀌는 때(구간이 시작/끝남),
 * 또는 구간 안에서 측정이 2분을 넘기는 때. 그때 깨어나 배지를 맞추고 다시 확인한다. 시계 차이가 없으면 null.
 */
export function nextDayCertaintyChangeAt({ nowMs, clockSkewMs, skewCheckedAt, lastAttemptTimed }) {
  const eNow = effectiveNow(nowMs, clockSkewMs);
  const skew = eNow - nowMs;
  if (Math.abs(skew) < 1000) return null;
  // 보정 시계의 06:00은 rollover 알람(+15초)이 맡는다. 내 시계의 06:00도 15초 뒤에 깨어난다(경계 바로 위에서 요청하지 않도록).
  const candidates = [nextDayBoundary(nowMs) + ROLLOVER_CHECK_DELAY_MS];
  if (
    solvedDayKey(nowMs) !== solvedDayKey(eNow) &&
    !dayUncertain({ nowMs, clockSkewMs, skewCheckedAt, lastAttemptTimed }) &&
    typeof skewCheckedAt === 'number'
  ) {
    candidates.push(skewCheckedAt + dayEvidenceFreshMs(skew) + 1000);
  }
  const future = candidates.filter((t) => t > nowMs);
  return future.length ? Math.min(...future) : null;
}

/** 하루 경계 직후 서버 반영 여유: 서버 시각으로 이 안에 만들어진 응답은 잠정(provisional)이다 */
export const ROLLOVER_GRACE_MS = 15 * 1000;
/**
 * 06:00 확인(rollover 알람)과 미룬 깨어남은 여유보다 3초 늦게 잡는다: 내 시계 보정에는 몇 초 안쪽의 오차(초 단위 Date,
 * 작은 차이를 0으로 보는 허용 범위, 요청 시간)가 있어, 정확히 15초에 맞추면 서버 시각으로 여유 안에 닿아 잠정이 되기 쉽다.
 */
export const ROLLOVER_CHECK_DELAY_MS = ROLLOVER_GRACE_MS + 3000;

/**
 * '채점 사이트에서 다시 불러오기'를 연 뒤 다시 확인하는 기간과 간격. solved.ac는 대조를 시작하면 "차이가 있는 문제는
 * 몇 분 안에 반영"한다고 안내하므로, 그동안 몇 번만 더 확인한다(오늘 푼 것이 보이면 멈춘다).
 */
export const REIMPORT_WATCH_MS = 10 * MINUTE_MS;
export const REIMPORT_RECHECK_MS = 2 * MINUTE_MS;

/**
 * 다시 불러오기를 누를 때의 확인 결과 요약(날짜, 오늘 해결 여부·문제 수, 스트릭, 휴가, 최근 7일의 날짜별 문제 수).
 * 반영됐는지 비교하는 데만 쓰고, 반영되거나 기간이 끝나면 지운다.
 */
export function reimportBaseOf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    dayKey: snapshot.dayKey ?? null,
    countedToday: !!snapshot.countedToday,
    todaySolvedCount: snapshot.todaySolvedCount ?? 0,
    currentStreak: snapshot.currentStreak ?? null,
    vacation: !!snapshot.vacation,
    recent: Array.isArray(snapshot.recent) ? snapshot.recent.map((d) => [d?.day ?? null, d?.solvedCount ?? 0]) : [],
  };
}

/**
 * 누를 때(base)와 비교해 다시 불러오기가 반영됐는지. 같은 날이면 오늘 해결 여부·문제 수·스트릭·휴가·최근 기록 중 하나라도
 * 바뀌면, 그사이 06:00이 지났다면 겹치는 날의 문제 수가 바뀌었거나 새 날에 푼 것이 보이면 반영된 것으로 본다
 * (날이 바뀌어 최근 7일 창이 밀린 것만으로는 반영으로 보지 않는다).
 */
export function reimportReflected(base, snapshot) {
  const now = reimportBaseOf(snapshot);
  if (!base || !now) return false;
  const before = new Map(Array.isArray(base.recent) ? base.recent : []);
  const overlapChanged = now.recent.some(([day, n]) => before.has(day) && before.get(day) !== n);
  if (now.dayKey === base.dayKey) {
    return (
      overlapChanged ||
      now.countedToday !== base.countedToday ||
      now.todaySolvedCount !== base.todaySolvedCount ||
      now.currentStreak !== base.currentStreak ||
      now.vacation !== base.vacation
    );
  }
  return overlapChanged || (now.countedToday && !snapshot.provisional);
}

/** 다시 불러오기 기다림이 끝났는지: 기간이 지났거나, 기록이 이상하거나, 같은 핸들의 확인 결과에 반영됐다 */
export function reimportWatchDone({ watch, snapshot, nowMs }) {
  if (!watch || typeof watch !== 'object') return false;
  if (typeof watch.since !== 'number' || typeof watch.until !== 'number') return true;
  if (nowMs >= watch.until || watch.since > nowMs + MINUTE_MS || watch.until - watch.since > REIMPORT_WATCH_MS) return true;
  // 다른 핸들의 확인 결과로는 끝내지 않는다(핸들을 막 바꾼 경우 등).
  const snap = snapshot && sameHandle(snapshot.handle, watch.handle) ? snapshot : null;
  if (!snap) return false;
  // 누른 뒤 새로 받은(잠정이 아닌) 결과만 반영 여부를 정한다(누를 때 이미 있던 결과로 끝내지 않도록).
  if (snap.provisional) return false;
  if (Object.hasOwn(watch, 'baseFetchedAt') && snap.fetchedAt === watch.baseFetchedAt) return false;
  const base = watch.base && typeof watch.base === 'object' ? watch.base : null;
  if (base) return reimportReflected(base, snap);
  // 누를 때 오늘 정보가 없었다면(06:00 직후 등) 그날 이후에 푼 것이 보일 때 끝낸다.
  return typeof watch.dayKey === 'string' && snap.dayKey >= watch.dayKey && !!snap.countedToday && !snap.provisional;
}

/**
 * 다시 불러오기 확인을 할 수 있는 가장 이른 때(내 시계): 429 대기, 백오프, 실패 뒤 재시도 시각 중 가장 늦은 때.
 * 서비스 워커의 예약과 팝업의 안내가 같은 계산을 쓴다.
 */
export function reimportNotBefore({ settings, handle, snapshot, lastError, backoffUntil, rateLimitedUntil, lastAttemptAt, nowMs }) {
  const retryAt = nextRetryAt({ settings, handle, snapshot, lastError, backoffUntil, rateLimitedUntil, lastAttemptAt });
  return Math.max(
    typeof rateLimitedUntil === 'number' ? rateLimitedUntil : 0,
    typeof backoffUntil === 'number' && backoffUntil > nowMs ? backoffUntil : 0,
    retryAt ?? 0,
  );
}

/**
 * 다시 불러오기를 기다리는 중이면 다음 확인 시각(내 시계), 아니면 null.
 * @param {{watch?: {handle: string, since: number, until: number, base?: string|null}|null, handle: string,
 *          statusKind: string, snapshot?: object|null, lastAttemptAt?: number|null, notBefore?: number|null,
 *          nowMs: number}} p
 *   확인 결과가 누른 때와 달라졌거나(반영됨), 다른 핸들의 것이거나, 기간이 지났으면 null.
 *   notBefore: 요청할 수 있는 가장 이른 때(429 대기·백오프·실패 뒤 재시도). 그 전에는 깨어나지 않고, 기간을 넘기면 null.
 *   시계가 뒤로 가 기록이 미래에 있으면 믿지 않는다.
 */
export function reimportRecheckAt({ watch, handle, statusKind, snapshot, lastAttemptAt, notBefore = null, nowMs }) {
  if (!watch || typeof watch !== 'object' || typeof watch.since !== 'number' || typeof watch.until !== 'number') return null;
  if (!sameHandle(watch.handle, handle)) return null;
  if (statusKind === 'setup') return null;
  if (reimportWatchDone({ watch, snapshot, nowMs })) return null;
  const last = typeof lastAttemptAt === 'number' && lastAttemptAt <= nowMs ? Math.max(lastAttemptAt, watch.since) : watch.since;
  const next = Math.max(last + REIMPORT_RECHECK_MS, nowMs, typeof notBefore === 'number' ? notBefore : 0);
  return next < watch.until ? next : null;
}

/** 지금 다시 불러오기 확인을 할 때인지(그때는 최근 정보가 있어도 확인한다 — 요청 제한·백오프는 지킨다) */
export function reimportDue(p) {
  const t = reimportRecheckAt(p);
  return t !== null && t <= p.nowMs + 1000;
}

/** solved.ac 날짜(YYYY-MM-DD)가 시작되는 시각(그날 06:00 KST)의 epoch ms */
export function dayStartMs(dayKey) {
  return Date.parse(`${dayKey}T06:00:00+09:00`);
}

/**
 * 응답이 만들어진 시각: 서버 Date 헤더(초 단위, 내 시계와 하루 안으로 맞을 때)를 먼저 쓰고, 없으면 보정한 헤더 수신 시각.
 * 06:00 직후 반영 여유를 지났는지는 이것으로 정한다(내 시계 보정의 오차와 상관없이).
 */
export function responseMadeAt(dateHeader, correctedHeadersAtMs) {
  const serverMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(serverMs) && Math.abs(serverMs - correctedHeadersAtMs) <= MAX_CLOCK_SKEW_MS
    ? serverMs
    : correctedHeadersAtMs;
}

/** 이 날짜(dayKey)의 응답이 그날 06:00 직후 서버 반영 여유 안에 만들어졌는지 */
export function madeInRolloverGrace(madeAtMs, dayKey) {
  return madeAtMs - dayStartMs(dayKey) < ROLLOVER_GRACE_MS;
}

/**
 * 깨어날 시각(내 시계)이 보정 시계로 06:00 직후의 서버 반영 여유 안이면 여유가 끝나는 때(rollover 알람과 같은 때)로
 * 미룬다 — 여유 안에서 요청해 어제의 정보를 오늘 것으로 받지 않도록.
 */
export function deferPastRolloverGrace(whenMs, clockSkewMs) {
  const skew = effectiveNow(0, clockSkewMs);
  const eWhen = whenMs + skew;
  const dayStart = nextDayBoundary(eWhen) - DAY_MS;
  return eWhen - dayStart < ROLLOVER_CHECK_DELAY_MS ? dayStart + ROLLOVER_CHECK_DELAY_MS - skew : whenMs;
}

/** 내 시계와 서버 시계 보정값이 서로 다른 solved.ac 날을 가리키는지(06:00 무렵 시계 차이만큼의 구간) */
export function daysDisagree(nowMs, clockSkewMs) {
  return solvedDayKey(nowMs) !== solvedDayKey(effectiveNow(nowMs, clockSkewMs));
}

/**
 * 시계 오류를 기록한 뒤 내 시계가 고쳐진 것으로 보이는지. 그때 본 서버 시각(serverAt)과 내 시계(localAt)로 판단한다:
 * 느린 시계였다면 지금 내 시계가 그 서버 시각을 따라잡았고, 빠른 시계였다면 그때의 내 시계보다 뒤로 갔다.
 * (429 대기 때문에 다시 확인할 수 없는 동안, 이미 고친 시계를 계속 고치라고 하지 않기 위해 쓴다.)
 */
export function clockErrorLooksFixed(problem, localNowMs) {
  if (!problem || typeof problem !== 'object') return false;
  if (problem.code !== undefined && problem.code !== ERROR_CODES.CLOCK) return false;
  if (problem.fixed === true) return true; // 한 번 고친 것으로 확인했으면(시간이 더 지나도) 그대로 둔다
  const { serverAt, localAt } = problem;
  if (typeof serverAt !== 'number' || typeof localAt !== 'number') return false;
  const offset = serverAt - localAt;
  if (Math.abs(offset) <= MAX_CLOCK_SKEW_MS) return false;
  // 느린 시계: 내 시계가 그때의 서버 시각을 따라잡음. 빠른 시계: 남은 차이가 하루 안이 될 만큼 뒤로 감
  // (흐른 시간이 없다고 볼 때. 일부만 고친 것은 고친 것으로 보지 않는다).
  return offset > 0 ? localNowMs >= serverAt - MINUTE_MS : localNowMs < localAt + offset + MAX_CLOCK_SKEW_MS;
}

/**
 * 서버 시각이 내 시계가 하루 넘게 틀렸다고 보여 준 기록(clockProblem {serverAt, localAt, fixed?})이 아직 유효한지.
 * 시각 정보가 있는 다음 응답이 정상 범위면 지워지고, 응답 없이 실패해도 그대로 남는다.
 */
export function clockProblemActive(problem, localNowMs) {
  return !!problem && typeof problem === 'object' && !clockErrorLooksFixed(problem, localNowMs);
}

/** 서버 Date 헤더와 내 시계가 하루 넘게 다른지(이 경우 날짜 계산을 믿을 수 없다) */
export function clockTooFarOff(dateHeader, headersAtMs) {
  const serverMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(serverMs) && Math.abs(serverMs - headersAtMs) > MAX_CLOCK_SKEW_MS;
}

export function errorText(code) {
  return ERROR_TEXT[code] ?? ERROR_TEXT[ERROR_CODES.HTTP];
}

export const SETUP_TEXT = Object.freeze({
  handle: { title: 'solved.ac 핸들을 설정해주세요', detail: '아래 설정에 핸들과 API 키를 입력하고 저장하면 자동으로 확인을 시작해요.' },
  migrated: {
    title: '새 solved.ac에 맞춰 다시 설정해주세요',
    detail: 'v2.0으로 업데이트되었어요. 핸들(백준 아이디와 다를 수 있어요)과 API 키를 확인하고 저장해주세요.',
  },
  credentials: {
    title: 'solved.ac API 키가 필요해요',
    detail: '새 solved.ac API는 앱 등록이 필요해요. 설정에서 클라이언트 ID와 시크릿을 입력해주세요.',
  },
});

export function setupText(status) {
  if (status.missing === 'credentials') return SETUP_TEXT.credentials;
  return status.migrated ? SETUP_TEXT.migrated : SETUP_TEXT.handle;
}

/** 툴바 배지 */
export function badgeFor(status) {
  switch (status.kind) {
    case 'solved':
      return { text: '✓', color: '#2e7d32' };
    case 'unsolved':
      return { text: '!', color: '#d32f2f' };
    case 'vacation':
      return { text: '휴', color: '#1565c0' };
    case 'error':
      return { text: '?', color: '#616161' };
    case 'setup':
      return { text: '…', color: '#ef6c00' };
    default:
      return { text: '', color: '#616161' };
  }
}

/** 툴바 아이콘에 마우스를 올렸을 때 보이는 제목 */
export function actionTitleFor(status, handle) {
  const base = 'Solved Streak Checker';
  switch (status.kind) {
    case 'setup':
      return `${base}\n${setupText(status).title}`;
    case 'checking':
      return `${base}\n${handle} · 확인 중`;
    case 'solved':
      return `${base}\n${handle} · 오늘 해결 완료 (${formatNumber(status.snapshot.currentStreak)}일 연속)`;
    case 'unsolved':
      return `${base}\n${handle} · 오늘 아직 안 풀었어요`;
    case 'vacation':
      return `${base}\n${handle} · 스트릭 휴가 중`;
    case 'error':
      return `${base}\n${handle} · ${errorText(status.code).title}`;
    default:
      return base;
  }
}

/** 설정에서 고쳐야 하는 오류(알림의 첫 버튼이 설정을 연다) */
export const SETTINGS_ERRORS = new Set([ERROR_CODES.NOT_FOUND, ERROR_CODES.AUTH, ERROR_CODES.REJECTED]);

/**
 * 데스크톱 알림 내용
 * @param {number} nowMs 서버 시계로 보정한 지금
 * @param {number} [skewMs] 서버 시계 - 내 시계 (시각은 팝업처럼 내 시계로 보여준다)
 */
export function notificationContent(kind, status, handle, nowMs, skewMs = 0) {
  if (kind === 'unsolved') {
    const snap = status.snapshot;
    const deadline = nextDayBoundary(nowMs);
    const left = deadline - nowMs;
    const remaining = formatDuration(left);
    let title;
    if (!status.atRisk) title = '📝 오늘의 문제를 풀어볼까요?';
    else if (left <= URGENT_REMAINING_MS) title = `🔥 ${formatNumber(snap.currentStreak)}일 스트릭이 끊기기 직전이에요!`;
    else title = `🔥 오늘 문제를 풀고 ${formatNumber(snap.currentStreak)}일 스트릭을 이어가세요`;
    const lines = [`${handle}님, 오늘 아직 문제를 풀지 않았어요.`, `마감 ${formatKstClock(deadline)}까지 ${remaining} 남았어요.`];
    if (status.stale) lines.push(`(최근 확인 실패 · ${formatClock(snap.fetchedAt - skewMs)} 기준)`);
    return { title, message: lines.join('\n'), requireInteraction: true, primaryButton: 'solved.ac 열기' };
  }
  if (kind === 'setup') {
    const t = setupText(status);
    return {
      title: `⚙️ ${t.title}`,
      message: `스트릭을 확인하려면 설정이 필요해요.\n${t.detail}`,
      requireInteraction: false,
      primaryButton: '설정 열기',
    };
  }
  const t = errorText(status.code);
  const needsSettings = SETTINGS_ERRORS.has(status.code);
  return {
    title: `⚠️ ${t.title}`,
    message: `${handle}님의 스트릭 상태를 확인하지 못했어요.\n${t.detail}`,
    requireInteraction: false,
    primaryButton: needsSettings ? '설정 열기' : 'solved.ac 열기',
  };
}

/** 알림의 첫 번째 버튼/본문 클릭이 설정을 열어야 하는지 (shownCause: 띄운 알림의 원인) */
export function notificationOpensSettings(shownKind, shownCause) {
  if (shownKind === 'setup') return true;
  return shownKind === 'error' && typeof shownCause === 'string' && SETTINGS_ERRORS.has(shownCause.slice('error:'.length));
}

const NOTIFICATION_ID_PREFIX = 'ssc';

/**
 * 띄우는 알림마다 고유 ID를 만든다. ID에 원인·solved.ac 날짜·핸들을 담아, 나중에 그 알림을 눌렀을 때
 * (그 사이 다른 알림으로 바뀌었더라도) 그 알림 자신에 맞게 처리한다.
 */
export function makeNotificationId({ cause, dayKey, handle, seq }) {
  return [NOTIFICATION_ID_PREFIX, seq, dayKey, handle || '-', cause].join('|');
}

/** @returns {{kind: 'unsolved'|'error'|'setup', cause: string, dayKey: string, handle: string} | null} */
export function parseNotificationId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split('|');
  if (parts.length < 5 || parts[0] !== NOTIFICATION_ID_PREFIX || !isDayString(parts[2])) return null;
  const cause = parts.slice(4).join('|');
  const kind = cause === 'unsolved' ? 'unsolved' : cause.startsWith('error:') ? 'error' : cause.startsWith('setup:') ? 'setup' : null;
  if (!kind) return null;
  return { kind, cause, dayKey: parts[2], handle: parts[3] === '-' ? '' : parts[3] };
}

/** 이 확장이 띄운 알림인지(예전 버전의 고정 ID 포함) */
export function isOwnNotificationId(id) {
  return parseNotificationId(id) !== null || id === 'streak-reminder' || id === 'solvedacStreakCheckNotification';
}
