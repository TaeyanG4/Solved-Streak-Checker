// content.js — https://solved.ac/* 에서 실행되는 콘텐츠 스크립트
//
// solved.ac 페이지가 열리거나 다시 보이면 서비스 워커에 알려서, 방금 푼 문제가 있으면
// 곧바로 반영되게 한다(서비스 워커가 간격 제한을 지킨다).
// 페이지의 내용(DOM)이나 네트워크 요청은 읽지도 바꾸지도 않는다.

(() => {
  'use strict';

  function notifyVisit() {
    try {
      chrome.runtime.sendMessage({ type: 'pageVisit' }).catch(() => {
        // 확장 프로그램이 업데이트/비활성화되어 연결이 끊긴 경우: 할 수 있는 일이 없다.
      });
    } catch {
      // 확장 프로그램 컨텍스트가 무효화된 경우
    }
  }

  notifyVisit();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') notifyVisit();
  });
})();
