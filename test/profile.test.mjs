import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const scripts = new URL('../skills/chrome-user/scripts/', import.meta.url);
const cdp = fileURLToPath(new URL('cdp.mjs', scripts));
const profile = fileURLToPath(new URL('profile.mjs', scripts));
const browserBin = process.env.CDP_TEST_CHROME;

test('dedicated profile persists cookies across restarts and isolates cdp state', {
  skip: !browserBin && 'Set CDP_TEST_CHROME to a Chrome binary',
  timeout: 90000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cdp-profile-test-'));
  const env = { ...process.env, CDP_PROFILE_ROOT: root, CDP_PROFILE_BROWSER: browserBin, PI_CODING_AGENT_PID: String(process.pid) };
  const server = createServer((req, res) => {
    if (req.url === '/set') res.setHeader('Set-Cookie', 'session=kept; Max-Age=86400; Path=/');
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>ok</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const run = async (...args) => (await exec(process.execPath, [profile, ...args], { env, timeout: 30000 })).stdout.trim();
  const withProfile = async () => {
    const exports = await run('start', 't1');
    const vars = Object.fromEntries([...exports.matchAll(/export (\w+)='([^']*)'/g)].map(m => [m[1], m[2]]));
    const cenv = { ...env, ...vars, CDP_TIMEOUT_MS: '10000' };
    const c = async (...args) => (await exec(process.execPath, [cdp, ...args], { env: cenv, timeout: 30000 })).stdout.trim();
    const tab = (await c('list')).split('\n').find(l => l.includes('about:blank') || l.includes('127.0.0.1')).split(/\s+/)[0];
    return { c, tab, vars };
  };
  try {
    let { c, tab, vars } = await withProfile();
    assert.ok(vars.CDP_PORT_FILE.startsWith(root) && vars.CDP_RUNTIME_DIR.startsWith(root));
    await c('nav', tab, url + 'set');
    assert.equal(await c('eval', tab, 'document.cookie'), 'session=kept');
    assert.doesNotMatch(await c('eval', tab, 'navigator.userAgent'), /Headless/);
    assert.equal(await c('eval', tab, 'navigator.webdriver'), 'false');
    const display = (await run('status', 't1')).match(/virtual display :(\d+)/)?.[1];
    assert.ok(display, 'background profile runs on its own Xvfb display');
    assert.equal(await c('eval', tab, 'screen.width'), '1920');
    assert.match(await run('start', 't1'), /CDP_PORT_FILE/, 'second start reuses the running browser');
    assert.match(await run('stop', 't1'), /stopped/);
    await delay(500);
    assert.equal(existsSync(`/tmp/.X11-unix/X${display}`), false, 'stop shuts down the profile Xvfb');
    await assert.rejects(c('list'), /CDP_PORT_FILE .* not found/);
    ({ c, tab } = await withProfile());
    await c('nav', tab, url);
    assert.equal(await c('eval', tab, 'document.cookie'), 'session=kept');
    assert.match(await run('list'), /t1 {2}running/);
    const other = env;
    const runIn = (cwd, e, ...args) => exec(process.execPath, [profile, ...args], { env: e, cwd, timeout: 30000 });
    await assert.rejects(runIn(tmpdir(), other, 'env', 't1'), /in use by/);
    await runIn(tmpdir(), { ...other, CDP_PROFILE_SHARE: '1' }, 'env', 't1');
    const info = JSON.parse(await readFile(join(root, 't1', 'pid'), 'utf8'));
    process.kill(info.pid, 'SIGKILL');
    await delay(1000);
    assert.match(await run('stop', 't1'), /not running/);
    await delay(500);
    assert.equal(existsSync(`/tmp/.X11-unix/X${info.display}`), false, 'stop after a browser crash still removes its Xvfb');
  } finally {
    await run('stop', 't1').catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
