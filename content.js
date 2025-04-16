// content.js - solved.ac 프로필 페이지에서 실행됩니다.
// 설정된 사용자의 스트릭 상태와 일수를 확인하여 백그라운드 스크립트로 전송합니다.
// 페이지의 외형은 변경하지 않습니다.

// --- 상수 정의 ---

// !!! 중요: 스트릭 관련 선택자 !!!
// 이 값들은 solved.ac 웹사이트의 HTML/CSS 구조가 변경되면 작동하지 않을 수 있습니다.
// F12 개발자 도구를 사용하여 정확하고 안정적인 선택자로 *직접 확인 및 수정*해야 합니다.
const SVG_CONTAINER_SELECTOR = 'div.css-fpwzir svg'; // 페이지 소스 기반 컨테이너 선택자
const STREAK_RECT_SELECTOR = 'rect[width="18"][height="18"][rx="5"]'; // 스트릭 사각형 기본 선택자

// 스트릭 일수 확인 로직 (변경 없음)
// const STREAK_COUNT_SELECTOR = 'div.css-jwdz37 div.css-1midmz7 > b'; // 이전 방식
// JavaScript 필터링 방식 유지

// 확장 프로그램 이름 (콘솔 로그용)
const EXT_NAME = "Solved Streak Checker";

console.log(`${EXT_NAME}: content.js loaded`);

/**
 * 타겟 사용자의 스트릭 상태 및 일수를 확인하고 백그라운드로 전송하는 메인 함수
 * @param {string} targetUsername - 확인할 사용자명
 */
async function checkStreakStatus(targetUsername) {
    let statusMessage = '스트릭 정보를 찾을 수 없습니다.'; // 기본 상태 메시지
    let solvedLastDay = null; // 마지막 활동일(오늘) 해결 여부 (null: 상태 모름, false: 안 품, true: 품)
    let streakCount = null;   // 현재 스트릭 일수 (null: 확인 불가)
    const timestamp = Date.now(); // 현재 확인 시각 타임스탬프

    // --- 1. 스트릭 일수 확인 (JavaScript 필터링 방식 - 기존 로직 유지) ---
    try {
        const potentialElements = document.querySelectorAll('div.css-1midmz7'); // 이 클래스는 실제 페이지에서 확인 필요
        let targetStreakDiv = null;

        for (const element of potentialElements) {
            if (element.textContent?.trim().startsWith('현재')) {
                targetStreakDiv = element;
                break;
            }
        }

        if (targetStreakDiv) {
            const bTag = targetStreakDiv.querySelector('b');
            if (bTag?.textContent) {
                const textContent = bTag.textContent.trim();
                const match = textContent.match(/\d+/);
                if (match) {
                    streakCount = parseInt(match[0], 10);
                    console.log(`[${EXT_NAME}] 스트릭 일수 확인: ${streakCount} (검색 방식: JS 필터링)`);
                } else {
                    console.warn(`[${EXT_NAME}] 스트릭 <b> 태그에서 숫자 추출 실패: '${textContent}'`);
                }
            } else {
                console.warn(`[${EXT_NAME}] '현재' div 내에서 <b> 태그 또는 텍스트를 찾지 못함`, targetStreakDiv);
            }
        } else {
            // 스트릭 일수 표시 요소가 없는 경우도 있으므로 경고 수준으로 유지
            console.warn(`[${EXT_NAME}] '현재 N일' 형태의 스트릭 일수 요소를 찾지 못함 (검색 대상 클래스: div.css-1midmz7). 스트릭이 0일이거나 페이지 구조 변경 가능성.`);
        }
    } catch(error) {
        console.error(`[${EXT_NAME}] 스트릭 일수 확인 중 오류:`, error);
    }


    // --- 2. 최근 활동일(오늘) 색상 확인 (수정된 로직) ---
    try {
        // 스트릭 그래프 SVG 컨테이너 선택 (선택자 주의!)
        const streakGraphContainer = document.querySelector(SVG_CONTAINER_SELECTOR);

        if (streakGraphContainer) {
            // SVG 내에서 STREAK_RECT_SELECTOR와 일치하는 *첫 번째* 요소를 가져옵니다.
            // solved.ac 페이지 소스 구조상 이것이 가장 최근(오늘) 날짜를 나타낸다고 가정합니다.
            // !!! 웹사이트 구조 변경 시 이 로직이 틀릴 수 있습니다 !!!
            const todayRect = streakGraphContainer.querySelector(STREAK_RECT_SELECTOR);

            if (todayRect) { // 첫 번째 사각형 요소를 찾았다면
                const posX = todayRect.getAttribute('x');
                const posY = todayRect.getAttribute('y');
                statusMessage = `가장 최근 활동 사각형(첫 번째 rect 요소, x=${posX}, y=${posY}) 찾음.`;
                console.log(`[${EXT_NAME}] ${statusMessage}`, todayRect);

                // 찾은 사각형의 'fill' 색상 확인
                try {
                    const style = window.getComputedStyle(todayRect);
                    const color = style.fill;
                    console.log(`[${EXT_NAME}] 감지된 fill 색상:`, color);

                    // '안 푼' 상태에 해당하는 색상 값들 (소문자로 비교, #dddfe0 포함 확인)
                    // solved.ac에서 사용하는 정확한 '안 푼' 색상을 여기에 추가/수정해야 합니다.
                    const notSolvedColors = [
                        'rgb(221, 223, 224)', // #dddfe0 의 RGB 값
                        '#dddfe0',
                        'rgb(235, 237, 238)', // #ebedee 의 RGB 값
                        '#ebedee',
                        'grey'                // 혹시 모를 경우 대비
                        // 필요시 다른 회색 계열 색상 추가
                    ];

                    const lowerCaseColor = color?.toLowerCase();

                    if (lowerCaseColor && notSolvedColors.includes(lowerCaseColor)) {
                        solvedLastDay = false; // 안 푼 상태
                        statusMessage = `가장 최근 활동일에 풀지 않음 😥 (색상: ${color})`;
                    } else if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)' && color !== 'none') {
                        // 회색 계열이 아니고, 투명하지 않으면 푼 것으로 간주
                        solvedLastDay = true; // 푼 상태
                        statusMessage = `가장 최근 활동일에 해결! 🎉 (색상: ${color})`;
                    } else {
                        // 색상이 없거나 투명한 경우 (거의 발생하지 않음)
                        solvedLastDay = null; // 상태 모름
                        statusMessage = `가장 최근 활동일 색상 불분명 (상태 모름. 색상: ${color})`;
                        console.warn(`[${EXT_NAME}] 사각형 fill 색상이 유효하지 않거나 투명함:`, color);
                    }
                } catch (error) {
                    statusMessage = '색상 확인 중 오류 발생: ' + error.message;
                    console.error(`[${EXT_NAME}] 사각형 fill 색상 확인 오류:`, error);
                    solvedLastDay = null; // 오류 시 상태 모름
                }
            } else {
                // SVG는 찾았지만 그 안에서 rect 요소를 찾지 못한 경우
                statusMessage = `스트릭 사각형 요소(${STREAK_RECT_SELECTOR})를 SVG 컨테이너 내에서 찾지 못했습니다. 선택자나 페이지 구조를 확인하세요.`;
                solvedLastDay = null; // 상태 모름
                console.warn(`[${EXT_NAME}] ${statusMessage}`);
            }
        } else {
            // SVG 컨테이너 자체를 찾지 못한 경우
            statusMessage = `스트릭 SVG 그래프 컨테이너(${SVG_CONTAINER_SELECTOR})를 찾지 못했습니다. 페이지 구조 변경 가능성이 높습니다.`;
            solvedLastDay = null; // 상태 모름
            console.warn(`[${EXT_NAME}] ${statusMessage}`);
        }
    } catch(error) {
        // 전체 스트릭 사각형 검색 로직에서 오류 발생 시
        statusMessage = '스트릭 사각형 검색 중 예외 발생: ' + error.message;
        console.error(`[${EXT_NAME}] ${statusMessage}`, error);
        solvedLastDay = null; // 상태 모름
    }

    // --- 3. 최종 결과 로그 및 백그라운드 전송 ---
    const solvedStateStr = solvedLastDay === null ? '상태 모름' : (solvedLastDay ? '해결' : '미해결');
    console.log(`[${EXT_NAME}] ${targetUsername} 최종 결과: ${statusMessage}, 상태: ${solvedStateStr}, 스트릭: ${streakCount ?? 'N/A'}`);

    try {
        await chrome.runtime.sendMessage({
            type: "streakStatusUpdate",
            payload: {
                solved: solvedLastDay,      // 오늘 해결 여부
                username: targetUsername,
                streakCount: streakCount,   // 현재 스트릭 일수
                timestamp: timestamp        // 확인 시각
            }
        });
        console.log(`[${EXT_NAME}] 백그라운드로 상태 업데이트 메시지 전송 성공.`);
    } catch (error) {
        // 백그라운드 스크립트가 비활성화되었거나 기타 이유로 메시지 전송 실패 시
        // content script는 할 수 있는 것이 많지 않으므로 에러 로깅만 합니다.
        console.error(`[${EXT_NAME}] 백그라운드 메시지 전송 실패:`, error?.message || error);
        if (error?.message?.includes('Receiving end does not exist')) {
             console.warn(`[${EXT_NAME}] 백그라운드 연결 오류. 확장 프로그램이 비활성화/업데이트되었을 수 있습니다.`);
        }
    }
}

// --- 스크립트 실행 시작 지점 ---
(async () => {
    console.log(`[${EXT_NAME}] 스토리지에서 타겟 사용자명 읽는 중...`);
    try {
        // chrome.storage.sync API 사용 확인
        if (!chrome.storage || !chrome.storage.sync) {
            console.error(`[${EXT_NAME}] chrome.storage.sync API를 사용할 수 없습니다.`);
            return;
        }

        const { targetUsername } = await chrome.storage.sync.get(['targetUsername']);

        if (!targetUsername) {
            console.log(`[${EXT_NAME}] 확장 프로그램 팝업에서 타겟 사용자명이 설정되지 않았습니다. 검사를 건너뜁니다.`);
            return;
        }

        const currentPath = window.location.pathname;
        const pathParts = currentPath.split('/');
        // URL path가 /profile/<username> 형태인지 확인
        const currentPageUsername = (pathParts.length >= 3 && pathParts[1] === 'profile' && pathParts[2]) ? pathParts[2] : null;

        console.log(`[${EXT_NAME}] 타겟 사용자명: ${targetUsername}, 현재 페이지 사용자명: ${currentPageUsername}`);

        // 대소문자 구분 없이 사용자명 비교
        if (currentPageUsername && currentPageUsername.toLowerCase() === targetUsername.toLowerCase()) {
            console.log(`[${EXT_NAME}] 현재 페이지가 타겟 사용자(${targetUsername})와 일치합니다. 스트릭 검사를 예약합니다.`);
            // 페이지 로딩 및 특히 SVG 같은 동적 컨텐츠 렌더링 시간을 고려하여 약간의 지연 후 실행
            // solved.ac 페이지 로딩 속도에 따라 이 시간(밀리초) 조절 필요 가능성 있음
            setTimeout(() => checkStreakStatus(targetUsername), 1500); // 1.5초 지연 (필요시 조절)
        } else {
            console.log(`[${EXT_NAME}] 현재 페이지(${currentPageUsername})는 타겟 사용자의 프로필(${targetUsername})이 아닙니다. 검사를 실행하지 않습니다.`);
        }
    } catch (error) {
        console.error(`[${EXT_NAME}] 사용자명 로딩 또는 스크립트 실행 중 오류:`, error);
    }
})();