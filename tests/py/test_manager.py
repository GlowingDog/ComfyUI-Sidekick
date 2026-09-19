"""Manager client against a mock ComfyUI-Manager (same routes and status codes as V3.40),
plus restart booking / resume."""
import asyncio
import os
import sys
import tempfile
import time
import unittest

from aiohttp import web as aioweb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import paths, registry, sessions  # noqa: E402
from sidekick.agent import runner  # noqa: E402
from sidekick.backend import loopback, manager, restart  # noqa: E402
from sidekick.registry import ToolError  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
sessions.set_emit_hook(lambda payload: None)

PACKS = {
    "comfyui-impact-pack": {"id": "comfyui-impact-pack", "title": "ComfyUI Impact Pack", "author": "Dr.Lt.Data", "stars": 3311,
                            "description": "Detector and detailer nodes that enhance facial details.", "state": "enabled",
                            "repository": "https://github.com/ltdrdata/ComfyUI-Impact-Pack", "files": ["https://github.com/ltdrdata/ComfyUI-Impact-Pack"],
                            "version": "8.28.3", "active_version": "8.28.3", "cnr_latest": "8.28.3", "trust": True},
    "rgthree-comfy": {"id": "rgthree-comfy", "title": "rgthree's ComfyUI Nodes", "author": "rgthree", "stars": 2500,
                      "description": "Seed, reroute, context, power lora loader.", "state": "not-installed",
                      "repository": "https://github.com/rgthree/rgthree-comfy", "files": ["https://github.com/rgthree/rgthree-comfy"],
                      "version": "1.0.0", "cnr_latest": "1.0.0"},
    "face-tools": {"id": "face-tools", "title": "Face Tools", "author": "someone", "stars": 12, "description": "facial helpers",
                   "state": "disabled", "repository": "https://github.com/someone/face-tools", "files": [], "version": "0.1"},
    "158997": {"id": "img2halftone", "title": "Image2Halftone", "author": "aimingfail", "stars": -1, "description": "halftone dots",
               "state": "not-installed", "repository": "https://example.org/dl/158997", "files": ["https://example.org/dl/158997"],
               "version": "unknown"},
}
MAPPINGS = {
    "comfyui-impact-pack": [["FaceDetailer", "SAMLoader"], {"title_aux": "Impact"}],
    "https://github.com/rgthree/rgthree-comfy": [["Seed (rgthree)", "Power Lora Loader (rgthree)"], {"nodename_pattern": r" \(rgthree\)$"}],
    "face-tools": [["FaceDetailer"], {}],
}


class MockManager:
    def __init__(self):
        self.installed = {"ComfyUI-Impact-Pack": {"ver": "8.28.3", "cnr_id": "comfyui-impact-pack", "aux_id": None, "enabled": True}}
        self.calls, self.busy, self.install_status, self.fail = [], False, 200, False
        self.processing_polls = 0

    async def start(self):
        app = aioweb.Application()
        app.router.add_get("/manager/version", lambda r: aioweb.Response(text="V3.40"))
        app.router.add_get("/customnode/getlist", lambda r: aioweb.json_response({"channel": "default", "node_packs": PACKS}))
        app.router.add_get("/customnode/getmappings", lambda r: aioweb.json_response(MAPPINGS))
        app.router.add_get("/customnode/installed", lambda r: aioweb.json_response(self.installed))
        app.router.add_get("/manager/queue/status", self.status)
        for name in ("reset", "start", "install", "update", "uninstall", "disable", "fix"):
            app.router.add_post(f"/manager/queue/{name}", self.queue(name))
        self.runner = aioweb.AppRunner(app)
        await self.runner.setup()
        site = aioweb.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]

    async def status(self, request):
        processing = self.busy or self.processing_polls > 0
        self.processing_polls = max(0, self.processing_polls - 1)
        return aioweb.json_response({"total_count": 1, "done_count": 0 if processing else 1, "in_progress_count": 0, "is_processing": processing})

    def queue(self, name):
        async def handler(request):
            if request.content_type != "application/json":
                return aioweb.Response(status=400, text="Invalid Content-Type")
            body = await request.json() if request.can_read_body else {}
            self.calls.append((name, body))
            if name in ("reset", "start"):
                if name == "start":
                    self.processing_polls = 2  # the worker needs a moment
                return aioweb.Response(status=200)
            if self.install_status != 200:
                return aioweb.Response(status=self.install_status, text="nope")
            for key in ("channel", "mode", "selected_version"):  # the real handler indexes these
                if name == "install" and key not in body:
                    return aioweb.Response(status=500, text=f"KeyError {key}")
            if not self.fail:
                if name == "install":
                    self.installed[body["id"]] = {"ver": "1.0.0", "cnr_id": body["id"], "aux_id": None, "enabled": True}
                elif name == "uninstall":
                    self.installed = {k: v for k, v in self.installed.items() if v["cnr_id"] != body["id"]}
                elif name == "disable":
                    for v in self.installed.values():
                        if v["cnr_id"] == body["id"]:
                            v["enabled"] = False
            return aioweb.Response(status=200)
        return handler


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class ManagerTests(unittest.TestCase):
    def with_mock(self, body):
        async def go():
            mock = MockManager()
            await mock.start()
            real = loopback.base_url
            loopback.base_url = lambda: f"http://127.0.0.1:{mock.port}"
            manager._cache.update(packs=None, packs_at=0.0, maps=None, maps_at=0.0)
            try:
                await body(mock)
            finally:
                loopback.base_url = real
                await mock.runner.cleanup()
        run(go())

    def test_search_info_and_types(self):
        async def body(mock):
            text = await manager.search("facial detail")
            self.assertIn("2 node pack(s)", text)  # face-tools only through its node name FaceDetailer
            self.assertEqual(text.split("\n")[1][:75], "comfyui-impact-pack | ComfyUI Impact Pack | Dr.Lt.Data | ★3311 | enabled 8.28.3"[:75])
            by_node = await manager.search("samloader")  # nothing in title or description: found through its node names
            self.assertIn("1 node pack(s)", by_node)
            self.assertIn("comfyui-impact-pack", by_node)
            first = lambda q: asyncio.ensure_future(manager.search(q))  # noqa: E731
            self.assertTrue((await first("facial")).split("\n")[1].startswith("comfyui-impact-pack"), "same match quality: stars decide")
            self.assertTrue((await first("fac")).split("\n")[1].startswith("face-tools"), "words in the title outrank words in the description")
            self.assertTrue((await first("face tools")).split("\n")[1].startswith("face-tools"), "an exact title wins")
            self.assertIn("No node pack matches", await manager.search("zzzz"))
            self.assertNotIn("rgthree", await manager.search("", only="installed"))
            self.assertIn("nodes (2): FaceDetailer, SAMLoader", await manager.info("ComfyUI Impact Pack"))
            self.assertEqual(manager.find_pack(PACKS, "https://github.com/rgthree/rgthree-comfy.git")[0], "rgthree-comfy")
            self.assertEqual(manager.find_pack(PACKS, "IMG2HALFTONE")[0], "158997")
            with self.assertRaises(ToolError) as cm:
                manager.find_pack(PACKS, "comfy")
            self.assertIn("Several node packs match", str(cm.exception))
            types = await manager.for_types(["FaceDetailer", "Anything (rgthree)", "NoSuchNode"])
            lines = types.split("\n")
            i = lines.index("FaceDetailer:")
            self.assertTrue(lines[i + 1].strip().startswith("comfyui-impact-pack"), "most starred provider first")
            self.assertTrue(lines[i + 2].strip().startswith("face-tools"))
            self.assertIn("rgthree-comfy", lines[lines.index("Anything (rgthree):") + 1], "URL-keyed entry + nodename_pattern")
            self.assertIn("NoSuchNode: no pack", types)
        self.with_mock(body)

    def test_install_goes_through_the_queue_and_is_verified(self):
        async def body(mock):
            text = await manager.act("install", "rgthree-comfy", poll=0.01)
            self.assertIn("installed rgthree-comfy 1.0.0", text)
            self.assertIn("restart_comfyui", text)
            names = [c[0] for c in mock.calls]
            self.assertEqual(names, ["reset", "install", "start"])
            sent = mock.calls[1][1]
            self.assertEqual((sent["id"], sent["selected_version"], sent["channel"], sent["mode"], sent["ui_id"], sent["skip_post_install"]),
                             ("rgthree-comfy", "latest", "default", "cache", "rgthree-comfy", False))
            self.assertEqual(sent["repository"], "https://github.com/rgthree/rgthree-comfy")  # the list entry travels as a whole
        self.with_mock(body)

    def test_refusals_and_failures(self):
        async def body(mock):
            for action, ref, needle in (("install", "comfyui-impact-pack", "already installed"), ("update", "rgthree-comfy", "not installed"),
                                        ("enable", "rgthree-comfy", "not disabled"), ("explode", "rgthree-comfy", "action must be")):
                with self.assertRaises(ToolError) as cm:
                    await manager.act(action, ref, poll=0.01)
                self.assertIn(needle, str(cm.exception))
            self.assertEqual(mock.calls, [], "nothing was queued for a refused action")
            mock.busy = True
            with self.assertRaises(ToolError) as cm:
                await manager.act("install", "rgthree-comfy", poll=0.01)
            self.assertIn("busy", str(cm.exception))
            mock.busy = False
            for status, needle in ((403, "security_level"), (404, "default list"), (500, "HTTP 500")):
                mock.install_status = status
                with self.assertRaises(ToolError) as cm:
                    await manager.act("install", "rgthree-comfy", poll=0.01)
                self.assertIn(needle, str(cm.exception))
            mock.install_status, mock.fail = 200, True  # queue ran, but the pack is still not there
            with self.assertRaises(ToolError) as cm:
                await manager.act("install", "rgthree-comfy", poll=0.01)
            self.assertIn("did not succeed", str(cm.exception))
        self.with_mock(body)

    def test_other_actions(self):
        async def body(mock):
            self.assertIn("disabled comfyui-impact-pack", await manager.act("disable", "comfyui-impact-pack", poll=0.01))
            PACKS["comfyui-impact-pack"]["state"] = "enabled"
            self.assertIn("uninstalled comfyui-impact-pack", await manager.act("uninstall", "comfyui-impact-pack", poll=0.01))
            sent = [c for c in mock.calls if c[0] == "install"]
            self.assertEqual(sent, [])
            text = await manager.act("install", "img2halftone", poll=0.01)  # a pack outside the registry
            body_sent = [c for c in mock.calls if c[0] == "install"][0][1]
            self.assertEqual(body_sent["selected_version"], "unknown")
            self.assertIn("installed 158997", text)
        self.with_mock(body)

    def test_no_manager(self):
        async def go():
            real = loopback.base_url
            loopback.base_url = lambda: "http://127.0.0.1:9"  # nothing listens there
            manager._cache.update(packs=None, maps=None)
            try:
                with self.assertRaises(ToolError) as cm:
                    await manager.search("x")
                self.assertIn("ComfyUI-Manager is not installed", str(cm.exception))
            finally:
                loopback.base_url = real
        run(go())


class RestartTests(unittest.TestCase):
    def test_note_is_handed_out_once_and_goes_stale(self):
        s = sessions.Session()
        restart.book(s, "  connect the   new node\nto SaveImage ", "deepseek", "deepseek-chat")
        self.assertTrue(s.restart_requested)
        again = sessions.Session(data={"id": s.id, "continuation": s.continuation})
        note = restart.take_continuation(again)
        self.assertEqual((note["note"], note["provider"], note["model"]), ("connect the new node to SaveImage", "deepseek", "deepseek-chat"))
        self.assertIsNone(restart.take_continuation(again), "second tab gets nothing")
        old = sessions.Session(data={"continuation": {"note": "x", "ts": time.time() - restart.MAX_AGE - 5}})
        self.assertIsNone(restart.take_continuation(old))
        self.assertIsNone(old.continuation, "a stale note is dropped, not kept for later")

    def test_restart_happens_after_the_turn_and_blocks_more_tools(self):
        async def go():
            performed = []

            async def fake_perform(stop_turns):
                performed.append(True)

            async def fake_provider(session, client_id, text, provider, model, cfg):
                ctx = registry.ToolContext(session, client_id, {"permission_mode": "auto"})
                ok, text1 = await registry.dispatch(ctx, "restart_comfyui", {"note": "then add the Seed node"})
                self.assertTrue(ok)
                self.assertIn("END YOUR TURN NOW", text1)
                self.assertEqual(performed, [], "not while the turn is still running")
                ok2, text2 = await registry.dispatch(ctx, "get_workflow", {})
                self.assertFalse(ok2)
                self.assertIn("about to restart", text2)
                return None

            from sidekick import tooldefs
            registry._tools.clear()
            tooldefs._done = False
            tooldefs.register_all()
            real_perform, real_run = restart.perform, runner._run_provider
            restart.perform, runner._run_provider = fake_perform, fake_provider
            try:
                s = sessions.Session()
                await runner.run_turn(s, "c1", "install rgthree", "claude_cli", "haiku")
                await asyncio.sleep(0.01)
                self.assertEqual(performed, [True])
                self.assertEqual((s.continuation["note"], s.continuation["provider"], s.continuation["model"]),
                                 ("then add the Seed node", "claude_cli", "haiku"))
                self.assertIn("Restarting ComfyUI", s.items[-1]["text"])

                async def stopped(session, client_id, text, provider, model, cfg):  # user presses Stop after the booking
                    restart.book(session, "x", "claude_cli", None)
                    raise asyncio.CancelledError()
                runner._run_provider = stopped
                s2 = sessions.Session()
                await runner.run_turn(s2, "c1", "hi", "claude_cli", None)
                await asyncio.sleep(0.01)
                self.assertEqual(performed, [True], "Stop cancels the booked restart")
                self.assertIsNone(s2.continuation)
            finally:
                restart.perform, runner._run_provider = real_perform, real_run
        run(go())

    def test_missing_note_is_refused(self):
        async def go():
            from sidekick import tooldefs
            registry._tools.clear()
            tooldefs._done = False
            tooldefs.register_all()
            s = sessions.Session()
            ctx = registry.ToolContext(s, "c1", {"permission_mode": "auto"})
            ok, text = await registry.dispatch(ctx, "restart_comfyui", {"note": "  "})
            self.assertFalse(ok)
            self.assertFalse(s.restart_requested)
        run(go())


if __name__ == "__main__":
    unittest.main()
