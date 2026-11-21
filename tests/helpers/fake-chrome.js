// tests/helpers/fake-chrome.js — background.js를 Node에서 돌리기 위한 최소한의 chrome.* 가짜 구현
//
// 실제 Chrome처럼 동작해야 하는 부분:
//  * storage.set/remove는 비동기로 끝나고, 값이 바뀐 키만 onChanged로 알린다(다음 매크로태스크).
//  * alarms.create는 같은 이름을 덮어쓴다. 알람은 테스트가 fireAlarm()으로 직접 울린다.
//  * notifications.create는 같은 ID를 덮어쓴다.
//  * runtime.sendMessage는 등록된 onMessage 리스너에 sender와 함께 전달하고 sendResponse 값을 돌려준다.

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListeners: () => listeners.length > 0,
  };
}

function makeStorageArea(areaName, onChanged) {
  const data = new Map();
  const emit = (changes) => {
    if (Object.keys(changes).length === 0) return;
    setTimeout(() => {
      for (const fn of onChanged.listeners) fn(clone(changes), areaName);
    }, 0);
  };
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (data.has(k)) out[k] = clone(data.get(k));
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        const oldValue = data.get(k);
        if (JSON.stringify(oldValue) === JSON.stringify(v)) continue;
        data.set(k, clone(v));
        changes[k] = { oldValue: clone(oldValue), newValue: clone(v) };
      }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: clone(data.get(k)) };
        data.delete(k);
      }
      emit(changes);
    },
    async clear() {
      await this.remove([...data.keys()]);
    },
    // 실제 Chrome은 setAccessLevel을 session 저장소에만 제공한다(local/sync에는 없음).
    // 테스트에서 지원하는 경우를 흉내 내려면 enableAccessLevel(area, error?)를 쓴다.
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  };
}

/**
 * @param {{now: () => number, extensionId?: string}} opts
 */
export function createFakeChrome({ now, extensionId = 'testextensionid' } = {}) {
  const storageChanged = makeEvent();
  const alarms = new Map();
  const notifications = new Map();
  const createdTabs = [];
  const badge = { text: '', color: null, textColor: null, title: '' };
  const extensionOrigin = `chrome-extension://${extensionId}/`;

  const chrome = {
    runtime: {
      id: extensionId,
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onMessage: makeEvent(),
      getURL: (p) => `${extensionOrigin}${p}`,
      getManifest: () => ({ version: '2.0.0' }),
      openOptionsPage: async () => {
        createdTabs.push({ url: `${extensionOrigin}popup.html`, options: true });
      },
    },
    storage: {
      onChanged: storageChanged,
      sync: makeStorageArea('sync', storageChanged),
      local: makeStorageArea('local', storageChanged),
    },
    alarms: {
      onAlarm: makeEvent(),
      async create(name, info) {
        const t = now();
        const scheduledTime = info.when ?? t + (info.delayInMinutes ?? info.periodInMinutes) * 60000;
        alarms.set(name, { name, scheduledTime, ...(info.periodInMinutes && { periodInMinutes: info.periodInMinutes }) });
      },
      async get(name) {
        return clone(alarms.get(name));
      },
      async getAll() {
        return [...alarms.values()].map(clone);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async clearAll() {
        alarms.clear();
        return true;
      },
    },
    notifications: {
      onClicked: makeEvent(),
      onButtonClicked: makeEvent(),
      onClosed: makeEvent(),
      failCreate: null, // 테스트에서 Error를 넣으면 create가 실패한다
      async create(id, options) {
        if (chrome.notifications.failCreate) throw chrome.notifications.failCreate;
        notifications.set(id, clone(options));
        chrome.notifications.history.push({ id, ...clone(options), at: now() });
        return id;
      },
      history: [],
      async clear(id) {
        return notifications.delete(id);
      },
      async getAll() {
        return Object.fromEntries([...notifications.keys()].map((k) => [k, true]));
      },
      async getPermissionLevel() {
        return 'granted';
      },
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
      async setBadgeTextColor({ color }) {
        badge.textColor = color;
      },
      async setTitle({ title }) {
        badge.title = title;
      },
    },
    tabs: {
      async create({ url }) {
        createdTabs.push({ url });
        return { id: createdTabs.length };
      },
    },
    windows: {
      async create({ url }) {
        createdTabs.push({ url, window: true });
      },
    },
  };

  /** 팝업(확장 페이지)에서 보낸 것처럼 메시지를 보낸다 */
  function sendMessage(message, sender = { id: extensionId, url: `${extensionOrigin}popup.html` }) {
    return new Promise((resolve) => {
      let async = false;
      let responded = false;
      const sendResponse = (v) => {
        responded = true;
        resolve(v);
      };
      for (const fn of chrome.runtime.onMessage.listeners) {
        if (fn(message, sender, sendResponse) === true) async = true;
      }
      if (!async && !responded) resolve(undefined);
    });
  }

  function fireAlarm(name) {
    const alarm = alarms.get(name) ?? { name, scheduledTime: now() };
    if (!alarm.periodInMinutes) alarms.delete(name);
    for (const fn of chrome.alarms.onAlarm.listeners) fn(clone(alarm));
  }

  return { chrome, alarms, notifications, badge, createdTabs, sendMessage, fireAlarm };
}

/** 저장소에 setAccessLevel을 붙인다. error를 주면 호출 시 실패한다. */
export function enableAccessLevel(area, error = null) {
  area.setAccessLevel = async ({ accessLevel }) => {
    if (error) throw error;
    area.accessLevel = accessLevel;
  };
}

/** 대기 중인 비동기 작업(타이머 0, 마이크로태스크)이 끝날 때까지 기다린다 */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}
