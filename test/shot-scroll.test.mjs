import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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

for (const zoom of [1, 1.25]) test(`fresh screenshots preserve scroll and fixed elements at page zoom ${zoom}`, {
  skip: !browserBin && 'Set CDP_TEST_CHROME; uses isolated headless Chrome and Python Pillow', timeout: 60000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cdp-shot-test-'));
  const portFile = join(dir, 'profile', 'DevToolsActivePort');
  await mkdir(join(dir, 'profile', 'Default'), { recursive: true });
  await writeFile(join(dir, 'profile', 'Default', 'Preferences'), JSON.stringify({
    partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } },
  }));
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, CDP_PORT_FILE: portFile,
    CDP_HOST: '127.0.0.1', CDP_TIMEOUT_MS: '5000', CDP_IDLE_MS: '10000' };
  const run = async (...args) => (await exec(process.execPath, [cli, ...args], { env, timeout: 15000 })).stdout.trim();
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<style>
      html {scroll-behavior:auto} body {margin:0;width:2600px;height:3200px;
      background:lime}
      #blue {position:absolute;top:700px;left:1000px;width:1600px;height:2500px;background:blue}
      #hero {position:absolute;top:0;left:0;width:2600px;height:700px;background:red}
      #fixed {position:fixed;top:20px;left:20px;width:30px;height:30px;background:yellow}
      </style><div id=blue></div><div id=hero></div><div id=fixed></div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = spawn(browserBin, ['--headless=new', `--user-data-dir=${join(dir, 'profile')}`,
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--force-device-scale-factor=1.25', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
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
    const raw = (method, params = {}) => run('evalraw', target, method, JSON.stringify(params));
    assert.ok(Math.abs(JSON.parse(await raw('Page.getLayoutMetrics')).cssVisualViewport.zoom - zoom) < 0.001);
    for (const emulated of [true, false]) {
      if (emulated) await raw('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
      });
      else await raw('Emulation.clearDeviceMetricsOverride');
      for (const [x, y, color] of [[0, 0, [255, 0, 0]], [0, 792, [0, 255, 0]], [1100, 850, [0, 0, 255]]]) {
        await run('eval', target, `(async()=>{scrollTo(${x},${y});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return true})()`);
        const metrics = JSON.parse(await run('eval', target, '({x:scrollX,y:scrollY,dpr:devicePixelRatio})'));
        assert.ok(Math.abs(metrics.x - x) < 1);
        assert.ok(Math.abs(metrics.y - y) < 1);
        const images = [];
        for (const fresh of [false, true]) {
          const file = join(dir, fresh ? 'fresh.png' : 'plain.png');
          await run('shot', target, file, ...(fresh ? ['--fresh'] : []));
          const out = await exec('python3', ['-c', `from PIL import Image
import json,sys
im=Image.open(sys.argv[1]).convert('RGB');d=float(sys.argv[2])
print(json.dumps({'size':im.size,'body':im.getpixel((round(100*d),round(100*d))),'fixed':im.getpixel((round(30*d),round(30*d)))}))`, file, String(metrics.dpr)]);
          const image = JSON.parse(out.stdout);
          assert.deepEqual(image.body, color, `body emulated=${emulated} fresh=${fresh} scroll=${x},${y}`);
          assert.deepEqual(image.fixed, [255, 255, 0], `fixed emulated=${emulated} fresh=${fresh} scroll=${x},${y}`);
          images.push(image);
        }
        assert.deepEqual(images[1].size, images[0].size, `geometry emulated=${emulated}`);
      }
    }
  } finally {
    if (target) await run('stop', target).catch(() => {});
    browser.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
