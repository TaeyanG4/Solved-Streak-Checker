// background.js - 주기적 알람, 알림, 상태 저장, 팝업 통신 등 백그라운드 작업을 처리합니다.

// --- 상수 정의 ---
const ALARM_NAME = 'solvedacStreakCheckAlarm';      // 주기적 상태 확인 알람 이름
const RESET_ALARM_NAME = 'dailyStatusResetAlarm';   // 매일 상태 초기화 알람 이름
const NOTIFICATION_ID = 'solvedacStreakCheckNotification'; // 알림 고유 ID
const DEFAULT_ALARM_INTERVAL = 1;                   // 기본 알람 주기 (1분)
// 스토리지 키 정의
const STORAGE_SYNC_KEYS = ['targetUsername', 'alarmInterval', 'notifyOnNotSolved', 'notifyOnUnknown'];
const STORAGE_LOCAL_KEYS = ['lastStreakStatus', 'lastStreakCount', 'lastCheckTimestamp'];

// --- 알람 설정 함수 ---

/** 저장된 설정값(알람 주기)에 따라 주기적 알람(ALARM_NAME)을 생성/교체 */
async function setupPeriodicAlarm() {
  try {
    const { alarmInterval } = await chrome.storage.sync.get(['alarmInterval']);
    let interval = alarmInterval;
    if (isNaN(interval) || interval < 1) {
      interval = DEFAULT_ALARM_INTERVAL;
    }
    // 참고: periodInMinutes는 최소 1분입니다.
    // delayInMinutes: 1 -> 1분 후에 첫 알람 실행
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: interval });
    console.log(`[백그라운드] 주기적 확인 알람 '${ALARM_NAME}'이 ${interval}분 주기로 설정/재설정됨.`);
  } catch (error) {
    console.error("[백그라운드] 주기적 알람 설정 오류:", error);
  }
}

/** 다음 날 오전 6시(로컬 시간 기준)에 울릴 초기화 알람(RESET_ALARM_NAME) 설정 */
async function setupDailyResetAlarm() {
  try {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(6, 0, 0, 0); // 다음 날 오전 6시

    // 현재 시간이 오전 6시 이전이면 오늘 오전 6시로 설정
    if (now.getHours() < 6) {
      tomorrow.setDate(now.getDate());
      tomorrow.setHours(6, 0, 0, 0);
    }

    const nextResetTime = tomorrow.getTime();

    await chrome.alarms.create(RESET_ALARM_NAME, { when: nextResetTime });
    console.log(`[백그라운드] 다음 상태 초기화 알람 '${RESET_ALARM_NAME}'이 ${new Date(nextResetTime).toLocaleString()}에 설정됨.`);
  } catch (error) {
    console.error("[백그라운드] 초기화 알람 설정 오류:", error);
  }
}

// --- 이벤트 리스너 ---

// 설치 / 업데이트 시
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[백그라운드] 확장 프로그램 ${details.reason}됨.`);
  // 기존 알람 제거 (업데이트 시 중복 방지)
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(RESET_ALARM_NAME);
  // 알람 새로 설정
  await setupPeriodicAlarm();
  await setupDailyResetAlarm();
});

// 브라우저 시작 시
chrome.runtime.onStartup.addListener(async () => {
  console.log("[백그라운드] 브라우저 시작됨.");
  // 알람 존재 확인 및 필요 시 재생성
  const periodicAlarm = await chrome.alarms.get(ALARM_NAME);
  if (!periodicAlarm) {
      console.log(`[백그라운드] 주기적 알람(${ALARM_NAME}) 없음. 새로 설정.`);
      await setupPeriodicAlarm();
  }
  const resetAlarm = await chrome.alarms.get(RESET_ALARM_NAME);
  if (!resetAlarm) {
      console.log(`[백그라운드] 초기화 알람(${RESET_ALARM_NAME}) 없음. 새로 설정.`);
      await setupDailyResetAlarm();
  }
});

// 스토리지 변경 감지
chrome.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace === 'sync') {
    let needsPeriodicAlarmReset = false;
    let needsStatusReset = false;

    if (changes.alarmInterval) { // 알람 주기 변경
      console.log(`[백그라운드] 알림 주기가 변경됨. 주기적 알람 재설정.`);
      needsPeriodicAlarmReset = true;
    }
    if (changes.targetUsername) { // 사용자명 변경
      console.log(`[백그라운드] 타겟 사용자명 변경됨. 이전 상태, 알림 초기화.`);
      needsStatusReset = true;
      // 사용자명 변경 시에도 주기적 알람은 새 설정으로 유지/재설정 필요
      needsPeriodicAlarmReset = true;
    }
    if (changes.notifyOnNotSolved || changes.notifyOnUnknown) { // 알림 옵션 변경
      console.log(`[백그라운드] 알림 수신 옵션 변경됨.`);
      // 옵션 변경만으로는 알람 재설정 불필요
    }

    if (needsStatusReset) {
        try {
            await chrome.storage.local.remove(STORAGE_LOCAL_KEYS); // 로컬 상태 모두 삭제
            await chrome.notifications.clear(NOTIFICATION_ID); // 기존 알림 제거
            console.log("[백그라운드] 사용자명 변경으로 로컬 상태 및 알림 초기화 완료.");
        } catch (error) {
            console.error("[백그라운드] 사용자명 변경에 따른 상태 초기화 중 오류:", error);
        }
    }

    if(needsPeriodicAlarmReset) {
        await chrome.alarms.clear(ALARM_NAME); // 기존 알람 제거 후
        await setupPeriodicAlarm(); // 새 주기로 알람 다시 설정
    }
  }
});

// 알람 울릴 때
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) { // 주기적 확인 알람
    console.log(`[백그라운드] 주기적 확인 알람 '${ALARM_NAME}' 울림.`);
    await checkStoredStatusAndNotify();
  } else if (alarm.name === RESET_ALARM_NAME) { // 매일 초기화 알람
    console.log(`[백그라운드] 매일 상태 초기화 알람 '${RESET_ALARM_NAME}' 울림.`);
    try {
      // 상태만 null로 바꾸고, 마지막 확인 시각은 유지하거나 업데이트
      await chrome.storage.local.set({
        'lastStreakStatus': null,
        // 'lastStreakCount': null, // 카운트는 유지해도 무방할 수 있음 (선택사항)
        'lastCheckTimestamp': Date.now() // 초기화 시각으로 업데이트
      });
      console.log("[백그라운드] 로컬 상태 초기화됨 (lastStreakStatus: null).");
      await checkStoredStatusAndNotify(); // 초기화된 상태 기준으로 알림 로직 실행 (주로 '상태 모름' 알림)
    } catch (error) {
      console.error("[백그라운드] 상태 초기화 중 오류:", error);
    } finally {
        await setupDailyResetAlarm(); // 다음 날 초기화 알람 다시 설정
    }
  }
});

// =============== 메시지 리스너 수정된 부분 ===============
// 메시지 수신 (content.js, popup.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- content.js 로부터 상태 업데이트 ---
  if (message.type === "streakStatusUpdate") {
    console.log("[백그라운드] content.js로부터 streakStatusUpdate 메시지 수신");
    // handleStreakStatusUpdate는 async 함수이지만, 여기서 await할 필요는 없습니다.
    // 백그라운드에서 조용히 처리하고 content.js로 응답을 보낼 필요가 없기 때문입니다.
    handleStreakStatusUpdate(message.payload).catch(error => {
        // 백그라운드 작업 중 발생할 수 있는 오류를 로깅하는 것이 좋습니다.
        console.error("[백그라운드] handleStreakStatusUpdate 처리 중 오류:", error);
    });

    // *** 중요 수정: content.js로 응답을 보내지 않으므로 false 또는 undefined 반환 ***
    // return true;  // <--- 이 줄을 삭제하거나 주석 처리합니다.
    return false; // 명시적으로 false를 반환하거나, 이 return 문 자체를 생략해도 됩니다.

  }
  // --- popup.js 로부터 초기 데이터 요청 ---
  else if (message.type === "requestInitialData") {
    console.log("[백그라운드] 팝업으로부터 초기 데이터 요청 수신");
    handlePopupDataRequest().then(sendResponse).catch(error => {
        console.error("[백그라운드] 팝업 데이터 요청 처리 중 오류:", error);
        sendResponse(null); // 오류 시 null 응답
    });
    // popup.js에는 비동기 응답을 보내야 하므로 true 반환이 필수입니다. (이 부분은 원래대로 유지)
    return true;
  }
  // 다른 타입의 메시지는 처리하지 않고 암묵적으로 false/undefined를 반환합니다.
});
// ========================================================


// --- 핵심 로직 함수 ---

/** content.js에서 받은 상태 업데이트 처리 */
async function handleStreakStatusUpdate(payload) {
    const { solved, username, streakCount, timestamp } = payload;
    console.log(`[백그라운드] '${username}' 상태 업데이트 처리 시작: solved=${solved}, count=${streakCount}, time=${timestamp}`);
    try {
        const { targetUsername } = await chrome.storage.sync.get(['targetUsername']);

        // 저장된 타겟 사용자명과 메시지로 받은 사용자명이 일치하는 경우에만 처리
        if (targetUsername && username && targetUsername.toLowerCase() === username.toLowerCase()) {
            // 로컬 스토리지에 최신 상태 저장
            await chrome.storage.local.set({
                'lastStreakStatus': solved,
                'lastStreakCount': streakCount,
                'lastCheckTimestamp': timestamp // content script가 확인한 시점의 timestamp
            });
            const stateStr = solved === null ? '상태 모름' : (solved ? '해결' : '미해결');
            console.log(`[백그라운드] '${username}' (${stateStr}, ${streakCount ?? 'N/A'}일) 상태 로컬 스토리지에 저장됨.`);

            // 상태가 업데이트되었으므로, 현재 표시 중인 알림이 있다면 조건부로 제거
            // '풀었음' 상태가 되면 알림 제거, '상태 모름' 상태가 되어도 제거 (방문 유도 알림 제외)
            // '안 풀었음' 상태는 알림 유지 또는 생성 필요할 수 있음 (checkStoredStatusAndNotify 에서 처리)
            if (solved === true || solved === null) {
                console.log("[백그라운드] 상태 업데이트(해결/모름)로 인해 기존 알림 제거 시도.");
                await chrome.notifications.clear(NOTIFICATION_ID);
            }
            // 변경된 상태에 따라 즉시 알림 다시 확인 (선택 사항)
            // await checkStoredStatusAndNotify();
        } else {
            console.log(`[백그라운드] 상태 업데이트 무시됨: 사용자 불일치 ('${username}' vs '${targetUsername}') 또는 타겟 미설정.`);
        }
    } catch (error) {
        console.error("[백그라운드] 스트릭 정보 저장 오류:", error);
    }
}

/** popup.js의 초기 데이터 요청 처리 */
async function handlePopupDataRequest() {
    try {
        // sync 스토리지와 local 스토리지에서 필요한 모든 데이터 가져오기
        const syncDataPromise = chrome.storage.sync.get(STORAGE_SYNC_KEYS);
        const localDataPromise = chrome.storage.local.get(STORAGE_LOCAL_KEYS);

        // 두 요청을 병렬로 실행
        const [syncData, localData] = await Promise.all([syncDataPromise, localDataPromise]);

        // 두 스토리지 데이터 병합하여 응답 객체 생성
        const response = { ...syncData, ...localData };
        console.log("[백그라운드] 팝업으로 보낼 데이터:", response);
        return response; // Promise resolve 값으로 데이터 반환
    } catch (error) {
        console.error("[백그라운드] 팝업 데이터 요청 - 스토리지 읽기 오류:", error);
        return null; // 오류 시 null 반환
    }
}

/** 저장된 상태 확인 및 필요시 알림 표시 함수 */
async function checkStoredStatusAndNotify() {
    try {
      // 설정값(사용자명, 알림 옵션)과 마지막 상태값 가져오기
      const syncData = await chrome.storage.sync.get(['targetUsername', 'notifyOnNotSolved', 'notifyOnUnknown']);
      const localData = await chrome.storage.local.get(['lastStreakStatus']);

      const { targetUsername, notifyOnNotSolved, notifyOnUnknown } = syncData;
      const solved = localData.lastStreakStatus; // true, false, null

      // 타겟 사용자명이 설정되지 않았으면 알림 로직 중단
      if (!targetUsername) {
        console.log("[백그라운드] 타겟 사용자명 미설정. 알림 확인 건너뜀.");
        // 혹시 남아있을 수 있는 알림 제거
        await chrome.notifications.clear(NOTIFICATION_ID);
        return;
      }

      const solvedStateString = solved === null ? '상태 모름' : (solved ? '해결' : '미해결');
      console.log(`[백그라운드] 알림 조건 확인 중: 사용자 ${targetUsername}, 상태 ${solvedStateString}`);

      let shouldNotify = false; // 알림을 보내야 하는지 여부
      let message = "";         // 알림 메시지 내용

      // 알림 조건 확인 및 메시지 설정
      // notifyOnNotSolved/notifyOnUnknown 값이 false로 명시된 경우를 제외하고는 기본적으로 알림 (true 또는 undefined)
      if (solved === false && notifyOnNotSolved !== false) {
        shouldNotify = true;
        message = `가장 최근 활동일에\n문제를 풀지 않았어요! 😥\n\n오늘도 꾸준함을 보여주세요! 💪`;
        console.log("[백그라운드] 알림 조건 충족: 미해결");
      } else if (solved === null && notifyOnUnknown !== false) {
        shouldNotify = true;
        message = `스트릭 상태를 알 수 없습니다.\n\n프로필 페이지를 방문하여\n상태를 업데이트해주세요. 🤔`;
        console.log("[백그라운드] 알림 조건 충족: 상태 모름");
      }

      // 알림 생성 또는 제거
      if (shouldNotify) {
        // 알림 생성 함수 호출
        await createNotification(message, targetUsername);
      } else {
        // 알림 조건 미충족 시, 기존 알림 제거 (예: 상태가 '해결'로 변경된 경우)
        console.log("[백그라운드] 알림 조건 미충족. 기존 알림 제거 시도.");
        await chrome.notifications.clear(NOTIFICATION_ID);
      }
    } catch (error) {
      console.error("[백그라운드] 상태 확인 및 알림 처리 중 오류:", error);
    }
  }

  /** 시스템 데스크탑 알림 생성 함수 */
  async function createNotification(message, username) {
    const notificationOptions = {
      type: 'basic',
      iconUrl: 'images/icon128.png',
      title: `⚠️ ${username}님, 잔디 알림! ⚠️`, // 제목에 사용자명 포함
      message: message,
      priority: 1, // 알림 우선순위 (0-2)
      buttons: [{ title: "프로필 확인하기" }], // 버튼 추가
      requireInteraction: true // 사용자가 닫기 전까지 유지 (Chrome 특정 동작)
    };
    try {
      // 기존 알림이 있다면 먼저 제거 (중복 알림 방지)
      await chrome.notifications.clear(NOTIFICATION_ID);
      // 새 알림 생성
      const notificationId = await chrome.notifications.create(NOTIFICATION_ID, notificationOptions);
      console.log(`[백그라운드] 알림 '${notificationId}' 생성됨 (requireInteraction: true).`);
    } catch (error) {
      console.error("[백그라운드] 알림 생성 실패:", error);
    }
  }

// 알림 버튼 클릭 리스너
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  console.log(`[백그라운드] 알림 버튼 클릭됨: ${notificationId}, 버튼 인덱스: ${buttonIndex}`);
  if (notificationId === NOTIFICATION_ID && buttonIndex === 0) { // 우리가 생성한 알림이고, 첫 번째 버튼("프로필 확인하기")일 경우
    try {
      const { targetUsername } = await chrome.storage.sync.get(['targetUsername']);
      if (targetUsername) {
        const profileUrl = `https://solved.ac/profile/${targetUsername}`;
        // 새 탭에서 프로필 페이지 열기
        await chrome.tabs.create({ url: profileUrl });
        console.log(`[백그라운드] 프로필 페이지 여는 중: ${profileUrl}`);
        // 버튼 클릭 후 알림 닫기
        await chrome.notifications.clear(notificationId);
      } else {
          console.error("[백그라운드] 알림 버튼 클릭 시 타겟 사용자명 찾기 실패");
      }
    } catch (error) {
        console.error("[백그라운드] 알림 버튼 클릭 처리 오류:", error);
    }
  }
});

// (선택사항) 알림 자체를 클릭했을 때의 리스너
chrome.notifications.onClicked.addListener(async (notificationId) => {
    console.log(`[백그라운드] 알림 클릭됨: ${notificationId}`);
    if (notificationId === NOTIFICATION_ID) {
        // 버튼 클릭과 동일한 동작 수행 (프로필 열기 및 알림 닫기)
        try {
            const { targetUsername } = await chrome.storage.sync.get(['targetUsername']);
            if (targetUsername) {
                const profileUrl = `https://solved.ac/profile/${targetUsername}`;
                await chrome.tabs.create({ url: profileUrl });
                console.log(`[백그라운드] (알림 클릭) 프로필 페이지 여는 중: ${profileUrl}`);
                await chrome.notifications.clear(notificationId);
            } else {
                console.error("[백그라운드] 알림 클릭 시 타겟 사용자명 찾기 실패");
            }
        } catch (error) {
            console.error("[백그라운드] 알림 클릭 처리 오류:", error);
        }
    }
});