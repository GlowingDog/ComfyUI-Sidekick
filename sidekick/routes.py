"""HTTP surface of Sidekick, registered on ComfyUI's aiohttp server at import.
Every route is also reachable under /api (ComfyUI aliases custom routes)."""
import asyncio
import logging
import os
import time

from aiohttp import web
from server import PromptServer

from . import VERSION, bridge, config, mcp_server, pending, registry, sessions, tooldefs
from .agent import cli_common, loop_openai, runner

log = logging.getLogger("sidekick")
routes = PromptServer.instance.routes
tooldefs.register_all()

_cli_status = {}
DEV_SESSION = "d0d0d0d0"  # session ids must be hex (they become file names)
_LOADED_AT = time.time()


def _restart_needed():
    """True when Sidekick's Python on disk is newer than this process. Tool
    definitions live in Python, so an update is invisible to the model until
    ComfyUI restarts — without this flag nobody can tell (it cost a real user
    a confusing "I have no tool for that")."""
    root = os.path.dirname(os.path.abspath(__file__))
    try:
        for folder, _, files in os.walk(root):
            if "__pycache__" in folder:
                continue
            for name in files:
                if name.endswith(".py") and os.path.getmtime(os.path.join(folder, name)) > _LOADED_AT:
                    return True
    except OSError:
        pass
    return False


def _is_loopback(request):
    return request.remote in ("127.0.0.1", "::1", "localhost")


def _bad(message, status=400):
    return web.json_response({"error": message}, status=status)


async def _json(request):
    try:
        data = await request.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


# ---------- status / config ----------

@routes.get("/sidekick/status")
async def status(request):
    cfg = config.load()
    if request.query.get("refresh") or not _cli_status:
        loop = asyncio.get_running_loop()

        def probe():
            out = {}
            for name in ("claude", "codex"):
                prov = config.get_provider(cfg, name + "_cli") or {}
                argv = cli_common.resolve(name, prov.get("cli_path"))
                out[name] = {"found": bool(argv),
                             "version": cli_common.version(argv) if argv else None}
            return out
        _cli_status.update(await loop.run_in_executor(None, probe))
    return web.json_response({"version": VERSION, "dev_mode": bool(cfg.get("dev_mode")),
                              "cli": _cli_status, "tools": len(registry.all_tools(cfg=cfg)),
                              "restart_needed": _restart_needed()})


@routes.get("/sidekick/config")
async def get_config(request):
    return web.json_response(config.masked(config.load()))


@routes.post("/sidekick/config")
async def post_config(request):
    data = await _json(request)
    if data is None:
        return _bad("JSON object expected")
    cfg = config.merge_update(config.load(), data)
    config.save(cfg)
    return web.json_response(config.masked(cfg))


@routes.get("/sidekick/providers/models")
async def provider_models(request):
    provider = config.get_provider(config.load(), request.query.get("provider"))
    if provider is None or provider.get("kind") != "openai":
        return _bad("unknown API provider", 404)
    try:
        return web.json_response({"models": await loop_openai.list_models(provider)})
    except Exception as e:
        return _bad(str(e), 502)


# ---------- chat ----------

@routes.post("/sidekick/chat")
async def chat(request):
    data = await _json(request)
    if data is None or not str(data.get("text") or "").strip():
        return _bad("text is required")
    if not data.get("client_id"):
        return _bad("client_id is required")
    cfg = config.load()
    provider = config.get_provider(cfg, data.get("provider") or cfg.get("default_provider"))
    if provider and provider.get("kind", "").endswith("_cli") and not _is_loopback(request):
        return _bad("CLI providers can only be used from the machine running ComfyUI.", 403)
    session = sessions.get(data.get("session_id"), create=True)
    if session.running:
        return _bad("This chat is still working. Stop it first.", 409)
    runner.start_turn(session, data["client_id"], str(data["text"]).strip(),
                      data.get("provider"), data.get("model"))
    return web.json_response({"session_id": session.id}, status=202)


@routes.post("/sidekick/chat/stop")
async def chat_stop(request):
    data = await _json(request) or {}
    session = sessions.get(data.get("session_id"))
    if session is not None and session.running:
        session.task.cancel()
    return web.json_response({"ok": True})


@routes.post("/sidekick/answer")
async def answer(request):
    data = await _json(request) or {}
    ok = pending.answer(str(data.get("request_id")), data.get("payload") or {})
    return web.json_response({"ok": ok}, status=200 if ok else 410)


@routes.post("/sidekick/rpc_result")
async def rpc_result(request):
    data = await _json(request) or {}
    ok = bridge.resolve(str(data.get("rid")), bool(data.get("ok")), data.get("result"),
                        data.get("error"))
    return web.json_response({"ok": ok})


# ---------- sessions ----------

@routes.get("/sidekick/sessions")
async def list_sessions(request):
    return web.json_response({"sessions": sessions.list_meta()})


@routes.get("/sidekick/sessions/{sid}")
async def get_session(request):
    session = sessions.get(request.match_info["sid"])
    if session is None:
        return _bad("not found", 404)
    return web.json_response(session.snapshot())


@routes.delete("/sidekick/sessions/{sid}")
async def delete_session(request):
    sessions.delete(request.match_info["sid"])
    return web.json_response({"ok": True})


# ---------- MCP endpoint (Claude / Codex CLIs connect here) ----------

@routes.post("/sidekick/mcp")
async def mcp_endpoint(request):
    if not _is_loopback(request):
        return web.Response(status=403)
    binding = mcp_server.binding_for(request.headers.get("Authorization"))
    if binding is None:
        return web.Response(status=401)
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"jsonrpc": "2.0", "id": None,
                                  "error": {"code": -32700, "message": "Parse error"}}, status=400)
    cfg = config.load()
    session = binding["session"]
    ctx = registry.ToolContext(session, binding.get("client_id"), cfg)

    def list_tools():
        return registry.to_mcp(registry.all_tools(binding.get("provider_kind"), cfg))

    async def call_tool(name, args):
        return await registry.dispatch(ctx, name, args)

    response = await mcp_server.handle_payload(payload, list_tools, call_tool)
    if response is None:
        return web.Response(status=202)
    return web.json_response(response)


@routes.get("/sidekick/mcp")
async def mcp_no_stream(request):
    return web.Response(status=405)  # no server-initiated SSE stream


# ---------- dev harness: call any tool without spending LLM tokens ----------

@routes.post("/sidekick/dev/call_tool")
async def dev_call_tool(request):
    cfg = config.load()
    if not cfg.get("dev_mode") or not _is_loopback(request):
        return _bad("dev_mode is off", 403)
    data = await _json(request) or {}
    session = sessions.get(DEV_SESSION) or sessions.Session(sid=DEV_SESSION)
    sessions._sessions.setdefault(DEV_SESSION, session)
    session.client_id = data.get("client_id") or session.client_id
    ctx = registry.ToolContext(session, session.client_id, cfg)
    ok, text = await registry.dispatch(ctx, str(data.get("tool")), data.get("args") or {})
    return web.json_response({"ok": ok, "text": text})


log.info("[Sidekick] v%s loaded, %d tools", VERSION, len(registry.all_tools()))
