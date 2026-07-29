---
name: chrome-user
description: user's Chrome via DevTools
---

Env: Linux + Vivaldi launched via `~/.local/bin/vivaldi-debug` (port=0, remote-allow-origins=*, modal-bypassed). Runtime files in `$XDG_RUNTIME_DIR/cdp/` (`pages.json`, daemon sockets, default screenshots)

CDP CLI at `~/.pi/agent/skills/chrome-user/scripts/cdp.mjs`. Set `CDP=<full-path>`, then `node $CDP <cmd>`. Node 22+. Never `alias cdp=...` (no bash -c expansion). Run `cdp` with no args for 17-command help. Per-command deadline 15s, shorten with `CDP_TIMEOUT_MS=<ms>` when probing tabs that may be dead

Agent window. User keeps a dedicated window for agent ops so tab activations don't steal focus from their working window. Discover at session start:
```
eval "$(node ~/.pi/agent/skills/chrome-user/scripts/discover-agent-window.mjs)"
# exports AGENT_WINDOW_ID, AGENT_SEED_TAB, AGENT_SEED_BLANK, AGENT_WINDOW_TAB_COUNT
```
Heuristic: window with fewest tabs (gap-checked). `AGENT_SEED_BLANK=1` means seed matches `about:blank`/`example.com`/`localhost:*` and `cdp nav $AGENT_SEED_TAB <url>` is safe; `=0` means the seed is a real user page — never nav it, open your own tab

Add tab to agent window: `NEW=$(cdp open <url> --in $AGENT_SEED_TAB)` — stdout is the bare targetId, details go to stderr. `Target.createTarget` has NO `windowId` param (silently ignored, tab lands in the user's main window); `--in` works because it calls `window.open(url,"_blank")` with `userGesture:true` from a tab already in that window, then re-activates the opener so the one unavoidable activation stays inside the agent window. Never `cdp open <url>` without `--window` or `--in`. List agent-window tabs: `cdp list --window $AGENT_WINDOW_ID`, or `cdp list --windows` for a `win=` column. Window of a tab: `cdp window <target>`. Clean up: `cdp close <target>`

Background tabs. Never raise a window to make a tab work. `cdp wake <target>` = focus emulation + active lifecycle + a 64px throwaway screencast; `cdp wake <target> --off` reverts. Focus emulation alone gives `document.hasFocus()`, `:focus`, key events and unthrottled timers, but NOT frames: an occluded or background window stops compositing, so `requestAnimationFrame` stays near 1Hz even when the tab reports `visible` (TurboWarp renders its stage at 1fps). The screencast forces frame production while the daemon holds the session — measured ~1 rAF/s before, ~590/s after. Screenshots of an uncomposited tab go stale: `cdp shot <target> [file] --fresh` repaints via `captureBeyondViewport` with a device-pixel clip, same geometry and DPR mapping as a plain shot (without the clip Chrome crops to the CSS-sized top-left corner). A discarded tab (renderer gone) answers nothing: every command times out and screenshots return `Internal error` — probe with `CDP_TIMEOUT_MS=2000` and `cdp nav` it back to life

TargetIds and windowIds change every restart. Re-run discovery, never persist. Discovery exits 1 when only one window exists — bootstrap with `cdp open about:blank --window`, then re-run. Prefix misses auto-refresh the page cache, so tabs created outside `cdp open` still resolve

Daemon lifetime. Per-tab daemon attached while IPC is active; a daemon left over from an older `cdp.mjs` retires and restarts itself on the next command. Idle shutdown via `IDLE_TIMEOUT` (default 30 days); override with `CDP_IDLE_MS=<ms>`, disable with `CDP_IDLE_MS=0`. Self-cleans on tab close and browser exit; idle timer is backstop. Dead daemon → next call re-attaches WS, fine with launch-flag bypass, otherwise re-fires consent modal

Default mode: DOM + JS-API. Prefer `cdp eval`, `cdp evalraw`, `cdp snap`, `fetch` from Runtime executionContext, `sessionStorage`/`document.cookie`/SPA state. Use `cdp shot` only when state lives in canvas, sealed shadow DOM, or unreachable from JS. Use `cdp click`/`clickxy` only when page rejects untrusted clicks (SCA/2FA, drag-drop, paywalls, some OAuth screens, react-joyride Next, some Radix dialogs) — `element.click()` from `eval` is `isTrusted=false` and rejected

Click decision. Read DOM / fetch JSON → `cdp eval`. Click button on plain web app → `cdp eval` + `.click()`. Click by text → `cdp eval` + `array.find` + `.click()` (see PLAYWRIGHT-SELECTOR PITFALL). Untrusted-click rejected → `cdp click '<selector>'`. Coordinate-only (canvas, map pin, drag preview) → `cdp clickxy <x> <y>`

Command-specific tips. `cdp snap` over `cdp html` (cheaper, filtered text); `cdp html` selector-scope when possible. `cdp type` works in cross-origin iframes; focus first via `cdp click` (trusted-focus sites) or `cdp eval '...focus()'` (cheaper). `cdp net` returns resource timings; for live HTTP bodies use `Network.enable` + `Network.responseReceived` via `evalraw`. `cdp shot` prints DPR conversion (CSS px = screenshot px / DPR; CDP Input events take CSS px). `cdp loadall <selector>` repeat-clicks until selector disappears (use for Show-more / load-more pagination)

Page overview. Return object directly, NOT `JSON.stringify`'d — `cdp eval` already serializes via `returnByValue`; wrapping gives string-of-JSON needing double-parse. Useful keys: title, url, viewport, scroll, counts of a/button/input, h1-h3 text, forms, iframes. ARIA names/roles/hidden via `cdp snap` or `cdp evalraw $T Accessibility.getFullAXTree '{}'`. None reaches cross-origin iframes

Wait-for-state. Single eval post-action returns stale state. Loop in shell with DOM probe, not fixed sleep:
```
for i in 1 2 3 4 5; do
  STATE=$(node $CDP eval $T '({ready:!!document.querySelector("[data-loaded]")})')
  echo "$STATE" | grep -q '"ready":true' && break
  sleep 0.5
done
```

NAV-EVAL RACE. `cdp nav` returns at `Page.loadEventFired`, BEFORE SPA hydration. Next eval may hit half-mounted React/Vue/Svelte. Add 1-2s sleep after nav, or DOM-probe loop until expected anchor mounts

PLAYWRIGHT-SELECTOR PITFALL. `cdp eval`/`cdp click` use plain DOM `querySelector`. Playwright shortcuts fail:
`:has-text("X")` → `[...qsa].find(b => b.innerText.trim() === "X")`
`>>` chain → compound selectors or space
`role=button[name="..."]` → `[role="button"]` + filter on `aria-label`/`innerText`
`data-testid=x` → `[data-testid="x"]` (brackets-and-quotes form works)

Trusted click on text-matched element: mark via eval, click by attribute
```
[...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Save")?.setAttribute("data-cdp-target","")
node $CDP click $T '[data-cdp-target]'
```

Eval pitfalls. `cdp eval` sets `awaitPromise`, so an async expression blocks the 15s deadline instead of returning; for long work store the result on `window` and poll. Errors surface as `Error: Uncaught` with no detail when JS throws or return is non-serializable. Return primitives or plain objects, never DOM nodes. Complex eval fails → split to localize. Top-frame context only; same-origin iframe via `iframe.contentDocument` traversal, cross-origin via recipe below

Console history not retroactive. `console.error` calls before eval ran are unreadable. Either subscribe via `cdp evalraw $T Runtime.consoleAPICalled` (persistent WS), or monkey-patch on first call:
```
if(!window.__errs){window.__errs=0;const o=console.error;console.error=function(){window.__errs++;return o.apply(this,arguments)}}
```

Keyboard events. `cdp evalraw $T Input.dispatchKeyEvent` is `isTrusted=true`. `dispatchEvent(new KeyboardEvent(...))` is untrusted, rejected by modern apps. Event: `{"type":"keyDown","key":"A","code":"KeyA","windowsVirtualKeyCode":65,"modifiers":N}`. Always send matching `keyUp`. Modifiers sum: Alt=1, Ctrl=2, Meta=4, Shift=8. Common vk: Backspace=8, Enter=13, Escape=27

Cross-origin iframes. `cdp eval`/`cdp snap`/`cdp html` stop at cross-origin iframe boundary. Reach inside via direct CDP (not CLI):

`Target.setAutoAttach {autoAttach:true, flatten:true}` exposes OOPIFs (different eTLD+1, separate process). Same-site cross-origin (e.g. `a.bank.fr` inside `bank.fr`) shares renderer and never appears in `Target.getTargets`. `Target.getTargets` hides `tab` targets in newer Chromium — pass `{filter:[{}]}`

Recipe (Node WS):
1. WS connect via `DevToolsActivePort`
2. `Target.getTargets {filter:[{}]}`, find page target
3. `Target.attachToTarget {targetId, flatten:true}` → sessionId
4. `Page.enable` + `Runtime.enable` on sessionId
5. Listen for `Runtime.executionContextCreated`; wait ~1.5s
6. Match by `context.origin` (bare `https://host`, NO path — path silently fails). Not `context.name`, not `context.auxData.url`
7. `Runtime.evaluate {expression, contextId, awaitPromise:true, returnByValue:true}` on sessionId

Multiple iframes share origin: `Page.getFrameTree` on session, match URL → `frameId`, cross-ref with `context.auxData.frameId`

Private Network Access: an https page fetching `http://127.0.0.1` hangs until timeout instead of rejecting — a local bridge looks like a dead server. Probe from an http/localhost page or curl it from the shell

`fetch('/api/...', {credentials:'include'})` inside iframe inherits iframe cookies/origin. Page SPA HTTP interceptor does NOT run — no anti-CSRF, no correlation IDs, no retry-on-401. Mutating endpoints often 400/403. Read token from `document.cookie` (e.g. `XSRF-TOKEN`), `sessionStorage`, or SPA state, add header manually. GET usually works without

Recipe stalls when: `executionContextCreated` fires before subscription (subscribe before `Page.enable`, or `Page.reload` after); iframe is same-site cross-origin not OOPIF; `context.origin` includes path

File chooser. Native OS dialogs not clickable. `Page.handleFileChooser` no longer exists in CDP. Input already in DOM (even hidden) → set files directly, no dialog, no race:
```
cdp evalraw $T DOM.getDocument '{}'                                          # root nodeId, always 1
cdp evalraw $T DOM.querySelector '{"nodeId":1,"selector":"input[type=file]"}'  # → nodeId
cdp evalraw $T DOM.setFileInputFiles '{"nodeId":<id>,"files":["/abs/path"]}'
```

Input created only on click → Node WS script: `Target.attachToTarget {flatten:true}`, `Page.enable` + `DOM.enable` on sessionId, `Page.setInterceptFileChooserDialog {enabled:true}`, click trigger via `Runtime.evaluate {userGesture:true}`, read `backendNodeId` from `Page.fileChooserOpened`, then `DOM.setFileInputFiles {backendNodeId, files:[path]}`. WS URL from `~/.config/vivaldi/DevToolsActivePort`

Gmail API (no browser) → gmail-api skill. Google Docs → chrome-user-google-doc skill
