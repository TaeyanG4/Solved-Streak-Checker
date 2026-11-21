import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

function packagedFiles() {
  const src = read('scripts/package.py');
  const block = src.match(/INCLUDE = \[([\s\S]*?)\]/);
  assert.ok(block, 'scripts/package.py의 INCLUDE 목록을 찾지 못함');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 확장 프로그램이 실행 중에 불러오는 파일 목록 */
function referencedFiles() {
  const files = new Set(['manifest.json', manifest.background.service_worker, manifest.action.default_popup]);
  for (const cs of manifest.content_scripts) for (const js of cs.js) files.add(js);
  for (const icon of Object.values(manifest.icons)) files.add(icon);
  for (const icon of Object.values(manifest.action.default_icon)) files.add(icon);
  const html = read(manifest.action.default_popup);
  for (const m of html.matchAll(/(?:src|href)="([^":#]+)"/g)) files.add(m[1]);
  // ES module import (상대 경로)
  const queue = [manifest.background.service_worker, 'popup.js'];
  while (queue.length) {
    const file = queue.pop();
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    for (const m of read(file).matchAll(/from '(\.[^']+)'/g)) {
      const resolved = new URL(m[1], new URL(dir || './', root)).href.slice(root.href.length);
      if (!files.has(resolved)) queue.push(resolved);
      files.add(resolved);
    }
  }
  files.add('images/icon128.png'); // 알림 아이콘
  return [...files];
}

describe('manifest', () => {
  test('MV3 + 최소 권한', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'notifications', 'storage']);
    assert.deepEqual(manifest.host_permissions, ['https://solved.ac/*']);
    assert.equal(manifest.background.type, 'module');
    assert.deepEqual(manifest.content_scripts[0].matches, ['https://solved.ac/*']);
  });
  test('package.json과 버전이 같다', () => {
    assert.equal(manifest.version, pkg.version);
  });
  test('참조하는 파일이 모두 존재한다', () => {
    for (const f of referencedFiles()) assert.ok(existsSync(new URL(f, root)), f);
  });
  test('배포 zip에 실행에 필요한 파일이 모두 들어간다', () => {
    const packaged = new Set(packagedFiles());
    for (const f of referencedFiles()) assert.ok(packaged.has(f), `package.py INCLUDE에 ${f} 없음`);
    for (const f of readdirSync(new URL('lib/', root))) assert.ok(packaged.has(`lib/${f}`), `lib/${f}`);
    for (const f of packaged) assert.ok(existsSync(new URL(f, root)), f);
  });
  test('Chrome이 거부하는 _로 시작하는 파일/폴더가 없다', () => {
    for (const entry of readdirSync(root)) assert.ok(!entry.startsWith('_'), entry);
  });
});
