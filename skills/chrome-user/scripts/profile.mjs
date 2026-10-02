#!/usr/bin/env node
// Dedicated persistent browser profiles for agent-owned accounts, separate from the user's Vivaldi.

import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { execFileSync, spawn } from 'child_process';

const ROOT = process.env.CDP_PROFILE_ROOT || resolve(homedir(), '.local/share/pi-browser-profiles');
const BROWSER = process.env.CDP_PROFILE_BROWSER || 'google-chrome';
const USAGE = `profile.mjs start <name> [--headed] | stop <name> | status <name> | env <name> | list

start   launch (or reuse) Chrome on ~/.local/share/pi-browser-profiles/<name>; headless unless --headed
        (--headed shows a window on the user's desktop: only for human verification/CAPTCHA)
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

async function start(name, headed) {
  const p = paths(name);
  const current = running(p);
  if (current) {
    if (current.headed !== headed) throw new Error(`profile ${name} already running ${current.headed ? 'headed' : 'headless'}; stop it first to switch`);
    console.log(envLines(p));
    return;
  }
  for (const dir of [p.dir, p.profile, p.runtime]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(p.port, { force: true });
  const args = [`--user-data-dir=${p.profile}`, '--remote-debugging-port=0', '--remote-allow-origins=*',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--window-size=1280,900'];
  if (!headed) {
    const major = execFileSync(BROWSER, ['--version'], { encoding: 'utf8' }).match(/(\d+)\./)?.[1];
    args.push('--headless=new');
    if (major) args.push(`--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`);
  }
  args.push('about:blank');
  const log = openSync(p.log, 'a');
  const child = spawn(BROWSER, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  writeFileSync(p.pid, JSON.stringify({ pid: child.pid, headed, started: new Date().toISOString() }), { mode: 0o600 });
  for (let i = 0; i < 150 && !existsSync(p.port); i++) await sleep(100);
  if (!existsSync(p.port)) throw new Error(`browser did not expose a debugging port; see ${p.log}`);
  console.log(envLines(p));
}

async function stop(name) {
  const p = paths(name);
  const info = running(p);
  if (!info) { console.log(`profile ${name} not running`); return; }
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
  rmSync(p.port, { force: true });
  console.log(`stopped profile ${name}`);
}

async function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (cmd === 'start') return start(name, rest.includes('--headed'));
  if (cmd === 'stop') return stop(name);
  if (cmd === 'env') {
    const p = paths(name);
    if (!running(p)) throw new Error(`profile ${name} not running; profile.mjs start ${name}`);
    console.log(envLines(p));
    return;
  }
  if (cmd === 'status') {
    const p = paths(name);
    const info = running(p);
    console.log(info ? `profile ${name} running pid=${info.pid} ${info.headed ? 'headed' : 'headless'} since ${info.started}` : `profile ${name} not running`);
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

main().catch(e => { console.error(`profile.mjs: ${e.message}`); process.exit(1); });
