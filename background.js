// background.js - 주기적 알람, 알림, 상태 저장, 팝업 통신 등 백그라운드 작업을 처리합니다.

// --- 상수 정의 ---
const ALARM_NAME = 'solvedacStreakCheckAlarm';      // 주기적 상태 확인 알람 이름
const RESET_ALARM_NAME = 'dailyStatusResetAlarm';  // 매일 상태 초기화 알람 이름
const NOTIFICATION_ID = 'solvedacStreakCheckNotification'; // 알림 고유 ID
const DEFAULT_ALARM_INTERVAL = 1;                   // 기본 알람 주기 (1분)
// 스토리지 키 정의
const STORAGE_SYNC_KEYS = ['targetUsername', 'alarmInterval', 'notifyOnNotSolved', 'notifyOnUnknown'];
const STORAGE_LOCAL_KEYS = ['lastStreakStatus', 'lastStreakCount', 'lastCheckTimestamp'];

// --- 알람 설정 함수 ---

/**
 * 저장된 설정값(알람 주기)에 따라 주기적 알람(ALARM_NAME)을 생성/교체
 * @param {number | null} [initialDelayMinutes=null] - 첫 알람까지의 지연 시간(분). null이면 기본값(interval) 사용. 0이면 즉시 실행.
 */
async function setupPeriodicAlarm(initialDelayMinutes = null) {
    try {
        const { alarmInterval } = await chrome.storage.sync.get(['alarmInterval']);
        let interval = alarmInterval;
        if (isNaN(interval) || interval < 1) {
            interval = DEFAULT_ALARM_INTERVAL;
        }

        // 초기 지연 시간 설정: 파라미터가 null이면 기본값(interval) 사용, 아니면 주어진 값 사용.
        // 0도 유효한 값으로 처리됩니다.
        const delay = initialDelayMinutes === null ? interval : initialDelayMinutes;

        // delayInMinutes는 0 이상이어야 합니다. (음수 방지)
        const validDelay = Math.max(0, delay);

        await chrome.alarms.create(ALARM_NAME, { delayInMinutes: validDelay, periodInMinutes: interval });
        console.log(`[백그라운드] 주기적 확인 알람 '${ALARM_NAME}'이 ${interval}분 주기로 설정/재설정됨. (다음 알람 ${validDelay}분 후)`);
    } catch (error) {
        console.error("[백그라운드] 주기적 알람 설정 오류:", error);
    }
}


/** 다음 날 오전 6시(로컬 시간 기준)에 울릴 초기화 알람(RESET_ALARM_NAME) 설정 */
async function setupDailyResetAlarm() {
    try {
        const now = new Date();
        const tomorrow = new Date(now);

        // 다음 날 6시로 설정
        tomorrow.setDate(now.getDate() + 1);
        tomorrow.setHours(6, 0, 0, 0);

        // 만약 현재 시간이 새벽 6시 이전이면, 오늘 6시로 설정
        if (now.getHours() < 6) {
            tomorrow.setDate(now.getDate());
            tomorrow.setHours(6, 0, 0, 0);
        }

        const nextResetTime = tomorrow.getTime();

        // 알람 생성 (when은 밀리초 단위 타임스탬프)
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
    // 기존 알람 모두 제거 후 새로 설정
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(RESET_ALARM_NAME);
    // 주기적 알람은 기본값(interval) 지연으로 설정
    await setupPeriodicAlarm(); // initialDelayMinutes=null 이므로 interval 만큼 지연
    await setupDailyResetAlarm();
});

// 브라우저 시작 시
chrome.runtime.onStartup.addListener(async () => {
    console.log("[백그라운드] 브라우저 시작됨.");
    // 알람이 존재하는지 확인하고 없으면 새로 설정
    const periodicAlarm = await chrome.alarms.get(ALARM_NAME);
    if (!periodicAlarm) {
        console.log(`[백그라운드] 주기적 알람(${ALARM_NAME}) 없음. 새로 설정.`);
        await setupPeriodicAlarm(); // 기본 지연으로 설정
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

        if (changes.alarmInterval) {
            console.log(`[백그라운드] 알림 주기가 변경됨. 주기적 알람 재설정.`);
            needsPeriodicAlarmReset = true;
        }
        if (changes.targetUsername) {
            console.log(`[백그라운드] 타겟 사용자명 변경됨. 이전 상태, 알림 초기화, 주기적 알람 재설정.`);
            needsStatusReset = true;
            needsPeriodicAlarmReset = true; // 사용자명 변경 시에도 알람 재시작
        }
        if (changes.notifyOnNotSolved || changes.notifyOnUnknown) {
            console.log(`[백그라운드] 알림 수신 옵션 변경됨.`);
            // 옵션 변경 시에는 즉시 데스크톱 알림 상태를 재확인해볼 수 있음
            // checkStoredStatusAndNotify().catch(e => console.error("Error checking notification on option change:", e));
            // 필요하다면 위 주석 해제 (옵션 변경만으로도 알림 상태가 바뀔 수 있으므로)
        }

        if (needsStatusReset) {
            try {
                await chrome.storage.local.remove(STORAGE_LOCAL_KEYS);
                await chrome.notifications.clear(NOTIFICATION_ID);
                console.log("[백그라운드] 사용자명 변경으로 로컬 상태 및 알림 초기화 완료.");
            } catch (error) {
                console.error("[백그라운드] 사용자명 변경에 따른 상태 초기화 중 오류:", error);
            }
        }

        if(needsPeriodicAlarmReset) {
            await chrome.alarms.clear(ALARM_NAME);
            // <<<--- 수정: 알람 재설정 시 즉시 실행되도록 initialDelay를 0으로 설정 --- >>>
            await setupPeriodicAlarm(0);
            // <<<------------------------------------------------------------------ >>>

            // 사용자명 변경으로 상태가 리셋되었을 때, 즉시 트리거된 알람이 '상태 모름'을 처리하므로
            // 여기서 checkStoredStatusAndNotify를 중복 호출할 필요는 없어 보입니다.
        }
    }
});


// 알람 울릴 때
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) { // 주기적 확인 알람
        console.log(`[백그라운드] 주기적 확인 알람 '${ALARM_NAME}' 울림.`);
        await checkStoredStatusAndNotify(); // <<< 알림 확인 로직 호출
    } else if (alarm.name === RESET_ALARM_NAME) { // 매일 초기화 알람
        console.log(`[백그라운드] 매일 상태 초기화 알람 '${RESET_ALARM_NAME}' 울림.`);
        try {
            await chrome.storage.local.set({
                'lastStreakStatus': null, // <<< 상태를 '모름(null)'으로 변경
                'lastCheckTimestamp': Date.now() // 초기화 시각 기록
                // lastStreakCount는 여기서 초기화하지 않음 (다음 content script 실행 시 업데이트)
            });
            console.log("[백그라운드] 로컬 상태 초기화됨 (lastStreakStatus: null).");
            // 초기화된 '상태 모름' 기준으로 (데스크톱)알림 로직 즉시 실행
            await checkStoredStatusAndNotify();
        } catch (error) {
            console.error("[백그라운드] 상태 초기화 중 오류:", error);
        } finally {
            // 다음 날 초기화 알람 다시 설정
            await setupDailyResetAlarm();
        }
    }
});

// 메시지 수신 (content.js, popup.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "streakStatusUpdate") {
        console.log("[백그라운드] content.js로부터 streakStatusUpdate 메시지 수신");
        handleStreakStatusUpdate(message.payload).catch(error => {
            console.error("[백그라운드] handleStreakStatusUpdate 처리 중 오류:", error);
        });
        return false; // 응답 불필요
    }
    else if (message.type === "requestInitialData") {
        console.log("[백그라운드] 팝업으로부터 초기 데이터 요청 수신");
        handlePopupDataRequest().then(sendResponse).catch(error => {
            console.error("[백그라운드] 팝업 데이터 요청 처리 중 오류:", error);
            sendResponse(null); // 오류 시 null 응답
        });
        return true; // 비동기 응답 필요
    }
    // 설정 저장 직후 (데스크톱)알림 확인 요청 처리 (팝업 -> 백그라운드)
    else if (message.type === "checkNotificationOnSave") {
        console.log("[백그라운드] 팝업으로부터 checkNotificationOnSave 메시지 수신. 즉시 (데스크톱)알림 조건 확인 실행.");
        checkStoredStatusAndNotify().catch(error => {
             console.error("[백그라운드] 설정 저장 후 (데스크톱)알림 확인 중 오류:", error);
        });
        return false; // 응답 불필요
    }
    // 다른 타입의 메시지가 있다면 여기에 추가
});

// --- 핵심 로직 함수 ---

/** content.js에서 받은 상태 업데이트 처리 */
async function handleStreakStatusUpdate(payload) {
    const { solved, username, streakCount, timestamp } = payload;
    console.log(`[백그라운드] '${username}' 상태 업데이트 처리 시작: solved=${solved}, count=${streakCount}, time=${new Date(timestamp).toLocaleTimeString()}`);
    try {
        const { targetUsername } = await chrome.storage.sync.get(['targetUsername']);

        // 메시지로 받은 사용자명과 저장된 타겟 사용자명이 일치하는지 확인 (대소문자 무시)
        if (targetUsername && username && targetUsername.toLowerCase() === username.toLowerCase()) {
            const currentStatus = {
                'lastStreakStatus': solved,
                'lastStreakCount': streakCount,
                'lastCheckTimestamp': timestamp
            };
            await chrome.storage.local.set(currentStatus);

            const stateStr = solved === null ? '상태 모름' : (solved ? '해결' : '미해결');
            console.log(`[백그라운드] '${username}' (${stateStr}, ${streakCount ?? 'N/A'}일) 상태 로컬 스토리지에 저장됨.`);

            // 상태 업데이트 후, 데스크톱 알림 상태 즉시 재확인
            // (예: 미해결->해결 변경 시 알림 제거, 상태모름->해결/미해결 시 알림 제거/변경 등)
            await checkStoredStatusAndNotify();

        } else {
            console.log(`[백그라운드] 상태 업데이트 무시됨: 사용자 불일치 ('${username}' vs '${targetUsername ?? '미설정'}')`);
        }
    } catch (error) {
        console.error("[백그라운드] 스트릭 정보 저장 오류:", error);
    }
}

/** popup.js의 초기 데이터 요청 처리 */
async function handlePopupDataRequest() {
    try {
        // sync와 local 저장소 데이터 병렬로 가져오기
        const [syncData, localData] = await Promise.all([
             chrome.storage.sync.get(STORAGE_SYNC_KEYS),
             chrome.storage.local.get(STORAGE_LOCAL_KEYS)
        ]);
        // 두 객체 병합하여 응답 생성
        const response = { ...syncData, ...localData };
        console.log("[백그라운드] 팝업으로 보낼 데이터:", response);
        return response;
    } catch (error) {
        console.error("[백그라운드] 팝업 데이터 요청 - 스토리지 읽기 오류:", error);
        return null; // 오류 발생 시 null 반환
    }
}

/* ================================================= */
/* ===== 상태 확인 및 (데스크톱)알림 처리 핵심 함수 ===== */
/* ================================================= */
/** 저장된 상태 확인 및 필요시 (데스크톱)알림 표시 함수 */
async function checkStoredStatusAndNotify() {
    try {
        // 설정값(사용자명, 알림 옵션)과 마지막 상태값 가져오기
        const [syncData, localData] = await Promise.all([
             chrome.storage.sync.get(['targetUsername', 'notifyOnNotSolved', 'notifyOnUnknown']),
             chrome.storage.local.get(['lastStreakStatus'])
        ]);

        const { targetUsername, notifyOnNotSolved, notifyOnUnknown } = syncData;
        // localData가 비어있거나 lastStreakStatus가 없는 경우 null로 처리
        const solved = localData?.lastStreakStatus ?? null;

        // 타겟 사용자명이 설정되지 않았으면 알림 로직 중단
        if (!targetUsername) {
            console.log("[백그라운드] 타겟 사용자명 미설정. (데스크톱)알림 확인 건너뜀.");
            await chrome.notifications.clear(NOTIFICATION_ID); // 기존 알림 제거
            return;
        }

        // 로그용 상태 문자열 정의
        let solvedStateString = solved === null ? '상태 모름' : (solved ? '해결' : '미해결');

        console.log(`[백그라운드] (데스크톱)알림 조건 확인 중: 사용자 ${targetUsername}, 상태 ${solvedStateString}, 설정(미해결:${notifyOnNotSolved !== false}, 모름:${notifyOnUnknown !== false})`);

        let shouldNotify = false; // 알림을 보내야 하는지 여부
        let message = "";       // 알림 메시지 내용

        // 알림 조건 확인 및 메시지 설정
        if (solved === false && notifyOnNotSolved !== false) {
            shouldNotify = true;
            message = `가장 최근 활동일에\n문제를 풀지 않았어요! 😥\n\n오늘도 꾸준함을 보여주세요! 💪`;
            console.log("[백그라운드] (데스크톱)알림 조건 충족: 미해결");
        }
        else if (solved === null && notifyOnUnknown !== false) {
            shouldNotify = true;
            message = `스트릭 상태를 알 수 없습니다.\n\n프로필 페이지를 방문하여\n상태를 업데이트해주세요. 🤔`;
            console.log("[백그라운드] (데스크톱)알림 조건 충족: 상태 모름");
        }

        // 알림 생성 또는 제거
        if (shouldNotify) {
            // 알림 조건 충족 시 알림 생성 (기존 알림은 createNotification 내부에서 clear됨)
            await createNotification(message, targetUsername);
        } else {
            // 알림 조건 미충족 시 (해결 상태이거나, 해당 상태 알림 설정이 꺼진 경우)
            console.log("[백그라운드] (데스크톱)알림 조건 미충족. 기존 알림 제거 시도.");
            await chrome.notifications.clear(NOTIFICATION_ID);
        }
    } catch (error) {
        console.error("[백그라운드] 상태 확인 및 (데스크톱)알림 처리 중 오류:", error);
        // 오류 발생 시에도 안전하게 기존 알림 제거 시도
        try {
             await chrome.notifications.clear(NOTIFICATION_ID);
        } catch (clearError) {
             console.error("[백그라운드] 오류 처리 중 알림 제거 실패:", clearError);
        }
    }
}


/* ================================================= */
/* ========== 실제 데스크톱 알림 생성 함수 ========== */
/* ================================================= */
/** 시스템 데스크탑 알림 생성 함수 */
async function createNotification(message, username) {
    const notificationOptions = {
        type: 'basic',
        iconUrl: 'images/icon128.png', // 확장 프로그램에 포함된 아이콘 경로
        title: `⚠️ ${username}님, 잔디 알림! ⚠️`, // 제목에 사용자명 포함
        message: message,
        priority: 1, // 알림 우선순위 (0-2)
        buttons: [{ title: "프로필 확인하기" }], // 버튼 추가
        requireInteraction: true // 사용자가 닫기 전까지 유지 (Chrome 특정 동작)
    };
    try {
        // 알림을 생성하기 전에 항상 이전 알림을 제거하여 중복 방지 및 최신 상태 반영
        await chrome.notifications.clear(NOTIFICATION_ID);
        const notificationId = await chrome.notifications.create(NOTIFICATION_ID, notificationOptions);
        console.log(`[백그라운드] (데스크톱)알림 '${notificationId}' 생성됨 (requireInteraction: true).`);
    } catch (error) {
        console.error("[백그라운드] (데스크톱)알림 생성 실패:", error);
    }
}

// --- 알림 상호작용 리스너 ---

// 알림 버튼 클릭 리스너
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    console.log(`[백그라운드] 알림 버튼 클릭됨: ${notificationId}, 버튼 인덱스: ${buttonIndex}`);
    if (notificationId === NOTIFICATION_ID && buttonIndex === 0) { // "프로필 확인하기" 버튼
        try {
            const { targetUsername } = await chrome.storage.sync.get(['targetUsername']);
            if (targetUsername) {
                const profileUrl = `https://solved.ac/profile/${targetUsername}`;
                await chrome.tabs.create({ url: profileUrl }); // 새 탭에서 프로필 열기
                console.log(`[백그라운드] 프로필 페이지 여는 중: ${profileUrl}`);
                await chrome.notifications.clear(notificationId); // 알림 닫기
            } else {
                console.error("[백그라운드] 알림 버튼 클릭 시 타겟 사용자명 찾기 실패");
            }
        } catch (error) {
            console.error("[백그라운드] 알림 버튼 클릭 처리 오류:", error);
        }
    }
});

// 알림 자체(버튼 제외 영역)를 클릭했을 때의 리스너
chrome.notifications.onClicked.addListener(async (notificationId) => {
    console.log(`[백그라운드] 알림 클릭됨: ${notificationId}`);
    if (notificationId === NOTIFICATION_ID) {
        try {
            // 버튼 클릭과 동일하게 프로필 페이지 열기
            const { targetUsername } = await chrome.storage.sync.get(['targetUsername']);
            if (targetUsername) {
                const profileUrl = `https://solved.ac/profile/${targetUsername}`;
                await chrome.tabs.create({ url: profileUrl });
                console.log(`[백그라운드] (알림 클릭) 프로필 페이지 여는 중: ${profileUrl}`);
                await chrome.notifications.clear(notificationId); // 알림 닫기
            } else {
                console.error("[백그라운드] 알림 클릭 시 타겟 사용자명 찾기 실패");
            }
        } catch (error) {
            console.error("[백그라운드] 알림 클릭 처리 오류:", error);
        }
    }
});