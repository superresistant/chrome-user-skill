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

for (const [name, browserBin] of [['Chrome', process.env.CDP_TEST_CHROME], ['Vivaldi', process.env.CDP_TEST_VIVALDI]]) {
  test(`${name}: keyboard routing and background-tab policy`, {
    skip: !browserBin && `Set CDP_TEST_${name.toUpperCase()}; Vivaldi additionally requires Xvfb`,
    timeout: 60000,
  }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'cdp-keyboard-test-'));
    const portFile = join(dir, 'profile', 'DevToolsActivePort');
    const env = { ...process.env, XDG_RUNTIME_DIR: dir, CDP_PORT_FILE: portFile,
      CDP_HOST: '127.0.0.1', CDP_TIMEOUT_MS: '5000', CDP_IDLE_MS: '60000', CDP_ALLOW_FOCUS: '0' };
    let xvfb, browser, ws, target, other;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<meta name=viewport content="width=device-width,initial-scale=1">
        <dialog><button id=first>Close</button><button id=second>Next</button><input id=text></dialog>
        <script>window.events=[];document.addEventListener('keydown',e=>events.push({key:e.key,shift:e.shiftKey,trusted:e.isTrusted}),true);
        document.querySelector('dialog').showModal();document.querySelector('#first').focus()</script>`);
    });
    const runWith = async (allowFocus, ...args) => (await exec(process.execPath, [cli, ...args], {
      env: { ...env, CDP_ALLOW_FOCUS: allowFocus ? '1' : '0' }, timeout: 15000,
    })).stdout.trim();
    const run = (...args) => runWith(false, ...args);
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      if (name === 'Vivaldi') {
        xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1600x1200x24', '-nolisten', 'tcp'], {
          stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
        });
        env.DISPLAY = await new Promise((resolve, reject) => {
          xvfb.stdio[3].once('data', data => resolve(':' + data.toString().trim()));
          xvfb.once('error', reject);
          xvfb.once('exit', () => reject(new Error('Xvfb exited before display allocation')));
        });
      }
      browser = spawn(browserBin, [...(name === 'Chrome' ? ['--headless=new'] : []),
        `--user-data-dir=${join(dir, 'profile')}`, '--remote-debugging-port=0', '--remote-allow-origins=*',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], {
        env, stdio: 'ignore',
      });
      let port, path;
      for (let i = 0; i < 150; i++) {
        try { [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n'); break; } catch {}
        await delay(100);
      }
      assert.ok(port, 'browser must expose its isolated port');
      ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      const pending = new Map();
      let id = 0;
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      };
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timeout`)); }, 7000);
        pending.set(key, message => {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        ws.send(JSON.stringify({ id: key, method, params }));
      });
      await delay(1500);
      const url = `http://127.0.0.1:${server.address().port}/`;
      target = (await send('Target.createTarget', { url })).targetId;
      await send('Target.activateTarget', { targetId: target });
      await delay(1500);
      other = (await send('Target.createTarget', { url })).targetId;
      const ev = (tab, expression) => run('eval', tab, expression).then(JSON.parse);
      const state = tab => ev(tab, '({focus:document.hasFocus(),active:document.activeElement.id,open:document.querySelector("dialog").open,text:document.querySelector("#text").value,events})');
      const reset = async () => {
        for (const tab of [target, other]) await ev(tab,
          '(()=>{const d=document.querySelector("dialog");if(!d.open)d.showModal();document.querySelector("#first").focus();document.querySelector("#text").value="";events=[];return true})()');
      };
      const key = async (allowFocus, type, key, modifiers = 0) => {
        const params = { type, key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 27, modifiers };
        await runWith(allowFocus, 'evalraw', target, 'Input.dispatchKeyEvent', JSON.stringify(params));
        await runWith(allowFocus, 'evalraw', target, 'Input.dispatchKeyEvent', JSON.stringify({ ...params, type: 'keyUp' }));
      };
      await send('Target.activateTarget', { targetId: target });
      await reset();
      await key(name === 'Vivaldi', 'keyDown', 'Tab');
      assert.equal((await state(target)).active, 'second');
      await key(name === 'Vivaldi', 'keyDown', 'Tab', 8);
      assert.equal((await state(target)).active, 'first');
      await key(name === 'Vivaldi', 'keyDown', 'Escape');
      assert.equal((await state(target)).open, false);
      assert.ok((await state(target)).events.every(event => event.trusted));
      assert.equal((await state(other)).events.length, 0);
      await reset();
      await ev(target, 'document.querySelector("#text").focus();true');
      await runWith(name === 'Vivaldi', 'type', target, 'typed');
      await runWith(name === 'Vivaldi', 'evalraw', target, 'Input.insertText', '{"text":" raw"}');
      assert.equal((await state(target)).text, 'typed raw');
      assert.equal((await state(other)).text, '');

      await send('Target.activateTarget', { targetId: other });
      await run('wake', target);
      for (const width of [1440, 390, 320]) await t.test(`${width}px background input`, async () => {
        await run('evalraw', target, 'Emulation.setDeviceMetricsOverride', JSON.stringify({
          width, height: 900, deviceScaleFactor: 1, mobile: width < 500,
        }));
        await reset();
        assert.equal((await state(target)).focus, true);
        if (name === 'Vivaldi') {
          for (const type of ['keyDown', 'rawKeyDown']) await assert.rejects(key(false, type, 'Tab'), error => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /Vivaldi.*another active tab/);
            return true;
          });
          for (const tab of [target, other]) await ev(tab, 'document.querySelector("#text").focus();true');
          for (const args of [['type', target, 'probe'], ['evalraw', target, 'Input.insertText', '{"text":"probe"}']]) {
            await assert.rejects(run(...args), error => {
              assert.match(error.stderr, /Vivaldi.*another active tab/);
              return true;
            });
          }
          for (const tab of [target, other]) {
            const after = await state(tab);
            assert.equal(after.events.length, 0);
            assert.equal(after.open, true);
            assert.equal(after.text, '');
            assert.equal(after.active, 'text');
          }
        } else {
          await key(false, 'rawKeyDown', 'Tab');
          assert.equal((await state(target)).active, 'second');
          await key(false, 'keyDown', 'Tab', 8);
          assert.equal((await state(target)).active, 'first');
          await key(false, 'keyDown', 'Escape');
          assert.equal((await state(target)).open, false);
          assert.equal((await state(target)).events.length, 3);
          assert.equal((await state(other)).events.length, 0);
          assert.equal((await state(other)).open, true);
        }
      });
    } finally {
      for (const tab of [target, other]) if (tab) await run('stop', tab).catch(() => {});
      ws?.close();
      browser?.kill('SIGTERM');
      await delay(300);
      xvfb?.kill('SIGTERM');
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
