// popup.js — 팝업 UI (ES module). 설정 탭(options_ui)으로도 열린다.
//
// 상태는 chrome.storage에서 직접 읽어 lib/core.js의 규칙으로 판정하고,
// 동작(지금 확인, 설정 저장, 오늘 알림 끄기)은 서비스 워커에 메시지로 요청한다.
// 저장된 클라이언트 시크릿은 화면(DOM)에 절대 넣지 않는다.

import * as core from './lib/core.js';

const $ = (id) => document.getElementById(id);

// 초기화가 끝나기 전이나 실패한 뒤에도 폼이 브라우저 기본 동작으로 제출되지 않게 가장 먼저 막는다
// (입력값이 주소에 붙어 새어 나가지 않도록. manifest의 CSP form-action 'none'과 이중 안전장치).
$('settingsForm').addEventListener('submit', (event) => event.preventDefault(), { capture: true });

const el = {
  handleBadge: $('handleBadge'),
  card: $('statusCard'),
  icon: $('statusIcon'),
  title: $('statusTitle'),
  detail: $('statusDetail'),
  stats: $('stats'),
  currentStreak: $('currentStreak'),
  maxStreak: $('maxStreak'),
  todaySolved: $('todaySolved'),
  recent: $('recent'),
  notes: $('notes'),
  deadline: $('deadline'),
  lastChecked: $('lastChecked'),
  refreshButton: $('refreshButton'),
  openButton: $('openButton'),
  snoozeButton: $('snoozeButton'),
  reimport: $('reimport'),
  reimportButton: $('reimportButton'),
  reimportHint: $('reimportHint'),
  permissionWarning: $('permissionWarning'),
  settings: $('settings'),
  form: $('settingsForm'),
  handleInput: $('handleInput'),
  legacyHint: $('legacyHint'),
  legacyHintText: $('legacyHintText'),
  confirmLegacyButton: $('confirmLegacyButton'),
  clientIdInput: $('clientIdInput'),
  clientSecretInput: $('clientSecretInput'),
  toggleSecret: $('toggleSecret'),
  intervalInput: $('intervalInput'),
  notifyUnsolved: $('notifyUnsolved'),
  unsolvedOptions: $('unsolvedOptions'),
  notifyStart: $('notifyStart'),
  remindInterval: $('remindInterval'),
  notifyError: $('notifyError'),
  saveButton: $('saveButton'),
  saveStatus: $('saveStatus'),
  resetButton: $('resetButton'),
  resetConfirm: $('resetConfirm'),
  resetCancelButton: $('resetCancelButton'),
  resetConfirmButton: $('resetConfirmButton'),
  openTabButton: $('openTabButton'),
  version: $('version'),
};

const LOCAL_KEYS = [
  core.CREDENTIALS_KEY,
  'credRev',
  'snapshot',
  'lastError',
  'lastAttemptAt',
  'clockSkewMs',
  'backoffUntil',
  'rateLimits',
  'skewCheckedAt',
  'clockProblem',
  'lastAttemptTimed',
  'serverSeenAt',
  'dayEvidenceLost',
  'localSeenAt',
  'stateHandle',
  'snoozeDayKey',
  'reimportWatch',
  'notificationError',
];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 팝업은 시크릿 값을 들고 있지 않는다: 클라이언트 ID와 '저장되어 있는지'만 안다.
let current = {
  seq: 0,
  settings: core.normalizeSettings({}),
  legacyHandle: null,
  local: {},
  creds: { clientId: '', hasSecret: false, rev: null },
};
/** 사용자가 고친 칸(설정 키 이름). 고친 칸만 저장하고, 다른 곳에서 바뀐 값은 고치지 않은 칸에만 반영한다. */
const dirty = new Set();
/**
 * 폼의 계정 칸(핸들/클라이언트 ID/시크릿)이 바탕으로 한 계정(키 리비전 포함). 저장할 때 그 사이 다른 곳에서 바뀌었는지
 * 확인한다. 계정 칸을 하나라도 고치기 시작하면 계정 칸 전체와 이 값을 고정한다(다른 키의 ID와 섞이지 않도록).
 */
let formBase = { handle: '', clientId: '', credRev: null, hasSecret: false };
const ACCOUNT_KEYS = ['handle', 'clientId', 'clientSecret'];
/** 핸들 칸에 넣어 둔, 아직 확인받지 않은 v1 아이디 제안(없으면 ''). 그 뒤 동기화에서 v1 값이 사라져도 이 칸 기준으로 판단한다. */
let unconfirmedSuggestion = '';
const FIELD_KEYS = {
  handleInput: 'handle',
  clientIdInput: 'clientId',
  clientSecretInput: 'clientSecret',
  intervalInput: 'checkIntervalMin',
  notifyUnsolved: 'notifyUnsolved',
  notifyStart: 'notifyStartHours',
  remindInterval: 'remindIntervalMin',
  notifyError: 'notifyError',
};
let refreshing = false;
let notificationsDenied = false;
let inTab = false;
let loadSeq = 0;
/** 설정/키가 바깥에서 바뀌어 폼을 다시 채워야 할 때, 그 변경을 반영한 읽기의 번호(그 읽기가 끝난 뒤에만 채운다) */
let fillAfterSeq = 0;
let saving = false;

// ---------------------------------------------------------------------------
// 데이터
// ---------------------------------------------------------------------------

async function readState(seq) {
  const [syncRaw, local] = await Promise.all([
    chrome.storage.sync.get([...core.SETTINGS_KEYS, ...core.LEGACY_SYNC_KEYS]),
    chrome.storage.local.get(LOCAL_KEYS),
  ]);
  const stored = core.normalizeCredentials(local[core.CREDENTIALS_KEY]);
  delete local[core.CREDENTIALS_KEY];
  const settings = core.effectiveSettings(syncRaw);
  return {
    seq,
    settings,
    legacyHandle: core.legacyHandleFrom(syncRaw),
    // 핸들별 상태가 아직 예전 핸들의 것이면(서비스 워커가 정리하기 전) 쓰지 않는다.
    local: core.ownedState(local, settings.handle),
    creds: { clientId: stored.clientId, hasSecret: !!stored.clientSecret, rev: local.credRev ?? null },
  };
}

let latestLoad = Promise.resolve(current);
/**
 * 저장소를 읽어 current를 바꾼다. 더 최근에 시작한 읽기가 있으면 그 읽기가 끝날 때까지 기다려 그 결과를 돌려준다
 * (먼저 시작한 읽기가 늦게 끝나도, 처음 화면이 예전 값이나 빈 값으로 채워지지 않도록).
 */
function loadState() {
  const seq = ++loadSeq;
  const load = readState(seq).then((state) => {
    if (seq !== loadSeq) return latestLoad;
    current = state;
    return current;
  });
  latestLoad = load;
  return load;
}

function currentStatus(eNow) {
  const { settings, local, creds } = current;
  return core.deriveStatus({
    settings,
    credentialsReady: !!creds.clientId && creds.hasSecret,
    legacyHandle: current.legacyHandle,
    rateLimited: core.activeRateLimit(local.rateLimits, creds.clientId, Date.now()) !== null,
    snapshot: local.snapshot,
    lastError: local.lastError,
    clockProblem: core.clockProblemActive(local.clockProblem, Date.now()),
    dayUncertain: dayUncertainNow(),
    nowMs: eNow,
  });
}

/** 시계를 고친 뒤 아직 서버 응답이 없어 오늘이 어느 날인지 확신할 수 없는지 */
function dayUncertainNow() {
  const { local } = current;
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

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

/** 서버 시계 기준 시각을 내 시계로 (표시용) */
function toLocalClock(serverMs) {
  return serverMs - core.effectiveNow(0, current.local.clockSkewMs);
}

function safeDayLabel(dayKey) {
  try {
    return core.formatDayKey(dayKey);
  } catch {
    return String(dayKey);
  }
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------

function render() {
  // 다른 곳(다른 기기, 서비스 워커)에서 설정/키가 바뀌었으면, 그 변경을 읽은 뒤에 사용자가 고치지 않은 칸에 반영한다.
  if (fillAfterSeq && current.seq >= fillAfterSeq && !saving) {
    fillAfterSeq = 0;
    fillForm({ onlyClean: true });
  }
  const { settings, local } = current;
  const now = Date.now();
  const eNow = core.effectiveNow(now, local.clockSkewMs);
  const today = core.solvedDayKey(eNow);
  const status = currentStatus(eNow);
  const snap = status.snapshot ?? status.lastSnapshot ?? null;
  // '오늘'을 확신할 수 없으면 '오늘 푼 문제', 오늘 칸, '어제 프리즈' 같은 날짜 기준 표시를 하지 않는다(날짜를 밝혀 보여준다).
  const dayKnown = !dayUncertainNow() && !core.clockProblemActive(local.clockProblem, now);
  // 06:00 직후 반영 여유 안에 만들어진 잠정 정보(provisional)는 '오늘'의 값으로 보여주지 않는다.
  const labelToday = dayKnown && !snap?.provisional ? today : null;
  const deadline = core.nextDayBoundary(eNow);
  const remaining = core.formatDuration(deadline - eNow);

  el.card.dataset.kind = status.kind;
  el.handleBadge.hidden = !settings.handle;
  el.handleBadge.textContent = settings.handle;
  el.handleBadge.title = settings.handle;

  const view = describe(status, snap);
  el.icon.textContent = view.icon;
  // 제목/설명은 live region이다. 남은 시간처럼 계속 바뀌는 값은 넣지 않고(아래 meta 줄에 표시),
  // 실제로 바뀔 때만 갱신해서 스크린 리더가 같은 내용을 반복해서 읽지 않게 한다.
  if (el.title.textContent !== view.title) el.title.textContent = view.title;
  if (el.detail.textContent !== view.detail) el.detail.textContent = view.detail;

  // 통계 (오류일 때는 마지막으로 성공한 값)
  el.stats.hidden = !snap;
  if (snap) {
    el.currentStreak.textContent = `${core.formatNumber(snap.currentStreak)}일`;
    el.maxStreak.textContent = `${core.formatNumber(snap.maxStreak)}일`;
    el.todaySolved.textContent = snap.dayKey === labelToday ? `${core.formatNumber(snap.todaySolvedCount)}개` : '-';
  }

  renderRecent(snap, labelToday);

  // 부가 안내
  const notes = [];
  if (snap && snap.dayKey === labelToday && snap.frozenYesterday) notes.push('❄️ 어제 스트릭 프리즈가 사용되었어요.');
  if (status.stale) {
    const when = core.formatClock(toLocalClock(snap.fetchedAt));
    const failed = !!local.lastError && core.sameHandle(local.lastError.handle, settings.handle);
    notes.push(
      failed
        ? `⚠️ 최근 확인에 실패해서 ${when} 기준 정보를 보여주고 있어요.`
        : `ℹ️ 요청 제한으로 확인을 미루고 있어서 ${when} 기준 정보를 보여주고 있어요.`,
    );
  }
  if (status.kind === 'error' && snap) {
    notes.push(
      snap.dayKey === labelToday
        ? `ℹ️ 아래 정보는 ${core.formatClock(toLocalClock(snap.fetchedAt))}에 마지막으로 확인한 값이에요.`
        : `ℹ️ 통계는 ${safeDayLabel(snap.dayKey)}에 마지막으로 확인한 값이에요.`,
    );
  }
  if (
    status.kind === 'error' &&
    local.lastError?.serverCode &&
    core.sameHandle(local.lastError.handle, settings.handle) &&
    status.code === local.lastError.code &&
    status.code !== core.ERROR_CODES.NOT_FOUND
  ) {
    notes.push(`ℹ️ solved.ac 응답 코드: ${local.lastError.serverCode}`);
  }
  const waitUntil = rateLimitedUntil(now);
  if (waitUntil) notes.push(`⏳ 요청 제한 때문에 ${core.formatWhen(waitUntil, now)} 이후에 다시 확인할 수 있어요.`);
  const snoozed = dayKnown && local.snoozeDayKey && local.snoozeDayKey === today;
  if (snoozed && settings.handle) notes.push('🔕 오늘은 알림을 끈 상태예요.');
  el.notes.replaceChildren(...notes.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
  el.notes.hidden = notes.length === 0;

  // 마감 / 마지막 확인
  const tracking = status.kind !== 'setup';
  const settled = status.kind === 'solved' || status.kind === 'vacation';
  el.deadline.textContent = !tracking
    ? ''
    : !dayKnown
      ? '마감 시각은 solved.ac에서 오늘 날짜를 다시 확인한 뒤 보여드릴게요.'
      : settled
      ? `다음 날 시작: ${core.formatKstClock(deadline)} · ${remaining} 후`
      : `오늘 마감: ${core.formatKstClock(deadline)} · ${remaining} 남음`;
  el.lastChecked.textContent =
    tracking && local.lastAttemptAt ? `마지막 확인: ${formatLastChecked(local.lastAttemptAt, now)}` : '';

  // 버튼
  el.refreshButton.disabled = refreshing || !tracking || !!waitUntil;
  el.refreshButton.setAttribute('aria-busy', String(refreshing));
  el.refreshButton.textContent = refreshing ? '확인 중…' : '지금 확인';
  // '오늘은 그만 알림'은 오늘이 어느 날인지 알 때만(모르면 다른 날을 끌 수 있다).
  const canSnooze = tracking && dayKnown && (status.kind === 'unsolved' || status.kind === 'error');
  el.snoozeButton.hidden = !canSnooze && !snoozed;
  el.snoozeButton.textContent = snoozed ? '오늘 알림 다시 켜기' : '오늘은 그만 알림';
  el.snoozeButton.dataset.action = snoozed ? 'unsnooze' : 'snooze';
  // 누를 때 이 핸들·날짜에만 적용되도록 함께 보낸다(그 사이 다른 탭에서 핸들을 바꿨거나 06:00이 지났으면 적용하지 않음).
  el.snoozeButton.dataset.handle = settings.handle;
  el.snoozeButton.dataset.day = today;

  // 백준에서 풀었는데 solved.ac에 아직 반영되지 않았을 때: solved.ac 연동 설정의 '채점 사이트에서 다시 불러오기'로 안내한다.
  // 이미 풀었어도 문제 수나 최근 기록이 빠졌을 수 있으므로 추적 중이면 항상 보여준다.
  // 서비스 워커와 같은 계산으로 다음 확인 시각을 정한다(429 대기·백오프·실패 뒤 재시도를 지킨다).
  const reimportNotBefore = core.reimportNotBefore({
    settings,
    handle: settings.handle,
    snapshot: local.snapshot,
    lastError: local.lastError,
    backoffUntil: local.backoffUntil,
    rateLimitedUntil: rateLimitedUntil(now),
    lastAttemptAt: local.lastAttemptAt,
    nowMs: now,
  });
  const nextReimportCheck = core.reimportRecheckAt({
    watch: local.reimportWatch,
    handle: settings.handle,
    statusKind: status.kind,
    snapshot: local.snapshot,
    lastAttemptAt: local.lastAttemptAt,
    notBefore: reimportNotBefore,
    nowMs: now,
  });
  // 기다리는 중인데 요청 제한·재시도 대기가 기간을 넘겨 이번에는 확인할 수 없는 경우
  const reimportBlocked =
    nextReimportCheck === null &&
    tracking &&
    !!local.reimportWatch &&
    core.sameHandle(local.reimportWatch.handle, settings.handle) &&
    !core.reimportWatchDone({ watch: local.reimportWatch, snapshot: local.snapshot, nowMs: now }) &&
    reimportNotBefore >= local.reimportWatch.until;
  el.reimport.hidden = !tracking;
  const account = settings.handle ? `${settings.handle} 계정으로 로그인해서 ` : '';
  const reimportHint =
    nextReimportCheck !== null
      ? `${settings.handle}의 다시 불러온 기록을 기다리는 중이에요. ${core.formatClock(nextReimportCheck)}부터 ${core.formatClock(local.reimportWatch.until)}까지 2분마다 다시 확인해요.`
      : reimportBlocked
        ? `요청 제한·재시도 대기 때문에 ${core.formatClock(reimportNotBefore)} 전에는 다시 확인할 수 없어요. 그 뒤 '지금 확인'을 눌러주세요.`
      : status.kind === 'unsolved'
        ? `백준에서 풀었는데 그대로라면 solved.ac 연동 설정(새 탭)에서 ${account}다시 불러와 주세요(12시간에 두 번까지). 반영되는 몇 분 동안 2분마다 다시 확인해요.`
        : `푼 문제가 빠져 있다면 solved.ac 연동 설정(새 탭)에서 ${account}다시 불러올 수 있어요(12시간에 두 번까지).`;
  if (el.reimportHint.textContent !== reimportHint) el.reimportHint.textContent = reimportHint;

  // 툴바 팝업은 다른 창을 누르면 닫혀서 입력하던 값이 사라진다. 처음 설정할 때는 탭에서 하도록 권한다.
  el.openTabButton.hidden = inTab || status.kind !== 'setup';

  // 알림 권한이 꺼져 있거나 마지막 알림 표시가 실패했으면 안내한다.
  el.permissionWarning.hidden = !(notificationsDenied || local.notificationError);
}

/** 이 앱(클라이언트)이 429 Retry-After로 기다려야 하면 그 시각(내 시계), 아니면 null */
function rateLimitedUntil(now) {
  return core.activeRateLimit(current.local.rateLimits, current.creds.clientId, now);
}

function describe(status, snap) {
  switch (status.kind) {
    case 'setup': {
      const t = core.setupText(status);
      return { icon: '⚙️', title: t.title, detail: t.detail };
    }
    case 'checking':
      return { icon: '⏳', title: '확인 중…', detail: 'solved.ac에서 오늘 기록을 불러오고 있어요.' };
    case 'solved': {
      const n = snap.todaySolvedCount;
      return {
        icon: '✅',
        title: '오늘 문제 해결 완료!',
        detail: n > 0 ? `오늘 ${core.formatNumber(n)}문제를 풀었어요. 내일도 화이팅!` : '오늘 스트릭이 유지되었어요.',
      };
    }
    case 'unsolved':
      return status.atRisk
        ? {
            icon: '🔥',
            title: '오늘 아직 문제를 풀지 않았어요',
            detail: `${core.formatNumber(snap.currentStreak)}일 스트릭이 끊기기 전에 오늘 문제를 풀어주세요.`,
          }
        : { icon: '📝', title: '오늘 아직 문제를 풀지 않았어요', detail: '오늘 한 문제를 풀어 새 스트릭을 시작해보세요!' };
    case 'vacation': {
      const from = snap.vacation?.fromDay;
      return {
        icon: '🏖️',
        title: '스트릭 휴가 중',
        detail: `${from ? `${safeDayLabel(from)}부터 ` : ''}휴가 중이라 스트릭이 끊기지 않아요. 다음에 문제를 풀면 휴가가 끝나요.`,
      };
    }
    case 'error': {
      const t = core.errorText(status.code);
      return { icon: '⚠️', title: t.title, detail: t.detail };
    }
    default:
      return { icon: '❓', title: '상태를 알 수 없어요', detail: '' };
  }
}

function renderRecent(snap, today) {
  if (!snap || !Array.isArray(snap.recent) || snap.dayKey !== today) {
    el.recent.hidden = true;
    el.recent.replaceChildren();
    return;
  }
  const items = snap.recent.map((d) => {
    const li = document.createElement('li');
    const state = d.solvedCount > 0 ? 'solved' : d.streakRepaired ? 'repaired' : d.freezeUsed ? 'freeze' : 'none';
    li.dataset.state = state;
    li.dataset.today = String(d.day === today);
    const label =
      state === 'solved'
        ? `${d.solvedCount}문제`
        : state === 'repaired'
          ? '스트릭 복구'
          : state === 'freeze'
            ? '스트릭 프리즈 사용'
            : '기록 없음';
    li.title = `${safeDayLabel(d.day)}: ${label}`;
    const cell = document.createElement('span');
    cell.className = 'cell';
    cell.setAttribute('aria-hidden', 'true');
    // 색만으로 구분하지 않도록 칸 안에 표시를 넣는다: 푼 문제 수 / ❄ 프리즈 / ↺ 복구
    cell.textContent =
      state === 'solved' ? (d.solvedCount > 99 ? '99+' : String(d.solvedCount)) : state === 'freeze' ? '❄' : state === 'repaired' ? '↺' : '';
    const weekday = document.createElement('span');
    weekday.setAttribute('aria-hidden', 'true');
    weekday.textContent = WEEKDAYS[new Date(`${d.day}T00:00:00Z`).getUTCDay()] ?? '';
    const sr = Object.assign(document.createElement('span'), {
      className: 'visually-hidden',
      textContent: `${safeDayLabel(d.day)}: ${label}`,
    });
    li.append(cell, weekday, sr);
    return li;
  });
  el.recent.replaceChildren(...items);
  el.recent.hidden = false;
}

function formatLastChecked(ms, now) {
  const diff = now - ms;
  if (diff < 60 * 1000) return '방금 전';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}분 전`;
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return sameDay
    ? core.formatClock(ms)
    : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
        new Date(ms),
      );
}

// ---------------------------------------------------------------------------
// 설정 폼
// ---------------------------------------------------------------------------

/**
 * 저장된 값으로 폼을 채운다.
 * @param {{onlyClean?: boolean}} [opts] onlyClean이면 사용자가 고치지 않은 칸만 채운다(다른 곳에서 바뀐 값 반영).
 */
function fillForm({ onlyClean = false } = {}) {
  const { settings, creds } = current;
  const clean = (key) => !onlyClean || !dirty.has(key);
  // 계정 칸(핸들/클라이언트 ID/시크릿)은 함께 움직인다: 하나라도 고치는 중이면 셋 다, 그리고 기준 계정도 그대로 둔다.
  // (예: 시크릿을 입력하는 중에 다른 탭에서 클라이언트 ID가 바뀌어도, 그 시크릿이 새 ID와 짝지어지지 않는다.)
  if (!onlyClean || !ACCOUNT_KEYS.some((k) => dirty.has(k))) {
    const suggested = !settings.handle && current.legacyHandle ? current.legacyHandle : '';
    el.handleInput.value = settings.handle || suggested;
    unconfirmedSuggestion = suggested;
    el.legacyHint.hidden = !suggested;
    el.confirmLegacyButton.hidden = false;
    el.legacyHintText.textContent = suggested
      ? `v1에서 쓰던 아이디(${suggested})를 넣어 두었어요. 새 solved.ac 핸들이 맞으면 '이 아이디가 맞아요'를 누르고, 다르면 새 핸들을 입력해주세요.`
      : '';
    el.clientIdInput.value = creds.clientId;
    el.clientSecretInput.value = '';
    setSecretVisible(false);
    formBase = { handle: settings.handle, clientId: creds.clientId, credRev: creds.rev, hasSecret: creds.hasSecret };
  }
  el.clientSecretInput.placeholder = creds.hasSecret ? '저장됨 · 바꿀 때만 입력' : '클라이언트 시크릿';
  if (clean('checkIntervalMin')) el.intervalInput.value = String(settings.checkIntervalMin);
  if (clean('notifyUnsolved')) el.notifyUnsolved.checked = settings.notifyUnsolved;
  if (clean('notifyStartHours')) el.notifyStart.value = String(settings.notifyStartHours);
  if (clean('remindIntervalMin')) el.remindInterval.value = String(settings.remindIntervalMin);
  if (clean('notifyError')) el.notifyError.checked = settings.notifyError;
  syncUnsolvedOptions();
  if (!onlyClean) {
    clearInvalid();
    dirty.clear();
  }
}

/** 예전 아이디 제안을 사용자가 직접 확인했다: 저장할 때 이 핸들로 확인한다. */
function confirmLegacySuggestion() {
  dirty.add('handle');
  unconfirmedSuggestion = '';
  // 방금 확인을 요청한 오류 안내는 지운다.
  clearInvalid();
  setSaveStatus('', null);
  el.confirmLegacyButton.hidden = true;
  el.legacyHintText.textContent = `저장하면 ${el.handleInput.value.trim()}을(를) solved.ac 핸들로 확인해요.`;
  el.handleInput.focus();
}

function setSecretVisible(visible) {
  el.clientSecretInput.type = visible ? 'text' : 'password';
  el.toggleSecret.textContent = visible ? '숨기기' : '보기';
  el.toggleSecret.setAttribute('aria-pressed', String(visible));
}

function syncUnsolvedOptions() {
  const enabled = el.notifyUnsolved.checked;
  el.notifyStart.disabled = !enabled;
  el.remindInterval.disabled = !enabled;
  el.unsolvedOptions.dataset.disabled = String(!enabled);
}

function setSaveStatus(text, tone) {
  // 오류는 바로 읽어주고(alert), 나머지는 차례가 오면 읽어준다(status).
  el.saveStatus.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.saveStatus.textContent = text;
  if (tone) el.saveStatus.dataset.tone = tone;
  else delete el.saveStatus.dataset.tone;
}

const VALIDATED_INPUTS = () => [el.handleInput, el.clientIdInput, el.clientSecretInput, el.intervalInput];

function clearInvalid() {
  for (const input of VALIDATED_INPUTS()) {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-errormessage');
  }
}

function markInvalid(input, message) {
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-errormessage', 'saveStatus');
  input.focus();
  setSaveStatus(message, 'error');
}

const SAVE_ERRORS = {
  'empty-handle': 'solved.ac 핸들을 입력해주세요.',
  'invalid-handle': '핸들은 영문, 숫자, 밑줄(_)만 쓸 수 있어요. 프로필 주소를 붙여넣어도 돼요.',
  'not-found': '이 핸들의 solved.ac 사용자를 찾을 수 없어요. 새 solved.ac 핸들은 백준 아이디와 다를 수 있어요.',
  rejected: 'solved.ac가 이 핸들로 한 요청을 거절했어요. 핸들을 확인해주세요.',
  'missing-credentials': '클라이언트 ID와 시크릿을 모두 입력해주세요.',
  'invalid-credentials': '클라이언트 ID/시크릿에 공백이나 허용되지 않는 문자가 있어요.',
  'storage-protection': '키를 안전하게 저장할 수 없어서 저장하지 않았어요. Chrome을 최신 버전으로 업데이트해주세요.',
  conflict: '그 사이 다른 곳(다른 기기 등)에서 핸들이나 API 키가 바뀌었어요. 바뀐 내용을 확인한 뒤 다시 저장해주세요.',
  'unconfirmed-handle': "v1에서 쓰던 아이디가 새 solved.ac 핸들이 맞는지 확인해주세요. 맞으면 '이 아이디가 맞아요'를 누르고, 다르면 새 핸들을 입력하세요.",
  partial: '일부만 저장됐어요. 실제로 저장된 값으로 화면을 바꿨으니 확인하고 다시 저장해주세요.',
  auth: 'solved.ac가 이 API 키를 받아주지 않았어요. 클라이언트 ID와 시크릿을 다시 확인해주세요.',
};

const FIELD_FOR_ERROR = {
  'empty-handle': 'handleInput',
  'unconfirmed-handle': 'handleInput',
  'invalid-handle': 'handleInput',
  'not-found': 'handleInput',
  rejected: 'handleInput',
  'missing-credentials': 'clientIdInput',
  'invalid-credentials': 'clientIdInput',
  auth: 'clientSecretInput',
};

async function onSubmit(event) {
  event.preventDefault();
  setSaveStatus('', null);
  clearInvalid();

  // 고친 알림/주기 설정만 보낸다(다른 기기에서 바꾼 값을 덮어쓰지 않도록).
  const preferences = {};
  if (dirty.has('checkIntervalMin')) {
    const interval = Number(el.intervalInput.value);
    if (!Number.isInteger(interval) || interval < core.CHECK_INTERVAL_MIN || interval > core.CHECK_INTERVAL_MAX) {
      markInvalid(el.intervalInput, `확인 주기는 ${core.CHECK_INTERVAL_MIN}~${core.CHECK_INTERVAL_MAX}분 사이의 정수로 입력해주세요.`);
      return;
    }
    preferences.checkIntervalMin = interval;
  }
  if (dirty.has('notifyUnsolved')) preferences.notifyUnsolved = el.notifyUnsolved.checked;
  if (dirty.has('notifyError')) preferences.notifyError = el.notifyError.checked;
  if (dirty.has('notifyStartHours')) preferences.notifyStartHours = Number(el.notifyStart.value);
  if (dirty.has('remindIntervalMin')) preferences.remindIntervalMin = Number(el.remindInterval.value);

  const clientId = el.clientIdInput.value.trim();
  const clientSecret = el.clientSecretInput.value.trim();
  const noStoredCreds = !current.creds.clientId && !current.creds.hasSecret;
  const accountEdited = ACCOUNT_KEYS.some((k) => dirty.has(k)) || !!clientSecret;
  const base = { ...formBase };

  // API 키가 아직 하나도 없으면(입력도 저장된 것도 없음) 알림/주기 설정만 저장한다.
  // 예: 설정 알림을 끄고 싶은데 아직 앱을 등록하지 않은 경우.
  if (noStoredCreds && !clientId && !clientSecret) {
    // 사용자가 직접 입력한 핸들은 함께 저장한다(키를 넣을 때 확인). 예전 아이디 제안을 그대로 둔 것은 저장하지 않는다.
    const typed = dirty.has('handle') ? el.handleInput.value.trim() : '';
    if (dirty.has('handle') && !typed && current.settings.handle) {
      markInvalid(el.handleInput, SAVE_ERRORS['empty-handle']);
      return;
    }
    if (typed && !core.normalizeHandleInput(typed).ok) {
      markInvalid(el.handleInput, SAVE_ERRORS['invalid-handle']);
      return;
    }
    await submit({ type: 'saveSettings', prefsOnly: true, settings: { ...preferences, ...(typed && { handle: typed }) }, base });
    return;
  }

  // 아직 핸들이 없는데(다른 기기에서 지웠거나 v1에서 업데이트) 계정 칸은 고치지 않았다면, 고친 알림/주기 설정만 저장한다.
  // 예전 아이디 제안은 사용자가 확인하기 전에는 핸들로 쓰지 않는다.
  if (!current.settings.handle && !accountEdited) {
    await submit({ type: 'saveSettings', prefsOnly: true, settings: preferences, base });
    return;
  }

  const settings = { ...preferences };
  // 처음 설정할 때나 핸들을 고쳤을 때만 핸들을 보낸다. 예전 아이디 제안은 직접 확인('이 아이디가 맞아요')해야 보낸다.
  if (!current.settings.handle && !dirty.has('handle') && unconfirmedSuggestion) {
    markInvalid(el.handleInput, SAVE_ERRORS['unconfirmed-handle']);
    return;
  }
  if (dirty.has('handle') || !current.settings.handle) {
    const parsed = core.normalizeHandleInput(el.handleInput.value);
    if (!parsed.ok) {
      markInvalid(el.handleInput, SAVE_ERRORS[parsed.reason === 'empty' ? 'empty-handle' : 'invalid-handle']);
      return;
    }
    settings.handle = parsed.handle;
  }
  let credentials;
  if (dirty.has('clientId') || clientSecret || noStoredCreds) {
    // 빈 시크릿 = 폼이 바탕으로 한 키의 시크릿 유지. 그 사이 다른 곳에서 키가 바뀌었으면 서비스 워커가 충돌로 알린다.
    const keepSecret = !clientSecret && formBase.hasSecret && clientId === formBase.clientId;
    if (!clientId || (!clientSecret && !keepSecret)) {
      markInvalid(clientId ? el.clientSecretInput : el.clientIdInput, SAVE_ERRORS['missing-credentials']);
      return;
    }
    if (!core.isValidCredential(clientId) || (clientSecret && !core.isValidCredential(clientSecret))) {
      markInvalid(core.isValidCredential(clientId) ? el.clientSecretInput : el.clientIdInput, SAVE_ERRORS['invalid-credentials']);
      return;
    }
    credentials = { clientId, clientSecret };
  }
  await submit({ type: 'saveSettings', settings, ...(credentials && { credentials }), base });
}

/** 저장하는 동안 폼을 잠근다(저장 중에 고친 값이 저장 결과로 덮여 사라지지 않도록). 글자 칸은 포커스를 지키도록 읽기 전용. */
function setFormLocked(locked) {
  saving = locked;
  for (const input of [el.handleInput, el.clientIdInput, el.clientSecretInput, el.intervalInput]) input.readOnly = locked;
  for (const control of [el.notifyUnsolved, el.notifyError, el.toggleSecret, el.resetButton, el.confirmLegacyButton]) {
    control.disabled = locked;
  }
  if (locked) {
    el.notifyStart.disabled = true;
    el.remindInterval.disabled = true;
  } else {
    syncUnsolvedOptions();
  }
  el.form.dataset.locked = String(locked);
}

async function submit(message) {
  el.saveButton.disabled = true;
  el.saveButton.setAttribute('aria-busy', 'true');
  el.saveButton.textContent = message.prefsOnly ? '저장 중…' : '확인 중…';
  setFormLocked(true);
  try {
    const res = await sendMessage(message);
    if (!res?.ok) {
      const field = el[FIELD_FOR_ERROR[res?.error]];
      let message = SAVE_ERRORS[res?.error] ?? '저장하지 못했어요. 잠시 후 다시 시도해주세요.';
      if ((res?.error === 'auth' || res?.error === 'rejected') && res.serverCode) message += ` (solved.ac 응답: ${res.serverCode})`;
      if (res?.error === 'conflict') {
        // 계정 칸을 최신 값으로 바꿔 보여준다(고친 알림 설정은 그대로 둔다).
        for (const key of ACCOUNT_KEYS) dirty.delete(key);
        await loadState();
        fillForm({ onlyClean: true });
        render();
      } else if (res?.error === 'partial') {
        // 실제로 저장된 값으로 폼 전체를 다시 채운다(다시 저장할 때 자기 저장과 충돌하지 않게).
        await loadState();
        fillForm();
        render();
      }
      if (field) markInvalid(field, message);
      else setSaveStatus(message, 'error');
      return;
    }
    // 저장은 끝났다. 화면을 다시 채우다 실패해도 '저장하지 못함'으로 알리지 않는다.
    try {
      await loadState();
      fillForm();
      render();
    } catch (e) {
      console.error('[SSC] 저장 뒤 화면 갱신 오류', e);
      setSaveStatus('저장했어요. 최신 설정은 창을 다시 열어 확인해주세요.', 'warn');
      return;
    }
    if (res.warning === 'prefs-only') {
      setSaveStatus(
        res.settings?.handle && !current.creds.clientId
          ? `알림 설정과 핸들(${res.settings.handle})을 저장했어요(동기화됨). API 키를 입력해야 스트릭 확인을 시작해요.`
          : current.creds.clientId
            ? '알림 설정을 저장했어요(동기화됨). 핸들을 입력해야 스트릭 확인을 시작해요.'
            : '알림 설정을 저장했어요(동기화됨). 핸들과 API 키를 입력해야 스트릭 확인을 시작해요.',
        'warn',
      );
    } else if (res.warning) {
      setSaveStatus(`저장했어요. 다만 지금은 확인하지 못했어요: ${core.errorText(res.warning).title}`, 'warn');
    } else if (res.followUpFailed) {
      setSaveStatus('저장했어요. 다만 확인 일정을 맞추는 중 문제가 있어서 곧 다시 맞춰요.', 'warn');
    } else {
      setSaveStatus('저장했어요!', 'ok');
    }
  } catch (e) {
    console.error('[SSC] 설정 저장 오류', e);
    setSaveStatus('저장하지 못했어요. 확장 프로그램을 다시 열어주세요.', 'error');
  } finally {
    setFormLocked(false);
    el.saveButton.disabled = false;
    el.saveButton.setAttribute('aria-busy', 'false');
    el.saveButton.textContent = '저장';
    render(); // 저장하는 동안 미뤄 둔 바깥 변경 반영
  }
}

// ---------------------------------------------------------------------------
// 동작
// ---------------------------------------------------------------------------

async function requestRefresh(force) {
  if (refreshing || currentStatus(core.effectiveNow(Date.now(), current.local.clockSkewMs)).kind === 'setup') return;
  refreshing = true;
  render();
  try {
    await sendMessage({ type: 'refresh', force });
  } catch (e) {
    console.error('[SSC] 새로고침 요청 오류', e);
  } finally {
    refreshing = false;
    try {
      await loadState();
    } catch (e) {
      console.error('[SSC] 상태 읽기 오류', e);
    }
    render();
  }
}

async function openSolvedAc() {
  const { settings, local } = current;
  const status = currentStatus(core.effectiveNow(Date.now(), local.clockSkewMs));
  const url =
    settings.handle && !(status.kind === 'error' && status.code === core.ERROR_CODES.NOT_FOUND)
      ? core.profileUrl(settings.handle)
      : core.SOLVED_ORIGIN;
  await chrome.tabs.create({ url });
  if (!inTab) window.close();
}

/** solved.ac 연동 설정을 열고, 반영될 때까지 몇 분 동안 더 자주 확인하게 한다(다시 불러오기는 사용자가 직접 누른다). */
async function openReimport() {
  // 기다리는 기간은 서비스 워커가 적는다(응답을 기다리지 않는다 — 다른 확인이 진행 중이어도 탭은 바로 연다. 툴바 팝업은
  // 탭이 열리면 닫히지만, 보낸 요청은 그대로 처리된다).
  const watching = sendMessage({ type: 'watchReimport', handle: current.settings.handle ?? '' }).catch((e) => {
    console.error('[SSC] 다시 불러오기 확인 예약 오류', e);
    return null;
  });
  await chrome.tabs.create({ url: core.INTEGRATIONS_URL });
  if (!inTab) {
    window.close();
    return;
  }
  const res = await watching;
  try {
    await loadState();
  } catch (e) {
    console.error('[SSC] 상태 읽기 오류', e);
  }
  render();
  if (!res?.ok) setSaveStatus("다시 확인 예약을 하지 못했어요. 다시 불러온 뒤 '지금 확인'을 눌러주세요.", 'error');
}

async function toggleSnooze() {
  const action = el.snoozeButton.dataset.action === 'unsnooze' ? 'unsnooze' : 'snooze';
  el.snoozeButton.disabled = true;
  try {
    // 화면에 보이는 핸들·날짜에만 적용한다. 그 사이 바뀌었으면 서비스 워커가 거절하고, 아래에서 새 상태를 보여준다.
    const res = await sendMessage({ type: action, handle: el.snoozeButton.dataset.handle ?? '', dayKey: el.snoozeButton.dataset.day ?? '' });
    if (!res?.ok) setSaveStatus('적용하지 못했어요. 화면을 새로 고친 뒤 다시 시도해주세요.', 'error');
    try {
      await loadState();
    } catch (e) {
      console.error('[SSC] 상태 읽기 오류', e);
    }
    render();
  } finally {
    el.snoozeButton.disabled = false;
  }
}

/** 모든 데이터 지우기: 무엇이 지워지고 무엇이 남는지 보여 주고, '지우기'나 '취소'를 누를 때까지 기다린다. */
function showResetConfirm(show) {
  el.resetConfirm.hidden = !show;
  el.resetButton.hidden = show;
  el.resetButton.setAttribute('aria-expanded', String(show));
  (show ? el.resetCancelButton : el.resetButton).focus();
}

async function onResetConfirmed() {
  el.resetConfirmButton.disabled = true;
  el.resetCancelButton.disabled = true;
  try {
    const res = await sendMessage({ type: 'resetAll' });
    // 지우기 기록을 남긴 뒤 멈춘 경우(reset-incomplete)와 다 지운 경우에만 폼 전체를 저장된 값으로 다시 채운다.
    // 아무것도 지우지 않았거나 어디까지 지웠는지 모르면 고치던 값은 그대로 둔다.
    const erased = res?.ok || res?.error === 'reset-incomplete';
    if (erased) dirty.clear();
    let reloaded = true;
    try {
      await loadState();
    } catch (e) {
      console.error('[SSC] 지운 뒤 화면 갱신 오류', e);
      reloaded = false;
    }
    if (reloaded) {
      fillForm(erased ? {} : { onlyClean: true });
      render();
    } else if (res?.ok) {
      // 다 지웠는데 화면을 다시 읽지 못했다: 입력 칸의 값(키 포함)은 비운다.
      for (const input of [el.handleInput, el.clientIdInput, el.clientSecretInput]) input.value = '';
    }
    if (res?.ok && !reloaded) {
      setSaveStatus('모든 데이터를 지웠어요. 화면은 창을 다시 열면 바뀌어요.', 'ok');
    } else if (res?.error === 'reset-not-started') {
      setSaveStatus('삭제를 시작하지 못했어요. 이번에는 아무것도 지우지 않았으니 다시 시도해주세요.', 'error');
    } else if (res?.error === 'reset-incomplete') {
      setSaveStatus('지우는 도중에 멈췄어요. 확장 프로그램이 다시 시작하거나 다음에 저장·확인할 때 마저 지워요.', 'error');
    } else if (!res?.ok) {
      setSaveStatus('지우는 중 오류가 났어요. 일부만 지워졌을 수 있으니 저장된 값을 확인하고 다시 시도해주세요.', 'error');
    }
    else if (res.keptWaitUntil) {
      setSaveStatus(
        `모든 데이터를 지웠어요. solved.ac가 정한 요청 제한 대기(${core.formatWhen(res.keptWaitUntil, Date.now())}까지)의 기록만 어느 키였는지 없이 남겨 두었어요.`,
        'ok',
      );
    } else setSaveStatus('모든 데이터를 지웠어요.', 'ok');
  } catch (e) {
    console.error('[SSC] 데이터 지우기 오류', e);
    setSaveStatus('지우는 중 오류가 났어요. 일부만 지워졌을 수 있으니 확장 프로그램을 다시 열어 확인해주세요.', 'error');
  } finally {
    el.resetConfirmButton.disabled = false;
    el.resetCancelButton.disabled = false;
    showResetConfirm(false);
  }
}

async function checkNotificationPermission() {
  try {
    notificationsDenied = (await chrome.notifications.getPermissionLevel()) === 'denied';
  } catch {
    notificationsDenied = false;
  }
  render();
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

async function onStorageChanged(changes, area) {
  const seq = loadSeq + 1; // 이 변경을 반영하는 읽기의 번호
  if (area === 'sync' || core.CREDENTIALS_KEY in changes || 'credRev' in changes) fillAfterSeq = seq;
  try {
    await loadState();
  } catch (e) {
    console.error('[SSC] 상태 읽기 오류', e); // 다음 변경이나 다시 열 때 읽는다
    return;
  }
  if (seq !== loadSeq) return; // 더 최근 읽기가 이어서 처리한다
  render();
}

async function init() {
  el.version.textContent = `v${chrome.runtime.getManifest().version}`;
  inTab = !!(await chrome.tabs.getCurrent().catch(() => null));
  document.documentElement.classList.toggle('in-tab', inTab);
  // 첫 읽기 전에 변경 알림을 먼저 구독한다(읽는 사이 다른 탭에서 키를 저장해도 놓치지 않도록).
  chrome.storage.onChanged.addListener(onStorageChanged);
  await loadState();
  fillForm();
  render();
  checkNotificationPermission();

  const status = currentStatus(core.effectiveNow(Date.now(), current.local.clockSkewMs));
  if (
    inTab ||
    status.kind === 'setup' ||
    (status.kind === 'error' && core.SETTINGS_ERRORS.has(status.code))
  ) {
    el.settings.open = true;
    const target = status.kind === 'setup' && status.missing === 'credentials' ? el.clientIdInput : el.handleInput;
    target.focus();
  }

  el.form.addEventListener('submit', onSubmit);
  const markDirty = (event) => {
    const key = FIELD_KEYS[event.target?.id];
    if (key) dirty.add(key);
  };
  el.form.addEventListener('input', markDirty);
  el.form.addEventListener('change', markDirty);
  el.notifyUnsolved.addEventListener('change', syncUnsolvedOptions);
  el.toggleSecret.addEventListener('click', () => setSecretVisible(el.clientSecretInput.type === 'password'));
  el.refreshButton.addEventListener('click', () => requestRefresh(true));
  el.openButton.addEventListener('click', openSolvedAc);
  el.snoozeButton.addEventListener('click', toggleSnooze);
  el.reimportButton.addEventListener('click', openReimport);
  el.resetButton.addEventListener('click', () => showResetConfirm(true));
  el.resetCancelButton.addEventListener('click', () => showResetConfirm(false));
  el.resetConfirmButton.addEventListener('click', onResetConfirmed);
  el.resetConfirm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      showResetConfirm(false);
    }
  });
  el.confirmLegacyButton.addEventListener('click', confirmLegacySuggestion);
  // 핸들을 직접 고치면 예전 아이디 안내는 더 맞지 않으므로 숨긴다.
  el.handleInput.addEventListener('input', () => {
    unconfirmedSuggestion = '';
    el.legacyHint.hidden = true;
    el.legacyHintText.textContent = ''; // 숨긴 안내도 aria-describedby로 읽히므로 비운다
    // 핸들 칸의 오류 안내(예: 제안값 확인 요청)는 고치는 순간 더 맞지 않으므로 지운다.
    if (el.handleInput.getAttribute('aria-invalid') === 'true') {
      el.handleInput.removeAttribute('aria-invalid');
      el.handleInput.removeAttribute('aria-errormessage');
      setSaveStatus('', null);
    }
  });
  el.openTabButton.addEventListener('click', async () => {
    await chrome.runtime.openOptionsPage();
    window.close();
  });


  // 남은 시간 표시 갱신
  setInterval(render, 30 * 1000);

  // 팝업을 열면 너무 오래된 정보는 새로 확인한다(서비스 워커가 간격 제한을 지킨다).
  requestRefresh(false);
}

init().catch((e) => {
  console.error('[SSC] 팝업 초기화 오류', e);
  el.icon.textContent = '❗';
  el.title.textContent = '팝업을 불러오지 못했어요';
  el.detail.textContent = '확장 프로그램을 다시 열어주세요.';
});
