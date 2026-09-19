# ComfyUI-Sidekick

An AI agent that lives inside ComfyUI. You chat with it in a sidebar tab (or a floating window) and it works on the workflow that is open on your canvas — **live**: nodes appear, links get drawn, values change while you watch, and every step it takes is one **Ctrl+Z**.

It is not tied to one AI service. Pick a brain:

| Brain | What you need |
|---|---|
| **Claude CLI** | [Claude Code](https://claude.com/claude-code) installed and logged in. No API key: it uses your CLI login. |
| **Codex CLI** | The OpenAI Codex CLI installed and logged in. No API key. |
| **Any OpenAI-compatible API** | A base URL and an API key: OpenRouter, DeepSeek, NanoGPT, a local server, … |

## Install

1. Clone this folder into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI. Nothing else to install: it only uses Python's standard library and `aiohttp`, which ComfyUI already ships.
3. Open the **Sidekick** tab in the sidebar (the sparkles icon). For an API brain, open ⚙ **Settings** in the panel, paste the key into the provider card and press Enter, then pick a model.

ComfyUI-Manager is optional; with it, Sidekick can find and install node packs and restart ComfyUI.

## What it can do

- **Build and edit workflows** — add, connect, configure, rename, bypass, delete nodes; write into text boxes; pick models, samplers, schedulers from the lists your ComfyUI really has. Big edits go in one batch and one undo step.
- **Keep things tidy** — titled groups, rows / columns / grids, and a whole-workflow auto layout that follows the links, keeps groups together and never overlaps.
- **Understand big graphs** — outlines that shrink to fit, filters by group / text / ids, link tracing, subgraphs.
- **See** — screenshots of the graph, your current view, or the whole browser tab (after you allow tab sharing), so it can check its own layout and look at results. Screenshots go to the AI provider you chose; it asks first.
- **Run and watch** — queue the workflow, read validation errors per node, runtime errors with the failing node, and the output files.
- **Use the rest of ComfyUI** — commands, workflow tabs and templates, right-click menus of nodes / groups / canvas (including entries from node packs), settings, and any dialog or window through a generic "read the screen / click / type / press keys" pair.
- **Node packs and models** — find which pack provides a missing (red) node, install / update / disable packs through ComfyUI-Manager, search the Manager's model list, Hugging Face and Civitai, download models into the right folder with a progress card, restart ComfyUI and continue the conversation by itself afterwards.
- **The web** — search and read pages (API brains; Claude and Codex use their own web tools).
- **Ask you** — multiple-choice questions when a decision is really yours, and a plan card for longer jobs.

## Permissions and safety

Sidekick asks before anything that cannot be undone with Ctrl+Z or that leaves your machine. The card shows exactly what it wants to do, with **Allow once**, **Allow for this chat** and **Deny**.

| Without asking | Asks first |
|---|---|
| Reading the graph, searching nodes / packs / models / the web | Installing, updating, removing node packs |
| Graph edits (each one is an undo step) | Downloading a model |
| View and navigation commands, opening tabs and templates | Restarting ComfyUI |
| Queueing the workflow | Changing a ComfyUI setting |
| | Saving / closing a workflow, unknown or destructive commands |
| | Clicking and typing in dialogs (once per chat) |
| | Screenshots (once per chat) |
| | Running JavaScript (every script; off unless you switch it on) |

Settings → **Permissions** also offers *Never ask* and *Read-only*.

Other guard rails:

- **API keys and tokens** are stored in `ComfyUI/user/__sidekick/config.json`, are write-only in the UI, and are never shown to the AI. Hugging Face / Civitai tokens are only ever sent to their own site.
- **Web access** only reaches public internet addresses: nothing on your PC or your network can be read through it, including by a web page that tries to trick the AI.
- **Downloads** land only in ComfyUI's model folders and never overwrite a file. `.safetensors` / `.gguf` from anywhere; formats that can run code when loaded (`.ckpt`, `.pt`, `.pth`, `.bin`) only from ComfyUI-Manager's vetted model list.
- **CLI brains** run with file and shell tools switched off: they can only use Sidekick's tools and the web. They are only offered to the machine ComfyUI runs on.
- Sidekick's panel cannot be seen or clicked by the AI itself, so it cannot approve its own requests.
- Text from web pages, model cards and files is treated as information, never as instructions.

## Tips

- Say what you want in plain words: *"build an SDXL text-to-image workflow with a 2x upscale, group it by stage"*, *"why is this node red?"*, *"tidy this group"*, *"set cfg to 5 and the scheduler to karras on both samplers"*, *"run it and tell me what failed"*.
- Next to **Send**: the brain, its **model** (the list comes from the brain itself; *Other…* takes any id) and the **effort** — how long the model thinks before it acts. Higher effort is slower and costs more; *Low* is fine for small edits, raise it for big builds or debugging. Both are remembered per brain.
- **⧉** in the panel header pops the chat out into a floating window you can drag and resize; **⇤** docks it back. There is also a command: *Sidekick: floating window on/off*.
- **☰** lists your chats (rename with ✎). Chats are kept in `ComfyUI/user/__sidekick/sessions/`; screenshots are never written to disk.
- A yellow banner means Sidekick was updated on disk: restart ComfyUI so the AI sees the new tools.
- After Sidekick installs a node pack, new nodes work right away, but a pack's own interface code only loads with the page: press F5 if a new node looks wrong.
- Text-only models (DeepSeek, …) work fine; screenshots are then shown to you only.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The ComfyUI browser tab for this chat is not connected" | The tab that started the chat was closed or reloaded. Send the message again from the open tab. |
| Claude / Codex CLI "not found" in Settings | Install the CLI and log in once in a terminal, then restart ComfyUI. |
| The AI says it has no tool for something listed above | Restart ComfyUI (yellow banner), then ask again in the same chat. |
| A node pack install is refused | ComfyUI-Manager's `security_level` does not allow it; install from the Manager's own dialog, or change the level in `ComfyUI/user/__manager/config.ini`. |
| A download says it needs a token | Gated Hugging Face models and most Civitai files need your token: Settings → Web and downloads. |
| DuckDuckGo returns nothing | It rate-limits; wait a minute, or set up Tavily / Brave / your own SearXNG in Settings. |

## For developers

`CLAUDE.md` describes the architecture and the rules of the code base, `PLAN.md` what was built, verified and left open. Tests: `python tests/py/<file>.py` (with ComfyUI's Python) and `node --test tests/js/pure.test.mjs`; in the browser console: `const t = await import("/extensions/ComfyUI-Sidekick/dev/paneTests.js"); await t.run()`.

## Credits

Design ideas (batched edit operations with refs, connect auto-matching with slot diagnostics, compact graph outlines) were informed by the MIT-licensed projects filliptm/ComfyUI_FL-MCP, artokun/comfyui-mcp-panel and ConstantineB6/comfy-pilot. No code was copied.

## License

MIT
