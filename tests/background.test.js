// background.js 흐름 테스트: 가짜 chrome.* + 가짜 fetch + 가짜 시계로 서비스 워커를 Node에서 돌린다.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeChrome, enableAccessLevel, settle } from './helpers/fake-chrome.js';
import * as core from '../lib/core.js';

const MIN = 60 * 1000;
const at = (iso) => Date.parse(iso);
const CREDS = { clientId: 'cid', clientSecret: 'secret-1' };
const CREDS2 = { clientId: 'cid2', clientSecret: 'secret-2' };
const VALID_KEYS = new Set(['cid:secret-1', 'cid2:secret-2']);
const SETTINGS = {
  handle: 'Taeyang',
  checkIntervalMin: 5,
  notifyUnsolved: true,
  notifyStartHours: 24,
  remindIntervalMin: 60,
  notifyError: true,
};

let instance = 0;
let env;

/** solved.ac API 가짜 응답. mode를 바꿔 가며 쓴다. */
function makeApi() {
  const api = { mode: 'solved', calls: [], serverLagMs: 0, serverOffsetMs: 0, retryAfter: '600', onFetch: null, rejectFutureDay: false };
  api.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = new Headers(init.headers);
    api.calls.push({ url: u.href, id: h.get('x-client-id'), secret: h.get('x-client-secret'), at: Date.now() });
    if (api.onFetch) await api.onFetch(u);
    // 서버가 응답을 만든 시각(Date 헤더, serverOffsetMs = 서버 시계 - 내 시계). serverLagMs만큼 늦게 도착한 것처럼 시계를 돌린다.
    const date = new Date(Date.now() + api.serverOffsetMs).toUTCString();
    if (api.serverLagMs) mock.timers.tick(api.serverLagMs);
    const json = (status, body, extra = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date, ...extra } });
    if (!VALID_KEYS.has(`${h.get('x-client-id')}:${h.get('x-client-secret')}`) || api.mode === 'auth') {
      return json(401, { error: { code: 'UNAUTHENTICATED', message: 'bad' } });
    }
    const handle = u.pathname.split('/')[4];
    // 서버의 오늘보다 뒤의 날을 요청하면 거절하는 서버를 흉내 낸다(실제 API가 그런지는 알 수 없다).
    if (api.rejectFutureDay && u.searchParams.get('to') > core.solvedDayKey(Date.now() + api.serverOffsetMs)) {
      return json(400, { error: { code: 'VALIDATION_FAILED', message: 'future day' } });
    }
    if (handle === 'NoSuchUser') return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
    if (api.mode === 'network') throw new TypeError('Failed to fetch');
    if (api.mode === 'bad-request') return json(400, { error: { code: 'VALIDATION_FAILED', message: 'x' } });
    if (api.mode === 'body-error') {
      const body = new ReadableStream({ pull: (c) => c.error(new TypeError('connection reset')) });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json', date } });
    }
    if (api.mode === 'rate-limited') return json(429, { error: { code: 'RATE_LIMITED', message: 'x' } }, { 'retry-after': api.retryAfter });
    if (api.mode === 'blocked') {
      return new Response('<title>Just a moment...</title>', {
        status: 403,
        headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge', date },
      });
    }
    const to = u.searchParams.get('to');
    const base = {
      from: u.searchParams.get('from'),
      to,
      maxSolvedCount: 1,
      theme: null,
      firstActiveDay: '2021-08-09',
      vacation: null,
      vacations: [],
      frozenYesterday: false,
      currentStreak: 100,
      maxStreak: 100,
    };
    const row = { day: to, solvedCount: 1, maxSolvedLevel: 3, ratingDelta: 0, freezeUsed: false, streakRepaired: false };
    if (api.mode === 'solved') return json(200, { ...base, countedToday: true, days: [row] });
    if (api.mode === 'unsolved') return json(200, { ...base, countedToday: false, days: [] });
    throw new Error(`unknown mode ${api.mode}`);
  };
  return api;
}

/**
 * 새 서비스 워커를 띄운다(모듈을 새로 불러온다 = 콜드 스타트).
 * @param {{time?: string, sync?: object, local?: object, from?: object, shareSyncOnly?: boolean}} opts
 *   from: 이전 env의 저장소를 이어받음(서비스 워커 재시작). shareSyncOnly: 동기화 저장소만 이어받음(다른 기기).
 */
async function boot({ time, sync = {}, local = {}, from = null, shareSyncOnly = false, beforeImport = null } = {}) {
  if (time) mock.timers.setTime(at(time));
  const fake = createFakeChrome({ now: () => Date.now() });
  if (from) {
    for (const [k, v] of from.fake.chrome.storage.sync.data) fake.chrome.storage.sync.data.set(k, v);
    if (!shareSyncOnly) {
      for (const [k, v] of from.fake.chrome.storage.local.data) fake.chrome.storage.local.data.set(k, v);
      for (const [k, v] of from.fake.alarms) fake.alarms.set(k, v);
      // 화면의 알림은 서비스 워커가 아니라 Chrome의 것이므로 재시작해도 남아 있다.
      for (const [k, v] of from.fake.notifications ?? []) fake.notifications.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(sync)) fake.chrome.storage.sync.data.set(k, structuredClone(v));
  for (const [k, v] of Object.entries(local)) fake.chrome.storage.local.data.set(k, structuredClone(v));
  const api = from?.api ?? makeApi();
  if (beforeImport) beforeImport(fake); // 서비스 워커가 시작하기 전에 저장소 실패 등을 심는다
  globalThis.chrome = fake.chrome;
  globalThis.fetch = api.fetch;
  instance += 1;
  await import(new URL(`../background.js?instance=${instance}`, import.meta.url));
  await settle();
  env = { fake, api };
  return env;
}

const local = () => Object.fromEntries(env.fake.chrome.storage.local.data);
const sync = () => Object.fromEntries(env.fake.chrome.storage.sync.data);
const created = () => env.fake.chrome.notifications.history;
const titles = () => created().map((n) => n.title);
const visible = () => [...env.fake.notifications.keys()];
/** 화면에 떠 있는 알림의 종류(원인): 'unsolved', 'error:blocked' 등 */
const visibleCauses = () => visible().map((id) => id.split('|').slice(4).join('|'));
const shownId = () => local().shownId;

async function popup(message) {
  const res = await env.fake.sendMessage(message);
  await settle();
  return res;
}

async function event(name, ...args) {
  const [area, ev] = name.split('.');
  env.fake.chrome[area][ev].listeners.forEach((fn) => fn(...args));
  await settle();
}

async function alarm(name) {
  env.fake.fireAlarm(name);
  await settle();
}

const advance = (ms) => mock.timers.tick(ms);
/** 이 클라이언트의 429 대기가 끝나는 시각(지금 내 시계 기준) */
const waitEnd = (id) => core.rateLimitEnd(local().rateLimits?.[id], Date.now());
/** 팝업의 '오늘은 그만 알림'/'다시 켜기': 팝업이 보여 준 핸들·solved.ac 날짜를 함께 보낸다 */
const snoozeMsg = (type) => ({
  type,
  handle: sync().handle ?? '',
  dayKey: core.solvedDayKey(core.effectiveNow(Date.now(), local().clockSkewMs)),
});
const refresh = () => popup({ type: 'refresh', force: true });

async function configured(time, extra = {}) {
  return boot({
    time,
    sync: { ...SETTINGS, ...extra.sync },
    local: { apiCredentials: CREDS, schemaVersion: 2, stateHandle: SETTINGS.handle, ...extra.local },
  });
}

function snapshotAt(fetchedAt, countedToday, dayKey = '2026-11-21') {
  return {
    handle: 'Taeyang', dayKey, fetchedAt, currentStreak: 100, maxStreak: 100, countedToday,
    frozenYesterday: false, vacation: null, todaySolvedCount: 0, recent: [],
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'] });
  for (const m of ['info', 'warn', 'error']) mock.method(console, m, () => {});
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  delete globalThis.chrome;
});

describe('설치 / 설정 저장', () => {
  test('처음 설치: 설정 탭을 열고, 배지 …, 알림 없음, 알람 2개', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    await event('runtime.onInstalled', { reason: 'install' });
    assert.ok(env.fake.createdTabs.some((t) => t.options), '설정 탭');
    assert.equal(env.fake.badge.text, '…');
    assert.deepEqual(created(), []);
    assert.deepEqual([...env.fake.alarms.keys()].sort(), ['poll', 'rollover']);
    assert.equal(env.api.calls.length, 0);
  });

  test('저장: 한 번만 요청하고(onChanged로 중복 요청 없음), 자격 증명 헤더를 보내고, 저장소를 보호한다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    const res = await popup({ type: 'saveSettings', settings: SETTINGS, credentials: CREDS });
    assert.equal(res.ok, true);
    assert.equal(env.api.calls.length, 1);
    assert.equal(env.api.calls[0].id, 'cid');
    assert.equal(sync().handle, 'Taeyang');
    assert.equal(sync().apiCredentials, undefined, '키는 동기화하지 않음');
    assert.deepEqual(local().apiCredentials, CREDS);
    assert.equal(local().snapshot.countedToday, true);
    assert.equal(env.fake.badge.text, '✓');
  });

  test('Chrome이 local 저장소 접근 제한을 지원하면 키 저장 전에 적용하고, 실패하면 저장하지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    enableAccessLevel(env.fake.chrome.storage.local);
    assert.equal((await popup({ type: 'saveSettings', settings: SETTINGS, credentials: CREDS })).ok, true);
    assert.equal(env.fake.chrome.storage.local.accessLevel, 'TRUSTED_CONTEXTS');

    await boot({ time: '2026-11-21T20:00:00+09:00' });
    enableAccessLevel(env.fake.chrome.storage.local, new Error('failed'));
    const res = await popup({ type: 'saveSettings', settings: SETTINGS, credentials: CREDS });
    assert.deepEqual([res.ok, res.error], [false, 'storage-protection']);
    assert.equal(local().apiCredentials, undefined);
    assert.equal(env.api.calls.length, 0);
  });

  test('틀린 키/없는 사용자는 저장하지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    assert.equal((await popup({ type: 'saveSettings', settings: SETTINGS, credentials: { ...CREDS, clientSecret: 'nope' } })).error, 'auth');
    assert.equal((await popup({ type: 'saveSettings', settings: { ...SETTINGS, handle: 'NoSuchUser' }, credentials: CREDS })).error, 'not-found');
    assert.equal(sync().handle, undefined);
    assert.equal(local().apiCredentials, undefined);
  });

  test('API 키 없이도 알림 설정만 저장할 수 있다(설정 알림 끄기)', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' } });
    const res = await popup({ type: 'saveSettings', prefsOnly: true, settings: { ...SETTINGS, handle: '', notifyError: false } });
    assert.deepEqual([res.ok, res.warning], [true, 'prefs-only']);
    assert.equal(sync().notifyError, false);
    assert.equal(sync().handle, 'Taeyang', '핸들은 바꾸지 않음');
    await alarm('poll');
    assert.deepEqual(created(), [], '설정 알림을 껐으므로 알리지 않음');
  });

  test('저장소 쓰기가 실패하면 아무것도 바뀌지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { targetUsername: 'taeyang95' } });
    env.fake.chrome.storage.sync.set = async () => {
      throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
    };
    const res = await popup({ type: 'saveSettings', settings: SETTINGS, credentials: CREDS });
    assert.equal(res.ok, false);
    assert.equal(sync().targetUsername, 'taeyang95', '예전 아이디 제안 유지');
    assert.equal(local().apiCredentials, undefined);
  });

  test('오류 상태에서 같은 설정을 다시 저장하면 다시 확인한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'blocked';
    await refresh();
    assert.equal(local().lastError.code, 'blocked');
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    const res = await popup({ type: 'saveSettings', settings: SETTINGS, credentials: { clientId: 'cid', clientSecret: '' } });
    assert.equal(res.ok, true);
    assert.equal(env.api.calls.length, before + 1, '백오프 중이어도 사용자가 저장하면 확인');
    assert.equal(local().lastError, null);
  });
});

describe('요청 제한(429)은 앱(클라이언트) 단위로 지킨다', () => {
  test('저장 → 지금 확인 → 알림 설정 저장 → 다른 기기의 핸들 변경 모두 대기 시간을 지킨다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    env.api.mode = 'rate-limited';
    const res = await popup({ type: 'saveSettings', settings: SETTINGS, credentials: CREDS });
    assert.deepEqual([res.ok, res.warning], [true, 'rate-limited']);
    assert.equal(env.api.calls.length, 1);

    await refresh();
    assert.equal(env.api.calls.length, 1, '"지금 확인"도 기다림');
    const res2 = await popup({ type: 'saveSettings', settings: { ...SETTINGS, remindIntervalMin: 30 }, credentials: { clientId: 'cid', clientSecret: '' } });
    assert.deepEqual([res2.ok, res2.warning], [true, 'rate-limited']);
    assert.equal(env.api.calls.length, 1, '설정만 바꿔 저장해도 요청하지 않음');
    await env.fake.chrome.storage.sync.set({ handle: 'Other' });
    await settle();
    assert.equal(env.api.calls.length, 1, '핸들이 바뀌어도 같은 앱이면 기다림');

    advance(601 * 1000);
    env.api.mode = 'solved';
    await alarm('poll');
    assert.equal(env.api.calls.length, 2);
    assert.ok(env.api.calls[1].url.includes('/users/Other/'));
  });
});

describe('알림', () => {
  test('콜드 스타트: 확인하기 전에는 저장된 정보로 알리지 않는다 (10분 전 미해결 + 다시 알림 시각)', async () => {
    const t = at('2026-11-21T20:00:00+09:00');
    await configured('2026-11-21T20:00:00+09:00', {
      local: {
        snapshot: snapshotAt(t - 10 * MIN, false),
        lastAttemptAt: t - 10 * MIN,
        notifHistory: { reminder: { dayKey: '2026-11-21', shownAt: t - 70 * MIN } },
      },
    });
    assert.equal(env.fake.badge.text, '!', '배지는 복원');
    assert.deepEqual(created(), [], '부팅만으로는 알리지 않음');
    env.api.mode = 'solved'; // 그사이 다른 기기에서 풀었다
    await alarm('wake');
    assert.deepEqual(created(), [], 'GET 전에 알림을 만들지 않음');
    assert.equal(env.fake.badge.text, '✓');
  });

  test('콜드 스타트: 몇 시간 전 미해결 정보로는 확인이 실패해도 새로 알리지 않는다', async () => {
    const t = at('2026-11-21T20:00:00+09:00');
    await configured('2026-11-21T20:00:00+09:00', {
      local: { snapshot: snapshotAt(t - 3 * 60 * MIN, false), lastAttemptAt: t - 3 * 60 * MIN },
    });
    env.api.mode = 'network'; // 절전 복귀 직후 네트워크가 아직 없다
    await alarm('poll');
    assert.deepEqual(created(), []);
  });

  test('짧은 일시 오류 뒤 회복해도 미해결 알림이 다시 뜨지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    assert.equal(created().length, 1);
    advance(10 * MIN);
    env.api.mode = 'network';
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved'], '짧은 오류로는 알림을 닫지 않음');
    advance(2 * MIN);
    env.api.mode = 'unsolved';
    await refresh();
    assert.equal(created().length, 1, '다시 띄우지 않음');
    advance(49 * MIN); // 처음 알림 후 61분
    await refresh();
    assert.equal(created().length, 2, '간격이 지나면 다시 알림');
  });

  test('오류가 길어지면 믿을 수 없는 미해결 알림을 닫았다가, 회복하면 (간격 전이어도) 되살린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const shownAt = local().notifHistory.reminder.shownAt;
    advance(25 * MIN);
    env.api.mode = 'network';
    await refresh();
    assert.deepEqual(visible(), [], '25분 묵은 미해결 정보로는 알림을 유지하지 않음');
    assert.equal(env.fake.badge.text, '?');
    advance(2 * MIN);
    env.api.mode = 'unsolved';
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved'], '확장이 닫은 알림이므로 되살림');
    assert.equal(local().notifHistory.reminder.shownAt, shownAt, '다시 알림 간격은 그대로');
  });

  test('"하루 한 번만"이어도 오류가 밀어낸 알림은 회복 후 되살린다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { remindIntervalMin: 0 } });
    env.api.mode = 'unsolved';
    await refresh();
    env.api.mode = 'blocked';
    advance(MIN);
    await refresh();
    assert.match(titles().at(-1), /보안 확인/);
    env.api.mode = 'unsolved';
    advance(2 * 60 * MIN);
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved']);
    assert.match(titles().at(-1), /스트릭/);
    env.fake.notifications.clear();
        advance(MIN);
    await refresh();
    assert.equal(created().length, 3, '사용자가 닫은 뒤에는 다시 띄우지 않음');
  });

  test('오류 원인이 번갈아 와도 같은 날 같은 원인은 한 번만', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    for (const mode of ['blocked', 'auth', 'blocked', 'auth']) {
      env.api.mode = mode;
      await refresh();
      advance(MIN);
    }
    assert.equal(created().length, 2, `알림: ${titles().join(' / ')}`);
    assert.match(titles()[0], /보안 확인/);
    assert.match(titles()[1], /API 키/);
  });

  test('오류 알림이 미해결 알림을 밀어냈다면, 회복할 때 오류 알림을 미해결 알림으로 되돌린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    env.api.mode = 'blocked';
    advance(MIN);
    await refresh();
    assert.match(titles().at(-1), /보안 확인/);
    env.api.mode = 'unsolved';
    advance(MIN);
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved']);
    assert.match(titles().at(-1), /스트릭/);
    assert.equal(created().length, 3);
  });

  test('사용자가 닫은 미해결 알림은 오류가 지나간 뒤에도 간격 전에는 다시 띄우지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    env.fake.notifications.clear(); // 사용자가 닫음
        env.api.mode = 'blocked';
    advance(MIN);
    await refresh();
    env.api.mode = 'unsolved';
    advance(MIN);
    await refresh();
    assert.deepEqual(visible(), [], '남아 있던 오류 알림만 닫음');
    assert.equal(created().length, 2);
  });

  test('실패가 이어지는 중 20분이 지나면 wake 알람으로 깨어나 배지를 오류로 바꾼다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440, remindIntervalMin: 0 } });
    env.api.mode = 'unsolved';
    await refresh();
    advance(MIN);
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    await refresh();
    assert.equal(env.fake.badge.text, '!', '아직은 마지막 정보');
    const wake = env.fake.alarms.get('wake');
    assert.equal(wake.scheduledTime, at('2026-11-21T20:20:01+09:00'));
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.fake.badge.text, '?');
    assert.match(titles().at(-1), /요청이 너무 많아요/, '대기가 길면 미해결 알림 대신 알림으로 알림');
    assert.equal(env.api.calls.length, 2, '429 대기 중이라 요청은 하지 않음');
    assert.ok(env.fake.alarms.get('wake'), '대기가 끝나는 시각에 다시 깨어남');
  });

  test('알림 시작 시각에 wake 알람으로 깨어나 확인한 뒤 알린다', async () => {
    await configured('2026-11-21T10:00:00+09:00', { sync: { notifyStartHours: 12, checkIntervalMin: 1440 } });
    env.api.mode = 'unsolved';
    await refresh();
    assert.deepEqual(created(), []);
    assert.equal(env.fake.alarms.get('wake').scheduledTime, at('2026-11-21T18:00:00+09:00'));
    mock.timers.setTime(at('2026-11-21T18:00:00+09:00'));
    await alarm('wake');
    assert.deepEqual(visibleCauses(), ['unsolved']);
    assert.equal(env.api.calls.length, 2, '알리기 전에 다시 확인');
  });

  test('오늘은 그만 알림 버튼 / 다시 켜기', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await event('notifications.onButtonClicked', shownId(), 1);
    assert.deepEqual(visible(), []);
    assert.equal(local().snoozeDayKey, '2026-11-21');
    assert.equal(env.fake.alarms.has('wake'), false);
    await popup(snoozeMsg('unsnooze'));
    assert.deepEqual(visibleCauses(), ['unsolved']);
  });

  test('알림 클릭: 미해결이면 프로필, API 키 오류면 설정 탭', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await event('notifications.onClicked', shownId());
    assert.equal(env.fake.createdTabs.at(-1).url, 'https://solved.ac/u/Taeyang');
    env.api.mode = 'auth';
    await refresh();
    assert.match(shownId(), /\|error:auth$/);
    await event('notifications.onClicked', shownId());
    assert.equal(env.fake.createdTabs.at(-1).options, true);
  });

  test('알림을 띄우지 못해도 배지는 갱신되고 오류를 기록한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.fake.chrome.notifications.failCreate = new Error('Unable to download all specified images.');
    env.api.mode = 'unsolved';
    await refresh();
    assert.equal(env.fake.badge.text, '!');
    assert.match(local().notificationError, /Unable/);
  });
});

describe('v1에서 업데이트', () => {
  const V1 = { targetUsername: 'taeyang95', alarmInterval: 7, notifyOnNotSolved: true, notifyOnUnknown: true };

  test('설정만 옮기고, 예전 아이디는 확인 전까지 추적하지 않으며, 다시 설정하라는 알림은 한 번만', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: V1, local: { lastStreakStatus: true } });
    await event('runtime.onInstalled', { reason: 'update', previousVersion: '1.0.2' });
    assert.equal(sync().handle, undefined);
    assert.equal(sync().checkIntervalMin, undefined, 'v2 키로 옮겨 적지 않음');
    assert.equal(env.fake.alarms.get('poll').periodInMinutes, 7, 'v1 주기를 그대로 씀');
    assert.equal(sync().targetUsername, 'taeyang95', '다른 기기를 위해 남김');
    assert.equal(local().lastStreakStatus, undefined, '이 기기의 v1 흔적은 정리');
    assert.equal(env.fake.badge.text, '…');
    assert.equal(created().length, 1);
    assert.match(titles()[0], /다시 설정/);
    advance(24 * 60 * MIN);
    await alarm('poll');
    assert.equal(created().length, 1, '다음 날에도 다시 띄우지 않음');
    assert.equal(env.api.calls.length, 0, '확인 전에는 요청하지 않음');
  });

  test('두 번째 기기도 예전 아이디 제안과 안내를 받는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: V1 });
    await event('runtime.onInstalled', { reason: 'update', previousVersion: '1.0.2' });
    const first = env;
    await boot({ from: first, shareSyncOnly: true, local: { lastStreakStatus: false } });
    await event('runtime.onInstalled', { reason: 'update', previousVersion: '1.0.2' });
    assert.equal(env.fake.badge.text, '…');
    assert.match(titles().at(-1) ?? '', /다시 설정/);
  });
});

describe('날짜 경계 / 시계', () => {
  test('06:00 KST를 걸친 응답은 버리고 새 날짜로 다시 확인한다 (서버는 이미 새 날)', async () => {
    await configured('2026-11-21T05:59:59+09:00');
    mock.timers.setTime(at('2026-11-21T05:59:59.500+09:00'));
    env.api.serverLagMs = 0;
    const realFetch = env.api.fetch;
    globalThis.fetch = async (url, init) => {
      if (env.api.calls.length === 0) mock.timers.tick(1000); // 서버가 06:00:00.5에 응답을 만든다
      return realFetch(url, init);
    };
    await refresh();
    const tos = env.api.calls.map((c) => new URL(c.url).searchParams.get('to'));
    assert.deepEqual(tos.slice(-2), ['2026-11-20', '2026-11-21']);
    assert.equal(local().snapshot.dayKey, '2026-11-21');
  });

  test('느린 응답의 전송 시간을 시계 차이로 착각해 어제 결과를 오늘로 쓰지 않는다', async () => {
    await configured('2026-11-21T05:59:57+09:00');
    env.api.mode = 'unsolved';
    env.api.serverLagMs = 6000; // 서버는 05:59:57에 만들고 06:00:03에 도착
    await refresh();
    env.api.serverLagMs = 0;
    const tos = env.api.calls.map((c) => new URL(c.url).searchParams.get('to'));
    assert.deepEqual(tos, ['2026-11-20', '2026-11-21']);
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    assert.equal(local().clockSkewMs, 0, '시계는 맞음');
  });

  test('콜드 스타트가 06:00:05여도 오늘 06:00:18 알람을 미루지 않는다', async () => {
    await configured('2026-11-21T06:00:05+09:00');
    assert.equal(env.fake.alarms.get('rollover').scheduledTime, at('2026-11-21T06:00:18+09:00'));
  });

  test('rollover 알람: 새 날짜로 확인하고 다음 날 알람을 다시 건다', async () => {
    await configured('2026-11-21T05:30:00+09:00');
    env.api.mode = 'solved';
    await refresh();
    assert.equal(local().snapshot.dayKey, '2026-11-20');
    mock.timers.setTime(at('2026-11-21T06:00:18+09:00'));
    env.api.mode = 'unsolved';
    await alarm('rollover');
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    assert.equal(env.fake.badge.text, '!');
    assert.equal(env.fake.alarms.get('rollover').scheduledTime, at('2026-11-22T06:00:18+09:00'));
  });
});

describe('동기화 / 핸들 소유 / 초기화', () => {
  test('다른 기기에서 핸들이 바뀌면 이전 핸들의 알림 상태를 지우고 새 핸들을 확인한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await popup(snoozeMsg('snooze'));
    await env.fake.chrome.storage.sync.set({ handle: 'Other' });
    await settle();
    assert.equal(local().snoozeDayKey, undefined);
    assert.equal(local().stateHandle, 'Other');
    assert.ok(env.api.calls.at(-1).url.includes('/users/Other/'));
  });

  test('A → B(오늘 그만 알림) → A로 돌아와도 B의 설정을 물려받지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh(); // A 스냅샷
    env.api.mode = 'blocked';
    await popup({ type: 'saveSettings', settings: { ...SETTINGS, handle: 'Bob' }, credentials: { clientId: 'cid', clientSecret: '' } });
    await popup(snoozeMsg('snooze'));
    assert.equal(local().snoozeDayKey, '2026-11-21');
    advance(MIN);
    env.api.mode = 'unsolved';
    await env.fake.chrome.storage.sync.set({ handle: 'Taeyang' });
    await settle();
    assert.equal(local().snoozeDayKey, undefined);
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved'], 'A의 알림은 정상');
  });

  test('모든 데이터 지우기', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { targetUsername: 'old' } });
    env.api.mode = 'unsolved';
    await refresh();
    const res = await popup({ type: 'resetAll' });
    assert.equal(res.ok, true);
    assert.deepEqual(sync(), {});
    assert.deepEqual(Object.keys(local()).sort(), ['schemaVersion', 'stateHandle']);
    assert.deepEqual(visible(), []);
    assert.equal(env.fake.badge.text, '…');
  });

  test('콘텐츠 스크립트는 설정을 바꾸거나 지울 수 없다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const sender = { id: 'testextensionid', url: 'https://solved.ac/u/Taeyang', tab: { id: 3 } };
    for (const type of ['resetAll', 'saveSettings', 'snooze']) {
      assert.equal(await env.fake.sendMessage({ type, settings: SETTINGS }, sender), undefined, type);
    }
    assert.equal(sync().handle, 'Taeyang');
  });

  test('solved.ac 방문은 간격 제한을 지키며 확인한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const sender = { id: 'testextensionid', url: 'https://solved.ac/u/Taeyang', tab: { id: 3 } };
    await env.fake.sendMessage({ type: 'pageVisit' }, sender);
    await settle();
    assert.equal(env.api.calls.length, 1, '방금 확인했으면 건너뜀');
    advance(2 * MIN);
    await env.fake.sendMessage({ type: 'pageVisit' }, sender);
    await settle();
    assert.equal(env.api.calls.length, 2);
  });
});

describe('3차 리뷰 회귀 테스트', () => {
  test('요청 중에 핸들이 바뀌어 결과를 버려도 429 대기는 기록하고, 새 핸들도 기다리며, 끝나는 시각에 깨어난다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'rate-limited';
    env.api.onFetch = async () => {
      env.api.onFetch = null;
      await env.fake.chrome.storage.sync.set({ handle: 'Bob' }); // 다른 기기에서 핸들 변경
    };
    await refresh();
    await settle();
    assert.equal(env.api.calls.length, 1, 'Bob을 바로 요청하지 않음');
    assert.ok(waitEnd('cid') > Date.now());
    assert.equal(env.fake.alarms.get('wake').scheduledTime, waitEnd('cid'));
    mock.timers.setTime(waitEnd('cid'));
    env.api.mode = 'solved';
    await alarm('wake');
    assert.equal(env.api.calls.length, 2);
    assert.ok(env.api.calls[1].url.includes('/users/Bob/'));
  });

  test('다시 켜기: 10분 전 미해결 정보로 바로 알리지 않고, 확인해 보니 풀었으면 알리지 않는다', async () => {
    const t = at('2026-11-21T20:00:00+09:00');
    await configured('2026-11-21T20:00:00+09:00', {
      local: { snapshot: snapshotAt(t - 10 * MIN, false), snoozeDayKey: '2026-11-21', lastAttemptAt: t - 10 * MIN },
    });
    env.api.mode = 'solved';
    await popup(snoozeMsg('unsnooze'));
    assert.deepEqual(created(), []);
    assert.equal(env.fake.badge.text, '✓');
  });

  test('키가 폐기되어도(401) 알림 설정은 저장된다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'auth';
    await refresh();
    const res = await popup({ type: 'saveSettings', settings: { ...SETTINGS, notifyError: false }, credentials: { clientId: 'cid', clientSecret: '' } });
    assert.equal(res.ok, true);
    assert.equal(sync().notifyError, false);
    assert.deepEqual(visible(), [], '오류 알림 닫힘');
  });

  test('알림 표시가 실패해도 30초마다 다시 깨어 요청하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'unsolved';
    await refresh();
    advance(61 * MIN);
    env.fake.chrome.notifications.failCreate = new Error('Notifications disabled');
    await refresh();
    assert.match(local().notificationError, /disabled/);
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake.scheduledTime - Date.now() >= 59 * MIN, `다음 시도는 다시 알림 간격 뒤 (${(wake.scheduledTime - Date.now()) / MIN}분)`);
  });

  test('시계 차이를 새로 알면 06:00 KST 알람도 다시 맞춘다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const before = env.fake.alarms.get('rollover').scheduledTime;
    env.api.serverOffsetMs = 2 * 60 * MIN; // 내 PC가 2시간 느림
    env.api.mode = 'solved';
    await refresh();
    assert.ok(Math.abs(local().clockSkewMs - 2 * 60 * MIN) < 2000);
    const after = env.fake.alarms.get('rollover').scheduledTime;
    assert.ok(Math.abs(before - after - 2 * 60 * MIN) < 2000, '내 시계로 2시간 일찍');
  });

  test('본문을 받다 끊긴 200은 일시 오류: 바로 알리지 않고 곧 다시 시도한다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'body-error';
    await refresh();
    assert.equal(local().lastError.code, 'network');
    assert.deepEqual(created(), []);
    assert.ok(env.fake.alarms.get('wake').scheduledTime - Date.now() <= 5 * MIN);
  });

  test('저장 중 키 쓰기가 실패해도 새 핸들이 예전 키로 조회되지 않고, 다음 확인 때 마무리된다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    let failOnce = true;
    area.set = async (items) => {
      if (failOnce && items.apiCredentials && !items.pendingSave) {
        failOnce = false;
        throw new Error('write failed');
      }
      return realSet(items);
    };
    const res = await popup({ type: 'saveSettings', settings: { ...SETTINGS, handle: 'Bob' }, credentials: CREDS2 });
    assert.equal(res.ok, true, '마무리로 모두 저장됐으면 성공으로 알린다');
    assert.equal(sync().handle, 'Bob');
    await refresh();
    const last = env.api.calls.at(-1);
    assert.ok(last.url.includes('/users/Bob/'));
    assert.equal(last.id, 'cid2', '새 핸들은 새 키로');
    assert.deepEqual(local().apiCredentials, CREDS2);
    assert.ok(!local().pendingSave);
  });

  test('늦게 동기화된 v1 설정도 바로 따른다(알림 끄기 포함, v2 키로 옮겨 적지는 않음)', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    await env.fake.chrome.storage.sync.set({ targetUsername: 'taeyang95', alarmInterval: 7, notifyOnUnknown: false });
    await settle();
    assert.equal(sync().notifyError, undefined);
    assert.equal(sync().checkIntervalMin, undefined);
    assert.equal(env.fake.alarms.get('poll').periodInMinutes, 7);
    await alarm('poll');
    assert.deepEqual(created(), [], 'v1에서 끈 알림은 계속 꺼짐');
  });

  test('오류 원인이 바뀌었다 돌아오면 지난 원인의 알림(다른 버튼)을 남기지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    for (const mode of ['blocked', 'auth', 'blocked']) {
      env.api.mode = mode;
      await refresh();
      advance(MIN);
    }
    assert.deepEqual(visible(), []);
    assert.equal(created().length, 2);
  });

  test('핸들 대소문자만 바꿔 저장해도 같은 계정: 오늘 그만 알림과 기록을 유지한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await popup(snoozeMsg('snooze'));
    await popup({ type: 'saveSettings', settings: { ...SETTINGS, handle: 'taeyang' }, credentials: { clientId: 'cid', clientSecret: '' } });
    assert.equal(sync().handle, 'taeyang');
    assert.equal(local().snoozeDayKey, '2026-11-21');
    assert.deepEqual(visible(), []);
  });

  test('절전 전 1번 + 깬 직후 1번의 네트워크 오류로는 알리지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'network';
    await refresh();
    advance(3 * 60 * MIN);
    await refresh();
    assert.equal(local().consecutiveFailures, 1);
    assert.deepEqual(created(), []);
  });

  test('API 키 없이 알림 설정만 저장할 때 직접 입력한 핸들은 함께 저장한다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    const res = await popup({ type: 'saveSettings', prefsOnly: true, settings: { ...SETTINGS, handle: 'https://solved.ac/u/Taeyang' } });
    assert.equal(res.ok, true);
    assert.equal(sync().handle, 'Taeyang');
    assert.equal(env.fake.badge.text, '…', 'API 키가 필요해요');
    assert.equal(env.api.calls.length, 0);
  });
});

describe('4차 리뷰 회귀 테스트', () => {
  test('예전 실패 기록만으로는 다시 켜기 때 오래된 정보로 알리지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await popup(snoozeMsg('snooze'));
    advance(5 * MIN);
    env.api.mode = 'network';
    await refresh();
    advance(5 * MIN);
    env.api.mode = 'solved'; // 그사이 다른 기기에서 풀었다
    await popup(snoozeMsg('unsnooze'));
    assert.equal(created().length, 1, '다시 켜도 확인 전에는 알리지 않음');
    assert.equal(env.fake.badge.text, '✓');
  });

  test('키만 바꾸는 저장은 한 번에 쓴다: 쓰기가 실패하면 예전 키와 그 상태가 그대로 남는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'blocked';
    await refresh();
    env.api.mode = 'solved';
    const before = local();
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    let failOnce = true;
    area.set = async (items) => {
      if (failOnce && items.apiCredentials) {
        failOnce = false;
        throw new Error('write failed');
      }
      return realSet(items);
    };
    const r1 = await popup({ type: 'saveSettings', settings: {}, credentials: CREDS2, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.equal(r1.ok, false);
    assert.deepEqual(local().apiCredentials, CREDS);
    assert.equal(local().credRev, undefined);
    assert.deepEqual(local().lastError, before.lastError, '예전 키의 오류가 반쯤 지워지지 않음');
    assert.equal(local().backoffUntil, before.backoffUntil);
    assert.ok(!local().pendingSave);
  });

  test('핸들을 바꾸며 받은 429 뒤 동기화 쓰기가 실패해도 대기 종료 알람이 있다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '2700';
    env.fake.chrome.alarms.clear('wake');
    env.fake.chrome.storage.sync.set = async () => {
      throw new Error('sync quota');
    };
    const res = await popup({ type: 'saveSettings', settings: { ...SETTINGS, handle: 'Bob' }, credentials: CREDS });
    assert.equal(res.ok, false);
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && Math.abs(wake.scheduledTime - waitEnd('cid')) < 1000, '45분 뒤 대기 종료에 깨어남');
  });

  test('오늘 정보가 없는데 429 대기 중이면 "확인 중"이 아니라 요청 제한으로 표시', async () => {
    const t = at('2026-11-21T20:00:00+09:00');
    await configured('2026-11-21T20:00:00+09:00', { local: { rateLimits: { cid: t + 3 * 60 * MIN } } });
    assert.equal(env.fake.badge.text, '?');
    assert.match(env.fake.badge.title, /요청이 너무 많아요/);
  });

  test('사용자가 닫은 뒤(응답을 기다리는 중이어도) 오류가 오면, 회복해도 되살리지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    env.api.mode = 'blocked';
    env.api.onFetch = async () => {
      env.api.onFetch = null;
      env.fake.notifications.clear(); // 요청 중에 사용자가 닫음
    };
    advance(MIN);
    await refresh();
    env.api.mode = 'unsolved';
    advance(MIN);
    await refresh();
    assert.deepEqual(visible(), []);
    assert.equal(created().filter((n) => /스트릭/.test(n.title)).length, 1);
  });

  test('바꿔 띄우려던 오류 알림이 실패해도, 회복하면 미해결 알림을 되살린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    env.fake.chrome.notifications.failCreate = new Error('boom');
    env.api.mode = 'blocked';
    advance(MIN);
    await refresh();
    assert.deepEqual(visible(), []);
    env.fake.chrome.notifications.failCreate = null;
    env.api.mode = 'unsolved';
    advance(MIN);
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved']);
  });

  test('06:00 직후 지난 날 알림의 "오늘은 그만 알림"을 눌러도 새 날을 끄지 않는다', async () => {
    await configured('2026-11-21T05:59:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    assert.match(shownId(), /\|2026-11-20\|Taeyang\|unsolved$/);
    mock.timers.setTime(at('2026-11-21T06:00:01+09:00'));
    await event('notifications.onButtonClicked', shownId(), 1);
    assert.notEqual(local().snoozeDayKey, '2026-11-21');
    assert.deepEqual(visible(), []);
  });

  test('아직 옮겨 적지 않은 v1 알림 끄기도 바로 따른다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    env.fake.chrome.storage.sync.data.set('targetUsername', 'taeyang95');
    env.fake.chrome.storage.sync.data.set('notifyOnUnknown', false); // 이벤트 처리 전
    await alarm('poll');
    assert.deepEqual(created(), []);
  });

  test('키 없는 기기에서 핸들이 두 번 바뀌어도 같은 설정 알림은 한 번만', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00' });
    await env.fake.chrome.storage.sync.set({ handle: 'Alice' });
    await settle();
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' });
    await settle();
    assert.equal(created().length, 1);
  });

  test('시계가 하루 넘게 틀리면 반복 요청하지 않고 시계 오류로 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.serverOffsetMs = 3 * 24 * 60 * MIN;
    await refresh();
    assert.equal(local().lastError.code, 'clock');
    assert.equal(env.api.calls.length, 1);
    assert.equal(env.fake.badge.text, '?');
    assert.match(titles().at(-1), /시계/);
    assert.ok(env.fake.alarms.get('wake').scheduledTime - Date.now() >= 14 * MIN, '15분 뒤 다시');
  });

  test('12분 절전 전후의 네트워크 오류로는 알리지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'network';
    await refresh();
    advance(12 * MIN);
    await refresh();
    assert.equal(local().consecutiveFailures, 1);
    assert.deepEqual(created(), []);
  });

  test('보안 확인에 막힌 동안 "지금 확인"을 여러 번 눌러도 자동 재시도 간격이 늘지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'blocked';
    for (let i = 0; i < 3; i++) {
      await refresh();
      advance(5000);
    }
    assert.equal(local().codeFailures, 1);
    const left = (local().backoffUntil - Date.now()) / MIN;
    assert.ok(left > 14 && left <= 15, String(left));
  });

  test('알림을 눌러 연 뒤에는 오류가 지나가도 그 알림을 되살리지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await event('notifications.onClicked', shownId());
    env.api.mode = 'blocked';
    advance(MIN);
    await refresh();
    env.api.mode = 'unsolved';
    advance(MIN);
    await refresh();
    assert.deepEqual(visible(), []);
  });

  test('키가 있으면 "알림 설정만 저장"으로 핸들을 바꿀 수 없다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const res = await popup({ type: 'saveSettings', prefsOnly: true, settings: { ...SETTINGS, handle: 'Bob' } });
    assert.equal(res.ok, true);
    assert.equal(sync().handle, 'Taeyang');
  });
});

describe('5차 리뷰 회귀 테스트', () => {
  test('바뀐 뒤에 지난 알림의 버튼을 눌러도 새 알림을 닫거나 오늘을 끄지 않는다', async () => {
    await configured('2026-11-21T05:59:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const oldId = shownId();
    mock.timers.setTime(at('2026-11-21T06:00:20+09:00'));
    await alarm('rollover');
    const newId = shownId();
    assert.notEqual(newId, oldId);
    await event('notifications.onButtonClicked', oldId, 1);
    assert.notEqual(local().snoozeDayKey, '2026-11-21');
    assert.deepEqual(visible(), [newId]);
    assert.equal(shownId(), newId);
    await event('notifications.onClicked', oldId);
    assert.deepEqual(visible(), [newId], '지난 알림 본문을 눌러도 새 알림은 그대로');
  });

  test('시계를 고치면(뒤로) 시계 오류의 백오프에 막히지 않고 바로 다시 확인한다', async () => {
    const real = at('2026-11-21T20:00:00+09:00');
    await configured('2026-11-23T20:00:00+09:00'); // 내 PC가 2일 빠름
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    await refresh();
    assert.equal(local().lastError.code, 'clock');
    mock.timers.setTime(real); // 사용자가 시계를 고침
    env.api.serverOffsetMs = 0;
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    await alarm('poll');
    assert.equal(env.api.calls.length, before + 1);
    assert.equal(env.fake.badge.text, '✓');
  });

  test('끊긴 저장(동기화 확정 전)의 키는 재시작 때 쓰지 않고, 확정된 저장의 키는 쓴다', async () => {
    await configured('2026-11-21T20:00:00+09:00', {
      local: { pendingSave: { handle: 'Bob', creds: CREDS2, rev: 'r1' } },
    });
    assert.deepEqual(local().apiCredentials, CREDS, '확정 안 된 저장(핸들이 아직 예전 것)은 버림');
    assert.equal(local().pendingSave, undefined);
    await configured('2026-11-21T20:00:00+09:00', {
      sync: { handle: 'Bob' },
      local: { pendingSave: { handle: 'Bob', creds: CREDS2, rev: 'r2' } },
    });
    assert.deepEqual(local().apiCredentials, CREDS2, '확정된 저장은 마무리');
    assert.equal(local().credRev, 'r2');
  });

  test('다른 핸들 확인에서 받은 429로 대기 중이면 오늘 미해결 정보도 20분 뒤 오류로 바뀐다(저장이 실패해도)', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'unsolved';
    await refresh();
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '7200';
    const realSet = env.fake.chrome.storage.sync.set;
    env.fake.chrome.storage.sync.set = async () => {
      throw new Error('sync quota');
    };
    advance(MIN);
    const res = await popup({ type: 'saveSettings', settings: { handle: 'Bob' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    env.fake.chrome.storage.sync.set = realSet;
    assert.equal(res.ok, false);
    assert.equal(env.fake.badge.text, '!', '아직은 마지막 정보(낡아 가는 중)');
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake.scheduledTime <= at('2026-11-21T20:20:01+09:00'), '20분 뒤에 깨어남');
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.fake.badge.text, '?');
    assert.deepEqual(visibleCauses(), ['error:rate-limited'], '미해결 알림 대신 요청 제한 알림');
  });

  test('9분짜리 429가 이어지면(제때 재시도) 장애로 보고 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '540';
    await refresh();
    for (let i = 0; i < 3; i++) {
      const wake = env.fake.alarms.get('wake');
      mock.timers.setTime(wake.scheduledTime + 1000);
      await alarm('wake');
    }
    assert.ok(local().consecutiveFailures >= 3, String(local().consecutiveFailures));
    assert.ok(titles().some((t) => /요청이 너무 많아요/.test(t)));
  });

  test('바꾼 알림 설정만 저장해서 다른 기기에서 바꾼 값을 덮어쓰지 않고, 계정이 바뀌었으면 거절한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    await env.fake.chrome.storage.sync.set({ notifyError: false }); // 다른 기기
    await settle();
    const res = await popup({ type: 'saveSettings', settings: { checkIntervalMin: 10 }, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.equal(res.ok, true);
    assert.equal(sync().notifyError, false);
    assert.equal(sync().checkIntervalMin, 10);
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' }); // 다른 기기에서 핸들 변경
    await settle();
    const res2 = await popup({ type: 'saveSettings', settings: { handle: 'Alice' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.deepEqual([res2.ok, res2.error], [false, 'conflict']);
    assert.equal(sync().handle, 'Bob');
  });

  test('요청 중 핸들이 바뀌어 버린 429 결과는 새 핸들 알림을 한 번만 만든다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    env.api.onFetch = async () => {
      env.api.onFetch = null;
      await env.fake.chrome.storage.sync.set({ handle: 'Bob' });
    };
    await refresh();
    await settle();
    assert.equal(created().filter((n) => /요청이 너무 많아요/.test(n.title)).length, 1);
  });

  test('getAll과 clear 사이에 사용자가 닫은 알림은 되살리지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const id = shownId();
    const realClear = env.fake.chrome.notifications.clear;
    env.fake.chrome.notifications.clear = async (x) => {
      if (x === id) {
        env.fake.chrome.notifications.clear = realClear;
        env.fake.notifications.delete(x); // 사용자가 방금 닫음
        return false;
      }
      return realClear(x);
    };
    env.api.mode = 'blocked';
    advance(MIN);
    await refresh();
    env.api.mode = 'unsolved';
    advance(MIN);
    await refresh();
    assert.deepEqual(visible(), []);
  });

  test('시계가 뒤로 가도(실패 뒤) 자동 확인이 막히지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'network';
    await refresh();
    mock.timers.setTime(at('2026-11-21T19:00:00+09:00'));
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    await alarm('poll');
    assert.equal(env.api.calls.length, before + 1);
    assert.equal(env.fake.badge.text, '✓');
  });

  test('429 대기 중이라 확인하지 못한 새 키에 예전 키의 오류를 남기지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'auth';
    await refresh();
    assert.equal(local().lastError.code, 'auth');
    await env.fake.chrome.storage.local.set({ rateLimits: { cid2: Date.now() + 60 * MIN } });
    const res = await popup({ type: 'saveSettings', settings: {}, credentials: CREDS2, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.deepEqual([res.ok, res.warning], [true, 'rate-limited']);
    assert.equal(local().lastError ?? null, null);
    assert.doesNotMatch(env.fake.badge.title, /API 키를 확인/);
  });

  test('시계가 하루 넘게 틀리면 4xx 응답이어도 시계 오류로 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'bad-request';
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    await refresh();
    assert.equal(local().lastError.code, 'clock');
  });

  test('모든 데이터 지우기도 서버가 정한 429 대기는 남긴다(어느 키였는지는 남기지 않음)', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { lastSaveId: 'obsolete' } });
    env.api.mode = 'rate-limited';
    await refresh();
    const until = waitEnd('cid');
    const res = await popup({ type: 'resetAll' });
    assert.equal(res.keptWaitUntil, until);
    assert.deepEqual(Object.keys(local().rateLimits), [''], '클라이언트 ID 없이');
    assert.equal(waitEnd(''), until, '같은 대기');
    assert.doesNotMatch(JSON.stringify(local().rateLimits), /cid/);
    assert.deepEqual(Object.keys(local()).sort(), ['rateLimits', 'schemaVersion', 'stateHandle']);
    assert.deepEqual(sync(), {});
    // 다시 설정해도 대기는 지킨다
    const before = env.api.calls.length;
    const r = await popup({ type: 'saveSettings', settings: { handle: 'Taeyang' }, credentials: CREDS, base: { handle: '', clientId: '' } });
    assert.deepEqual([r.ok, r.warning], [true, 'rate-limited']);
    assert.equal(env.api.calls.length, before);
    // 대기가 끝나면 지워진다
    mock.timers.setTime(until + 1000);
    await alarm('wake');
    assert.ok(env.api.calls.length > before, '대기가 끝나면 확인');
    assert.equal(local().rateLimits?.[''], undefined);
  });
});

describe('6차 리뷰 회귀 테스트', () => {
  test('키를 확인하는 사이 다른 기기에서 바꾼 알림 설정을 덮어쓰지 않고, 핸들이 바뀌었으면 거절한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.onFetch = async () => {
      env.api.onFetch = null;
      await env.fake.chrome.storage.sync.set({ notifyError: false }); // 다른 기기
    };
    const r1 = await popup({ type: 'saveSettings', settings: { remindIntervalMin: 30 }, credentials: CREDS2, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.equal(r1.ok, true);
    assert.equal(sync().notifyError, false, '확인 중에 바뀐 다른 항목은 그대로');
    assert.equal(sync().remindIntervalMin, 30);
    assert.deepEqual(local().apiCredentials, CREDS2);

    env.api.onFetch = async () => {
      env.api.onFetch = null;
      await env.fake.chrome.storage.sync.set({ handle: 'Carol' }); // 다른 기기에서 핸들 변경
    };
    const rev = local().credRev;
    const r2 = await popup({ type: 'saveSettings', settings: {}, credentials: CREDS, base: { handle: 'Taeyang', clientId: 'cid2', credRev: rev } });
    assert.deepEqual([r2.ok, r2.error], [false, 'conflict']);
    assert.equal(sync().handle, 'Carol');
    assert.deepEqual(local().apiCredentials, CREDS2, '키도 바꾸지 않음');
  });

  test('같은 클라이언트 ID라도 다른 곳에서 시크릿을 바꿨으면(리비전이 다르면) 거절한다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { local: { credRev: 'r1' } });
    const res = await popup({
      type: 'saveSettings',
      settings: {},
      credentials: { clientId: 'cid', clientSecret: 'typed-before' },
      base: { handle: 'Taeyang', clientId: 'cid', credRev: 'r0' },
    });
    assert.deepEqual([res.ok, res.error], [false, 'conflict']);
    assert.deepEqual(local().apiCredentials, CREDS);
  });

  test('핸들과 키를 함께 바꾸다 끊긴 뒤 재시작하면 새 키로 확정하고 예전 키의 오류/백오프 없이 바로 확인한다', async () => {
    const t = at('2026-11-21T20:00:00+09:00');
    await configured('2026-11-21T20:00:00+09:00', {
      sync: { handle: 'Bob' }, // 동기화 쓰기는 끝났다
      local: {
        stateHandle: 'Bob',
        pendingSave: { handle: 'Bob', creds: CREDS2, rev: 'r9' },
        lastError: { handle: 'Bob', code: 'auth', at: t },
        codeFailures: 2,
        backoffUntil: t + 60 * MIN,
      },
    });
    assert.deepEqual(local().apiCredentials, CREDS2);
    assert.equal(local().backoffUntil, null);
    assert.equal(local().lastError, null);
    assert.equal(local().verifyPending, 'r9');
    await event('runtime.onStartup');
    const last = env.api.calls.at(-1);
    assert.ok(last && last.url.includes('/users/Bob/') && last.id === 'cid2', '새 키로 바로 확인');
    assert.equal(env.fake.badge.text, '✓');
    assert.equal(local().verifyPending, null);
  });

  test('429 대기 중에 저장한 새 키는 대기가 끝나면(최근 정보가 있어도) 바로 확인한다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh(); // 해결: 30분 동안은 다시 확인하지 않는 상태
    const t = Date.now();
    await env.fake.chrome.storage.local.set({ rateLimits: { cid: t + 5 * MIN } });
    const res = await popup({
      type: 'saveSettings',
      settings: {},
      credentials: { clientId: 'cid', clientSecret: 'WRONG' },
      base: { handle: 'Taeyang', clientId: 'cid' },
    });
    assert.deepEqual([res.ok, res.warning], [true, 'rate-limited']);
    assert.ok(local().verifyPending);
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && wake.scheduledTime <= t + 5 * MIN + 1000, '대기 끝에 깨어남');
    const before = env.api.calls.length;
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.api.calls.length, before + 1, '새 키를 확인');
    assert.equal(local().lastError.code, 'auth');
    assert.equal(env.fake.badge.text, '?');
  });

  test('저장이 실패하면 더 믿을 수 없게 된 미해결 알림을 그 자리에서 정리한다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'unsolved';
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved']);
    advance(31 * MIN);
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '7200';
    const realSet = env.fake.chrome.storage.sync.set;
    env.fake.chrome.storage.sync.set = async () => {
      throw new Error('sync quota');
    };
    const res = await popup({ type: 'saveSettings', settings: { handle: 'Bob' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    env.fake.chrome.storage.sync.set = realSet;
    assert.equal(res.ok, false);
    assert.equal(env.fake.badge.text, '?');
    assert.deepEqual(visibleCauses(), ['error:rate-limited'], '2시간 대기를 알리고 미해결 알림은 내림');
  });

  test('시계가 뒤로 간 뒤 확인이 실패하면 미래 시각의 미해결 정보를 믿지 않고 알림을 내린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    assert.deepEqual(visibleCauses(), ['unsolved']);
    mock.timers.setTime(at('2026-11-21T19:00:00+09:00'));
    env.api.mode = 'network';
    await refresh();
    assert.equal(env.fake.badge.text, '?');
    assert.deepEqual(visible(), []);
    assert.ok(local().failingSince <= Date.now(), '실패 시작 시각도 지금 시계 기준');
  });

  test('시계가 하루 넘게 틀린 429: 대기는 기록하고 시계 오류로 표시한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    advance(MIN);
    await refresh();
    assert.ok(waitEnd('cid') > Date.now() + 59 * MIN, '대기는 남김');
    assert.equal(local().lastError.code, 'clock');
    assert.equal(env.fake.badge.text, '?');
  });

  test('시계가 하루 넘게 틀려도 저장할 때 잘못된 키는 인증 오류로 막는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    const res = await popup({
      type: 'saveSettings',
      settings: {},
      credentials: { clientId: 'cid', clientSecret: 'WRONG' },
      base: { handle: 'Taeyang', clientId: 'cid' },
    });
    assert.deepEqual([res.ok, res.error], [false, 'auth']);
    assert.deepEqual(local().apiCredentials, CREDS);
  });

  test('저장 확인 중 다른 기기에서 핸들을 바꾸면 거절하고 새 핸들의 알림은 한 번만', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    env.api.onFetch = async () => {
      env.api.onFetch = null;
      await env.fake.chrome.storage.sync.set({ handle: 'Carol' });
    };
    const res = await popup({ type: 'saveSettings', settings: { handle: 'Bob' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    await settle();
    assert.deepEqual([res.ok, res.error], [false, 'conflict']);
    assert.equal(sync().handle, 'Carol');
    assert.ok(created().filter((n) => /요청이 너무 많아요/.test(n.title)).length <= 1);
  });

  test('짧은 Retry-After: 깨어나는 시각과 "예정된 재시도 시각"이 같다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '60';
    await refresh();
    const wake = env.fake.alarms.get('wake');
    assert.ok(Math.abs(local().expectedRetryAt - wake.scheduledTime) < 1000, `${local().expectedRetryAt} vs ${wake.scheduledTime}`);
    // 그 시각보다 5분 늦게 깨어났다면(절전) 연속 실패를 새로 센다
    mock.timers.setTime(wake.scheduledTime + 5 * MIN);
    await alarm('wake');
    assert.equal(local().consecutiveFailures, 1);
  });

  test('핸들을 바꾼 뒤 지난 핸들의 알림을 누르면 그 핸들의 프로필을 연다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const id = shownId();
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' });
    await settle();
    await event('notifications.onClicked', id);
    assert.equal(env.fake.createdTabs.at(-1).url, 'https://solved.ac/u/Taeyang');
  });

  test('알림을 띄운 직후 서비스 워커가 멈춰도 다음에 그 알림을 지우지 않는다(한 번만 띄우는 설정 알림)', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    const realCreate = notifications.create.bind(notifications);
    let captured = null;
    notifications.create = async (id, options) => {
      const r = await realCreate(id, options);
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)])); // 여기서 멈춤
      return r;
    };
    await alarm('poll');
    assert.ok(captured, '설정 알림을 띄움');
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: {
          chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } },
          alarms: prev.fake.alarms,
          notifications: prev.fake.notifications,
        },
      },
    });
    await alarm('poll');
    assert.deepEqual(visibleCauses(), ['setup:credentials'], '띄운 알림이 그대로 남음');
  });

  test('알림 목록을 읽지 못해도 지난 알림을 닫고 새 알림으로 바꾼다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    env.fake.chrome.notifications.getAll = async () => {
      throw new Error('getAll failed');
    };
    advance(61 * MIN);
    await refresh();
    assert.equal(visible().length, 1);
    assert.equal(visible()[0], shownId());
  });

  test('시계를 고치면(뒤로) 확인 주기 알람도 지금 시계에 맞춰 다시 건다', async () => {
    await configured('2026-11-23T20:00:00+09:00'); // 내 PC가 2일 빠름
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    await refresh();
    assert.equal(local().lastError.code, 'clock');
    mock.timers.setTime(at('2026-11-21T20:00:00+09:00')); // 사용자가 시계를 고침
    env.api.serverOffsetMs = 0;
    await refresh();
    const poll = env.fake.alarms.get('poll');
    assert.ok(poll.scheduledTime <= Date.now() + 5 * MIN + 1000, `poll ${new Date(poll.scheduledTime).toISOString()}`);
    const rollover = env.fake.alarms.get('rollover');
    assert.ok(rollover.scheduledTime <= at('2026-11-22T06:01:00+09:00'), '06:00 알람도 지금 시계 기준');
  });

  test('재시작할 때 확인 주기 알람이 너무 멀리 있으면 다시 건다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.fake.alarms.set('poll', { name: 'poll', scheduledTime: Date.now() + 2 * 24 * 60 * MIN, periodInMinutes: 5 });
    await boot({ from: env });
    assert.ok(env.fake.alarms.get('poll').scheduledTime <= Date.now() + 5 * MIN + 1000);
  });

  test('키는 있지만 핸들이 없을 때(다른 기기에서 지움) 알림 설정만 저장할 수 있다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', local: { apiCredentials: CREDS, schemaVersion: 2, stateHandle: '' } });
    const res = await popup({ type: 'saveSettings', prefsOnly: true, settings: { notifyError: false }, base: { handle: '', clientId: 'cid' } });
    assert.equal(res.ok, true);
    assert.equal(sync().notifyError, false);
    assert.equal(sync().handle, undefined);
  });
});

describe('7차 리뷰 회귀 테스트', () => {
  test('빠른 시계를 06:00 직후에 고치고 첫 확인이 실패해도 어제의 ✓를 오늘로 보이지 않는다', async () => {
    await configured('2026-11-22T07:50:00+09:00'); // 실제 05:50, 내 PC가 2시간 빠름
    env.api.serverOffsetMs = -2 * 60 * MIN;
    await refresh();
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    assert.equal(env.fake.badge.text, '✓');
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00')); // 시계를 고침(실제 06:10)
    env.api.serverOffsetMs = 0;
    env.api.mode = 'network';
    await refresh();
    assert.notEqual(env.fake.badge.text, '✓', '어제의 해결을 오늘로 보이지 않음');
    const rollover = env.fake.alarms.get('rollover').scheduledTime;
    assert.ok(Math.abs(rollover - at('2026-11-23T06:00:15+09:00')) < 2 * MIN, new Date(rollover).toISOString());
  });

  test('느린 시계(시계 오류)일 때 받은 429는 시계를 앞으로 고쳐도 서버 기준 대기를 지킨다', async () => {
    await configured('2026-11-19T20:00:00+09:00'); // 내 PC가 2일 느림
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    await refresh();
    assert.equal(local().lastError.code, 'clock');
    mock.timers.setTime(at('2026-11-21T20:02:00+09:00')); // 시계를 고침
    env.api.serverOffsetMs = 0;
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    await alarm('poll');
    await event('runtime.onStartup');
    assert.equal(env.api.calls.length, before, '서버가 정한 1시간 안에는 요청하지 않음');
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && Math.abs(wake.scheduledTime - at('2026-11-21T21:00:00+09:00')) < 2 * MIN, '대기가 끝나면 깨어남');
    mock.timers.setTime(wake.scheduledTime + 1000);
    await alarm('wake');
    assert.equal(env.api.calls.length, before + 1);
    assert.equal(env.fake.badge.text, '✓');
  });

  test('팝업의 오늘은 그만 알림은 버튼이 보여 준 핸들·날짜에만 적용한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const msg = snoozeMsg('snooze');
    const r1 = await popup({ ...msg, dayKey: '2026-11-20' });
    assert.deepEqual([r1.ok, r1.error], [false, 'stale'], '지난 날');
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' }); // 다른 탭에서 핸들 변경
    await settle();
    const r2 = await popup(msg);
    assert.deepEqual([r2.ok, r2.error], [false, 'stale'], '다른 핸들');
    assert.equal(local().snoozeDayKey, undefined);
    const r3 = await popup(snoozeMsg('snooze'));
    assert.equal(r3.ok, true);
    assert.equal(local().snoozeDayKey, '2026-11-21');
  });

  test('오늘 정보가 없을 때도 긴 429 대기가 예전 네트워크 오류보다 앞서고 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'network';
    await refresh();
    assert.equal(local().lastError.code, 'network');
    await env.fake.chrome.storage.local.set({ rateLimits: { cid: Date.now() + 2 * 60 * MIN } });
    advance(MIN);
    await refresh();
    assert.match(env.fake.badge.title, /요청이 너무 많아요/);
    assert.deepEqual(visibleCauses(), ['error:rate-limited']);
  });

  test('알림을 띄우기 직전에 서비스 워커가 멈추면 한 번만 띄우는 설정 알림을 잃지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    let captured = null;
    notifications.create = async () => {
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      throw new Error('worker stopped'); // 여기서 멈춤(알림은 뜨지 않음)
    };
    await alarm('poll');
    assert.ok(captured);
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: {
          chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } },
          alarms: prev.fake.alarms,
          notifications: new Map(),
        },
      },
    });
    await alarm('poll');
    assert.deepEqual(visibleCauses(), ['setup:credentials'], '다시 띄움');
    await alarm('poll');
    assert.equal(created().length, 1, '한 번만');
  });

  test('저장 중 쓰기가 실패하면 실제로 저장된 부분을 확인해 알린다(일부만 저장)', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    area.set = async (items) => {
      if (items.apiCredentials) throw new Error('write failed');
      return realSet(items);
    };
    const res = await popup({
      type: 'saveSettings',
      settings: { notifyError: false },
      credentials: CREDS2,
      base: { handle: 'Taeyang', clientId: 'cid' },
    });
    area.set = realSet;
    assert.deepEqual([res.ok, res.error], [false, 'partial']);
    assert.equal(sync().notifyError, false, '알림 설정은 저장됨');
    assert.deepEqual(local().apiCredentials, CREDS, '키는 그대로');
  });

  test('응답 없이 실패하면 새 키의 "확인 전" 표시를 지우지 않고, 1분마다 다시 요청하지도 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    await refresh();
    await env.fake.chrome.storage.local.set({ rateLimits: { cid2: Date.now() + 5 * MIN } });
    const res = await popup({ type: 'saveSettings', settings: {}, credentials: CREDS2, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.deepEqual([res.ok, res.warning], [true, 'rate-limited']);
    env.api.mode = 'network';
    mock.timers.setTime(env.fake.alarms.get('wake').scheduledTime + 1000);
    await alarm('wake');
    assert.ok(local().verifyPending, '아직 확인 전');
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake.scheduledTime - Date.now() >= 4 * MIN, `다음 재시도는 재시도 간격 뒤 (${(wake.scheduledTime - Date.now()) / MIN}분)`);
    env.api.mode = 'solved';
    mock.timers.setTime(wake.scheduledTime + 1000);
    await alarm('wake');
    assert.equal(local().verifyPending, null, '응답을 받으면 확인 완료');
  });

  test('실패 응답의 Date로도 시계 차이를 다시 잰다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.serverOffsetMs = 3 * 60 * MIN;
    env.api.mode = 'blocked';
    await refresh();
    assert.ok(Math.abs(local().clockSkewMs - 3 * 60 * MIN) < 2000);
  });
});

describe('7차 리뷰(fable) 회귀 테스트', () => {
  test('4xx 거절(400)은 저장을 막고, 저장된 핸들이면 팝업을 열거나 알람이 울려도 일시 오류처럼 되풀이하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 5 } });
    env.api.mode = 'bad-request';
    const res = await popup({ type: 'saveSettings', settings: { handle: 'ab' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.deepEqual([res.ok, res.error, res.serverCode], [false, 'rejected', 'VALIDATION_FAILED']);
    assert.equal(sync().handle, 'Taeyang');
    await refresh();
    assert.equal(local().lastError.code, 'rejected');
    assert.equal(env.fake.badge.text, '?');
    assert.match(titles().at(-1), /거절/);
    const before = env.api.calls.length;
    // 30분 동안 5분마다 팝업을 열고(page) 알람이 울려도, 15분 → 30분 간격으로만 다시 확인한다.
    for (let i = 0; i < 6; i++) {
      advance(5 * MIN);
      await popup({ type: 'refresh', force: false });
      await alarm('poll');
      if (env.fake.alarms.get('wake')?.scheduledTime <= Date.now()) await alarm('wake');
    }
    assert.ok(env.api.calls.length - before <= 1, `요청 ${env.api.calls.length - before}번`);
  });
});

describe('8차 리뷰 회귀 테스트', () => {
  test('시계가 7일 넘게 느릴 때 받은 429도, 그 사이 주기 확인이 있어도 시계를 고친 뒤 서버 기준 대기를 지킨다', async () => {
    const t0 = at('2026-11-11T10:00:00+09:00');
    await configured('2026-11-11T10:00:00+09:00'); // 내 PC가 10일 느림
    env.api.serverOffsetMs = 10 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '600';
    await refresh();
    advance(MIN);
    await alarm('poll'); // 시계를 고치기 전의 주기 확인(대기 시각을 자르지 않아야 한다)
    mock.timers.setTime(t0 + 10 * 24 * 60 * MIN + 2 * MIN); // 시계를 고침(받은 지 실제로 2분 뒤)
    env.api.serverOffsetMs = 0;
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    await refresh();
    await alarm('poll');
    assert.equal(env.api.calls.length, before, '서버가 정한 10분 안에는 요청하지 않음');
  });

  test('보안 확인 페이지는(시계 오류와 겹쳐도) 새 키를 확인한 것으로 치지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { local: { verifyPending: 'rev', credRev: 'rev' } });
    env.api.mode = 'blocked';
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    await refresh();
    assert.equal(local().lastError.code, 'clock');
    assert.equal(local().verifyPending, 'rev');
  });
});

describe('8차 리뷰(fable) 회귀 테스트', () => {
  test('시계 오류 + 긴 429 뒤 시계를 고치면, 대기 중에도 시계 오류를 계속 알리지 않는다', async () => {
    await configured('2026-11-19T20:00:00+09:00'); // 내 PC가 2일 느림
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '86400';
    await refresh();
    assert.match(env.fake.badge.title, /시계/);
    mock.timers.setTime(at('2026-11-21T20:05:00+09:00')); // 시계를 고침
    env.api.serverOffsetMs = 0;
    env.api.mode = 'solved';
    await event('runtime.onStartup');
    assert.doesNotMatch(env.fake.badge.title, /시계/);
    assert.match(env.fake.badge.title, /요청이 너무 많아요/);
    mock.timers.setTime(at('2026-11-22T07:00:00+09:00'));
    await alarm('rollover');
    assert.equal(titles().filter((t) => /시계/.test(t)).length, 1, '다음 날에도 시계 오류를 다시 알리지 않음');
    const wake = env.fake.alarms.get('wake');
    mock.timers.setTime(wake.scheduledTime + 1000);
    await alarm('wake');
    assert.equal(env.fake.badge.text, '✓', '대기가 끝나면 확인');
  });

  test('아직 고치지 않은 느린 시계는 계속 시계 오류로 보인다', async () => {
    await configured('2026-11-19T20:00:00+09:00');
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '86400';
    await refresh();
    advance(3 * 60 * MIN);
    await event('runtime.onStartup');
    assert.match(env.fake.badge.title, /시계/);
  });

  test('설정 알림 표시가 실패하면 띄운 것으로 치지 않고 다음 확인 때 다시 띄운다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    env.fake.chrome.notifications.failCreate = new Error('boom');
    await alarm('poll');
    assert.equal(visible().length, 0);
    env.fake.chrome.notifications.failCreate = null;
    advance(5 * MIN);
    await alarm('poll');
    assert.deepEqual(visibleCauses(), ['setup:credentials']);
  });

  test('핸들이 없는(v1에서 업데이트) 사용자도 알림에서 끈 오늘 알림을 팝업에서 다시 켤 수 있다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { targetUsername: 'taeyang95' } });
    await alarm('poll');
    await event('notifications.onButtonClicked', visible()[0], 1);
    assert.equal(local().snoozeDayKey, '2026-11-21');
    const res = await popup(snoozeMsg('unsnooze'));
    assert.equal(res.ok, true);
    assert.equal(local().snoozeDayKey, undefined);
  });
});

describe('팝업(가짜 DOM으로 실제 popup.js 실행)', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }

  let popupSeq = 0;
  async function openPopup() {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => ({ id: 1 }); // 설정 탭으로 열림
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    popupSeq += 1;
    await import(new URL(`../popup.js?popup=${popupSeq}`, import.meta.url));
    await settle();
    globalThis.setInterval = realSetInterval;
    const $ = (id) => doc.getElementById(id);
    const form = $('settingsForm');
    const type = async (id, value) => {
      $(id).value = value;
      await form.dispatch('input', { target: $(id) });
      await $(id).dispatch('input');
    };
    const toggle = async (id) => {
      $(id).checked = !$(id).checked;
      await form.dispatch('change', { target: $(id) });
      await $(id).dispatch('change');
    };
    const save = async () => {
      await form.dispatch('submit');
      await settle();
    };
    const click = async (id) => {
      await $(id).dispatch('click');
      await settle();
    };
    return { $, type, toggle, save, click };
  }

  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('v1 아이디 제안: 확인 전에는 키를 넣어도 보내지 않고, 확인하면 오류 안내를 지우고 그 핸들로 저장한다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { targetUsername: 'Taeyang' } });
    const p = await openPopup();
    assert.equal(p.$('handleInput').value, 'Taeyang');
    assert.equal(p.$('legacyHint').hidden, false);
    await p.type('clientIdInput', 'cid');
    await p.type('clientSecretInput', 'secret-1');
    await p.save();
    assert.match(p.$('saveStatus').textContent, /이 아이디가 맞아요/);
    assert.equal(sync().handle, undefined);
    assert.equal(env.api.calls.length, 0);
    await p.click('confirmLegacyButton');
    assert.equal(p.$('saveStatus').textContent, '', '오류 안내를 지움');
    assert.equal(p.$('handleInput').getAttribute('aria-invalid'), null);
    await p.save();
    assert.equal(sync().handle, 'Taeyang');
    assert.deepEqual(local().apiCredentials, CREDS);
  });

  test('v1 값이 동기화에서 사라져도 확인하지 않은 제안값은 보내지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { targetUsername: 'taeyang95' } });
    const p = await openPopup();
    await p.type('clientIdInput', 'cid');
    await env.fake.chrome.storage.sync.remove('targetUsername'); // 다른 기기
    await settle();
    await p.type('clientSecretInput', 'secret-1');
    await p.save();
    assert.match(p.$('saveStatus').textContent, /이 아이디가 맞아요/);
    assert.equal(sync().handle, undefined);
    assert.equal(env.api.calls.length, 0);
  });

  test('클라이언트 ID 칸을 고치는 중 다른 탭에서 키가 바뀌면 엉뚱한 오류 대신 충돌로 알리고 다시 채운다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { local: { credRev: 'r1' } });
    const p = await openPopup();
    await p.type('clientIdInput', 'cid'); // 같은 값을 다시 입력(고친 칸)
    await env.fake.chrome.storage.local.set({ apiCredentials: CREDS2, credRev: 'r2' }); // 다른 탭
    await settle();
    await p.save();
    assert.match(p.$('saveStatus').textContent, /다른 곳/);
    assert.equal(p.$('clientIdInput').value, 'cid2');
    assert.deepEqual(local().apiCredentials, CREDS2);
  });

  test('v1 아이디 제안: 핸들을 직접 고치면 안내를 숨기고 입력한 핸들로 저장한다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { targetUsername: 'taeyang95' } });
    const p = await openPopup();
    await p.type('handleInput', 'Taeyang');
    assert.equal(p.$('legacyHint').hidden, true);
    await p.type('clientIdInput', 'cid');
    await p.type('clientSecretInput', 'secret-1');
    await p.save();
    assert.equal(sync().handle, 'Taeyang');
  });

  test('키가 저장돼 있고 핸들이 없을 때 알림 설정만 바꾸면 제안값을 핸들로 쓰지 않는다', async () => {
    await boot({
      time: '2026-11-21T20:00:00+09:00',
      sync: { targetUsername: 'taeyang95' },
      local: { apiCredentials: CREDS, schemaVersion: 2, stateHandle: '' },
    });
    const p = await openPopup();
    await p.toggle('notifyError');
    await p.save();
    assert.match(p.$('saveStatus').textContent, /알림 설정을 저장했어요/);
    assert.equal(sync().handle, undefined);
    assert.equal(sync().notifyError, false);
    assert.equal(env.api.calls.length, 0);
  });

  test('오늘은 그만 알림 / 다시 켜기 버튼은 보이는 핸들·날짜로 동작한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    const p = await openPopup();
    assert.equal(p.$('snoozeButton').hidden, false);
    assert.deepEqual([p.$('snoozeButton').dataset.handle, p.$('snoozeButton').dataset.day], ['Taeyang', '2026-11-21']);
    await p.click('snoozeButton');
    assert.equal(local().snoozeDayKey, '2026-11-21');
    assert.equal(p.$('snoozeButton').textContent, '오늘 알림 다시 켜기');
    await p.click('snoozeButton');
    assert.equal(local().snoozeDayKey, undefined);
  });

  test('모든 데이터 지우기: 확인 창은 고를 때까지 남고, 취소하면 지우지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const p = await openPopup();
    await p.click('resetButton');
    assert.equal(p.$('resetConfirm').hidden, false);
    assert.equal(p.$('resetCancelButton').focused, true, '취소에 포커스');
    await p.$('resetConfirm').dispatch('keydown', { key: 'Escape' });
    assert.equal(p.$('resetConfirm').hidden, true);
    assert.equal(sync().handle, 'Taeyang');
    await p.click('resetButton');
    await p.click('resetConfirmButton');
    assert.deepEqual(sync(), {});
    assert.equal(local().apiCredentials, undefined);
    assert.match(p.$('saveStatus').textContent, /모든 데이터를 지웠어요/);
  });

  test('저장하는 동안 폼을 잠그고, 다른 탭에서 키가 바뀌면 고치던 시크릿을 새 키와 섞지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { local: { credRev: 'r1' } });
    const p = await openPopup();
    await p.type('clientSecretInput', 'secret-1');
    await env.fake.chrome.storage.local.set({ apiCredentials: CREDS2, credRev: 'r2' }); // 다른 탭
    await settle();
    assert.equal(p.$('clientIdInput').value, 'cid', '고치는 중인 계정 칸은 그대로');
    let lockedDuringSave = null;
    env.api.onFetch = async () => {
      if (lockedDuringSave === null) lockedDuringSave = p.$('intervalInput').readOnly;
    };
    await p.save();
    assert.match(p.$('saveStatus').textContent, /다른 곳/);
    assert.deepEqual(local().apiCredentials, CREDS2);
    assert.equal(p.$('clientIdInput').value, 'cid2', '거절 뒤 최신 계정으로 다시 채움');
    assert.equal(p.$('intervalInput').readOnly, false);
    // 이번에는 저장이 진행되도록 고쳐서 잠금을 확인한다
    await p.type('handleInput', 'Bob');
    await p.save();
    assert.equal(lockedDuringSave, true, '확인 요청 중에는 폼이 잠김');
    assert.equal(sync().handle, 'Bob');
  });
});

describe('9차 리뷰(fable) 회귀 테스트', () => {
  test('06:00 직후 시계가 조금 빨라 서버의 내일을 요청해 거절되면 서버 날짜로 다시 확인한다(핸들 문제로 알리지 않음)', async () => {
    await configured('2026-11-22T06:00:30+09:00'); // 실제 05:58:30, 내 PC가 2분 빠름(시계 차이 모름)
    env.api.serverOffsetMs = -2 * MIN;
    env.api.rejectFutureDay = true;
    env.api.mode = 'unsolved';
    await refresh();
    assert.notEqual(local().lastError?.code, 'rejected');
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    assert.ok(Math.abs(local().clockSkewMs + 2 * MIN) < 2000, '시계 차이를 잼');
    assert.equal(titles().filter((t) => /거절/.test(t)).length, 0);
    assert.equal(env.fake.badge.text, '!');
  });

  test('같은 상황의 저장도 핸들 오류로 막지 않는다', async () => {
    await configured('2026-11-22T06:00:30+09:00');
    env.api.serverOffsetMs = -2 * MIN;
    env.api.rejectFutureDay = true;
    const res = await popup({ type: 'saveSettings', settings: { handle: 'Bob' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.equal(res.ok, true);
    assert.equal(sync().handle, 'Bob');
  });

  test('빠른 시계를 고친 뒤에는 긴 429 대기 중에 시간이 흘러도 시계 오류가 다시 나타나지 않는다', async () => {
    await configured('2026-11-23T20:00:00+09:00'); // 내 PC가 2일 빠름
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = String(3 * 24 * 60 * 60);
    await refresh();
    assert.equal(local().lastError.code, 'clock');
    mock.timers.setTime(at('2026-11-21T20:05:00+09:00')); // 시계를 고침
    env.api.serverOffsetMs = 0;
    await event('runtime.onStartup');
    assert.doesNotMatch(env.fake.badge.title, /시계/);
    mock.timers.setTime(at('2026-11-23T21:00:00+09:00')); // 그때의 내 시계를 지남(아직 대기 중)
    await alarm('poll');
    assert.doesNotMatch(env.fake.badge.title, /시계/);
    assert.equal(titles().filter((t) => /시계/.test(t)).length, 1, '시계 오류 알림은 처음 한 번뿐');
  });
});

describe('10차 리뷰 회귀 테스트', () => {
  test('시계 차이가 1분 미만으로 바뀌어도 다음 06:00 확인 알람을 그 차이에 맞춘다', async () => {
    // 내 PC가 45초 빠르고 아직 시계 차이를 모른다. 06:00:15 알람이 서버 05:59:30에 울린 상황.
    await configured('2026-11-22T06:00:15+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.serverOffsetMs = -45 * 1000;
    env.api.rejectFutureDay = true;
    await alarm('rollover');
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    const rollover = env.fake.alarms.get('rollover').scheduledTime;
    // 서버 06:00:18 = 내 시계 06:01:03(오늘). 내일로 밀리면 안 된다.
    assert.ok(Math.abs(rollover - at('2026-11-22T06:01:03+09:00')) < 5000, new Date(rollover).toISOString());
    mock.timers.setTime(rollover);
    await alarm('rollover');
    assert.equal(local().snapshot.dayKey, '2026-11-22', '서버의 새 날을 확인');
  });

  test('절전 중에 빠른 시계를 고쳐 뒤로 간 것을 못 알아채도, 06:00을 걸쳐 오프라인이면 어제의 ✓를 오늘로 보이지 않는다', async () => {
    await configured('2026-11-22T05:50:00+09:00'); // 내 PC가 30분 빠름(실제 05:20)
    env.api.serverOffsetMs = -30 * MIN;
    await refresh();
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    assert.equal(env.fake.badge.text, '✓');
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00')); // 절전 뒤 시계를 고침(실제 06:10)
    env.api.serverOffsetMs = 0;
    env.api.mode = 'network';
    await refresh();
    assert.notEqual(env.fake.badge.text, '✓');
    env.api.mode = 'solved';
    advance(MIN);
    await refresh();
    assert.equal(local().snapshot.dayKey, '2026-11-22');
    assert.equal(env.fake.badge.text, '✓');
  });

  test('빠른 시계가 맞게 보정돼 있으면 06:00 무렵에도 서버 응답 뒤에는 그대로 믿는다', async () => {
    await configured('2026-11-22T06:10:00+09:00'); // 내 PC가 30분 빠름(실제 05:40)
    env.api.serverOffsetMs = -30 * MIN;
    await refresh();
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    assert.equal(env.fake.badge.text, '✓', '서버 기준으로는 아직 어제');
  });

  test('06:00 바로 앞뒤의 1초 남짓한 차이로 날짜가 엇갈려도 시계 오류로 보지 않고 곧 다시 확인한다', async () => {
    await configured('2026-11-22T06:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    advance(200);
    env.api.serverOffsetMs = -600; // 0.6초 빠름(시계 차이 0으로 잼)
    await refresh();
    assert.notEqual(local().lastError?.code, 'clock');
    assert.doesNotMatch(env.fake.badge.title, /시계/);
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && wake.scheduledTime - Date.now() <= 61 * 1000, '곧 다시 확인');
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(local().snapshot.dayKey, '2026-11-22');
  });

  test('10일 느린 시계로 받은 429는 데이터를 지우고 시계를 고친 뒤 같은 앱을 다시 저장해도 지킨다', async () => {
    const t0 = at('2026-11-11T10:00:00+09:00');
    await configured('2026-11-11T10:00:00+09:00');
    env.api.serverOffsetMs = 10 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '600';
    await refresh();
    await popup({ type: 'resetAll' });
    advance(MIN);
    await alarm('poll'); // 지운 뒤의 주기 확인(대기 기록을 자르지 않아야 한다)
    mock.timers.setTime(t0 + 10 * 24 * 60 * MIN + 2 * MIN); // 시계를 고침(받은 지 실제로 2분 뒤)
    env.api.serverOffsetMs = 0;
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    const res = await popup({ type: 'saveSettings', settings: { handle: 'Taeyang' }, credentials: CREDS, base: { handle: '', clientId: '' } });
    assert.deepEqual([res.ok, res.warning], [true, 'rate-limited']);
    assert.equal(env.api.calls.length, before, '서버가 정한 10분 안에는 요청하지 않음');
  });

  test('2일 빠른 시계로 받은 10분 대기는 데이터를 지우고 시계를 고친 뒤 이틀이 아니라 남은 시간만 기다린다', async () => {
    await configured('2026-11-23T20:00:00+09:00'); // 내 PC가 2일 빠름
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '600';
    await refresh();
    await popup({ type: 'resetAll' });
    advance(5 * MIN);
    await alarm('poll'); // 시계를 고치기 전의 마지막 확인
    mock.timers.setTime(at('2026-11-21T20:11:00+09:00')); // 시계를 고침(받은 지 실제로 11분 뒤)
    await alarm('poll');
    const left = waitEnd('') - Date.now();
    assert.ok(left <= 10 * MIN, `남은 대기 ${left / MIN}분(이틀이 아님)`);
  });

  test('같은 앱의 시크릿을 바꿔(오류 기록이 지워져도) 시계 오류 때 받은 429 대기는 지킨다', async () => {
    const t0 = at('2026-11-11T10:00:00+09:00');
    await configured('2026-11-11T10:00:00+09:00');
    env.api.serverOffsetMs = 10 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '600';
    await refresh();
    const res = await popup({ type: 'saveSettings', settings: {}, credentials: { clientId: 'cid', clientSecret: 'secret-x' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    assert.equal(res.ok, true);
    assert.equal(local().lastError, null);
    advance(MIN);
    await alarm('poll');
    mock.timers.setTime(t0 + 10 * 24 * 60 * MIN + 2 * MIN);
    env.api.serverOffsetMs = 0;
    const before = env.api.calls.length;
    await refresh();
    assert.equal(env.api.calls.length, before);
  });

  test('느린 시계는 시간이 흐른 것만으로 "고쳤다"고 남기지 않는다', async () => {
    await configured('2026-11-19T20:00:00+09:00'); // 2일 느림
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = String(5 * 24 * 60 * 60);
    await refresh();
    advance(2 * 24 * 60 * MIN + 10 * MIN); // 고치지 않은 채 이틀이 흐름
    await alarm('poll');
    assert.equal(local().clockProblem?.fixed, undefined);
  });

  test('다른 기기의 "모든 데이터 지우기"가 나뉘어 도착해도 지운 알림 설정이 v1 값으로 되살아나지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { notifyError: false, targetUsername: 'taeyang95', notifyOnUnknown: false } });
    await env.fake.chrome.storage.sync.remove([...core.SETTINGS_KEYS]); // 첫 묶음
    await settle();
    await env.fake.chrome.storage.sync.remove([...core.LEGACY_SYNC_KEYS]); // 둘째 묶음
    await settle();
    assert.deepEqual(sync(), {});
  });

  test('본문 형식과 상관없이 401은 인증 오류다', async () => {
    const r = core.classifyResponse({ status: 401, contentType: 'text/plain', bodyText: 'Unauthorized' });
    assert.equal(r.code, 'auth');
  });
});

describe('10차 리뷰: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup({ beforeInit } = {}) {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => {
      if (beforeInit) await beforeInit();
      return { id: 1 };
    };
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?popup10=${seq}`, import.meta.url));
    await settle();
    globalThis.setInterval = realSetInterval;
    const $ = (id) => doc.getElementById(id);
    const form = $('settingsForm');
    return {
      $,
      type: async (id, value) => {
        $(id).value = value;
        await form.dispatch('input', { target: $(id) });
        await $(id).dispatch('input');
      },
      save: async () => {
        await form.dispatch('submit');
        await settle();
      },
    };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('제안값 확인 요청 뒤 핸들을 직접 고치면 그 오류 안내(aria-invalid 포함)를 지운다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { targetUsername: 'taeyang95' } });
    const p = await openPopup();
    await p.type('clientIdInput', 'cid');
    await p.type('clientSecretInput', 'secret-1');
    await p.save();
    assert.equal(p.$('handleInput').getAttribute('aria-invalid'), 'true');
    await p.type('handleInput', 'Taeyang');
    assert.equal(p.$('handleInput').getAttribute('aria-invalid'), null);
    assert.equal(p.$('handleInput').getAttribute('aria-errormessage'), null);
    assert.equal(p.$('saveStatus').textContent, '');
  });

  test('키가 없는 기기에서 핸들을 지우고 저장하면 "저장했어요" 대신 핸들을 입력하라고 한다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' } });
    const p = await openPopup();
    await p.type('handleInput', '');
    await p.save();
    assert.match(p.$('saveStatus').textContent, /핸들을 입력해주세요/);
    assert.equal(sync().handle, 'Taeyang');
  });

  test('설정 중인 사용자에게도 알림 표시 실패를 안내한다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { notificationError: 'boom' } });
    const p = await openPopup();
    assert.equal(p.$('permissionWarning').hidden, false);
  });

  test('팝업이 처음 읽는 사이 다른 탭에서 키를 저장해도 놓치지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const p = await openPopup({
      beforeInit: async () => {
        // 팝업의 첫 읽기가 예전 값을 읽은 직후(폼을 채우기 전) 다른 탭이 키를 저장한다.
        const area = env.fake.chrome.storage.local;
        const realGet = area.get.bind(area);
        let once = true;
        area.get = async (keys) => {
          const r = await realGet(keys);
          if (once) {
            once = false;
            area.get = realGet;
            await area.set({ apiCredentials: CREDS, credRev: 'r1' });
            await new Promise((resolve) => setTimeout(resolve, 5)); // 변경 알림이 이때 도착
          }
          return r;
        };
      },
    });
    await settle();
    assert.equal(p.$('clientIdInput').value, 'cid');
    assert.doesNotMatch(p.$('statusTitle').textContent, /API 키가 필요/);
  });
});

describe('11차 리뷰 회귀 테스트', () => {
  test('빠른 시계로 받은 긴 429는 시계를 고친 뒤 시간이 흘러도 끝이 다시 늘어나지 않는다', async () => {
    await configured('2026-11-23T20:00:00+09:00'); // 2일 빠름
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = String(3 * 24 * 60 * 60);
    await refresh();
    mock.timers.setTime(at('2026-11-21T20:05:00+09:00')); // 고침
    env.api.serverOffsetMs = 0;
    await alarm('poll');
    const end = waitEnd('cid');
    assert.ok(Math.abs(end - at('2026-11-24T20:05:00+09:00')) <= 6 * MIN, new Date(end).toISOString());
    mock.timers.setTime(at('2026-11-23T20:30:00+09:00')); // 그때의 내 시계를 지남
    await alarm('poll');
    assert.equal(waitEnd('cid'), end, '끝이 바뀌지 않음');
  });

  test('빠른 시계를 일부만 뒤로 고쳐도 남은 대기를 지킨다', async () => {
    await configured('2026-11-23T20:00:00+09:00'); // 2일 빠름
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '600';
    await refresh();
    advance(MIN);
    await alarm('poll');
    mock.timers.setTime(Date.now() - 6 * MIN); // 6분만 뒤로
    await alarm('poll');
    const left = waitEnd('cid') - Date.now();
    assert.ok(left >= 8.5 * MIN, `남은 대기 ${left / MIN}분`);
  });

  test('시계가 하루 넘게 틀렸다는 근거는 그 뒤 오프라인 실패로 지워지지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN; // 서버가 보기에 내 PC가 2일 느림
    advance(MIN);
    await refresh();
    assert.equal(env.fake.badge.text, '?');
    env.api.mode = 'network';
    advance(16 * MIN);
    await refresh();
    assert.equal(env.fake.badge.text, '?');
    assert.match(env.fake.badge.title, /시계/);
  });

  test('06:00 직후에 잰 시계 차이도 절전 중 시계를 고친 뒤에는 다시 확인하고, 오프라인이면 ✓를 오늘로 보이지 않는다', async () => {
    await configured('2026-11-22T06:05:00+09:00'); // 30분 빠름(실제 05:35)
    env.api.serverOffsetMs = -30 * MIN;
    await refresh();
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00')); // 절전 뒤 고침(실제 06:10)
    env.api.serverOffsetMs = 0;
    env.api.mode = 'network';
    const before = env.api.calls.length;
    await alarm('poll');
    assert.equal(env.api.calls.length, before + 1, '최근 정보가 있어도 다시 확인');
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('06:00 경계의 성공 응답은 예전 인증 오류를 지우고, 곧 다시 확인하는 알람을 지킨다', async () => {
    await configured('2026-11-22T05:59:55+09:00');
    env.api.mode = 'auth';
    await refresh();
    assert.equal(local().lastError.code, 'auth');
    mock.timers.setTime(at('2026-11-22T06:00:00+09:00') + 200);
    env.api.serverOffsetMs = -600;
    env.api.mode = 'solved';
    await refresh();
    assert.doesNotMatch(env.fake.badge.title, /API 키/);
    assert.equal(local().backoffUntil, null);
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && wake.scheduledTime - Date.now() <= 61 * 1000, `재확인 ${(wake?.scheduledTime - Date.now()) / 1000}초 뒤`);
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(local().snapshot.dayKey, '2026-11-22');
  });

  test('알림을 띄우다 멈춘 뒤 알림 목록을 읽지 못하면 띄웠는지 정하지 않고 다음에 맞춘다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    let captured = null;
    env.fake.chrome.notifications.create = async () => {
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      throw new Error('worker stopped');
    };
    await alarm('poll');
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: { chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } }, alarms: prev.fake.alarms, notifications: new Map() },
      },
    });
    const realGetAll = env.fake.chrome.notifications.getAll;
    env.fake.chrome.notifications.getAll = async () => {
      throw new Error('getAll failed');
    };
    await alarm('poll');
    // 목록을 읽지 못하는 동안에는 띄웠는지 알 수 없으므로 알림을 건드리지 않고, 띄웠다고 기록하지도 않는다.
    assert.equal(created().length, 0);
    assert.equal((local().notifHistory?.setup ?? []).length, 0);
    env.fake.chrome.notifications.getAll = realGetAll;
    advance(MIN);
    await alarm('poll');
    // 목록을 읽을 수 있게 되면 띄우지 않은 것으로 맞추고 한 번 띄운다.
    assert.deepEqual(visibleCauses(), ['setup:credentials']);
    assert.equal(created().length, 1, '한 번만');
  });

  test('띄우는 중으로 남은 알림을 사용자가 누르면 띄운 것으로 기록해 다시 띄우지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    const realCreate = notifications.create.bind(notifications);
    let captured = null;
    notifications.create = async (id, options) => {
      const r = await realCreate(id, options);
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      return r;
    };
    await alarm('poll');
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: { chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } }, alarms: prev.fake.alarms, notifications: prev.fake.notifications },
      },
    });
    const id = visible()[0];
    await event('notifications.onClicked', id);
    assert.deepEqual(visible(), []);
    await alarm('poll');
    assert.deepEqual(visible(), [], '다시 띄우지 않음');
    assert.equal(created().length, 0);
  });

  test('"모든 데이터 지우기"가 동기화 저장소를 지운 뒤 끊겨도 다음 시작 때 이 기기의 키와 기록을 마저 지운다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    await refresh();
    const area = env.fake.chrome.storage.local;
    const realRemove = area.remove.bind(area);
    area.remove = async (keys) => {
      if ((Array.isArray(keys) ? keys : [keys]).includes('apiCredentials')) throw new Error('browser closed');
      return realRemove(keys);
    };
    const res = await popup({ type: 'resetAll' });
    assert.equal(res.ok, false);
    assert.deepEqual(sync(), {});
    assert.deepEqual(local().apiCredentials, CREDS, '끊김');
    area.remove = realRemove;
    await boot({ from: env }); // 다음 시작
    assert.equal(local().apiCredentials, undefined);
    assert.equal(local().snapshot, undefined);
    assert.equal(local().resetPending, undefined);
  });
});

describe('11차 리뷰: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup({ beforeInit } = {}) {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => {
      if (beforeInit) await beforeInit();
      return { id: 1 };
    };
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?popup11=${seq}`, import.meta.url));
    await settle(40);
    globalThis.setInterval = realSetInterval;
    return { $: (id) => doc.getElementById(id) };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('첫 읽기 중에 다른 값이 바뀌어 다시 읽어도(먼저 시작한 읽기가 먼저 끝남) 폼을 저장된 값으로 채운다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 17, notifyError: false } });
    await refresh();
    const p = await openPopup({
      beforeInit: async () => {
        // 저장소 읽기가 20ms씩 걸리고(먼저 시작한 읽기가 먼저 끝남), 첫 읽기 2ms 뒤 서비스 워커가 다른 값을 쓴다.
        for (const area of [env.fake.chrome.storage.local, env.fake.chrome.storage.sync]) {
          const realGet = area.get.bind(area);
          area.get = async (keys) => {
            const r = await realGet(keys);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return r;
          };
        }
        setTimeout(() => env.fake.chrome.storage.local.set({ lastAttemptAt: Date.now() }), 2);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    assert.equal(p.$('handleInput').value, 'Taeyang');
    assert.equal(p.$('clientIdInput').value, 'cid');
    assert.equal(p.$('intervalInput').value, '17');
    assert.equal(p.$('notifyError').checked, false);
  });

  test('오늘을 확신할 수 없으면 "오늘 푼 문제"와 오늘 칸, 어제 프리즈 안내를 보여주지 않는다', async () => {
    await configured('2026-11-22T05:50:00+09:00'); // 30분 빠름(실제 05:20)
    env.api.serverOffsetMs = -30 * MIN;
    await refresh();
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00')); // 절전 뒤 고침
    env.api.serverOffsetMs = 0;
    env.api.mode = 'network';
    await refresh();
    const p = await openPopup();
    assert.equal(p.$('todaySolved').textContent, '-');
    assert.equal(p.$('recent').hidden, true);
    assert.ok(!p.$('notes').children.some((c) => /어제 스트릭 프리즈/.test(c.textContent)));
  });
});

describe('12차 리뷰 회귀 테스트', () => {
  test('동기화 저장소 지우기가 실패한 뒤 저장한 설정은, 다음 시작 때 지우기를 마무리하면서 지워지지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const syncArea = env.fake.chrome.storage.sync;
    const realRemove = syncArea.remove.bind(syncArea);
    let failOnce = true;
    syncArea.remove = async (keys) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('sync quota');
      }
      return realRemove(keys);
    };
    const r1 = await popup({ type: 'resetAll' });
    assert.equal(r1.ok, false);
    // 이어서 저장: 끊긴 지우기를 먼저 마무리한 뒤 저장한다
    const r2 = await popup({ type: 'saveSettings', prefsOnly: true, settings: { checkIntervalMin: 9 } });
    assert.equal(r2.ok, true);
    assert.equal(sync().checkIntervalMin, 9);
    await boot({ from: env }); // 다시 시작
    assert.equal(sync().checkIntervalMin, 9, '다시 시작해도 그 뒤 저장한 설정이 남음');
  });

  test('지우기가 동기화 저장소를 지운 뒤 끊기고 그 사이 다른 기기가 저장했으면, 마무리할 때 그 설정을 지우지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const area = env.fake.chrome.storage.local;
    const realRemove = area.remove.bind(area);
    area.remove = async (keys) => {
      if ((Array.isArray(keys) ? keys : [keys]).includes('apiCredentials')) throw new Error('browser closed');
      return realRemove(keys);
    };
    await popup({ type: 'resetAll' });
    area.remove = realRemove;
    await env.fake.chrome.storage.sync.set({ handle: 'Carol' }); // 다른 기기
    await boot({ from: env });
    assert.equal(sync().handle, 'Carol');
    assert.equal(local().apiCredentials, undefined, '이 기기의 키는 지움');
  });

  test('429 대기 중이라 확인할 수 없어도, 시계 차이를 잰 지 오래되면 06:00 무렵 어제의 ✓를 오늘로 보이지 않는다', async () => {
    await configured('2026-11-22T06:05:00+09:00'); // 30분 빠름(실제 05:35)
    env.api.serverOffsetMs = -30 * MIN;
    await refresh();
    advance(MIN);
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    await refresh();
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00')); // 절전 뒤 고침(실제 06:10)
    env.api.serverOffsetMs = 0;
    const before = env.api.calls.length;
    await alarm('poll');
    assert.equal(env.api.calls.length, before, '대기는 지킴');
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('오늘을 확신할 수 없으면 팝업 메시지로 다른 날을 끄지 못한다', async () => {
    await configured('2026-11-22T05:50:00+09:00'); // 30분 빠름
    env.api.serverOffsetMs = -30 * MIN;
    await refresh();
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00'));
    env.api.serverOffsetMs = 0;
    env.api.mode = 'network';
    await refresh();
    const res = await popup({ type: 'snooze', handle: 'Taeyang', dayKey: '2026-11-21' });
    assert.deepEqual([res.ok, res.error], [false, 'stale']);
    assert.equal(local().snoozeDayKey, undefined);
  });

  test('시계가 하루 넘게 틀린 날짜의 401도 API 키 오류로 알리고, 정상 날짜의 401은 시계 문제 기록을 지운다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'auth';
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    await refresh();
    assert.match(env.fake.badge.title, /API 키/);
    assert.ok(local().clockProblem);
    env.api.serverOffsetMs = 0;
    const res = await popup({
      type: 'saveSettings',
      settings: {},
      credentials: { clientId: 'cid', clientSecret: 'WRONG' },
      base: { handle: 'Taeyang', clientId: 'cid' },
    });
    assert.equal(res.error, 'auth');
    assert.equal(local().clockProblem, null, '저장을 막아도 시계 기록은 정상으로');
  });

  test('2일 빠른 시계를 6분만 뒤로 고치면 시계 오류를 계속 알린다', async () => {
    await configured('2026-11-23T20:00:00+09:00');
    env.api.serverOffsetMs = -2 * 24 * 60 * MIN;
    env.api.mode = 'rate-limited';
    env.api.retryAfter = String(3 * 24 * 60 * 60);
    await refresh();
    mock.timers.setTime(Date.now() - 6 * MIN);
    await alarm('poll');
    assert.equal(local().clockProblem?.fixed, undefined);
    assert.match(env.fake.badge.title, /시계/);
  });

  test('정확한 시계로 받은 10분 대기는 곧바로 시계를 이틀 되돌려도 10분 남짓만 기다린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '600';
    await refresh();
    mock.timers.setTime(Date.now() - 2 * 24 * 60 * MIN);
    await alarm('poll');
    const left = waitEnd('cid') - Date.now();
    assert.ok(left <= 11 * MIN, `남은 대기 ${left / MIN}분`);
  });

  test('알림을 띄운 직후 멈춘 뒤 알림 목록을 읽지 못하면 그대로 두고(중복 없음), 읽을 수 있을 때 띄운 것으로 맞춘다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    const realCreate = notifications.create.bind(notifications);
    let captured = null;
    notifications.create = async (id, options) => {
      const r = await realCreate(id, options);
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      return r;
    };
    await alarm('poll');
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: { chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } }, alarms: prev.fake.alarms, notifications: prev.fake.notifications },
      },
    });
    const id = visible()[0];
    const realGetAll = env.fake.chrome.notifications.getAll;
    env.fake.chrome.notifications.getAll = async () => {
      throw new Error('getAll failed');
    };
    await alarm('poll');
    assert.deepEqual(visible(), [id], '건드리지 않음');
    assert.equal(created().length, 0);
    env.fake.chrome.notifications.getAll = realGetAll;
    advance(MIN);
    await alarm('poll');
    assert.deepEqual(visible(), [id]);
    assert.equal(created().length, 0, '다시 띄우지 않음');
    assert.ok(local().notifHistory.setup.includes('setup:credentials'));
  });

  test('띄우기 전 기록 쓰기가 실패하면 한 번만 띄우는 설정 알림을 띄운 것으로 치지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    let failOnce = true;
    area.set = async (items) => {
      if (failOnce && items.notifPending) {
        failOnce = false;
        throw new Error('write failed');
      }
      return realSet(items);
    };
    await alarm('poll');
    assert.equal(created().length, 0);
    assert.equal((local().notifHistory?.setup ?? []).length, 0);
    advance(MIN);
    await alarm('poll');
    assert.deepEqual(visibleCauses(), ['setup:credentials']);
  });
});

describe('12차 리뷰: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup() {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => ({ id: 1 });
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?popup12=${seq}`, import.meta.url));
    await settle(40);
    globalThis.setInterval = realSetInterval;
    return { $: (id) => doc.getElementById(id) };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('오늘을 확신할 수 없으면 마감 시각을 세지 않고 "오늘은 그만 알림"도 보여주지 않는다', async () => {
    await configured('2026-11-22T05:50:00+09:00'); // 30분 빠름
    env.api.serverOffsetMs = -30 * MIN;
    env.api.mode = 'unsolved';
    await refresh();
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00'));
    env.api.serverOffsetMs = 0;
    env.api.mode = 'network';
    await refresh();
    const p = await openPopup();
    assert.doesNotMatch(p.$('deadline').textContent, /남음/);
    assert.equal(p.$('snoozeButton').hidden, true);
  });
});

describe('12차 리뷰(fable) 회귀 테스트', () => {
  test('맞던 시계가 잠깐 앞으로 갔다가 돌아와도 429 대기가 짧아지지 않는다', async () => {
    await configured('2026-11-21T12:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'rate-limited';
    env.api.retryAfter = String(6 * 60 * 60);
    await refresh();
    mock.timers.setTime(at('2026-11-21T15:01:00+09:00')); // 시계가 3시간 앞으로(실제 12:01)
    await alarm('poll');
    mock.timers.setTime(at('2026-11-21T12:02:00+09:00')); // 다시 맞춤
    await alarm('poll');
    assert.ok(waitEnd('cid') >= at('2026-11-21T18:00:00+09:00'), new Date(waitEnd('cid')).toISOString());
  });
});

describe('13차 리뷰 회귀 테스트', () => {
  test('첫 동기화 지우기가 실패한 뒤 다른 기기가 저장한 설정은, 지우기를 마무리할 때 지우지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const syncArea = env.fake.chrome.storage.sync;
    const realRemove = syncArea.remove.bind(syncArea);
    let failOnce = true;
    syncArea.remove = async (keys) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('sync quota');
      }
      return realRemove(keys);
    };
    const r = await popup({ type: 'resetAll' });
    assert.equal(r.ok, false);
    await syncArea.set({ handle: 'Carol', checkIntervalMin: 37 }); // 다른 기기
    await settle();
    await refresh(); // 끊긴 지우기를 마무리
    assert.equal(sync().handle, 'Carol');
    assert.equal(sync().checkIntervalMin, 37);
    assert.equal(sync().notifyError, undefined, '그대로인 항목은 지움');
    assert.equal(local().apiCredentials, undefined);
    assert.equal(local().resetPending, undefined);
  });

  test('지우기 시작 기록을 남기지 못하면 아무것도 지우지 않고 그렇게 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    area.set = async (items) => {
      if ('resetPending' in items) throw new Error('write failed');
      return realSet(items);
    };
    const r = await popup({ type: 'resetAll' });
    area.set = realSet;
    assert.deepEqual([r.ok, r.error], [false, 'reset-not-started']);
    assert.deepEqual(local().apiCredentials, CREDS);
    assert.equal(sync().handle, 'Taeyang');
  });

  test('맞던 시계를 이틀 되돌렸다가 다시 맞춰도 남은 429 대기를 지킨다', async () => {
    await configured('2026-11-21T12:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '600';
    await refresh();
    mock.timers.setTime(at('2026-11-19T12:01:00+09:00')); // 이틀 되돌림
    await alarm('poll');
    mock.timers.setTime(at('2026-11-21T12:02:00+09:00')); // 다시 맞춤
    await alarm('poll');
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    await refresh();
    assert.equal(env.api.calls.length, before, '12:10까지는 요청하지 않음');
    assert.ok(waitEnd('cid') >= at('2026-11-21T12:10:00+09:00'));
  });

  test('시계 차이 구간에서 측정이 2분을 넘기는 때 깨어나 배지를 맞춘다(429 대기 중에도)', async () => {
    await configured('2026-11-22T06:01:00+09:00', { sync: { checkIntervalMin: 1440 } }); // 1시간 빠름(실제 05:01)
    env.api.serverOffsetMs = -60 * MIN;
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '7200';
    advance(30 * 1000);
    await refresh();
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && wake.scheduledTime - Date.now() <= 2 * MIN + 2000, `wake ${(wake?.scheduledTime - Date.now()) / 1000}초 뒤`);
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('서버가 새 날을 보여 준 뒤 시계가 뒤로 가도 어제의 ✓로 돌아가지 않는다', async () => {
    await configured('2026-11-22T05:58:00+09:00');
    await refresh();
    assert.equal(local().snapshot.dayKey, '2026-11-21');
    mock.timers.setTime(at('2026-11-22T06:03:00+09:00'));
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    await refresh();
    assert.notEqual(env.fake.badge.text, '✓');
    mock.timers.setTime(at('2026-11-22T05:58:30+09:00')); // 시계가 뒤로
    await alarm('poll');
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('막힌 저장 확인 응답의 Date로도 시계 차이를 재고 06:00을 맞춘다', async () => {
    await configured('2026-11-22T05:55:00+09:00');
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    await env.fake.chrome.storage.local.set({ rateLimits: { cid: Date.now() + 60 * MIN } });
    env.api.serverOffsetMs = 30 * MIN; // 서버는 이미 06:25
    const res = await popup({
      type: 'saveSettings',
      settings: {},
      credentials: { clientId: 'cid2', clientSecret: 'WRONG' },
      base: { handle: 'Taeyang', clientId: 'cid' },
    });
    assert.equal(res.error, 'auth');
    assert.ok(Math.abs(local().clockSkewMs - 30 * MIN) < 2000);
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('오늘을 확신할 수 없으면 알림의 "오늘은 그만 알림"도 받지 않고, 새 알림에는 그 버튼을 넣지 않는다', async () => {
    await configured('2026-11-22T05:50:00+09:00'); // 30분 빠름
    env.api.serverOffsetMs = -30 * MIN;
    await refresh();
    mock.timers.setTime(at('2026-11-22T06:10:00+09:00'));
    env.api.serverOffsetMs = 0;
    env.api.mode = 'network';
    await refresh();
    await event('notifications.onButtonClicked', 'ssc|x1|2026-11-21|Taeyang|error:network', 1);
    assert.equal(local().snoozeDayKey, undefined);
    // 시각 정보 없는 실패가 10분 넘게 이어져 오류 알림이 뜨는 동안에도 날짜를 모르므로 버튼은 하나뿐이다.
    for (let i = 0; i < 3; i++) {
      advance(5 * MIN);
      await refresh();
    }
    const n = created().at(-1);
    assert.ok(n && n.id.endsWith('|error:network'), n?.id);
    assert.equal(n.buttons.length, 1);
  });

  test('설정 알림을 띄운 직후 멈추고 핸들이 바뀌어도 같은 설정 알림을 다시 띄우지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    const realCreate = notifications.create.bind(notifications);
    let captured = null;
    notifications.create = async (id, options) => {
      const r = await realCreate(id, options);
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      return r;
    };
    await alarm('poll');
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: { chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } }, alarms: prev.fake.alarms, notifications: prev.fake.notifications },
      },
    });
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' });
    await settle();
    await alarm('poll');
    assert.equal(created().length, 0, '다시 띄우지 않음');
  });
});

describe('13차 리뷰(fable) 회귀 테스트', () => {
  test('짧은 Retry-After의 429가 계속되어도 자동 확인은 재시도 간격(5분)보다 자주 하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '1';
    await refresh();
    const start = Date.now();
    const before = env.api.calls.length;
    while (Date.now() - start < 60 * MIN) {
      const wake = env.fake.alarms.get('wake');
      const poll = env.fake.alarms.get('poll');
      const next = Math.min(wake?.scheduledTime ?? Infinity, poll?.scheduledTime ?? Infinity);
      mock.timers.setTime(Math.max(next, Date.now() + 1000));
      await alarm(next === wake?.scheduledTime ? 'wake' : 'poll');
      if (env.fake.alarms.get('poll')) env.fake.alarms.get('poll').scheduledTime = Date.now() + 5 * MIN;
    }
    const n = env.api.calls.length - before;
    assert.ok(n <= 13, `한 시간에 ${n}번`);
  });
});

describe('14차 리뷰 회귀 테스트', () => {
  test('429 대기 중 핸들을 바꿨다 돌아와도 대기가 끝나는 시각에 깨어난다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 240 } });
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '1800';
    await refresh();
    await popup({ type: 'saveSettings', settings: { handle: 'Other' }, base: { handle: 'Taeyang', clientId: 'cid' } });
    await popup({ type: 'saveSettings', settings: { handle: 'Taeyang' }, base: { handle: 'Other', clientId: 'cid' } });
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && Math.abs(wake.scheduledTime - waitEnd('cid')) < 2000, '대기 끝에 깨어남');
  });

  test('짧은 429가 이어질 때 팝업을 1분마다 열어도 재시도 간격보다 자주 요청하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '1';
    await refresh();
    const before = env.api.calls.length;
    for (let i = 0; i < 60; i++) {
      advance(MIN);
      await popup({ type: 'refresh', force: false });
    }
    const n = env.api.calls.length - before;
    assert.ok(n <= 13, `한 시간에 ${n}번`);
  });

  test('9시간 느린 시계(듀얼 부팅)는 06:00 무렵에도 2분마다 확인하지 않는다', async () => {
    await configured('2026-11-21T21:00:00+09:00', { sync: { checkIntervalMin: 60 } }); // 내 시계 21:00, 서버 다음 날 06:00
    env.api.serverOffsetMs = 9 * 60 * MIN;
    await refresh(); // 서버 11-22 06:00 → 해결
    const before = env.api.calls.length;
    const start = Date.now();
    while (Date.now() - start < 3 * 60 * MIN) {
      const next = Math.min(...['wake', 'poll', 'rollover'].map((n) => env.fake.alarms.get(n)?.scheduledTime ?? Infinity));
      mock.timers.setTime(Math.max(next, Date.now() + 1000));
      const name = ['wake', 'poll', 'rollover'].find((n) => env.fake.alarms.get(n)?.scheduledTime === next) ?? 'poll';
      await alarm(name);
      if (env.fake.alarms.get('poll')) env.fake.alarms.get('poll').scheduledTime = Math.max(env.fake.alarms.get('poll').scheduledTime, Date.now() + 60 * MIN);
    }
    const n = env.api.calls.length - before;
    assert.ok(n <= 10, `3시간에 ${n}번`);
  });

  test('서버 시각이 한 번 사흘 앞으로 튀어도, 정상 응답을 받으면 오늘 날짜를 다시 확신한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.serverOffsetMs = 3 * 24 * 60 * MIN;
    await refresh();
    env.api.serverOffsetMs = 0;
    advance(MIN);
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
  });

  test('지우기를 시작하며 읽기가 실패하면 아무것도 지우지 않았다고 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const syncArea = env.fake.chrome.storage.sync;
    const realGet = syncArea.get.bind(syncArea);
    syncArea.get = async (keys) => {
      if (keys === null) throw new Error('read failed');
      return realGet(keys);
    };
    const r = await popup({ type: 'resetAll' });
    syncArea.get = realGet;
    assert.deepEqual([r.ok, r.error], [false, 'reset-not-started']);
    assert.deepEqual(local().apiCredentials, CREDS);
  });

  test('429 응답의 대기와 시계 정보는 본문을 받기 전에 저장된다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const realFetch = env.api.fetch;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    globalThis.fetch = async (url, init) => {
      env.api.calls.push({ url, at: Date.now() });
      const body = new ReadableStream({
        async pull(c) {
          await gate;
          c.close();
        },
      });
      return new Response(body, {
        status: 429,
        headers: { 'retry-after': '1800', date: new Date(Date.now() + 2 * 24 * 60 * MIN).toUTCString() },
      });
    };
    const pending = popup({ type: 'refresh', force: true });
    await settle();
    assert.ok(waitEnd('cid') > Date.now() + 29 * MIN, '본문 전에 대기 기록');
    assert.ok(local().clockProblem, '본문 전에 시계 기록');
    release();
    await pending;
    globalThis.fetch = realFetch;
  });
});

describe('14차 리뷰: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup() {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => ({ id: 1 });
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?popup14=${seq}`, import.meta.url));
    await settle(40);
    globalThis.setInterval = realSetInterval;
    const $ = (id) => doc.getElementById(id);
    return { $, click: async (id) => { await $(id).dispatch('click'); await settle(); } };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('지우기를 시작하지 못하면 "아무것도 지우지 않았어요"라고 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const p = await openPopup();
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    area.set = async (items) => {
      if ('resetPending' in items) throw new Error('write failed');
      return realSet(items);
    };
    await p.click('resetButton');
    await p.click('resetConfirmButton');
    area.set = realSet;
    assert.match(p.$('saveStatus').textContent, /시작하지 못했어요/);
  });
});

describe('15차 리뷰(fable) 회귀 테스트', () => {
  test('핸들을 바꿨다 돌아오면 예전 핸들의 오류 기록은 남지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'blocked';
    await refresh();
    assert.equal(local().lastError.code, 'blocked');
    // 그 사이에는 요청이 나가지 않게(429 대기) 해서, 남은 오류가 예전 기록인지만 본다.
    await env.fake.chrome.storage.local.set({ rateLimits: { cid: Date.now() + 60 * MIN } });
    await env.fake.chrome.storage.sync.set({ handle: 'Other' });
    await settle();
    await env.fake.chrome.storage.sync.set({ handle: 'Taeyang' });
    await settle();
    assert.equal(local().lastError, undefined);
    assert.doesNotMatch(env.fake.badge.title, /보안 확인/);
  });

  test('시계 차이가 몇 초만 바뀌어도 06:00 알람을 그 차이에 맞춘다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.serverOffsetMs = -14 * 1000; // 14초 빠름
    await refresh();
    const rollover = env.fake.alarms.get('rollover').scheduledTime;
    assert.ok(Math.abs(rollover - (at('2026-11-22T06:00:18+09:00') + 14 * 1000)) < 2000, new Date(rollover).toISOString());
  });
});

describe('16차 리뷰 회귀 테스트', () => {
  test('내 시계가 14초 빠르면 06:00 직후 반영 여유 안에서 확인하지 않고, 여유 뒤의 확인으로 어제의 ✓를 바로잡는다', async () => {
    await configured('2026-11-22T05:50:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.serverOffsetMs = -14 * 1000;
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    // 서버는 06:00:15 전까지 어제의 countedToday를 돌려준다(반영 지연).
    env.api.onFetch = () => {
      env.api.mode = Date.now() + env.api.serverOffsetMs < at('2026-11-22T06:00:14+09:00') ? 'solved' : 'unsolved';
    };
    const before = env.api.calls.length;
    for (let i = 0; i < 8; i++) {
      const next = ['wake', 'rollover']
        .map((n) => env.fake.alarms.get(n))
        .filter(Boolean)
        .sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
      if (!next || next.scheduledTime > at('2026-11-22T06:02:00+09:00')) break;
      mock.timers.setTime(Math.max(Date.now(), next.scheduledTime));
      await alarm(next.name);
    }
    const serverTimes = env.api.calls.slice(before).map((c) => c.at + env.api.serverOffsetMs);
    assert.ok(serverTimes.length >= 1, '06:00 뒤에 확인함');
    // Date 헤더는 초 단위라 시계 차이 측정에 1초 안쪽의 오차가 있다.
    for (const t of serverTimes) {
      assert.ok(t < at('2026-11-22T06:00:00+09:00') || t >= at('2026-11-22T06:00:14+09:00'), new Date(t).toISOString());
    }
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('맞던 시계를 06:00 뒤에 06:00 전으로 되돌리면(429 대기 중) 지난 날의 ✓를 보여주지 않는다', async () => {
    await configured('2026-11-22T05:55:00+09:00');
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    advance(4 * MIN); // 05:59
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    await refresh();
    // 실제 06:05에 기기 시계를 05:05로 되돌림
    mock.timers.setTime(at('2026-11-22T05:05:00+09:00'));
    env.api.serverOffsetMs = 60 * MIN;
    const before = env.api.calls.length;
    await alarm('poll');
    assert.equal(env.api.calls.length, before, '대기는 지킨다');
    assert.equal(local().dayEvidenceLost, true);
    assert.notEqual(env.fake.badge.text, '✓');
    // 대기가 끝나고 시각 정보가 있는 응답을 받으면 풀린다.
    env.api.mode = 'unsolved';
    mock.timers.setTime(at('2026-11-22T07:00:00+09:00')); // 내 시계로 받은 시각 기준의 대기도 끝남
    await refresh();
    assert.ok(!local().dayEvidenceLost);
    assert.equal(local().snapshot.dayKey, '2026-11-22');
  });

  test('동기화 설정을 지운 뒤 이 기기 정리가 끊기면, 나중에 다른 기기가 같은 핸들을 다시 저장해도 지우지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const area = env.fake.chrome.storage.local;
    const realRemove = area.remove.bind(area);
    let broken = true; // 이 기기 정리가 계속 끊긴다(서비스 워커가 멈춘 것과 같음)
    area.remove = async (keys) => {
      if (broken && Array.isArray(keys) && keys.includes('apiCredentials')) throw new Error('stopped');
      return realRemove(keys);
    };
    const r = await popup({ type: 'resetAll' });
    assert.deepEqual([r.ok, r.error], [false, 'reset-incomplete']);
    assert.equal(sync().handle, undefined);
    assert.deepEqual(local().resetPending, { phase: 'local' });
    advance(3 * 60 * MIN);
    await env.fake.chrome.storage.sync.set({ handle: 'Taeyang' }); // 다른 기기가 같은 값으로 다시 저장
    await settle();
    assert.equal(sync().handle, 'Taeyang');
    broken = false;
    await refresh();
    assert.equal(sync().handle, 'Taeyang');
    assert.equal(local().apiCredentials, undefined);
    assert.equal(local().resetPending, undefined);
  });

  test('헤더 시각 정보 저장이 한 번 실패해도 다시 기록해 시계 오류를 놓치지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    let failOnce = true;
    area.set = async (items) => {
      if (failOnce && 'clockProblem' in items) {
        failOnce = false;
        throw new Error('write failed');
      }
      return realSet(items);
    };
    env.api.serverOffsetMs = 3 * 24 * 60 * MIN;
    advance(MIN);
    await refresh();
    area.set = realSet;
    assert.equal(failOnce, false, '헤더 쓰기가 한 번 실패함');
    assert.ok(local().clockProblem, '시계 문제 근거를 다시 기록');
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('429 대기 중 핸들을 바꿨다 돌아오면, 대기가 끝날 때 최근 정보가 있어도 한 번 확인한다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh();
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '360';
    advance(MIN);
    await refresh();
    assert.equal(local().retryOwed, true);
    await env.fake.chrome.storage.sync.set({ handle: 'Other' });
    await settle();
    await env.fake.chrome.storage.sync.set({ handle: 'Taeyang' });
    await settle();
    env.api.mode = 'solved';
    const before = env.api.calls.length;
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake, 'wake 알람');
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.api.calls.length, before + 1, '대기가 끝나면 확인');
    assert.ok(!local().retryOwed);
  });

  test('지난 지우기 기록을 읽지 못하면 아무것도 지우지 않고 그렇게 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const area = env.fake.chrome.storage.local;
    const realGet = area.get.bind(area);
    area.get = async (keys) => {
      if (keys === 'resetPending') throw new Error('read failed');
      return realGet(keys);
    };
    const r = await popup({ type: 'resetAll' });
    area.get = realGet;
    assert.deepEqual([r.ok, r.error], [false, 'reset-not-started']);
    assert.deepEqual(local().apiCredentials, CREDS);
    assert.equal(sync().handle, 'Taeyang');
  });

  test('키를 저장한 뒤 알람 설정이 실패해도 저장했다고 알리고 알람을 다시 건다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const alarms = env.fake.chrome.alarms;
    const realGet = alarms.get.bind(alarms);
    let failOnce = true;
    alarms.get = async (name) => {
      if (failOnce && env.fake.chrome.storage.local.data.get('apiCredentials')?.clientId === 'cid2') {
        failOnce = false;
        throw new Error('alarms busy');
      }
      return realGet(name);
    };
    const res = await popup({
      type: 'saveSettings',
      settings: {},
      credentials: CREDS2,
      base: { handle: 'Taeyang', clientId: 'cid' },
    });
    alarms.get = realGet;
    assert.equal(failOnce, false, '저장 뒤 알람 조회가 한 번 실패함');
    assert.equal(res.ok, true);
    assert.equal(res.followUpFailed, true);
    assert.deepEqual(local().apiCredentials, CREDS2);
    assert.ok(env.fake.alarms.get('poll') && env.fake.alarms.get('rollover'), '알람을 다시 걺');
  });

  test('설정 알림을 띄우기 전에 멈춘 뒤 알림 목록을 읽지 못한 채 핸들이 바뀌어도, 그 알림을 띄운 것으로 치지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    const realCreate = notifications.create.bind(notifications);
    let captured = null;
    notifications.create = async (id, options) => {
      captured ??= new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      return realCreate(id, options);
    };
    await alarm('poll');
    assert.ok(captured?.get('notifPending'), '띄우는 중 기록');
    const prev = env;
    // 알림을 띄우기 전에 멈췄다: 저장소는 그 시점이고 화면에는 알림이 없다.
    await boot({
      from: {
        api: prev.api,
        fake: {
          chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } },
          alarms: prev.fake.alarms,
          notifications: new Map(),
        },
      },
    });
    const n = env.fake.chrome.notifications;
    const realGetAll = n.getAll.bind(n);
    n.getAll = async () => {
      throw new Error('unavailable');
    };
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' });
    await settle();
    assert.deepEqual(local().notifHistory?.setup ?? [], [], '띄운 것으로 치지 않음');
    assert.ok(local().notifPending?.setupOnly, '확인할 수 있을 때까지 남김');
    n.getAll = realGetAll;
    await alarm('poll');
    assert.equal(created().length, 1, '띄우지 못했던 설정 알림을 띄움');
  });

  test('띄우는 중으로 남긴 설정 알림이 실제로 떠 있었다면 그 원인만 기록에 더한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const id = core.makeNotificationId({ cause: 'setup:credentials', dayKey: '2026-11-21', handle: 'Old', seq: 'x1' });
    await env.fake.chrome.storage.local.set({
      notifHistory: { setup: [], reminder: { dayKey: '2026-11-21', at: Date.now() } },
      notifPending: { id, setupOnly: true, history: { setup: ['setup:credentials'] }, fallback: { setup: [] } },
    });
    env.fake.notifications.set(id, {});
    await alarm('poll');
    assert.deepEqual(local().notifHistory.setup, ['setup:credentials']);
    assert.ok(local().notifHistory.reminder, '지금 핸들의 다른 기록은 그대로');
    assert.equal(local().notifPending, null);
  });
});

describe('16차 리뷰: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup() {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => ({ id: 1 });
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?popup16=${seq}`, import.meta.url));
    await settle(40);
    globalThis.setInterval = realSetInterval;
    const $ = (id) => doc.getElementById(id);
    const form = $('settingsForm');
    return {
      $,
      click: async (id) => {
        await $(id).dispatch('click');
        await settle();
      },
      type: async (id, value) => {
        $(id).value = value;
        await form.dispatch('input', { target: $(id) });
        await $(id).dispatch('input');
      },
    };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('지난 지우기 기록을 읽지 못해 지우지 못하면 고치던 값을 그대로 두고 "마저 지워요"라고 하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const p = await openPopup();
    await p.type('handleInput', 'Draft');
    const area = env.fake.chrome.storage.local;
    const realGet = area.get.bind(area);
    area.get = async (keys) => {
      if (keys === 'resetPending') throw new Error('read failed');
      return realGet(keys);
    };
    await p.click('resetButton');
    await p.click('resetConfirmButton');
    area.get = realGet;
    assert.equal(p.$('handleInput').value, 'Draft');
    assert.match(p.$('saveStatus').textContent, /시작하지 못했어요/);
    assert.doesNotMatch(p.$('saveStatus').textContent, /마저 지워요/);
  });

  test('어디까지 지웠는지 모르는 오류면 고치던 값을 그대로 두고, 일부만 지워졌을 수 있다고 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const p = await openPopup();
    await p.type('handleInput', 'Draft');
    const realSend = env.fake.chrome.runtime.sendMessage;
    env.fake.chrome.runtime.sendMessage = async (m) =>
      m.type === 'resetAll' ? { ok: false, error: 'internal' } : realSend(m);
    await p.click('resetButton');
    await p.click('resetConfirmButton');
    env.fake.chrome.runtime.sendMessage = realSend;
    assert.equal(p.$('handleInput').value, 'Draft');
    assert.match(p.$('saveStatus').textContent, /일부만 지워졌을 수/);
  });

  test('시계가 뒤로 가 오늘을 정할 수 없으면 팝업도 "오늘은 그만 알림"을 보여주지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { notifyStartHours: 24 } });
    env.api.mode = 'unsolved';
    await refresh();
    // 팝업을 열 때의 확인이 나가지 않도록(시각 정보가 있는 응답은 이 표시를 지운다) 429 대기를 둔다.
    await env.fake.chrome.storage.local.set({ rateLimits: { cid: Date.now() + 60 * MIN } });
    const shown = await openPopup();
    assert.equal(shown.$('snoozeButton').hidden, false, '평소에는 보임');
    await env.fake.chrome.storage.local.set({ dayEvidenceLost: true });
    const p = await openPopup();
    assert.equal(p.$('snoozeButton').hidden, true);
  });
});

describe('채점 사이트에서 다시 불러오기', () => {
  test('누르면 2분 뒤부터 다시 확인하고, 푼 것이 보이면 멈춘다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 60 } });
    env.api.mode = 'unsolved';
    await refresh();
    const r = await popup({ type: 'watchReimport', handle: 'Taeyang' });
    assert.equal(r.ok, true);
    assert.equal(r.until, Date.now() + core.REIMPORT_WATCH_MS);
    const before = env.api.calls.length;
    let wake = env.fake.alarms.get('wake');
    assert.ok(wake && Math.abs(wake.scheduledTime - (Date.now() + 2 * MIN)) < 2000, '2분 뒤');
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.api.calls.length, before + 1);
    env.api.mode = 'solved'; // 다시 불러오기가 반영됨
    wake = env.fake.alarms.get('wake');
    assert.ok(wake && wake.scheduledTime - Date.now() <= 2 * MIN + 2000);
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.api.calls.length, before + 2);
    assert.equal(env.fake.badge.text, '✓');
    wake = env.fake.alarms.get('wake');
    assert.ok(!wake || wake.scheduledTime - Date.now() > 10 * MIN, '푼 뒤에는 더 자주 확인하지 않음');
  });

  test('이미 풀었어도 누르면 최근 정보가 있어도 다시 확인하고, 문제 수가 바뀌면 멈춘다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    const before = env.api.calls.length;
    let wake = env.fake.alarms.get('wake');
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.api.calls.length, before + 1, '30분 안이어도 확인');
    // 다시 불러오기가 반영되어 최근 기록(어제)이 바뀜
    const realFetch = env.api.fetch;
    globalThis.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      const body = await res.json();
      body.days = [...body.days, { day: core.addDays(body.to, -1), solvedCount: 3, maxSolvedLevel: 3, ratingDelta: 0, freezeUsed: false, streakRepaired: false }];
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    };
    wake = env.fake.alarms.get('wake');
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.api.calls.length, before + 2);
    wake = env.fake.alarms.get('wake');
    assert.ok(!wake || wake.scheduledTime - Date.now() > 10 * MIN, '반영되면 멈춤');
  });

  test('반영되지 않아도 10분이 지나면 멈추고, 그동안 다섯 번까지만 확인한다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440, notifyUnsolved: false } });
    env.api.mode = 'unsolved';
    await refresh();
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    const start = Date.now();
    const before = env.api.calls.length;
    for (let i = 0; i < 20; i++) {
      const wake = env.fake.alarms.get('wake');
      if (!wake || wake.scheduledTime > start + 30 * MIN) break;
      mock.timers.setTime(wake.scheduledTime);
      await alarm('wake');
    }
    const n = env.api.calls.length - before;
    assert.ok(n >= 4 && n <= 5, `${n}번`);
    assert.ok(env.api.calls.at(-1).at <= start + core.REIMPORT_WATCH_MS);
  });

  test('다른 핸들에 대한 요청은 받지 않고, 핸들이 바뀌면 기간도 지운다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const r = await popup({ type: 'watchReimport', handle: 'Other' });
    assert.deepEqual([r.ok, r.error], [false, 'stale']);
    assert.equal(local().reimportWatch, undefined);
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    assert.ok(local().reimportWatch);
    await env.fake.chrome.storage.sync.set({ handle: 'Other' });
    await settle();
    assert.equal(local().reimportWatch, undefined);
  });

  test('429 대기 중에도 대기는 지킨다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440, notifyUnsolved: false } });
    env.api.mode = 'unsolved';
    await refresh();
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '900';
    advance(MIN);
    await refresh();
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    const before = env.api.calls.length;
    const end = waitEnd('cid');
    let fires = 0;
    for (let i = 0; i < 40; i++) {
      const wake = env.fake.alarms.get('wake');
      if (!wake || wake.scheduledTime >= end) break;
      mock.timers.setTime(wake.scheduledTime);
      await alarm('wake');
      fires += 1;
    }
    assert.equal(env.api.calls.length, before, '대기 중에는 요청하지 않음');
    assert.equal(fires, 0, `대기가 끝나기 전에 ${fires}번 깨어남`);
  });
});

describe('채점 사이트에서 다시 불러오기: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup() {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => ({ id: 1 });
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?reimport=${seq}`, import.meta.url));
    await settle(40);
    globalThis.setInterval = realSetInterval;
    const $ = (id) => doc.getElementById(id);
    return {
      $,
      click: async (id) => {
        await $(id).dispatch('click');
        await settle(40);
      },
    };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('추적 중이면 항상 보이고, 누르면 연동 설정을 열고 기다리는 중이라고 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const solved = await openPopup();
    assert.equal(solved.$('reimport').hidden, false, '풀었어도 보임');
    assert.match(solved.$('reimportHint').textContent, /빠져 있다면/);
    env.api.mode = 'unsolved';
    advance(31 * MIN);
    await refresh();
    const p = await openPopup();
    assert.equal(p.$('reimport').hidden, false);
    assert.match(p.$('reimportHint').textContent, /12시간에 두 번/);
    await p.click('reimportButton');
    assert.ok(env.fake.createdTabs.some((t) => t.url === core.INTEGRATIONS_URL), '연동 설정 탭');
    assert.equal(local().reimportWatch.handle, 'Taeyang');
    assert.match(p.$('reimportHint').textContent, /기다리는 중/);
  });
});

describe('17차 리뷰 회귀 테스트', () => {
  test('06:00 직후 여유 안에 받은 ✓는 잠정이고, 여유 뒤 확인이 429여도 ✓를 보여주지 않는다', async () => {
    await configured('2026-11-22T05:59:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh(); // 어제(21일) 해결
    mock.timers.setTime(at('2026-11-22T06:00:03+09:00'));
    await refresh(); // 서버는 아직 어제의 countedToday를 돌려준다(반영 지연)
    assert.equal(local().snapshot.dayKey, '2026-11-22');
    assert.equal(local().snapshot.provisional, true);
    assert.notEqual(env.fake.badge.text, '✓');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '86400';
    mock.timers.setTime(env.fake.alarms.get('rollover').scheduledTime);
    const before = env.api.calls.length;
    await alarm('rollover');
    assert.equal(env.api.calls.length, before + 1, '여유 뒤 다시 확인');
    assert.notEqual(env.fake.badge.text, '✓');
    assert.equal(created().filter((n) => /풀었/.test(n.title ?? '')).length, 0);
  });

  test('06:00:12에 헤더를 받고 본문이 06:00:16에 끝난 응답도 잠정이며, 06:00:15 확인이 다시 요청한다', async () => {
    await configured('2026-11-22T05:59:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh();
    mock.timers.setTime(at('2026-11-22T06:00:12+09:00'));
    const realFetch = env.api.fetch;
    globalThis.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      const text = await res.text();
      const body = new ReadableStream({
        pull(c) {
          mock.timers.tick(4000);
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
    await refresh();
    globalThis.fetch = realFetch;
    assert.ok(Date.now() >= at('2026-11-22T06:00:16+09:00'), '본문은 여유 뒤에 끝남');
    assert.equal(local().snapshot.provisional, true);
    env.api.mode = 'unsolved';
    const before = env.api.calls.length;
    await alarm('rollover');
    assert.equal(env.api.calls.length, before + 1, '06:00:15 확인이 다시 요청');
    assert.equal(env.fake.badge.text, '!');
    assert.equal(local().snapshot.provisional, undefined);
  });

  test('429 대기 중 06:00 확인 뒤 시계를 06:00 전으로 되돌려도 어제의 ✓로 돌아가지 않는다(팝업 판단 포함)', async () => {
    await configured('2026-11-22T05:35:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh();
    assert.equal(env.fake.badge.text, '✓');
    advance(5 * MIN); // 05:40
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '3600';
    await refresh();
    mock.timers.setTime(env.fake.alarms.get('rollover').scheduledTime);
    await alarm('rollover');
    assert.notEqual(env.fake.badge.text, '✓');
    mock.timers.setTime(at('2026-11-22T05:50:00+09:00')); // 시계를 되돌림
    // 서비스 워커가 알아채기 전에 팝업이 저장소만 읽어도 오늘을 확신하지 않는다.
    assert.equal(core.dayUncertain({ nowMs: Date.now(), localSeenAt: local().localSeenAt }), true);
    const before = env.api.calls.length;
    await popup({ type: 'refresh', force: false });
    assert.equal(env.api.calls.length, before, '대기는 지킨다');
    assert.equal(local().dayEvidenceLost, true);
    assert.notEqual(env.fake.badge.text, '✓');
  });

  test('핸들을 바꾸는 정리 쓰기가 실패해도 다음 확인이 먼저 마치고, 예전 핸들의 "오늘은 그만 알림"을 쓰지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await popup(snoozeMsg('snooze'));
    assert.equal(local().snoozeDayKey, '2026-11-21');
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    let failOnce = true;
    area.set = async (items) => {
      if (failOnce && 'stateHandle' in items) {
        failOnce = false;
        throw new Error('write failed');
      }
      return realSet(items);
    };
    await env.fake.chrome.storage.sync.set({ handle: 'Bobby' });
    await settle();
    area.set = realSet;
    assert.equal(failOnce, false, '정리 쓰기가 한 번 실패함');
    advance(MIN);
    await alarm('poll');
    assert.equal(local().stateHandle, 'Bobby');
    assert.ok(!local().snoozeDayKey, '예전 핸들의 "오늘은 그만 알림"은 지움');
    assert.ok(visible().some((id) => id.endsWith('|Bobby|unsolved')), 'Bobby의 미해결 알림');
  });

  test('핸들 정리를 끝내지 못한 동안에도 배지·알림은 예전 핸들의 기록을 쓰지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await popup(snoozeMsg('snooze'));
    // 다른 핸들의 상태가 남은 채(정리 전) 저장소만 바뀐 상황
    await env.fake.chrome.storage.local.set({ stateHandle: 'Taeyang' });
    env.fake.chrome.storage.sync.data.set('handle', 'Bobby');
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    area.set = async (items) => {
      if ('stateHandle' in items) throw new Error('write failed');
      return realSet(items);
    };
    await alarm('poll'); // 확인은 실패하지만(정리 실패) 배지는 Bobby의 기록 없이 정한다
    area.set = realSet;
    assert.notEqual(env.fake.badge.text, '!', 'Taeyang의 미해결 정보를 Bobby의 것으로 쓰지 않음');
  });

  test('시계 오류로 보여주는 429도 미룬 확인으로 남긴다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '360';
    env.api.serverOffsetMs = 2 * 24 * 60 * MIN;
    await refresh();
    assert.equal(local().lastError.code, 'clock');
    assert.equal(local().retryOwed, true);
  });

  test('띄운 설정 알림이 떠 있는 채 멈춘 뒤 알림 목록을 읽지 못하는 동안 핸들이 바뀌어도, 같은 설정 알림을 또 띄우지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    const realCreate = notifications.create.bind(notifications);
    let captured = null;
    notifications.create = async (id, options) => {
      const r = await realCreate(id, options);
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      return r;
    };
    await alarm('poll');
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: {
          chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } },
          alarms: prev.fake.alarms,
          notifications: prev.fake.notifications, // 화면에 떠 있음
        },
      },
    });
    const n = env.fake.chrome.notifications;
    const realGetAll = n.getAll.bind(n);
    n.getAll = async () => {
      throw new Error('unavailable');
    };
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' });
    await settle();
    assert.equal(visible().length, 1, '띄운 것인지 모르는 알림은 닫지 않음');
    n.getAll = realGetAll;
    await alarm('poll');
    assert.equal(created().length, 0, '다시 띄우지 않음');
    assert.ok(local().notifHistory.setup.includes('setup:credentials'));
  });

  test('시작 처리에서 지우기 기록을 읽지 못해도, 지우기 요청에는 "시작하지 못함"으로 정확히 답한다', async () => {
    await boot({
      time: '2026-11-21T20:00:00+09:00',
      sync: SETTINGS,
      local: { apiCredentials: CREDS, schemaVersion: 2, stateHandle: 'Taeyang' },
      beforeImport: (fake) => {
        const area = fake.chrome.storage.local;
        const realGet = area.get.bind(area);
        area.get = async (keys) => {
          if (keys === 'resetPending') throw new Error('read failed');
          return realGet(keys);
        };
      },
    });
    const r = await popup({ type: 'resetAll' });
    assert.deepEqual([r.ok, r.error], [false, 'reset-not-started']);
    assert.deepEqual(local().apiCredentials, CREDS);
  });

  test('끊긴 지우기가 남아 있을 때 다시 지우면, 그것을 마친 것으로 성공을 알린다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    // 앞선 지우기가 시작 기록만 남기고 멈춘 상태
    await env.fake.chrome.storage.local.set({ resetPending: { sync: { ...sync() } } });
    const r = await popup({ type: 'resetAll' });
    assert.equal(r.ok, true);
    assert.equal(local().apiCredentials, undefined);
    assert.equal(sync().handle, undefined);
    assert.equal(local().resetPending, undefined);
  });

  test('오늘 정보가 없을 때 다시 불러오기를 눌렀다면 첫 응답에서 멈추지 않고, 오늘 푼 것이 보일 때 멈춘다', async () => {
    await configured('2026-11-22T05:50:00+09:00', { sync: { checkIntervalMin: 1440, notifyUnsolved: false } });
    await refresh(); // 21일 정보
    mock.timers.setTime(at('2026-11-22T06:01:00+09:00'));
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    assert.equal(local().reimportWatch.base, null, '어제 정보는 기준으로 쓰지 않음');
    env.api.mode = 'unsolved';
    await refresh();
    let wake = env.fake.alarms.get('wake');
    assert.ok(wake && wake.scheduledTime - Date.now() <= 2 * MIN + 2000, '계속 기다림');
    env.api.mode = 'solved';
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    assert.equal(env.fake.badge.text, '✓');
    wake = env.fake.alarms.get('wake');
    assert.ok(!wake || wake.scheduledTime - Date.now() > 10 * MIN, '오늘 푼 것이 보이면 멈춤');
  });
});

describe('17차 리뷰: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup() {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = (m) => env.fake.sendMessage(structuredClone(m));
    env.fake.chrome.tabs.getCurrent = async () => ({ id: 1 });
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?popup17=${seq}`, import.meta.url));
    await settle(40);
    globalThis.setInterval = realSetInterval;
    const $ = (id) => doc.getElementById(id);
    const form = $('settingsForm');
    return {
      $,
      type: async (id, value) => {
        $(id).value = value;
        await form.dispatch('input', { target: $(id) });
        await $(id).dispatch('input');
      },
      save: async () => {
        await form.dispatch('submit');
        await settle(40);
      },
    };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('저장이 끝난 뒤 화면을 다시 읽지 못해도 "저장하지 못했어요"라고 하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const p = await openPopup();
    await p.type('intervalInput', '33');
    const area = env.fake.chrome.storage.local;
    const realGet = area.get.bind(area);
    const realSend = env.fake.chrome.runtime.sendMessage;
    env.fake.chrome.runtime.sendMessage = async (m) => {
      const r = await realSend(m);
      if (m.type === 'saveSettings') {
        area.get = async () => {
          throw new Error('read failed');
        };
      }
      return r;
    };
    await p.save();
    area.get = realGet;
    env.fake.chrome.runtime.sendMessage = realSend;
    assert.equal(sync().checkIntervalMin, 33);
    assert.match(p.$('saveStatus').textContent, /저장했어요/);
    assert.doesNotMatch(p.$('saveStatus').textContent, /저장하지 못했어요/);
  });

  test('핸들을 바꾼 직후(정리 전)에는 예전 핸들의 "오늘은 그만 알림" 상태를 보여주지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    await popup(snoozeMsg('snooze'));
    env.fake.chrome.storage.sync.data.set('handle', 'Bobby'); // 서비스 워커가 아직 정리하지 않음
    await env.fake.chrome.storage.local.set({ rateLimits: { cid: Date.now() + 60 * MIN } }); // 팝업의 확인이 나가지 않게
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    area.set = async (items) => {
      if ('stateHandle' in items) throw new Error('write failed');
      return realSet(items);
    };
    const p = await openPopup();
    area.set = realSet;
    assert.notEqual(p.$('snoozeButton').textContent, '오늘 알림 다시 켜기');
  });
});

describe('18차 리뷰 회귀 테스트', () => {
  test('서비스 워커가 시작하며 끊긴 지우기를 마무리하는 사이 도착한 지우기는, 다른 기기가 새로 저장한 핸들을 지우지 않는다', async () => {
    let pending = null;
    await boot({
      time: '2026-11-21T20:00:00+09:00',
      sync: { ...SETTINGS, handle: 'Newer' }, // 지우기가 동기화 설정을 지운 뒤 다른 기기가 새로 저장
      local: { apiCredentials: CREDS, schemaVersion: 2, stateHandle: 'Taeyang', resetPending: { phase: 'local' } },
      beforeImport: (fake) => {
        const area = fake.chrome.storage.local;
        const realGet = area.get.bind(area);
        area.get = async (keys) => {
          if (keys === 'resetPending' && !pending) pending = fake.sendMessage({ type: 'resetAll' }); // 시작 처리 도중 도착
          return realGet(keys);
        };
      },
    });
    const r = await pending;
    await settle();
    assert.equal(r.ok, true);
    assert.equal(sync().handle, 'Newer', '새로 저장한 핸들은 남김');
    assert.equal(local().apiCredentials, undefined);
  });

  test('06:00 확인 뒤 시계를 1분 안쪽으로 되돌려 06:00 전으로 가도 어제의 ✓로 돌아가지 않고, 06:00 알람을 다시 건다', async () => {
    await configured('2026-11-22T05:59:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh(); // 21일 해결
    advance(30 * 1000);
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '86400';
    await refresh();
    mock.timers.setTime(env.fake.alarms.get('rollover').scheduledTime);
    await alarm('rollover');
    assert.notEqual(env.fake.badge.text, '✓');
    mock.timers.setTime(at('2026-11-22T05:59:40+09:00')); // 38초 되돌림
    const l = local();
    assert.equal(core.dayUncertain({ nowMs: Date.now(), clockSkewMs: l.clockSkewMs, localSeenAt: l.localSeenAt }), true, '팝업도 확신하지 않음');
    await popup({ type: 'refresh', force: false });
    assert.equal(local().dayEvidenceLost, true);
    assert.notEqual(env.fake.badge.text, '✓');
    assert.equal(env.fake.alarms.get('rollover').scheduledTime, at('2026-11-22T06:00:18+09:00'), '오늘 06:00 확인을 다시 걺');
  });

  test('다른 핸들의 확인 결과로는 다시 불러오기 기다림을 끝내지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440, notifyError: false } });
    await refresh(); // Taeyang 해결
    env.api.mode = 'network';
    await env.fake.chrome.storage.sync.set({ handle: 'Other' });
    await settle(); // Other의 첫 확인은 실패(스냅샷은 Taeyang의 것 그대로)
    assert.equal(local().snapshot.handle, 'Taeyang');
    const r = await popup({ type: 'watchReimport', handle: 'Other' });
    assert.equal(r.ok, true);
    assert.ok(local().reimportWatch, '기다림 유지');
    const wake = env.fake.alarms.get('wake');
    assert.ok(wake && wake.scheduledTime <= local().reimportWatch.until, '기간 안에 다시 확인');
  });

  test('핸들 정리 쓰기가 계속 실패하면 "오늘은 그만 알림"·다시 불러오기를 받았다고 답하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    env.fake.chrome.storage.sync.data.set('handle', 'Bobby'); // 동기화는 Bobby, 로컬 상태는 아직 Taeyang
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    area.set = async (items) => {
      if ('stateHandle' in items) throw new Error('write failed');
      return realSet(items);
    };
    const snooze = await popup({ type: 'snooze', handle: 'Bobby', dayKey: '2026-11-21' });
    const watch = await popup({ type: 'watchReimport', handle: 'Bobby' });
    area.set = realSet;
    assert.equal(snooze.ok, false);
    assert.equal(watch.ok, false);
    // 정리가 되면 받는다
    const ok = await popup({ type: 'watchReimport', handle: 'Bobby' });
    assert.equal(ok.ok, true);
    assert.equal(local().stateHandle, 'Bobby');
    assert.equal(local().reimportWatch.handle, 'Bobby');
  });

  test('시작할 때 핸들 정리 쓰기가 실패해도 알람을 다시 걸고 배지를 맞춘다', async () => {
    await boot({
      time: '2026-11-21T20:00:00+09:00',
      sync: { ...SETTINGS, handle: 'Bobby' },
      local: { apiCredentials: CREDS, schemaVersion: 2, stateHandle: 'Taeyang', snoozeDayKey: '2026-11-21' },
      beforeImport: (fake) => {
        const area = fake.chrome.storage.local;
        const realSet = area.set.bind(area);
        area.set = async (items) => {
          if ('stateHandle' in items) throw new Error('write failed');
          return realSet(items);
        };
      },
    });
    assert.ok(env.fake.alarms.get('poll') && env.fake.alarms.get('rollover'), '알람');
    assert.match(env.fake.badge.title, /Bobby/);
  });

  test('06:00 확인 뒤 날이 바뀐 것만으로는 다시 불러오기 기다림을 끝내지 않고, 어제 기록이 바뀌면 끝내고 지운다', async () => {
    await configured('2026-11-22T05:59:30+09:00', { sync: { checkIntervalMin: 1440, notifyUnsolved: false } });
    env.api.mode = 'unsolved';
    await refresh(); // 21일, 안 풂
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    mock.timers.setTime(env.fake.alarms.get('rollover').scheduledTime);
    await alarm('rollover'); // 22일, 안 풂(겹치는 날의 기록은 그대로)
    assert.equal(local().snapshot.dayKey, '2026-11-22');
    assert.ok(local().reimportWatch, '날이 바뀐 것만으로는 끝내지 않음');
    // 다시 불러오기가 반영되어 21일에 푼 문제가 생김
    const realFetch = env.api.fetch;
    globalThis.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      const body = await res.json();
      body.days = [...body.days, { day: '2026-11-21', solvedCount: 1, maxSolvedLevel: 3, ratingDelta: 0, freezeUsed: false, streakRepaired: false }];
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    };
    const wake = env.fake.alarms.get('wake');
    mock.timers.setTime(wake.scheduledTime);
    await alarm('wake');
    globalThis.fetch = realFetch;
    assert.equal(local().reimportWatch, undefined, '반영되면 끝내고 지움');
  });

  test('다시 불러오기 기간이 지나면 기록을 지운다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440, notifyUnsolved: false } });
    env.api.mode = 'unsolved';
    await refresh();
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    advance(11 * MIN);
    await alarm('poll');
    assert.equal(local().reimportWatch, undefined);
  });

  test('연결 실패는 429로 미룬 확인을 끝내지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '60';
    await refresh();
    assert.equal(local().retryOwed, true);
    advance(2 * MIN);
    env.api.mode = 'network';
    await refresh();
    assert.equal(local().lastError.code, 'network');
    assert.equal(local().retryOwed, true, '응답을 받지 못했으면 남김');
  });

  test('핸들 정리 쓰기가 한 번 실패해도, 이미 확인한 설정 알림을 닫지 않아 다시 띄우지 않는다', async () => {
    await boot({ time: '2026-11-21T20:00:00+09:00', sync: { handle: 'Taeyang' }, local: { schemaVersion: 2, stateHandle: 'Taeyang' } });
    const notifications = env.fake.chrome.notifications;
    const realCreate = notifications.create.bind(notifications);
    let captured = null;
    notifications.create = async (id, options) => {
      const r = await realCreate(id, options);
      captured = new Map([...env.fake.chrome.storage.local.data].map(([k, v]) => [k, structuredClone(v)]));
      return r;
    };
    await alarm('poll');
    const prev = env;
    await boot({
      from: {
        api: prev.api,
        fake: {
          chrome: { storage: { sync: prev.fake.chrome.storage.sync, local: { data: captured } } },
          alarms: prev.fake.alarms,
          notifications: prev.fake.notifications,
        },
      },
    });
    const area = env.fake.chrome.storage.local;
    const realSet = area.set.bind(area);
    let failOnce = true;
    area.set = async (items) => {
      if (failOnce && 'stateHandle' in items) {
        failOnce = false;
        throw new Error('write failed');
      }
      return realSet(items);
    };
    await env.fake.chrome.storage.sync.set({ handle: 'Bob' });
    await settle();
    area.set = realSet;
    assert.equal(failOnce, false);
    await alarm('poll');
    assert.equal(created().length, 0, '다시 띄우지 않음');
    assert.ok(local().notifHistory.setup.includes('setup:credentials'));
  });

  test('내 시계가 1초 빨라도(시계 차이 0으로 잼) 06:00 확인은 서버 시각으로 여유 뒤라 잠정이 아니다', async () => {
    await configured('2026-11-22T05:59:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.serverOffsetMs = -1000;
    await refresh();
    assert.equal(local().clockSkewMs, 0, '허용 범위 안이라 0');
    env.api.mode = 'unsolved';
    mock.timers.setTime(env.fake.alarms.get('rollover').scheduledTime);
    await alarm('rollover');
    assert.equal(local().snapshot.dayKey, '2026-11-22');
    assert.equal(local().snapshot.provisional, undefined);
    assert.equal(env.fake.badge.text, '!');
  });
});

describe('18차 리뷰: 팝업', () => {
  function makeEl(id) {
    const handlers = {};
    const attrs = {};
    const e = {
      id, value: '', checked: false, hidden: false, disabled: false, readOnly: false, textContent: '', title: '',
      type: 'text', placeholder: '', open: false, dataset: {}, children: [], focused: false, attrs,
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      removeAttribute: (k) => { delete attrs[k]; },
      addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
      dispatch: async (type, ev = {}) => {
        for (const fn of handlers[type] ?? []) await fn({ preventDefault() {}, target: e, ...ev });
      },
      focus: () => { e.focused = true; },
      replaceChildren: (...c) => { e.children = c; },
      append: (...c) => { e.children.push(...c); },
    };
    return e;
  }
  let seq = 0;
  async function openPopup({ send = null } = {}) {
    const els = new Map();
    const doc = {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      createElement: () => makeEl(''),
      documentElement: { classList: { toggle() {} } },
    };
    globalThis.document = doc;
    globalThis.window = { close() {} };
    env.fake.chrome.runtime.sendMessage = send ?? ((m) => env.fake.sendMessage(structuredClone(m)));
    env.fake.chrome.tabs.getCurrent = async () => null; // 툴바 팝업
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    seq += 1;
    await import(new URL(`../popup.js?popup18=${seq}`, import.meta.url));
    await settle(40);
    globalThis.setInterval = realSetInterval;
    const $ = (id) => doc.getElementById(id);
    return {
      $,
      click: async (id) => {
        await $(id).dispatch('click');
        await settle(40);
      },
      type: async (id, value) => {
        $(id).value = value;
        await $('settingsForm').dispatch('input', { target: $(id) });
        await $(id).dispatch('input');
      },
    };
  }
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  test('06:00 직후 잠정 정보는 팝업에서도 오늘 푼 문제·오늘 칸으로 보여주지 않는다', async () => {
    await configured('2026-11-22T05:59:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh();
    mock.timers.setTime(at('2026-11-22T06:00:03+09:00'));
    await refresh(); // 잠정
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '7200';
    mock.timers.setTime(env.fake.alarms.get('rollover').scheduledTime);
    await alarm('rollover');
    const p = await openPopup();
    assert.equal(p.$('todaySolved').textContent, '-');
    assert.ok(!p.$('recent').children.some((li) => li.dataset?.today === 'true'), '오늘 칸 강조 없음');
  });

  test('다른 확인이 진행 중이어도 다시 불러오기 탭은 바로 연다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    let release;
    const hold = new Promise((r) => {
      release = r;
    });
    const p = await openPopup({
      send: async (m) => {
        if (m.type === 'watchReimport') await hold; // 서비스 워커가 다른 확인으로 바쁨
        return env.fake.sendMessage(structuredClone(m));
      },
    });
    await p.click('reimportButton');
    assert.ok(env.fake.createdTabs.some((t) => t.url === core.INTEGRATIONS_URL), '응답 전에 탭을 엶');
    release();
    await settle(40);
    assert.ok(local().reimportWatch, '기다리는 기간은 서비스 워커가 적음');
  });

  test('백오프 중에는 실제로 확인할 수 있는 때부터 2분마다라고 안내하고, 어느 계정으로 불러올지 알려준다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    const before = await openPopup();
    assert.match(before.$('reimportHint').textContent, /Taeyang 계정으로/);
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '60';
    await refresh(); // 429 뒤에는 재시도 간격(5분) 안에서 확인하지 않는다
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    const p = await openPopup();
    const hint = p.$('reimportHint').textContent;
    const l = local();
    const notBefore = core.reimportNotBefore({
      settings: core.effectiveSettings(sync()),
      handle: 'Taeyang',
      snapshot: l.snapshot,
      lastError: l.lastError,
      backoffUntil: l.backoffUntil,
      rateLimitedUntil: core.activeRateLimit(l.rateLimits, 'cid', Date.now()),
      lastAttemptAt: l.lastAttemptAt,
      nowMs: Date.now(),
    });
    assert.ok(notBefore > Date.now() + 2 * MIN, '2분보다 늦게 확인할 수 있음');
    assert.ok(hint.includes(`${core.formatClock(notBefore)}부터`), hint);
  });

  test('확인 기간 안에 확인할 수 없으면(긴 백오프) 기다린다고 안내하지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    env.api.mode = 'blocked';
    await refresh(); // 15분 백오프 > 10분 기간
    await popup({ type: 'watchReimport', handle: 'Taeyang' });
    const p = await openPopup();
    assert.doesNotMatch(p.$('reimportHint').textContent, /기다리는 중/);
  });

  test('다 지운 뒤 화면을 다시 읽지 못해도 지웠다고 알리고 입력 칸의 키를 비운다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    const p = await openPopup();
    await p.type('clientSecretInput', 'typed-secret');
    const area = env.fake.chrome.storage.local;
    const realGet = area.get.bind(area);
    const realSend = env.fake.chrome.runtime.sendMessage;
    env.fake.chrome.runtime.sendMessage = async (m) => {
      const r = await realSend(m);
      if (m.type === 'resetAll') {
        area.get = async () => {
          throw new Error('read failed');
        };
      }
      return r;
    };
    await p.click('resetButton');
    await p.click('resetConfirmButton');
    area.get = realGet;
    env.fake.chrome.runtime.sendMessage = realSend;
    assert.equal(local().apiCredentials, undefined);
    assert.equal(p.$('clientSecretInput').value, '');
    assert.match(p.$('saveStatus').textContent, /모든 데이터를 지웠어요/);
  });
});

describe('19차 리뷰 회귀 테스트', () => {
  test('크기 제한을 넘은 응답은 429로 미룬 확인을 끝내지 않는다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'rate-limited';
    env.api.retryAfter = '60';
    await refresh();
    assert.equal(local().retryOwed, true);
    advance(2 * MIN);
    const realFetch = env.api.fetch;
    globalThis.fetch = async () =>
      new Response('x'.repeat(256 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } });
    await refresh();
    globalThis.fetch = realFetch;
    assert.equal(local().lastError.code, 'parse');
    assert.equal(local().retryOwed, true);
  });

  test('정리하지 못한 v1 알람이 울려도 확인하지 않고 지운다', async () => {
    await configured('2026-11-21T20:00:00+09:00', { sync: { checkIntervalMin: 1440 } });
    await refresh();
    env.fake.alarms.set('solvedacStreakCheckAlarm', { name: 'solvedacStreakCheckAlarm', scheduledTime: Date.now(), periodInMinutes: 1 });
    const before = env.api.calls.length;
    advance(31 * MIN);
    await alarm('solvedacStreakCheckAlarm');
    assert.equal(env.api.calls.length, before, '요청하지 않음');
    assert.equal(env.fake.alarms.has('solvedacStreakCheckAlarm'), false, '지움');
  });

  test('v1 알람 정리가 실패하면 다음 시작 때 다시 정리한다', async () => {
    await boot({
      time: '2026-11-21T20:00:00+09:00',
      sync: SETTINGS,
      local: { apiCredentials: CREDS },
      beforeImport: (fake) => {
        const realClear = fake.chrome.alarms.clear.bind(fake.chrome.alarms);
        fake.chrome.alarms.clear = async (name) => {
          if (name === 'solvedacStreakCheckAlarm') throw new Error('busy');
          return realClear(name);
        };
      },
    });
    assert.notEqual(local().schemaVersion, 2, '다음에 다시 시도하도록 남김');
  });

  test('끊긴 지우기를 마무리한 뒤 저장이 있었다면, 그 뒤의 지우기 요청은 새로 지운다', async () => {
    const sent = [];
    await boot({
      time: '2026-11-21T20:00:00+09:00',
      sync: SETTINGS,
      local: { apiCredentials: CREDS, schemaVersion: 2, stateHandle: 'Taeyang', resetPending: { phase: 'local' } },
      beforeImport: (fake) => {
        const area = fake.chrome.storage.local;
        const realGet = area.get.bind(area);
        area.get = async (keys) => {
          if (keys === 'resetPending' && !sent.length) {
            // 시작 처리 도중 다른 페이지의 저장과 지우기가 차례로 도착
            sent.push(
              fake.sendMessage({
                type: 'saveSettings',
                settings: {},
                credentials: CREDS2,
                base: { handle: 'Taeyang', clientId: '' },
              }),
            );
            sent.push(fake.sendMessage({ type: 'resetAll' }));
          }
          return realGet(keys);
        };
      },
    });
    const [save, reset] = await Promise.all(sent);
    await settle();
    assert.equal(save.ok, true, '저장은 됨');
    assert.equal(reset.ok, true);
    assert.equal(local().apiCredentials, undefined, '저장 뒤의 지우기는 새로 지움');
    assert.equal(sync().handle, undefined);
  });

  test('알림의 "오늘은 그만 알림"은 상태를 맞춘 핸들의 알림에만 적용한다', async () => {
    await configured('2026-11-21T20:00:00+09:00');
    env.api.mode = 'unsolved';
    await refresh();
    const id = visible().find((v) => v.endsWith('|Taeyang|unsolved'));
    assert.ok(id);
    env.fake.chrome.storage.sync.data.set('handle', 'Bobby'); // 다른 기기에서 핸들이 바뀜(아직 정리 전)
    await event('notifications.onButtonClicked', id, 1);
    assert.equal(local().stateHandle, 'Bobby');
    assert.ok(!local().snoozeDayKey, 'Taeyang의 알림으로 Bobby를 끄지 않음');
  });
});
