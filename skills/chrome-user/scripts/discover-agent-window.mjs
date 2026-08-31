#!/usr/bin/env node
// Discover user's agent window. Prints AGENT_WINDOW_ID, AGENT_SEED_TAB,
// AGENT_SEED_BLANK, AGENT_WINDOW_TAB_COUNT as shell-evalable assignments. Exit 1
// if only one window. A unique window containing agent-pool tabs wins; otherwise
// fall back to the window with fewest page tabs. AGENT_SEED_BLANK=0 means the seed
// is a real user page — lease a pool tab instead of navigating it.

import { readFileSync } from 'fs';
import { homedir } from 'os';

const PORT_FILES = [
  process.env.CDP_PORT_FILE,
  `${homedir()}/.config/vivaldi/DevToolsActivePort`,
  `${homedir()}/.config/google-chrome/DevToolsActivePort`,
  `${homedir()}/.config/chromium/DevToolsActivePort`,
  `${homedir()}/.config/BraveSoftware/Brave-Browser/DevToolsActivePort`,
  `${homedir()}/.config/microsoft-edge/DevToolsActivePort`,
].filter(Boolean);

const POOL_RE = /^about:blank#pi-agent-pool/;
const SEED_RE = /^(about:blank($|#pi-agent-pool)|chrome:\/(?:\/vivaldi-webui\/startpage|\/newtab)(?:[/?#]|$)|https?:\/\/(www\.)?example\.com\/?$|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/;

try {
  let port, path = '';
  for (const p of PORT_FILES) {
    try {
      [port, path = ''] = readFileSync(p, 'utf8').split('\n').map(s => s.trim());
      if (port) break;
    } catch {}
  }
  if (!port) throw new Error('DevToolsActivePort not found');

  const ws = new WebSocket(`ws://${process.env.CDP_HOST || '127.0.0.1'}:${port}${path}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error(`WS connect failed: ${e.message || 'unknown'}`));
    setTimeout(() => rej(new Error('WS connect timeout')), 5000);
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const slot = pending.get(m.id);
    if (!slot) return;
    pending.delete(m.id);
    m.error ? slot.rej(m.error) : slot.res(m.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const { targetInfos } = await send('Target.getTargets', { filter: [{ type: 'page' }] });
  const pages = targetInfos.filter((t) => t.type === 'page');

  const groups = new Map();
  for (const t of pages) {
    try {
      const { windowId } = await send('Browser.getWindowForTarget', { targetId: t.targetId });
      if (!groups.has(windowId)) groups.set(windowId, []);
      groups.get(windowId).push(t);
    } catch {}
  }
  ws.close();

  if (groups.size < 2) {
    process.stderr.write(`no agent window detected (only ${groups.size} window with ${pages.length} tabs total)\n`);
    process.exit(1);
  }

  const poolGroups = [...groups.entries()].filter(([, tabs]) => tabs.some(t => POOL_RE.test(t.url || '')));
  if (poolGroups.length > 1) {
    process.stderr.write(`agent pool is split across ${poolGroups.length} windows; recover it before browsing\n`);
    process.exit(1);
  }
  const sorted = [...groups.entries()].sort((a, b) => a[1].length - b[1].length);
  const [agentWid, agentTabs] = poolGroups[0] || sorted[0];
  if (!poolGroups.length) process.stderr.write('no agent-pool tabs found; safe Vivaldi Start Page tabs will be initialized on first lease\n');
  const blank = agentTabs.find((t) => POOL_RE.test(t.url || '')) || agentTabs.find((t) => t.url && SEED_RE.test(t.url));
  const seed = blank || agentTabs[0];
  if (!blank) process.stderr.write(`seed tab is a real page (${seed.url}) — do not navigate it, use: cdp open <url> --in ${seed.targetId.slice(0, 8)}\n`);
  process.stdout.write(`AGENT_WINDOW_ID=${agentWid}\nAGENT_SEED_TAB=${seed.targetId.slice(0, 8)}\nAGENT_SEED_BLANK=${blank ? 1 : 0}\nAGENT_WINDOW_TAB_COUNT=${agentTabs.length}\n`);
} catch (e) {
  process.stderr.write(`discover-agent-window: ${e.message}\n`);
  process.exit(2);
}
