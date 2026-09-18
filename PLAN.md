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

## P3 — Sophisticated editing + interaction
- [ ] auto_layout (layered DAG, groups as super-nodes, reroutes, dry_run), Vue-nodes check of `setNodePos`
- [ ] Node/canvas context menus (list/invoke with submenu paths), commands, settings
- [ ] Workflow lifecycle (new/load/save/tabs/templates), queue_prompt, wait_for_execution, execution errors
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
