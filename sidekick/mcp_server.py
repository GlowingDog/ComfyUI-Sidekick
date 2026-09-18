"""Minimal MCP server (Streamable HTTP, JSON responses only) hosted on ComfyUI's
own aiohttp server. Just enough of the protocol for tools: initialize, ping,
tools/list, tools/call. Each agent turn gets a bearer token that binds MCP
calls to a chat session and its browser tab."""
import secrets

from . import VERSION

DEFAULT_PROTOCOL = "2025-06-18"
SERVER_NAME = "sidekick"

_tokens = {}  # token -> binding dict {session, client_id, provider_kind}


def issue_token(binding):
    token = secrets.token_urlsafe(32)
    _tokens[token] = binding
    return token


def revoke_token(token):
    _tokens.pop(token, None)


def binding_for(auth_header):
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return None
    return _tokens.get(auth_header[7:].strip())


def _result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


async def handle_message(msg, list_tools, call_tool):
    """Handle one JSON-RPC message. Returns a response dict, or None for
    notifications. `list_tools()` -> MCP tool dicts; `call_tool(name, args)` ->
    (ok, text)."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _error(None, -32600, "Invalid Request")
    method, msg_id = msg.get("method"), msg.get("id")
    if method is None:  # a response to something we never sent
        return None
    if msg_id is None:  # notification (notifications/initialized, cancelled, …)
        return None
    params = msg.get("params") or {}
    if method == "initialize":
        version = params.get("protocolVersion")
        if not (isinstance(version, str) and version[:2] == "20"):
            version = DEFAULT_PROTOCOL
        return _result(msg_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": VERSION},
            "instructions": "Tools that read and edit the live ComfyUI canvas.",
        })
    if method == "ping":
        return _result(msg_id, {})
    if method == "tools/list":
        return _result(msg_id, {"tools": list_tools()})
    if method == "tools/call":
        name = params.get("name")
        if not isinstance(name, str):
            return _error(msg_id, -32602, "Missing tool name")
        ok, text = await call_tool(name, params.get("arguments") or {})
        return _result(msg_id, {"content": [{"type": "text", "text": text}], "isError": not ok})
    if method in ("resources/list", "prompts/list", "resources/templates/list"):
        key = {"resources/list": "resources", "prompts/list": "prompts",
               "resources/templates/list": "resourceTemplates"}[method]
        return _result(msg_id, {key: []})
    return _error(msg_id, -32601, f"Method not found: {method}")


async def handle_payload(payload, list_tools, call_tool):
    """Single message or (legacy) batch. Returns response body or None."""
    if isinstance(payload, list):
        out = []
        for m in payload:
            r = await handle_message(m, list_tools, call_tool)
            if r is not None:
                out.append(r)
        return out or None
    return await handle_message(payload, list_tools, call_tool)
