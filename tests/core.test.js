import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as core from '../lib/core.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fixture(name));
const at = (iso) => Date.parse(iso);
const MIN = 60 * 1000;

const SETTINGS = core.normalizeSettings({ handle: 'Taeyang', notifyStartHours: 24 });

describe('solved.ac 날짜 계산 (06:00 KST 경계)', () => {
  test('06:00 KST 이전은 전날', () => {
    assert.equal(core.solvedDayKey(at('2026-11-21T05:59:59+09:00')), '2026-11-20');
    assert.equal(core.solvedDayKey(at('2026-11-21T00:05:00+09:00')), '2026-11-20');
  });
  test('06:00 KST 정각부터 새 날', () => {
    assert.equal(core.solvedDayKey(at('2026-11-21T06:00:00+09:00')), '2026-11-21');
    assert.equal(core.solvedDayKey(at('2026-11-21T23:59:59+09:00')), '2026-11-21');
  });
  test('연말/윤년 경계', () => {
    assert.equal(core.solvedDayKey(at('2027-01-01T05:00:00+09:00')), '2026-12-31');
    assert.equal(core.solvedDayKey(at('2028-03-01T03:00:00+09:00')), '2028-02-29');
  });
  test('다음 하루 경계는 항상 미래의 06:00 KST', () => {
    assert.equal(core.nextDayBoundary(at('2026-11-21T00:05:00+09:00')), at('2026-11-21T06:00:00+09:00'));
    assert.equal(core.nextDayBoundary(at('2026-11-21T05:59:59.999+09:00')), at('2026-11-21T06:00:00+09:00'));
    assert.equal(core.nextDayBoundary(at('2026-11-21T06:00:00+09:00')), at('2026-11-22T06:00:00+09:00'));
    assert.equal(core.nextDayBoundary(at('2026-11-21T18:30:00+09:00')), at('2026-11-22T06:00:00+09:00'));
  });
  test('경계 직후에 계산해도 오늘의 06:00:15 알람을 내일로 미루지 않는다', () => {
    const d = 15 * 1000;
    assert.equal(core.nextRolloverAt(at('2026-11-21T06:00:05+09:00'), d), at('2026-11-21T06:00:15+09:00'));
    assert.equal(core.nextRolloverAt(at('2026-11-21T05:00:00+09:00'), d), at('2026-11-21T06:00:15+09:00'));
    assert.equal(core.nextRolloverAt(at('2026-11-21T06:00:15+09:00'), d), at('2026-11-22T06:00:15+09:00'));
    assert.equal(core.nextRolloverAt(at('2026-11-21T12:00:00+09:00'), d), at('2026-11-22T06:00:15+09:00'));
  });
  test('addDays / isDayString', () => {
    assert.equal(core.addDays('2026-11-21', -6), '2026-11-15');
    assert.equal(core.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(core.addDays('2026-12-31', 1), '2027-01-01');
    assert.ok(core.isDayString('2028-02-29'));
    for (const bad of ['2026-13-15', '2026-02-30', '2026-1-1', '', null, 20261121]) {
      assert.ok(!core.isDayString(bad), String(bad));
    }
  });
});

describe('시계 보정', () => {
  test('Date 헤더가 요청~응답 사이(±1초)면 시계는 맞다', () => {
    const sent = at('2026-11-20T15:05:45.200Z');
    assert.equal(core.computeClockSkew('Fri, 20 Nov 2026 15:05:45 GMT', sent, sent + 300), 0);
    assert.equal(core.computeClockSkew('Fri, 20 Nov 2026 15:05:44 GMT', sent, sent + 300), 0, 'Date는 초 단위로 잘림');
  });
  test('느린 응답의 전송 시간을 시계 차이로 착각하지 않는다', () => {
    // 05:59:57에 보내고, 서버는 05:59:58에 응답을 만들고, 헤더는 06:00:03에 도착
    const sent = at('2026-11-21T05:59:57+09:00');
    assert.equal(core.computeClockSkew('Fri, 20 Nov 2026 20:59:58 GMT', sent, at('2026-11-21T06:00:03+09:00')), 0);
  });
  test('실제로 시계가 틀렸으면 차이를 잰다', () => {
    const sent = at('2026-11-20T15:05:46Z');
    const skew = core.computeClockSkew('Fri, 20 Nov 2026 15:15:46 GMT', sent, sent + 200);
    assert.ok(Math.abs(skew - 10 * MIN) < 1000, String(skew));
    assert.equal(core.computeClockSkew('garbage', sent), null);
    assert.equal(core.computeClockSkew(null, sent), null);
    assert.equal(core.computeClockSkew('Fri, 01 Jan 2027 00:00:00 GMT', sent), null, '하루 넘게 차이 나면 신뢰하지 않음');
  });
  test('effectiveNow는 이상한 값을 무시한다', () => {
    assert.equal(core.effectiveNow(1000, 500), 1500);
    assert.equal(core.effectiveNow(1000, undefined), 1000);
    assert.equal(core.effectiveNow(1000, Number.NaN), 1000);
    assert.equal(core.effectiveNow(1000, 2 * core.DAY_MS), 1000);
  });
});

describe('핸들 입력 정규화', () => {
  const ok = (input, handle) => assert.deepEqual(core.normalizeHandleInput(input), { ok: true, handle });
  test('핸들, @핸들, 공백', () => {
    ok('Taeyang', 'Taeyang');
    ok('  @Taeyang  ', 'Taeyang');
    ok('taeyang_95', 'taeyang_95');
  });
  test('프로필 주소를 붙여넣어도 된다', () => {
    ok('https://solved.ac/u/Taeyang', 'Taeyang');
    ok('https://solved.ac/ko/u/Taeyang', 'Taeyang');
    ok('solved.ac/en/u/Taeyang?tab=activity', 'Taeyang');
    ok('https://solved.ac/profile/Taeyang', 'Taeyang');
    ok('http://www.solved.ac/u/Taeyang/', 'Taeyang');
  });
  test('잘못된 입력', () => {
    assert.deepEqual(core.normalizeHandleInput(''), { ok: false, reason: 'empty' });
    assert.deepEqual(core.normalizeHandleInput('   '), { ok: false, reason: 'empty' });
    assert.deepEqual(core.normalizeHandleInput(null), { ok: false, reason: 'empty' });
    for (const bad of ['a b', '../etc', '한글', 'https://example.com/u/Taeyang', 'x'.repeat(65), 'https://solved.ac/u/%E0%A4%A']) {
      assert.equal(core.normalizeHandleInput(bad).ok, false, bad);
    }
  });
});

describe('API 자격 증명', () => {
  test('형식 검사', () => {
    assert.ok(core.isValidCredential('abc_123-XYZ.='));
    for (const bad of ['', ' a', 'a b', 'a\nb', 'x'.repeat(513), null, 1]) assert.ok(!core.isValidCredential(bad), String(bad));
  });
  test('정규화 / 준비 여부 / 헤더', () => {
    assert.deepEqual(core.normalizeCredentials(undefined), { clientId: '', clientSecret: '' });
    assert.deepEqual(core.normalizeCredentials({ clientId: 'id', clientSecret: 'bad secret' }), { clientId: 'id', clientSecret: '' });
    assert.equal(core.hasCredentials({ clientId: 'id', clientSecret: '' }), false);
    assert.equal(core.hasCredentials({ clientId: 'id', clientSecret: 's3' }), true);
    assert.deepEqual(core.credentialHeaders({ clientId: 'id', clientSecret: 's3' }), { 'x-client-id': 'id', 'x-client-secret': 's3' });
  });
});

describe('API 경로', () => {
  test('요청한 날 포함 7일', () => {
    assert.equal(core.activityPath('Taeyang', '2026-11-20'), '/api/v4/users/Taeyang/activity/days?from=2026-11-14&to=2026-11-20');
  });
  test('프로필 주소', () => {
    assert.equal(core.profileUrl('Taeyang'), 'https://solved.ac/u/Taeyang');
  });
});

describe('설정', () => {
  test('기본값', () => {
    assert.deepEqual(core.normalizeSettings(undefined), { ...core.DEFAULT_SETTINGS });
  });
  test('범위를 벗어난 값은 보정한다', () => {
    const s = core.normalizeSettings({
      handle: 'bad handle',
      checkIntervalMin: 0,
      notifyUnsolved: 'yes',
      notifyStartHours: 7,
      remindIntervalMin: '30',
      notifyError: false,
    });
    assert.deepEqual(s, {
      handle: '',
      checkIntervalMin: 1,
      notifyUnsolved: true,
      notifyStartHours: 12,
      remindIntervalMin: 30,
      notifyError: false,
    });
    assert.equal(core.normalizeSettings({ checkIntervalMin: 99999 }).checkIntervalMin, 1440);
    assert.equal(core.normalizeSettings({ checkIntervalMin: '15' }).checkIntervalMin, 15);
    assert.equal(core.normalizeSettings({ checkIntervalMin: 'abc' }).checkIntervalMin, 5);
  });
  test('v1 설정 마이그레이션: 알림/주기만 옮기고 v1 키는 남긴다', () => {
    const v1 = { targetUsername: 'taeyang95', alarmInterval: 1, notifyOnNotSolved: false, notifyOnUnknown: true };
    assert.deepEqual(core.migrateLegacySettings(v1), { checkIntervalMin: 1, notifyUnsolved: false, notifyError: true });
    assert.deepEqual(core.migrateLegacySettings({ ...v1, checkIntervalMin: 9, notifyError: false }), { notifyUnsolved: false },
      '이미 v2 값이 있으면 덮어쓰지 않음');
    assert.deepEqual(core.migrateLegacySettings({ handle: 'x' }), {});
    assert.deepEqual(core.migrateLegacySettings(null), {});
  });
  test('실제로 쓸 설정: v2 값이 없으면 v1 값(늦게 동기화된 v1 설정도 바로 따른다)', () => {
    assert.equal(core.effectiveSettings({ notifyOnUnknown: false }).notifyError, false);
    assert.equal(core.effectiveSettings({ notifyOnUnknown: false, notifyError: true }).notifyError, true);
    assert.equal(core.effectiveSettings({ alarmInterval: 7 }).checkIntervalMin, 7);
    assert.deepEqual(core.effectiveSettings(undefined), core.normalizeSettings({}));
  });
  test('예전 아이디는 v2 핸들이 없을 때만 확인용 제안값', () => {
    assert.equal(core.legacyHandleFrom({ targetUsername: 'taeyang95' }), 'taeyang95');
    assert.equal(core.legacyHandleFrom({ targetUsername: 'taeyang95', handle: 'Taeyang' }), null);
    assert.equal(core.legacyHandleFrom({ targetUsername: 'bad name' }), null);
    assert.equal(core.legacyHandleFrom({}), null);
    assert.equal(core.legacyHandleFrom(undefined), null);
  });
  test('API 키 없이 저장할 수 있는 설정 키', () => {
    assert.deepEqual(core.PREFERENCE_KEYS, ['checkIntervalMin', 'notifyUnsolved', 'notifyStartHours', 'remindIntervalMin', 'notifyError']);
  });
});

describe('응답 해석', () => {
  const ok = (body, extra = {}) => ({ status: 200, contentType: 'application/json', bodyText: body, ...extra });
  const jsonErr = (status, code) => ({
    status,
    contentType: 'application/json',
    bodyText: JSON.stringify({ error: { code, message: 'x' } }),
  });

  test('정상 응답 (실제 응답 형식)', () => {
    const r = core.classifyResponse(ok(fixture('activity-solved.json')));
    assert.equal(r.ok, true);
    assert.equal(r.data.currentStreak, 1183);
    assert.equal(r.data.maxStreak, 1183);
    assert.equal(r.data.countedToday, true);
    assert.equal(r.data.vacation, null);
    assert.equal(r.data.days.length, 1);
  });
  test('휴가 응답', () => {
    const r = core.classifyResponse(ok(fixture('activity-vacation.json')));
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.vacation, { fromDay: '2026-04-14' });
  });
  test('없는 사용자', () => {
    const r = core.classifyResponse({ status: 404, contentType: 'application/json', bodyText: fixture('not-found.json') });
    assert.deepEqual(r, { ok: false, code: 'not-found', httpStatus: 404, serverCode: 'NOT_FOUND' });
  });
  test('라우팅 404(text/plain)는 사용자 없음이 아니다', () => {
    const r = core.classifyResponse({ status: 404, contentType: 'text/plain; charset=UTF-8', bodyText: '404 Not Found' });
    assert.equal(r.code, 'http');
  });
  test('앱 자격 증명 없음/틀림 → auth', () => {
    assert.deepEqual(core.classifyResponse(jsonErr(401, 'MISSING_CLIENT_CREDENTIALS')), {
      ok: false,
      code: 'auth',
      httpStatus: 401,
      serverCode: 'MISSING_CLIENT_CREDENTIALS',
    });
    assert.equal(core.classifyResponse(jsonErr(401, 'UNAUTHENTICATED')).code, 'auth');
    assert.equal(core.classifyResponse(jsonErr(403, 'FORBIDDEN')).code, 'auth');
  });
  test('Cloudflare 보안 확인', () => {
    const html = fixture('challenge.html');
    assert.equal(core.classifyResponse({ status: 403, contentType: 'text/html', cfMitigated: 'challenge', bodyText: html }).code, 'blocked');
    assert.equal(core.classifyResponse({ status: 403, contentType: 'text/html', bodyText: html }).code, 'blocked');
    assert.equal(core.classifyResponse({ status: 503, contentType: 'text/html', bodyText: html }).code, 'blocked');
    assert.equal(core.classifyResponse({ status: 403, contentType: 'text/html', bodyText: 'error code: 1020' }).code, 'blocked');
    assert.equal(core.classifyResponse({ status: 503, contentType: 'text/html', bodyText: 'maintenance' }).code, 'http');
  });
  test('06:00 KST를 걸친 응답 판별 (수신 시각 + 서버 Date 헤더)', () => {
    const day = '2026-11-20';
    assert.equal(core.responseDayChanged(day, 'Fri, 20 Nov 2026 20:59:59 GMT', at('2026-11-21T05:59:59.500+09:00')), false);
    assert.equal(core.responseDayChanged(day, null, at('2026-11-21T06:00:01+09:00')), true, '수신이 새 날');
    assert.equal(core.responseDayChanged(day, 'Fri, 20 Nov 2026 21:00:01 GMT', at('2026-11-21T05:59:59+09:00')), true, '서버는 이미 새 날');
    assert.equal(core.responseDayChanged(day, 'garbage', at('2026-11-21T05:00:00+09:00')), false);
    assert.equal(core.responseDayChanged(day, null, at('2026-11-21T05:59:59+09:00'), at('2026-11-21T06:00:02+09:00')), true,
      '시계 추정치 중 하나라도 새 날이면 다시 확인');
  });
  test('요청 제한', () => {
    assert.deepEqual(core.classifyResponse({ status: 429, retryAfter: '120' }), {
      ok: false,
      code: 'rate-limited',
      httpStatus: 429,
      retryAfterSec: 120,
    });
    assert.deepEqual(core.classifyResponse({ status: 429 }), { ok: false, code: 'rate-limited', httpStatus: 429 });
  });
  test('서버 오류 / 형식 오류 / 잘린 응답', () => {
    assert.equal(core.classifyResponse({ status: 500, contentType: 'application/json', bodyText: '{}' }).code, 'http');
    assert.equal(core.classifyResponse(jsonErr(400, 'VALIDATION_FAILED')).code, 'rejected', '되풀이해도 같은 4xx는 거절');
    assert.equal(core.classifyResponse(jsonErr(422, 'X')).code, 'rejected');
    assert.equal(core.classifyResponse({ status: 408, contentType: 'text/plain', bodyText: '' }).code, 'http', '408은 일시 오류');
    assert.equal(core.classifyResponse(ok('not json')).code, 'parse');
    assert.equal(core.classifyResponse(ok('{"currentStreak":"1"}')).code, 'parse');
    assert.equal(core.classifyResponse(ok(fixture('activity-solved.json'), { truncated: true })).code, 'parse');
    assert.equal(core.classifyResponse({ status: 200, contentType: 'text/html', bodyText: '<html>' }).code, 'parse');
    assert.equal(core.classifyResponse(undefined).code, 'http');
  });
  test('parseActivity 필드 검증', () => {
    const base = json('activity-unsolved.json');
    assert.ok(core.parseActivity(base));
    assert.equal(core.parseActivity({ ...base, currentStreak: -1 }), null);
    assert.equal(core.parseActivity({ ...base, countedToday: 'false' }), null);
    assert.equal(core.parseActivity({ ...base, vacation: { fromDay: 'soon' } }), null);
    assert.equal(core.parseActivity({ ...base, vacation: { fromDay: '2026-13-15' } }), null, '존재하지 않는 날짜');
    assert.equal(core.parseActivity({ ...base, days: 'x' }), null);
    // 문서상 필수인 필드가 빠진 '일부 응답'으로 정보를 지어내지 않는다
    for (const key of ['days', 'vacation', 'frozenYesterday', 'countedToday', 'currentStreak', 'maxStreak']) {
      const partial = { ...base };
      delete partial[key];
      assert.equal(core.parseActivity(partial), null, `${key} 없음`);
    }
    const row = { day: '2026-11-20', solvedCount: 3, maxSolvedLevel: 1, ratingDelta: 0, freezeUsed: false, streakRepaired: false };
    assert.equal(core.parseActivity({ ...base, days: [row] }).days.length, 1);
    for (const bad of [{ ...row, day: '2026-02-30' }, { ...row, solvedCount: -1 }, { ...row, freezeUsed: 'no' }, null]) {
      assert.equal(core.parseActivity({ ...base, days: [row, bad] }), null, JSON.stringify(bad));
    }
    // maxStreak가 currentStreak보다 작게 와도 최소한 currentStreak
    assert.equal(core.parseActivity({ ...base, maxStreak: 1, currentStreak: 5 }).maxStreak, 5);
  });
  test('Retry-After 파싱 (최대 7일)', () => {
    const now = at('2026-11-20T00:00:00Z');
    assert.equal(core.parseRetryAfter('30', now), 30);
    assert.equal(core.parseRetryAfter('Fri, 20 Nov 2026 00:01:00 GMT', now), 60);
    assert.equal(core.parseRetryAfter('Thu, 19 Nov 2026 00:00:00 GMT', now), 0);
    assert.equal(core.parseRetryAfter('soon', now), null);
    assert.equal(core.parseRetryAfter(null, now), null);
    assert.equal(core.parseRetryAfter('172800', now), 172800, '하루가 넘는 대기도 지킨다');
    assert.equal(core.parseRetryAfter('1.5', now), 2, '소수 초는 올림');
    assert.equal(core.parseRetryAfter('999999999', now), 7 * 86400);
  });
  test('429의 날짜형 Retry-After는 서버 Date 기준', () => {
    const r = core.classifyResponse(
      { status: 429, retryAfter: 'Fri, 20 Nov 2026 00:10:00 GMT', date: 'Fri, 20 Nov 2026 00:00:00 GMT' },
      at('2026-11-20T00:09:00Z'), // 내 시계는 9분 빠름
    );
    assert.equal(r.retryAfterSec, 600);
  });
  test('본문을 읽다 실패한 429도 대기 정보를 잃지 않는다', () => {
    const r = core.classifyResponse({ status: 429, retryAfter: '3600', bodyText: '', bodyError: true });
    assert.deepEqual([r.code, r.retryAfterSec], ['rate-limited', 3600]);
    assert.equal(core.classifyResponse({ status: 200, contentType: 'application/json', bodyText: '', bodyError: true }).code, 'network',
      '본문을 받다 끊긴 200은 일시적인 연결 문제');
  });
  test('챌린지 표시가 붙은 429도 요청 제한으로 보고 Retry-After를 지킨다', () => {
    const r = core.classifyResponse({ status: 429, contentType: 'text/html', cfMitigated: 'challenge', retryAfter: '120', bodyText: 'Just a moment' });
    assert.deepEqual([r.code, r.retryAfterSec], ['rate-limited', 120]);
  });
});

describe('스냅샷', () => {
  test('요청한 날 기준으로 최근 7일을 빈 날 포함해 채운다', () => {
    const data = core.parseActivity(json('activity-unsolved.json'));
    const snap = core.buildSnapshot('Taeyang', data, '2026-11-21', at('2026-11-21T20:00:00+09:00'));
    assert.equal(snap.dayKey, '2026-11-21');
    assert.deepEqual(
      snap.recent.map((d) => d.day),
      ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'],
    );
    assert.equal(snap.recent[3].solvedCount, 2);
    assert.equal(snap.recent[4].freezeUsed, true);
    assert.equal(snap.todaySolvedCount, 0);
  });
});

describe('재시도 / 확인 간격', () => {
  test('백오프 (보안 확인/인증 오류는 같은 원인이 이어질 때 늘어난다)', () => {
    assert.equal(core.backoffMsFor('rate-limited', 3), 0, '429는 클라이언트 단위 rateLimit으로 따로 관리');
    assert.equal(core.rateLimitUntil(120, 1000), 1000 + 120 * 1000);
    assert.equal(core.rateLimitUntil(undefined, 1000), 1000 + core.DEFAULT_RATE_LIMIT_BACKOFF_MS);
    assert.equal(core.activeRateLimit({ a: 2000 }, 'a', 1000), 2000);
    assert.equal(core.activeRateLimit({ a: 2000 }, 'b', 1000), null, '다른 앱이면 무관');
    assert.equal(core.activeRateLimit({ a: 2000 }, 'a', 2000), null);
    assert.equal(core.activeRateLimit(undefined, 'a', 0), null);
    assert.deepEqual(core.withRateLimit({ a: 500, b: 3000 }, 'c', 2000, 1000), { b: 3000, c: 2000 }, '끝난 항목은 정리');
    assert.deepEqual(core.withRateLimit({ c: 5000 }, 'c', 2000, 1000), { c: 5000 }, '더 긴 대기는 유지');
    const weird = core.withRateLimit({}, '__proto__', 2000, 1000);
    assert.equal(core.activeRateLimit(weird, '__proto__', 1000), 2000, '특이한 클라이언트 ID도 기록');
    assert.equal(core.activeRateLimit({}, 'constructor', 1000), null);
  });
  test('연속 실패는 8분 넘는 공백(절전 등) 뒤에 새로 센다', () => {
    const t0 = at('2026-11-21T20:00:00+09:00');
    assert.equal(core.STREAK_RESET_GAP_MS < core.TRANSIENT_ERROR_GRACE_MS, true);
    assert.deepEqual(
      core.nextFailureStreak({ consecutiveFailures: 1, failingSince: t0 - 12 * MIN, lastAttemptAt: t0 - 12 * MIN, receivedAt: t0, at: t0 }),
      { consecutiveFailures: 1, failingSince: t0 },
      '12분 절전',
    );
  });
  test('서버가 정한 대기(Retry-After) 끝에 맞춰 다시 실패하면 연속 실패로 센다', () => {
    const t0 = at('2026-11-21T20:00:00+09:00');
    assert.deepEqual(
      core.nextFailureStreak({ consecutiveFailures: 1, failingSince: t0 - 9 * MIN, lastAttemptAt: t0 - 9 * MIN, expectedRetryAt: t0, receivedAt: t0 + 20 * 1000, at: t0 }),
      { consecutiveFailures: 2, failingSince: t0 - 9 * MIN },
      '9분 대기 뒤 제때 재시도',
    );
    assert.deepEqual(
      core.nextFailureStreak({ consecutiveFailures: 2, failingSince: t0 - 9 * MIN, lastAttemptAt: t0 - 9 * MIN, expectedRetryAt: t0 - 4 * MIN, receivedAt: t0, at: t0 }),
      { consecutiveFailures: 1, failingSince: t0 },
      '예정보다 4분 늦음 = 그 사이 절전',
    );
    const settings = { ...SETTINGS, checkIntervalMin: 1440 };
    assert.equal(core.expectedRetryAfterFailure({ settings, receivedAt: t0, backoffUntil: null, rateLimitedUntil: t0 + 9 * MIN }), t0 + 9 * MIN);
    assert.equal(core.expectedRetryAfterFailure({ settings, receivedAt: t0, backoffUntil: null, rateLimitedUntil: null }), t0 + 5 * MIN);
  });
  test('긴 공백 경계', () => {
    const t = at('2026-11-21T20:00:00+09:00');
    assert.deepEqual(core.nextFailureStreak({ consecutiveFailures: 0, failingSince: null, lastAttemptAt: t - MIN, receivedAt: t, at: t }),
      { consecutiveFailures: 1, failingSince: t });
    assert.deepEqual(core.nextFailureStreak({ consecutiveFailures: 1, failingSince: t - 5 * MIN, lastAttemptAt: t - 5 * MIN, receivedAt: t, at: t }),
      { consecutiveFailures: 2, failingSince: t - 5 * MIN });
    assert.deepEqual(core.nextFailureStreak({ consecutiveFailures: 1, failingSince: t - 3 * 60 * MIN, lastAttemptAt: t - 3 * 60 * MIN, receivedAt: t, at: t }),
      { consecutiveFailures: 1, failingSince: t }, '절전 전 1번 + 깬 뒤 1번은 새 연속');
    assert.equal(core.backoffMsFor('blocked', 1), 15 * MIN);
    assert.equal(core.backoffMsFor('blocked', 2), 30 * MIN);
    assert.equal(core.backoffMsFor('auth', 3), 60 * MIN);
    assert.equal(core.backoffMsFor('auth', 10), 60 * MIN, '최대 60분');
    assert.equal(core.backoffMsFor('network', 5), 0);
    assert.equal(core.backoffMsFor('not-found', 5), 0);
  });

  const now = at('2026-11-21T20:00:00+09:00');
  const snapAt = (fetchedAt, extra = {}) => ({ handle: 'T', dayKey: '2026-11-21', fetchedAt, countedToday: false, vacation: null, ...extra });
  const skip = (over) =>
    core.shouldSkipRefresh({
      policy: 'auto', handle: 'T', snapshot: null, lastError: null, backoffUntil: null, rateLimitedUntil: null,
      lastAttemptAt: null, nowMs: now, eNowMs: now, ...over,
    });

  test('시계가 뒤로 가서 미래 시각인 정보/시도는 간격 제한에 쓰지 않는다', () => {
    assert.equal(skip({ snapshot: snapAt(now + 10 * MIN) }), false);
    assert.equal(skip({ snapshot: snapAt(now + 1000) }), false, '1초라도 미래면 다시 확인');
    const lastError = { handle: 'T', code: 'network', at: now };
    assert.equal(skip({ lastError, lastAttemptAt: now + 60 * MIN }), false, '마지막 시도가 미래 시각이어도 막지 않음');
  });
  test('알림 ID에 원인·날짜·핸들을 담는다', () => {
    const id = core.makeNotificationId({ cause: 'error:auth', dayKey: '2026-11-21', handle: 'Taeyang', seq: 'abc' });
    assert.deepEqual(core.parseNotificationId(id), { kind: 'error', cause: 'error:auth', dayKey: '2026-11-21', handle: 'Taeyang' });
    assert.deepEqual(core.parseNotificationId(core.makeNotificationId({ cause: 'unsolved', dayKey: '2026-11-21', handle: '', seq: 1 })),
      { kind: 'unsolved', cause: 'unsolved', dayKey: '2026-11-21', handle: '' });
    assert.equal(core.parseNotificationId('streak-reminder'), null);
    assert.ok(core.isOwnNotificationId('streak-reminder'), '예전 버전 ID도 정리 대상');
    assert.ok(!core.isOwnNotificationId('other'));
  });
  test('시계가 하루 넘게 틀렸는지', () => {
    const t = at('2026-11-21T20:00:00+09:00');
    assert.equal(core.clockTooFarOff('Tue, 24 Nov 2026 11:00:00 GMT', t), true);
    assert.equal(core.clockTooFarOff('Sat, 21 Nov 2026 13:00:00 GMT', t), false);
    assert.equal(core.clockTooFarOff(null, t), false);
  });
  test('force는 간격 제한/보안 확인 백오프를 무시하지만 429 Retry-After는 지킨다', () => {
    assert.equal(skip({ policy: 'force', backoffUntil: now + MIN, snapshot: snapAt(now - 1000) }), false);
    assert.equal(skip({ policy: 'force', rateLimitedUntil: now + MIN }), true);
    assert.equal(skip({ policy: 'auto', rateLimitedUntil: now + MIN, snapshot: { ...snapAt(now - 1000), handle: 'other' } }), true,
      '핸들이 바뀌어도 같은 앱이면 기다린다');
    assert.equal(skip({ policy: 'force', rateLimitedUntil: now - 1 }), false);
  });
  test('백오프 중에는 자동 확인/페이지 방문을 건너뛴다', () => {
    assert.equal(skip({ backoffUntil: now + MIN }), true);
    assert.equal(skip({ policy: 'page', backoffUntil: now + MIN }), true);
    assert.equal(skip({ backoffUntil: now - 1 }), false);
  });
  test('새 정보가 있으면 간격 제한', () => {
    assert.equal(skip({ snapshot: snapAt(now - 10 * 1000) }), true);
    assert.equal(skip({ snapshot: snapAt(now - 40 * 1000) }), false);
    assert.equal(skip({ policy: 'page', snapshot: snapAt(now - 40 * 1000) }), true);
    assert.equal(skip({ policy: 'page', snapshot: snapAt(now - 70 * 1000) }), false);
    assert.equal(skip({ snapshot: snapAt(now - 20 * MIN, { countedToday: true }) }), true, '해결했으면 30분 간격');
    assert.equal(skip({ snapshot: snapAt(now - 31 * MIN, { countedToday: true }) }), false);
    assert.equal(skip({ snapshot: { ...snapAt(now - 1000), dayKey: '2026-11-20' } }), false, '어제 정보면 확인');
    assert.equal(skip({ snapshot: { ...snapAt(now - 1000), handle: 'other' } }), false, '다른 핸들이면 확인');
  });
  test('실패 직후에는 연달아 요청하지 않는다', () => {
    const lastError = { handle: 'T', code: 'network', at: now - 1000 };
    assert.equal(skip({ lastError, lastAttemptAt: now - 1000 }), true);
    assert.equal(skip({ lastError, lastAttemptAt: now - 40 * 1000 }), false);
    assert.equal(skip({ policy: 'page', lastError, lastAttemptAt: now - 40 * 1000 }), true);
    assert.equal(skip({ lastError, snapshot: snapAt(now - 5000), lastAttemptAt: now - 40 * 1000 }), false);
    assert.equal(skip({ lastError: { ...lastError, handle: 'other' }, snapshot: snapAt(now - 5000) }), true, '다른 핸들의 오류는 무관');
  });
  test('다음 재시도 시각', () => {
    const base = { settings: SETTINGS, handle: 'T', snapshot: null, lastAttemptAt: now, backoffUntil: null, rateLimitedUntil: null };
    assert.equal(core.nextRetryAt({ ...base, lastError: null }), null, '실패가 아니면 없음');
    assert.equal(core.nextRetryAt({ ...base, lastError: { handle: 'T', code: 'network', at: now } }), now + 5 * MIN);
    const slow = { ...base, settings: { ...SETTINGS, checkIntervalMin: 2 } };
    assert.equal(core.nextRetryAt({ ...slow, lastError: { handle: 'T', code: 'network', at: now } }), now + 2 * MIN);
    assert.equal(core.nextRetryAt({ ...base, backoffUntil: now + 15 * MIN, lastError: { handle: 'T', code: 'blocked', at: now } }), now + 15 * MIN);
    assert.equal(core.nextRetryAt({ ...base, rateLimitedUntil: now + 60 * MIN, lastError: { handle: 'T', code: 'rate-limited', at: now } }), now + 60 * MIN);
    assert.equal(core.nextRetryAt({ ...base, lastError: { handle: 'T', code: 'not-found', at: now } }), null);
  });
});

describe('상태 판정', () => {
  const now = at('2026-11-21T20:00:00+09:00');
  const snapFrom = (name, fetchedAt = now - 60000, handle = 'Taeyang', dayKey = '2026-11-21') =>
    core.buildSnapshot(handle, core.parseActivity(json(name)), dayKey, fetchedAt);
  const derive = (over) => core.deriveStatus({ settings: SETTINGS, credentialsReady: true, nowMs: now, ...over });

  test('설정 전: 핸들 없음 / v1에서 옮겨온 경우 / API 키 없음', () => {
    assert.deepEqual(derive({ settings: core.normalizeSettings({}) }), { kind: 'setup', missing: 'handle', migrated: false });
    assert.deepEqual(derive({ settings: core.normalizeSettings({}), legacyHandle: 'taeyang95' }), {
      kind: 'setup',
      missing: 'handle',
      migrated: true,
    });
    assert.deepEqual(derive({ credentialsReady: false }), { kind: 'setup', missing: 'credentials', migrated: false });
  });
  test('아직 조회 전', () => {
    assert.equal(derive({}).kind, 'checking');
  });
  test('해결 / 미해결 / 휴가', () => {
    assert.equal(derive({ snapshot: snapFrom('activity-solved.json') }).kind, 'solved');
    const u = derive({ snapshot: snapFrom('activity-unsolved.json') });
    assert.equal(u.kind, 'unsolved');
    assert.equal(u.atRisk, true);
    assert.equal(u.stale, false);
    assert.equal(derive({ snapshot: snapFrom('activity-vacation.json') }).kind, 'vacation');
  });
  test('스트릭 0일이면 위험 아님', () => {
    const snap = snapFrom('activity-unsolved.json');
    snap.currentStreak = 0;
    const s = derive({ snapshot: snap });
    assert.equal(s.kind, 'unsolved');
    assert.equal(s.atRisk, false);
  });
  test('어제 스냅샷은 오늘 상태로 쓰지 않는다', () => {
    const snap = snapFrom('activity-solved.json', at('2026-11-21T05:59:00+09:00'), 'Taeyang', '2026-11-20');
    const s = derive({ snapshot: snap, nowMs: at('2026-11-21T06:00:30+09:00') });
    assert.equal(s.kind, 'checking');
    assert.equal(s.lastSnapshot, snap);
  });
  test('다른 핸들의 스냅샷/오류는 무시한다', () => {
    const snap = snapFrom('activity-solved.json', now - 1000, 'someone');
    const lastError = { handle: 'someone', code: 'not-found', at: now };
    assert.equal(derive({ snapshot: snap, lastError }).kind, 'checking');
  });
  test('핸들 대소문자는 구분하지 않는다', () => {
    assert.equal(derive({ snapshot: snapFrom('activity-solved.json', now - 1000, 'taeyang') }).kind, 'solved');
  });
  test('짧은 일시 오류: 오늘 미해결 정보 유지 + stale', () => {
    const snap = snapFrom('activity-unsolved.json', now - 10 * MIN);
    const s = derive({ snapshot: snap, lastError: { handle: 'Taeyang', code: 'network', at: now - 1000 } });
    assert.equal(s.kind, 'unsolved');
    assert.equal(s.stale, true);
  });
  test('실패가 길어지거나 막히면 예전 미해결 정보 대신 오류를 보여준다', () => {
    const old = snapFrom('activity-unsolved.json', now - 25 * MIN);
    const s1 = derive({ snapshot: old, lastError: { handle: 'Taeyang', code: 'network', at: now - 1000 } });
    assert.deepEqual([s1.kind, s1.code, s1.lastSnapshot], ['error', 'network', old]);
    const recent = snapFrom('activity-unsolved.json', now - 2 * MIN);
    const s2 = derive({ snapshot: recent, lastError: { handle: 'Taeyang', code: 'blocked', at: now - 1000 } });
    assert.deepEqual([s2.kind, s2.code], ['error', 'blocked']);
  });
  test('해결 상태는 확인이 실패해도 유지 (그날 안에 되돌아가지 않음)', () => {
    const snap = snapFrom('activity-solved.json', now - 3 * 60 * MIN);
    const s = derive({ snapshot: snap, lastError: { handle: 'Taeyang', code: 'blocked', at: now - 1000 } });
    assert.deepEqual([s.kind, s.stale], ['solved', true]);
  });
  test('최신 not-found/auth는 스냅샷보다 우선', () => {
    const snap = snapFrom('activity-solved.json', now - 10 * MIN);
    for (const code of ['not-found', 'auth']) {
      const s = derive({ snapshot: snap, lastError: { handle: 'Taeyang', code, at: now - 1000 } });
      assert.deepEqual([s.kind, s.code], ['error', code]);
    }
  });
  test('429 대기 중이면 오늘 미해결 정보도 낡아 가고, 20분이 지나면 요청 제한 오류로', () => {
    const fresh = derive({ rateLimited: true, snapshot: snapFrom('activity-unsolved.json', now - 5 * MIN) });
    assert.deepEqual([fresh.kind, fresh.stale], ['unsolved', true]);
    const old = derive({ rateLimited: true, snapshot: snapFrom('activity-unsolved.json', now - 21 * MIN) });
    assert.deepEqual([old.kind, old.code], ['error', 'rate-limited']);
  });
  test('시계 오류는 오늘 해결 정보보다 우선(날짜를 믿을 수 없으므로)', () => {
    const s = derive({ snapshot: snapFrom('activity-solved.json', now - MIN), clockProblem: true });
    assert.deepEqual([s.kind, s.code], ['error', 'clock']);
    const fixed = derive({ snapshot: snapFrom('activity-solved.json', now - MIN), lastError: { handle: 'Taeyang', code: 'clock', at: now } });
    assert.equal(fixed.kind, 'solved', '시계 문제 기록이 풀렸으면 예전 시계 오류는 보여주지 않음');
  });
  test('오늘 정보가 없고 이 앱이 429 대기 중이면 "확인 중"이 아니라 요청 제한 오류', () => {
    const s = derive({ rateLimited: true });
    assert.deepEqual([s.kind, s.code], ['error', 'rate-limited']);
    assert.equal(derive({ rateLimited: true, snapshot: snapFrom('activity-solved.json') }).kind, 'solved', '오늘 정보가 있으면 그대로');
  });
  test('오늘 스냅샷 없이 오류만 있으면 error', () => {
    const s = derive({ lastError: { handle: 'Taeyang', code: 'blocked', at: now - 1000 } });
    assert.deepEqual([s.kind, s.code], ['error', 'blocked']);
  });
  test('남아 있는 오류는 시각과 상관없이 스냅샷보다 나중 일이다 (성공하면 지워지므로)', () => {
    const snap = snapFrom('activity-unsolved.json', now - 1000);
    // 시계 보정이 바뀌어 오류 시각이 스냅샷보다 앞서 보여도 오류가 최신이다.
    const s = derive({ snapshot: snap, lastError: { handle: 'Taeyang', code: 'blocked', at: now - 10 * MIN } });
    assert.deepEqual([s.kind, s.code], ['error', 'blocked']);
  });
});

describe('알림 판단', () => {
  const now = at('2026-11-21T20:00:00+09:00');
  const dayKey = '2026-11-21';
  const unsolved = { kind: 'unsolved', atRisk: true, snapshot: { currentStreak: 10, fetchedAt: now } };
  const decide = (over = {}) =>
    core.decideNotification({
      status: unsolved,
      settings: SETTINGS,
      history: null,
      shownKind: null,
      snoozeDayKey: null,
      consecutiveFailures: 0,
      failingSince: null,
      lastFailureAt: null,
      nowMs: now,
      ...over,
    });
  const err = (code) => ({ kind: 'error', code });

  test('미해결이면 알림', () => {
    assert.deepEqual(decide(), { action: 'show', kind: 'unsolved' });
  });
  test('해결/휴가/확인 중/처음 설치면 지운다', () => {
    for (const status of [{ kind: 'solved' }, { kind: 'vacation' }, { kind: 'checking' }, { kind: 'setup', missing: 'handle', migrated: false }]) {
      assert.equal(decide({ status }).action, 'clear', status.kind);
    }
  });
  test('새 미해결 알림은 방금(2분 안에) 확인한 정보로만, 바로 이번 확인이 실패했으면 20분까지', () => {
    const aged = (min, stale = false) => ({ ...unsolved, stale, snapshot: { currentStreak: 10, fetchedAt: now - min * MIN } });
    assert.equal(decide({ status: aged(1) }).action, 'show');
    assert.deepEqual(decide({ status: aged(10) }), { action: 'keep' }, '10분 전 정보: 그사이 풀었을 수 있음');
    assert.equal(decide({ status: aged(10, true), refreshJustFailed: true }).action, 'show', '이번 확인이 실패했을 때만 마지막 정보로');
    assert.deepEqual(decide({ status: aged(10, true), refreshJustFailed: false }), { action: 'keep' },
      '예전 실패 기록만으로는 오래된 정보로 알리지 않음(예: 다시 켜기)');
    assert.deepEqual(decide({ status: aged(21, true), refreshJustFailed: true }), { action: 'keep' });
    assert.deepEqual(decide({ status: aged(-10) }), { action: 'keep' }, '시계가 뒤로 가서 미래 시각인 정보도 믿지 않음');
  });
  test('설정 알림은 원인당 한 번만', () => {
    const migrated = { kind: 'setup', missing: 'handle', migrated: true };
    const creds = { kind: 'setup', missing: 'credentials', migrated: false };
    assert.deepEqual(decide({ status: migrated }), { action: 'show', kind: 'setup' });
    assert.deepEqual(decide({ status: creds }), { action: 'show', kind: 'setup' });
    const history = core.recordNotification(null, 'setup', creds, now - 20 * 24 * 60 * MIN);
    assert.equal(decide({ status: creds, history, shownKind: 'setup', shownCause: 'setup:credentials' }).action, 'keep', '며칠이 지나도 다시 알리지 않음');
    assert.equal(decide({ status: creds, history }).action, 'clear', '이미 알렸고 화면에 없으면 다시 띄우지 않음');
    assert.equal(decide({ status: migrated, history }).action, 'show', '원인이 다르면 알림');
    assert.equal(decide({ status: creds, settings: { ...SETTINGS, notifyError: false } }).action, 'clear');
  });
  test('설정으로 끄면 지운다', () => {
    assert.equal(decide({ settings: { ...SETTINGS, notifyUnsolved: false } }).action, 'clear');
  });
  test('오늘 그만 알림', () => {
    assert.equal(decide({ snoozeDayKey: dayKey }).action, 'clear');
    assert.equal(decide({ snoozeDayKey: dayKey, status: err('auth') }).action, 'clear');
    assert.equal(decide({ snoozeDayKey: '2026-11-20' }).action, 'show', '어제 끈 것은 오늘 영향 없음');
  });
  test('알림 시작 시각 이전에는 띄우지 않는다 (기본값: 마감 12시간 전)', () => {
    assert.equal(core.DEFAULT_SETTINGS.notifyStartHours, 12);
    const settings = { ...SETTINGS, notifyStartHours: 12 }; // 18:00 KST부터
    const st = (t) => ({ ...unsolved, snapshot: { currentStreak: 10, fetchedAt: t } });
    const d = (iso, s = settings) => decide({ settings: s, status: st(at(iso)), nowMs: at(iso) }).action;
    assert.equal(d('2026-11-21T17:59:00+09:00'), 'clear');
    assert.equal(d('2026-11-21T18:00:00+09:00'), 'show');
    assert.equal(d('2026-11-22T02:00:00+09:00'), 'show', '자정 이후 마감 전');
    const late = { ...SETTINGS, notifyStartHours: 1 }; // 05:00 KST부터
    assert.equal(d('2026-11-22T04:59:00+09:00', late), 'clear');
    assert.equal(d('2026-11-22T05:00:00+09:00', late), 'show');
  });
  test('다시 알림 간격', () => {
    const history = { reminder: { dayKey, shownAt: now - 59 * MIN } };
    assert.deepEqual(decide({ history, shownKind: 'unsolved' }), { action: 'keep' });
    assert.equal(decide({ history: { reminder: { dayKey, shownAt: now - 60 * MIN } } }).action, 'show');
    const once = { ...SETTINGS, remindIntervalMin: 0 };
    assert.equal(decide({ settings: once, history: { reminder: { dayKey, shownAt: now - 10 * 60 * MIN } } }).action, 'keep');
    assert.equal(decide({ history: { reminder: { dayKey: '2026-11-20', shownAt: now - MIN } } }).action, 'show', '날이 바뀌면 다시');
  });
  test('오류가 끼었다가 회복해도 미해결 알림 기록은 남아 간격을 지킨다', () => {
    const history = { reminder: { dayKey, shownAt: now - 30 * MIN }, alerts: { dayKey, causes: ['error:blocked'] } };
    assert.deepEqual(decide({ history, shownKind: 'unsolved' }), { action: 'keep' });
    assert.deepEqual(decide({ history, shownKind: 'error' }), { action: 'clear' }, '사용자가 닫았던 알림은 되살리지 않고 오류 알림만 닫음');
    assert.deepEqual(decide({ history, shownKind: null }), { action: 'keep' });
  });
  test('확장이 스스로 닫거나 바꾼 미해결 알림은 회복되면 되살린다(하루 한 번만이어도)', () => {
    const once = { ...SETTINGS, remindIntervalMin: 0 };
    const history = { reminder: { dayKey, shownAt: now - 2 * 60 * MIN, displaced: true } };
    assert.deepEqual(decide({ settings: once, history, shownKind: 'error' }), { action: 'show', kind: 'unsolved', restore: true });
    assert.deepEqual(decide({ settings: once, history, shownKind: null }), { action: 'show', kind: 'unsolved', restore: true });
    const stale = { ...unsolved, snapshot: { currentStreak: 10, fetchedAt: now - 10 * MIN } };
    assert.deepEqual(decide({ settings: once, history, status: stale }), { action: 'keep' }, '되살릴 때도 방금 확인한 정보여야 함');
  });
  test('알림 기록 갱신: 밀어낸 미해결 알림 표시, 되살릴 때 shownAt 유지, 실패해도 기록', () => {
    const base = { reminder: { dayKey, shownAt: now - 30 * MIN } };
    const err = { kind: 'error', code: 'blocked' };
    const h1 = core.applyDecisionToHistory(base, { action: 'show', kind: 'error' }, err, 'unsolved', now);
    assert.equal(h1.reminder.displaced, true);
    assert.deepEqual(h1.alerts, { dayKey, causes: ['error:blocked'] });
    const h2 = core.applyDecisionToHistory(h1, { action: 'show', kind: 'unsolved', restore: true }, unsolved, 'error', now + MIN);
    assert.deepEqual(h2.reminder, { dayKey, shownAt: now - 30 * MIN, displaced: false });
    const h3 = core.applyDecisionToHistory(base, { action: 'clear' }, { kind: 'solved' }, 'unsolved', now);
    assert.equal(h3.reminder.displaced, true);
    const h4 = core.applyDecisionToHistory(base, { action: 'keep' }, unsolved, 'unsolved', now);
    assert.deepEqual(h4, base);
    const h5 = core.applyDecisionToHistory(null, { action: 'show', kind: 'unsolved' }, unsolved, null, now);
    assert.deepEqual(h5, { reminder: { dayKey, shownAt: now } });
  });
  test('오류 알림: 같은 날 같은 원인은 한 번만 (원인이 번갈아 와도)', () => {
    assert.deepEqual(decide({ status: err('not-found') }), { action: 'show', kind: 'error' });
    let history = core.recordNotification(null, 'error', err('blocked'), now);
    history = core.recordNotification(history, 'error', err('auth'), now + MIN);
    assert.deepEqual(history.alerts, { dayKey, causes: ['error:blocked', 'error:auth'] });
    assert.equal(decide({ status: err('blocked'), history, shownKind: 'error', shownCause: 'error:blocked' }).action, 'keep');
    assert.equal(decide({ status: err('blocked'), history, shownKind: 'error', shownCause: 'error:auth' }).action, 'clear',
      '지난 원인의 알림(다른 버튼)이 남지 않게 닫음');
    assert.equal(decide({ status: err('blocked'), history, shownKind: null }).action, 'clear');
    assert.equal(decide({ status: err('not-found'), history }).action, 'show', '새 원인은 알림');
    const tomorrow = at('2026-11-22T07:00:00+09:00');
    assert.equal(decide({ status: err('blocked'), history, nowMs: tomorrow }).action, 'show', '다음 날 다시');
    assert.equal(decide({ status: err('blocked'), settings: { ...SETTINGS, notifyError: false } }).action, 'clear');
    assert.equal(decide({ status: err('blocked'), settings: { ...SETTINGS, notifyError: false }, shownKind: 'unsolved' }).action, 'clear',
      '오류로 바뀌면 더 이상 믿을 수 없는 미해결 알림은 닫는다');
  });
  test('일시 오류는 관찰한 실패가 2번 이상이고 처음~마지막이 10분 이상일 때만', () => {
    const net = err('network');
    const mk = (n, firstAgo, lastAgo) =>
      decide({ status: net, consecutiveFailures: n, failingSince: now - firstAgo, lastFailureAt: now - lastAgo }).action;
    assert.equal(mk(2, 1000, 0), 'clear', '절전 복귀 직후 연달아 2번');
    assert.equal(mk(2, 20 * MIN, 19 * MIN), 'clear', '두 번이 1분 간격이면 시간이 지나도 아님');
    assert.equal(mk(1, 30 * MIN, 30 * MIN), 'clear');
    assert.equal(mk(3, 12 * MIN, 0), 'show');
    assert.equal(decide({ status: err('rate-limited'), consecutiveFailures: 5, failingSince: null }).action, 'clear');
  });
  test('긴 429 대기(10분 이상 남음)는 바로 알린다 — 확인을 못 하는 동안 조용히 넘어가지 않도록', () => {
    const rl = err('rate-limited');
    assert.equal(decide({ status: rl, consecutiveFailures: 1, rateLimitRemainingMs: 50 * MIN }).action, 'show');
    assert.equal(decide({ status: rl, consecutiveFailures: 1, rateLimitRemainingMs: 2 * MIN }).action, 'clear');
  });

  test('다음 확인 시각 (확인 주기와 무관하게 제때 깨우기)', () => {
    const next = (over) =>
      core.nextNotificationCheckAt({ status: unsolved, settings: SETTINGS, history: null, snoozeDayKey: null, nowMs: now, ...over });
    const late = { ...SETTINGS, notifyStartHours: 1 };
    assert.equal(next({ settings: late }), at('2026-11-22T05:00:00+09:00'), '알림 시작 시각');
    const history = { reminder: { dayKey, shownAt: now - 10 * MIN } };
    assert.equal(next({ history }), now + 50 * MIN, '다시 알림 시각');
    assert.equal(next({ history, settings: { ...SETTINGS, remindIntervalMin: 0 } }), null);
    assert.equal(next({ history: { reminder: { dayKey, shownAt: at('2026-11-22T05:30:00+09:00') } } }), null, '마감 이후는 rollover가 처리');
    assert.equal(next({ snoozeDayKey: dayKey }), null);
    assert.equal(next({ status: { kind: 'solved' } }), null);
    assert.equal(next({ settings: { ...SETTINGS, notifyUnsolved: false } }), null);
    const stale = { ...unsolved, stale: true, snapshot: { currentStreak: 10, fetchedAt: now - 5 * MIN } };
    assert.equal(next({ status: stale, history, settings: { ...SETTINGS, remindIntervalMin: 0 } }), now + 15 * MIN + 1000,
      '실패 중이면 미해결 정보를 더 믿지 않게 되는 시각에도 깨어난다');
    assert.equal(next({ status: stale, snoozeDayKey: dayKey }), now + 15 * MIN + 1000, '알림을 꺼도 표시는 바꿔야 함');
    assert.equal(next({ history: { reminder: { dayKey, shownAt: now - 2 * 60 * MIN } } }), null,
      '이미 지난 시각으로는 깨우지 않음(30초마다 깨는 일 방지)');
  });
});

describe('표시 텍스트', () => {
  test('남은 시간', () => {
    assert.equal(core.formatDuration(0), '0분');
    assert.equal(core.formatDuration(30 * 1000), '1분 미만');
    assert.equal(core.formatDuration(45 * MIN), '45분');
    assert.equal(core.formatDuration(3 * 60 * MIN), '3시간');
    assert.equal(core.formatDuration(5 * 60 * MIN + 54 * MIN + 59 * 1000), '5시간 54분');
  });
  test('시각/날짜 포맷', () => {
    assert.equal(core.formatClock(at('2026-11-21T06:00:00+09:00'), 'Asia/Seoul'), '오전 6:00');
    assert.equal(core.formatKstClock(at('2026-11-21T06:00:00+09:00')), '오전 6:00(한국 시간)');
    const t = at('2026-11-21T15:20:00+09:00');
    assert.equal(core.formatWhen(t, at('2026-11-21T09:00:00+09:00'), 'Asia/Seoul'), '오후 3:20');
    assert.match(core.formatWhen(t + 2 * 24 * 60 * MIN, t, 'Asia/Seoul'), /11월 23일.*오후 3:20/);
    assert.ok(core.sameHandle('Taeyang', 'taeyang'));
    assert.ok(!core.sameHandle('Taeyang', null));
    assert.match(core.formatDayKey('2026-11-21'), /11월 21일/);
    assert.equal(core.formatNumber(1183), '1,183');
    assert.equal(core.formatNumber(undefined), '-');
  });
  test('배지', () => {
    assert.equal(core.badgeFor({ kind: 'solved' }).text, '✓');
    assert.equal(core.badgeFor({ kind: 'unsolved' }).text, '!');
    assert.equal(core.badgeFor({ kind: 'vacation' }).text, '휴');
    assert.equal(core.badgeFor({ kind: 'error' }).text, '?');
    assert.equal(core.badgeFor({ kind: 'setup' }).text, '…');
    assert.equal(core.badgeFor({ kind: 'checking' }).text, '');
  });
  test('미해결 알림: 마감이 가까울 때만 급한 문구', () => {
    const status = { kind: 'unsolved', atRisk: true, stale: false, snapshot: { currentStreak: 1183, fetchedAt: 0 } };
    const early = core.notificationContent('unsolved', status, 'Taeyang', at('2026-11-21T07:00:00+09:00'));
    assert.doesNotMatch(early.title, /직전/);
    assert.match(early.title, /1,183일 스트릭/);
    assert.match(early.message, /23시간 남았어요/);
    const late = core.notificationContent('unsolved', status, 'Taeyang', at('2026-11-22T03:00:00+09:00'));
    assert.match(late.title, /끊기기 직전/);
    assert.match(late.message, /Taeyang님/);
    assert.equal(late.requireInteraction, true);
    assert.equal(late.primaryButton, 'solved.ac 열기');
    assert.match(core.notificationContent('unsolved', { ...status, atRisk: false }, 'T', 0).title, /오늘의 문제/);
    assert.match(core.notificationContent('unsolved', { ...status, stale: true }, 'T', 0).message, /최근 확인 실패/);
  });
  test('오류/설정 알림은 고칠 곳을 연다', () => {
    const e = core.notificationContent('error', { kind: 'error', code: 'blocked' }, 'T', 0);
    assert.match(e.title, /보안 확인/);
    assert.equal(e.requireInteraction, false);
    assert.equal(e.primaryButton, 'solved.ac 열기');
    assert.equal(core.notificationContent('error', { kind: 'error', code: 'auth' }, 'T', 0).primaryButton, '설정 열기');
    const s = core.notificationContent('setup', { kind: 'setup', missing: 'handle', migrated: true }, '', 0);
    assert.match(s.title, /다시 설정/);
    assert.equal(s.primaryButton, '설정 열기');
    assert.ok(core.notificationOpensSettings('setup', 'setup:credentials'));
    assert.ok(core.notificationOpensSettings('error', 'error:auth'));
    assert.ok(core.notificationOpensSettings('error', 'error:not-found'));
    assert.ok(!core.notificationOpensSettings('error', 'error:network'));
    assert.ok(!core.notificationOpensSettings('unsolved', 'error:auth'));
    assert.ok(!core.notificationOpensSettings(null, null));
    assert.equal(core.notificationCause({ kind: 'setup', missing: 'handle', migrated: true }), 'setup:handle:migrated');
    assert.equal(core.notificationCause({ kind: 'error', code: 'blocked' }), 'error:blocked');
    assert.equal(core.notificationCause({ kind: 'solved' }), null);
  });
  test('모든 오류 코드에 안내 문구가 있다', () => {
    for (const code of Object.values(core.ERROR_CODES)) {
      assert.ok(core.errorText(code).title, code);
      assert.ok(core.errorText(code).detail, code);
    }
    assert.equal(core.errorText('unknown-code'), core.errorText('http'));
  });
  test('툴바 제목', () => {
    assert.match(core.actionTitleFor({ kind: 'solved', snapshot: { currentStreak: 3 } }, 'T'), /3일 연속/);
    assert.match(core.actionTitleFor({ kind: 'setup', missing: 'handle' }, ''), /핸들을 설정/);
    assert.match(core.actionTitleFor({ kind: 'setup', missing: 'credentials' }, 'T'), /API 키/);
    assert.match(core.actionTitleFor({ kind: 'error', code: 'network' }, 'T'), /연결할 수 없어요/);
  });
});

describe('6차 리뷰: 시계·대기·재시도 계산', () => {
  const MIN6 = 60 * 1000;
  const settings6 = core.normalizeSettings({ handle: 'T', checkIntervalMin: 5 });

  test('지우기 뒤 남긴 대기(클라이언트 ID 없음)는 모든 클라이언트에 적용되고, 끝난 대기는 정리한다', () => {
    const kept = core.anonymousRateLimits({ a: 5000, b: 9000, c: 100 }, 1000);
    assert.deepEqual(kept, { '': [5000, 9000] }, '끝나지 않은 대기를 모두(클라이언트 ID 없이)');
    assert.equal(core.anonymousRateLimits({ a: 500 }, 1000), null);
    assert.equal(core.activeRateLimit(kept, 'new-client', 2000), 9000);
    assert.equal(core.activeRateLimit(kept, 'new-client', 9000), null);
    assert.deepEqual(core.pruneRateLimits({ a: 500, b: 3000, c: 'x' }, 1000), { b: 3000 });
  });

  test('짧은 429 대기: 다음 재시도 시각과 예정 기록이 같다', () => {
    const t0 = 1_000_000;
    const p = { settings: settings6, code: 'rate-limited', backoffUntil: null, rateLimitedUntil: t0 + MIN6 };
    // 429가 이어질 때는 짧은 Retry-After라도 재시도 간격(5분)보다 자주 요청하지 않는다. 기록과 알람은 같은 값.
    assert.equal(core.expectedRetryAfterFailure({ ...p, receivedAt: t0 }), t0 + 5 * MIN6);
    assert.equal(
      core.nextRetryAt({ settings: settings6, handle: 'T', lastError: { handle: 'T', code: 'rate-limited' }, lastAttemptAt: t0, backoffUntil: null, rateLimitedUntil: t0 + MIN6 }),
      t0 + 5 * MIN6,
    );
    assert.equal(core.expectedRetryAfterFailure({ settings: settings6, code: 'not-found', receivedAt: t0 }), t0 + 5 * MIN6, '사용자 없음은 다음 주기');
  });

  test('실패 시작 시각이 지금보다 뒤(시계가 뒤로 감)면 연속 실패를 새로 센다', () => {
    const r = core.nextFailureStreak({ consecutiveFailures: 3, failingSince: 10_000_000, lastAttemptAt: 9_000_000, receivedAt: 5_000_000, at: 5_000_000 });
    assert.deepEqual(r, { consecutiveFailures: 1, failingSince: 5_000_000 });
  });

  test('확인 실패 중에는 0~20분 전 미해결 정보만 믿는다(미래 시각이면 오류)', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const snap = { handle: 'T', dayKey: '2026-11-21', fetchedAt: now + 60 * MIN6, countedToday: false, currentStreak: 3, vacation: null };
    const st = core.deriveStatus({ settings: settings6, snapshot: snap, lastError: { handle: 'T', code: 'network', at: now }, nowMs: now });
    assert.equal(st.kind, 'error');
    const ok = core.deriveStatus({ settings: settings6, snapshot: { ...snap, fetchedAt: now - 5 * MIN6 }, lastError: { handle: 'T', code: 'network', at: now }, nowMs: now });
    assert.equal(ok.kind, 'unsolved');
  });

  test('20분이 지나면 이어지는 429 대기가 예전 일시 오류보다 원인으로 앞선다', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const snap = { handle: 'T', dayKey: '2026-11-21', fetchedAt: now - 30 * MIN6, countedToday: false, currentStreak: 3, vacation: null };
    const st = core.deriveStatus({ settings: settings6, snapshot: snap, lastError: { handle: 'T', code: 'network', at: now - 25 * MIN6 }, rateLimited: true, nowMs: now });
    assert.deepEqual([st.kind, st.code], ['error', 'rate-limited']);
    const blocked = core.deriveStatus({ settings: settings6, snapshot: snap, lastError: { handle: 'T', code: 'blocked', at: now }, rateLimited: true, nowMs: now });
    assert.equal(blocked.code, 'blocked', '막힘은 그대로');
  });

  test('새 키를 아직 확인하지 못했으면 최근 정보가 있어도 건너뛰지 않는다(429 대기는 지킴)', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const snapshot = { handle: 'T', dayKey: '2026-11-21', fetchedAt: now - MIN6, countedToday: true, vacation: null };
    const base = { policy: 'auto', handle: 'T', snapshot, lastError: null, backoffUntil: null, lastAttemptAt: now - MIN6, nowMs: now, eNowMs: now };
    assert.equal(core.shouldSkipRefresh(base), true);
    assert.equal(core.shouldSkipRefresh({ ...base, verifyPending: true }), false);
    assert.equal(core.shouldSkipRefresh({ ...base, verifyPending: true, rateLimitedUntil: now + MIN6 }), true);
  });

  test('다시 알림 시각이 미래(시계가 뒤로 감)면 간격이 지난 것으로 본다', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const status = { kind: 'unsolved', snapshot: { fetchedAt: now, currentStreak: 3 }, stale: false, atRisk: true };
    const d = core.decideNotification({
      status,
      settings: core.normalizeSettings({ handle: 'T', notifyStartHours: 24, remindIntervalMin: 60 }),
      history: { reminder: { dayKey: '2026-11-21', shownAt: now + 60 * MIN6 } },
      shownKind: null,
      nowMs: now,
    });
    assert.deepEqual(d, { action: 'show', kind: 'unsolved' });
  });

  test('알림의 "최근 확인 실패" 시각은 내 시계로 보여준다', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const status = { kind: 'unsolved', snapshot: { fetchedAt: now, currentStreak: 3 }, stale: true, atRisk: true };
    const skew = 2 * 60 * MIN6;
    const msg = core.notificationContent('unsolved', status, 'T', now, skew).message;
    assert.ok(msg.includes(core.formatClock(now - skew)), msg);
  });
});

describe('7차 리뷰: 429 대기·키 확인', () => {
  test('429 대기 기록: 끝나는 시각은 받은 시각·서버 시각·길이로 그때그때 계산한다', () => {
    const D = 24 * 60 * 60 * 1000;
    const local = Date.parse('2026-11-19T20:00:00+09:00');
    const slow = core.rateLimitEntry(3600, local, new Date(local + 2 * D).toUTCString()); // 2일 느린 시계
    assert.equal(core.rateLimitEnd(slow, local), local + 2 * D + 1000 + 3600 * 1000, '시계 오류면 서버 기준 끝까지');
    const near = core.rateLimitEntry(3600, local, new Date(local + 60 * 60 * 1000).toUTCString()); // 1시간 느림
    assert.equal(core.rateLimitEnd(near, local), local + 3600 * 1000, '하루 안 차이는 내 시계 기준');
    const fast = core.rateLimitEntry(600, local, new Date(local - 2 * D).toUTCString()); // 2일 빠름
    assert.equal(core.rateLimitEnd(fast, local + MIN), local + 600 * 1000, '시계가 그대로면 내 시계 기준');
    // 시계가 뒤로 가면 rebaseRateLimits가 마지막으로 본 시각과의 차이만큼 받은 시각을 옮긴다.
    const seen = { ...fast, seen: local + MIN };
    const moved = core.rebaseRateLimits({ a: seen }, local + MIN - 2 * D).a;
    assert.equal(core.rateLimitEnd(moved, local + MIN - 2 * D), local - 2 * D + 600 * 1000);
    assert.equal(core.rateLimitEntry(undefined, local, null).ms, core.DEFAULT_RATE_LIMIT_BACKOFF_MS);
    assert.equal(core.rateLimitEntry(30 * 24 * 3600, local, null).ms, core.MAX_RETRY_AFTER_SEC * 1000, '받을 때 7일로 자름');
    assert.equal(core.rateLimitEnd(12345, 0), 12345, '예전 형식(숫자)');
    assert.equal(core.rateLimitEnd({ bad: 1 }, 0), 0);
  });

  test('키 확인: 2xx·4xx는 확인, 429·보안 확인·5xx·응답 없음은 아직', () => {
    assert.equal(core.responseVerifiesKey({ status: 200 }, { ok: true }), true);
    assert.equal(core.responseVerifiesKey({ status: 401 }, { ok: false, code: 'auth' }), true);
    assert.equal(core.responseVerifiesKey({ status: 404 }, { ok: false, code: 'not-found' }), true);
    assert.equal(core.responseVerifiesKey({ status: 429 }, { ok: false, code: 'clock' }), false);
    assert.equal(core.responseVerifiesKey({ status: 403 }, { ok: false, code: 'blocked' }), false);
    assert.equal(core.responseVerifiesKey({ status: 503 }, { ok: false, code: 'http' }), false);
    assert.equal(core.responseVerifiesKey({ networkError: true }, { ok: false, code: 'network' }), false);
  });

  test('오늘 정보가 없을 때도 원인은 막힘 > 429 대기 > 예전 일시 오류', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const s = core.normalizeSettings({ handle: 'T' });
    const err = (code) => ({ handle: 'T', code, at: now });
    assert.equal(core.deriveStatus({ settings: s, lastError: err('network'), rateLimited: true, nowMs: now }).code, 'rate-limited');
    assert.equal(core.deriveStatus({ settings: s, lastError: err('blocked'), rateLimited: true, nowMs: now }).code, 'blocked');
    assert.equal(core.deriveStatus({ settings: s, lastError: err('network'), nowMs: now }).code, 'network');
    assert.equal(core.deriveStatus({ settings: s, nowMs: now }).kind, 'checking');
  });
});

describe('8차 리뷰: 시계 오류 뒤 시계를 고쳤는지', () => {
  const D = 24 * 60 * 60 * 1000;
  test('느린 시계: 그때 본 서버 시각을 따라잡으면 고친 것', () => {
    const err = { code: 'clock', localAt: 1_000_000_000, serverAt: 1_000_000_000 + 2 * D };
    assert.equal(core.clockErrorLooksFixed(err, 1_000_000_000 + 60 * 60 * 1000), false, '아직 느림');
    assert.equal(core.clockErrorLooksFixed(err, 1_000_000_000 + 2 * D + 5 * 60 * 1000), true);
  });
  test('빠른 시계: 그때의 내 시계보다 뒤로 가면 고친 것', () => {
    const err = { code: 'clock', localAt: 1_000_000_000 + 2 * D, serverAt: 1_000_000_000 };
    assert.equal(core.clockErrorLooksFixed(err, 1_000_000_000 + 2 * D + 60 * 1000), false);
    assert.equal(core.clockErrorLooksFixed(err, 1_000_000_000 + 10 * 60 * 1000), true);
  });
  test('근거가 없거나 시계 오류가 아니면 판단하지 않는다', () => {
    assert.equal(core.clockErrorLooksFixed({ code: 'clock' }, 0), false);
    assert.equal(core.clockErrorLooksFixed({ code: 'network', localAt: 0, serverAt: 3 * D }, 3 * D), false);
    assert.equal(core.clockErrorLooksFixed({ code: 'clock', localAt: 0, serverAt: 60 * 1000 }, D), false, '하루 안 차이는 근거가 아님');
  });
});

describe('10차 리뷰: 오늘을 확신할 수 없는 구간', () => {
  const at = (iso) => Date.parse(iso);
  test('내 시계와 보정한 시계가 같은 날이면 확실하다', () => {
    assert.equal(core.dayUncertain({ nowMs: at('2026-11-22T12:00:00+09:00'), clockSkewMs: -30 * 60 * 1000 }), false);
  });
  test('서로 다른 날인데 그 구간이 시작된 뒤 서버 응답이 없으면 불확실', () => {
    const now = at('2026-11-22T06:10:00+09:00');
    const skew = -30 * 60 * 1000;
    assert.equal(core.dayUncertain({ nowMs: now, clockSkewMs: skew, skewCheckedAt: at('2026-11-22T05:50:00+09:00') }), true);
    assert.equal(core.dayUncertain({ nowMs: now, clockSkewMs: skew, skewCheckedAt: at('2026-11-22T06:09:00+09:00') }), false);
    assert.equal(core.dayUncertain({ nowMs: now, clockSkewMs: skew, skewCheckedAt: at('2026-11-22T06:05:00+09:00') }), true, '2분 넘게 지난 측정');
    assert.equal(
      core.dayUncertain({ nowMs: now, clockSkewMs: skew, skewCheckedAt: at('2026-11-22T06:09:00+09:00'), lastAttemptTimed: false }),
      true,
      '마지막 확인이 시각 정보 없이 끝남',
    );
    assert.equal(core.dayUncertain({ nowMs: now, clockSkewMs: skew }), true);
  });
  test('느린 시계(보정 시계가 먼저 날이 바뀜)도 같은 규칙', () => {
    const now = at('2026-11-22T05:40:00+09:00');
    const skew = 30 * 60 * 1000; // 서버 06:10
    assert.equal(core.dayUncertain({ nowMs: now, clockSkewMs: skew, skewCheckedAt: at('2026-11-22T05:20:00+09:00') }), true);
    assert.equal(core.dayUncertain({ nowMs: now, clockSkewMs: skew, skewCheckedAt: at('2026-11-22T05:39:00+09:00') }), false);
  });
  test('불확실하면 같은 날 스냅샷도 오늘로 쓰지 않는다', () => {
    const now = at('2026-11-22T05:40:00+09:00');
    const s = core.normalizeSettings({ handle: 'T' });
    const snap = { handle: 'T', dayKey: '2026-11-21', fetchedAt: now - 60 * 1000, countedToday: true, vacation: null };
    assert.equal(core.deriveStatus({ settings: s, snapshot: snap, nowMs: now }).kind, 'solved');
    assert.equal(core.deriveStatus({ settings: s, snapshot: snap, nowMs: now, dayUncertain: true }).kind, 'checking');
  });
});

describe('11차 리뷰: 429 대기 기록 옮기기', () => {
  const D = 24 * 60 * 60 * 1000;
  test('한 번 옮긴 뒤에는 시간이 흘러도 끝이 바뀌지 않는다', () => {
    const t = Date.parse('2026-11-23T20:00:00+09:00');
    let map = { a: { at: t, server: t - 2 * D, ms: 3 * D, seen: t } };
    map = core.rebaseRateLimits(map, t - 2 * D + 5 * MIN); // 시계를 고침
    const end = core.rateLimitEnd(map.a, t - 2 * D + 5 * MIN);
    map = core.rebaseRateLimits(map, t + 30 * MIN); // 그때의 내 시계를 지남
    assert.equal(core.rateLimitEnd(map.a, t + 30 * MIN), end);
  });
  test('일부만 뒤로 고쳐도 남은 대기를 지킨다', () => {
    const t = 1_000_000_000;
    let map = { a: { at: t, server: t - 2 * D, ms: 10 * MIN, seen: t + MIN } };
    map = core.rebaseRateLimits(map, t - 5 * MIN); // 6분만 뒤로
    assert.equal(core.rateLimitEnd(map.a, t - 5 * MIN) - (t - 5 * MIN), 9 * MIN);
  });
  test('지우기 뒤 남긴 여러 대기는 그중 가장 늦은 끝을 따르고 각각 옮긴다', () => {
    const t = 1_000_000_000;
    const kept = core.anonymousRateLimits({ a: { at: t, server: t, ms: 72 * 60 * MIN, seen: t }, b: { at: t, server: t, ms: 36 * 60 * MIN, seen: t } }, t);
    assert.equal(kept[''].length, 2);
    assert.equal(core.activeRateLimit(kept, 'x', t + 40 * 60 * MIN), t + 72 * 60 * MIN);
  });
});

describe('12차 리뷰: 대기 기록·시계 판단', () => {
  const D = 24 * 60 * 60 * 1000;
  test('뒤로 옮겨도 "받을 때 하루 넘게 느렸는지"는 받은 시각으로만 판단한다', () => {
    const t = 1_000_000_000_000;
    let map = { a: core.rateLimitEntry(600, t, new Date(t).toUTCString()) };
    map = core.rebaseRateLimits(map, t - 2 * D); // 받은 직후 시계를 이틀 되돌림
    assert.ok(core.rateLimitEnd(map.a, t - 2 * D) - (t - 2 * D) <= 10 * MIN + 1000);
  });
  test("'__proto__' 같은 클라이언트 ID도 옮기기와 지우기를 거쳐 남는다", () => {
    const t = 1_000_000_000_000;
    const map = core.withRateLimit({}, '__proto__', core.rateLimitEntry(600, t, null), t);
    const r = core.rebaseRateLimits(map, t + 1000);
    assert.ok(Object.hasOwn(r, '__proto__'));
    assert.ok(core.activeRateLimit(r, '__proto__', t + 1000));
    assert.equal(core.anonymousRateLimits(r, t + 1000)[''].length, 1);
  });
  test('빠른 시계를 일부만 뒤로 고친 것은 "고쳤다"고 보지 않는다', () => {
    const localAt = 1_000_000_000_000;
    const problem = { serverAt: localAt - 2 * D, localAt };
    assert.equal(core.clockErrorLooksFixed(problem, localAt - 6 * MIN), false);
    assert.equal(core.clockErrorLooksFixed(problem, localAt - 2 * D + 10 * MIN), true);
  });
  test('사용자 없음/API 키 오류는 시계 오류보다 먼저 알린다', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const s = core.normalizeSettings({ handle: 'T' });
    const st = core.deriveStatus({ settings: s, lastError: { handle: 'T', code: 'auth', at: now }, clockProblem: true, nowMs: now });
    assert.equal(st.code, 'auth');
  });
});

describe('13차 리뷰: 시계 판단', () => {
  const D = 24 * 60 * 60 * 1000;
  test('10일 빠른 시계를 6일만 되돌린 것은 고친 것이 아니다', () => {
    const localAt = 2_000_000_000_000;
    const problem = { serverAt: localAt - 10 * D, localAt };
    assert.equal(core.clockErrorLooksFixed(problem, localAt - 6 * D), false);
    assert.equal(core.clockErrorLooksFixed(problem, localAt - 10 * D + 5 * MIN), true);
  });
  test('서버가 이미 보여 준 날보다 앞이면(시계가 뒤로 감) 오늘을 확신할 수 없다', () => {
    const now = Date.parse('2026-11-22T05:58:00+09:00');
    assert.equal(core.dayUncertain({ nowMs: now, serverSeenAt: Date.parse('2026-11-22T06:03:00+09:00') }), true);
    assert.equal(core.dayUncertain({ nowMs: now, serverSeenAt: Date.parse('2026-11-22T05:57:00+09:00') }), false);
  });
  test('미래 시각의 측정은 믿지 않는다', () => {
    const now = Date.parse('2026-11-22T06:10:00+09:00');
    const skew = -30 * MIN;
    assert.equal(core.dayUncertain({ nowMs: now, clockSkewMs: skew, skewCheckedAt: now + 30 * 1000 }), true);
  });
  test('다음에 오늘 확실성이 바뀌는 시각', () => {
    const now = Date.parse('2026-11-22T06:01:00+09:00');
    const skew = -60 * MIN; // 보정 시계 05:01
    const t = core.nextDayCertaintyChangeAt({ nowMs: now, clockSkewMs: skew, skewCheckedAt: now - 30 * 1000, lastAttemptTimed: true });
    assert.equal(t, now - 30 * 1000 + core.DAY_EVIDENCE_FRESH_MS + 1000);
    assert.equal(core.nextDayCertaintyChangeAt({ nowMs: now, clockSkewMs: 0 }), null);
  });
});

describe('15차 리뷰: 새 동작 고정', () => {
  test('측정을 믿는 시간은 시계 차이 방향에 따라 다르다', () => {
    assert.equal(core.dayEvidenceFreshMs(-30 * MIN), core.DAY_EVIDENCE_FRESH_MS, '빠른 시계: 2분');
    assert.equal(core.dayEvidenceFreshMs(9 * 60 * MIN), core.SETTLED_RECHECK_MS, '느린 시계: 30분');
  });
  test('오늘 확실성이 바뀌어 깨어나는 때는 내 시계의 06:00 + 18초이고, 보정 시계의 06:00은 아니다', () => {
    const now = Date.parse('2026-11-22T03:00:00+09:00');
    const skew = 2 * 60 * MIN; // 보정 시계 05:00
    const t = core.nextDayCertaintyChangeAt({ nowMs: now, clockSkewMs: skew });
    assert.equal(t, Date.parse('2026-11-22T06:00:18+09:00'));
    assert.notEqual(t, Date.parse('2026-11-22T06:00:00+09:00') - skew);
  });
  test('429 뒤에는 팝업 열기(page)도 재시도 간격 안에서는 건너뛴다', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const p = {
      policy: 'page',
      handle: 'T',
      snapshot: null,
      lastError: { handle: 'T', code: 'rate-limited', at: now },
      backoffUntil: null,
      rateLimitedUntil: null,
      lastAttemptAt: now - 2 * MIN,
      retryGapMs: 5 * MIN,
      nowMs: now,
      eNowMs: now,
    };
    assert.equal(core.shouldSkipRefresh(p), true);
    assert.equal(core.shouldSkipRefresh({ ...p, lastAttemptAt: now - 6 * MIN }), false);
    assert.equal(core.shouldSkipRefresh({ ...p, lastError: { handle: 'T', code: 'network', at: now } }), false, '다른 오류는 1분');
    assert.equal(core.shouldSkipRefresh({ ...p, policy: 'force' }), false, '지금 확인');
  });
});

describe('16차 리뷰: 06:00 반영 여유와 시계 근거', () => {
  test('보정 시계로 06:00 직후 여유(+3초) 안에 깨어나는 시각은 rollover와 같은 06:00:18로 미룬다', () => {
    const skew = -14 * 1000; // 내 시계가 14초 빠름
    const deviceWake = Date.parse('2026-11-22T06:00:15+09:00');
    assert.equal(core.deferPastRolloverGrace(deviceWake, skew), Date.parse('2026-11-22T06:00:32+09:00'));
    const outside = Date.parse('2026-11-22T06:10:00+09:00');
    assert.equal(core.deferPastRolloverGrace(outside, skew), outside);
    assert.equal(core.deferPastRolloverGrace(deviceWake, 0), Date.parse('2026-11-22T06:00:18+09:00'), 'rollover와 같은 때');
  });

  test('06:00 직후 여유 안에 받은 정보는 여유가 지나면 다시 확인한다', () => {
    const fetchedAt = Date.parse('2026-11-22T06:00:05+09:00');
    const snapshot = { handle: 'a', dayKey: '2026-11-22', fetchedAt, countedToday: true, vacation: null };
    const base = { policy: 'auto', handle: 'a', snapshot };
    const inGrace = Date.parse('2026-11-22T06:00:10+09:00');
    const after = Date.parse('2026-11-22T06:00:16+09:00');
    assert.equal(core.shouldSkipRefresh({ ...base, nowMs: inGrace, eNowMs: inGrace }), true);
    assert.equal(core.shouldSkipRefresh({ ...base, nowMs: after, eNowMs: after }), false);
    const later = { ...snapshot, fetchedAt: Date.parse('2026-11-22T06:00:20+09:00') };
    const t = Date.parse('2026-11-22T06:05:00+09:00');
    assert.equal(core.shouldSkipRefresh({ ...base, snapshot: later, nowMs: t, eNowMs: t }), true);
  });

  test('429로 미룬 확인이 남아 있으면 최근 정보가 있어도 확인한다(대기는 지킨다)', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const snapshot = { handle: 'a', dayKey: '2026-11-21', fetchedAt: now - 5 * MIN, countedToday: true, vacation: null };
    const p = { policy: 'auto', handle: 'a', snapshot, nowMs: now, eNowMs: now };
    assert.equal(core.shouldSkipRefresh(p), true);
    assert.equal(core.shouldSkipRefresh({ ...p, retryOwed: true }), false);
    assert.equal(core.shouldSkipRefresh({ ...p, retryOwed: true, rateLimitedUntil: now + MIN }), true);
  });

  test('시계가 뒤로 간 것을 감지한 뒤에는 오늘을 확신하지 않는다', () => {
    const now = Date.parse('2026-11-22T05:05:00+09:00');
    assert.equal(core.dayUncertain({ nowMs: now }), false);
    assert.equal(core.dayUncertain({ nowMs: now, evidenceLost: true }), true);
  });
});

describe('채점 사이트에서 다시 불러오기', () => {
  const now = Date.parse('2026-11-21T20:00:00+09:00');
  const recent = [{ day: '2026-11-20', solvedCount: 0 }, { day: '2026-11-21', solvedCount: 0 }];
  const snap = { handle: 'Taeyang', dayKey: '2026-11-21', countedToday: false, todaySolvedCount: 0, currentStreak: 5, recent };
  const watch = { handle: 'Taeyang', since: now, until: now + core.REIMPORT_WATCH_MS, base: core.reimportBaseOf(snap) };
  const p = { watch, handle: 'taeyang', statusKind: 'unsolved', snapshot: snap, nowMs: now };
  test('누른 뒤 2분마다, 기간 안에서만', () => {
    assert.equal(core.reimportRecheckAt(p), now + 2 * MIN);
    assert.equal(core.reimportRecheckAt({ ...p, lastAttemptAt: now + 3 * MIN, nowMs: now + 3 * MIN }), now + 5 * MIN);
    assert.equal(core.reimportRecheckAt({ ...p, lastAttemptAt: now + 9 * MIN, nowMs: now + 9 * MIN }), null);
    assert.equal(core.reimportRecheckAt({ ...p, nowMs: now + 10 * MIN }), null);
  });
  test('확인 결과가 달라졌거나(반영됨), 다른 핸들이거나, 기록이 이상하면 하지 않는다', () => {
    assert.equal(core.reimportRecheckAt({ ...p, snapshot: { ...snap, countedToday: true, todaySolvedCount: 1 } }), null);
    assert.equal(core.reimportRecheckAt({ ...p, snapshot: { ...snap, recent: [{ day: '2026-11-20', solvedCount: 2 }] } }), null);
    assert.equal(core.reimportRecheckAt({ ...p, statusKind: 'setup' }), null);
    assert.equal(core.reimportRecheckAt({ ...p, handle: 'Other' }), null);
    assert.equal(core.reimportRecheckAt({ ...p, watch: null }), null);
    assert.equal(core.reimportRecheckAt({ ...p, nowMs: now - 5 * MIN }), null, '시계가 뒤로 감');
    assert.equal(core.reimportRecheckAt({ ...p, watch: { ...watch, until: now + 60 * MIN } }), null, '너무 긴 기간');
  });
  test('오류 상태(대기 등)여도 기간 안이면 다시 확인 시각을 준다(요청은 대기·백오프가 정한다)', () => {
    assert.equal(core.reimportRecheckAt({ ...p, statusKind: 'error' }), now + 2 * MIN);
  });
  test('이미 푼 상태에서 눌러도, 바뀌기 전까지는 최근 정보가 있어도 확인할 때가 된다', () => {
    const solved = { ...snap, countedToday: true, todaySolvedCount: 1, fetchedAt: now + MIN };
    const w = { ...watch, base: core.reimportBaseOf(solved) };
    const q = { ...p, watch: w, snapshot: solved, statusKind: 'solved' };
    assert.equal(core.reimportDue({ ...q, nowMs: now + MIN }), false);
    assert.equal(core.reimportDue({ ...q, nowMs: now + 2 * MIN }), true);
    const base = { policy: 'auto', handle: 'Taeyang', snapshot: solved, nowMs: now + 2 * MIN, eNowMs: now + 2 * MIN };
    assert.equal(core.shouldSkipRefresh(base), true);
    assert.equal(core.shouldSkipRefresh({ ...base, reimportDue: true }), false);
    assert.equal(core.shouldSkipRefresh({ ...base, reimportDue: true, rateLimitedUntil: now + 3 * MIN }), true);
  });
});

describe('17차 리뷰 회귀 테스트', () => {
  test('응답이 만들어진 시각은 서버 Date를 먼저 쓰고, 06:00 직후 여유 안이면 잠정이다', () => {
    const dayKey = '2026-11-22';
    assert.equal(core.dayStartMs(dayKey), Date.parse('2026-11-22T06:00:00+09:00'));
    const corrected = Date.parse('2026-11-22T06:00:16+09:00');
    const date = new Date(Date.parse('2026-11-22T06:00:13+09:00')).toUTCString();
    assert.equal(core.responseMadeAt(date, corrected), Date.parse('2026-11-22T06:00:13+09:00'));
    assert.equal(core.madeInRolloverGrace(core.responseMadeAt(date, corrected), dayKey), true);
    assert.equal(core.madeInRolloverGrace(Date.parse('2026-11-22T06:00:15+09:00'), dayKey), false);
    assert.equal(core.responseMadeAt(null, corrected), corrected);
  });

  test('잠정 정보는 오늘 상태로 쓰지 않고, 여유가 끝나면 다시 확인한다', () => {
    const now = Date.parse('2026-11-22T06:00:20+09:00');
    const snapshot = {
      handle: 'a', dayKey: '2026-11-22', fetchedAt: Date.parse('2026-11-22T06:00:16+09:00'), provisional: true,
      countedToday: true, vacation: null, currentStreak: 3, maxStreak: 3, todaySolvedCount: 1, recent: [],
    };
    const settings = { ...core.DEFAULT_SETTINGS, handle: 'a' };
    assert.equal(core.deriveStatus({ settings, snapshot, nowMs: now }).kind, 'checking');
    assert.equal(core.deriveStatus({ settings, snapshot, rateLimited: true, nowMs: now }).kind, 'error');
    assert.equal(core.shouldSkipRefresh({ policy: 'auto', handle: 'a', snapshot, nowMs: now, eNowMs: now }), false);
    const inGrace = Date.parse('2026-11-22T06:00:10+09:00');
    assert.equal(core.shouldSkipRefresh({ policy: 'auto', handle: 'a', snapshot, nowMs: inGrace, eNowMs: inGrace }), true);
  });

  test('이미 본 내 시각보다 1분 넘게 앞이면 오늘을 확신하지 않는다', () => {
    const now = Date.parse('2026-11-22T05:50:00+09:00');
    assert.equal(core.dayUncertain({ nowMs: now, localSeenAt: now + 30 * 1000 }), false);
    assert.equal(core.dayUncertain({ nowMs: now, localSeenAt: now + 10 * MIN }), true);
  });

  test('429 대기 기록의 마지막 확인 시각으로도 시계가 뒤로 간 것을 안다(익명 대기 포함)', () => {
    const now = 2_000_000_000_000;
    assert.equal(core.rateLimitsSeenAhead({ cid: { at: now - MIN, seen: now + 10 * MIN, ms: 60 * MIN } }, now), true);
    assert.equal(core.rateLimitsSeenAhead({ '': [{ at: now - MIN, seen: now + 10 * MIN, ms: 60 * MIN }] }, now), true);
    assert.equal(core.rateLimitsSeenAhead({ cid: { at: now - MIN, seen: now, ms: 60 * MIN } }, now), false);
    assert.equal(core.rateLimitsSeenAhead(null, now), false);
  });

  test('다른 핸들의 핸들별 상태는 쓰지 않는다', () => {
    const local = { stateHandle: 'Alice', snoozeDayKey: '2026-11-21', lastError: { code: 'network' }, snapshot: { handle: 'Alice' } };
    assert.equal(core.ownedState(local, 'alice'), local);
    const other = core.ownedState(local, 'Bobby');
    assert.equal(other.snoozeDayKey, undefined);
    assert.equal(other.lastError, undefined);
    assert.ok(other.snapshot, '핸들별 상태가 아닌 것은 남김');
  });

  test('다시 불러오기: 요청할 수 있는 때 전에는 깨어나지 않고, 기간을 넘기면 하지 않는다', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const watch = { handle: 'a', since: now, until: now + core.REIMPORT_WATCH_MS, base: null, dayKey: '2026-11-21' };
    const p = { watch, handle: 'a', statusKind: 'error', nowMs: now + 3 * MIN, lastAttemptAt: now - MIN };
    assert.equal(core.reimportRecheckAt({ ...p, notBefore: now + 6 * MIN }), now + 6 * MIN);
    assert.equal(core.reimportRecheckAt({ ...p, notBefore: now + 15 * MIN }), null);
  });
});

describe('18차 리뷰 회귀 테스트', () => {
  test('1분 안쪽의 되돌림이라도 이미 본 solved.ac 날보다 앞이면 오늘을 확신하지 않는다', () => {
    const seen = Date.parse('2026-11-22T06:00:18+09:00');
    const now = Date.parse('2026-11-22T05:59:40+09:00');
    assert.equal(core.dayUncertain({ nowMs: now, localSeenAt: seen }), true);
    assert.equal(core.dayUncertain({ nowMs: seen + 10 * 1000, localSeenAt: seen }), false);
  });

  test('다시 불러오기: 날이 바뀌어 최근 7일 창이 밀린 것만으로는 반영으로 보지 않는다', () => {
    const recent21 = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'].map((day) => ({ day, solvedCount: day === '2026-11-20' ? 2 : 0 }));
    const recent22 = [...recent21.slice(1), { day: '2026-11-22', solvedCount: 0 }];
    const base = core.reimportBaseOf({ dayKey: '2026-11-21', countedToday: false, todaySolvedCount: 0, currentStreak: 3, recent: recent21 });
    assert.equal(core.reimportReflected(base, { dayKey: '2026-11-22', countedToday: false, todaySolvedCount: 0, currentStreak: 0, recent: recent22 }), false);
    const filled = recent22.map((d) => (d.day === '2026-11-21' ? { ...d, solvedCount: 1 } : d));
    assert.equal(core.reimportReflected(base, { dayKey: '2026-11-22', countedToday: false, todaySolvedCount: 0, currentStreak: 4, recent: filled }), true);
  });

  test('다시 불러오기: 다른 핸들의 결과로는 끝내지 않는다(누를 때 오늘 정보가 없었어도)', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const watch = { handle: 'Other', dayKey: '2026-11-21', since: now, until: now + core.REIMPORT_WATCH_MS, base: null };
    const solvedByOld = { handle: 'Taeyang', dayKey: '2026-11-21', countedToday: true, recent: [] };
    assert.equal(core.reimportWatchDone({ watch, snapshot: solvedByOld, nowMs: now + MIN }), false);
    assert.equal(core.reimportWatchDone({ watch, snapshot: { ...solvedByOld, handle: 'other' }, nowMs: now + MIN }), true);
    assert.equal(core.reimportWatchDone({ watch, snapshot: null, nowMs: now + core.REIMPORT_WATCH_MS }), true, '기간 지남');
  });

  test('다시 불러오기: 기간 끝과 같은 때에는 헛되이 깨어나지 않는다', () => {
    const now = Date.parse('2026-11-21T20:00:00+09:00');
    const watch = { handle: 'a', dayKey: '2026-11-21', since: now, until: now + core.REIMPORT_WATCH_MS, base: null };
    const p = { watch, handle: 'a', statusKind: 'unsolved', nowMs: now + 8 * MIN, lastAttemptAt: now + 8 * MIN };
    assert.equal(core.reimportRecheckAt(p), null);
  });
});

describe('19차 리뷰 회귀 테스트', () => {
  test('마지막 요청이 이미 지금보다 뒤의 solved.ac 날이면 오늘을 확신하지 않는다', () => {
    const now = Date.parse('2026-11-22T05:59:51+09:00');
    assert.equal(core.dayUncertain({ nowMs: now, lastAttemptAt: Date.parse('2026-11-22T06:00:03+09:00') }), true);
    assert.equal(core.dayUncertain({ nowMs: now, lastAttemptAt: Date.parse('2026-11-22T05:59:30+09:00') }), false);
  });

  test('다시 불러오기: 누를 때 이미 있던 결과나 잠정 결과로는 끝내지 않는다', () => {
    const now = Date.parse('2026-11-22T05:59:59+09:00');
    const snap = { handle: 'a', dayKey: '2026-11-22', fetchedAt: Date.parse('2026-11-22T06:00:32+09:00'), countedToday: true, recent: [] };
    const watch = { handle: 'a', dayKey: '2026-11-21', since: now, until: now + core.REIMPORT_WATCH_MS, base: null, baseFetchedAt: snap.fetchedAt };
    assert.equal(core.reimportWatchDone({ watch, snapshot: snap, nowMs: now + MIN }), false, '이미 있던 결과');
    const fresh = { ...snap, fetchedAt: snap.fetchedAt + 2 * MIN };
    assert.equal(core.reimportWatchDone({ watch, snapshot: { ...fresh, provisional: true }, nowMs: now + MIN }), false, '잠정');
    assert.equal(core.reimportWatchDone({ watch, snapshot: fresh, nowMs: now + MIN }), true);
  });
});
