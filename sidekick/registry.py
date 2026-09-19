"""Single tool registry. Every brain (OpenAI-compatible loop, Claude CLI and
Codex CLI through MCP) sees the same tools and goes through `dispatch`."""
import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from . import bridge, pending

MAX_RESULT_CHARS = 16000


@dataclass
class Tool:
    name: str
    description: str
    params: dict  # JSON-schema "properties"
    required: list = field(default_factory=list)
    side: str = "frontend"  # frontend: runs in the browser tab | backend: runs here
    risk: str = "read"  # read | edit (undoable graph edit) | risky (needs confirmation)
    handler: Optional[Callable[["ToolContext", dict], Awaitable[Any]]] = None
    timeout: float = 60.0
    silent: bool = False  # no tool card in the chat (the tool draws its own UI)
    hide_for: tuple = ()  # provider kinds that should not see this tool
    max_chars: int = MAX_RESULT_CHARS  # result cap; big-graph readers budget themselves below it
    # Per-call risk for multiplexed tools (run_command, workflow_tabs): args -> read|edit|risky
    risk_fn: Optional[Callable[[dict], str]] = None
    # Ask first even though nothing is edited (screenshots leave the machine). Unlike
    # risk="risky" this still works in read-only mode.
    confirm: bool = False
    confirm_note: str = ""

    def risk_of(self, args):
        if self.risk_fn is None:
            return self.risk
        try:
            return self.risk_fn(args) or self.risk
        except Exception:
            return "risky"  # unknown shape: be careful

    def schema(self):
        return {"type": "object", "properties": self.params, "required": list(self.required)}


@dataclass
class ToolContext:
    session: Any
    client_id: Optional[str]
    cfg: dict


_tools = {}


def register(tool):
    if tool.side == "backend" and tool.handler is None:
        raise ValueError(f"backend tool {tool.name} needs a handler")
    _tools[tool.name] = tool
    return tool


def get(name):
    return _tools.get(name)


def all_tools(provider_kind=None, cfg=None):
    out = []
    for t in _tools.values():
        if provider_kind and provider_kind in t.hide_for:
            continue
        if t.name == "execute_js" and not (cfg or {}).get("allow_execute_js"):
            continue
        if t.name in ("web_search", "web_fetch") and (cfg or {}).get("web_tools") is False:
            continue  # the user switched internet access off
        out.append(t)
    return out


def to_openai(tools):
    return [{"type": "function",
             "function": {"name": t.name, "description": t.description, "parameters": t.schema()}}
            for t in tools]


def to_mcp(tools):
    return [{"name": t.name, "description": t.description, "inputSchema": t.schema()} for t in tools]


def _to_text(result, limit=MAX_RESULT_CHARS):
    if result is None:
        text = "ok"
    elif isinstance(result, str):
        text = result
    else:
        text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if len(text) > limit:
        text = text[:limit] + f"\n…[truncated {len(text) - limit} chars; narrow the request]"
    return text


def _grant_key(tool, args):
    """What "Allow for this chat" covers. For multiplexed tools the grant is for
    this exact call shape (one command id), never for the whole tool."""
    if tool.risk_fn is None:
        return tool.name
    return tool.name + ":" + json.dumps(args, sort_keys=True, default=str)[:300]


async def _check_permission(ctx, tool, args):
    """Returns None when allowed, else the refusal text for the model."""
    mode = ctx.cfg.get("permission_mode", "confirm")
    risk = tool.risk_of(args)
    if mode == "readonly" and risk != "read":
        return ("Denied: Sidekick is in read-only mode. Describe the change instead, or ask the "
                "user to switch the permission mode in Sidekick settings.")
    key = _grant_key(tool, args)
    needs_card = risk == "risky" or tool.confirm  # confirm: harmless to the graph, but private
    if not needs_card or mode == "auto" or key in ctx.session.allowed_tools:
        return None
    answer = await pending.ask(ctx.session, "permission", tool=tool.name, args=args,
                               note=tool.confirm_note or None)
    decision = (answer or {}).get("decision")
    if decision == "allow_session":
        ctx.session.allowed_tools.add(key)
        return None
    if decision == "allow":
        return None
    note = (answer or {}).get("note")
    return "Denied by the user." + (f" User says: {note}" if note else "")


IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_B64 = 4_000_000
MAX_THUMB_CHARS = 120_000


def _split_images(result):
    """Vision tools return {"__images__": [{mime, data(base64)}], "text", "thumb"}.
    Returns (result_without_images, images, thumb_data_url)."""
    if not isinstance(result, dict) or "__images__" not in result:
        return result, [], None
    images = []
    for img in result.get("__images__") or []:
        if (isinstance(img, dict) and img.get("mime") in IMAGE_MIMES and isinstance(img.get("data"), str)
                and 0 < len(img["data"]) <= MAX_IMAGE_B64 and len(images) < 2):
            images.append({"mime": img["mime"], "data": img["data"]})
    thumb = result.get("thumb")
    if not (isinstance(thumb, str) and thumb.startswith("data:image/") and len(thumb) <= MAX_THUMB_CHARS):
        thumb = None
    return result.get("text") or "screenshot taken", images, thumb


async def dispatch(ctx, name, args):
    """Run one tool call. Returns (ok, text); never raises except CancelledError."""
    ok, text, _ = await dispatch_full(ctx, name, args)
    return ok, text


async def dispatch_full(ctx, name, args):
    """Like dispatch, plus the images a vision tool produced: (ok, text, images)."""
    tool = _tools.get(name)
    if tool is None:
        return False, f"Unknown tool '{name}'. Available: {', '.join(sorted(_tools))}", []
    if isinstance(args, str):
        try:
            args = json.loads(args) if args.strip() else {}
        except ValueError:
            return False, "Arguments were not valid JSON.", []
    if not isinstance(args, dict):
        return False, "Arguments must be a JSON object.", []
    missing = [k for k in tool.required if k not in args]
    if missing:
        return False, f"Missing required argument(s): {', '.join(missing)}", []
    if getattr(ctx.session, "restart_requested", False):
        return False, ("ComfyUI is about to restart (you booked it with restart_comfyui). Call no more tools: end "
                       "your turn now with one short sentence. You will be called again after the restart."), []

    item = None if tool.silent else ctx.session.add_item("tool", name=name, args=args, status="running")

    def finish(ok, text, status=None, images=(), thumb=None):
        if item is not None:
            patch = {"status": status or ("ok" if ok else "error"), "summary": text[:400]}
            if thumb:
                patch["thumb"] = thumb  # the user sees what the model saw
            ctx.session.update_item(item, **patch)
        return ok, text, list(images)

    try:
        refusal = await _check_permission(ctx, tool, args)
        if refusal:
            return finish(False, refusal, "denied")
        if tool.side == "backend":
            result = await tool.handler(ctx, args)
        else:
            result = await bridge.call(ctx.client_id, name, args, tool.timeout)
        result, images, thumb = _split_images(result)
        return finish(True, _to_text(result, tool.max_chars), images=images, thumb=thumb)
    except asyncio.CancelledError:
        finish(False, "Stopped.", "interrupted")
        raise
    except bridge.BridgeError as e:
        return finish(False, f"Error: {e}")
    except ToolError as e:
        return finish(False, f"Error: {e}")
    except Exception as e:  # tool bugs must reach the model as text, not kill the turn
        return finish(False, f"Error: {type(e).__name__}: {e}")


class ToolError(Exception):
    """Expected, user-facing tool failure (bad arguments, not found, …)."""
