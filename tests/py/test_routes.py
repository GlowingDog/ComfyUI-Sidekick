"""routes.py only imports inside ComfyUI (it needs server.PromptServer). A stub lets
us catch import-time mistakes before a user restart turns them into a dead extension."""
import asyncio
import json
import os
import sys
import tempfile
import time
import types
import unittest

from aiohttp import web

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

stub = types.ModuleType("server")
stub.PromptServer = type("PromptServer", (), {})
stub.PromptServer.instance = types.SimpleNamespace(routes=web.RouteTableDef(), sockets={}, port=8188,
                                                   send_sync=lambda *a, **k: None)
sys.modules.setdefault("server", stub)

from sidekick import paths  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))

from sidekick import routes  # noqa: E402


class FakeRequest:
    def __init__(self, remote="127.0.0.1", query=None, body=None, headers=None, match=None):
        self.remote, self.query, self.headers, self.match_info = remote, query or {}, headers or {}, match or {}
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class RoutesTests(unittest.TestCase):
    def test_all_routes_registered(self):
        paths_ = {(r.method, r.path) for r in routes.routes if isinstance(r, web.RouteDef)}
        for expected in [("GET", "/sidekick/status"), ("POST", "/sidekick/chat"), ("POST", "/sidekick/mcp"),
                         ("POST", "/sidekick/rpc_result"), ("POST", "/sidekick/answer"),
                         ("GET", "/sidekick/providers/models"), ("POST", "/sidekick/dev/call_tool")]:
            self.assertIn(expected, paths_)

    def test_status_reports_tools_and_restart_flag(self):
        routes._cli_status.update({"claude": {"found": False}, "codex": {"found": False}})  # skip CLI probing
        routes._LOADED_AT = time.time() + 5
        data = json.loads(run(routes.status(FakeRequest())).body)
        self.assertGreaterEqual(data["tools"], 21)
        self.assertFalse(data["restart_needed"])
        routes._LOADED_AT = 0  # every .py on disk is newer than "process start"
        self.assertTrue(json.loads(run(routes.status(FakeRequest())).body)["restart_needed"])

    def test_mcp_needs_loopback_and_token(self):
        self.assertEqual(run(routes.mcp_endpoint(FakeRequest(remote="10.0.0.5"))).status, 403)
        self.assertEqual(run(routes.mcp_endpoint(FakeRequest())).status, 401)

    def test_dev_route_is_off_by_default(self):
        self.assertEqual(run(routes.dev_call_tool(FakeRequest(body={"tool": "get_workflow"}))).status, 403)

    def test_cli_brains_are_loopback_only(self):
        resp = run(routes.chat(FakeRequest(remote="192.168.1.20",
                                           body={"text": "hi", "client_id": "c", "provider": "claude_cli"})))
        self.assertEqual(resp.status, 403)


if __name__ == "__main__":
    unittest.main()
