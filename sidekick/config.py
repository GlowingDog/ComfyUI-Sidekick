"""Config file (`user/__sidekick/config.json`). Secrets never leave the server
unmasked: GET returns `<key>: ""` plus `<key>_set` / `<key>_hint`."""
import copy
import json
import os
import threading

from . import paths

SECRET_KEYS = {"api_key", "tavily_key", "brave_key", "huggingface", "civitai"}

DEFAULTS = {
    "permission_mode": "confirm",  # confirm | auto | readonly
    "dev_mode": False,
    "allow_execute_js": False,
    "default_provider": "claude_cli",
    "providers": [
        {"id": "claude_cli", "kind": "claude_cli", "name": "Claude CLI", "model": ""},
        {"id": "codex_cli", "kind": "codex_cli", "name": "Codex CLI", "model": ""},
        {"id": "openrouter", "kind": "openai", "name": "OpenRouter",
         "base_url": "https://openrouter.ai/api/v1", "api_key": "", "model": ""},
        {"id": "deepseek", "kind": "openai", "name": "DeepSeek",
         "base_url": "https://api.deepseek.com/v1", "api_key": "", "model": "deepseek-chat"},
        {"id": "nanogpt", "kind": "openai", "name": "NanoGPT",
         "base_url": "https://nano-gpt.com/api/v1", "api_key": "", "model": ""},
    ],
    "search": {"backend": "ddg", "tavily_key": "", "brave_key": "", "searxng_url": ""},
    "tokens": {"huggingface": "", "civitai": ""},
}

_lock = threading.Lock()
_cache = None


def _path():
    return os.path.join(paths.data_dir(), "config.json")


def load():
    global _cache
    with _lock:
        if _cache is None:
            cfg = copy.deepcopy(DEFAULTS)
            try:
                with open(_path(), "r", encoding="utf-8") as f:
                    cfg.update(json.load(f))
            except FileNotFoundError:
                pass
            except Exception:
                pass  # corrupt file: fall back to defaults, keep the file for inspection
            _cache = cfg
        return copy.deepcopy(_cache)


def save(cfg):
    global _cache
    with _lock:
        tmp = _path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, _path())
        _cache = copy.deepcopy(cfg)


def reset_cache():
    global _cache
    with _lock:
        _cache = None


def get_provider(cfg, provider_id):
    for p in cfg.get("providers", []):
        if p.get("id") == provider_id:
            return p
    return None


def masked(cfg):
    """Deep copy with every secret blanked and described by _set/_hint."""
    def walk(node):
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if k in SECRET_KEYS:
                    s = v if isinstance(v, str) else ""
                    out[k] = ""
                    out[k + "_set"] = bool(s)
                    out[k + "_hint"] = ("…" + s[-4:]) if len(s) >= 8 else ""
                else:
                    out[k] = walk(v)
            return out
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node
    return walk(cfg)


def merge_update(current, incoming):
    """Apply a config POST. A secret is only replaced when the client sends a
    non-empty string, or cleared when it sends `<key>_clear: true`."""
    def merge(cur, inc):
        if isinstance(cur, dict) and isinstance(inc, dict):
            out = dict(cur)
            for k, v in inc.items():
                if k.endswith(("_set", "_hint")) and k.rsplit("_", 1)[0] in SECRET_KEYS:
                    continue
                if k.endswith("_clear") and k[:-6] in SECRET_KEYS:
                    if v:
                        out[k[:-6]] = ""
                    continue
                if k in SECRET_KEYS:
                    if isinstance(v, str) and v:
                        out[k] = v
                    continue
                out[k] = merge(cur.get(k), v)
            return out
        return inc

    new = merge(current, {k: v for k, v in incoming.items() if k != "providers"})
    if isinstance(incoming.get("providers"), list):
        old_by_id = {p.get("id"): p for p in current.get("providers", [])}
        new["providers"] = [merge(old_by_id.get(p.get("id"), {}), p)
                            for p in incoming["providers"] if isinstance(p, dict) and p.get("id")]
    return new
