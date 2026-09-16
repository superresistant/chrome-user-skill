import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../skills/chrome-user/scripts/cdp.mjs', import.meta.url));
const browserBin = process.env.CDP_TEST_CHROME;

test('pool lease boundaries clear metrics and page scale in the persistent daemon', {
  skip: !browserBin && 'Set CDP_TEST_CHROME to a Chrome binary; uses an isolated headless profile',
  timeout: 90000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cdp-pool-test-'));
  const portFile = join(dir, 'profile', 'DevToolsActivePort');
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, CDP_PORT_FILE: portFile,
    CDP_HOST: '127.0.0.1', CDP_TIMEOUT_MS: '5000', CDP_IDLE_MS: '10000' };
  const run = async (...args) => (await exec(process.execPath, [cli, ...args], {
    env, timeout: 15000,
  })).stdout.trim();
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><input id="form">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = spawn(browserBin, ['--headless=new', `--user-data-dir=${join(dir, 'profile')}`,
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--window-size=1200,900', 'about:blank'], {
    stdio: 'ignore',
  });
  let target;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await readFile(portFile, 'utf8')).split('\n')[0]; break; } catch {}
      await delay(100);
    }
    assert.ok(port, 'isolated Chrome must expose its own debugging port');
    for (let i = 0; i < 50; i++) {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = pages.find(p => p.type === 'page' && p.url === 'about:blank')?.id;
      if (target) break;
      await delay(100);
    }
    assert.ok(target, 'isolated blank tab must be loaded');
    await run('open', url, '--in', target);
    const metrics = () => run('eval', target,
      '({screen:[screen.width,screen.height],viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,scale:visualViewport.scale})').then(JSON.parse);
    const baseline = await metrics();
    const raw = (method, params = {}) => run('evalraw', target, method, JSON.stringify(params));
    const dirty = async () => {
      await raw('Emulation.setDeviceMetricsOverride', { width: 390, height: 844,
        screenWidth: 390, screenHeight: 844, deviceScaleFactor: 2, mobile: true });
      await raw('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      assert.notDeepEqual(await metrics(), baseline);
    };
    const assertReleased = async () => {
      const metrics = await new Promise((resolve, reject) => {
        const conn = createConnection(join(dir, 'cdp', `cdp-${target}.sock`));
        let buffer = '';
        conn.setTimeout(5000, () => conn.destroy(new Error('daemon probe timeout')));
        conn.on('error', reject);
        conn.on('connect', () => conn.write(JSON.stringify({ id: 1, cmd: 'eval', args: [
          '({screen:[screen.width,screen.height],viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,scale:visualViewport.scale})',
        ] }) + '\n'));
        conn.on('data', data => {
          buffer += data;
          if (!buffer.includes('\n')) return;
          conn.end();
          const reply = JSON.parse(buffer.split('\n')[0]);
          if (!reply.ok) reject(new Error(reply.error));
          else resolve(JSON.parse(reply.result));
        });
      });
      assert.deepEqual(metrics, baseline, 'release must clear emulation before another acquisition');
    };

    await dirty();
    await run('nav', target, url);
    assert.equal((await metrics()).dpr, 2, 'ordinary navigation must preserve intentional emulation');
    await run('close', target);
    await assertReleased();
    await run('open', url, '--in', target);
    assert.deepEqual(await metrics(), baseline, 'release/re-lease must restore desktop metrics');

    await dirty();
    await run('pool-reset');
    await assertReleased();
    await run('open', url, '--in', target);
    assert.deepEqual(await metrics(), baseline, 'pool-reset must clear the existing daemon session');

    await dirty();
    await raw('Page.navigate', { url: 'about:blank#pi-agent-pool' });
    await rm(join(dir, 'cdp', `lease-${target}`));
    await run('open', url, '--in', target);
    assert.deepEqual(await metrics(), baseline, 'acquisition must also clean a legacy dirty marker');
  } finally {
    if (target) await run('stop', target).catch(() => {});
    browser.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
