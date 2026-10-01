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

test('Vivaldi: exhausted pool creates a pool tab; emulated hi-DPR shot is downscaled instead of repeating', {
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

    await run('eval', second, `document.body.style.margin=0;for(let i=0;i<20;i++)document.body.insertAdjacentHTML('beforeend',
      '<div style="height:200px;background:rgb('+(i*12)+','+(240-i*12)+',128)"></div>');1`);
    await run('evalraw', second, 'Emulation.setDeviceMetricsOverride', JSON.stringify({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }));
    await run('eval', second, 'scrollTo(0,500),1');
    const file = join(dir, 'shot.png');
    const shot = (await run('shot', second, file, '--fresh')).stdout;
    assert.match(shot, /Downscaled/, 'emulated 1688px output exceeds the Xvfb window surface');
    const ratio = Number(shot.match(/divide by ([\d.]+)/)[1]);
    const expected = JSON.parse((await run('eval', second, 'getComputedStyle(document.elementFromPoint(10,800)).backgroundColor.match(/\\d+/g).map(Number)')).stdout);
    const { stdout: pixel } = await exec('python3', ['-c', `import sys,json
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB'); r=float(sys.argv[2])
print(json.dumps(im.getpixel((round(10*r),round(800*r)))))`, file, String(ratio)]);
    JSON.parse(pixel).forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= 3, `bottom of shot must show the block at CSS y=800, got ${pixel} want ${expected}`));
  } finally {
    await run('stop').catch(() => {});
    browser?.kill('SIGTERM');
    xvfb?.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
