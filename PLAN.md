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
- [ ] Live verification in ComfyUI: routes load, sidebar renders, dev `call_tool` builds a txt2img graph with one undo step per call, MCP via curl, real chat turn with Claude
- [ ] Pane tests (`web/dev/pane_tests.js`, `window.SidekickTests`)

## P2 — Other brains
- [ ] OpenAI-compatible loop (aiohttp SSE, tool-call deltas, `reasoning_content`), provider settings UI (base_url, key, model picker via `/models`)
- [ ] Codex provider. Open: MCP approval in `exec` mode ("approval policy is never"), disable `~/.agents/skills` loading (~60k tokens/turn), web search config key, JSONL mapper (fixture: `tests/fixtures/codex_mcp_denied.jsonl`)

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
