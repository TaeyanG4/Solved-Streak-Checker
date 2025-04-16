// popup.js - 팝업 창의 UI 업데이트 및 설정 저장을 담당합니다.

// --- 상수 정의 ---
// 상수들을 모아두어 관리 용이성을 높입니다.
const DEFAULT_ALARM_INTERVAL = 1; // 기본 알람 주기 (분 단위)
// chrome.storage.sync에 저장될 키 목록
const STORAGE_SYNC_KEYS = ['targetUsername', 'alarmInterval', 'notifyOnNotSolved', 'notifyOnUnknown'];
// chrome.storage.local에 저장될 키 목록 (백그라운드에서 주로 사용)
const STORAGE_LOCAL_KEYS = ['lastStreakStatus', 'lastStreakCount', 'lastCheckTimestamp'];

// --- HTML 요소 참조 ---
// 자주 사용되는 DOM 요소들을 미리 찾아 변수에 할당합니다.
const statusDisplay = document.getElementById('statusDisplay');         // 상태 메시지 전체 영역
const statusIcon = statusDisplay.querySelector('.icon');                // 상태 아이콘 (이모지)
const statusText = statusDisplay.querySelector('.text');                // 상태 텍스트 메시지
const streakCountDisplay = document.getElementById('streakCountDisplay'); // 현재 스트릭 일수 표시 영역
const lastCheckedDisplay = document.getElementById('lastCheckedDisplay'); // 마지막 확인 시간 표시 영역
const usernameInput = document.getElementById('usernameInput');         // 사용자명 입력 필드
const intervalInput = document.getElementById('intervalInput');         // 알림 주기 입력 필드
const notifyNotSolvedCheckbox = document.getElementById('notifyNotSolved'); // '미해결 시 알림' 체크박스
const notifyUnknownCheckbox = document.getElementById('notifyUnknown');   // '상태 모름 시 알림' 체크박스
const saveButton = document.getElementById('saveButton');             // 설정 저장 버튼
const saveStatusDiv = document.getElementById('saveStatus');            // 저장 결과 메시지 표시 영역
const refreshButton = document.getElementById('refreshButton');         // 상태 새로고침 버튼
const profileLinkButton = document.getElementById('profileLinkButton');   // 프로필 바로가기 버튼

// --- 전역 상태 변수 ---
let currentUsername = ''; // '프로필 가기' 버튼 등에서 사용될 현재 설정된 사용자명

// --- UI 업데이트 함수 ---

/**
 * 팝업 상단의 상태 표시 영역(아이콘, 메시지, 스트릭, 확인 시간)을 업데이트합니다.
 * @param {object | null} data - 백그라운드에서 가져온 데이터 또는 상태 업데이트용 객체.
 * @param {string} [data.targetUsername] - 대상 사용자명.
 * @param {boolean | null} [data.lastStreakStatus] - 마지막 스트릭 상태 (true: 해결, false: 미해결, null: 모름).
 * @param {number | null} [data.lastStreakCount] - 마지막 확인된 스트릭 일수.
 * @param {number | null} [data.lastCheckTimestamp] - 마지막 확인 시간 (타임스탬프).
 */
function updateDisplay(data) {
  // data가 null이거나 undefined인 경우 빈 객체로 초기화하여 오류 방지
  const { targetUsername, lastStreakStatus, lastStreakCount, lastCheckTimestamp } = data || {};

  // 이전 상태 관련 CSS 클래스 제거
  statusDisplay.classList.remove('solved', 'not-solved', 'unknown');

  let message = ""; // 표시될 메시지
  let icon = "";    // 표시될 아이콘

  // 현재 사용자명 업데이트 (프로필 버튼 등에 사용)
  currentUsername = targetUsername || '';

  // 프로필 링크 버튼 활성화/비활성화 상태 업데이트
  profileLinkButton.disabled = !currentUsername;

  if (currentUsername) {
    // 사용자명이 설정된 경우
    if (lastStreakStatus === true) {
      // 마지막 활동일에 문제를 푼 경우
      icon = "✅";
      message = `${currentUsername}님,\n가장 최근 활동일에 해결!`;
      statusDisplay.classList.add('solved');
    } else if (lastStreakStatus === false) {
      // 마지막 활동일에 문제를 풀지 않은 경우
      icon = "❌";
      message = `${currentUsername}님,\n가장 최근 활동일에 풀지 않음`;
      statusDisplay.classList.add('not-solved');
    } else {
      // 상태를 알 수 없는 경우 (null 또는 undefined)
      // 처음 사용자를 설정했거나, content script가 아직 실행되지 않았거나 오류가 발생한 경우
      icon = "❓";
      message = `${currentUsername}님의 상태를 알 수 없습니다.\n프로필 페이지를 방문하여\n상태를 업데이트 해주세요.`;
      statusDisplay.classList.add('unknown');
    }

    // 스트릭 일수 표시 (숫자인 경우에만 표시)
    streakCountDisplay.textContent = typeof lastStreakCount === 'number'
      ? `현재 스트릭: ${lastStreakCount}일`
      : ''; // 숫자가 아니면 빈 문자열

    // 마지막 확인 시각 표시 (타임스탬프가 유효한 경우에만)
    lastCheckedDisplay.textContent = lastCheckTimestamp
      ? `(마지막 확인: ${new Date(lastCheckTimestamp).toLocaleTimeString()})`
      : ''; // 없으면 빈 문자열

  } else {
    // 사용자명이 설정되지 않은 경우
    icon = "⚠️";
    message = "사용자명을 설정하고\n저장해주세요.";
    statusDisplay.classList.add('unknown'); // '모름' 스타일 적용
    streakCountDisplay.textContent = ''; // 스트릭 정보 없음
    lastCheckedDisplay.textContent = ''; // 확인 시간 정보 없음
  }

  // 계산된 아이콘과 메시지를 화면에 적용
  statusIcon.textContent = icon;
  statusText.textContent = message; // 줄바꿈(\n)이 적용되도록 textContent 사용
}

// --- 데이터 로딩 및 처리 함수 ---

/**
 * 백그라운드 스크립트에 초기 데이터(설정값, 마지막 상태)를 요청하고,
 * 받아온 데이터로 팝업 UI를 업데이트합니다.
 */
async function requestAndUpdateData() {
  console.log("팝업: 데이터 요청 및 UI 업데이트 시작");

  // 로딩 상태 표시
  statusIcon.textContent = "⏳";
  statusText.textContent = "상태 불러오는 중...";
  streakCountDisplay.textContent = '';
  lastCheckedDisplay.textContent = '';
  profileLinkButton.disabled = true; // 로딩 중에는 프로필 버튼 비활성화

  try {
    // 백그라운드 스크립트에 'requestInitialData' 메시지 전송 및 응답 대기
    const response = await chrome.runtime.sendMessage({ type: "requestInitialData" });

    // 백그라운드 응답 유효성 검사 (확장 프로그램 비활성화 등 예외 상황 처리)
    if (!response) {
      throw new Error("백그라운드 스크립트로부터 유효하지 않은 응답을 받았습니다.");
    }

    console.log("팝업: 백그라운드로부터 받은 초기 데이터:", response);

    // 응답 데이터 구조 분해 할당
    const {
      targetUsername,
      alarmInterval,
      notifyOnNotSolved,
      notifyOnUnknown,
      lastStreakStatus,
      lastStreakCount,
      lastCheckTimestamp
    } = response;

    // 받아온 설정값으로 입력 필드 채우기
    usernameInput.value = targetUsername || '';
    // 알람 주기가 유효하지 않으면 기본값(1) 사용
    intervalInput.value = (alarmInterval && alarmInterval >= 1) ? alarmInterval : DEFAULT_ALARM_INTERVAL;
    // 체크박스 상태 설정 (저장된 값이 false가 아니면 기본적으로 체크됨)
    notifyNotSolvedCheckbox.checked = notifyOnNotSolved !== false;
    notifyUnknownCheckbox.checked = notifyOnUnknown !== false;

    // 받아온 데이터로 상태 표시 영역 업데이트
    updateDisplay({ targetUsername, lastStreakStatus, lastStreakCount, lastCheckTimestamp });

    // 사용자명이 비어있으면 입력 필드에 자동으로 포커스 설정
    if (!targetUsername) {
      usernameInput.focus();
    }

  } catch (error) {
    // 데이터 로딩 또는 처리 중 오류 발생 시 처리
    console.error("팝업: 데이터 로딩/처리 오류:", error);
    statusIcon.textContent = "❗";
    statusText.textContent = "데이터 로딩 중 오류 발생.\n잠시 후 새로고침 해주세요.";
    statusDisplay.classList.add('unknown'); // 오류 시 '모름' 상태로 표시

    // 오류 발생 시에도 기본 설정값으로 필드를 채우려고 시도 (선택적)
    usernameInput.value = '';
    intervalInput.value = DEFAULT_ALARM_INTERVAL;
    notifyNotSolvedCheckbox.checked = true;
    notifyUnknownCheckbox.checked = true;
    profileLinkButton.disabled = true; // 오류 시 프로필 버튼 비활성화
  }
}

// --- 이벤트 리스너 설정 ---

/**
 * 팝업 창이 완전히 로드되었을 때 초기 데이터 로딩 및 UI 업데이트 실행
 */
document.addEventListener('DOMContentLoaded', requestAndUpdateData);

/**
 * '설정 저장' 버튼 클릭 시 입력값 검증, 설정 저장, UI 즉시 업데이트 수행
 */
saveButton.addEventListener('click', async () => {
  // 1. 입력값 읽기 (앞뒤 공백 제거)
  const username = usernameInput.value.trim();
  const interval = parseInt(intervalInput.value, 10); // 문자열을 숫자로 변환
  const notifyNotSolved = notifyNotSolvedCheckbox.checked;
  const notifyUnknown = notifyUnknownCheckbox.checked;

  // 2. 저장 상태 메시지 초기화
  saveStatusDiv.textContent = '';
  saveStatusDiv.style.color = ''; // 기본 색상으로

  // 3. 입력값 유효성 검사
  if (!username) {
    saveStatusDiv.textContent = '사용자명을 입력해주세요.';
    saveStatusDiv.style.color = 'red'; // 오류 메시지는 빨간색
    usernameInput.focus(); // 사용자명 필드에 포커스
    return; // 저장 중단
  }
  if (isNaN(interval) || interval < 1) {
    saveStatusDiv.textContent = '알림 주기는 1분 이상의 숫자여야 합니다.';
    saveStatusDiv.style.color = 'red';
    intervalInput.value = DEFAULT_ALARM_INTERVAL; // 잘못된 값 입력 시 기본값으로 복원
    intervalInput.focus();
    return; // 저장 중단
  }

  // 4. 저장 진행 중 상태 표시 (버튼 비활성화)
  saveButton.disabled = true;
  saveButton.textContent = '저장 중...';

  try {
    // 5. chrome.storage.sync에 설정값 저장 (동기화 스토리지 사용)
    await chrome.storage.sync.set({
      'targetUsername': username,
      'alarmInterval': interval,
      'notifyOnNotSolved': notifyNotSolved,
      'notifyOnUnknown': notifyUnknown
    });

    console.log('팝업: 설정 저장 완료:', { username, interval, notifyNotSolved, notifyUnknown });

    // 6. 저장 성공 메시지 표시
    saveStatusDiv.textContent = '설정이 저장되었습니다!';
    saveStatusDiv.style.color = 'green'; // 성공 메시지는 녹색

    // 7. UI 즉시 업데이트 (사용자 경험 개선)
    // 저장된 사용자명과 '상태 모름'으로 상태 표시 영역을 업데이트합니다.
    // background.js나 content.js에서 새로운 상태를 가져오기 전까지 임시 상태를 보여줍니다.
    updateDisplay({
      targetUsername: username,     // 방금 저장한 사용자명
      lastStreakStatus: null,       // 상태는 아직 모르므로 null
      lastStreakCount: null,        // 스트릭 수도 아직 모르므로 null
      lastCheckTimestamp: null    // 마지막 확인 시각도 리셋 (혹은 Date.now() 사용 가능)
    });

  } catch (error) {
    // 8. 저장 중 오류 발생 시 처리
    console.error("팝업: 설정 저장 오류:", error);
    saveStatusDiv.textContent = '설정 저장 중 오류가 발생했습니다.';
    saveStatusDiv.style.color = 'red';
    // 오류 발생 시에도 입력된 사용자명 기준으로 '상태 모름' UI를 표시하려고 시도
    updateDisplay({
        targetUsername: username,
        lastStreakStatus: null,
        lastStreakCount: null,
        lastCheckTimestamp: null
    });

  } finally {
    // 9. 저장 완료 또는 오류 발생 후 버튼 다시 활성화
    saveButton.disabled = false;
    saveButton.textContent = '설정 저장';

    // 10. 저장 상태 메시지 일정 시간 후 자동으로 지우기
    setTimeout(() => {
      saveStatusDiv.textContent = '';
    }, 2500); // 2.5초 후 메시지 사라짐
  }
});

/**
 * '새로고침' 버튼 클릭 시 백그라운드에 최신 데이터 요청 및 UI 업데이트
 */
refreshButton.addEventListener('click', requestAndUpdateData);

/**
 * '프로필 가기' 버튼 클릭 시 저장된 사용자명의 solved.ac 프로필 페이지를 새 탭으로 엽니다.
 */
profileLinkButton.addEventListener('click', () => {
  if (currentUsername) { // currentUsername 변수에 유효한 사용자명이 있을 때만 실행
    const profileUrl = `https://solved.ac/profile/${currentUsername}`;
    chrome.tabs.create({ url: profileUrl }); // 새 탭에서 URL 열기
    console.log(`팝업: 프로필 페이지로 이동: ${profileUrl}`);
  } else {
    console.warn("팝업: 프로필 가기 버튼 클릭 - 사용자명이 설정되지 않았습니다.");
  }
});