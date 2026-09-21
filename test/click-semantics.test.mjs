import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

for (const zoom of [1, 1.25]) test(`trusted input and emulation calibration with browser zoom ${zoom}`, {
  skip: !browserBin && 'Set CDP_TEST_CHROME; uses an isolated headless profile', timeout: 60000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cdp-click-test-'));
  const portFile = join(dir, 'profile', 'DevToolsActivePort');
  await mkdir(join(dir, 'profile', 'Default'), { recursive: true });
  await writeFile(join(dir, 'profile', 'Default', 'Preferences'), JSON.stringify({
    partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } },
  }));
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, CDP_PORT_FILE: portFile,
    CDP_HOST: '127.0.0.1', CDP_TIMEOUT_MS: '5000', CDP_IDLE_MS: '10000' };
  const run = async (...args) => (await exec(process.execPath, [cli, ...args], {
    env, timeout: 10000,
  })).stdout.trim();
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<meta name="viewport" content="width=device-width,initial-scale=1">
      <button id=hidden aria-label=Share style="display:none">Share</button>
      <button id=visible aria-label=Share>Share</button><script>
      window.events=[];window.opened=false;
      for(const button of document.querySelectorAll('button')) {
        button.onmousedown=e=>events.push({id:button.id,type:e.type,trusted:e.isTrusted});
        button.onclick=e=>{events.push({id:button.id,type:e.type,trusted:e.isTrusted});if(e.isTrusted)opened=true};
      }
      window.probes=[];window.calibrating=false;
      for(const type of ['pointerdown','pointerup','touchstart','touchend','mousedown','mouseup','click']) {
        document.addEventListener(type,e=>{
          if(e.type==='pointerdown')probes.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted,kind:e.pointerType});
          if(calibrating){e.preventDefault();e.stopImmediatePropagation()}
        },{capture:true,passive:false});
      }</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = spawn(browserBin, ['--headless=new', `--user-data-dir=${join(dir, 'profile')}`,
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--force-device-scale-factor=1.25', 'about:blank'], { stdio: 'ignore' });
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

    const ev = expression => run('eval', target, expression).then(JSON.parse);
    const raw = (method, params = {}) => run('evalraw', target, method, JSON.stringify(params)).then(JSON.parse);
    assert.ok(Math.abs((await raw('Page.getLayoutMetrics')).cssVisualViewport.zoom - zoom) < 0.001);
    await ev(`document.querySelector('#visible').style.cssText='position:fixed;left:220px;top:110px;width:30px;height:28px';true`);
    await raw('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    for (const width of [320, 390]) for (const kind of ['mouse', 'touch']) {
      await t.test(`${width}px mobile ${kind}: measured transform hits the DOM target`, async () => {
        await raw('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
        const metrics = await raw('Page.getLayoutMetrics');
        assert.equal(metrics.cssVisualViewport.zoom, 1, 'mobile metrics hide the configured browser zoom');
        assert.equal(metrics.cssVisualViewport.scale, 1);
        const dispatch = async (x, y) => {
          if (kind === 'mouse') await run('clickxy', target, String(x), String(y));
          else {
            await raw('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
            await raw('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          }
        };
        await ev('probes=[];calibrating=true;opened=false;true');
        for (const n of [100, 200]) await dispatch(n, n);
        const probes = await ev('probes');
        assert.equal(probes.length, 2);
        assert.ok(probes.every(p => p.trusted && p.kind === kind));
        const sx = (probes[1].x - probes[0].x) / 100;
        const sy = (probes[1].y - probes[0].y) / 100;
        assert.ok(sx > 0 && sy > 0);
        assert.equal((await state()).opened, false, 'diagnostic probes must not open the test menu');
        await ev('calibrating=false;true');
        await dispatch((235 - probes[0].x) / sx + 100, (124 - probes[0].y) / sy + 100);
        const hit = (await ev('probes')).at(-1);
        assert.ok(Math.abs(hit.x - 235) < 0.1 && Math.abs(hit.y - 124) < 0.1, JSON.stringify(hit));
        assert.equal((await state()).opened, true, 'calibrated trusted input must open the test menu');
      });
    }
  } finally {
    if (target) await run('stop', target).catch(() => {});
    browser.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
