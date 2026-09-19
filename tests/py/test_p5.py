"""Plan card, history compaction, and the gates around ui_act / execute_js."""
import asyncio
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import bridge, paths, pending, registry, sessions, tooldefs  # noqa: E402
from sidekick.agent import loop_openai  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
sessions.set_emit_hook(lambda payload: None)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def fresh_registry():
    registry._tools.clear()
    tooldefs._done = False
    tooldefs.register_all()


class TodoTests(unittest.TestCase):
    def test_one_plan_card_per_turn_updated_in_place(self):
        async def go():
            fresh_registry()
            s = sessions.Session()
            ctx = registry.ToolContext(s, "c1", {"permission_mode": "confirm"})
            s.add_item("user", text="build it")
            ok, text = await registry.dispatch(ctx, "update_todos", {"todos": [
                {"text": "add  nodes", "status": "in_progress"}, {"text": "connect", "status": "pending"}, "run it"]})
            self.assertTrue(ok)
            self.assertEqual(text, "todo list shown to the user: 0/3 done; in progress: add nodes")
            ok, text = await registry.dispatch(ctx, "update_todos", {"todos": [
                {"text": "add nodes", "status": "completed"}, {"text": "connect", "status": "In Progress"}, {"text": "run it", "status": "pending"}]})
            self.assertIn("1/3 done; in progress: connect", text)
            cards = [i for i in s.items if i["kind"] == "todos"]
            self.assertEqual(len(cards), 1, "the same card is updated")
            self.assertEqual([t["status"] for t in cards[0]["todos"]], ["done", "in_progress", "pending"])
            self.assertEqual([i["kind"] for i in s.items], ["user", "todos"], "no tool card: the plan card is the UI")
            s.add_item("user", text="now something else")
            await registry.dispatch(ctx, "update_todos", {"todos": [{"text": "other", "status": "pending"}]})
            self.assertEqual(len([i for i in s.items if i["kind"] == "todos"]), 2, "a new request gets a new card")
            for bad in ({"todos": []}, {"todos": "x"}, {"todos": [{"text": "", "status": "done"}]}, {"todos": [{"text": "a", "status": "later"}]}):
                self.assertFalse((await registry.dispatch(ctx, "update_todos", bad))[0], bad)
        run(go())


class CompactionTests(unittest.TestCase):
    def build(self, sizes):
        msgs = [{"role": "user", "content": "please tidy my graph"}]
        for i, n in enumerate(sizes):
            msgs.append({"role": "assistant", "content": None, "tool_calls": [{"id": f"c{i}", "type": "function", "function": {"name": "get_workflow", "arguments": "{}"}}]})
            msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"result {i} " + "x" * n})
        return msgs

    def test_small_histories_are_left_alone(self):
        msgs = self.build([5000] * 10)
        before = json.dumps(msgs)
        self.assertEqual(loop_openai.compact_history(msgs), 0)
        self.assertEqual(json.dumps(msgs), before)

    def test_one_sweep_then_a_stable_prefix(self):
        msgs = self.build([15000] * 10)  # ~150k chars
        cut = loop_openai.compact_history(msgs)
        self.assertEqual(cut, 4, "everything older than the newest six, in one go")
        tools = [m for m in msgs if m["role"] == "tool"]
        self.assertTrue(all(len(m["content"]) < 600 for m in tools[:4]))
        self.assertTrue(all(len(m["content"]) > 15000 for m in tools[4:]))
        self.assertTrue(tools[0]["content"].startswith("result 0 xxx"))
        self.assertIn("call the tool again", tools[0]["content"])
        self.assertEqual([m["role"] for m in msgs], ["user"] + ["assistant", "tool"] * 10, "order and pairing untouched")
        self.assertEqual([m["tool_call_id"] for m in tools], [f"c{i}" for i in range(10)])
        frozen = json.dumps(msgs[:9])
        self.assertEqual(loop_openai.compact_history(msgs), 0, "nothing more to cut: providers keep hitting their prefix cache")
        self.assertEqual(json.dumps(msgs[:9]), frozen)

    def test_giant_recent_results_keep_only_two(self):
        msgs = self.build([45000] * 8)  # the newest six alone are 270k
        loop_openai.compact_history(msgs)
        tools = [m for m in msgs if m["role"] == "tool"]
        self.assertEqual([len(m["content"]) > 40000 for m in tools], [False] * 6 + [True] * 2)
        self.assertEqual(loop_openai.compact_history(msgs), 0)

    def test_screenshots_and_non_text_are_ignored(self):
        msgs = self.build([60000] * 3) + [{"role": "user", "content": [{"type": "text", "text": "t"}, {"type": "image_url", "image_url": {"url": "data:..."}}]}]
        loop_openai.compact_history(msgs, keep_recent=1)
        self.assertIsInstance(msgs[-1]["content"], list)


class GateTests(unittest.TestCase):
    def setUp(self):
        fresh_registry()
        bridge.set_send_hook(lambda cid, p: asyncio.get_event_loop().call_soon(bridge.resolve, p["rid"], True, "done"))

    def test_execute_js_is_off_hidden_and_per_script(self):
        async def go():
            bridge.set_send_hook(lambda cid, p: asyncio.get_running_loop().call_soon(bridge.resolve, p["rid"], True, "2"))
            names = lambda cfg: {t.name for t in registry.all_tools("openai", cfg)}  # noqa: E731
            self.assertNotIn("execute_js", names({}))
            self.assertIn("execute_js", names({"allow_execute_js": True}))
            s = sessions.Session()
            off = registry.ToolContext(s, "c1", {"permission_mode": "auto"})
            ok, text = await registry.dispatch(off, "execute_js", {"code": "return 1"})
            self.assertFalse(ok, "guessing the hidden tool's name does not help, not even in auto mode")
            self.assertIn("switched off", text)
            on = registry.ToolContext(s, "c1", {"permission_mode": "confirm", "allow_execute_js": True})
            for n, code in enumerate(("return 1 + 1", "return document.cookie"), start=1):
                task = asyncio.ensure_future(registry.dispatch(on, "execute_js", {"code": code}))
                await asyncio.sleep(0.01)
                cards = [i for i in s.items if i["kind"] == "permission"]
                self.assertEqual(len(cards), n, "every script gets its own card, even after 'allow for this chat'")
                self.assertEqual(cards[-1]["args"]["code"], code)
                self.assertIn("Read it", cards[-1]["note"])
                pending.answer(cards[-1]["request_id"], {"decision": "allow_session"})
                self.assertTrue((await task)[0])
        run(go())

    def test_ui_act_asks_once_per_chat_and_snapshot_never(self):
        async def go():
            bridge.set_send_hook(lambda cid, p: asyncio.get_running_loop().call_soon(bridge.resolve, p["rid"], True, "clicked"))
            s = sessions.Session()
            ctx = registry.ToolContext(s, "c1", {"permission_mode": "confirm"})
            self.assertTrue((await registry.dispatch(ctx, "ui_snapshot", {}))[0])
            self.assertEqual([i for i in s.items if i["kind"] == "permission"], [])
            task = asyncio.ensure_future(registry.dispatch(ctx, "ui_act", {"action": "click", "text": "Install"}))
            await asyncio.sleep(0.01)
            card = [i for i in s.items if i["kind"] == "permission"][0]
            self.assertIn("click, type and press keys", card["note"])
            pending.answer(card["request_id"], {"decision": "allow_session"})
            self.assertTrue((await task)[0])
            self.assertTrue((await registry.dispatch(ctx, "ui_act", {"action": "key", "key": "Escape"}))[0])
            self.assertEqual(len([i for i in s.items if i["kind"] == "permission"]), 1, "one grant covers the chat")
            ro = registry.ToolContext(sessions.Session(), "c1", {"permission_mode": "readonly"})
            self.assertFalse((await registry.dispatch(ro, "ui_act", {"action": "click", "text": "x"}))[0])
            self.assertTrue((await registry.dispatch(ro, "ui_snapshot", {}))[0])
        run(go())

    def test_tool_budget(self):
        everything = registry.all_tools(cfg={"allow_execute_js": True})
        self.assertLess(len(everything), 45, "Codex drops oversized MCP servers")
        self.assertEqual(len(everything), 40)


if __name__ == "__main__":
    unittest.main()
