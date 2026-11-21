"""Solved Streak Checker E2E 테스트 (Playwright + Chromium).

확장 프로그램을 실제 Chromium에 로드하고, solved.ac API 응답은 가짜로 바꿔서
설정 저장(자격 증명 검증)/팝업/배지/알림/백오프/페이지 방문/설정 탭/마이그레이션 흐름을 끝까지 확인한다.

실제 solved.ac에는 절대 요청하지 않는다:
  * Chromium을 --host-resolver-rules로 띄워 solved.ac 도메인 이름 해석 자체를 막는다.
  * 서비스 워커의 fetch는 MOCK_FETCH_JS로, 탭의 solved.ac 요청은 Playwright route로 가짜 응답한다.

사용법:
    python -I tests/e2e/run_e2e.py                 # 테스트
    python -I tests/e2e/run_e2e.py --screenshots   # + readme_images/ 스크린샷 갱신
    python -I tests/e2e/run_e2e.py --headed        # 브라우저 창을 띄워서 실행

필요: pip install playwright && playwright install chromium
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, Worker, sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "readme_images"
CLIENT_ID = "test-client-id"
CLIENT_SECRET = "test-client-secret-e2e"

# 서비스 워커의 fetch를 가짜로 바꾼다. 요청한 from/to에 맞춰 날짜를 만들어 주므로 항상 "오늘" 데이터가 된다.
# 실제 API처럼 x-client-id / x-client-secret 헤더를 검사한다.
MOCK_FETCH_JS = r"""
([mode, clientId, clientSecret]) => {
  // Chrome의 알림 바인딩도 아이콘을 fetch로 읽으므로 solved.ac 요청만 가짜로 응답하고 나머지는 원래 fetch로 넘긴다.
  self.__sscRealFetch = self.__sscRealFetch || self.fetch.bind(self);
  self.__sscMock = { mode, calls: [] };
  self.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== 'https://solved.ac') return self.__sscRealFetch(input, init);
    const h = new Headers(init.headers || {});
    self.__sscMock.calls.push({ url: url.href, credentials: init.credentials, redirect: init.redirect,
      hasId: h.get('x-client-id') === clientId, hasSecret: h.has('x-client-secret') });
    const m = self.__sscMock.mode;
    if (self.__sscMock.delayMs) await new Promise((r) => setTimeout(r, self.__sscMock.delayMs));
    const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json', date: new Date().toUTCString(), ...extra } });
    if (!h.get('x-client-id') || !h.get('x-client-secret'))
      return json(401, { error: { code: 'MISSING_CLIENT_CREDENTIALS', message: 'x-client-id and x-client-secret headers are required.' } });
    if (h.get('x-client-id') !== clientId || h.get('x-client-secret') !== clientSecret)
      return json(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid client credentials.' } });
    const handle = decodeURIComponent(url.pathname.split('/')[4] || '');
    if (m === 'network') throw new TypeError('Failed to fetch');
    if (m === 'blocked') return new Response('<!DOCTYPE html><title>Just a moment...</title>', {
      status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' } });
    if (m === 'rate-limited') return json(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, { 'retry-after': '600' });
    if (handle.toLowerCase() === 'nosuchuser') return json(404, { error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const to = url.searchParams.get('to');
    const day = (offset) => { const d = new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
    const base = { from: url.searchParams.get('from'), to, maxSolvedCount: 3, theme: null, firstActiveDay: '2021-08-09', vacations: [] };
    const history = [
      { day: day(-6), solvedCount: 1 }, { day: day(-5), solvedCount: 3 }, { day: day(-4), solvedCount: 0, freezeUsed: true },
      { day: day(-3), solvedCount: 2 }, { day: day(-2), solvedCount: 1 }, { day: day(-1), solvedCount: 1 },
    ].map((d) => ({ maxSolvedLevel: 5, ratingDelta: 0, freezeUsed: false, streakRepaired: false, ...d }));
    if (m === 'solved') return json(200, { ...base, days: [...history, { day: to, solvedCount: 2, maxSolvedLevel: 8, ratingDelta: 4, freezeUsed: false, streakRepaired: false }],
      currentStreak: 1184, maxStreak: 1184, vacation: null, countedToday: true, frozenYesterday: false });
    if (m === 'unsolved') return json(200, { ...base, days: history, currentStreak: 1183, maxStreak: 1183, vacation: null, countedToday: false, frozenYesterday: false });
    if (m === 'vacation') return json(200, { ...base, days: [], currentStreak: 120, maxStreak: 340,
      vacation: { fromDay: day(-3), source: 'item' }, countedToday: false, frozenYesterday: false });
    throw new Error('unknown mock mode ' + m);
  };
}
"""


class Failure(Exception):
    pass


def next_boundary(t: float) -> float:
    """t 이후 처음 오는 06:00 KST (epoch 초)"""
    shift = 3 * 3600  # KST(+9) - 6시간
    return (int((t + shift) // 86400) + 1) * 86400 - shift


def next_rollover(t: float) -> float:
    return next_boundary(t - 18) + 18  # 06:00:18 KST (반영 여유 15초 + 시계 오차 여유 3초)


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise Failure(msg)
    print(f"  ✔ {msg}")


def wait_until(page: Page, fn, msg: str, timeout: float = 10.0, interval_ms: int = 150):
    """조건이 참이 될 때까지 기다린다. page.wait_for_timeout을 써야 Playwright 이벤트가 처리된다."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            print(f"  ✔ {msg}")
            return last
        page.wait_for_timeout(interval_ms)
    raise Failure(f"{msg} (마지막 값: {last!r})")


class Harness:
    def __init__(self, ctx: BrowserContext):
        self.ctx = ctx
        self.sw: Worker = next((w for w in ctx.service_workers if w.url.startswith("chrome-extension://")), None) \
            or ctx.wait_for_event("serviceworker", timeout=20000)
        self.ext_id = self.sw.url.split("/")[2]
        self.popup: Page | None = None

    def mock(self, mode: str):
        self.sw.evaluate(MOCK_FETCH_JS, [mode, CLIENT_ID, CLIENT_SECRET])

    def set_mode(self, mode: str):
        self.sw.evaluate("(m) => { if (!self.__sscMock) throw new Error('mock missing'); self.__sscMock.mode = m; }", mode)

    def set_delay(self, ms: int):
        self.sw.evaluate("(ms) => { self.__sscMock.delayMs = ms; }", ms)

    def calls(self) -> list:
        return self.sw.evaluate("() => self.__sscMock ? self.__sscMock.calls : []")

    def open_popup(self) -> Page:
        if self.popup and not self.popup.is_closed():
            self.popup.close()
        page = self.ctx.new_page()
        page.set_viewport_size({"width": 340, "height": 900})
        # ?harness: 설정 탭(options_ui, popup.html)과 다른 주소로 열어 openOptionsPage가 새 탭을 열게 한다.
        page.goto(f"chrome-extension://{self.ext_id}/popup.html?harness")
        page.wait_for_selector("#statusTitle")
        self.popup = page
        return page

    def ext_eval(self, js: str, arg=None):
        """확장 프로그램 페이지(팝업)에서 chrome.* API를 실행한다."""
        assert self.popup is not None
        return self.popup.evaluate(js, arg)

    def badge(self) -> str:
        return self.ext_eval("() => chrome.action.getBadgeText({})")

    def notifications(self) -> dict:
        return self.ext_eval("() => chrome.notifications.getAll()")

    def local(self) -> dict:
        return self.ext_eval("() => chrome.storage.local.get(null)")

    def sync(self) -> dict:
        return self.ext_eval("() => chrome.storage.sync.get(null)")

    def alarms(self) -> dict:
        return {a["name"]: a for a in self.ext_eval("() => chrome.alarms.getAll()")}

    def title(self) -> str:
        assert self.popup is not None
        return self.popup.inner_text("#statusTitle")

    def wait(self, fn, msg: str, timeout: float = 10.0):
        assert self.popup is not None
        return wait_until(self.popup, fn, msg, timeout)

    def idle(self, ms: int = 800):
        assert self.popup is not None
        self.popup.wait_for_timeout(ms)

    def shot(self, name: str, enabled: bool, settings_open: bool = False):
        if not enabled or not self.popup:
            return
        SHOTS.mkdir(exist_ok=True)
        page = self.popup
        was_open = page.evaluate("() => document.getElementById('settings').open")
        page.evaluate("(o) => { document.getElementById('settings').open = o; document.activeElement?.blur(); "
                      "document.getElementById('saveStatus').textContent = ''; }", settings_open)
        page.locator("main.app").screenshot(path=str(SHOTS / name))
        page.evaluate("(o) => { document.getElementById('settings').open = o; }", was_open)
        print(f"  📸 readme_images/{name}")


def fill_settings(popup: Page, handle: str, client_id: str | None = CLIENT_ID, secret: str | None = CLIENT_SECRET,
                  interval: str | None = None, start_hours: str = "24"):
    popup.evaluate("() => { document.getElementById('settings').open = true; }")
    popup.fill("#handleInput", handle)
    if client_id is not None:
        popup.fill("#clientIdInput", client_id)
    if secret is not None:
        popup.fill("#clientSecretInput", secret)
    if interval is not None:
        popup.fill("#intervalInput", interval)
    if popup.is_enabled("#notifyStart"):
        popup.select_option("#notifyStart", start_hours)
    popup.click("#saveButton")


def run(headed: bool, screenshots: bool) -> int:
    with sync_playwright() as p:
        user_data = tempfile.mkdtemp(prefix="ssc-e2e-")
        page_api_hits: list[str] = []

        def route_solved(route, request):
            # 탭에서 solved.ac를 열면 가짜 페이지를 준다. 확장은 페이지의 API를 읽지 않으므로 API 요청이 오면 기록만 한다.
            if "/api/" in request.url:
                page_api_hits.append(request.url)
                route.fulfill(status=404, body="")
            elif request.resource_type == "document":
                route.fulfill(status=200, content_type="text/html; charset=utf-8",
                              body="<!doctype html><html><head><title>solved.ac (mock)</title></head><body>mock</body></html>")
            else:
                route.fulfill(status=404, body="")

        def launch() -> BrowserContext:
            c = p.chromium.launch_persistent_context(
                user_data,
                channel="chromium",
                headless=not headed,
                locale="ko-KR",
                timezone_id="Asia/Seoul",
                color_scheme="light",
                args=[
                    f"--disable-extensions-except={ROOT}",
                    f"--load-extension={ROOT}",
                    # 실수로라도 실제 solved.ac에 닿지 않도록 이름 해석을 막는다(가짜 fetch를 넣기 전의 요청 포함).
                    "--host-resolver-rules=MAP solved.ac ~NOTFOUND, MAP *.solved.ac ~NOTFOUND",
                    "--disable-lcd-text",  # 스크린샷 글자에 색 번짐이 생기지 않게
                ],
            )
            c.grant_permissions(["notifications"])
            c.route("https://solved.ac/**", route_solved)
            return c

        ctx = launch()
        h = Harness(ctx)
        h.mock("solved")

        def open_solved_tab() -> Page:
            tab = ctx.new_page()
            tab.goto("https://solved.ac/u/Taeyang")
            return tab

        try:
            print("[1] 설치 직후: 설정 안내")
            popup = h.open_popup()
            check("핸들을 설정" in h.title(), "설정 안내 문구")
            check(popup.locator("#settings").get_attribute("open") is not None, "설정 패널이 열려 있음")
            check(h.badge() == "…", "설정 필요 배지 …")
            check(h.notifications() == {}, "막 설치했을 때는 알림 없음")
            alarms = h.alarms()
            check(sorted(alarms) == ["poll", "rollover"], f"알람 등록: {sorted(alarms)}")
            check(alarms["poll"]["periodInMinutes"] == 5, "기본 확인 주기 5분")
            check(abs(alarms["rollover"]["scheduledTime"] / 1000 - next_rollover(time.time())) < 90, "하루 경계(06:00:15 KST) 알람")
            check(any(pg.url.endswith("/popup.html") for pg in ctx.pages), "설치하면 설정 탭이 열림")
            check(popup.get_attribute("#appsLink", "href") == "https://backstage.solved.ac/developer/apps", "앱 등록 링크")
            h.shot("screenshot_popup_initial.png", screenshots, settings_open=True)

            print("[2] 입력 검증")
            fill_settings(popup, "a b")
            check("영문, 숫자" in popup.inner_text("#saveStatus"), "잘못된 핸들 거부")
            fill_settings(popup, "Taeyang", secret="")
            check("클라이언트 ID와 시크릿" in popup.inner_text("#saveStatus"), "시크릿 없음 거부")
            fill_settings(popup, "Taeyang", interval="0")
            check("확인 주기" in popup.inner_text("#saveStatus"), "잘못된 주기 거부")
            check(h.calls() == [], "검증 실패 시 요청 없음")
            check(h.sync().get("handle") is None, "아무것도 저장되지 않음")
            fill_settings(popup, "Taeyang", client_id="", secret="", interval="5")
            h.wait(lambda: "알림 설정과 핸들(Taeyang)을 저장" in popup.inner_text("#saveStatus"), "API 키 없이 알림 설정(과 입력한 핸들)만 저장")
            check(h.sync().get("notifyStartHours") == 24, "알림 설정 저장")
            check(h.sync().get("handle") == "Taeyang", "직접 입력한 핸들은 함께 저장(키를 넣을 때 확인)")
            check(h.title() == "solved.ac API 키가 필요해요", "API 키 안내")
            check(h.calls() == [], "요청 없음")

            print("[3] 없는 사용자 / 틀린 API 키는 저장하지 않음")
            fill_settings(popup, "NoSuchUser", interval="5")
            h.wait(lambda: "찾을 수 없어요" in popup.inner_text("#saveStatus"), "사용자 없음 안내")
            fill_settings(popup, "Taeyang", secret="wrong-secret")
            h.wait(lambda: "받아주지 않았어요" in popup.inner_text("#saveStatus"), "틀린 API 키 안내")
            check(popup.get_attribute("#clientSecretInput", "aria-invalid") == "true", "시크릿 입력칸 표시")
            check(h.sync().get("handle") == "Taeyang" and "apiCredentials" not in h.local(), "핸들/키 바뀌지 않음")

            print("[4] 프로필 주소 + API 키로 저장 → 오늘 해결")
            fill_settings(popup, "https://solved.ac/ko/u/Taeyang", interval="3")
            h.wait(lambda: "저장했어요" in popup.inner_text("#saveStatus"), "저장 완료")
            check(h.sync().get("handle") == "Taeyang", "URL에서 핸들 추출")
            check(popup.input_value("#handleInput") == "Taeyang", "입력창도 정규화")
            check("apiCredentials" not in h.sync(), "API 키는 동기화 저장소에 없음")
            check(h.local()["apiCredentials"] == {"clientId": CLIENT_ID, "clientSecret": CLIENT_SECRET}, "API 키는 local에만")
            check(popup.input_value("#clientSecretInput") == "", "저장 후 시크릿 입력칸 비움")
            check("저장됨" in (popup.get_attribute("#clientSecretInput", "placeholder") or ""), "저장됨 표시")
            check(CLIENT_SECRET not in popup.content(), "시크릿이 화면(DOM)에 없음")
            h.wait(lambda: h.title() == "오늘 문제 해결 완료!", "해결 상태 표시")
            check(popup.inner_text("#currentStreak") == "1,184일", "현재 스트릭")
            check(popup.inner_text("#todaySolved") == "2개", "오늘 푼 문제")
            check(popup.locator("#recent li").count() == 7, "최근 7일 표시")
            check(popup.locator('#recent li[data-today="true"][data-state="solved"]').count() == 1, "오늘 칸 = 해결")
            check(popup.locator('#recent li[data-state="freeze"]').count() == 1, "프리즈 사용일 표시")
            check(h.badge() == "✓", "배지 ✓")
            check(h.notifications() == {}, "알림 없음")
            check(h.alarms()["poll"]["periodInMinutes"] == 3, "확인 주기 변경 반영")
            calls = h.calls()
            check(all(c["hasId"] and c["hasSecret"] for c in calls[-1:]), "x-client-id/x-client-secret 헤더")
            check(all(c["credentials"] == "omit" and c["redirect"] == "error" for c in calls), "쿠키·리디렉트 없음")
            check(all(c["url"].startswith("https://solved.ac/api/v4/users/") for c in calls), "v4 API만 요청")
            h.shot("screenshot_popup_solved.png", screenshots)

            print("[5] 오늘 안 풀었음 → 알림 + 다시 알림 예약")
            h.set_mode("unsolved")
            popup.click("#refreshButton")
            h.wait(lambda: h.title() == "오늘 아직 문제를 풀지 않았어요", "미해결 상태 표시")
            check("오늘 마감" in popup.inner_text("#deadline"), "마감 시각 표시")
            check(h.badge() == "!", "배지 !")
            notes = h.wait(lambda: h.notifications(), "알림 생성")
            check(len(notes) == 1 and list(notes)[0].endswith("|Taeyang|unsolved"), "알림 ID에 날짜·핸들·원인")
            state = h.local()["notifHistory"]["reminder"]
            check(h.local()["shownId"] == list(notes)[0], "띄운 알림 기록")
            wake = h.alarms().get("wake")
            remind_at = state["shownAt"] / 1000 + 3600
            if remind_at < next_boundary(time.time()):
                check(wake is not None and abs(wake["scheduledTime"] / 1000 - remind_at) < 5, "확인 주기와 별개로 1시간 뒤 다시 알림 알람")
            else:
                check(wake is None, "마감 뒤로는 다시 알림 알람을 걸지 않음")
            check(popup.is_visible("#snoozeButton"), "'오늘은 그만 알림' 버튼")
            h.shot("screenshot_popup_not_solved.png", screenshots)

            print("[6] 다시 확인해도 알림 간격 안에서는 재생성하지 않음")
            popup.click("#refreshButton")
            h.wait(lambda: not popup.is_disabled("#refreshButton"), "새로고침 끝")
            check(h.local()["notifHistory"]["reminder"]["shownAt"] == state["shownAt"], "같은 알림 유지")

            print("[7] 오늘은 그만 알림 / 다시 켜기")
            popup.click("#snoozeButton")
            h.wait(lambda: h.notifications() == {}, "알림 닫힘")
            h.wait(lambda: "오늘은 알림을 끈 상태" in popup.inner_text("#notes"), "끔 안내")
            check("wake" not in h.alarms(), "다시 알림 알람 해제")
            check(popup.inner_text("#snoozeButton") == "오늘 알림 다시 켜기", "다시 켜기 버튼")
            popup.click("#snoozeButton")
            h.wait(lambda: h.notifications() != {}, "알림 다시 표시")

            print("[7-1] 채점 사이트에서 다시 불러오기: 연동 설정을 열고 몇 분 동안 더 자주 확인")
            check(popup.is_visible("#reimportButton"), "'채점 사이트에서 다시 불러오기' 버튼")
            with ctx.expect_page() as page_info:
                popup.click("#reimportButton")
            integ = page_info.value
            # 확장이 연 탭의 첫 이동은 가짜 응답(route)보다 먼저 일어날 수 있어 오류 페이지가 될 수 있다(이름 해석을 막아 둠).
            # 그래서 화면이 아니라 Chrome이 기록한 탭 주소로 확인한다.
            urls = h.ext_eval("async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl || t.url)")
            check("https://solved.ac/settings/integrations" in urls, f"solved.ac 연동 설정을 엶 ({urls})")
            integ.close()
            watch = h.wait(lambda: h.local().get("reimportWatch"), "다시 확인 기간 기록")
            check(watch["handle"] == "Taeyang" and watch["until"] - watch["since"] == 600000, "10분 동안")
            wake = h.wait(lambda: h.alarms().get("wake"), "다시 확인 예약")
            check(wake["scheduledTime"] / 1000 - time.time() <= 125, "2분 안에 다시 확인")
            h.wait(lambda: "기다리는 중" in popup.inner_text("#reimportHint"), "기다리는 중 안내")
            h.ext_eval("() => chrome.storage.local.remove('reimportWatch')")  # 뒤 단계의 알람 검사에 섞이지 않게

            print("[8] 문제를 풀면 알림이 사라짐")
            h.set_mode("solved")
            popup.click("#refreshButton")
            h.wait(lambda: h.notifications() == {}, "알림 제거")
            check(h.badge() == "✓", "배지 ✓")
            check(popup.is_visible("#reimportButton") and "빠져 있다면" in popup.inner_text("#reimportHint"),
                  "풀었어도 다시 불러오기 버튼(안내는 다름)")
            check("다음 날 시작" in popup.inner_text("#deadline"), "해결 후에는 다음 날 시작 표시")

            print("[9] 휴가")
            h.set_mode("vacation")
            popup.click("#refreshButton")
            h.wait(lambda: h.title() == "스트릭 휴가 중", "휴가 표시")
            check(h.badge() == "휴", "배지 휴")
            check(h.notifications() == {}, "알림 없음")
            h.shot("screenshot_popup_vacation.png", screenshots)

            print("[10] 일시적 네트워크 오류 1회: 조용히, 오늘 정보 유지, 재시도 예약")
            h.set_mode("unsolved")
            popup.click("#refreshButton")
            h.wait(lambda: h.title() == "오늘 아직 문제를 풀지 않았어요", "미해결")
            h.ext_eval("async () => { const { shownId } = await chrome.storage.local.get('shownId'); if (shownId) await chrome.notifications.clear(shownId); }")
            h.set_mode("network")
            popup.click("#refreshButton")
            h.wait(lambda: "최근 확인에 실패" in popup.inner_text("#notes"), "stale 안내")
            check(h.title() == "오늘 아직 문제를 풀지 않았어요", "마지막 정보 유지")
            local = h.local()
            check(local["consecutiveFailures"] == 1 and local["lastError"]["code"] == "network", "실패 1회 기록")
            check("wake" in h.alarms(), "재시도 알람 예약")

            print("[11] Cloudflare 차단(오늘 정보 있음) → 오류로 표시, 백오프")
            h.set_mode("blocked")
            popup.click("#refreshButton")
            h.wait(lambda: h.title() == "solved.ac 보안 확인에 막혔어요", "예전 미해결 정보 대신 보안 확인 오류 표시")
            check("마지막으로 확인한 값" in popup.inner_text("#notes"), "마지막 정보 안내")
            check(not popup.is_hidden("#stats"), "마지막 통계는 계속 표시")
            check(h.badge() == "?", "배지 ?")
            h.wait(lambda: str(h.local().get("shownId", "")).endswith("|error:blocked"), "오류 알림(하루 한 번)")
            backoff_min = (h.local()["backoffUntil"] - time.time() * 1000) / 60000
            check(14 < backoff_min <= 15.1, f"15분 백오프 ({backoff_min:.1f}분)")
            n_calls = len(h.calls())
            tab = open_solved_tab()
            h.idle(1500)
            check(len(h.calls()) == n_calls, "백오프 중에는 solved.ac 방문으로도 요청하지 않음")
            tab.close()
            h.shot("screenshot_popup_unknown.png", screenshots)

            print("[12] 429 응답으로 저장해도 Retry-After를 지킨다 (중복 요청 없음)")
            h.set_mode("rate-limited")
            n_calls = len(h.calls())
            fill_settings(popup, "OtherUser", client_id=None, secret=None)
            h.wait(lambda: "다만 지금은 확인하지 못했어요" in popup.inner_text("#saveStatus"), "저장 + 경고")
            h.idle(1500)
            check(len(h.calls()) == n_calls + 1, f"요청 1번만 ({len(h.calls()) - n_calls})")
            local = h.local()
            check(local["lastError"]["handle"] == "OtherUser", "새 핸들의 실패 기록")
            wait = local["rateLimits"][CLIENT_ID]
            check(wait["ms"] == 600 * 1000 and wait["at"] + wait["ms"] - time.time() * 1000 > 500 * 1000,
                  "Retry-After(600초)를 앱 단위로 기억")
            popup.click("#refreshButton") if not popup.is_disabled("#refreshButton") else None
            h.idle(800)
            check(len(h.calls()) == n_calls + 1, "대기 중에는 '지금 확인'도 요청하지 않음")
            check("요청 제한 때문에" in popup.inner_text("#notes"), "대기 안내 표시")
            h.ext_eval("() => chrome.storage.local.remove('rateLimits')")  # 대기 시간이 지난 것으로 친다

            print("[13] solved.ac 방문 시 갱신")
            h.set_mode("solved")
            fill_settings(popup, "Taeyang", client_id=None, secret=None)
            h.wait(lambda: h.title() == "오늘 문제 해결 완료!", "다시 저장 → 해결")
            h.set_mode("unsolved")
            h.ext_eval("async () => { const { snapshot } = await chrome.storage.local.get('snapshot');"
                       " snapshot.fetchedAt -= 2 * 60 * 1000; await chrome.storage.local.set({ snapshot, lastAttemptAt: Date.now() - 120000 }); }")
            n_calls = len(h.calls())
            tab = open_solved_tab()
            h.wait(lambda: len(h.calls()) > n_calls, "페이지 방문으로 확인 요청")
            check(page_api_hits == [], "확장이 페이지 안에서 API를 호출하지 않음")
            tab.close()

            print("[13-1] 계정 칸을 고치는 중에 다른 곳에서 키가 바뀌면 섞지 않고 거절 / 저장 중에는 폼 잠금")
            popup.evaluate("() => { document.getElementById('settings').open = true; }")
            popup.fill("#clientSecretInput", "draft-secret-for-old-client")
            h.ext_eval("() => chrome.storage.local.set({ apiCredentials: { clientId: 'other-client', clientSecret: 'other-secret' },"
                       " credRev: 'rev-other' })")
            h.idle(600)
            check(popup.input_value("#clientIdInput") == CLIENT_ID, "고치는 중인 계정 칸은 바깥 변경으로 바뀌지 않음")
            popup.click("#saveButton")
            h.wait(lambda: "다른 곳" in popup.inner_text("#saveStatus"), "다른 곳에서 키가 바뀌었다고 거절")
            check(h.local()["apiCredentials"]["clientId"] == "other-client", "다른 곳의 키를 덮어쓰지 않음")
            check(popup.input_value("#clientIdInput") == "other-client" and popup.input_value("#clientSecretInput") == "",
                  "거절 뒤 최신 계정으로 다시 채움")
            h.ext_eval(f"() => chrome.storage.local.set({{ apiCredentials: {{ clientId: '{CLIENT_ID}', clientSecret: '{CLIENT_SECRET}' }},"
                       " credRev: 'rev-back' })")
            h.wait(lambda: popup.input_value("#clientIdInput") == CLIENT_ID, "고치지 않은 폼에는 바깥 변경 반영")
            h.set_delay(1500)
            popup.fill("#handleInput", "Taeyang2")
            popup.click("#saveButton")
            h.wait(lambda: popup.evaluate("() => document.getElementById('intervalInput').readOnly"
                                          " && document.getElementById('notifyError').disabled"), "확인하는 동안 폼 잠금")
            h.wait(lambda: "저장했어요" in popup.inner_text("#saveStatus"), "저장 완료")
            check(not popup.evaluate("() => document.getElementById('intervalInput').readOnly"), "저장 뒤 잠금 해제")
            check(h.sync().get("handle") == "Taeyang2", "새 핸들 저장")
            h.set_delay(0)
            fill_settings(popup, "Taeyang", client_id=None, secret=None)
            h.wait(lambda: h.sync().get("handle") == "Taeyang" and "저장했어요" in popup.inner_text("#saveStatus"), "핸들 되돌림")

            print("[14] 설정 탭(options_ui)")
            for pg in list(ctx.pages):  # 설치 때 열린 설정 탭을 닫아야 openOptionsPage가 새 탭을 연다
                if pg.url.endswith("/popup.html"):
                    pg.close()
            with ctx.expect_page() as page_info:
                h.ext_eval("() => chrome.runtime.openOptionsPage()")
            options = page_info.value
            options.wait_for_selector("#statusTitle")
            check(options.url.endswith("/popup.html"), "설정 페이지 = popup.html")
            wait_until(options, lambda: options.evaluate("() => document.getElementById('settings').open"), "설정 패널 열림")
            options.close()

            print("[15] v1 사용자 업데이트 (v1 데이터가 남은 채로 브라우저 재시작)")
            h.ext_eval(
                """async () => {
                  await chrome.storage.sync.clear();
                  await chrome.storage.local.clear();
                  await chrome.storage.sync.set({ targetUsername: 'taeyang95', alarmInterval: 7,
                                                  notifyOnNotSolved: false, notifyOnUnknown: true });
                  await chrome.storage.local.set({ lastStreakStatus: true, lastStreakCount: 3,
                                                   lastCheckTimestamp: 1, lastResetDate: '2025-01-01' });
                  await chrome.alarms.clearAll();
                  await chrome.alarms.create('solvedacStreakCheckAlarm', { periodInMinutes: 1 });
                  await chrome.alarms.create('dailyStatusResetAlarm', { delayInMinutes: 600 });
                }"""
            )
            ctx.close()
            ctx = launch()
            h = Harness(ctx)
            print("  ✔ 브라우저 재시작")
            h.mock("solved")
            popup = h.open_popup()
            h.wait(lambda: h.alarms().get("poll", {}).get("periodInMinutes") == 7, "마이그레이션 완료")
            sync = h.sync()
            check(popup.input_value("#intervalInput") == "7" and popup.is_checked("#notifyError")
                  and not popup.is_checked("#notifyUnsolved"), "주기/알림 설정을 v1 값으로 이어서 씀")
            check("checkIntervalMin" not in sync and "notifyError" not in sync, "v2 키로 옮겨 적지 않음")
            check("handle" not in sync, "백준 아이디를 바로 solved.ac 핸들로 쓰지 않음")
            check(sync.get("targetUsername") == "taeyang95", "v1 키는 다른 기기를 위해 남김")
            local = h.local()
            check(not any(k in local for k in ["lastStreakStatus", "lastStreakCount", "lastCheckTimestamp", "lastResetDate"]),
                  "v1 local 키 삭제")
            check(sorted(h.alarms()) == ["poll", "rollover"], f"v1 알람 정리: {sorted(h.alarms())}")
            check(h.alarms()["poll"]["periodInMinutes"] == 7, "옮긴 확인 주기로 알람")
            check(h.title() == "새 solved.ac에 맞춰 다시 설정해주세요", "업데이트 안내")
            check(popup.input_value("#handleInput") == "taeyang95" and popup.is_visible("#legacyHint"), "핸들 입력칸에 제안값")
            check(h.badge() == "…", "설정 필요 배지")
            h.wait(lambda: "setup:handle:migrated" in ((h.local().get("notifHistory") or {}).get("setup") or []),
                   "다시 설정하라는 알림(한 번, 기록됨)")
            check(h.calls() == [], "확인 전에는 요청하지 않음")
            # 키가 저장돼 있어도 알림 설정만 바꾸면 예전 아이디 제안을 핸들로 쓰지 않는다(실제 폼으로).
            h.ext_eval(f"() => chrome.storage.local.set({{ apiCredentials: {{ clientId: '{CLIENT_ID}', clientSecret: '{CLIENT_SECRET}' }} }})")
            h.wait(lambda: popup.input_value("#clientIdInput") == CLIENT_ID, "저장된 키가 폼에 반영")
            popup.evaluate("() => { document.getElementById('settings').open = true; }")
            popup.click("#notifyError")
            popup.click("#saveButton")
            h.wait(lambda: "알림 설정을 저장했어요" in popup.inner_text("#saveStatus"), "알림 설정만 저장")
            check("handle" not in h.sync() and h.sync().get("notifyError") is False, "제안값은 핸들로 저장하지 않음")
            check(h.calls() == [], "제안값으로 요청하지 않음")
            popup.fill("#clientSecretInput", CLIENT_SECRET)
            popup.click("#saveButton")
            h.wait(lambda: "이 아이디가 맞아요" in popup.inner_text("#saveStatus"), "키를 넣어도 제안값은 확인을 요구")
            h.ext_eval("() => chrome.storage.sync.remove('targetUsername')")  # 다른 기기에서 v1 값이 사라짐
            h.idle(600)
            popup.evaluate("() => { document.getElementById('saveStatus').textContent = ''; }")
            popup.click("#saveButton")
            h.wait(lambda: "이 아이디가 맞아요" in popup.inner_text("#saveStatus"), "그 사이 v1 값이 사라져도 확인 없이 제안값을 쓰지 않음")
            check("handle" not in h.sync() and h.calls() == [], "핸들 저장·요청 없음")
            popup.click("#confirmLegacyButton")
            check("저장하면 taeyang95" in popup.inner_text("#legacyHintText"), "제안값 확인 표시")
            popup.click("#notifyError")  # 되돌림
            fill_settings(popup, "Taeyang")
            h.wait(lambda: h.title() == "오늘 문제 해결 완료!", "새 핸들 확인 후 추적 시작")
            check(popup.is_hidden("#legacyHint"), "제안 안내 사라짐")
            check(h.notifications() == {}, "설정 알림 제거")

            if screenshots:
                print("[+] 다크 모드 스크린샷")
                popup.emulate_media(color_scheme="dark")
                popup.wait_for_timeout(200)
                h.shot("screenshot_popup_dark.png", screenshots)
                popup.emulate_media(color_scheme="light")

            print("[16] 모든 데이터 지우기: 확인 창은 고를 때까지 남는다")
            popup.evaluate("() => { document.getElementById('settings').open = true; }")
            popup.click("#resetButton")
            check(popup.is_visible("#resetConfirm") and "되돌릴 수 없어요" in popup.inner_text("#resetConfirmText"), "지워지는 것과 남는 것 안내")
            popup.wait_for_timeout(6000)
            check(popup.is_visible("#resetConfirm"), "6초 뒤에도 그대로")
            popup.keyboard.press("Escape")
            check(popup.is_hidden("#resetConfirm") and h.sync().get("handle") == "Taeyang", "Esc로 취소(지우지 않음)")
            popup.click("#resetButton")
            popup.click("#resetConfirmButton")
            h.wait(lambda: "모든 데이터를 지웠어요" in popup.inner_text("#saveStatus"), "지움")
            check(h.sync() == {}, "동기화 설정이 모두 지워짐")
            check("apiCredentials" not in h.local(), "키가 지워짐")

            print("\nE2E 통과 ✅")
            return 0
        except Failure as e:
            print(f"\n✖ 실패: {e}")
            try:
                print(f"  sync: {json.dumps(h.sync(), ensure_ascii=False)}")
                local = h.local()
                local.pop("apiCredentials", None)
                print(f"  local: {json.dumps(local, ensure_ascii=False)[:800]}")
                print(f"  calls: {len(h.calls())}")
            except Exception as ex:  # noqa: BLE001
                print(f"  (상태 덤프 실패: {ex})")
            if h.popup and not h.popup.is_closed():
                shot = Path(tempfile.gettempdir()) / "ssc-e2e-failure.png"
                h.popup.screenshot(path=str(shot))
                print(f"  팝업 스크린샷: {shot}")
            return 1
        finally:
            try:
                ctx.close()
            except Exception:  # noqa: BLE001
                pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--screenshots", action="store_true")
    args = ap.parse_args()
    return run(args.headed, args.screenshots)


if __name__ == "__main__":
    sys.exit(main())
