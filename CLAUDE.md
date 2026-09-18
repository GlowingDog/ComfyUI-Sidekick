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
- **Blocking interactions** (`pending.py`): `ask_user` questions and permission prompts add an item and await a future resolved by `POST /sidekick/answer`.
- **Data dir**: `folder_paths.get_system_user_directory("sidekick")` → `ComfyUI/user/__sidekick/` (`config.json`, `sessions/`, `cli_workspace/`, `tmp/`). The `__` prefix keeps it out of the `/userdata` HTTP API. API keys are never returned unmasked (`config.masked`).
- **Python package layout**: everything is under the inner package `sidekick/` with **relative imports only**, so it imports as `ComfyUI-Sidekick.sidekick` inside ComfyUI and as `sidekick` in unit tests. Only `routes.py` imports ComfyUI's `server`.

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
- All node moves go through `graphCtx.setNodePos` (Vue-nodes mode routes geometry through an internal layout store; behaviour there is still unverified — P3).
- `nodeCreated` fires before `graph.add()`; dynamic widgets appear a tick after add → `addNode` awaits `tick()` before setting widgets. Third-party packs may veto/rewire links → `connectNodes` verifies the link and returns slot diagnostics on failure.
- PrimeIcons classes do not work inside the Shadow root; use text glyphs / inline SVG.

## Tests
- Python (run each file; `tests/py` is not an importable package name): `..\..\..\python_embeded\python.exe tests\py\test_core.py`, `…\test_openai_loop.py`, `…\test_codex.py`
- **Never patch source files with ad-hoc Python/sed scripts** — use the Edit tool (scripted rewrites make the harness re-echo whole files into context).
- JS (pure modules): `node --test tests/js/pure.test.mjs`
- Token-free live checks: enable Dev mode in Sidekick settings, then `POST /sidekick/dev/call_tool {tool, args, client_id}` (loopback only).
