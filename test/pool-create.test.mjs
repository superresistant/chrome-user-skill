import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../skills/chrome-user/scripts/cdp.mjs', import.meta.url));
const browserBin = process.env.CDP_TEST_VIVALDI;

test('Vivaldi: exhausted pool creates a background pool tab in the agent window', {
  skip: !browserBin && 'Set CDP_TEST_VIVALDI; requires Xvfb',
  timeout: 90000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cdp-pool-create-'));
  const portFile = join(dir, 'profile', 'DevToolsActivePort');
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, CDP_PORT_FILE: portFile, CDP_HOST: '127.0.0.1',
    CDP_TIMEOUT_MS: '8000', CDP_IDLE_MS: '60000', CDP_POOL_CREATE_IDLE_MS: '0',
    PI_CODING_AGENT_PID: String(process.pid) };
  const run = async (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 30000 });
  let xvfb, browser, first;
  try {
    xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1600x1200x24', '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    env.DISPLAY = await new Promise((resolve, reject) => {
      xvfb.stdio[3].once('data', data => resolve(':' + data.toString().trim()));
      xvfb.once('error', reject);
    });
    browser = spawn(browserBin, [`--user-data-dir=${join(dir, 'profile')}`, '--remote-debugging-port=0',
      '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', 'about:blank'], { env, stdio: 'ignore' });
    let port;
    for (let i = 0; i < 200 && !port; i++) {
      try { port = (await readFile(portFile, 'utf8')).split('\n')[0]; } catch { await delay(100); }
    }
    assert.ok(port, 'isolated Vivaldi must expose its port');
    await delay(1500);
    const opened = await exec(process.execPath, [cli, 'open', 'about:blank'], { env: { ...env, CDP_ALLOW_FOCUS: '1' }, timeout: 30000 });
    first = opened.stdout.match(/Opened new tab: (\w+)/)?.[1];
    assert.ok(first, 'isolated blank tab must open');
    assert.equal((await run('open', 'about:blank#one', '--in', first)).stdout.trim(), first.slice(0, 8));
    const { stdout, stderr } = await run('open', 'about:blank#two', '--in', first, '--wait', '15');
    const second = stdout.trim();
    assert.match(stderr, /created pool tab in window \d+/);
    assert.notEqual(second, first.slice(0, 8));
    const win = id => run('window', id).then(r => r.stdout.match(/windowId=(\d+)/)[1]);
    assert.equal(await win(second), await win(first));
    assert.equal((await run('eval', second, 'location.hash')).stdout.trim(), '#two');
    assert.match((await run('leases')).stdout, /0 free pool tab\(s\), 2 lease\(s\)/);
  } finally {
    await run('stop').catch(() => {});
    browser?.kill('SIGTERM');
    xvfb?.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
