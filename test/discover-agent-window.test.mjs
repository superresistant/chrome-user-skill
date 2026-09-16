import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../skills/chrome-user/scripts/discover-agent-window.mjs', import.meta.url), 'utf8')
  .replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');

async function discover(url) {
  const pages = [
    { targetId: 'FD55E7610000', url, windowId: 2 },
    { targetId: 'AAAAAAAA0000', url: 'https://user.test/a', windowId: 1 },
    { targetId: 'BBBBBBBB0000', url: 'https://user.test/b', windowId: 1 },
  ].map(p => ({ ...p, type: 'page' }));
  let stdout = '', stderr = '';
  class WebSocket {
    constructor() { queueMicrotask(() => this.onopen()); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      let result;
      if (method === 'Target.getTargets') result = { targetInfos: pages };
      else if (method === 'Browser.getWindowForTarget') {
        result = { windowId: pages.find(p => p.targetId === params.targetId).windowId };
      } else throw new Error(`Unexpected browser command: ${method}`);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, result }) }));
    }
    close() {}
  }
  await runInNewContext(`(async () => {${source}\n})()`, {
    readFileSync: () => '12345\n/devtools/browser/test', homedir: () => '/test',
    WebSocket, setTimeout: () => {},
    process: {
      env: {}, stdout: { write: text => { stdout += text; } },
      stderr: { write: text => { stderr += text; } },
      exit: code => { throw new Error(`Unexpected exit ${code}: ${stderr}`); },
    },
  });
  return { fields: Object.fromEntries(stdout.trim().split('\n').map(line => line.split('='))), stderr };
}

for (const url of [
  'http://127.0.0.1:8672/vad?dataset=vad-followup-8-20260916',
  'http://localhost:3000/', 'https://localhost/dashboard',
  'https://example.com/', 'https://www.example.com/',
  'https://bank.test/form', 'about:blank#task-content',
  'chrome://vivaldi-webui/startpage-other',
]) {
  test(`nonblank seed: ${url}`, async () => {
    const { fields, stderr } = await discover(url);
    assert.equal(fields.AGENT_WINDOW_ID, '2');
    assert.equal(fields.AGENT_SEED_TAB, 'FD55E761');
    assert.equal(fields.AGENT_SEED_BLANK, '0');
    assert.match(stderr, /seed tab is a real page/);
    assert.match(stderr, /occupied leases may belong to other tasks/);
    assert.doesNotMatch(stderr, /will be initialized/);
  });
}

for (const url of ['about:blank', 'about:blank#pi-agent-pool',
  'chrome://vivaldi-webui/startpage?section=Speed-dials', 'chrome://newtab/']) {
  test(`reusable seed: ${url}`, async () => {
    const { fields, stderr } = await discover(url);
    assert.equal(fields.AGENT_SEED_BLANK, '1');
    assert.doesNotMatch(stderr, /seed tab is a real page/);
  });
}
