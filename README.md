# ComfyUI-Sidekick

An AI agent chat panel inside ComfyUI. Pick a brain — the **Claude CLI**, the **Codex CLI** (both use your existing CLI login, no API key) or any **OpenAI-compatible API** (OpenRouter, DeepSeek, NanoGPT, …) — and it builds and edits the workflow on your canvas **live**: nodes, links, widget values, groups. Every tool call is a single Ctrl+Z step.

Status: early development (see `PLAN.md`).

## Install
Clone into `ComfyUI/custom_nodes/` and restart ComfyUI. No extra Python packages are required. Open the **Sidekick** tab in the sidebar.

## Credits
Design ideas (batched edit operations with refs, connect auto-matching with slot diagnostics, compact graph outlines) were informed by the MIT-licensed projects filliptm/ComfyUI_FL-MCP, artokun/comfyui-mcp-panel and ConstantineB6/comfy-pilot. No code was copied.

## License
MIT
