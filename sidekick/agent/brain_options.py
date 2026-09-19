"""What the model and effort pickers offer for each brain.

- Claude CLI: its model aliases; effort levels read from `claude --help` (they change with
  CLI versions), with a static fallback.
- Codex CLI: `~/.codex/models_cache.json`, which the CLI keeps fresh from the service: the
  models this login can use, each with its own effort levels and default.
- API providers: `GET {base_url}/models`; effort is OpenAI's `reasoning_effort` trio.
Shape: {"models": [{"id", "label", "efforts"?, "default_effort"?}], "efforts": [...], "note"?}
An empty id / effort means "the brain's own default" and is always offered by the UI."""
import asyncio
import json
import os
import re
import time

from . import cli_common, loop_openai

CLAUDE_MODELS = [("fable", "Fable"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")]
CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
API_EFFORTS = ["low", "medium", "high"]
TTL = 600

_cache = {}  # key -> (time, value)


def _cached(key, refresh):
    hit = _cache.get(key)
    return hit[1] if hit and not refresh and time.time() - hit[0] < TTL else None


def parse_claude_efforts(help_text):
    """`--effort <level>  Effort level … (low, medium, high, xhigh, max)` -> the list."""
    m = re.search(r"--effort\b.*?\(([^)]*)\)", help_text or "", re.S)
    levels = [w.strip() for w in (m.group(1) if m else "").split(",")]
    return [w for w in levels if w.isalpha()] or None


def _claude_help(provider):
    argv = cli_common.resolve("claude", provider.get("cli_path"))
    if not argv:
        return ""
    import subprocess
    try:
        return subprocess.run(argv + ["--help"], capture_output=True, text=True, timeout=20,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except Exception:
        return ""


def codex_models(path=None):
    """Models from Codex's own cache, best first. [] when Codex never ran here."""
    path = path or os.path.join(os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex"),
                                "models_cache.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            rows = json.load(f).get("models") or []
    except (OSError, ValueError, AttributeError):
        return []
    out = []
    for m in sorted((r for r in rows if isinstance(r, dict)), key=lambda r: r.get("priority") or 999):
        if not m.get("slug") or m.get("visibility") not in (None, "list"):
            continue
        levels = [str(x.get("effort") if isinstance(x, dict) else x) for x in m.get("supported_reasoning_levels") or []]
        out.append({"id": m["slug"], "label": m.get("display_name") or m["slug"],
                    "efforts": [x for x in levels if x.isalpha()],
                    "default_effort": m.get("default_reasoning_level") or None})
    return out


async def options(provider, refresh=False):
    kind = provider.get("kind")
    key = (kind, provider.get("id"), provider.get("base_url"), bool(provider.get("api_key")))
    hit = _cached(key, refresh)
    if hit is not None:
        return hit
    if kind == "claude_cli":
        text = await asyncio.get_running_loop().run_in_executor(None, _claude_help, provider)
        value = {"models": [{"id": i, "label": l} for i, l in CLAUDE_MODELS],
                 "efforts": parse_claude_efforts(text) or CLAUDE_EFFORTS}
    elif kind == "codex_cli":
        models = codex_models()
        value = {"models": models, "efforts": ["low", "medium", "high"]}
        if not models:
            value["note"] = "Run the Codex CLI once so it can fetch its model list."
    else:
        value = {"models": [], "efforts": API_EFFORTS}
        try:
            value["models"] = [{"id": m, "label": m} for m in await loop_openai.list_models(provider)]
        except Exception as e:
            value["note"] = f"Could not list models: {str(e)[:160]}"
        if provider.get("model") and provider["model"] not in [m["id"] for m in value["models"]]:
            value["models"].insert(0, {"id": provider["model"], "label": provider["model"]})
        if value.get("note"):  # do not remember a failure (no key yet, provider down)
            return value
    _cache[key] = (time.time(), value)
    return value
