"""OpenAI-compatible loop against a local mock SSE server (no API key, no tokens)."""
import asyncio
import json
import os
import sys
import tempfile
import unittest

from aiohttp import web

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import paths, registry, sessions  # noqa: E402
from sidekick.agent import loop_openai  # noqa: E402
from sidekick.agent.loop_openai import StreamAccumulator, TRIMMED, trim_messages  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
sessions.set_emit_hook(lambda payload: None)


def sse(*chunks):
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


TURN_1 = sse(
    {"choices": [{"delta": {"role": "assistant", "reasoning_content": "thinking…"}}]},
    {"choices": [{"delta": {"content": "Let me "}}]},
    {"choices": [{"delta": {"content": "check."}}]},
    {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_a", "function": {"name": "echo", "arguments": "{\"v\""}}]}}]},
    {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ": 42}"}}]}, "finish_reason": "tool_calls"}]},
    {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 10}},
)
TURN_2 = ": keep-alive comment\n\n" + sse(
    {"choices": [{"delta": {"content": "The value is 42."}, "finish_reason": "stop"}]},
    {"choices": [], "usage": {"prompt_tokens": 150, "completion_tokens": 6}},
)


class LoopTests(unittest.TestCase):
    def test_accumulator_and_trim(self):
        acc = StreamAccumulator()
        for line in TURN_1.split("\n\n"):
            if line.startswith("data: {"):
                acc.feed(json.loads(line[6:]))
        msg = acc.message()
        self.assertEqual(msg["content"], "Let me check.")
        self.assertEqual(msg["tool_calls"][0]["function"], {"name": "echo", "arguments": '{"v": 42}'})
        with self.assertRaises(RuntimeError):
            acc.feed({"error": {"message": "rate limited"}})

        msgs = [{"role": "user", "content": "hi"}, {"role": "tool", "tool_call_id": "1", "content": "x" * 500},
                {"role": "tool", "tool_call_id": "2", "content": "y" * 500}]
        out = trim_messages(msgs, budget=700)
        self.assertEqual([m["content"] == TRIMMED for m in out], [False, True, False])
        self.assertEqual(len(msgs[1]["content"]), 500)  # input untouched

    def test_full_loop_against_mock_server(self):
        requests = []

        async def completions(request):
            body = await request.json()
            requests.append({"auth": request.headers.get("Authorization"), "body": body})
            if len(requests) == 1:  # provider that rejects stream_options
                return web.json_response({"error": {"message": "unknown field stream_options"}}, status=400)
            return web.Response(text=TURN_1 if len(requests) == 2 else TURN_2, content_type="text/event-stream")

        async def go():
            registry._tools.clear()

            async def echo(ctx, a):
                return {"echo": a["v"]}
            registry.register(registry.Tool("echo", "Echo v.", {"v": {}}, ["v"], side="backend", handler=echo))

            app = web.Application()
            app.router.add_post("/v1/chat/completions", completions)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            try:
                session = sessions.Session()
                session.add_item("user", text="what is v?")
                provider = {"name": "mock", "base_url": f"http://127.0.0.1:{port}/v1/", "api_key": "sk-test"}
                usage = await loop_openai.run(session, "client", "what is v?", provider, "mock-model",
                                              {"permission_mode": "confirm"})
                return session, usage
            finally:
                await runner.cleanup()

        session, usage = asyncio.new_event_loop().run_until_complete(go())
        self.assertEqual(len(requests), 3)
        self.assertEqual(requests[0]["auth"], "Bearer sk-test")
        self.assertIn("stream_options", requests[0]["body"])
        self.assertNotIn("stream_options", requests[1]["body"])
        self.assertEqual(requests[1]["body"]["messages"][0]["role"], "system")
        self.assertEqual(requests[1]["body"]["tools"][0]["function"]["name"], "echo")
        # second model call carries the assistant tool_call and the tool result
        roles = [m["role"] for m in requests[2]["body"]["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant", "tool"])
        self.assertEqual(requests[2]["body"]["messages"][3]["content"], '{"echo":42}')
        kinds = [(i["kind"], i.get("text") or i.get("name")) for i in session.items]
        self.assertEqual(kinds, [("user", "what is v?"), ("assistant", "Let me check."), ("tool", "echo"),
                                 ("assistant", "The value is 42.")])
        self.assertEqual(session.items[1]["reasoning"], "thinking…")
        self.assertEqual(usage, {"input_tokens": 250, "output_tokens": 16})


if __name__ == "__main__":
    unittest.main()
