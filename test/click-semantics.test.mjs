import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../skills/chrome-user/scripts/cdp.mjs', import.meta.url));
const browserBin = process.env.CDP_TEST_CHROME;

test('click is DOM-only; clickxy supplies trusted input to a visible match', {
  skip: !browserBin && 'Set CDP_TEST_CHROME; uses an isolated headless profile', timeout: 30000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cdp-click-test-'));
  const portFile = join(dir, 'profile', 'DevToolsActivePort');
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, CDP_PORT_FILE: portFile,
    CDP_HOST: '127.0.0.1', CDP_TIMEOUT_MS: '5000', CDP_IDLE_MS: '10000' };
  const run = async (...args) => (await exec(process.execPath, [cli, ...args], {
    env, timeout: 10000,
  })).stdout.trim();
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<button id=hidden aria-label=Share style="display:none">Share</button>
      <button id=visible aria-label=Share>Share</button><script>
      window.events=[];window.opened=false;
      for(const button of document.querySelectorAll('button')) {
        button.onmousedown=e=>events.push({id:button.id,type:e.type,trusted:e.isTrusted});
        button.onclick=e=>{events.push({id:button.id,type:e.type,trusted:e.isTrusted});if(e.isTrusted)opened=true};
      }</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = spawn(browserBin, ['--headless=new', `--user-data-dir=${join(dir, 'profile')}`,
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
  let target;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await readFile(portFile, 'utf8')).split('\n')[0]; break; } catch {}
      await delay(100);
    }
    assert.ok(port);
    for (let i = 0; i < 50; i++) {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = pages.find(p => p.type === 'page' && p.url === 'about:blank')?.id;
      if (target) break;
      await delay(100);
    }
    assert.ok(target);
    await run('open', `http://127.0.0.1:${server.address().port}/`, '--in', target);
    const state = () => run('eval', target, '({events,opened})').then(JSON.parse);
    await run('click', target, '#visible');
    assert.deepEqual(await state(), { events: [{ id: 'visible', type: 'click', trusted: false }], opened: false });
    await run('click', target, 'button[aria-label=Share]');
    assert.deepEqual((await state()).events.at(-1), { id: 'hidden', type: 'click', trusted: false });
    const point = JSON.parse(await run('eval', target, `(()=>{
      const el=[...document.querySelectorAll('button[aria-label=Share]')].find(el=>{
        const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility==='visible';
      });el.scrollIntoView({block:'center',behavior:'instant'});
      const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`));
    await run('clickxy', target, String(point.x), String(point.y));
    const after = await state();
    assert.equal(after.opened, true);
    assert.deepEqual(after.events.slice(-2), [
      { id: 'visible', type: 'mousedown', trusted: true },
      { id: 'visible', type: 'click', trusted: true },
    ]);
  } finally {
    if (target) await run('stop', target).catch(() => {});
    browser.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
