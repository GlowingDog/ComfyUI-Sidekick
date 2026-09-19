"""Run: python_embeded\\python.exe -m unittest discover -s tests/py -t . (from the project root)"""
import asyncio
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import bridge, config, mcp_server, paths, pending, registry, sessions  # noqa: E402
from sidekick.agent.cli_claude import ClaudeEventMapper, build_argv  # noqa: E402
from sidekick.backend import node_catalog  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
EVENTS = []
sessions.set_emit_hook(EVENTS.append)

INFO = {
    "KSampler": {"display_name": "KSampler", "category": "sampling", "python_module": "nodes",
                 "input": {"required": {
                     "model": ["MODEL", {}], "seed": ["INT", {"default": 0, "min": 0}],
                     "cfg": ["FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0}],
                     "scheduler": [["normal", "karras"] + [f"s{i}" for i in range(20)], {}],
                     "latent_image": ["LATENT", {}]}},
                 "output": ["LATENT"], "output_name": ["LATENT"]},
    "VAEDecode": {"display_name": "VAE Decode", "category": "latent", "python_module": "nodes",
                  "input": {"required": {"samples": ["LATENT", {}], "vae": ["VAE", {}]}},
                  "output": ["IMAGE"], "output_name": ["IMAGE"]},
    "FancyUpscale": {"display_name": "Fancy", "category": "image/upscale",
                     "python_module": "custom_nodes.fancy-pack",
                     "input": {"required": {"image": ["IMAGE", {}],
                                            "mode": ["COMBO", {"options": ["a", "b"]}]}},
                     "output": ["IMAGE"], "output_name": ["IMAGE"]},
}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class CatalogTests(unittest.TestCase):
    def test_search_and_filters(self):
        self.assertTrue(node_catalog.search(INFO, "ksampler").startswith("KSampler |"))
        out = node_catalog.search(INFO, "", output_type="image")
        self.assertIn("VAEDecode", out)
        self.assertNotIn("KSampler", out)
        self.assertIn("fancy-pack", node_catalog.search(INFO, "upscale"))
        self.assertIn("No node types", node_catalog.search(INFO, "zzzz"))

    def test_describe_truncates_combos(self):
        d = node_catalog.describe(INFO, "KSampler")
        by = {i["name"]: i for i in d["inputs"]}
        self.assertFalse(by["model"]["widget"])
        self.assertTrue(by["cfg"]["widget"])
        self.assertEqual(by["scheduler"]["type"], "COMBO")
        self.assertEqual(len(by["scheduler"]["options"]), node_catalog.MAX_OPTIONS)
        self.assertEqual(by["scheduler"]["options_total"], 22)
        with self.assertRaises(registry.ToolError):
            node_catalog.describe(INFO, "Nope")

    def test_combo_options(self):
        r = node_catalog.combo_options(INFO, "KSampler", "scheduler", "karr")
        self.assertEqual(r["options"], ["karras"])
        self.assertEqual(node_catalog.combo_options(INFO, "FancyUpscale", "mode")["total_matching"], 2)


class EventTests(unittest.TestCase):
    def test_events_are_snapshots_not_live_references(self):
        """ComfyUI serializes websocket messages later, from its publish loop. An "item_add" that
        still pointed at the live item already contained the first streamed chunk, which then
        arrived again as a delta: replies began "II can't…" (user report, 2026-09-18)."""
        sent = []
        sessions.set_emit_hook(sent.append)  # keeps the payload objects, like ComfyUI's message queue
        try:
            s = sessions.Session()
            item = s.add_item("assistant", text="", questions=[{"q": 1}])
            s.append_text(item, "I")  # same tick, before anything was serialized
            s.append_text(item, " can't")
            item["questions"].append({"q": 2})
            replay = ""
            for ev in sent:  # what the browser does with what it receives
                if ev["type"] == "item_add":
                    replay = ev["item"]["text"]
                    self.assertEqual(ev["item"]["questions"], [{"q": 1}])
                elif ev["type"] == "text_delta":
                    replay += ev["delta"]
            self.assertEqual(replay, "I can't")
            self.assertEqual([ev["seq"] for ev in sent], [1, 2, 3])
        finally:
            sessions.set_emit_hook(lambda payload: None)

    def test_config_merges_nested_secrets(self):
        cfg = config.merge_update(config.load(), {"tokens": {"huggingface": "hf_abcdefgh1234"}, "search": {"backend": "brave", "brave_key": "BSA-99998888"}, "web_tools": False})
        self.assertEqual((cfg["tokens"]["huggingface"], cfg["search"]["backend"], cfg["web_tools"]), ("hf_abcdefgh1234", "brave", False))
        m = config.masked(cfg)
        self.assertEqual((m["tokens"]["huggingface"], m["tokens"]["huggingface_hint"], m["search"]["brave_key"], m["search"]["brave_key_set"]), ("", "…1234", "", True))
        kept = config.merge_update(cfg, {"tokens": m["tokens"], "search": {"searxng_url": "http://localhost:8080"}})
        self.assertEqual((kept["tokens"]["huggingface"], kept["search"]["brave_key"], kept["search"]["searxng_url"]), ("hf_abcdefgh1234", "BSA-99998888", "http://localhost:8080"))
        self.assertEqual(config.merge_update(kept, {"tokens": {"huggingface_clear": True}})["tokens"]["huggingface"], "")


class ConfigTests(unittest.TestCase):
    def test_secrets_masked_and_preserved(self):
        cfg = config.load()
        cfg = config.merge_update(cfg, {"providers": [dict(cfg["providers"][2], api_key="sk-12345678")]})
        m = config.masked(cfg)
        self.assertEqual(m["providers"][0]["api_key"], "")
        self.assertTrue(m["providers"][0]["api_key_set"])
        self.assertEqual(m["providers"][0]["api_key_hint"], "…5678")
        again = config.merge_update(cfg, {"providers": m["providers"], "permission_mode": "auto"})
        self.assertEqual(again["providers"][0]["api_key"], "sk-12345678")
        self.assertEqual(again["permission_mode"], "auto")


class McpTests(unittest.TestCase):
    def test_protocol(self):
        async def call_tool(name, args):
            return name == "ok", "text:" + name

        def rpc(msg):
            return run(mcp_server.handle_payload(msg, lambda: [{"name": "ok"}], call_tool))
        init = rpc({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                    "params": {"protocolVersion": "2025-11-25"}})
        self.assertEqual(init["result"]["protocolVersion"], "2025-11-25")
        self.assertIsNone(rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertEqual(rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"],
                         [{"name": "ok"}])
        good = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "ok"}})
        self.assertFalse(good["result"]["isError"])
        bad = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "no"}})
        self.assertTrue(bad["result"]["isError"])
        self.assertEqual(rpc({"jsonrpc": "2.0", "id": 4, "method": "server/discover"})["error"]["code"],
                         -32601)

    def test_tokens(self):
        t = mcp_server.issue_token({"x": 1})
        self.assertEqual(mcp_server.binding_for("Bearer " + t), {"x": 1})
        mcp_server.revoke_token(t)
        self.assertIsNone(mcp_server.binding_for("Bearer " + t))
        self.assertIsNone(mcp_server.binding_for(None))


class DispatchTests(unittest.TestCase):
    def setUp(self):
        registry._tools.clear()

        async def echo(ctx, a):
            return {"echo": a.get("v")}
        registry.register(registry.Tool("echo", "d", {"v": {}}, ["v"], side="backend", handler=echo))
        registry.register(registry.Tool("danger", "d", {}, side="backend", handler=echo, risk="risky"))
        registry.register(registry.Tool("front", "d", {}, risk="edit"))

    def ctx(self, mode="confirm"):
        return registry.ToolContext(sessions.Session(), "client1", {"permission_mode": mode})

    def test_backend_and_validation(self):
        ctx = self.ctx()
        self.assertEqual(run(registry.dispatch(ctx, "echo", {"v": 3})), (True, '{"echo":3}'))
        self.assertFalse(run(registry.dispatch(ctx, "echo", {}))[0])
        self.assertFalse(run(registry.dispatch(ctx, "nope", {}))[0])
        self.assertEqual(run(registry.dispatch(ctx, "echo", '{"v": 1}'))[0], True)
        self.assertEqual(ctx.session.items[0]["status"], "ok")

    def test_readonly_blocks_edits(self):
        ok, text = run(registry.dispatch(self.ctx("readonly"), "front", {}))
        self.assertFalse(ok)
        self.assertIn("read-only", text)

    def test_frontend_roundtrip(self):
        async def go():
            bridge.set_send_hook(lambda cid, p: asyncio.get_running_loop().call_soon(
                bridge.resolve, p["rid"], True, {"client": cid, "tool": p["tool"]}))
            return await registry.dispatch(self.ctx(), "front", {})
        ok, text = run(go())
        self.assertTrue(ok)
        self.assertIn('"client":"client1"', text)

    def test_permission_flow(self):
        async def go(decision):
            ctx = self.ctx()
            task = asyncio.ensure_future(registry.dispatch(ctx, "danger", {}))
            await asyncio.sleep(0.01)
            item = [i for i in ctx.session.items if i["kind"] == "permission"][0]
            pending.answer(item["request_id"], {"decision": decision})
            return await task
        self.assertTrue(run(go("allow"))[0])
        ok, text = run(go("deny"))
        self.assertFalse(ok)
        self.assertIn("Denied", text)


class ClaudeMapperTests(unittest.TestCase):
    def test_fixture_replay(self):
        s = sessions.Session()
        m = ClaudeEventMapper(s)
        with open(os.path.join(ROOT, "tests", "fixtures", "claude_basic.jsonl"), encoding="utf-8") as f:
            for line in f:
                m.feed(line)
        texts = [i["text"] for i in s.items if i["kind"] == "assistant"]
        self.assertEqual(texts, ["The cfg value in your workflow is 8."])
        self.assertTrue(s.cli["claude_cli"])
        self.assertFalse([i for i in s.items if i["kind"] in ("tool", "error")])
        self.assertGreater(m.usage()["output_tokens"], 0)

    def test_argv(self):
        argv = build_argv(["claude"], "m.json", "s.txt", "haiku", "abc")
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--resume") + 1], "abc")
        self.assertNotIn("--dangerously-skip-permissions", argv)


if __name__ == "__main__":
    unittest.main()
