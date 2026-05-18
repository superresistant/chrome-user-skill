#!/usr/bin/env node
// Discover user's agent window. Prints AGENT_WINDOW_ID, AGENT_SEED_TAB,
// AGENT_WINDOW_TAB_COUNT as shell-evalable assignments. Exit 1 if only one
// window. Heuristic: window with fewest page tabs; seed prefers
// about:blank|example.com|localhost|127.0.0.1.

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

const SEED_RE = /^(about:blank$|https?:\/\/(www\.)?example\.com\/?$|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/;

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

  const sorted = [...groups.entries()].sort((a, b) => a[1].length - b[1].length);
  const [agentWid, agentTabs] = sorted[0];
  const mainTabs = sorted.at(-1)[1];

  // require gap so two user windows don't get pinned as agent
  if (mainTabs.length - agentTabs.length < 5 && agentTabs.length > 5) {
    process.stderr.write(`ambiguous: smallest window has ${agentTabs.length} tabs, largest has ${mainTabs.length}. Not pinning.\n`);
    process.exit(1);
  }

  const seed = agentTabs.find((t) => t.url && SEED_RE.test(t.url)) || agentTabs[0];
  process.stdout.write(`AGENT_WINDOW_ID=${agentWid}\nAGENT_SEED_TAB=${seed.targetId.slice(0, 8)}\nAGENT_WINDOW_TAB_COUNT=${agentTabs.length}\n`);
} catch (e) {
  process.stderr.write(`discover-agent-window: ${e.message}\n`);
  process.exit(2);
}
