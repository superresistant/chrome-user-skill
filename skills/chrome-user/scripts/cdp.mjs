#!/usr/bin/env node
// cdp - Chrome DevTools Protocol CLI over raw WebSocket. Node 22+.
// Per-tab daemon holds the CDP session; Chrome's Allow-debugging modal fires
// once per daemon. Daemon self-cleans on tab close and browser exit;
// IDLE_TIMEOUT is the backstop. CDP_IDLE_MS overrides (ms); =0 disables.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = Number(process.env.CDP_TIMEOUT_MS) > 0 ? Number(process.env.CDP_TIMEOUT_MS) : 15000;
const NAVIGATION_TIMEOUT = 30000;
const DEFAULT_IDLE = 30 * 24 * 60 * 60 * 1000; // 30 days
const IDLE_TIMEOUT = (() => {
  const raw = process.env.CDP_IDLE_MS;
  if (raw === undefined) return DEFAULT_IDLE;
  const n = Number(raw);
  if (n === 0) return null; // disabled
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_IDLE;
  return n;
})();
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
process.umask(0o077);
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR
  ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
  : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');

function sockPath(targetId) {
  return resolve(RUNTIME_DIR, `cdp-${targetId}.sock`);
}

function getWsUrl() {
  const browsers = ['google-chrome', 'google-chrome-beta', 'chromium', 'vivaldi', 'vivaldi-snapshot', 'BraveSoftware/Brave-Browser', 'microsoft-edge'];
  const base = resolve(homedir(), '.config');
  const pair = (name) => [resolve(base, name, 'DevToolsActivePort'), resolve(base, name, 'Default/DevToolsActivePort')];
  const candidates = [
    process.env.CDP_PORT_FILE,
    ...browsers.flatMap(pair),
  ].filter(Boolean);
  const portFile = candidates.find(existsSync);
  if (!portFile) throw new Error('No DevToolsActivePort found. Enable remote debugging at chrome://inspect/#remote-debugging');
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  return `ws://${process.env.CDP_HOST || '127.0.0.1'}:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// Command implementations — return strings, take (cdp, sessionId)

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

async function withBrowser(fn) {
  const cdp = new CDP();
  await cdp.connect(getWsUrl());
  try { return await fn(cdp); } finally { cdp.close(); }
}

async function refreshPages(cdp) {
  const pages = await getPages(cdp);
  writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
  return pages;
}

async function resolveTargetId(prefix) {
  if (!prefix) throw new Error('target ID required. Run "cdp list" first.');
  const cached = existsSync(PAGES_CACHE) ? JSON.parse(readFileSync(PAGES_CACHE, 'utf8')) : [];
  try {
    return resolvePrefix(prefix, cached.map(p => p.targetId), 'target', 'Run "cdp list".');
  } catch (e) {
    if (e.message.startsWith('Ambiguous')) throw e;
  }
  const pages = await withBrowser(refreshPages);
  return resolvePrefix(prefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
    childrenByParent.get(n.parentId).push(n);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const role = node.role?.value || '';
    const name = node.name?.value ?? '';
    const value = node.value?.value;
    const hasValue = !(value === '' || value == null);
    const show = !(compact && role === 'InlineTextBox')
      && role !== 'none' && role !== 'generic'
      && !(name === '' && !hasValue);
    if (show) {
      let line = `${'  '.repeat(Math.min(depth, 10))}[${role}]`;
      if (name !== '') line += ` ${name}`;
      if (hasValue) line += ` = ${JSON.stringify(value)}`;
      lines.push(line);
    }
    const seen = new Set();
    const pushChild = c => { if (c && !seen.has(c.nodeId)) { seen.add(c.nodeId); visit(c, depth + 1); } };
    for (const id of node.childIds || []) pushChild(nodesById.get(id));
    for (const c of childrenByParent.get(node.nodeId) || []) pushChild(c);
  }

  for (const n of nodes) if (!n.parentId || !nodesById.has(n.parentId)) visit(n, 0);
  for (const n of nodes) visit(n, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  let result;
  try {
    result = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sid);
  } catch (e) {
    if (e.message.startsWith('Timeout')) {
      throw new Error(`${e.message} — awaitPromise blocks until the promise settles; unsettled promise or unresponsive tab. Store the result on window and poll, or raise CDP_TIMEOUT_MS`);
    }
    throw e;
  }
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath, targetId) {
  let dpr = 1;
  try {
    const parsed = parseFloat(await evalStr(cdp, sid, 'window.devicePixelRatio'));
    if (parsed > 0) dpr = parsed;
  } catch {}

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [
    out,
    `Screenshot saved. Device pixel ratio (DPR): ${dpr}`,
    `Coordinate mapping:`,
    `  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`,
    `  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`,
  ];
  if (dpr !== 1) lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) { loadEvent.cancel(); throw new Error(result.errorText); }
  if (result.loaderId) await loadEvent.promise;
  else loadEvent.cancel();

  // Poll for document.readyState === 'complete' (SPA hydration may continue past load).
  const deadline = Date.now() + 5000;
  let lastState = '', lastError;
  while (Date.now() < deadline) {
    try {
      lastState = await evalStr(cdp, sid, 'document.readyState');
      if (lastState === 'complete') return `Navigated to ${url}`;
    } catch (e) { lastError = e; }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for navigation to finish${lastState ? ` (last readyState: ${lastState})` : lastError ? ` (${lastError.message})` : ''}`);
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Input.insertText works in cross-origin iframes, unlike eval-based typing
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// Per-tab daemon

async function runDaemon(targetId) {
  const sp = sockPath(targetId);

  const cdp = new CDP();
  try {
    await cdp.connect(getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Chain setTimeouts past Node's 2^31-1 ms cap so 30d default works
  // (otherwise Node truncates to 1ms and daemon exits immediately)
  const MAX_TIMEOUT = 0x7FFFFFFF;
  let idleTimer = null;
  function scheduleShutdown(remaining) {
    if (remaining <= MAX_TIMEOUT) {
      idleTimer = setTimeout(shutdown, remaining);
    } else {
      idleTimer = setTimeout(() => scheduleShutdown(remaining - MAX_TIMEOUT), MAX_TIMEOUT);
    }
  }
  function resetIdle() {
    if (IDLE_TIMEOUT === null) return;
    if (idleTimer) clearTimeout(idleTimer);
    scheduleShutdown(IDLE_TIMEOUT);
  }
  if (IDLE_TIMEOUT !== null) scheduleShutdown(IDLE_TIMEOUT);

  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': result = await snapshotStr(cdp, sessionId, true); break;
        case 'eval': result = await evalStr(cdp, sessionId, args[0]); break;
        case 'shot': result = await shotStr(cdp, sessionId, args[0], targetId); break;
        case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
        case 'nav': result = await navStr(cdp, sessionId, args[0]); break;
        case 'net': result = await netStr(cdp, sessionId); break;
        case 'click': result = await clickStr(cdp, sessionId, args[0]); break;
        case 'clickxy': result = await clickXyStr(cdp, sessionId, args[0], args[1]); break;
        case 'type': result = await typeStr(cdp, sessionId, args[0]); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // NDJSON over Unix socket. See USAGE for wire format.
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// CLI ↔ daemon communication

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(targetId) {
  const sp = sockPath(targetId);
  try { return await connectToSocket(sp); } catch {}
  try { unlinkSync(sp); } catch {}

  spawn(process.execPath, [process.argv[1], '_daemon', targetId], { detached: true, stdio: 'ignore' }).unref();

  // Retry loop covers daemon startup + time for user to click Allow
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// Stop daemons

async function stopDaemons(targetPrefix) {
  if (!existsSync(PAGES_CACHE)) return;
  const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  const targets = targetPrefix
    ? [resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target')]
    : pages.map(p => p.targetId);

  for (const targetId of targets) {
    const sp = sockPath(targetId);
    try {
      const conn = await connectToSocket(sp);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      try { unlinkSync(sp); } catch {}
    }
  }
}

// Main

const USAGE = `cdp - Chrome DevTools Protocol CLI (no Puppeteer, Node 22+)

Usage: cdp <command> [args]

  list  [--window <id>]             List open pages with unique targetId prefixes; filter by windowId
  window <target>                   windowId + bounds of the window holding this tab
  close  <target>                   Close tab
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression (top frame, returnByValue)
  shot  <target> [file]             Screenshot (default screenshot-<target>.png in runtime dir); prints DPR mapping
  html  <target> [selector]         Full or selector-scoped outerHTML
  nav   <target> <url>              Navigate, wait for Page.loadEventFired + readyState=complete
  net   <target>                    performance.getEntriesByType('resource') dump
  click   <target> <selector>       Trusted click via Input.dispatchMouseEvent
  clickxy <target> <x> <y>          Trusted click at CSS pixel coords
  type    <target> <text>           Input.insertText at focus (works in cross-origin iframes)
  loadall <target> <selector> [ms]  Repeat-click until selector disappears (default 1500ms, 5min cap)
  evalraw <target> <method> [json]  Raw CDP method passthrough; returns JSON
  open  [url] [--window|-w]         New tab (default about:blank). --window/-w opens a new browser
        [--in <target>]             window so tab activation doesn't steal focus; --in puts the tab in
                                    the same window as <target>. New targets trigger a fresh
                                    "Allow debugging?" prompt on first access.
  stop  [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "cdp list". Use more chars to disambiguate.
The page cache auto-refreshes when a prefix misses, so tabs opened after the last list resolve.
Per-command deadline is 15s; CDP_TIMEOUT_MS=<ms> shortens it for probing dead tabs.

Coordinates. Screenshot pixels = CSS pixels × DPR. CDP Input events take CSS pixels.
CSS px = screenshot px / DPR. shot prints the conversion for the current page.

Eval pitfall. Across multiple eval calls, avoid querySelectorAll(...)[i] when the list
can change (e.g. clicking Ignore buttons on a feed shifts indices). Use stable selectors
or collect everything in one eval.

Daemon IPC. Per-tab Unix socket in the runtime dir. NDJSON wire format:
  Request:  {"id":<n>,"cmd":"<command>","args":[...]}
  Response: {"id":<n>,"ok":true,"result":"<string>"} | {"id":<n>,"ok":false,"error":"<msg>"}
Commands mirror the CLI. Socket disappears on idle (CDP_IDLE_MS) or tab close.
`;

const NEEDS_TARGET = new Set([
  'snap','eval','shot','html','nav','net','click','clickxy','type','loadall','evalraw',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === '_daemon') { await runDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  if (cmd === 'list') {
    const wIdx = args.findIndex(a => a === '--window');
    const windowId = wIdx >= 0 ? Number(args[wIdx + 1]) : null;
    await withBrowser(async (cdp) => {
      let pages = await refreshPages(cdp);
      if (windowId !== null) {
        const kept = [];
        for (const p of pages) {
          try {
            const { windowId: w } = await cdp.send('Browser.getWindowForTarget', { targetId: p.targetId });
            if (w === windowId) kept.push(p);
          } catch {}
        }
        pages = kept;
      }
      console.log(formatPageList(pages));
    });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (cmd === 'close') {
    const targetId = await resolveTargetId(args[0]);
    await withBrowser(async (cdp) => {
      await cdp.send('Target.closeTarget', { targetId });
      await sleep(300);
      await refreshPages(cdp);
    });
    console.log(`Closed ${targetId.slice(0, 8)}`);
    return;
  }

  if (cmd === 'window') {
    const targetId = await resolveTargetId(args[0]);
    const { windowId, bounds } = await withBrowser(cdp => cdp.send('Browser.getWindowForTarget', { targetId }));
    console.log(`windowId=${windowId} ${bounds.width}x${bounds.height}+${bounds.left}+${bounds.top} ${bounds.windowState}`);
    return;
  }

  // --window/-w opens a separate browser window so tab activation doesn't steal focus
  if (cmd === 'open') {
    const newWindow = args.includes('--window') || args.includes('-w');
    const inIdx = args.indexOf('--in');
    const inTarget = inIdx >= 0 ? args[inIdx + 1] : null;
    const url = args.find((a, i) => !a.startsWith('-') && i !== inIdx + 1) || 'about:blank';

    // Target.createTarget has no windowId parameter; window.open from a tab already
    // in that window is the only way to place a tab in a specific window
    if (inTarget) {
      const hostId = await resolveTargetId(inTarget);
      const before = new Set((await withBrowser(refreshPages)).map(p => p.targetId));
      const conn = await getOrStartTabDaemon(hostId);
      const res = await sendCommand(conn, { cmd: 'evalraw', args: ['Runtime.evaluate',
        JSON.stringify({ expression: `window.open(${JSON.stringify(url)}, '_blank')`, userGesture: true })] });
      if (!res.ok) { console.error('Error:', res.error); process.exit(1); }
      await sleep(500);
      const opened = (await withBrowser(refreshPages)).find(p => !before.has(p.targetId));
      console.log(`Opened tab in window of ${hostId.slice(0, 8)}: ${opened ? opened.targetId.slice(0, 8) : '(run cdp list)'}  ${url}`);
      return;
    }

    await withBrowser(async (cdp) => {
      const { targetId } = await cdp.send('Target.createTarget', newWindow ? { url, newWindow: true } : { url });
      // New tab may not appear in getTargets immediately; insert manually
      const pages = await getPages(cdp);
      if (!pages.some(p => p.targetId === targetId)) pages.push({ targetId, title: url, url });
      writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
      console.log(`Opened ${newWindow ? 'new window' : 'new tab'}: ${targetId.slice(0, 8)}  ${url}`);
    });
    console.log('Note: this target will need "Allow debugging?" approval on first access.');
    return;
  }

  if (cmd === 'stop') { await stopDaemons(args[0]); return; }

  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  const targetId = await resolveTargetId(targetPrefix);

  const conn = await getOrStartTabDaemon(targetId);

  const cmdArgs = args.slice(1);

  if (cmd === 'eval' || cmd === 'type') {
    const joined = cmdArgs.join(' ');
    if (!joined) { console.error(`Error: ${cmd === 'eval' ? 'expression' : 'text'} required`); process.exit(1); }
    cmdArgs[0] = joined;
  } else if (cmd === 'evalraw') {
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if (cmd === 'nav' && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
