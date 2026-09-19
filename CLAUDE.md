# ComfyUI-Sidekick — project guide for Claude

**Read this and [PLAN.md](PLAN.md) first.** This file is the stable architecture + rules; PLAN.md is the live task list (keep it updated as you work).

## What it is
An AI agent chat panel inside ComfyUI. The brain is the **Claude CLI**, the **Codex CLI** (headless, using the user's own CLI logins) or any **OpenAI-compatible API**. It edits the open workflow **live** through tools — no page refresh, every tool call is one Ctrl+Z step.

## Rules
- **Do not use superpowers skills in this project** (user decision, 2026-09-18). Work from PLAN.md.
- **Zero new pip dependencies.** Backend uses only the stdlib + `aiohttp` (a ComfyUI dependency). No `openai`, `mcp`, `anthropic` SDKs — they are installed here by accident, not by ComfyUI.
- **No-build frontend.** Plain ES modules under `web/`, no bundler, no vendored frameworks. UI is plain DOM inside a Shadow root (`web/ui/panel.js`).
- **Never use** `--dangerously-skip-permissions`, `bypassPermissions` or `--dangerously-bypass-approvals-and-sandbox`. CLIs get a tool allowlist; risky tools go through the in-chat permission card.
- **No shell when spawning CLIs.** argv lists only; prompts go over stdin or files (`agent/cli_common.py`).
- Syntax-check every change: `node --check <file>` and `python -m compileall -q sidekick`. Work in small self-contained portions.
- Python change → restart ComfyUI. JS-only change → hard refresh (Ctrl+Shift+R).
- Git-versioned, private repo `GlowingDog/ComfyUI-Sidekick`. Push when a feature lands on main.
- Every `.js` under `web/` is auto-imported by ComfyUI as an extension → **no top-level side effects** outside `web/index.js`. Tests live outside `web/`.

## Architecture
```
Browser (web/)                                    Python (sidekick/, inside the ComfyUI process)
 ui/panel.js  ── REST (bridge/client.js) ──▶  routes.py ─▶ agent/runner.py ─▶ agent/cli_claude.py …
 tools/*.js on the live graph ◀─ ws "sidekick.rpc" ── bridge.py ◀─ registry.dispatch()
        └─ POST /sidekick/rpc_result ─────────▶                          ▲
 bridge/client.js ◀─ ws "sidekick.event" ── sessions.py                  │
                                               POST /sidekick/mcp (mcp_server.py) ◀── claude / codex CLI
```
- **One tool registry** (`sidekick/registry.py`). LLM-facing schemas live in `sidekick/tooldefs/*.py`; `side="frontend"` tools are implemented under the same name in `web/tools/index.js`, `side="backend"` tools have a Python handler. `risk`: `read` | `edit` (undoable) | `risky` (permission card unless mode is `auto`).
- **`registry.dispatch()` is the single choke point** for every brain: validation, permissions, the tool card in the chat, truncation of results (16k chars).
- **MCP endpoint** (`mcp_server.py` + `POST /sidekick/mcp`): hand-written JSON-RPC (initialize, ping, tools/list, tools/call), JSON responses only, loopback only. A per-turn bearer token binds CLI calls to a chat session + browser tab (`client_id` = ComfyUI websocket `clientId`).
- **Sessions** (`sessions.py`): the server owns chat state as a list of UI *items* (`user`, `assistant`, `tool`, `question`, `permission`, `error`, `notice`). Every mutation is a sequenced `sidekick.event` (`item_add`, `item_update`, `text_delta`, `turn_start`, `turn_end`). Browsers fetch a snapshot, then apply events with a higher `seq`; a gap triggers a re-fetch.
- **Never put a live, mutable object into an event payload.** `PromptServer.send_sync` only queues; serialization happens later in ComfyUI's publish loop, so later mutations leak into earlier events (this doubled the first streamed chunk of every reply until 2026-09-19). `add_item` emits a deep copy; `update_item` patches must be fresh values.
- When checking a chat end to end, compare the **browser store** (`client.state.items`) with the server snapshot — the server copy alone hid that bug for two phases.
- **Blocking interactions** (`pending.py`): `ask_user` questions and permission prompts add an item and await a future resolved by `POST /sidekick/answer`.
- **Data dir**: `folder_paths.get_system_user_directory("sidekick")` → `ComfyUI/user/__sidekick/` (`config.json`, `sessions/`, `cli_workspace/`, `tmp/`). The `__` prefix keeps it out of the `/userdata` HTTP API. API keys are never returned unmasked (`config.masked`).
- **Python package layout**: everything is under the inner package `sidekick/` with **relative imports only**, so it imports as `ComfyUI-Sidekick.sidekick` inside ComfyUI and as `sidekick` in unit tests. Only `routes.py` imports ComfyUI's `server`.

## Backend tools that touch the outside world (P4)
- **Every request the model can cause goes through `backend/netguard.py`** (`fetch` / `open_url`): public http(s) only, checked at connect time by a resolver (DNS rebinding safe), redirects followed by hand and re-checked, credentials pinned to their host via `auth={host_suffix: headers}`. Never call `aiohttp` directly for model-supplied URLs. `backend/loopback.py` is the opposite: only this server (core + Manager routes). The one unguarded outbound call is the user's own SearXNG address.
- Tests reach their local mock servers by patching `netguard.is_public_ip` (there is deliberately no "guard off" switch in production code paths except `guard=False` for the SearXNG call).
- **ComfyUI-Manager** (V3.40, `custom_nodes/comfyui-manager/glob/manager_server.py`): body-less POSTs (`/manager/queue/reset|start`, `/manager/reboot`) reject form content types → always send JSON (`loopback.request` does). `/manager/queue/install` indexes `version`, `channel`, `mode` → send the whole list entry. Verdicts are websocket-only (`cm-queue-status`) → verify through `/customnode/installed`. At `security_level=normal`: installs from the default list OK, git-URL / pip installs refused (404/403), non-safetensors models only from its model list.
- **Downloads** write only under `folder_paths` model folders; pickle-capable formats only from the Manager's vetted list (`downloads.check_ext`). Do not loosen either without asking the user.
- **Restart** is booked by the tool and performed by `runner.run_turn`'s `finally` (turn saved first). `session.continuation` = `{note, provider, model, ts}`; `POST /sidekick/chat/resume` consumes it once.
- Internal browser RPCs start with `_` in `web/tools/index.js` (`_missing_node_types`, `_refresh_node_defs`): callable from Python through `bridge.call`, never offered to the model (the parity test pins the list).

## Verified CLI facts (2026-09-18; claude 2.1.274, codex-cli 0.154.0)
- `claude` npm shim → native `…/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`; `codex` shim → `node …/@openai/codex/bin/codex.js`. `cli_common.resolve()` handles both.
- Claude argv is in `cli_claude.build_argv`. `--setting-sources project` keeps the OAuth login but drops the user's global hooks/plugins (verified: `plugins: []`). `--bare` would break OAuth (skips keychain). `--allowedTools mcp__sidekick` allows every tool of our server. `--tools "WebSearch,WebFetch"` removes file/shell tools.
- Claude probes `server/discover` first; answering JSON-RPC "method not found" makes it fall back to `initialize` (works). It sends `_meta["claudecode/toolUseId"]` with tool calls.
- stream-json shapes: see `tests/fixtures/claude_basic.jsonl`. One `assistant` message per content block, interleaved with `stream_event`s; thinking text is empty (signature only).
- Codex argv is in `cli_codex.build_argv`. Streamable-HTTP MCP via `-c mcp_servers.sidekick.url=…` + `bearer_token_env_var`; `--ignore-user-config` keeps auth. In `exec` mode MCP calls are refused ("approval policy is never", `tests/fixtures/codex_mcp_denied.jsonl`) unless `mcp_servers.sidekick.default_tools_approval_mode="approve"` is set (`tests/fixtures/codex_basic.jsonl`). System prompt goes in `developer_instructions`; web search is `web_search="live"`. Options go **before** `resume <thread_id>`. Codex still loads `~/.agents/skills` (≈58k input tokens/turn); no off-switch found yet.
- Cheap config oracle: `codex exec --strict-config -c <key>=… -m bogus-model` — an unknown key errors instantly, a valid key reaches the model and 400s, no tokens spent.

## Frontend facts (frontend 1.48.6)
- Import only `/scripts/app.js` and `/scripts/api.js`. `graph.links` is a **Map** (`graphCtx.getLink`). Tools must use `graphCtx.graph()` (the graph shown on the canvas — may be a subgraph), never `app.graph` directly.
- One undo step: `changeTracker.beforeChange()` … `afterChange()` (`graphCtx.withUndo`), applied by `web/tools/index.js` to every `edit: true` tool.
- All node moves go through `graphCtx.setNodePos`, which **assigns** `node.pos = [x, y]`: the setter notifies the Vue-nodes layout store (`moveNode`), verified in both render modes. Mutating in place (`node.pos[0] = x`) does not sync — never do it.
- **Layout**: geometry is pure (`dagLayout.js` layered flow, `layoutMath.js` rows/grids — both node-tested); `autoLayout.js` builds the input tree from the live canvas (groups = blocks, by the same centre-inside test as `read.groupMembers`) and applies the result. `autoLayout.js` must not import `edit.js` (`edit.js` imports it for the `edit_graph` op): shared group helpers (`groupRect`, `groupHead`, `setGroupRect`, `addGroupBox`, `GROUP_PAD`) live in `graphCtx.js`.
- **Context menus**: LiteGraph opens submenus from entry callbacks via `new LiteGraph.ContextMenu(...)` (call sites go through the `LiteGraph` global, which is also what ComfyUI's own menu filter patches). `menus.js` swaps that constructor for a recorder while it walks a path and restores it in `finally`. LiteGraph's built-in entries read `LGraphCanvas.active_canvas`, which only real mouse events set → set it to `app.canvas` first. Entry labels contain HTML/entities (`menuMatch.entryLabel`).
- **Running**: `app.queuePrompt(number, batchCount)` resolves to a boolean only. `run.js` wraps `api.queuePrompt` for the duration of the call to catch `{prompt_id, node_errors}` or the rejection (`error.response`). Results come from `/history/<id>` (exists only once the run ended) + `/queue`; `api.getHistory()` returns a different, newer shape — do not use it. Node ids inside subgraphs are reported as `"<subgraph node id>:<inner id>"`.
- **Subgraphs**: `node.isSubgraphNode()`, `node.subgraph` (`name`, `_nodes`), `node.type` is a UUID; `app.canvas.openSubgraph(subgraph, node)` / `app.canvas.setGraph(parent)`; `app.graph` stays the root while `app.canvas.graph` is what is shown (`graphCtx.graph()`), `graphCtx.subgraphTrail()` finds the way from the root.
- **Settings**: `app.extensionManager.setting` = `{settings (definitions by id), get, set}`; `set` persists to the server. For tests that must not persist, flip the value in memory through pinia (`#vue-app.__vue_app__…$pinia._s.get('setting').settingValues[id]`) and flip it back — test-only, tools never touch pinia.
- **Templates**: core index at `/templates/index.json` (categories → `templates[{name,title,description}]`, JSON at `/templates/<name>.json`); node-pack examples from `api.getWorkflowTemplates()` → `/api/workflow_templates/<pack>/<name>.json`. `app.loadGraphData(json, true, true, name)` with a string/null name opens a NEW temporary tab — but a name equal to a saved file binds to that file, hence `workflow.freeName`. `app.loadApiJson` clears and rebuilds inside a new tab too.
- `nodeCreated` fires before `graph.add()`; dynamic widgets appear a tick after add → `addNode` awaits `tick()` before setting widgets. Third-party packs may veto/rewire links → `connectNodes` verifies the link and returns slot diagnostics on failure.
- PrimeIcons classes do not work inside the Shadow root; use text glyphs / inline SVG.
- **Node ids are strings** in this build — compare with `String()`. `LGraphGroup` geometry setters throw unless the group is already in a graph. LiteGraph's `group._children` is **stale right after programmatic moves**: group membership always comes from `read.groupMembers` (node centre inside the box), for reads and edits alike.
- Shadow DOM retargets events, so the panel stops `keydown/keyup/keypress/paste/copy/cut` at its root; otherwise ComfyUI/LiteGraph shortcuts can fire while the user types. `h()` flattens children with `flat(Infinity)` (a one-level flat once rendered cards as `[object HTMLDivElement]`).
- Big graphs: `get_workflow` budgets itself (`full` → `outline` → `index`, 40k chars) under its 48k `Tool.max_chars`; never rely on blind truncation — a truncated outline cost a real session ~40 extra calls.
- `run_command` / `workflow_tabs` are never wrapped in `withUndo` (tab switches mid-call would corrupt the other tab's history). Their per-call risk lives in `tooldefs/ui.py` (`Tool.risk_fn`); permission grants for them are per exact call, not per tool.
- Commands: `app.extensionManager.command.commands` (id, label getter, source) + `.execute(id, {errorHandler})`. Workflows: `app.extensionManager.workflow` (`openWorkflows`, `activeWorkflow`, `persistedWorkflows`, `syncWorkflows`); switching = `await wf.load()` if needed, then `app.loadGraphData(clone(wf.activeState), true, true, wf)`.
- **Vision** (`web/tools/vision.js`): canvas shots re-render the real canvas at our own bitmap size — `c.resize(W,H)` (resets the 2D context to identity), set `ds.scale/offset`, `_lowQualityZoomThreshold = 0`, `show_info = false`, `c.draw(true,true)`, `toDataURL`, then restore size, **`ctx.setTransform(saved)`** (ComfyUI applies its devicePixelRatio scale once after a resize; a plain restore would lose it), ds and redraw — all synchronous so nothing flickers. Tab shots use `getDisplayMedia({preferCurrentTab:true})`, which only works inside a user gesture → `client.requestGesture()` + the panel's share bar. Images never go through `_to_text`: `registry.dispatch_full` returns them separately; `Tool.confirm` gates them with a privacy card that also works in read-only mode.
- To look at a screenshot yourself while testing: run a throwaway local receiver (aiohttp `POST /save/<name>`), `fetch(..., {mode:"no-cors", body: blob})` from the pane, then Read the JPEG. Returning base64 through the JS tool floods the context.
- Live testing needs a running ComfyUI. If the user's (:8188) is down, start your own on **:8189** (`python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --port 8189 --disable-auto-launch`, background, ~2 min to boot) and stop it when done; never restart the user's instance without asking. After a page reload wait for `app.extensionManager.workflow.activeWorkflow` before calling tools (tabs restore late). To run something without loading a model: `EmptyImage → PreviewImage`; a guaranteed runtime error: `SaveImage` with `filename_prefix: "../../x"`.
- Live-test browser tools without restarting the server: in the Browser pane, `const { runTool } = await import('/extensions/ComfyUI-Sidekick/tools/index.js')` (same module instance ComfyUI loaded). Python tool-def changes still need a ComfyUI restart before an LLM can see them.

## Tests
- Python (run each file; `tests/py` is not an importable package name): `..\..\..\python_embeded\python.exe tests\py\test_core.py`, `…\test_openai_loop.py`, `…\test_codex.py`, `…\test_tooldefs.py`, `…\test_routes.py`, `…\test_vision.py`, `…\test_web.py`, `…\test_manager.py` (mock Manager), `…\test_downloads.py` (stubs `folder_paths`)
- Anything with arithmetic or text formatting goes in a **pure module** (no ComfyUI imports) so node can test it: `layoutMath.js`, `dagLayout.js`, `menuMatch.js`, `runReport.js`, `connectMatch.js`, `widgetCoerce.js`.
- **Never patch source files with ad-hoc Python/sed scripts** — use the Edit tool (scripted rewrites make the harness re-echo whole files into context).
- JS (pure modules): `node --test tests/js/pure.test.mjs`
- Token-free live checks: enable Dev mode in Sidekick settings, then `POST /sidekick/dev/call_tool {tool, args, client_id}` (loopback only).
