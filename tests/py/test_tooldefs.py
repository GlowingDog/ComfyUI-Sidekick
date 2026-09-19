"""Tool definitions: per-call risk, result caps, and parity with the browser tool table."""
import asyncio
import os
import re
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import bridge, paths, pending, registry, sessions, tooldefs  # noqa: E402
from sidekick.tooldefs import ui  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
sessions.set_emit_hook(lambda payload: None)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class ToolDefTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        registry._tools.clear()
        tooldefs._done = False
        tooldefs.register_all()

    def test_every_frontend_tool_exists_in_the_browser_table(self):
        with open(os.path.join(ROOT, "web", "tools", "index.js"), encoding="utf-8") as f:
            js = f.read()
        table = js[js.index("const TOOLS = {"):js.index("};", js.index("const TOOLS = {"))]
        js_names = set(re.findall(r"^\s*([a-z_]+): \{ fn:", table, re.M))
        py_frontend = {t.name for t in registry.all_tools() if t.side == "frontend"}
        self.assertEqual(py_frontend - js_names, set(), "declared to the LLM but not implemented in web/tools/index.js")
        self.assertEqual(js_names - py_frontend, set(), "implemented in the browser but never offered to the LLM")

    def test_schemas_are_provider_safe(self):
        self.assertLess(len(registry.all_tools()), 45)  # Codex drops oversized MCP servers
        for t in registry.all_tools():
            schema = t.schema()
            self.assertEqual(schema["type"], "object")
            for req in schema["required"]:
                self.assertIn(req, schema["properties"], f"{t.name}: required '{req}' is not a property")
            for prop in schema["properties"].values():
                self.assertNotIsInstance(prop.get("type"), list, f"{t.name}: union types break some providers")

    def test_command_risk(self):
        for safe in ("Comfy.Canvas.FitView", "Comfy.NewBlankWorkflow", "Workspace.ToggleSidebarTab.node-library",
                     "Comfy.QueuePrompt", "Comfy.Undo", "Comfy.Manager.CustomNodesManager.ShowCustomNodesMenu",
                     "Comfy.Canvas.ToggleSelectedNodes.Bypass"):
            self.assertEqual(ui.command_risk({"id": safe}), "edit", safe)
        for risky in ("Comfy.ClearWorkflow", "Workspace.CloseWorkflow", "Comfy.SaveWorkflow", "Comfy.ExportWorkflow",
                      "SomePack.DeleteEverything", "", "Comfy.Canvas.FitView; rm -rf"):
            self.assertEqual(ui.command_risk({"id": risky}), "risky", risky)
        self.assertEqual(ui.tabs_risk({"action": "list"}), "read")
        self.assertEqual(ui.tabs_risk({"action": "new"}), "edit")
        self.assertEqual(ui.tabs_risk({"action": "close"}), "risky")
        self.assertEqual(ui.tabs_risk({}), "read")
        self.assertEqual(ui.tabs_risk({"action": "list_templates"}), "read")
        self.assertEqual(ui.tabs_risk({"action": "open_template"}), "edit")

    def test_menu_settings_and_run_risk(self):
        self.assertEqual(ui.menu_risk({"target": "node", "node_id": 3}), "read")
        self.assertEqual(ui.menu_risk({"action": "list", "path": ["Mode"]}), "read")
        self.assertEqual(ui.menu_risk({"action": "invoke", "path": ["Mode", "Never"]}), "edit")
        self.assertEqual(ui.settings_risk({"query": "link"}), "read")
        self.assertEqual(ui.settings_risk({"id": "Comfy.LinkRenderMode"}), "read")
        self.assertEqual(ui.settings_risk({"action": "get", "id": "x", "value": 1}), "read")
        self.assertEqual(ui.settings_risk({"id": "Comfy.LinkRenderMode", "value": 0}), "risky")
        self.assertEqual(ui.settings_risk({"action": "set", "id": "x", "value": 1}), "risky")
        self.assertEqual(ui.settings_risk({"action": "wipe"}), "risky")  # unknown action: careful
        reg = registry.get
        self.assertEqual(reg("queue_prompt").risk, "edit")  # the user can stop it; never silent in read-only
        self.assertEqual(reg("wait_for_execution").risk_of({}), "read")
        self.assertEqual(reg("subgraph").risk_of({"action": "enter", "node_id": 3}), "read")  # a view change
        self.assertEqual(reg("load_workflow").risk, "edit")  # opens a new tab, nothing is replaced
        self.assertEqual(reg("auto_layout").risk, "edit")
        for long_runner in ("queue_prompt", "wait_for_execution"):
            self.assertGreaterEqual(reg(long_runner).timeout, 900)

    def test_settings_change_asks_even_once_allowed_for_another_value(self):
        async def go():
            bridge.set_send_hook(lambda cid, p: asyncio.get_running_loop().call_soon(
                bridge.resolve, p["rid"], True, "ok"))
            session = sessions.Session()
            ctx = registry.ToolContext(session, "c1", {"permission_mode": "confirm"})
            self.assertTrue((await registry.dispatch(ctx, "settings", {"query": "link"}))[0])
            self.assertEqual([i for i in session.items if i["kind"] == "permission"], [])
            for n, value in enumerate((0, 1), start=1):  # the grant is per exact call, not per tool
                task = asyncio.ensure_future(registry.dispatch(
                    ctx, "settings", {"action": "set", "id": "Comfy.LinkRenderMode", "value": value}))
                await asyncio.sleep(0.01)
                cards = [i for i in session.items if i["kind"] == "permission"]
                self.assertEqual(len(cards), n)
                pending.answer(cards[-1]["request_id"], {"decision": "allow_session"})
                self.assertTrue((await task)[0])
            ro = registry.ToolContext(sessions.Session(), "c1", {"permission_mode": "readonly"})
            self.assertFalse((await registry.dispatch(ro, "queue_prompt", {}))[0])
            self.assertFalse((await registry.dispatch(ro, "context_menu", {"action": "invoke", "path": ["Remove"]}))[0])
            self.assertTrue((await registry.dispatch(ro, "context_menu", {"target": "canvas"}))[0])
            self.assertTrue((await registry.dispatch(ro, "subgraph", {"action": "list"}))[0])
        run(go())

    def test_per_call_risk_drives_permissions_and_grants_are_per_command(self):
        async def go():
            bridge.set_send_hook(lambda cid, p: asyncio.get_running_loop().call_soon(
                bridge.resolve, p["rid"], True, "ran"))
            session = sessions.Session()
            ctx = registry.ToolContext(session, "c1", {"permission_mode": "confirm"})
            # safe command: no card
            ok, _ = await registry.dispatch(ctx, "run_command", {"id": "Comfy.Canvas.FitView"})
            cards = [i for i in session.items if i["kind"] == "permission"]
            self.assertTrue(ok)
            self.assertEqual(cards, [])
            # risky command: card, "allow for this chat"
            task = asyncio.ensure_future(registry.dispatch(ctx, "run_command", {"id": "Comfy.ClearWorkflow"}))
            await asyncio.sleep(0.01)
            card = [i for i in session.items if i["kind"] == "permission"][0]
            pending.answer(card["request_id"], {"decision": "allow_session"})
            self.assertTrue((await task)[0])
            # same command again: no new card; a different risky command: new card
            await registry.dispatch(ctx, "run_command", {"id": "Comfy.ClearWorkflow"})
            self.assertEqual(len([i for i in session.items if i["kind"] == "permission"]), 1)
            task = asyncio.ensure_future(registry.dispatch(ctx, "run_command", {"id": "Workspace.CloseWorkflow"}))
            await asyncio.sleep(0.01)
            cards = [i for i in session.items if i["kind"] == "permission"]
            self.assertEqual(len(cards), 2)
            pending.answer(cards[1]["request_id"], {"decision": "deny"})
            self.assertFalse((await task)[0])
            # read-only mode blocks even "safe" commands, but not listing tabs
            ro = registry.ToolContext(sessions.Session(), "c1", {"permission_mode": "readonly"})
            self.assertFalse((await registry.dispatch(ro, "run_command", {"id": "Comfy.Canvas.FitView"}))[0])
            self.assertTrue((await registry.dispatch(ro, "workflow_tabs", {"action": "list"}))[0])
        run(go())

    def test_result_caps(self):
        self.assertEqual(registry.get("get_workflow").max_chars, 48000)
        self.assertEqual(registry.get("add_node").max_chars, registry.MAX_RESULT_CHARS)
        self.assertTrue(registry._to_text("x" * 50000, 48000).startswith("x" * 48000))
        self.assertIn("truncated 2000", registry._to_text("x" * 50000, 48000))


if __name__ == "__main__":
    unittest.main()
