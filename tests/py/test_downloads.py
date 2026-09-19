"""Model downloads: where files may land, which formats from where, progress, cancel, tokens."""
import asyncio
import hashlib
import os
import sys
import tempfile
import types
import unittest

from aiohttp import web as aioweb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

MODELS = tempfile.mkdtemp(prefix="sidekick_models_")
fp = types.ModuleType("folder_paths")  # stand-in for ComfyUI's module
fp.models_dir = MODELS
fp.folder_names_and_paths = {
    "checkpoints": ([os.path.join(MODELS, "checkpoints")], {".safetensors"}),
    "loras": ([os.path.join(MODELS, "loras")], {".safetensors"}),
    "custom_nodes": ([os.path.join(MODELS, "..", "custom_nodes")], set()),
}
fp.get_filename_list = lambda name: sorted(os.listdir(fp.folder_names_and_paths[name][0][0])) if os.path.isdir(fp.folder_names_and_paths[name][0][0]) else []
sys.modules["folder_paths"] = fp

from sidekick import paths, registry, sessions, tooldefs  # noqa: E402
from sidekick.backend import downloads, models, netguard  # noqa: E402
from sidekick.registry import ToolError  # noqa: E402
from sidekick.tooldefs import manager as manager_defs  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
sessions.set_emit_hook(lambda payload: None)
BLOB = os.urandom(3 * 1024 * 1024 + 17)


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class DestinationTests(unittest.TestCase):
    def test_folders(self):
        self.assertEqual(downloads.resolve_folder("loras")[1], "loras")
        path, rel = downloads.resolve_folder("loras\\SDXL/")
        self.assertEqual((os.path.normpath(path), rel), (os.path.normpath(os.path.join(MODELS, "loras", "SDXL")), "loras/SDXL"))
        self.assertTrue(downloads.resolve_folder("ultralytics/bbox")[0].startswith(os.path.realpath(MODELS)))  # unregistered: under models/
        for bad in ("", "..", "../custom_nodes", "loras/../../x", "loras/..", "custom_nodes", "custom_nodes/evil", "C:/Windows",
                    "/etc", "loras/a:b", "loras/<x>", "checkpoints/./x"):
            with self.assertRaises(ToolError, msg=bad):
                downloads.resolve_folder(bad)

    def test_file_names_and_formats(self):
        self.assertEqual(downloads.clean_filename("../../evil dir\\my model (v2).safetensors"), "my model (v2).safetensors")
        self.assertEqual(downloads.clean_filename("a|b?.gguf"), "a_b_.gguf")
        for bad in ("", "...", "x.safetensors.part"):
            with self.assertRaises(ToolError):
                downloads.clean_filename(bad)
        listed = {"https://good.example/4x.pth"}
        for ok in (("m.safetensors", "https://anywhere.example/m"), ("m.SFT", "u"), ("q4.gguf", "u"), ("4x.pth", "https://good.example/4x.pth")):
            downloads.check_ext(ok[0], ok[1], listed)
        for name, url, needle in (("4x.pth", "https://evil.example/4x.pth", "vetted"), ("m.ckpt", "u", "vetted"), ("m.bin", "u", "vetted"),
                                  ("run.exe", "u", "not a model file"), ("nodes.zip", "u", "not a model file"), ("x.py", "u", "not a model file")):
            with self.assertRaises(ToolError) as cm:
                downloads.check_ext(name, url, listed)
            self.assertIn(needle, str(cm.exception))


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self._real = netguard.is_public_ip
        netguard.is_public_ip = lambda value: True
        models._catalog.update(models=[], at=1e18)  # no Manager in these tests: an empty vetted list
        downloads._downloads.clear()

    def tearDown(self):
        netguard.is_public_ip = self._real

    def serve(self, body):
        async def go():
            seen = {"auth": []}

            async def blob(request):
                seen["auth"].append(request.headers.get("Authorization"))
                return aioweb.Response(body=BLOB, headers={"Content-Disposition": 'attachment; filename="Nice Model v1.safetensors"'})

            async def slow(request):
                resp = aioweb.StreamResponse(headers={"Content-Length": str(50 * 1024 * 1024)})
                await resp.prepare(request)
                for _ in range(400):
                    await resp.write(b"x" * 65536)
                    await asyncio.sleep(0.02)
                return resp

            async def short(request):
                resp = aioweb.StreamResponse(headers={"Content-Length": "999999"})
                await resp.prepare(request)
                await resp.write(b"abc")
                request.transport.close()  # the server dies mid-file
                return resp

            app = aioweb.Application()
            app.router.add_get("/file/model.safetensors", blob)
            app.router.add_get("/file/upscaler.pth", blob)
            app.router.add_get("/slow/big.safetensors", slow)
            app.router.add_get("/short/cut.safetensors", short)
            app.router.add_get("/page/model.safetensors", lambda r: aioweb.Response(text="<html>log in</html>", content_type="text/html"))
            app.router.add_get("/gated/model.safetensors", lambda r: aioweb.Response(status=401))
            runner = aioweb.AppRunner(app)
            await runner.setup()
            site = aioweb.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            try:
                await body(f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}", seen)
            finally:
                await runner.cleanup()
        run(go())

    def test_download_lands_in_the_models_folder_with_progress_and_hash(self):
        async def body(base, seen):
            s = sessions.Session()
            s.client_id = None
            cfg = {"tokens": {"huggingface": "hf_secret"}}
            d = await downloads.start(s, cfg, base + "/file/model.safetensors", "loras/test")
            self.assertEqual((d.name, d.folder, d.total), ("Nice Model v1.safetensors", "loras/test", len(BLOB)))  # name from the server
            await d.task
            dest = os.path.join(MODELS, "loras", "test", "Nice Model v1.safetensors")
            self.assertEqual((d.status, os.path.getsize(dest), d.sha256), ("done", len(BLOB), hashlib.sha256(BLOB).hexdigest()))
            self.assertFalse(os.path.exists(dest + ".part"))
            item = [i for i in s.items if i["kind"] == "download"][0]
            self.assertEqual((item["status"], item["done"], item["total"], item["download_id"]), ("done", len(BLOB), len(BLOB), d.id))
            self.assertEqual(seen["auth"], [None], "the Hugging Face token is not sent to other hosts")
            self.assertIn("finished", downloads.status_text(d.id))
            with self.assertRaises(ToolError) as cm:  # never overwrite
                await downloads.start(s, cfg, base + "/file/model.safetensors", "loras/test")
            self.assertIn("already exists", str(cm.exception))
            ok = await downloads.start(s, cfg, base + "/file/model.safetensors", "checkpoints", "renamed.safetensors", hashlib.sha256(BLOB).hexdigest())
            await ok.task
            self.assertEqual(ok.status, "done")
            bad = await downloads.start(s, cfg, base + "/file/model.safetensors", "checkpoints", "tampered.safetensors", "00" * 32)
            await bad.task
            self.assertEqual(bad.status, "error")
            self.assertIn("sha256 mismatch", bad.error)
            self.assertEqual(sorted(os.listdir(os.path.join(MODELS, "checkpoints"))), ["renamed.safetensors"])  # no tampered file, no .part
        self.serve(body)

    def test_refusals_happen_before_anything_is_written(self):
        async def body(base, seen):
            s = sessions.Session()
            for url, folder, name, needle in (
                    (base + "/file/upscaler.pth", "upscale", "upscaler.pth", "vetted model list"),
                    (base + "/page/model.safetensors", "loras", None, "web page, not a file"),
                    (base + "/gated/model.safetensors", "loras", None, "access token"),
                    (base + "/nope/model.safetensors", "loras", None, "HTTP 404"),
                    (base + "/file/model.safetensors", "../custom_nodes", None, "folder must be"),
                    ("ftp://x.example/m.safetensors", "loras", None, "direct http(s) link")):
                with self.assertRaises(ToolError) as cm:
                    await downloads.start(s, {}, url, folder, name)
                self.assertIn(needle, str(cm.exception), url)
            self.assertEqual([i for i in s.items if i["kind"] == "download"], [], "no progress card for a refused download")
            self.assertFalse(os.path.exists(os.path.join(MODELS, "upscale")))
            self.assertEqual(downloads._downloads, {})
            models._catalog.update(models=[{"url": base + "/file/upscaler.pth"}])  # now it is on the vetted list
            d = await downloads.start(s, {}, base + "/file/upscaler.pth", "upscale", "upscaler.pth")
            await d.task
            self.assertEqual(d.status, "done")
        self.serve(body)

    def test_cancel_and_broken_connections_leave_no_files(self):
        async def body(base, seen):
            s = sessions.Session()
            d = await downloads.start(s, {}, base + "/slow/big.safetensors", "loras/slow")
            await asyncio.sleep(0.3)
            self.assertEqual(d.status, "running")
            self.assertTrue(os.path.exists(d.tmp))
            self.assertIn("cancelling", downloads.cancel(d.id))
            await asyncio.wait([d.task], timeout=5)
            self.assertEqual(d.status, "cancelled")
            self.assertEqual(os.listdir(os.path.join(MODELS, "loras", "slow")), [])
            self.assertEqual([i for i in s.items if i["kind"] == "download"][0]["status"], "cancelled")
            cut = await downloads.start(s, {}, base + "/short/cut.safetensors", "loras/slow")
            await asyncio.wait([cut.task], timeout=10)
            self.assertEqual(cut.status, "error")
            self.assertEqual(os.listdir(os.path.join(MODELS, "loras", "slow")), [])
            with self.assertRaises(ToolError):
                downloads.cancel("nope")
        self.serve(body)

    def test_the_guard_applies_to_downloads(self):
        netguard.is_public_ip = self._real

        async def go():
            with self.assertRaises(ToolError) as cm:
                await downloads.start(sessions.Session(), {}, "http://127.0.0.1:8188/view?filename=x.safetensors", "loras")
            self.assertIn("not a public", str(cm.exception))
        run(go())


class ToolSurfaceTests(unittest.TestCase):
    def test_risk_and_permission(self):
        self.assertEqual(manager_defs.download_risk({"url": "https://x/y.safetensors", "folder": "loras"}), "risky")
        self.assertEqual(manager_defs.download_risk({"action": "start"}), "risky")
        self.assertEqual(manager_defs.download_risk({}), "read")
        self.assertEqual(manager_defs.download_risk({"action": "status", "id": "ab"}), "read")
        self.assertEqual(manager_defs.download_risk({"action": "cancel", "id": "ab"}), "edit")
        self.assertEqual(manager_defs.download_risk({"action": "format_disk"}), "risky")
        registry._tools.clear()
        tooldefs._done = False
        tooldefs.register_all()
        for name in ("manager_node_action", "restart_comfyui"):
            self.assertEqual(registry.get(name).risk_of({}), "risky", name)
        for name in ("manager_nodes", "models", "web_search", "web_fetch"):
            self.assertEqual(registry.get(name).risk_of({}), "read", name)
        names = lambda kind, cfg=None: {t.name for t in registry.all_tools(kind, cfg)}  # noqa: E731
        self.assertTrue({"web_search", "web_fetch"} <= names("openai"))
        self.assertFalse({"web_search", "web_fetch"} & names("claude_cli"), "CLI brains bring their own web tools")
        self.assertFalse({"web_search", "web_fetch"} & names("codex_cli"))
        self.assertFalse({"web_search", "web_fetch"} & names("openai", {"web_tools": False}), "the user can switch the web off")
        self.assertIn("download_model", names("claude_cli"))

    def test_models_listing(self):
        os.makedirs(os.path.join(MODELS, "checkpoints"), exist_ok=True)
        open(os.path.join(MODELS, "checkpoints", "sdxl_base.safetensors"), "wb").close()
        text = models.installed("checkpoints", "sdxl")
        self.assertIn("checkpoints | sdxl_base.safetensors", text)
        self.assertNotIn("custom_nodes", models.folders())
        self.assertIn("checkpoints |", models.folders())
        with self.assertRaises(ToolError):
            models.installed("nope")
        self.assertEqual(models.catalog_folder({"save_path": "default", "type": "upscale"}), "upscale_models")
        self.assertEqual(models.catalog_folder({"save_path": "loras/SDXL"}), "loras/SDXL")
        self.assertIsNone(models.catalog_folder({"save_path": "custom_nodes/x/models"}))
        self.assertIsNone(models.catalog_folder({"save_path": "../outside"}))


if __name__ == "__main__":
    unittest.main()
