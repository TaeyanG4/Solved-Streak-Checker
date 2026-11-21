// background.js — 서비스 워커 (ES module)
//
// 1. solved.ac 공식 API(v4)로 스트릭 정보를 가져온다. 모든 요청에 사용자가 등록한 앱의
//    클라이언트 ID/시크릿(x-client-id / x-client-secret)을 보낸다.
// 2. 가져온 정보로 툴바 배지와 데스크톱 알림을 갱신한다.
// 3. 팝업의 요청(새로고침, 설정 저장, 오늘 알림 끄기, 데이터 지우기)을 처리한다.
//
// 알람: poll(확인 주기), rollover(매일 06:00:18 KST), wake(알림 시작/다시 알림/재시도/정보 만료 시각)

import * as core from './lib/core.js';
import { requestRaw } from './lib/api.js';

const ALARM_POLL = 'poll';
const ALARM_ROLLOVER = 'rollover';
const ALARM_WAKE = 'wake';
const LEGACY_ALARMS = ['solvedacStreakCheckAlarm', 'dailyStatusResetAlarm'];
const SCHEMA_VERSION = 2;

/** 하루 경계 직후 이만큼 기다렸다가 확인한다(서버 반영 여유 15초 + 시계 보정 오차 여유 3초). */
const ROLLOVER_DELAY_MS = core.ROLLOVER_CHECK_DELAY_MS;
/** Chrome 알람의 최소 지연 */
const MIN_ALARM_DELAY_MS = 30 * 1000;
/** 내 시계가 이보다 많이 뒤로 갔으면(시계를 고친 경우 등) 내 시계로 적어 둔 시각들을 옮긴다. */
const CLOCK_JUMP_MS = 60 * 1000;

const LOCAL_KEYS = [
  core.CREDENTIALS_KEY, // {clientId, clientSecret} — 이 브라우저에만 저장
  'credRev', // 키를 저장할 때마다 바뀌는 리비전(팝업이 폼을 채운 뒤 키가 바뀌었는지 확인)
  'verifyPending', // 저장한 뒤 아직 solved.ac에 확인하지 못한 키의 리비전(429 대기 등)
  'snapshot', // 마지막으로 성공한 조회 결과 (handle 포함)
  'lastError', // 마지막 실패 {handle, code, at, httpStatus, serverCode}
  'stateHandle', // 아래 '핸들별 상태'가 어느 핸들의 것인지
  'consecutiveFailures',
  'codeFailures', // 같은 원인으로 연속 실패한 횟수(백오프 계산용)
  'failingSince', // 연속 실패가 시작된 시각(서버 시계)
  'lastAttemptAt', // 마지막 요청 시각(내 시계)
  'expectedRetryAt', // 실패 뒤 다음 자동 재시도 예정 시각(내 시계) — 절전 감지용
  'clockSkewMs', // 서버 시계 - 내 시계
  'backoffUntil', // 보안 확인/인증/시계 오류 뒤 자동 확인을 쉬는 시각(내 시계)
  'rateLimits', // 429 대기 {클라이언트 ID: {at, server, ms, shift, seen}} — 핸들이 아니라 앱(클라이언트) 단위
  'skewCheckedAt', // 서버 응답으로 시계 차이를 마지막으로 잰 시각(내 시계)
  'clockProblem', // 서버 시각이 내 시계가 하루 넘게 틀렸다고 보여 준 기록 {serverAt, localAt, fixed?}
  'lastAttemptTimed', // 마지막 확인 요청의 응답에 Date(시각 정보)가 있었는지 — lastAttemptAt과 같은 쓰기로 저장
  'serverSeenAt', // 응답 Date로 본 가장 늦은 서버 시각(시계가 뒤로 가도 이미 지난 서버 날을 '오늘'로 보지 않도록)
  'dayEvidenceLost', // 시계가 뒤로 간 것을 감지했고 아직 시각 정보가 있는 응답을 받지 못함(그동안 오늘을 정하지 않는다)
  'localSeenAt', // 이 확장이 본 가장 늦은 내 시각(30초 단위로 적음) — 시계가 뒤로 간 것을 알아채는 데 쓴다
  'retryOwed', // 429로 미룬 확인이 남음(대기가 끝나면 최근 정보가 있어도 한 번 확인한다) — 다음 확인 결과가 지운다
  'recheckAt', // 06:00 바로 앞뒤라 곧 다시 확인할 시각(내 시계)
  'resetPending', // 진행 중인 '모든 데이터 지우기' {sync: 지울 동기화 항목과 그때 값} — 끊기면 다음 시작(또는 다음 저장/확인) 때 마저 지운다
  'pendingSave', // 핸들과 키를 함께 바꾸는 저장의 중간 상태 {handle, creds, rev}
  'notifHistory', // 알림 기록 {reminder, alerts, setup}
  'shownId', // 지금 띄워 둔 알림의 ID(원인·날짜·핸들이 들어 있음)
  'notifPending', // 띄우는 중인 알림 {id, history, fallback} — 띄우다 멈췄을 때 기록을 맞추기 위해
  'snoozeDayKey', // '오늘은 그만 알림'을 누른 solved.ac 날짜
  'reimportWatch', // '채점 사이트에서 다시 불러오기'를 연 뒤 잠깐 더 자주 확인하는 기간 {handle, since, until}
  'notificationError',
  'schemaVersion',
];
/**
 * 핸들별 상태: 핸들이 바뀌면 지운다(알림 기록 중 기기 단위인 '설정 알림'은 남긴다). 오류 기록도 핸들별이다(핸들을 바꿨다가
 * 돌아왔을 때 횟수·시각 없이 예전 오류만 되살아나지 않도록).
 */
const HANDLE_SCOPED_LOCAL_KEYS = core.HANDLE_SCOPED_KEYS;
/** 이 확장이 본 내 시각을 적는 간격(쓰기를 줄이기 위해) */
const LOCAL_SEEN_STEP_MS = 30 * 1000;
/** 키가 바뀌면 이전 키의 실패 기록은 의미가 없다 */
const FAILURE_STATE_KEYS = ['lastError', 'consecutiveFailures', 'codeFailures', 'failingSince', 'backoffUntil', 'expectedRetryAt'];

const POLICY_RANK = { auto: 0, page: 1, force: 2 };

// ---------------------------------------------------------------------------
// 저장소
// ---------------------------------------------------------------------------

async function getSyncRaw() {
  return chrome.storage.sync.get([...core.SETTINGS_KEYS, ...core.LEGACY_SYNC_KEYS]);
}

/** 실제로 쓸 설정(v2 값이 없으면 v1 값). */
async function getSettings() {
  return core.effectiveSettings(await getSyncRaw());
}

/** 로컬 상태. 핸들별 상태가 지금 핸들의 것이 아니면(핸들 바꾸기가 끝나지 않음) 그 값들은 빼고 돌려준다. */
async function getLocal(handle = undefined) {
  const local = await chrome.storage.local.get(LOCAL_KEYS);
  return handle === undefined ? local : core.ownedState(local, handle);
}

function credentialsOf(local) {
  return core.normalizeCredentials(local[core.CREDENTIALS_KEY]);
}

function nowInfo(local) {
  const now = Date.now();
  return { now, eNow: core.effectiveNow(now, local.clockSkewMs) };
}

function statusOf(syncRaw, local, eNow) {
  const creds = credentialsOf(local);
  return core.deriveStatus({
    settings: core.effectiveSettings(syncRaw),
    credentialsReady: core.hasCredentials(creds),
    legacyHandle: core.legacyHandleFrom(syncRaw),
    snapshot: local.snapshot,
    lastError: local.lastError,
    rateLimited: core.activeRateLimit(local.rateLimits, creds.clientId, Date.now()) !== null,
    clockProblem: core.clockProblemActive(local.clockProblem, Date.now()),
    dayUncertain: dayUncertainNow(local),
    nowMs: eNow,
  });
}

/** 시계를 고친 뒤 아직 서버 응답이 없어 오늘이 어느 날인지 확신할 수 없는지 */
function dayUncertainNow(local) {
  return core.dayUncertain({
    nowMs: Date.now(),
    clockSkewMs: local.clockSkewMs,
    skewCheckedAt: local.skewCheckedAt,
    lastAttemptTimed: local.lastAttemptTimed,
    serverSeenAt: local.serverSeenAt,
    evidenceLost: local.dayEvidenceLost === true,
    localSeenAt: local.localSeenAt,
    lastAttemptAt: local.lastAttemptAt,
  });
}

/** 오늘이 어느 날인지 알고 있는지(시계 문제도 없음) — '오늘은 그만 알림' 같은 날짜를 정하는 동작에 쓴다 */
function dayKnownNow(local) {
  return !dayUncertainNow(local) && !core.clockProblemActive(local.clockProblem, Date.now());
}

/**
 * 응답 헤더를 받는 즉시(본문을 읽기 전에) 기기 단위 시각 정보와 429 대기를 한 번의 쓰기로 저장한다 — 본문을 받는 사이
 * 브라우저가 닫히거나, 저장 확인처럼 결과를 기록하지 않는 요청이어도 이미 받은 대기와 시계 근거를 잃지 않도록.
 * - 시계 문제(clockProblem): Date가 하루 넘게 틀리면 근거를 남기고, 정상 범위면 지운다.
 * - 시계 차이(clockSkewMs, skewCheckedAt)와 본 가장 늦은 서버 시각(serverSeenAt).
 * - 429면 이 앱(클라이언트)의 대기 기록과 '미룬 확인이 남음' 표시.
 * - 시계 차이를 잴 수 있으면 '시계가 뒤로 가 오늘을 정할 수 없음' 표시를 지운다.
 * @returns {Promise<boolean>} 429 대기를 기록했는지
 */
async function recordResponseHeaders(meta, clientId, prior) {
  const update = {};
  const headersAt = meta.headersAt;
  const serverAt = meta.date ? Date.parse(meta.date) : Number.NaN;
  let measured = null;
  if (Number.isFinite(serverAt)) {
    update.clockProblem = core.clockTooFarOff(meta.date, headersAt) ? { serverAt, localAt: headersAt } : null;
    // 본 가장 늦은 서버 시각. 새 응답이 그보다 1분 넘게 이르면 예전 값이 잘못된 것(서버/중계 시계의 일시 오류)이므로
    // 새 값으로 바꾼다(서버 시각이 기준이다). 그 밖에는 응답 사이의 작은 흔들림만 무시한다.
    const seen = typeof prior.serverSeenAt === 'number' ? prior.serverSeenAt : 0;
    update.serverSeenAt = seen - serverAt > 60 * 1000 ? serverAt : Math.max(serverAt, seen);
    measured = core.computeClockSkew(meta.date, meta.sentAt, headersAt);
    if (measured !== null) Object.assign(update, { clockSkewMs: measured, skewCheckedAt: headersAt, dayEvidenceLost: null });
  }
  let until = null;
  if (meta.status === 429) {
    const retryAfterSec = core.parseRetryAfter(meta.retryAfter, Number.isFinite(serverAt) ? serverAt : headersAt);
    const entry = core.rateLimitEntry(retryAfterSec ?? undefined, headersAt, meta.date);
    update.rateLimits = core.withRateLimit(prior.rateLimits, clientId, entry, headersAt);
    update.retryOwed = true;
    until = core.rateLimitEnd(entry, headersAt);
  }
  if (Object.keys(update).length) await chrome.storage.local.set(update);
  if (until !== null) await bestEffort('대기 종료 알람', () => ensureWakeBy(until));
  // 06:00 KST 알람을 새 시계 차이에 맞춘다(저장이 막힌 확인 요청이어도). 1분 넘게 다를 때만 다시 건다.
  if (measured !== null) await bestEffort('06:00 알람', async () => scheduleAlarms(await getSettings()));
  return until !== null;
}

/** 실패해도 다른 처리를 막지 않는 Chrome API 호출 */
async function bestEffort(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[SSC] ${label} 실패`, e);
    return undefined;
  }
}

/**
 * 핸들별 상태(알림 기록, 오늘 그만 알림, 실패 횟수, 띄워 둔 알림)가 지금 핸들의 것인지 확인하고, 아니면 지운다.
 * 기기 단위인 설정 알림 기록(원인당 한 번)은 남긴다.
 */
async function ensureStateOwner(handle) {
  const { stateHandle, notifHistory, shownId, notifPending } = await chrome.storage.local.get([
    'stateHandle',
    'notifHistory',
    'shownId',
    'notifPending',
  ]);
  if (stateHandle === handle || (handle && core.sameHandle(stateHandle, handle))) {
    if (stateHandle !== handle) await chrome.storage.local.set({ stateHandle: handle }); // 대소문자만 바뀜
    return;
  }
  // 기기 단위 설정 알림 기록은 남긴다. 띄우다 멈춘 알림이 있으면 먼저 맞춘다: 떠 있으면 띄운 것으로 보고 그 설정 알림
  // 원인을 남긴다(핸들이 바뀌어도 같은 설정 알림을 두 번 띄우지 않도록). 알림 목록을 읽지 못해 알 수 없으면 설정 알림
  // 부분만 '띄우는 중'으로 남겨 두고 목록을 읽을 수 있을 때 맞춘다(띄우지 못한 설정 알림을 띄운 것으로 치지 않도록).
  const setup = new Set(notifHistory?.setup ?? []);
  let keepPending = null;
  if (notifPending?.id) {
    const live = await bestEffort('알림 목록', () => chrome.notifications.getAll());
    const pendingSetup = (notifPending.history?.setup ?? []).filter((c) => !setup.has(c));
    if (live && Object.hasOwn(live, notifPending.id)) for (const c of pendingSetup) setup.add(c);
    else if (!live && pendingSetup.length) {
      keepPending = {
        id: notifPending.id,
        setupOnly: true,
        history: { setup: [...setup, ...pendingSetup] },
        fallback: { setup: [...setup] },
      };
    }
  }
  // 새 주인, 지운 핸들별 상태, 남길 설정 알림 기록을 한 번의 쓰기로 바꾼다(중간에 끊겨 다른 핸들의 '오늘은 그만 알림'이
  // 새 핸들에 남거나 설정 알림 기록을 잃지 않도록). 지운 항목은 null로 적고, 그다음 정리한다(null은 없는 것과 같게 다룬다).
  const cleared = HANDLE_SCOPED_LOCAL_KEYS.filter((k) => k !== 'notifHistory' && !(keepPending && k === 'notifPending'));
  await chrome.storage.local.set({
    ...Object.fromEntries(cleared.map((k) => [k, null])),
    stateHandle: handle,
    notifHistory: { setup: [...setup] },
    ...(keepPending && { notifPending: keepPending }),
  });
  // 이전 핸들의 알림은 위 기록을 남긴 뒤에 닫는다(먼저 닫았는데 쓰기가 실패하면, 띄운 증거가 사라져 같은 설정 알림을 다시
  // 띄운다). 띄운 것인지 아직 모르는 설정 알림은 닫지 않는다(나중에 떠 있는지 보고 맞춘다).
  if (shownId && shownId !== keepPending?.id) await bestEffort('이전 핸들 알림 닫기', () => chrome.notifications.clear(shownId));
  await bestEffort('핸들별 상태 정리', () => chrome.storage.local.remove(cleared));
}

/**
 * 띄우는 중으로 남은 알림이 실제로 떴을 때의 알림 기록. 핸들이 바뀌면서 설정 알림 부분만 남긴 기록(setupOnly)이면
 * 지금 기록에 그 설정 알림 원인만 더한다.
 */
function deliveredHistory(pending, current) {
  if (!pending?.setupOnly) return pending?.history ?? {};
  const setup = new Set([...(current?.setup ?? []), ...(pending.history?.setup ?? [])]);
  return { ...(current ?? {}), setup: [...setup] };
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 새 API 키를 한 번의 쓰기로 확정한다: 키와 리비전, '아직 확인하지 못함' 표시, 예전 키의 실패 기록(오류·백오프) 지우기,
 * 끊긴 저장 기록 지우기. 중간에 끊겨도 '새 키 + 예전 키의 오류/백오프'처럼 섞인 상태가 남지 않는다.
 */
async function commitCredentials(creds, rev) {
  savedSinceRecovery = true;
  await chrome.storage.local.set({
    [core.CREDENTIALS_KEY]: creds,
    credRev: rev,
    verifyPending: rev,
    pendingSave: null,
    ...Object.fromEntries(FAILURE_STATE_KEYS.map((k) => [k, null])),
  });
}

/**
 * 핸들과 키를 함께 바꾸는 저장이 중간에 끊겼다면 마무리한다. 동기화된 핸들이 저장하려던 핸들이면(동기화 쓰기가 끝남)
 * 그 키로 확정하고, 아니면(동기화 쓰기 전에 끊겼거나, 그 뒤 다른 곳에서 핸들을 또 바꿈) 버린다.
 * 이 기기에 남긴 기록과 지금 핸들만 보므로, 다른 기기의 저장(같은 핸들의 키 교체 등)과 섞이지 않는다.
 */
async function finalizePendingSave() {
  const { pendingSave } = await chrome.storage.local.get('pendingSave');
  if (!pendingSave) return;
  const settings = await getSettings();
  const creds = core.normalizeCredentials(pendingSave.creds);
  if (core.sameHandle(settings.handle, pendingSave.handle) && core.hasCredentials(creds)) {
    await commitCredentials(creds, typeof pendingSave.rev === 'string' ? pendingSave.rev : randomId());
  } else {
    await chrome.storage.local.remove('pendingSave');
  }
}

/**
 * 내 시계로 적어 둔 시각들(마지막 요청, 백오프)을 점검한다. 시계가 뒤로 크게 갔으면(시계를 고친 경우 등) 그만큼 옮겨서,
 * 미래로 남은 시각 때문에 자동 확인이 며칠씩 막히지 않게 한다. 비정상적으로 긴 백오프는 상한으로 자르고, 끝난 429 대기는 지운다.
 */
async function rebaseLocalClock() {
  const local = await chrome.storage.local.get([
    'lastAttemptAt',
    'backoffUntil',
    'rateLimits',
    'expectedRetryAt',
    'lastError',
    'clockSkewMs',
    'clockProblem',
    'serverSeenAt',
    'dayEvidenceLost',
    'localSeenAt',
    'snapshot',
  ]);
  const now = Date.now();
  const update = {};
  let { backoffUntil, expectedRetryAt } = local;
  let jumped = false;
  if (typeof local.lastAttemptAt === 'number' && local.lastAttemptAt > now + CLOCK_JUMP_MS) {
    jumped = true;
    const delta = now - local.lastAttemptAt;
    update.lastAttemptAt = now - CLOCK_JUMP_MS; // 간격 제한에 걸리지 않게(곧바로 다시 확인)
    // 시계 오류 때문에 쉬고 있었다면 사용자가 시계를 고친 것이므로 바로 다시 확인한다.
    if (local.lastError?.code === core.ERROR_CODES.CLOCK) backoffUntil = null;
    else if (typeof backoffUntil === 'number') backoffUntil += delta;
    if (typeof expectedRetryAt === 'number') update.expectedRetryAt = expectedRetryAt + delta;
    // 예전 시계로 잰 서버 시계 차이는 더 맞지 않는다(빠른 시계를 고쳤다면 어제를 오늘로 볼 수 있다).
    // 다음 응답으로 다시 잴 때까지 내 시계를 그대로 쓴다(06:00 알람도 아래에서 다시 건다).
    if (typeof local.clockSkewMs === 'number' && local.clockSkewMs !== 0) update.clockSkewMs = null;
    console.info('[SSC] 시계가 뒤로 바뀐 것을 감지해 대기 시각을 옮겼습니다.', delta);
  }
  // 마지막 요청 뒤 요청 없이 시간이 지났다면(429 대기 중 06:00 확인 등) 그 뒤의 되돌림은 마지막 요청 시각으로 알 수 없다.
  // 이 확장이 본 가장 늦은 내 시각과, 대기 기록마다 마지막으로 확인한 내 시각(익명 대기 포함)으로도 알아챈다.
  const localAhead = typeof local.localSeenAt === 'number' && local.localSeenAt > now + CLOCK_JUMP_MS;
  const waitAhead = core.rateLimitsSeenAhead(local.rateLimits, now, CLOCK_JUMP_MS);
  // 1분 안쪽의 되돌림이라도 이미 본 solved.ac 날보다 앞의 날로 돌아갔다면(06:00을 거꾸로 넘음) 시계가 뒤로 간 것으로 본다.
  const daySkew = core.effectiveNow(0, local.clockSkewMs);
  const seenDay = typeof local.localSeenAt === 'number' ? core.solvedDayKey(local.localSeenAt + daySkew) : null;
  const nowDay = core.solvedDayKey(now + daySkew);
  const attemptDay = typeof local.lastAttemptAt === 'number' ? core.solvedDayKey(local.lastAttemptAt + daySkew) : null;
  const dayBack = (seenDay !== null && seenDay > nowDay) || (attemptDay !== null && attemptDay > nowDay);
  if ((localAhead || waitAhead || dayBack) && !jumped) {
    jumped = true;
    if (typeof local.clockSkewMs === 'number' && local.clockSkewMs !== 0) update.clockSkewMs = null;
    console.info('[SSC] 시계가 뒤로 바뀐 것을 감지했습니다.');
  }
  // 지킬 확인 결과(스냅샷)가 있을 때만 적는다(지운 뒤에는 남기지 않는다).
  if (
    local.snapshot &&
    (typeof local.localSeenAt !== 'number' ||
      localAhead ||
      dayBack ||
      seenDay !== nowDay || // 날이 바뀌면 바로 적는다(06:00을 거꾸로 넘는 되돌림을 알아채도록)
      now - local.localSeenAt >= LOCAL_SEEN_STEP_MS)
  ) {
    update.localSeenAt = now;
  }
  // 시계가 뒤로 갔다면(위에서 감지했거나, 이미 본 서버 시각이 지금 보정 시계보다 1분 넘게 뒤) 그 전에 받은 정보로는
  // 오늘이 어느 날인지 정할 수 없다(맞던 시계를 되돌리면 두 시계가 모두 지난 날을 가리킨다). 시각 정보가 있는 다음 응답이
  // 지울 때까지 남긴다 — 배지, 팝업의 '오늘' 표시, '오늘은 그만 알림'이 모두 이것을 따른다.
  const skewNow = update.clockSkewMs === null ? 0 : core.effectiveNow(0, local.clockSkewMs);
  const seenAhead = typeof local.serverSeenAt === 'number' && local.serverSeenAt > now + skewNow + CLOCK_JUMP_MS;
  if ((jumped || seenAhead) && local.dayEvidenceLost !== true) update.dayEvidenceLost = true;
  // 빠른 시계였던 시계 오류 뒤 내 시계가 실제로 뒤로 갔다면(고침) 그 사실을 남긴다: 시간이 흘러 그때의 내 시계를
  // 지나도 다시 '시계를 확인해주세요'로 보이지 않도록. 느린 시계는 앞으로 고친 것과 시간이 흐른 것을 구별할 수 없으므로
  // 남기지 않는다(다음 서버 응답이 정한다). 다음 확인 결과가 오류 기록을 바꾼다.
  const problem = local.clockProblem;
  if (
    problem &&
    !problem.fixed &&
    typeof problem.serverAt === 'number' &&
    typeof problem.localAt === 'number' &&
    problem.serverAt < problem.localAt &&
    core.clockErrorLooksFixed(problem, now)
  ) {
    update.clockProblem = { ...problem, fixed: true };
  }
  if (typeof backoffUntil === 'number') backoffUntil = Math.min(backoffUntil, now + core.HARD_ERROR_BACKOFF_MAX_MS);
  if ((backoffUntil ?? null) !== (local.backoffUntil ?? null)) update.backoffUntil = backoffUntil ?? null;
  // 429 대기: 대기마다 마지막으로 본 내 시각과 비교해 시계가 뒤로 갔으면 받은 시각을 옮기고, 끝난 대기는 지운다.
  const rebased = core.rebaseRateLimits(local.rateLimits, now);
  if (rebased !== local.rateLimits) update.rateLimits = rebased;
  if (Object.keys(update).length) await chrome.storage.local.set(update);
  // Chrome 알람은 내 시계의 시각으로 예약된다. 시계가 뒤로 가면 확인 주기·06:00 알람이 그만큼 늦게 울리므로 다시 건다.
  if (jumped) await scheduleAlarms(await getSettings(), { resetPoll: true });
}

// ---------------------------------------------------------------------------
// 직렬 실행: 조회/저장/설정 변경 처리가 서로 겹치지 않게 한 줄로 세운다.
// ---------------------------------------------------------------------------

let tail = Promise.resolve();
function serialize(task) {
  const p = tail.then(task);
  tail = p.catch(() => {});
  return p;
}

let pendingRefresh = null;
/**
 * 상태를 새로 조회한다. 아직 시작하지 않은 조회가 대기 중이면 거기에 합친다.
 * @param {'auto'|'page'|'force'} policy force는 간격 제한과 보안 확인 백오프를 무시한다(사용자가 직접 누른 경우).
 *   429 대기 시간은 force도 지킨다.
 */
function refresh(policy = 'auto') {
  if (pendingRefresh) {
    if (POLICY_RANK[policy] > POLICY_RANK[pendingRefresh.policy]) pendingRefresh.policy = policy;
    return pendingRefresh.promise;
  }
  const entry = { policy, promise: null };
  pendingRefresh = entry;
  entry.promise = serialize(() => {
    if (pendingRefresh === entry) pendingRefresh = null;
    return doRefresh(entry.policy);
  });
  return entry.promise;
}

// ---------------------------------------------------------------------------
// 초기화 / 마이그레이션 / 알람
// ---------------------------------------------------------------------------

async function migrate() {
  // v1 설정은 v2 동기화 키로 옮겨 적지 않는다: 읽을 때마다 v2 값이 없으면 v1 값을 쓴다(core.effectiveSettings).
  // 옮겨 적으면 다른 기기의 '모든 데이터 지우기'가 나뉘어 도착할 때 지운 설정이 v1 값으로 되살아날 수 있다.
  // v1 키는 다른 기기(아직 v1이거나 막 업데이트한 기기)를 위해 남긴다.
  const { schemaVersion } = await chrome.storage.local.get('schemaVersion');
  if (schemaVersion !== SCHEMA_VERSION) {
    // 이 기기의 v1 흔적 정리 (실패해도 계속 진행하고, 다음 시작 때 다시 시도한다)
    const removed = await bestEffort('v1 저장값 정리', async () => {
      await chrome.storage.local.remove(core.LEGACY_LOCAL_KEYS);
      return true;
    });
    const cleared = await bestEffort('v1 알람 정리', async () => {
      await Promise.all(LEGACY_ALARMS.map((name) => chrome.alarms.clear(name)));
      return true;
    });
    if (removed && cleared) await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
  }
}

function skewOf(local) {
  return core.effectiveNow(0, local.clockSkewMs);
}

async function scheduleAlarms(settings, { resetPoll = false } = {}) {
  const poll = await chrome.alarms.get(ALARM_POLL);
  // 다음 울릴 시각이 한 주기보다 멀리 있으면(시계가 뒤로 감) 다시 건다.
  const stranded = !!poll && poll.scheduledTime > Date.now() + (settings.checkIntervalMin + 1) * 60 * 1000;
  if (resetPoll || stranded || !poll || poll.periodInMinutes !== settings.checkIntervalMin) {
    await chrome.alarms.create(ALARM_POLL, {
      delayInMinutes: settings.checkIntervalMin,
      periodInMinutes: settings.checkIntervalMin,
    });
  }

  // 하루 경계(06:00 KST)는 서버 시계 기준이므로 내 시계로 바꿔 예약한다.
  const skew = skewOf(await chrome.storage.local.get('clockSkewMs'));
  const when = core.nextRolloverAt(Date.now() + skew, ROLLOVER_DELAY_MS) - skew;
  const rollover = await chrome.alarms.get(ALARM_ROLLOVER);
  // 시계 차이가 몇 초만 바뀌어도 다시 맞춘다(06:00 뒤 15초의 여유가 줄어들지 않도록).
  if (!rollover || Math.abs(rollover.scheduledTime - when) > 2000) {
    await chrome.alarms.create(ALARM_ROLLOVER, { when });
  }
}

/** 알림 시작/다시 알림/재시도/정보 만료 시각에 깨어나도록 한 번짜리 알람을 맞춘다. */
async function scheduleWake(settings, local, status) {
  const { now, eNow } = nowInfo(local);
  const skew = eNow - now;
  const candidates = [];
  const notifyAt = core.nextNotificationCheckAt({
    status,
    settings,
    history: local.notifHistory,
    snoozeDayKey: local.snoozeDayKey,
    nowMs: eNow,
  });
  if (notifyAt !== null) candidates.push(notifyAt - skew);
  // 06:00 바로 앞뒤라 미뤄 둔 재확인
  if (typeof local.recheckAt === 'number' && local.recheckAt > now) candidates.push(local.recheckAt);

  // 오늘을 확신할 수 있는지가 바뀌는 때(시계 차이 구간의 시작/끝, 구간 안에서 측정이 2분을 넘김): 배지를 맞추고 다시 확인한다.
  if (status.kind !== 'setup') {
    const certaintyAt = core.nextDayCertaintyChangeAt({
      nowMs: now,
      clockSkewMs: local.clockSkewMs,
      skewCheckedAt: local.skewCheckedAt,
      lastAttemptTimed: local.lastAttemptTimed,
    });
    if (certaintyAt !== null) candidates.push(certaintyAt);
  }
  if (status.kind !== 'setup') {
    const rateLimitedUntil = core.activeRateLimit(local.rateLimits, credentialsOf(local).clientId, now);
    const retryAt = core.nextRetryAt({
      settings,
      handle: settings.handle,
      snapshot: local.snapshot,
      lastError: local.lastError,
      backoffUntil: local.backoffUntil,
      rateLimitedUntil,
      lastAttemptAt: local.lastAttemptAt,
    });
    if (retryAt !== null) candidates.push(retryAt);
    // '채점 사이트에서 다시 불러오기'를 연 뒤 몇 분 동안의 재확인(결과가 바뀌면 멈춘다). 요청할 수 있는 때(429 대기·
    // 백오프·실패 뒤 재시도) 전에는 깨어나지 않는다 — 그동안 30초마다 헛되이 깨어나지 않도록.
    const reimportAt = core.reimportRecheckAt({
      watch: local.reimportWatch,
      handle: settings.handle,
      statusKind: status.kind,
      snapshot: local.snapshot,
      lastAttemptAt: local.lastAttemptAt,
      notBefore: core.reimportNotBefore({
        settings,
        handle: settings.handle,
        snapshot: local.snapshot,
        lastError: local.lastError,
        backoffUntil: local.backoffUntil,
        rateLimitedUntil,
        lastAttemptAt: local.lastAttemptAt,
        nowMs: now,
      }),
      nowMs: now,
    });
    if (reimportAt !== null) candidates.push(reimportAt);
    // 429 대기가 끝나면 핸들이 바뀌었더라도(또는 새 키를 아직 확인하지 못했어도) 바로 확인한다. 단, 지금 핸들의 마지막
    // 확인이 429였다면 재시도는 nextRetryAt(대기 끝과 재시도 간격 중 늦은 때)을 따른다.
    const lastWasRateLimited = failingNow(local, settings.handle) && local.lastError.code === core.ERROR_CODES.RATE_LIMITED;
    if (rateLimitedUntil !== null) {
      if (!lastWasRateLimited || retryAt === null) candidates.push(rateLimitedUntil);
    }
    // 아직 오늘 정보가 없거나 새 키를 확인하지 못했거나 429로 미룬 확인이 남았고, 기다릴 이유도 없으면 곧 확인한다.
    else if (
      (status.kind === 'checking' || ((local.verifyPending || local.retryOwed) && !failingNow(local, settings.handle))) &&
      !(typeof local.backoffUntil === 'number' && local.backoffUntil > now)
    ) {
      candidates.push(now + 60 * 1000);
    }
  }

  if (!candidates.length) {
    await chrome.alarms.clear(ALARM_WAKE);
    return;
  }
  // 보정 시계로 06:00 직후의 서버 반영 여유 안이면 rollover 알람과 같은 때(여유가 끝날 때)로 미룬다.
  const when = core.deferPastRolloverGrace(Math.max(Math.min(...candidates), now + MIN_ALARM_DELAY_MS), local.clockSkewMs);
  const existing = await chrome.alarms.get(ALARM_WAKE);
  if (!existing || Math.abs(existing.scheduledTime - when) > 5000) {
    await chrome.alarms.create(ALARM_WAKE, { when });
  }
}

/** 이 핸들의 마지막 확인이 실패했는지(그렇다면 재시도는 nextRetryAt이 정한다) */
function failingNow(local, handle) {
  return !!local.lastError && core.sameHandle(local.lastError.handle, handle);
}

/** wake 알람이 늦어도 when(내 시계)까지는 울리게 한다(이미 더 이른 알람이 있으면 그대로). */
async function ensureWakeBy(when) {
  const target = Math.max(when, Date.now() + MIN_ALARM_DELAY_MS);
  const existing = await chrome.alarms.get(ALARM_WAKE);
  if (!existing || existing.scheduledTime > target + 5000) await chrome.alarms.create(ALARM_WAKE, { when: target });
}

let setupPromise = null;
/**
 * 서비스 워커가 깨어날 때마다 한 번: 마이그레이션 + 알람 확인 + 배지 복원.
 * 여기서는 알림을 띄우지 않는다 — 저장된 정보가 낡았을 수 있으므로, 알림은 확인(refresh)한 뒤에만 정한다.
 */
function ensureSetup() {
  setupPromise ??= serialize(async () => {
    // 지난번 '모든 데이터 지우기'가 중간에 끊겼다면 마저 지운다.
    await resumeReset();
    await bestEffort('마이그레이션', migrate);
    await rebaseLocalClock();
    await finalizePendingSave();
    const settings = await getSettings();
    // 핸들 정리 쓰기가 실패해도 알람과 배지는 맞춘다(배지는 다른 핸들의 기록 없이 정한다).
    await bestEffort('상태 주인 확인', () => ensureStateOwner(settings.handle));
    await scheduleAlarms(settings);
    await updateUi({ notify: false });
  }).catch((e) => {
    setupPromise = null;
    throw e;
  });
  return setupPromise;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/**
 * 핸들의 활동 정보를 가져온다.
 * @returns {Promise<{raw: object, classified: object, dayKey: string, receivedAt: number}>}
 */
async function fetchActivity(handle, creds, eNow, { retried = false } = {}) {
  const dayKey = core.solvedDayKey(eNow);
  const prior = await chrome.storage.local.get(['clockSkewMs', 'rateLimits', 'serverSeenAt']);
  let headersCommitted = false;
  const raw = await requestRaw(core.activityPath(handle, dayKey), {
    headers: core.credentialHeaders(creds),
    onHeaders: async (meta) => {
      await recordResponseHeaders(meta, creds.clientId, prior);
      headersCommitted = true;
    },
  });
  if (!raw.networkError && !headersCommitted) {
    // 헤더를 받을 때 기록하지 못했다면(저장 실패 등) 결과를 다루기 전에 같은 내용(시계 근거, 서버 시각, 429 대기)을 다시
    // 기록한다 — 결과를 버리거나 저장이 막히는 경우에도 잃지 않도록. 이번에도 실패하면 오류를 그대로 올린다(시계 오류의
    // 근거 없이 결과만 남겨 지난 ✓를 보여주지 않도록).
    const fresh = await chrome.storage.local.get(['rateLimits', 'serverSeenAt']);
    await recordResponseHeaders(raw, creds.clientId, fresh);
  }
  const receivedAt = raw.receivedAt ?? Date.now();
  const headersAt = raw.headersAt ?? receivedAt;
  let classified = raw.networkError ? { ok: false, code: core.ERROR_CODES.NETWORK } : core.classifyResponse(raw, headersAt);
  const rateLimitedResponse = !classified.ok && classified.code === core.ERROR_CODES.RATE_LIMITED;
  // 이 응답이 키를 실제로 확인해 주었는지는 아래 시계 판정과 상관없이 응답 자체로 정한다(보안 확인 페이지는 확인이 아니다).
  const keyVerified = core.responseVerifiesKey(raw, classified);
  // 내 시계가 서버와 하루 넘게 다르면 날짜를 정할 수 없다(성공, 429, 4xx/5xx 모두 — 미래 날짜를 요청해 오류가 났을 수
  // 있다). 429 대기는 위에서 따로 기록했다. 날짜와 상관없는 결과(인증 실패, 사용자 없음)는 그대로 알린다.
  if (
    !raw.networkError &&
    classified.code !== core.ERROR_CODES.AUTH &&
    classified.code !== core.ERROR_CODES.NOT_FOUND &&
    core.clockTooFarOff(raw.date, raw.headersAt ?? receivedAt)
  ) {
    classified = { ok: false, code: core.ERROR_CODES.CLOCK };
  }
  // 06:00 직후 내 시계가 조금 빠르거나 아직 시계 차이를 모르면 서버의 '내일'을 요청해 거절될 수 있다. 거절(4xx) 응답의
  // Date로 본 서버의 날이 요청한 날과 다르면, 핸들 문제로 알리기 전에 서버 날짜로 한 번만 다시 요청한다.
  if (!retried && !classified.ok && classified.code === core.ERROR_CODES.REJECTED) {
    const serverMs = raw.date ? Date.parse(raw.date) : Number.NaN;
    if (Number.isFinite(serverMs) && core.solvedDayKey(serverMs) !== dayKey) {
      const serverNow = serverMs + 500 + (Date.now() - (raw.headersAt ?? receivedAt));
      console.info('[SSC] 요청한 날이 서버의 날과 달라 서버 날짜로 다시 확인합니다.', dayKey, core.solvedDayKey(serverNow));
      return fetchActivity(handle, creds, serverNow, { retried: true });
    }
  }
  return { raw, classified, dayKey, receivedAt, rateLimitedResponse, keyVerified, priorSkewMs: prior.clockSkewMs };
}

/**
 * 조회 결과를 저장한다.
 * @param {'auto'|'page'|'force'} policy force(사용자가 직접 확인)는 백오프 중이면 자동 재시도 간격을 늘리지 않는다.
 * @returns {Promise<'saved'|'discarded'|'day-changed'>}
 */
async function recordResult(handle, creds, result, policy = 'auto') {
  const settings = await getSettings();
  if (!core.sameHandle(settings.handle, handle)) return 'discarded'; // 그사이 핸들이 바뀜

  const local = await getLocal();
  const stored = credentialsOf(local);
  if (stored.clientId !== creds.clientId || stored.clientSecret !== creds.clientSecret) return 'discarded'; // 그사이 키가 바뀜
  const { raw, receivedAt, classified, dayKey } = result;
  // solved.ac가 이 키로 요청을 처리했다면(2xx, 인증 실패 같은 4xx) 키는 확인된 것이다. 응답이 없거나 429·보안 확인·5xx면 아직이다.
  const verified = result.keyVerified ? { verifyPending: null } : {};

  if (classified.ok) {
    const measured = core.computeClockSkew(raw.date, raw.sentAt ?? receivedAt, raw.headersAt ?? receivedAt);
    const clockSkewMs = measured ?? local.clockSkewMs ?? 0;
    // 응답이 만들어진 때(헤더를 받은 때) 기준. 본문이 늦게 끝나도 06:00 직후 여유 안의 응답을 여유 뒤의 것으로 보지 않도록.
    const fetchedAt = core.effectiveNow(raw.headersAt ?? receivedAt, clockSkewMs);
    const checked = measured !== null ? { skewCheckedAt: raw.headersAt ?? receivedAt } : {};
    // 요청한 날과 응답 시점의 날이 다르면(06:00 KST를 걸친 응답) 어느 날의 countedToday인지 알 수 없다.
    if (core.responseDayChanged(dayKey, raw.date, fetchedAt, core.effectiveNow(receivedAt, result.priorSkewMs))) {
      // 요청은 성공했다(키와 핸들은 정상): 예전 실패 기록(인증 오류·백오프 등)은 더 맞지 않으므로 지운다. 날짜만 다시 확인한다.
      await chrome.storage.local.set({
        clockSkewMs,
        lastAttemptAt: receivedAt,
        lastAttemptTimed: measured !== null,
        lastError: null,
        consecutiveFailures: 0,
        codeFailures: 0,
        failingSince: null,
        backoffUntil: null,
        expectedRetryAt: null,
        retryOwed: null,
        ...checked,
        ...verified,
      });
      await scheduleAlarms(settings); // 06:00 KST 알람을 새 시계 차이에 맞춘다(차이가 작아도 다음 경계를 놓치지 않도록)
      return 'day-changed';
    }
    const snapshot = core.buildSnapshot(settings.handle, classified.data, dayKey, fetchedAt);
    // 서버 시각으로 06:00 직후 반영 여유 안에 만들어진 응답은 '잠정': 여유 뒤의 응답이 성공할 때까지 오늘 상태로 쓰지 않는다.
    if (core.madeInRolloverGrace(core.responseMadeAt(raw.date, fetchedAt), dayKey)) snapshot.provisional = true;
    await chrome.storage.local.set({
      snapshot,
      lastError: null,
      consecutiveFailures: 0,
      codeFailures: 0,
      failingSince: null,
      lastAttemptAt: receivedAt,
      lastAttemptTimed: measured !== null,
      expectedRetryAt: null,
      clockSkewMs,
      backoffUntil: null,
      recheckAt: null,
      retryOwed: null,
      ...checked,
      ...verified,
    });
    // 06:00 KST 알람을 지금 시계 차이에 맞춘다(scheduleAlarms는 1분 넘게 다를 때만 다시 건다).
    await scheduleAlarms(settings);
    return 'saved';
  }

  // 실패 응답이어도 Date 헤더가 있으면 시계 차이를 다시 잰다(시계를 고친 뒤 오프라인이었다가 돌아온 경우 등).
  const measured = raw.networkError ? null : core.computeClockSkew(raw.date, raw.sentAt ?? receivedAt, raw.headersAt ?? receivedAt);
  const clockSkewMs = measured ?? local.clockSkewMs ?? null;
  const at = core.effectiveNow(receivedAt, clockSkewMs);
  const streak = core.nextFailureStreak({
    consecutiveFailures: local.consecutiveFailures,
    failingSince: local.failingSince,
    lastAttemptAt: local.lastAttemptAt,
    expectedRetryAt: local.expectedRetryAt,
    receivedAt,
    at,
  });
  const sameCode = core.sameHandle(local.lastError?.handle, handle) && local.lastError?.code === classified.code;
  // 사용자가 백오프 중에 직접 다시 확인한 것은 자동 재시도 간격을 늘리지 않는다.
  const backoffActive = typeof local.backoffUntil === 'number' && local.backoffUntil > receivedAt;
  const escalate = !(policy === 'force' && sameCode && backoffActive);
  const codeFailures = sameCode ? (local.codeFailures ?? 0) + (escalate ? 1 : 0) : 1;
  const backoffMs = core.backoffMsFor(classified.code, codeFailures);
  const backoffUntil = escalate ? (backoffMs > 0 ? receivedAt + backoffMs : null) : local.backoffUntil;
  const { rateLimits } = await chrome.storage.local.get('rateLimits');
  await chrome.storage.local.set({
    lastError: {
      handle: settings.handle,
      code: classified.code,
      at,
      httpStatus: classified.httpStatus ?? null,
      serverCode: classified.serverCode ?? null,
    },

    consecutiveFailures: streak.consecutiveFailures,
    codeFailures,
    failingSince: streak.failingSince,
    lastAttemptAt: receivedAt,
    lastAttemptTimed: measured !== null,
    expectedRetryAt: core.expectedRetryAfterFailure({
      settings,
      code: classified.code,
      receivedAt,
      backoffUntil,
      rateLimitedUntil: core.activeRateLimit(rateLimits, creds.clientId, receivedAt),
    }),
    backoffUntil,
    clockSkewMs,
    ...(measured !== null && { skewCheckedAt: raw.headersAt ?? receivedAt }),
    // 429가 아닌 HTTP 응답을 받았다면 미룬 확인은 끝났다(이제 실패 기록이 재시도를 정한다). 시계 오류로 보여주는 429도
    // 429이고, 연결 실패·본문을 받다 끊긴 응답은 확인한 것이 아니다.
    ...(!result.rateLimitedResponse && !raw.networkError && !raw.bodyError && !raw.truncated && { retryOwed: null }),
    ...verified,
  });
  if (measured !== null) await scheduleAlarms(settings);
  console.warn(`[SSC] 조회 실패 (${handle}): ${classified.code}`, classified.httpStatus ?? '', classified.serverCode ?? '');
  return 'saved';
}

async function doRefresh(policy) {
  await resumeReset();
  await rebaseLocalClock();
  await finalizePendingSave();
  const settings = await getSettings();
  // 핸들을 바꾸는 정리가 끊겼다면 먼저 마친다(다른 핸들의 실패 기록·'오늘은 그만 알림'을 쓰지 않도록). 이번에도 못 마치면
  // 확인하지 않고(기록할 곳의 주인이 다르다) 화면만 그 기록 없이 맞춘다.
  await bestEffort('상태 주인 확인', () => ensureStateOwner(settings.handle));
  const rawLocal = await getLocal();
  const local = core.ownedState(rawLocal, settings.handle);
  const owned = local === rawLocal;
  const creds = credentialsOf(local);
  let refreshJustFailed = false;
  let discarded = false;
  if (owned && settings.handle && core.hasCredentials(creds)) {
    const { now, eNow } = nowInfo(local);
    const skip = core.shouldSkipRefresh({
      policy,
      handle: settings.handle,
      snapshot: local.snapshot,
      lastError: local.lastError,
      backoffUntil: local.backoffUntil,
      rateLimitedUntil: core.activeRateLimit(local.rateLimits, creds.clientId, now),
      lastAttemptAt: local.lastAttemptAt,
      verifyPending: !!local.verifyPending,
      // 오늘이 어느 날인지 확신할 수 없으면(06:00 무렵 시계 차이 구간에서 측정이 2분 넘게 지났거나 시각 정보 없이 실패)
      // 최근 정보가 있어도 다시 확인한다 — 배지·팝업이 쓰는 것과 같은 규칙.
      dayUncertain: dayUncertainNow(local),
      retryOwed: !!local.retryOwed,
      reimportDue: core.reimportDue({
        watch: local.reimportWatch,
        handle: settings.handle,
        statusKind: 'tracking',
        snapshot: local.snapshot,
        lastAttemptAt: local.lastAttemptAt,
        nowMs: now,
      }),
      retryGapMs: Math.min(settings.checkIntervalMin * 60 * 1000, core.RETRY_CADENCE_MS),
      nowMs: now,
      eNowMs: eNow,
    });
    if (!skip) {
      let result = await fetchActivity(settings.handle, creds, eNow);
      let outcome = await recordResult(settings.handle, creds, result, policy);
      if (outcome === 'day-changed') {
        // 경계를 걸쳤으면 새 날짜로 한 번 더 확인한다. 또 걸치면 시계를 믿을 수 없는 것이다.
        const fresh = await getLocal();
        result = await fetchActivity(settings.handle, creds, nowInfo(fresh).eNow);
        outcome = await recordResult(settings.handle, creds, result, policy);
        if (outcome === 'day-changed') {
          // 또 걸쳤다: 06:00 바로 앞뒤의 작은(초 단위) 차이다(하루 넘게 틀린 시계는 fetchActivity가 이미 시계 오류로 바꾼다).
          // 오류로 기록하지 않고(정보가 없으니 '확인 중') 곧 다시 확인한다. 재확인 시각을 남겨 두면 이어지는 wake 계산도 지킨다.
          await chrome.storage.local.set({ recheckAt: Date.now() + MIN_ALARM_DELAY_MS });
        }
      }
      discarded = outcome === 'discarded';
      refreshJustFailed = outcome === 'saved' && !result.classified.ok;
    }
  }
  // 요청하는 사이 핸들이 바뀌어 결과를 버렸다면, 알림은 새 핸들의 상태가 정리된 뒤(이어지는 확인에서) 정한다.
  await updateUi({ notify: !discarded, refreshJustFailed });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 배지 / 알림
// ---------------------------------------------------------------------------

let notificationSeq = 0;
function nextNotificationSeq() {
  notificationSeq = (notificationSeq + 1) % 1000;
  return `${Date.now().toString(36)}${notificationSeq.toString(36)}`;
}

/**
 * 배지·툴바 제목을 갱신하고, notify면 알림을 띄우거나 닫는다. 마지막에 wake 알람을 맞춘다.
 * @param {{notify?: boolean, refreshJustFailed?: boolean}} [opts]
 *   refreshJustFailed: 바로 이번 확인 요청이 실패했는지(그때만 최대 20분 전 정보로 알릴 수 있다)
 */
async function updateUi({ notify = true, refreshJustFailed = false } = {}) {
  await bestEffort('상태 주인 확인', async () => ensureStateOwner((await getSettings()).handle));
  const [syncRaw, rawLocal] = await Promise.all([getSyncRaw(), getLocal()]);
  const settings = core.effectiveSettings(syncRaw);
  // 핸들별 상태가 아직 다른 핸들의 것이면(정리 실패) 그 값을 쓰지 않고, 알림도 건드리지 않는다.
  let local = core.ownedState(rawLocal, settings.handle);
  if (local !== rawLocal) notify = false;
  // 끝난 '다시 불러오기' 기다림(반영됨, 기간 지남)은 지운다(누를 때의 확인 결과 요약을 남겨 두지 않도록).
  if (local.reimportWatch && core.reimportWatchDone({ watch: local.reimportWatch, snapshot: local.snapshot, nowMs: Date.now() })) {
    const removed = await bestEffort('다시 불러오기 기간 정리', async () => {
      await chrome.storage.local.remove('reimportWatch');
      return true;
    });
    if (removed) local = { ...local, reimportWatch: null };
  }
  const { now, eNow } = nowInfo(local);
  const status = statusOf(syncRaw, local, eNow);

  const badge = core.badgeFor(status);
  await bestEffort('배지 갱신', () =>
    Promise.all([
      chrome.action.setBadgeText({ text: badge.text }),
      chrome.action.setBadgeBackgroundColor({ color: badge.color }),
      chrome.action.setBadgeTextColor({ color: '#ffffff' }),
      chrome.action.setTitle({ title: core.actionTitleFor(status, settings.handle) }),
    ]),
  );

  let history = local.notifHistory;
  // 띄우다 멈춘 알림이 있는데 알림 목록을 읽지 못하면, 띄웠는지 알 수 없으므로 이번에는 알림을 건드리지 않는다.
  const listed = notify ? await bestEffort('알림 목록', () => chrome.notifications.getAll()) : undefined;
  if (notify && !(listed === undefined && local.notifPending?.id)) {
    const rateLimitedUntil = core.activeRateLimit(local.rateLimits, credentialsOf(local).clientId, now);
    // 화면에 실제로 떠 있는 알림을 확인한다. 사용자가 닫았거나(클릭 포함) 표시에 실패했다면 '떠 있지 않음'이다.
    // 목록을 읽지 못하면 기록된 알림이 떠 있다고 본다(바꾸거나 닫아야 할 때 닫을 수 있도록).
    const live = listed ?? (local.shownId ? { [local.shownId]: true } : {});
    // 지난번에 알림을 띄우다 멈췄다면 마무리한다: 알림이 떠 있으면 띄운 것으로 기록하고, 없으면 띄우지 않은 것으로 둔다.
    // 목록을 읽지 못했다면 띄웠는지 알 수 없으므로 그대로 둔다(다음에 다시 맞춘다).
    if (listed && local.notifPending?.id) {
      if (Object.hasOwn(live, local.notifPending.id)) history = deliveredHistory(local.notifPending, history);
      await chrome.storage.local.set({ notifHistory: history ?? {}, notifPending: null });
    }
    const shownId = local.shownId && Object.hasOwn(live, local.shownId) ? local.shownId : null;
    const shown = core.parseNotificationId(shownId);
    // 지난 알림 인스턴스가 남아 있으면 정리한다(예전 버전의 고정 ID 포함).
    for (const id of Object.keys(live)) {
      if (id !== shownId && core.isOwnNotificationId(id)) await bestEffort('지난 알림 닫기', () => chrome.notifications.clear(id));
    }
    const decision = core.decideNotification({
      status,
      settings,
      history,
      shownKind: shown?.kind ?? null,
      shownCause: shown?.cause ?? null,
      snoozeDayKey: local.snoozeDayKey,
      consecutiveFailures: local.consecutiveFailures,
      failingSince: local.failingSince,
      lastFailureAt: local.lastError?.at,
      rateLimitRemainingMs: rateLimitedUntil === null ? 0 : rateLimitedUntil - now,
      refreshJustFailed,
      nowMs: eNow,
    });

    let creating = null;
    let fallback = null;
    let delivered = false;
    try {
      // 떠 있던 알림을 닫아야 하면 먼저 닫는다. 실제로 닫혔을 때만 '확장이 밀어낸 알림'으로 기록한다
      // (그 사이 사용자가 닫았다면 clear는 false를 돌려준다).
      let displacedKind = null;
      if (shownId && (decision.action === 'clear' || decision.action === 'show')) {
        const wasCleared = await chrome.notifications.clear(shownId);
        if (wasCleared) displacedKind = shown.kind;
      }
      // 기록은 표시 성공 여부와 상관없이 남긴다(실패할 때마다 곧바로 다시 시도하지 않도록).
      const before = history;
      history = core.applyDecisionToHistory(before, decision, status, displacedKind, eNow);

      if (decision.action === 'show') {
        const content = core.notificationContent(decision.kind, status, settings.handle, eNow, eNow - now);
        const id = core.makeNotificationId({
          cause: core.notificationCause(status) ?? decision.kind,
          dayKey: core.solvedDayKey(eNow),
          handle: settings.handle,
          seq: nextNotificationSeq(),
        });
        // 띄우기 전에 ID와 '띄우는 중' 기록을 먼저 적는다. 띄운 직후 서비스 워커가 멈추면 다음에 이 알림을 '지난 알림'으로
        // 지우지 않고 띄운 것으로 기록하며, 띄우기 전에 멈추면(알림 없음) 띄우지 않은 것으로 둔다(한 번만 띄우는 알림을 잃지 않게).
        fallback = core.applyDecisionToHistory(before, { action: 'clear' }, status, displacedKind, eNow);
        await chrome.storage.local.set({ notifHistory: fallback, shownId: id, notifPending: { id, history, fallback } });
        creating = id;
        await chrome.notifications.create(id, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('images/icon128.png'),
          title: content.title,
          message: content.message,
          priority: decision.kind === 'unsolved' ? 2 : 1,
          requireInteraction: content.requireInteraction,
          // 오늘이 어느 날인지 모르면 '오늘은 그만 알림'을 넣지 않는다(다른 날을 끌 수 있다).
          buttons: dayKnownNow(local)
            ? [{ title: content.primaryButton }, { title: '오늘은 그만 알림' }]
            : [{ title: content.primaryButton }],
        });
        creating = null;
        delivered = true;
        await chrome.storage.local.set({ notifHistory: history, notifPending: null, notificationError: null });
      } else if (decision.action === 'clear') {
        if (JSON.stringify(history ?? {}) !== JSON.stringify(local.notifHistory ?? {})) {
          await chrome.storage.local.set({ notifHistory: history });
        }
        await chrome.storage.local.remove(['shownId', 'notificationError']);
      }
    } catch (e) {
      // 알림을 띄우지 못해도 배지/상태 갱신은 계속된다. 팝업에서 안내할 수 있게 기록한다.
      console.warn('[SSC] 알림 처리 실패', e);
      await bestEffort('알림 오류 기록', async () => {
        // 띄우지 못한 알림도 기록해서 곧바로 되풀이하지 않는다. 단, 한 번만 띄우는 설정 알림은 띄우지 못했다면
        // 띄운 것으로 치지 않는다(다음 확인 때 다시 시도).
        // (기록을 미리 적는 쓰기가 실패한 경우처럼 알림을 띄우는 데까지 가지 못한 경우도 포함)
        const keep = decision.action === 'show' && decision.kind === 'setup' && !delivered && fallback ? fallback : history;
        history = keep;
        await chrome.storage.local.set({ notifHistory: keep, notifPending: null, notificationError: String(e?.message ?? e) });
        if (creating) await chrome.storage.local.remove('shownId'); // 띄우지 못한 알림
      });
    }
  }

  await bestEffort('wake 알람 예약', () => scheduleWake(settings, { ...local, notifHistory: history }, status));
  return status;
}

/**
 * 팝업의 버튼이 보여 준 핸들·solved.ac 날짜가 지금과 같은지. 그 사이 다른 탭에서 핸들을 바꿨거나 06:00이 지났다면
 * 다른 대상(새 핸들, 새 날)에 적용하지 않는다.
 */
async function popupTarget(message, ownerHandle) {
  const [settings, local] = await Promise.all([getSettings(), getLocal()]);
  const today = core.solvedDayKey(nowInfo(local).eNow);
  // 오늘이 어느 날인지 확신할 수 없으면(시계 문제, 06:00 무렵 시계를 고친 뒤 등) 날짜를 정하는 동작은 받지 않는다.
  if (!dayKnownNow(local)) return null;
  // 핸들별 상태를 맞춘 핸들(ownerHandle)과 지금 핸들이 같아야 한다(그 사이 다른 곳에서 핸들이 바뀌었으면 받지 않는다).
  if (!core.ownsState(ownerHandle, settings.handle) || !core.ownsState(local.stateHandle, settings.handle)) return null;
  const same =
    typeof message?.handle === 'string' &&
    (message.handle === settings.handle || core.sameHandle(message.handle, settings.handle)) &&
    message.dayKey === today;
  return same ? today : null;
}

/** 핸들별 상태를 쓰는 버튼 동작 전에: 핸들을 바꾸는 정리를 먼저 마친다(못 마치면 오류로 답해, 쓴 값이 곧 지워지지 않게). */
async function ownStateForAction() {
  const { handle } = await getSettings();
  await ensureStateOwner(handle);
  return handle; // 상태를 맞춘 핸들(동작은 이 핸들에 대해서만 적용한다)
}

async function snoozeToday(message) {
  const owner = await ownStateForAction();
  const today = await popupTarget(message, owner);
  if (!today) return { ok: false, error: 'stale' };
  await chrome.storage.local.set({ snoozeDayKey: today });
  await updateUi();
  return { ok: true };
}

/**
 * 팝업에서 '채점 사이트에서 다시 불러오기'를 눌렀다: solved.ac 연동 설정은 팝업이 연다(다시 불러오기는 사용자가
 * solved.ac에 로그인해서 직접 누른다 — solved.ac는 이 기능을 앱에 맡기지 않는다). 여기서는 반영될 때까지 몇 분 동안
 * 2분마다 다시 확인하도록 기간을 적어 둔다(요청 제한·백오프는 그대로 지킨다).
 */
async function watchReimport(message) {
  const owner = await ownStateForAction();
  const settings = await getSettings();
  const same =
    !!settings.handle &&
    core.ownsState(owner, settings.handle) &&
    typeof message?.handle === 'string' &&
    (message.handle === settings.handle || core.sameHandle(message.handle, settings.handle));
  if (!same) return { ok: false, error: 'stale' };
  const now = Date.now();
  // 누른 때의 오늘 확인 결과를 적어 두고, 그것이 달라지면(반영되면) 멈춘다. 이미 풀었어도 문제 수·최근 기록이 바뀔 수 있다.
  // 오늘 정보가 아니면(어제 것, 잠정) 기준으로 쓰지 않는다(base: null — 첫 응답에서 바로 멈추지 않도록).
  const local = await getLocal(settings.handle);
  const dayKey = core.solvedDayKey(nowInfo(local).eNow);
  const snap = local.snapshot;
  const todays =
    snap && core.sameHandle(snap.handle, settings.handle) && snap.dayKey === dayKey && !snap.provisional ? snap : null;
  const watch = {
    handle: settings.handle,
    dayKey,
    since: now,
    until: now + core.REIMPORT_WATCH_MS,
    base: core.reimportBaseOf(todays),
    // 누를 때 이미 있던 결과(어느 날의 것이든)로는 끝내지 않는다 — 새로 받은 결과만 비교한다.
    baseFetchedAt: snap && core.sameHandle(snap.handle, settings.handle) ? snap.fetchedAt ?? null : null,
  };
  await chrome.storage.local.set({ reimportWatch: watch });
  await updateUi({ notify: false });
  return { ok: true, until: watch.until };
}

async function unsnooze(message) {
  const owner = await ownStateForAction();
  if (!(await popupTarget(message, owner))) return { ok: false, error: 'stale' };
  // 다시 켜면 오늘 기록을 지워서 지금 상태에 맞는 알림을 바로 띄운다(정보가 낡았으면 먼저 확인).
  const { notifHistory } = await chrome.storage.local.get('notifHistory');
  await chrome.storage.local.set({ notifHistory: { setup: notifHistory?.setup ?? [] } });
  await chrome.storage.local.remove('snoozeDayKey');
  await updateUi();
  refresh('auto').catch((e) => console.error('[SSC] 다시 켠 뒤 확인 오류', e));
  return { ok: true };
}

async function openUrl(url) {
  try {
    await chrome.tabs.create({ url });
  } catch {
    // 열린 Chrome 창이 없을 때(백그라운드 실행 중)는 새 창으로 연다.
    await chrome.windows.create({ url, focused: true });
  }
}

/**
 * 알림 클릭/버튼 처리. 누른 알림 자신의 ID(원인·날짜·핸들)를 기준으로 처리하고, 그 알림만 닫는다
 * (그 사이 새 알림으로 바뀌었어도 새 알림에는 영향이 없다).
 * @param {string} id 누른 알림의 ID
 * @param {'open'|'snooze'} action
 */
async function handleNotificationAction(id, action) {
  if (!core.isOwnNotificationId(id)) return;
  const info = core.parseNotificationId(id);
  // 띄우는 중으로 남아 있던 알림을 눌렀다면 실제로 떴던 것이다: 닫기 전에 띄운 것으로 기록한다.
  const { notifPending, notifHistory } = await chrome.storage.local.get(['notifPending', 'notifHistory']);
  if (notifPending?.id === id) {
    await chrome.storage.local.set({ notifHistory: deliveredHistory(notifPending, notifHistory), notifPending: null });
  }
  await bestEffort('알림 닫기', () => chrome.notifications.clear(id));
  const [settings, local] = await Promise.all([getSettings(), getLocal()]);
  if (local.shownId === id) await chrome.storage.local.remove('shownId');

  if (action === 'snooze') {
    const owner = await ownStateForAction();
    // 그 알림이 속한 날·핸들에만 적용한다(06:00 직후에 지난 날 알림을 누른 경우 등은 닫기만 한다). 핸들은 상태를 맞춘 핸들과
    // 지금 저장소를 다시 읽어 비교한다(그 사이 다른 기기에서 핸들이 바뀌었으면 끄지 않는다).
    const [nowSettings, nowLocal] = await Promise.all([getSettings(), getLocal()]);
    const today = core.solvedDayKey(nowInfo(nowLocal).eNow);
    if (
      info &&
      info.dayKey === today &&
      core.sameHandle(info.handle, owner) &&
      core.ownsState(owner, nowSettings.handle) &&
      core.ownsState(nowLocal.stateHandle, nowSettings.handle) &&
      dayKnownNow(nowLocal)
    ) {
      await chrome.storage.local.set({ snoozeDayKey: today });
    }
    await updateUi();
    return;
  }

  // 누른 알림이 가리키던 핸들의 프로필을 연다(그 사이 핸들을 바꿨어도). 예전 버전의 알림은 지금 핸들.
  const target = info?.handle && core.isValidHandle(info.handle) ? info.handle : settings.handle;
  if (!target || (info && core.notificationOpensSettings(info.kind, info.cause))) {
    await bestEffort('설정 열기', () => chrome.runtime.openOptionsPage());
  } else {
    await openUrl(core.profileUrl(target));
  }
}

// ---------------------------------------------------------------------------
// 설정 저장 / 데이터 지우기
// ---------------------------------------------------------------------------

const SAVE_BLOCKING_ERRORS = new Set([core.ERROR_CODES.NOT_FOUND, core.ERROR_CODES.AUTH, core.ERROR_CODES.REJECTED]);

/** 팝업이 보낸 값 중 실제로 바꾼 알림/주기 설정만 고른다(다른 기기에서 바뀐 값을 덮어쓰지 않도록). */
function pickPreferences(input) {
  const out = {};
  for (const k of core.PREFERENCE_KEYS) if (input && k in input) out[k] = input[k];
  return out;
}

/** 바꾼 항목만(정규화한 값으로) 담은 동기화 쓰기 내용. 다른 곳에서 바꾼 나머지 항목은 건드리지 않는다. */
function patchOf(next, keys) {
  return Object.fromEntries([...new Set(keys)].map((k) => [k, next[k]]));
}

async function writeSync(patch) {
  savedSinceRecovery = true; // 이 뒤의 지우기 요청은 앞선 마무리로 갈음하지 않는다
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
}

/**
 * 저장이 끝난 뒤의 후속 처리(상태 주인 맞추기, 확인 결과 기록, 알람, 배지). 설정은 이미 저장됐으므로 여기서 실패해도
 * 저장 실패로 알리지 않는다: 알람을 한 번 더 걸어 보고, 이어지는 확인이 배지와 wake 알람을 다시 맞추게 한다.
 * @returns {Promise<boolean>} 후속 처리 중 실패가 있었는지
 */
async function afterSave(fn) {
  try {
    await fn();
    return false;
  } catch (e) {
    console.error('[SSC] 저장 뒤 처리 실패', e);
    await bestEffort('알람 다시 걸기', async () => scheduleAlarms(await getSettings()));
    refresh('auto').catch((err) => console.error('[SSC] 저장 뒤 재확인 오류', err));
    return true;
  }
}

/** 저장하려던 내용(동기화 항목, 키) 중 실제로 저장된 부분 */
async function appliedParts(patch, creds, credsChanged) {
  const parts = [];
  if (Object.keys(patch).length) {
    const stored = await chrome.storage.sync.get(Object.keys(patch));
    parts.push(Object.entries(patch).every(([k, v]) => JSON.stringify(stored[k]) === JSON.stringify(v)));
  }
  if (credsChanged) {
    const { creds: now } = await readAccount();
    parts.push(now.clientId === creds.clientId && now.clientSecret === creds.clientSecret);
  }
  return { all: parts.every(Boolean), any: parts.some(Boolean) };
}

/** 지금 저장된 계정(핸들·키·키 리비전) */
async function readAccount() {
  const [settings, local] = await Promise.all([getSettings(), chrome.storage.local.get([core.CREDENTIALS_KEY, 'credRev'])]);
  return { handle: settings.handle, creds: credentialsOf(local), credRev: local.credRev ?? null };
}

function sameAccount(a, b) {
  return (
    a.handle === b.handle &&
    a.creds.clientId === b.creds.clientId &&
    a.creds.clientSecret === b.creds.clientSecret &&
    a.credRev === b.credRev
  );
}

/** 팝업이 폼을 채울 때 본 계정(base)에서 그 사이 다른 곳(다른 기기/탭)이 핸들이나 키를 바꿨는지 */
function accountMovedSince(base, account) {
  const handleMoved = (base.handle ?? '') !== account.handle && !core.sameHandle(base.handle, account.handle);
  const keyMoved = (base.clientId ?? '') !== account.creds.clientId || (base.credRev ?? null) !== account.credRev;
  return handleMoved || keyMoved;
}

/**
 * 팝업에서 받은 설정을 저장한다.
 * - settings에는 사용자가 바꾼 항목만 온다(핸들 포함). 동기화 저장소에도 그 항목만 쓴다.
 * - credentials는 키를 바꾼 경우에만 온다(빈 시크릿 = 같은 클라이언트 ID의 기존 시크릿 유지).
 * - base는 팝업이 폼을 채울 때 본 핸들/클라이언트 ID/키 리비전. 계정을 고치는데 그 사이 다른 곳에서 계정이 바뀌었으면
 *   (확인 요청을 기다리는 동안 바뀐 경우 포함) 거절한다.
 * - prefsOnly: API 키가 없거나 핸들이 없을 때 알림/주기 설정(과 키가 없으면 사용자가 입력한 핸들)만 저장한다.
 * 확정 순서: 키만 바꾸면 이 기기 저장소에 한 번에 쓴다. 핸들만 바꾸면 동기화 저장소에 한 번에 쓴다.
 * 둘 다 바꾸면 ① 새 키를 '대기'로 적고 ② 핸들을 동기화하고 ③ 키를 확정한다(끊기면 finalizePendingSave가 마무리).
 * @returns {Promise<object>} {ok, settings, warning} 또는 {ok:false, error}
 */
async function saveSettings(message) {
  // 끊긴 데이터 지우기가 있으면 먼저 마무리한다(그 뒤 저장한 설정이 나중에 지워지지 않도록).
  await resumeReset();
  // 이전 저장이 끊겼다면 먼저 마무리한다(빈 시크릿 칸이 예전 키를 다시 쓰지 않도록).
  await rebaseLocalClock();
  await finalizePendingSave();
  const input = message?.settings ?? {};
  const base = message?.base ?? null;
  const current = await getSettings();
  const local = await getLocal();
  const currentCreds = credentialsOf(local);
  const before = { handle: current.handle, creds: currentCreds, credRev: local.credRev ?? null };
  const handleProvided = typeof input.handle === 'string';
  const credsProvided = !!message?.credentials;

  if (base && (handleProvided || credsProvided) && accountMovedSince(base, before)) {
    return { ok: false, error: 'conflict' };
  }

  const prefs = pickPreferences(input);
  const prefKeys = Object.keys(prefs);

  if (message?.prefsOnly) {
    // 키가 이미 있으면 핸들은 확인 절차를 거쳐서만 바꾼다.
    let handle = null;
    if (!core.hasCredentials(currentCreds) && handleProvided && input.handle.trim() !== '') {
      const parsed = core.normalizeHandleInput(input.handle);
      if (!parsed.ok) return { ok: false, error: 'invalid-handle' };
      handle = parsed.handle;
    }
    const next = core.normalizeSettings({ ...current, ...prefs, ...(handle && { handle }) });
    await writeSync(patchOf(next, handle && handle !== current.handle ? [...prefKeys, 'handle'] : prefKeys));
    const followUpFailed = await afterSave(async () => {
      await ensureStateOwner(next.handle);
      await scheduleAlarms(next, { resetPoll: current.checkIntervalMin !== next.checkIntervalMin });
      await updateUi();
    });
    return { ok: true, settings: next, warning: 'prefs-only', ...(followUpFailed && { followUpFailed }) };
  }

  const parsed = core.normalizeHandleInput(handleProvided ? input.handle : current.handle);
  if (!parsed.ok) return { ok: false, error: parsed.reason === 'empty' ? 'empty-handle' : 'invalid-handle' };

  let creds = currentCreds;
  if (credsProvided) {
    const clientId = String(message.credentials.clientId ?? '').trim();
    const secretInput = String(message.credentials.clientSecret ?? '').trim();
    creds = {
      clientId,
      clientSecret: secretInput || (clientId === currentCreds.clientId ? currentCreds.clientSecret : ''),
    };
  }
  if (!creds.clientId || !creds.clientSecret) return { ok: false, error: 'missing-credentials' };
  if (!core.isValidCredential(creds.clientId) || !core.isValidCredential(creds.clientSecret)) {
    return { ok: false, error: 'invalid-credentials' };
  }

  // 시크릿을 저장하기 전에, 가능하면 local 저장소를 확장 페이지/서비스 워커만 읽게 제한한다.
  // (현재 Chrome은 이 기능을 session 저장소에만 제공한다. 지원하는데 실패하면 저장하지 않는다.
  //  지원하지 않는 경우에도 content.js는 저장소를 읽지 않고, 웹 페이지는 확장 API에 접근할 수 없다.)
  if (typeof chrome.storage.local.setAccessLevel === 'function') {
    try {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    } catch (e) {
      console.error('[SSC] 저장소 보호 설정 실패', e);
      return { ok: false, error: 'storage-protection' };
    }
  }

  const next = core.normalizeSettings({ ...current, ...prefs, handle: parsed.handle });
  const patch = patchOf(next, next.handle !== current.handle ? [...prefKeys, 'handle'] : prefKeys);
  const handleChanged = !core.sameHandle(current.handle, next.handle);
  const credsChanged = creds.clientId !== currentCreds.clientId || creds.clientSecret !== currentCreds.clientSecret;
  const resetPoll = current.checkIntervalMin !== next.checkIntervalMin;
  const { now, eNow } = nowInfo(local);

  if (!handleChanged && !credsChanged) {
    // 계정(핸들/키)은 그대로이고 알림 설정만 바꾼 경우: 확인 결과와 상관없이 먼저 저장한다
    // (키가 폐기되었거나 사용자가 사라졌어도 알림을 끌 수 있어야 한다). 그다음 바로 다시 확인한다.
    await writeSync(patch);
    const followUpFailed = await afterSave(async () => {
      await ensureStateOwner(next.handle);
      await scheduleAlarms(next, { resetPoll });
      await updateUi();
    });
    refresh('force').catch((e) => console.error('[SSC] 저장 후 확인 오류', e));
    const rateLimited = core.activeRateLimit(local.rateLimits, creds.clientId, now) !== null;
    return {
      ok: true,
      settings: next,
      warning: rateLimited ? core.ERROR_CODES.RATE_LIMITED : null,
      ...(followUpFailed && { followUpFailed }),
    };
  }

  // 핸들이나 키가 바뀌면 저장 전에 실제로 조회해 본다. 단, 이 앱(클라이언트)이 429 대기 중이면 확인을 미루고 저장한다
  // (새 키는 '아직 확인하지 못함'으로 표시해 두고 대기가 끝나면 바로 확인한다).
  const rateLimited = core.activeRateLimit(local.rateLimits, creds.clientId, now) !== null;
  let verification = null;
  if (!rateLimited) {
    verification = await fetchActivity(next.handle, creds, eNow);
    // 응답을 기다리는 사이 다른 곳(다른 기기/탭)에서 계정이 바뀌었다면 이 저장은 낡은 것이다.
    if (!sameAccount(before, await readAccount())) {
      await updateUi({ notify: false });
      return { ok: false, error: 'conflict' };
    }
    const c = verification.classified;
    if (!c.ok && SAVE_BLOCKING_ERRORS.has(c.code)) {
      await updateUi({ notify: false });
      return { ok: false, error: c.code, serverCode: c.serverCode ?? null };
    }
  }

  const rev = randomId();
  try {
    if (handleChanged && credsChanged) {
      await chrome.storage.local.set({ pendingSave: { handle: next.handle, creds, rev } });
      await writeSync(patch);
      await commitCredentials(creds, rev);
    } else if (handleChanged) {
      await writeSync(patch);
    } else {
      await writeSync(patch);
      await commitCredentials(creds, rev);
    }
  } catch (e) {
    // 동기화 쓰기 전에 끊겼으면 새 키를 버리고, 쓴 뒤라면 새 키로 마무리한다. 그 결과 실제로 저장된 내용을 확인해서
    // 모두 저장됐으면 정상 처리를 이어 가고, 일부만 저장됐으면 그렇게 알린다(팝업은 저장된 값으로 폼을 다시 채운다).
    console.error('[SSC] 설정 쓰기 실패', e);
    await bestEffort('저장 마무리', finalizePendingSave);
    const applied = await bestEffort('저장 결과 확인', () => appliedParts(patch, creds, credsChanged));
    if (!applied?.all) {
      // 떠 있는 알림도 지금 상태에 맞춘다(예: 다른 핸들 확인에서 받은 429로 지금 미해결 정보도 믿을 수 없게 된 경우).
      // 핸들이 이미 바뀌었다면 그 핸들의 기록으로 판단하도록 먼저 상태 주인을 맞춘다.
      await bestEffort('상태 주인 확인', async () => ensureStateOwner((await getSettings()).handle));
      await bestEffort('상태 갱신', () => updateUi());
      if (applied?.any) return { ok: false, error: 'partial' };
      throw e;
    }
  }
  // 여기부터는 설정과 키가 저장된 뒤다. 후속 처리가 실패해도 '저장했음'을 그대로 알린다(키가 저장됐는지 사용자가 알 수 있도록).
  const followUpFailed = await afterSave(async () => {
    await ensureStateOwner(next.handle);
    let notify = true;
    if (verification) {
      const outcome = await recordResult(next.handle, creds, verification, 'force');
      // 그 사이 다른 기기에서 핸들이 또 바뀌어 결과를 버렸다면, 알림은 새 핸들의 확인(이어지는 refresh)이 정한다.
      if (outcome === 'discarded') notify = false;
      if (outcome === 'day-changed') refresh('force').catch((e) => console.error('[SSC] 재확인 오류', e));
    }
    await scheduleAlarms(next, { resetPoll });
    await updateUi({ notify });
  });

  let warning = null;
  if (rateLimited) warning = core.ERROR_CODES.RATE_LIMITED;
  else if (verification && !verification.classified.ok) warning = verification.classified.code;
  return { ok: true, settings: next, warning, ...(followUpFailed && { followUpFailed }) };
}

/**
 * 이 확장 프로그램이 저장한 모든 데이터(동기화된 설정·v1 설정 포함)를 지운다.
 * 서버가 정한 429 대기만, 어느 키였는지 없이 그 기록들(받은 시각·서버 시각·대기 길이·시계 보정량·마지막으로 확인한 시각)로 남긴다
 * (끝나면 지워진다).
 * @returns {Promise<{ok: true, keptWaitUntil: number|null}|{ok: false, error: 'reset-not-started'|'reset-incomplete'}>}
 *   reset-not-started: 이번 요청으로는 아무것도 지우지 않았다. reset-incomplete: 지우기 기록을 남긴 뒤 멈췄다(나중에 마저 지운다).
 */
async function resetAll(recoveriesAtRequest = resetRecoveries) {
  // 이 요청이 도착한 뒤 이미 끊긴 지우기를 마무리했고 그 뒤 저장이 없었다면 그것이 이번 요청의 결과다(아래 읽기가 실패해도).
  if (resetRecoveries !== recoveriesAtRequest && !savedSinceRecovery) return finishResetResponse();
  // 지난번 지우기가 끊겼다면 그것부터 마무리한다. 그 기록을 읽지도 못하면 아무것도 지우지 않는다.
  let previous;
  try {
    ({ resetPending: previous } = await chrome.storage.local.get('resetPending'));
  } catch (e) {
    console.error('[SSC] 데이터 지우기를 시작하지 못함', e);
    return { ok: false, error: 'reset-not-started' };
  }
  if (previous) {
    // 끊긴 지우기를 마치는 것이 곧 이번 요청이다(그 사이 다른 기기가 새로 저장한 동기화 설정은 원래 남긴다).
    try {
      await finishReset();
      resetRecoveries += 1; // 뒤이어 도착한 지우기 요청도 이 마무리를 결과로 본다
      savedSinceRecovery = false;
    } catch (e) {
      console.error('[SSC] 지난 데이터 지우기를 마무리하지 못함', e);
      return { ok: false, error: 'reset-incomplete' };
    }
    return finishResetResponse();
  }
  // 이 요청이 도착한 뒤(예: 서비스 워커가 시작하며) 끊긴 지우기를 이미 마무리했다면 그것이 이번 요청의 결과다 — 새로 지우면
  // 그 마무리가 일부러 남긴, 다른 기기가 새로 저장한 동기화 설정까지 지운다.
  if (resetRecoveries !== recoveriesAtRequest && !savedSinceRecovery) return finishResetResponse();
  let all;
  try {
    let syncAll;
    [all, syncAll] = await Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null)]);
    const keptWait = core.anonymousRateLimits(core.rebaseRateLimits(all.rateLimits, Date.now()), Date.now());
    // ① 지우기를 시작한다는 기록을 먼저 한 번에 남긴다: 지울 동기화 항목과 그 값, 남길 대기(클라이언트 ID 없이).
    //    이것을 남기지 못하면(읽기 실패 포함) 아무것도 지우지 않는다(나중에 마저 지운다고 약속할 수 없으므로).
    await chrome.storage.local.set({ resetPending: { sync: syncAll }, rateLimits: keptWait ?? {} });
  } catch (e) {
    console.error('[SSC] 데이터 지우기를 시작하지 못함', e);
    return { ok: false, error: 'reset-not-started' };
  }
  try {
    await finishReset(all.shownId);
  } catch (e) {
    // 지우기 기록은 남았으므로 다음 시작(또는 다음 저장/확인/지우기) 때 마저 지운다.
    console.error('[SSC] 데이터 지우기가 중간에 멈춤', e);
    return { ok: false, error: 'reset-incomplete' };
  }
  return finishResetResponse();
}

/** 지우기를 마친 뒤: 알람·배지를 맞추고(실패해도 다음 시작 때 다시 맞춘다) 남긴 대기를 알린다. */
async function finishResetResponse() {
  await bestEffort('알람 정리', async () => {
    await chrome.alarms.clearAll();
    await scheduleAlarms(await getSettings());
  });
  await bestEffort('상태 갱신', () => updateUi({ notify: false }));
  const kept = await bestEffort('남긴 대기 읽기', async () => (await chrome.storage.local.get('rateLimits')).rateLimits);
  const keptWaitUntil = kept && Object.hasOwn(kept, core.ANY_CLIENT_WAIT_KEY) ? core.rateLimitEnd(kept[core.ANY_CLIENT_WAIT_KEY], Date.now()) : 0;
  return { ok: true, keptWaitUntil: keptWaitUntil > Date.now() ? keptWaitUntil : null };
}

/** 끊긴 지우기를 마무리한 횟수(이 서비스 워커 안에서). 지우기 요청이 도착한 뒤 마무리됐는지 알기 위해 쓴다. */
let resetRecoveries = 0;
/** 마지막 마무리 뒤에 설정을 저장했는지(그랬다면 그 마무리를 새 지우기 요청의 결과로 볼 수 없다) */
let savedSinceRecovery = false;

/** 끊긴 '모든 데이터 지우기'가 있으면 마무리한다(저장·확인·지우기 전에, 그리고 서비스 워커가 시작할 때). */
async function resumeReset() {
  const { resetPending } = await chrome.storage.local.get('resetPending');
  if (resetPending) {
    await finishReset();
    resetRecoveries += 1;
    savedSinceRecovery = false;
  }
}

/**
 * '모든 데이터 지우기'의 나머지 단계. 동기화 저장소는 지우기를 시작할 때 적어 둔 항목 중 그때 값 그대로인 것만 지운다
 * (예전 키까지 모두. 그 뒤 다른 기기에서 다시 저장한 값은 남긴다). 동기화 저장소를 지우면 곧바로 '이 기기만 남음'
 * (phase: 'local')으로 바꿔 적어서, 이 기기의 정리가 끊겨 나중에 다시 실행해도 그 사이 다른 기기가 같은 값으로 다시
 * 저장한 설정을 지우지 않는다. 그다음 이 기기의 데이터를 지운다. 남겨 둔 429 대기 기록과 진행 표시는 마지막에 정리한다.
 */
async function finishReset(shownId = null) {
  const { resetPending } = await chrome.storage.local.get('resetPending');
  if (!resetPending) return;
  const recorded =
    resetPending && typeof resetPending === 'object' && resetPending.sync && typeof resetPending.sync === 'object'
      ? resetPending.sync
      : {};
  const keys = resetPending.phase === 'local' ? [] : Object.keys(recorded);
  if (keys.length) {
    const nowSync = await chrome.storage.sync.get(keys);
    const unchanged = keys.filter(
      (k) => Object.hasOwn(nowSync, k) && JSON.stringify(nowSync[k]) === JSON.stringify(recorded[k]),
    );
    if (unchanged.length) await chrome.storage.sync.remove(unchanged);
    await chrome.storage.local.set({ resetPending: { phase: 'local' } });
  }
  const all = await chrome.storage.local.get(null);
  const keep = new Set(['rateLimits', 'resetPending']);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => !keep.has(k)));
  const wait = all.rateLimits && typeof all.rateLimits === 'object' ? all.rateLimits : {};
  if (!Object.keys(wait).length) await chrome.storage.local.remove('rateLimits');
  await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION, stateHandle: '' });
  await chrome.storage.local.remove('resetPending');
  // 이 확장이 띄운 알림을 모두 닫는다.
  const live = (await bestEffort('알림 목록', () => chrome.notifications.getAll())) ?? {};
  for (const id of new Set([...Object.keys(live), shownId ?? all.shownId].filter(Boolean))) {
    if (core.isOwnNotificationId(id)) await bestEffort('알림 닫기', () => chrome.notifications.clear(id));
  }
}

/** 다른 기기에서 동기화된 설정 변경 등, 이 서비스 워커의 저장을 거치지 않은 변경 처리 */
async function onSyncSettingsChanged(changes) {
  const settings = await getSettings();
  await ensureStateOwner(settings.handle);
  await scheduleAlarms(settings, { resetPoll: !!changes.checkIntervalMin || !!changes.alarmInterval });
}

// ---------------------------------------------------------------------------
// 이벤트 리스너 (서비스 워커 최상위에서 동기적으로 등록해야 한다)
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[SSC] ${details.reason} (v${chrome.runtime.getManifest().version})`);
  ensureSetup()
    .then(async () => {
      // 처음 설치하면 설정 화면을 연다(핸들과 API 키가 있어야 동작한다).
      if (details.reason === 'install') await bestEffort('설정 열기', () => chrome.runtime.openOptionsPage());
      await refresh('auto');
    })
    .catch((e) => console.error('[SSC] 설치 처리 오류', e));
});

chrome.runtime.onStartup.addListener(() => {
  ensureSetup()
    .then(() => refresh('auto'))
    .catch((e) => console.error('[SSC] 시작 처리 오류', e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // 이 버전의 알람만 처리한다(정리하지 못한 v1 알람 등은 무시하고 지운다).
  if (![ALARM_POLL, ALARM_ROLLOVER, ALARM_WAKE].includes(alarm.name)) {
    chrome.alarms.clear(alarm.name).catch(() => {});
    return;
  }
  const run = async () => {
    await ensureSetup();
    if (alarm.name === ALARM_ROLLOVER) {
      await serialize(async () => scheduleAlarms(await getSettings()));
    }
    // 알람이 한꺼번에 울려도(절전 복귀 등) 'auto'는 서로 합쳐지거나 간격 제한으로 한 번만 요청한다.
    await refresh('auto');
  };
  run().catch((e) => console.error('[SSC] 알람 처리 오류', alarm.name, e));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (![...core.SETTINGS_KEYS, ...core.LEGACY_SYNC_KEYS].some((k) => k in changes)) return;
  serialize(() => onSyncSettingsChanged(changes))
    .catch((e) => console.error('[SSC] 설정 변경 처리 오류', e))
    .then(() => refresh('auto'))
    .catch((e) => console.error('[SSC] 설정 변경 후 확인 오류', e));
});

chrome.notifications.onClicked.addListener((id) => {
  if (!core.isOwnNotificationId(id)) return;
  ensureSetup()
    .then(() => serialize(() => handleNotificationAction(id, 'open')))
    .catch((e) => console.error('[SSC] 알림 클릭 처리 오류', e));
});

chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
  if (!core.isOwnNotificationId(id)) return;
  ensureSetup()
    .then(() => serialize(() => handleNotificationAction(id, buttonIndex === 0 ? 'open' : 'snooze')))
    .catch((e) => console.error('[SSC] 알림 버튼 처리 오류', e));
});

function isFromExtensionPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

function isFromSolvedTab(sender) {
  return !!sender.tab && typeof sender.url === 'string' && sender.url.startsWith(`${core.SOLVED_ORIGIN}/`);
}

function respond(promise, sendResponse) {
  promise.then(
    (result) => sendResponse(result ?? { ok: true }),
    (e) => {
      console.error('[SSC] 메시지 처리 오류', e);
      sendResponse({ ok: false, error: 'internal', message: String(e?.message ?? e) });
    },
  );
  return true; // 비동기 응답
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;

  if (message.type === 'pageVisit') {
    // solved.ac를 방문했다면 방금 문제를 풀었을 수 있다(간격 제한/백오프는 지킨다).
    if (!isFromSolvedTab(sender)) return false;
    ensureSetup()
      .then(() => refresh('page'))
      .catch((e) => console.error('[SSC] 페이지 방문 처리 오류', e));
    return false;
  }

  if (!isFromExtensionPage(sender)) return false;
  switch (message.type) {
    case 'refresh':
      return respond(
        ensureSetup().then(() => refresh(message.force ? 'force' : 'page')),
        sendResponse,
      );
    case 'saveSettings':
      return respond(
        ensureSetup().then(() => serialize(() => saveSettings(message))),
        sendResponse,
      );
    case 'snooze':
      return respond(ensureSetup().then(() => serialize(() => snoozeToday(message))), sendResponse);
    case 'unsnooze':
      return respond(ensureSetup().then(() => serialize(() => unsnooze(message))), sendResponse);
    case 'watchReimport':
      return respond(ensureSetup().then(() => serialize(() => watchReimport(message))), sendResponse);
    case 'resetAll': {
      // 시작 처리(끊긴 지우기 마무리 포함)가 실패해도 지우기 요청은 받아서, 무엇을 했는지 정확히 답한다.
      // 요청이 도착한 때의 마무리 횟수를 적어 두고, 그 뒤 시작 처리가 마무리했다면 그 결과로 답한다.
      const recoveriesAtRequest = resetRecoveries;
      return respond(
        ensureSetup()
          .catch((e) => console.error('[SSC] 시작 처리 오류(지우기 요청)', e))
          .then(() => serialize(() => resetAll(recoveriesAtRequest))),
        sendResponse,
      );
    }
    default:
      return false;
  }
});

// 서비스 워커가 (재)시작될 때마다 알람/마이그레이션/배지 상태를 점검한다.
ensureSetup().catch((e) => console.error('[SSC] 초기화 오류', e));
