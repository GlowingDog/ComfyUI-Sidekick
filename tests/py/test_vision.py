"""Screenshots: tool result -> images for MCP brains and for OpenAI-compatible brains,
text-only fallback, history hygiene, consent."""
import asyncio
import json
import os
import sys
import tempfile
import unittest

from aiohttp import web

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import bridge, mcp_server, paths, pending, registry, sessions  # noqa: E402
from sidekick.agent import loop_openai  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
sessions.set_emit_hook(lambda payload: None)

PIXELS = "aGVsbG8="  # any base64
SHOT = {"__images__": [{"mime": "image/jpeg", "data": PIXELS}], "text": "screenshot of group #1",
        "thumb": "data:image/jpeg;base64,AAAA"}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def sse(*chunks):
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


CALL_SHOT = sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {
    "name": "screenshot", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}]})
DONE = sse({"choices": [{"delta": {"content": "Looks tidy."}, "finish_reason": "stop"}]})


def register_tools():
    registry._tools.clear()

    async def shot(ctx, a):
        return dict(SHOT)
    registry.register(registry.Tool("screenshot", "look", {}, side="backend", handler=shot, confirm=True,
                                    confirm_note="Screenshots are sent to the AI provider."))


class VisionTests(unittest.TestCase):
    def setUp(self):
        register_tools()
        loop_openai._no_vision.clear()

    def ctx(self, mode="auto"):
        return registry.ToolContext(sessions.Session(), "c1", {"permission_mode": mode})

    def test_dispatch_separates_pixels_from_text_and_keeps_a_thumb_for_the_user(self):
        ctx = self.ctx()
        ok, text, images = run(registry.dispatch_full(ctx, "screenshot", {}))
        self.assertTrue(ok)
        self.assertEqual(text, "screenshot of group #1")
        self.assertEqual(images, [{"mime": "image/jpeg", "data": PIXELS}])
        self.assertNotIn(PIXELS, text)
        self.assertEqual(ctx.session.items[0]["thumb"], SHOT["thumb"])
        self.assertEqual(run(registry.dispatch(ctx, "screenshot", {})), (True, "screenshot of group #1"))

    def test_bad_image_payloads_are_dropped(self):
        for bad in ({"mime": "text/html", "data": PIXELS}, {"mime": "image/png", "data": ""},
                    {"mime": "image/png", "data": "x" * (registry.MAX_IMAGE_B64 + 1)}, "nope"):
            _, images, _ = registry._split_images({"__images__": [bad], "text": "t"})
            self.assertEqual(images, [])
        _, _, thumb = registry._split_images({"__images__": [], "thumb": "javascript:alert(1)"})
        self.assertIsNone(thumb)

    def test_consent_card_even_in_read_only_mode(self):
        async def go(mode):
            ctx = self.ctx(mode)
            task = asyncio.ensure_future(registry.dispatch_full(ctx, "screenshot", {}))
            await asyncio.sleep(0.01)
            cards = [i for i in ctx.session.items if i["kind"] == "permission"]
            self.assertEqual(len(cards), 1, mode)
            self.assertIn("sent to the AI provider", cards[0]["note"])
            pending.answer(cards[0]["request_id"], {"decision": "allow_session"})
            ok, _, images = await task
            # granted for this chat: no second card
            await registry.dispatch_full(ctx, "screenshot", {})
            self.assertEqual(len([i for i in ctx.session.items if i["kind"] == "permission"]), 1)
            return ok, images
        for mode in ("confirm", "readonly"):  # looking is not editing: read-only must not block it
            ok, images = run(go(mode))
            self.assertTrue(ok and images)

    def test_mcp_result_carries_an_image_block(self):
        async def call_tool(name, args):
            return await registry.dispatch_full(self.ctx(), name, args)
        resp = run(mcp_server.handle_payload({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                              "params": {"name": "screenshot", "arguments": {}}},
                                             lambda: [], call_tool))
        content = resp["result"]["content"]
        self.assertEqual(content[0], {"type": "text", "text": "screenshot of group #1"})
        self.assertEqual(content[1], {"type": "image", "data": PIXELS, "mimeType": "image/jpeg"})

    def _serve(self, handler):
        async def go():
            app = web.Application()
            app.router.add_post("/v1/chat/completions", handler)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                session = sessions.Session()
                session.add_item("user", text="is it tidy?")
                await loop_openai.run(session, "c", "is it tidy?", {"name": "mock", "base_url": f"http://127.0.0.1:{port}/v1"},
                                      "m", {"permission_mode": "auto"})
                return session
            finally:
                await runner.cleanup()
        return run(go())

    def test_openai_loop_sends_pixels_in_a_user_message_after_the_tool_result(self):
        bodies = []

        async def handler(request):
            bodies.append(await request.json())
            return web.Response(text=CALL_SHOT if len(bodies) == 1 else DONE, content_type="text/event-stream")
        session = self._serve(handler)
        msgs = bodies[1]["messages"]
        self.assertEqual([m["role"] for m in msgs], ["system", "user", "assistant", "tool", "user"])
        self.assertEqual(msgs[3]["content"], "screenshot of group #1")
        self.assertEqual(msgs[4]["content"][1]["image_url"]["url"], "data:image/jpeg;base64," + PIXELS)
        # nothing with pixels is written to disk
        session.save()
        with open(os.path.join(paths.sub_dir("sessions"), session.id + ".json"), encoding="utf-8") as f:
            saved = f.read()
        self.assertNotIn(PIXELS, saved.replace(SHOT["thumb"], ""))
        self.assertIn("screenshot not kept", saved)

    def test_text_only_model_falls_back_and_is_remembered(self):
        bodies = []

        async def handler(request):
            body = await request.json()
            bodies.append(body)
            if any(loop_openai.has_images(m) for m in body["messages"]):
                return web.json_response({"error": {"message": "image input not supported"}}, status=400)
            return web.Response(text=CALL_SHOT if len(bodies) == 1 else DONE, content_type="text/event-stream")
        session = self._serve(handler)
        self.assertEqual(len(bodies), 3)  # call, rejected with pixels, retried without
        self.assertFalse(any(loop_openai.has_images(m) for m in bodies[2]["messages"]))
        self.assertIn("did not accept images", bodies[2]["messages"][-1]["content"])
        self.assertEqual(session.items[-1]["text"], "Looks tidy.")
        self.assertEqual(len(loop_openai._no_vision), 1)

    def test_only_the_newest_screenshots_keep_their_pixels(self):
        msgs = [loop_openai.image_message([{"mime": "image/jpeg", "data": str(i)}]) for i in range(4)]
        loop_openai.strip_old_images(msgs, keep=2)
        self.assertEqual([loop_openai.has_images(m) for m in msgs], [False, False, True, True])
        self.assertEqual(msgs[0]["content"], loop_openai.IMAGE_GONE)
        self.assertEqual(loop_openai.trim_messages(msgs), msgs)  # multimodal content does not crash sizing


if __name__ == "__main__":
    unittest.main()
