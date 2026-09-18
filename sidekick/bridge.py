"""RPC bridge to the browser tab that owns a chat. Python pushes
`sidekick.rpc {rid, tool, args}` to one websocket client; the tab runs the tool
against the live graph and POSTs the outcome to /sidekick/rpc_result."""
import asyncio
import uuid

RPC_EVENT = "sidekick.rpc"

_pending = {}
_send_hook = None  # tests replace this


class BridgeError(Exception):
    pass


def set_send_hook(fn):
    global _send_hook
    _send_hook = fn


def _client_connected(client_id):
    if _send_hook is not None:
        return True
    try:
        from server import PromptServer
        return client_id in PromptServer.instance.sockets
    except Exception:
        return False


def _send(client_id, payload):
    if _send_hook is not None:
        _send_hook(client_id, payload)
        return
    from server import PromptServer
    PromptServer.instance.send_sync(RPC_EVENT, payload, client_id)


async def call(client_id, tool, args, timeout=60.0):
    if not client_id or not _client_connected(client_id):
        raise BridgeError("The ComfyUI browser tab for this chat is not connected. "
                          "Ask the user to open or reload the ComfyUI page.")
    rid = uuid.uuid4().hex
    fut = asyncio.get_running_loop().create_future()
    _pending[rid] = fut
    try:
        _send(client_id, {"rid": rid, "tool": tool, "args": args or {}})
        return await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        raise BridgeError(f"Browser did not answer '{tool}' within {int(timeout)}s.")
    finally:
        _pending.pop(rid, None)


def resolve(rid, ok, result=None, error=None):
    fut = _pending.get(rid)
    if fut is None or fut.done():
        return False
    if ok:
        fut.set_result(result)
    else:
        fut.set_exception(BridgeError(str(error or "tool failed in browser")))
    return True
