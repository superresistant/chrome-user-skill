#!/usr/bin/env node
// Dedicated persistent browser profiles for agent-owned accounts, separate from the user's Vivaldi.

import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { execFileSync, spawn } from 'child_process';

const ROOT = process.env.CDP_PROFILE_ROOT || resolve(homedir(), '.local/share/pi-browser-profiles');
const BROWSER = process.env.CDP_PROFILE_BROWSER || 'google-chrome';
const USAGE = `profile.mjs start <name> [--headed] | show <name> | stop <name> | status <name> | env <name> | list

start   launch (or reuse) Chrome on ~/.local/share/pi-browser-profiles/<name>; on a private Xvfb display unless --headed (headless if Xvfb missing)
        (--headed shows a window on the user's desktop: only for human verification/CAPTCHA)
show    open a VNC viewer on the user's desktop onto the profile's virtual display (same page/fingerprint; only when the user is asked
        to solve a CAPTCHA); closes when the viewer closes
env     print exports for cdp.mjs: eval "$(node profile.mjs env <name>)"
stop    graceful shutdown (cookies persist)`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function paths(name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name || '')) throw new Error('profile name: lowercase letters, digits, . _ -');
  const dir = resolve(ROOT, name);
  return { dir, profile: resolve(dir, 'profile'), runtime: resolve(dir, 'runtime'), pid: resolve(dir, 'pid'),
    port: resolve(dir, 'profile', 'DevToolsActivePort'), log: resolve(dir, 'browser.log') };
}

function running(p) {
  let info;
  try { info = JSON.parse(readFileSync(p.pid, 'utf8')); } catch { return null; }
  try { process.kill(info.pid, 0); } catch { return null; }
  try {
    if (!readFileSync(`/proc/${info.pid}/cmdline`, 'utf8').includes(`--user-data-dir=${p.profile}`)) return null;
  } catch { return null; }
  return existsSync(p.port) ? info : null;
}

function envLines(p) {
  return `export CDP_PORT_FILE='${p.port}'\nexport CDP_RUNTIME_DIR='${p.runtime}'`;
}

const MY_PID = Number(process.env.PI_CODING_AGENT_PID) || null;

// One agent (cwd, or same Pi pid after cd) per running profile: profiles have no tab leases
function assertOwner(name, info) {
  const o = info.owner;
  if (!o || o.cwd === process.cwd() || (MY_PID && o.pid === MY_PID) || process.env.CDP_PROFILE_SHARE === '1') return;
  let alive = false;
  try { if (o.pid) { process.kill(o.pid, 0); alive = true; } } catch {}
  if (alive) throw new Error(`profile ${name} is in use by ${o.cwd} (pid ${o.pid}); ask that agent, or set CDP_PROFILE_SHARE=1 if it agreed`);
}

async function browserCall(p, fn) {
  const [port, path] = readFileSync(p.port, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to profile browser')); setTimeout(() => rej(new Error('connect timeout')), 5000); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const key = ++id;
    pending.set(key, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.delete(key)) rej(new Error(`${method} timeout`)); }, 5000);
  });
  try { return await fn(send); } finally { ws.close(); }
}

async function webdriverFlag(p) {
  return browserCall(p, async send => {
    let page;
    for (let i = 0; i < 30 && !page; i++) {
      page = (await send('Target.getTargets')).targetInfos.find(t => t.type === 'page');
      if (!page) await sleep(100);
    }
    if (!page) return null;
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const { result } = await send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true }, sessionId);
    await send('Target.detachFromTarget', { sessionId });
    return result.value;
  });
}

async function start(name, headed) {
  const p = paths(name);
  const current = running(p);
  if (current) {
    assertOwner(name, current);
    if (current.headed !== headed) throw new Error(`profile ${name} already running ${current.headed ? 'headed' : 'in background'}; stop it first to switch`);
    try {
      const installed = execFileSync(BROWSER, ['--version'], { encoding: 'utf8' }).match(/[\d.]+/)?.[0];
      const { product } = await browserCall(p, send => send('Browser.getVersion'));
      if (installed && !product.endsWith(installed)) process.stderr.write(`profile ${name} runs ${product} but ${installed} is installed; stop/start it when idle\n`);
    } catch {}
    console.log(envLines(p));
    return;
  }
  for (const dir of [p.dir, p.profile, p.runtime]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(p.port, { force: true });
  const args = [`--user-data-dir=${p.profile}`, '--remote-debugging-port=0',
    '--disable-blink-features=AutomationControlled',
    // OptimizationHints: drops PassageEmbeddingsService (~80 MB/profile); --test-type: no unsupported-flag infobar shrinking the viewport
    '--disable-features=BackForwardCache,SpareRendererForSitePerProcess,OptimizationHints', '--test-type',
    '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--window-size=1280,900'];
  const env = { ...process.env };
  let display = null;
  let xvfbPid = null;
  if (!headed && existsSync('/usr/bin/Xvfb')) {
    // -displayfd lets Xvfb pick a free display atomically (concurrent starts)
    const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    display = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Xvfb did not report a display')), 5000);
      xvfb.stdio[3].once('data', d => { clearTimeout(timer); done(Number(String(d).trim())); });
      xvfb.once('exit', code => { clearTimeout(timer); fail(new Error(`Xvfb exited (${code})`)); });
    });
    xvfb.stdio[3].destroy();
    xvfb.removeAllListeners('exit');
    xvfb.unref();
    xvfbPid = xvfb.pid;
    env.DISPLAY = `:${display}`;
    if (existsSync('/usr/bin/openbox')) spawn('openbox', [], { detached: true, stdio: 'ignore', env }).unref();
    args.push('--use-angle=vulkan', '--enable-features=Vulkan');
  } else if (!headed) {
    const major = execFileSync(BROWSER, ['--version'], { encoding: 'utf8' }).match(/(\d+)\./)?.[1];
    args.push('--headless=new');
    if (major) args.push(`--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`);
  }
  args.push('about:blank');
  const log = openSync(p.log, 'a');
  const child = spawn(BROWSER, args, { detached: true, stdio: ['ignore', log, log], env });
  child.unref();
  writeFileSync(p.pid, JSON.stringify({ pid: child.pid, headed, display, xvfbPid, started: new Date().toISOString(),
    owner: { cwd: process.cwd(), pid: MY_PID } }), { mode: 0o600 });
  for (let i = 0; i < 150 && !existsSync(p.port); i++) await sleep(100);
  if (!existsSync(p.port)) {
    killXvfb(xvfbPid);
    throw new Error(`browser did not expose a debugging port; see ${p.log}`);
  }
  // AutomationControlled is an unsupported flag; a Chrome update could silently drop it
  if (await webdriverFlag(p).catch(() => null) === true) {
    await stop(name);
    throw new Error('navigator.webdriver is true despite --disable-blink-features=AutomationControlled; profile stopped, sites will flag it as a bot');
  }
  console.log(envLines(p));
}

async function show(name) {
  const p = paths(name);
  const info = running(p);
  if (!info) throw new Error(`profile ${name} not running`);
  if (info.display == null) throw new Error(`profile ${name} has no virtual display (${info.headed ? 'already headed' : 'headless'})`);
  const out = execFileSync('x11vnc', ['-display', `:${info.display}`, '-localhost', '-once', '-nopw', '-autoport', '5990', '-quiet', '-bg'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
  const port = out.match(/PORT=(\d+)/)?.[1];
  if (!port) throw new Error('x11vnc did not report a port');
  spawn('vncviewer', [`127.0.0.1::${port}`], { detached: true, stdio: 'ignore' }).unref();
  console.log(`viewer opened on the user's desktop (VNC 127.0.0.1:${port}); it closes the share when the user closes it`);
}

function killXvfb(pid) {
  try { if (pid && readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith('Xvfb')) process.kill(pid, 'SIGTERM'); } catch {}
}

async function stop(name) {
  const p = paths(name);
  const info = running(p);
  if (!info) {
    // browser crashed or was killed: its Xvfb+openbox would otherwise leak
    try { killXvfb(JSON.parse(readFileSync(p.pid, 'utf8')).xvfbPid); } catch {}
    console.log(`profile ${name} not running`);
    return;
  }
  assertOwner(name, info);
  const alive = () => { try { process.kill(info.pid, 0); return true; } catch { return false; } };
  try {
    const [port, path] = readFileSync(p.port, 'utf8').trim().split('\n');
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(rej, 5000); });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch {
    process.kill(info.pid, 'SIGTERM');
  }
  for (let i = 0; i < 150 && alive(); i++) await sleep(100);
  if (alive()) process.kill(info.pid, 'SIGKILL');
  // openbox exits with its display
  killXvfb(info.xvfbPid);
  rmSync(p.port, { force: true });
  console.log(`stopped profile ${name}`);
}

async function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (cmd === 'start') return start(name, rest.includes('--headed'));
  if (cmd === 'stop') return stop(name);
  if (cmd === 'show') return show(name);
  if (cmd === 'env') {
    const p = paths(name);
    const info = running(p);
    if (!info) throw new Error(`profile ${name} not running; profile.mjs start ${name}`);
    assertOwner(name, info);
    console.log(envLines(p));
    return;
  }
  if (cmd === 'status') {
    const p = paths(name);
    const info = running(p);
    console.log(info ? `profile ${name} running pid=${info.pid} ${info.headed ? 'headed' : info.display != null ? `virtual display :${info.display}` : 'headless'} since ${info.started}${info.owner ? ` owner=${info.owner.cwd}` : ''}` : `profile ${name} not running`);
    return;
  }
  if (cmd === 'list') {
    const names = existsSync(ROOT) ? readdirSync(ROOT) : [];
    for (const n of names) console.log(`${n}  ${running(paths(n)) ? 'running' : 'stopped'}`);
    return;
  }
  console.log(USAGE);
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
}

main().catch(e => {
  console.error(`profile.mjs: ${e.message}`);
  // eval "$(profile.mjs env|start X)" must not leave CDP_PORT_FILE unset: cdp would silently drive the user's Vivaldi
  if (['start', 'env'].includes(process.argv[2])) console.log(`export CDP_PORT_FILE='/nonexistent/profile.mjs-failed'; false`);
  process.exit(1);
});
