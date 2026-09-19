# ComfyUI-Sidekick — live task list

Full approved plan: `C:\Users\PC\.claude\plans\i-would-like-to-compressed-finch.md`. Architecture + rules: [CLAUDE.md](CLAUDE.md).

## P1 — Skeleton + live edits + Claude CLI
- [x] Repo scaffold, CLAUDE.md / PLAN.md, inner `sidekick/` package
- [x] config (masked secrets), sessions (items + sequenced events), bridge (browser RPC), pending (questions/permissions)
- [x] Tool registry + dispatch (validation, permission modes, tool cards, truncation)
- [x] Node catalog over `/object_info` (search, describe with COMBO truncation, combo option search)
- [x] Tool defs: get_workflow, get_node, search_node_types, get_node_type, get_combo_options, add_node, connect_nodes, disconnect, set_widget_values, update_node, remove_nodes, create/update/remove_group, edit_graph, ask_user
- [x] MCP endpoint (hand-written JSON-RPC over HTTP, per-turn bearer token)
- [x] Spike: `claude -p` ↔ HTTP MCP, `--setting-sources project` keeps OAuth and drops user hooks; fixtures recorded
- [x] Claude CLI provider (argv builder, stream-json mapper, resume, retry without resume)
- [x] Frontend: graphCtx, read/edit tools, connect auto-match, widget coercion, RPC executor, chat panel (Shadow DOM), sidebar tab, settings + chat list overlays
- [x] Unit tests: `tests/py/test_core.py` (12), `tests/js/pure.test.mjs` (5)
- [x] Live verification (2026-09-18, second instance on :8189): routes load, sidebar panel mounts, dev `call_tool` built a 7-node txt2img graph via one `edit_graph`, groups, combo/clamp coercion, connect diagnostics, one undo step per call, MCP 401 without token, real Claude CLI turn (haiku) changed cfg/sampler and added a linked PreviewImage
- [ ] Known rough edge: `create_group` around nodes that sit inside another group's area overlaps it — needs auto_layout (P3)
- [ ] Note: node ids are **strings** in frontend 1.48.6 — always compare with `String()`; geometry setters on `LGraphGroup` throw unless the group is already in a graph
- [x] Fix (2026-09-18, user report "nowhere to paste a key"): `h()` flattened children one level only, so arrays passed through `openOverlay(...kids)` rendered as `[object HTMLDivElement]` text — provider cards and the chat list were unusable. Now `flat(Infinity)`. Verified live on :8188: cards show Base URL / API key / Fetch models / remove; dummy key on a junk entry saved → field cleared, hint shown, focus kept, raw key never returned; then cleared again.
- [x] Panel keeps `keydown/keyup/keypress/paste/copy/cut` inside the Shadow root (retargeting makes them look like they come from a `<div>`, so ComfyUI/LiteGraph shortcuts could fire while typing or pasting a key). Verified: nothing reaches `document`, node count unchanged.
- [ ] Pane tests (`web/dev/pane_tests.js`, `window.SidekickTests`) — must cover the settings + chats overlays (that bug shipped because only `node --check` had seen them)

## P2 — Other brains
- [x] OpenAI-compatible loop (`agent/loop_openai.py`: aiohttp SSE, tool-call delta accumulation, `reasoning_content`/`reasoning`, `stream_options` fallback on 400, history trimming, 40-step cap), `GET /sidekick/providers/models`, provider settings UI (base URL, write-only key, model datalist, add/remove)
  - Verified only against a local mock SSE server (`tests/py/test_openai_loop.py`). **Not yet run against a real provider** (no API key on hand) — first real DeepSeek/OpenRouter/NanoGPT turn still owed.
- [x] Codex provider (`agent/cli_codex.py`). Spike-verified flags (codex-cli 0.155.0): HTTP MCP via `-c mcp_servers.sidekick.url` + `bearer_token_env_var`; **`default_tools_approval_mode="approve"` fixes "approval policy is never"**; `developer_instructions`, `web_search="live"`, `tools.web_search` are valid keys; `exec <opts> resume <thread_id> -` works; `--ignore-user-config` keeps the login.
  - Mapper + argv unit-tested from fixtures (`tests/py/test_codex.py`). **Live turn through the real stack (ComfyUI + browser bridge) not yet run** — do this first next session.
  - Trick: `--strict-config` + `-m bogus-model` validates a config key without spending tokens (wrong key → instant error, right key → model 400).
- [ ] Codex loads `~/.agents/skills` (~58k input tokens/turn, mostly cached). No working off-switch found: `--disable skills`, `skills.enabled`, `skills.include_host` are unknown; `skip_host_skill_discovery` is under-development and had no effect.

## Driven by real use (2026-09-18) — done ahead of plan order
The user's first two real sessions (API brain, 123-node workflow; session files in `user/__sidekick/sessions/`) **proved the OpenAI-compatible loop against a real provider** (streaming, 46 tool calls in one turn, ask_user card) and exposed three problems:
- [x] `get_workflow` hit the 16k cap → the model made ~40 single `get_node` calls. Now: budgeted detail (`full` → `outline` → `index`, 40k budget, 48k cap via `Tool.max_chars`), filters `group` / `query` / `node_ids`, `get_node node_ids` (≤25, bad ids tolerated), new `trace_connections`. Verified live: 260 nodes → outline 20.6k chars, index 3.9k; group filter 13 nodes 4k with widgets.
- [x] "open a new workflow tab" was refused. Now: `list_commands` / `run_command` (121 commands; per-call risk via `Tool.risk_fn` + regex allowlist in `tooldefs/ui.py`; "allow for this chat" is per command id, never the whole tool) and `workflow_tabs` (list/new/switch/list_saved/open/save/close). Tab switch replicates `workflowService.openWorkflow` (`load()` + `app.loadGraphData(state, true, true, wf)`); verified state survives a round trip. These two are **not** wrapped in `withUndo` (a tab switch mid-call would write the new tab's graph into the old tab's history).
- [x] Nodes overflowed a group; model did coordinate math by hand. Now: `add_node group_id` (first free spot, group grows), `arrange_nodes` (row/column/grid from real sizes, `fit_group_id`, reports collisions, skips pinned), `update_group fit_to_contents`. Pure math in `web/tools/layoutMath.js` (node-tested).
- [x] Bug found while testing: `remove_group remove_nodes` deleted the box but left the nodes (LiteGraph's `group._children` is stale right after programmatic moves). Now uses the same geometry test as `get_workflow` (`read.groupMembers`). Verified incl. undo/redo.
- [x] `tests/py/test_tooldefs.py`: Python frontend tool names == `web/tools/index.js` table, no union types in schemas, < 45 tools, command risk, per-command grants, read-only mode.
- [x] User report "I have no tool for tabs" after the tools shipped: the server had not been restarted (`/sidekick/status` still said 16 tools; 21 after restart). Prompt now tells the model its tools can change mid-chat so it does not parrot an earlier refusal from the history.
- [x] Stale server is now visible: `/sidekick/status` returns `restart_needed` (any `sidekick/**/*.py` newer than process start); the panel shows a yellow banner, refreshed on mount, on every send and on reconnect. Verified: banner logic live; flag + route import via `tests/py/test_routes.py` (stubs ComfyUI's `server` so import-time mistakes in `routes.py` are caught before a restart).
- [ ] Claude CLI: `--system-prompt-snapshot` defaults to `on`, so resumed chats keep the system prompt they started with (tools still refresh via MCP). Verify `off` with a spike before using it.
- [ ] Still unverified: `workflow_tabs` save/close/open/list_saved against real saved files (only list/new/switch ran live); new tools through a real LLM turn (needs ComfyUI restart — Python tool defs changed).

## Vision (user request 2026-09-18: "a way for it to visually see comfyui and the graph")
- [x] `screenshot` tool (`web/tools/vision.js`). `graph`: re-renders the real LiteGraph canvas at a size and framing we choose (node_ids / group / whole workflow, ≤1568px, zoom ≤1.0, low-quality threshold and debug overlay off), grabs it and restores everything in one synchronous task — the user's view never moves and it works even when the canvas is 0×0. `viewport`: the user's current view. `ui`: whole tab through `getDisplayMedia` (needs a click → `client.requestGesture` + a share bar in the panel; stream reused until the user stops sharing).
- [x] Pixels travel separately from text: tool result `{__images__, text, thumb}` → `registry.dispatch_full` → (ok, text, images). MCP brains get `image` content blocks; the OpenAI-compatible loop appends a `user` message with `image_url` parts after the batch of tool results (tool messages are text-only there). Only the newest 2 screenshots keep pixels; nothing with pixels is written to session files; a 360px `thumb` is stored on the tool card so the user sees what the model saw.
- [x] Text-only models (DeepSeek): provider setting `vision` auto/on/off. Auto: a 4xx while images are in history → strip pixels, retry, and remember `(base_url, model)` as blind only if the retry succeeds.
- [x] Consent: `Tool.confirm` + `confirm_note` → permission card ("Screenshots are sent to the AI provider…") even in read-only mode (looking is not editing); "allow for this chat" covers the rest of the chat. `ui` additionally needs the browser's own share prompt.
- [x] Verified: canvas capture live on :8188 (viewed the JPEG myself: nodes, titles, widget values, links all legible; canvas state restored bit-for-bit); **Claude CLI really sees MCP image blocks** (spike, haiku: read "KSampler, steps 8, cfg 1.0" off the real screenshot, $0.005); `tests/py/test_vision.py` (7 tests: split, bad payloads, consent incl. read-only, MCP block, OpenAI image message, blind-model fallback, history hygiene).
- [ ] Unverified: `ui` target end to end (needs a human click + browser prompt); a real vision-capable API model; **Codex with MCP image blocks**; Vue-nodes mode (canvas shots lack nodes there — the tool warns and points to `ui`).
- [ ] Known limit: multiline text boxes and other DOM widgets are not on the canvas, so they are blank in `graph`/`viewport` shots (values are in `get_workflow`; `ui` shows them).

## P3 — Sophisticated editing + interaction
- [ ] auto_layout (layered DAG, groups as super-nodes, reroutes, dry_run), Vue-nodes check of `setNodePos` (`arrange_nodes` covers the simple cases already)
- [ ] Node/canvas context menus (list/invoke with submenu paths), settings (commands: done)
- [ ] load_workflow from JSON/template, queue_prompt with validation errors, wait_for_execution, execution errors (tabs + queue via `run_command`: done)
- [ ] Subgraph-aware ids in outlines

## P4 — Manager, models, web, restart/resume
- [ ] Manager client (queue → start → poll), missing-nodes flow, model search/install, direct download with progress
- [ ] web_search / web_fetch (SSRF guard) for API providers
- [ ] restart_comfyui with continuation note + auto-resume on `reconnected`

## P5 — Reach + polish
- [ ] Pop-out floating window, DOM automation (ui_snapshot/click/type/key), execute_js (gated), todos card, context trimming, README

## P6 — Power mode (opt-in)
- [ ] CLI file/shell tools with permission prompts bridged into the chat

## Deviations from the approved plan
- UI uses plain DOM + a tiny `h()` helper and a built-in safe markdown renderer instead of vendored Preact/htm/marked/DOMPurify: no downloads, no supply chain, matches the no-build convention.
- Python lives in one inner package `sidekick/` (not top-level `server/`, `mcp/`, `tools/`) to avoid shadowing ComfyUI's `server` module and the `mcp` pip package.
- Event catch-up is snapshot + seq (re-fetch on gap) instead of an `events?after=N` log.
