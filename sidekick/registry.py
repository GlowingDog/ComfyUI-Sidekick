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
        out.append(t)
    return out


def to_openai(tools):
    return [{"type": "function",
             "function": {"name": t.name, "description": t.description, "parameters": t.schema()}}
            for t in tools]


def to_mcp(tools):
    return [{"name": t.name, "description": t.description, "inputSchema": t.schema()} for t in tools]


def _to_text(result):
    if result is None:
        text = "ok"
    elif isinstance(result, str):
        text = result
    else:
        text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_RESULT_CHARS:
        text = (text[:MAX_RESULT_CHARS] +
                f"\n…[truncated {len(text) - MAX_RESULT_CHARS} chars; narrow the request]")
    return text


async def _check_permission(ctx, tool, args):
    """Returns None when allowed, else the refusal text for the model."""
    mode = ctx.cfg.get("permission_mode", "confirm")
    if mode == "readonly" and tool.risk != "read":
        return ("Denied: Sidekick is in read-only mode. Describe the change instead, or ask the "
                "user to switch the permission mode in Sidekick settings.")
    if tool.risk != "risky" or mode == "auto" or tool.name in ctx.session.allowed_tools:
        return None
    answer = await pending.ask(ctx.session, "permission", tool=tool.name, args=args)
    decision = (answer or {}).get("decision")
    if decision == "allow_session":
        ctx.session.allowed_tools.add(tool.name)
        return None
    if decision == "allow":
        return None
    note = (answer or {}).get("note")
    return "Denied by the user." + (f" User says: {note}" if note else "")


async def dispatch(ctx, name, args):
    """Run one tool call. Returns (ok, text); never raises except CancelledError."""
    tool = _tools.get(name)
    if tool is None:
        return False, f"Unknown tool '{name}'. Available: {', '.join(sorted(_tools))}"
    if isinstance(args, str):
        try:
            args = json.loads(args) if args.strip() else {}
        except ValueError:
            return False, "Arguments were not valid JSON."
    if not isinstance(args, dict):
        return False, "Arguments must be a JSON object."
    missing = [k for k in tool.required if k not in args]
    if missing:
        return False, f"Missing required argument(s): {', '.join(missing)}"

    item = None if tool.silent else ctx.session.add_item("tool", name=name, args=args, status="running")

    def finish(ok, text, status=None):
        if item is not None:
            ctx.session.update_item(item, status=status or ("ok" if ok else "error"),
                                    summary=text[:400])
        return ok, text

    try:
        refusal = await _check_permission(ctx, tool, args)
        if refusal:
            return finish(False, refusal, "denied")
        if tool.side == "backend":
            result = await tool.handler(ctx, args)
        else:
            result = await bridge.call(ctx.client_id, name, args, tool.timeout)
        return finish(True, _to_text(result))
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
