---
name: chrome-user
description: user's Chrome via DevTools
---

Env: Linux X11 + Vivaldi launched via `~/.local/bin/vivaldi-debug` (port=0, remote-allow-origins=*, modal-bypassed). Focus preservation is proven on X11; Wayland only in a disposable session. Runtime files in `$XDG_RUNTIME_DIR/cdp/` (`pages.json`, daemon sockets, leases, default screenshots)

CDP CLI at `~/.pi/agent/skills/chrome-user/scripts/cdp.mjs`. Set `CDP=<full-path>`, then `node $CDP <cmd>`. Node 22+. No `cdp` on PATH: `cdp <cmd>` below means `node $CDP <cmd>` (bare `cdp` → command not found). Never `alias cdp=...` (no bash -c expansion). Run `cdp` with no args for 19-command help. Per-command deadline 15s, shorten with `CDP_TIMEOUT_MS=<ms>` when probing tabs that may be dead

Agent window. User keeps a dedicated window for agent ops so tab activations don't steal focus from their working window. Discover at session start:
```
eval "$(node ~/.pi/agent/skills/chrome-user/scripts/discover-agent-window.mjs)"
# exports AGENT_WINDOW_ID, AGENT_SEED_TAB, AGENT_SEED_BLANK, AGENT_WINDOW_TAB_COUNT
```
Discovery prefers the unique window containing pool markers or leased tabs, otherwise the window with fewest tabs; when every pool tab is leased the seed is a leased tab, only used to locate the window. Never navigate `$AGENT_SEED_TAB` directly, even when `AGENT_SEED_BLANK=1`; always lease a pool tab

Lease an inactive tab in the agent window: `NEW=$(cdp open <url> --in $AGENT_SEED_TAB)` — stdout is the targetId, emitted immediately after acquisition, before navigation; details go to stderr. A navigation failure exits nonzero but keeps the ID and lease; stderr includes full targetId/windowId. Capture stdout even on failure (Node execFile: error.stdout); probe DOM with `eval`, retry `nav`, or release with `close`. An ID confirms acquisition, not page readiness. Each `open` converts empty Vivaldi Start Page/about:blank tabs in that window into pool markers (pool up to 10), then leases one. Vivaldi 8.1 raises its window for any new tab (CDP `active:false`/`background:true` and `chrome.tabs.create`), so when nothing is free or reclaimable and the pool is under 10, `open --in` creates one marker via Vivaldi `chrome.tabs.create` only after the user is idle 3s (GNOME idle monitor; `CDP_POOL_CREATE_IDLE_MS`), then re-activates the previously active X window (stderr `created pool tab`). Pool tabs are lost when the user closes agent-window tabs or Vivaldi restarts (markers not restored). Never ask the user to type `about:blank#pi-agent-pool`; never create a tab or window directly; always use `--in`. Pool exhausted (user decision Sept30): `open` reclaims a lease whose owner process ended (pid dead or reused, e.g. after handoff), whose release failed, or idle >20m (no cdp command on it); otherwise waits `--wait <seconds>` (default 100; set command timeout above it), then errors listing owners. The reclaimed owner's next command on that tab fails with "reclaimed"; re-open. Keep a lease only while actively using it. Never take unleased real pages. List agent-window tabs: `cdp list --window $AGENT_WINDOW_ID`, or `cdp list --windows` for a `win=` column. Window of a tab: `cdp window <target>`

Task cleanup: `cdp close $NEW`; leased targets reset to `about:blank#pi-agent-pool` instead of closing. A hung page is navigated away before its emulation reset; a reset that still fails keeps the lease marked released (any agent may retry `cdp close`). Leases record url, cwd, `PI_SESSION_FILE`, `PI_CODING_AGENT_PID`, created; `cdp leases` shows owner, age, pid alive/dead, stale (tab gone), released, free count and unleased real pages in the pool window. `open` drops leases whose tab vanished. A successor session (handoff) must re-open rather than reuse a predecessor's tab. Acquire/release/`pool-reset` clear device-metrics and page-scale overrides in the tab daemon; release and `pool-reset` also restart the tab's CDP session, dropping `evalraw` session state (`Page.addScriptToEvaluateOnNewDocument`, `wake`, bindings, `Fetch` interception) so the next lessee starts clean; ordinary `nav` preserves intentional emulation. `cdp pool-reset` resets every lease, including another active task: use it only when no browser task is running. Close only non-pool tabs created by the task. Never close `$AGENT_SEED_TAB`, the last tab, or the dedicated agent window. If discovery succeeds, reuse that window; never bootstrap another

Background tabs. Never raise a window to make a tab work; do not call `Target.activateTarget`, `Page.bringToFront`, `window.focus/open/close`, or OS focus tools. The helper blocks direct CDP tab/window control; raw WebSocket access to `DevToolsActivePort` bypasses that policy and is forbidden for agent workflows. `CDP_ALLOW_FOCUS=1` is only for foreground explicitly requested by the user. `cdp wake <target>` = focus emulation + active lifecycle + a 64px throwaway screencast; `cdp wake <target> --off` reverts. Focus emulation can give `document.hasFocus()`, `:focus` and unthrottled timers, but guarantees neither native keyboard delivery nor frames: an occluded or background window stops compositing, so `requestAnimationFrame` stays near 1Hz even when the tab reports `visible` (TurboWarp renders its stage at 1fps). Rendering-tied events also wait: SYCLEF Oct1 saw `dialog.close()` fire no `close` event in an occluded leased tab until `cdp wake`, while timers and sync handlers ran; wake before proving flows that react to dialog `close`. The screencast forces frame production while the daemon holds the session — measured ~1 rAF/s before, ~590/s after. Screenshots of an uncomposited tab go stale: `cdp shot <target> [file] --fresh` requests `captureBeyondViewport` with a current-viewport clip, including scroll offsets and browser page zoom, not an extra DPR multiplier. It is not a rendering synchronization guarantee; verify DOM state separately. Vivaldi paints device-metrics emulation into the real window surface: output taller than the window's physical height repeats the page top (390x844 dpr2 → 1688px in a 1039px window), so `shot` then downscales the capture to fit and prints the effective pixel ratio; use the printed ratio, not DPR, for coordinates. A discarded tab (renderer gone) answers nothing: every command times out and screenshots return `Internal error` — probe with `CDP_TIMEOUT_MS=2000` and `cdp nav` it back to life

TargetIds and windowIds change every restart. Re-run discovery, never persist. If discovery reports fewer than two windows, stop and ask the user to create the dedicated agent window while Vivaldi is already focused; autonomous bootstrap raises Vivaldi. Direct tab/window creation requires explicit `CDP_ALLOW_FOCUS=1`, and an extra window also requires `CDP_ALLOW_NEW_WINDOW=1`. Prefix misses auto-refresh the page cache, so tabs created outside `cdp open` still resolve

Daemon lifetime. Per-tab daemon attached while IPC is active; a daemon left over from an older `cdp.mjs` retires and restarts itself on the next command. Idle shutdown via `IDLE_TIMEOUT` (default 30 days); override with `CDP_IDLE_MS=<ms>`, disable with `CDP_IDLE_MS=0`. Self-cleans on tab close and browser exit; idle timer is backstop. Dead daemon → next call re-attaches WS, fine with launch-flag bypass, otherwise re-fires consent modal

Dedicated profile (agent-owned accounts that must not share the user's Vivaldi cookies, e.g. a second account on the same site): `P=~/.pi/agent/skills/chrome-user/scripts; eval "$(node $P/profile.mjs start <name>)"` launches/reuses Chrome headed on its own Xvfb display + openbox (Vulkan WebGL on the real GPU; headless fallback only without Xvfb; DataDome blocked headless 3/3, passed Xvfb 3/3, agent-browser Oct2; BackForwardCache/spare renderer off halves RAM) on persistent `~/.local/share/pi-browser-profiles/<name>` and exports `CDP_PORT_FILE`/`CDP_RUNTIME_DIR`; then plain `cdp.mjs list/nav/eval/type/click` on its tabs (no pool, no Vivaldi focus limits). Every shell running cdp needs those exports (or `eval "$(node $P/profile.mjs env <name>)"`); without them cdp targets the user's Vivaldi. Profiles launch with `--disable-blink-features=AutomationControlled` (Chrome 154 otherwise sets `navigator.webdriver=true` under remote debugging → Turnstile 600010, Cloudflare interstitials); `eval` never sends `Runtime.enable` (CDP detection probe); agent-browser bench Oct2. Challenge widgets (Turnstile checkbox) in a Vivaldi pool tab: `cdp wake <target>` before `clickxy`, else no token (2/2 fails; wake after the click too late). Login forms behind Cloudflare/Turnstile (Claude, Indeed): DOM `.click()`/value setters leave submit spinning; use trusted `clickxy` + `type` (in Vivaldi `type` stays under the keyboard guard below). `profile.mjs stop <name>` when done (graceful close flushes cookies; kill loses recent ones). CAPTCHA/human verification: `stop`, then `start <name> --headed` (visible window on user's desktop; ask the user), then `stop` + `start <name>` back to background. One profile per account; `profile.mjs list`

Default mode: DOM + JS-API. Prefer `cdp eval`, `cdp evalraw`, `cdp snap`, `fetch` from Runtime executionContext, `sessionStorage`/`document.cookie`/SPA state. Use `cdp shot` only when state lives in canvas, sealed shadow DOM, or unreachable from JS. `cdp click` invokes DOM `element.click()` (`isTrusted=false`, no mouse press/release); it is not a trusted-input fallback. `cdp clickxy` dispatches trusted CDP mouse events

Click decision. Plain DOM click → `cdp click '<selector>'` or eval `.click()`. No effect → choose a visible match, scroll it into view, get its live `getBoundingClientRect()` center, then `cdp clickxy <x> <y>` (nominal CDP viewport CSS coordinates; emulation caveat below). `Clicked` means dispatch succeeded, not that the menu opened; verify resulting DOM state. Before trusted input, inspect links/actions: `target=_blank`, popups and OAuth windows bypass the pool and may raise Vivaldi; navigate the leased target instead unless foreground was explicitly requested

Input coordinates under emulation. `clickxy` and `evalraw Input.*` pass coordinates through without correction. Chrome153 with stored browser zoom1.25 + mobile emulation delivered DOM pointer coordinates at input×1.25 even though `Page.getLayoutMetrics.cssVisualViewport.zoom` and `visualViewport.scale` both reported1. DPR changes did not fix it. Vivaldi8.2/Chromium152 additionally shifted touch coordinates by browser UI embedding offset; mouse had no offset. Isolated Xvfb reproduced touch input×1.25−(41.6,84); SYCLEF reported −(312,35). These offsets are not constants; neither layout metrics nor screenshot DPR proves raw input equals DOM client coordinates

Calibration when needed. Use a known-safe diagnostic surface, separately for mouse and touch. Record trusted `pointerdown.clientX/clientY` for two known input points; suppress default actions and known application handlers during probes, then remove temporary listeners. For inputs100 and200 with observed coordinates a,b, per-axis slope s=(b−a)/100; corrected input=(desired−a)/s+100. Reject missing/extra events or nonpositive slopes; validate a third point and resulting DOM target/action. Recalibrate after viewport, zoom, scroll or browser UI geometry changes; never reuse another tab's transform. Probe interception is not automatically harmless on arbitrary apps

Command-specific tips. `cdp snap` over `cdp html` (cheaper, filtered text); `cdp html` selector-scope when possible. `cdp type` uses native `Input.insertText`, subject to browser focus routing and Vivaldi guard (see Keyboard events); `cdp click` does not supply trusted focus. `cdp net` returns resource timings; for live HTTP bodies use `Network.enable` + `Network.responseReceived` via `evalraw`. `cdp shot` prints screenshot-to-CSS DPR conversion; this does not correct emulated input transforms. `cdp loadall <selector>` repeat-clicks until selector disappears (use for Show-more / load-more pagination)

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

Hidden duplicates (e.g. Drive Share): `querySelector` takes the first match, even hidden. Before selecting by text/label, filter candidates for rect `width>0 && height>0` and computed `visibility==="visible"`. Scroll the chosen element with `behavior:"instant"`, recompute its rect, then use `x+width/2`, `y+height/2` as desired DOM coordinates for `clickxy`, applying measured input calibration when needed. Do not reuse coordinates after layout changes

Form payloads. Visible value/validity does not prove derived fields are populated. Before submission or payment authorization, inspect relevant `FormData` entries and derived previews. Financing reported GitHub `/account/organizations/new` duplicated `organization_profile_name` on LABEL and INPUT; use `input.js-new-organization-name`, not `getElementById`. Native input setter + `input`/`change` left hidden `organization[login]` empty despite valid display name; site-specific `keyup` (key `m`) + blur triggered canonical-name validation and URL preview. Verify both display-name/login payload fields afterward. Observed site behavior, not a universal event recipe; synthetic keyup is not proof of native keyboard delivery

Eval pitfalls. `cdp eval` sets `awaitPromise`, so an async expression blocks the 15s deadline instead of returning; for long work store the result on `window` and poll. Errors surface as `Error: Uncaught` with no detail when JS throws or return is non-serializable. Return primitives or plain objects, never DOM nodes. Complex eval fails → split to localize. Top-frame context only; same-origin iframe via `iframe.contentDocument` traversal, cross-origin via recipe below

Console history not retroactive. `console.error` calls before eval ran are unreadable. Either subscribe via `cdp evalraw $T Runtime.consoleAPICalled` (persistent WS), or monkey-patch on first call:
```
if(!window.__errs){window.__errs=0;const o=console.error;console.error=function(){window.__errs++;return o.apply(this,arguments)}}
```

Keyboard routing. Successful `Input.dispatchKeyEvent`/`Input.insertText` reply, `wake`, `document.hasFocus()` and focused DOM element do not prove delivery to that target. Isolated Vivaldi8.2 sent background-target Tab/ShiftTab/Escape and inserted text to another active tab, with zero target keydown events even after wake. Stock Chrome153 delivered keys to the intended background target; do not generalize between browsers. `type` and `evalraw Input.dispatchKeyEvent/Input.insertText` are blocked by default when Vivaldi UI is detected. Existing `CDP_ALLOW_FOCUS=1` override requires explicitly authorized input and intended target verified active; flag does not activate it. Never enable override merely to retry background input

Keyboard verification. Observe intended target's capture listener and resulting focus/action; `isTrusted=true` applies to delivered native events, not protocol acknowledgements. For Vivaldi background-only tasks use DOM APIs/native value setter + `input`/`change`; those are not keyboard verification. Use isolated browser for native-keyboard tests. `dispatchEvent(new KeyboardEvent(...))` is untrusted and does not reproduce native navigation. Where native delivery is supported: `{"type":"keyDown","key":"A","code":"KeyA","windowsVirtualKeyCode":65,"modifiers":N}`, then matching `keyUp`. Modifiers sum: Alt=1, Ctrl=2, Meta=4, Shift=8. Common vk: Tab=9, Backspace=8, Enter=13, Escape=27

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
ROOT=$(node "$CDP" evalraw "$T" DOM.getDocument '{}' | jq -r '.root.nodeId')
INPUT=$(node "$CDP" evalraw "$T" DOM.querySelector "{\"nodeId\":$ROOT,\"selector\":\"input[type=file]\"}" | jq -r '.nodeId')
node "$CDP" evalraw "$T" DOM.setFileInputFiles "{\"nodeId\":$INPUT,\"files\":[\"/abs/path\"]}"
```

Input created only on click → Node WS script: `Target.attachToTarget {flatten:true}`, `Page.enable` + `DOM.enable` on sessionId, `Page.setInterceptFileChooserDialog {enabled:true}`, click trigger via `Runtime.evaluate {userGesture:true}`, read `backendNodeId` from `Page.fileChooserOpened`, then `DOM.setFileInputFiles {backendNodeId, files:[path]}`. WS URL from `~/.config/vivaldi/DevToolsActivePort`

Gmail API (no browser) → gmail-api skill. Google Docs → chrome-user-google-doc skill
