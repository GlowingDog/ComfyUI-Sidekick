"""Model downloads that run in the background of a chat and show their progress in it.

Rules (each one exists because the URL comes from a model, i.e. possibly from a web page):
- public http(s) only (netguard), credentials only to their own host;
- the file lands inside ComfyUI's model folders, under a cleaned file name, never over an
  existing file, first as <name>.part;
- .safetensors / .sft / .gguf from anywhere; formats that can run code when loaded
  (.ckpt .pt .pth .bin) or are opaque (.onnx) only when the URL is on ComfyUI-Manager's
  vetted model list — the same line the Manager draws at its default security level."""
import asyncio
import hashlib
import os
import re
import shutil
import time
import uuid
from urllib.parse import unquote, urlsplit

from . import models, netguard, node_catalog
from .. import bridge
from ..registry import ToolError

SAFE_EXTS = (".safetensors", ".sft", ".gguf")
LISTED_ONLY_EXTS = (".ckpt", ".pt", ".pth", ".bin", ".onnx")
MAX_ACTIVE = 2
KEEP_FREE = 2 * 1024 ** 3
_NAME_OK = r"[\w .+()\[\]-]+"

_downloads = {}


class Download:
    def __init__(self, url, session):
        self.id = uuid.uuid4().hex[:8]
        self.url, self.session = url, session
        self.name = self.dest = self.tmp = self.folder = None
        self.total = self.done = 0
        self.speed = 0.0
        self.status, self.error, self.sha256 = "starting", None, None
        self.started = time.time()
        self.task = self.item = None

    def public(self):
        return {"download_id": self.id, "name": self.name, "folder": self.folder, "total": self.total,
                "done": self.done, "speed": round(self.speed), "status": self.status, "error": self.error}

    def line(self):
        pct = f"{100 * self.done / self.total:.0f}%" if self.total else "?%"
        size = f"{models._size(self.done)} of {models._size(self.total) if self.total else '?'}"
        extra = {"running": f"{pct}, {size}, {models._size(self.speed)}/s", "done": f"finished, {models._size(self.done)}, sha256 {self.sha256}",
                 "error": f"FAILED: {self.error}", "cancelled": "cancelled"}.get(self.status, self.status)
        return f"{self.id} | {self.folder}/{self.name} | {extra}"


def resolve_folder(folder):
    """'loras', 'loras/SDXL', 'ipadapter' -> (absolute directory, tidy relative name)."""
    fp = models._fp()
    raw = str(folder or "").replace("\\", "/").strip()
    rel = raw.strip("/")
    parts = rel.split("/") if rel else []
    if not parts or raw.startswith("/") or any(p in (".", "..") or not re.fullmatch(_NAME_OK, p) for p in parts):
        raise ToolError("folder must be a ComfyUI model folder such as checkpoints, loras, vae, controlnet, "
                        "upscale_models (optionally with a subfolder, e.g. loras/SDXL). See models action=folders.")
    if parts[0] in models._SKIP_FOLDERS:
        raise ToolError(f"{parts[0]} is not a model folder.")
    if parts[0] in fp.folder_names_and_paths:
        root = fp.folder_names_and_paths[parts[0]][0][0]
        path = os.path.join(root, *parts[1:])
    else:  # folders node packs use without registering them (ipadapter, ultralytics/bbox, …)
        root = fp.models_dir
        path = os.path.join(root, *parts)
    real, real_root = os.path.realpath(path), os.path.realpath(root)
    if os.path.commonpath([real, real_root]) != real_root:
        raise ToolError("That folder is outside ComfyUI's model folders.")
    return real, "/".join(parts)


def clean_filename(name):
    name = os.path.basename(str(name or "").replace("\\", "/")).strip().strip(".")
    name = re.sub(r"[^\w .+()\[\]-]", "_", name)
    if not name or name.lower().endswith(".part"):
        raise ToolError("Could not work out a file name; pass filename.")
    return name[:180]


def check_ext(name, url, listed_urls):
    low = name.lower()
    if low.endswith(SAFE_EXTS):
        return
    if low.endswith(LISTED_ONLY_EXTS):
        if url in listed_urls:
            return
        raise ToolError(f"{name}: this format can run code when it is loaded, so Sidekick only downloads it from "
                        "ComfyUI-Manager's vetted model list (models action=catalog). Look for a .safetensors or "
                        ".gguf version, or let the user download it themselves.")
    raise ToolError(f"{name} is not a model file Sidekick downloads (allowed: {', '.join(SAFE_EXTS + LISTED_ONLY_EXTS)}).")


def _name_from(resp, final_url):
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r"filename\*\s*=\s*[\w-]*''([^;]+)", cd) or re.search(r'filename\s*=\s*"?([^";]+)"?', cd)
    return unquote(m.group(1)) if m else unquote(os.path.basename(urlsplit(final_url).path))


def _write(f, digest, chunk):
    f.write(chunk)
    digest.update(chunk)


def _show(d, force=False):
    now = time.time()
    if d.item is None or (not force and now - getattr(d, "_shown", 0) < 1.0):
        return
    d._shown = now
    try:
        d.session.update_item(d.item, **d.public())
    except Exception:
        pass


async def _refresh_lists(d):
    node_catalog.invalidate()  # get_combo_options must see the new file
    try:  # …and so must the combo widgets on the canvas
        await bridge.call(d.session.client_id, "_refresh_node_defs", {}, 60)
    except Exception:
        pass


async def _run(d, ready, cfg, folder, filename, sha256, listed_urls):
    loop = asyncio.get_running_loop()
    try:
        async with netguard.open_url(d.url, auth=models._auth(cfg), timeout=None, sock_read=120) as (resp, final):
            if resp.status in (401, 403):
                raise ToolError(f"HTTP {resp.status}: the site wants a login. Gated Hugging Face models and most Civitai "
                                "files need the user's access token (Sidekick settings → Web and downloads).")
            if resp.status != 200:
                raise ToolError(f"HTTP {resp.status} from {urlsplit(final).netloc}.")
            if resp.headers.get("Content-Type", "").lower().startswith("text/html"):
                raise ToolError("The URL returned a web page, not a file (a login, licence or landing page). "
                                "Use the direct file URL.")
            d.name = clean_filename(filename or _name_from(resp, final))
            check_ext(d.name, d.url, listed_urls)
            directory, d.folder = resolve_folder(folder)
            d.dest = os.path.join(directory, d.name)
            d.tmp = d.dest + ".part"
            if os.path.exists(d.dest):
                raise ToolError(f"{d.folder}/{d.name} already exists; nothing was downloaded.")
            d.total = int(resp.headers.get("Content-Length") or 0)
            os.makedirs(directory, exist_ok=True)
            free = shutil.disk_usage(directory).free
            if d.total and d.total + KEEP_FREE > free:
                raise ToolError(f"Not enough disk space: the file is {models._size(d.total)}, {models._size(free)} is free.")
            d.status = "running"
            d.item = d.session.add_item("download", **d.public())
            ready.set_result(d)

            digest, last, last_done = hashlib.sha256(), time.time(), 0
            with open(d.tmp, "wb") as f:
                async for chunk in resp.content.iter_chunked(1 << 20):
                    await loop.run_in_executor(None, _write, f, digest, chunk)  # disk + hashing off the server's loop
                    d.done += len(chunk)
                    now = time.time()
                    if now - last >= 1.0:
                        d.speed = (d.done - last_done) / (now - last)
                        last, last_done = now, d.done
                        _show(d)
            if d.total and d.done != d.total:
                raise ToolError(f"The connection ended early ({models._size(d.done)} of {models._size(d.total)}).")
            d.sha256 = digest.hexdigest()
            if sha256 and d.sha256.lower() != str(sha256).strip().lower():
                raise ToolError(f"sha256 mismatch: expected {sha256}, got {d.sha256}. The file was deleted.")
            os.replace(d.tmp, d.dest)
            d.status = "done"
    except asyncio.CancelledError:
        d.status = "cancelled"
    except Exception as e:
        d.status = "error"
        d.error = str(e) if isinstance(e, (ToolError, netguard.Blocked)) else f"{type(e).__name__}: {e}"
        if not ready.done():
            ready.set_exception(ToolError(d.error))
    finally:
        if not ready.done():
            ready.set_exception(ToolError("The download was cancelled before it started."))
        if d.status != "done" and d.tmp:
            try:
                os.remove(d.tmp)
            except OSError:
                pass
        _show(d, force=True)
        try:
            d.session.save()
        except Exception:
            pass
        if d.status == "done":
            await _refresh_lists(d)


async def start(session, cfg, url, folder, filename=None, sha256=None):
    if not re.match(r"^https?://", str(url or ""), re.I):
        raise ToolError("url must be a direct http(s) link to the model file.")
    resolve_folder(folder)  # fail on a bad folder before anything is requested
    if sum(1 for x in _downloads.values() if x.status in ("starting", "running")) >= MAX_ACTIVE:
        raise ToolError(f"{MAX_ACTIVE} downloads are already running; wait for one to finish (download_model action=status).")
    d = Download(str(url).strip(), session)
    _downloads[d.id] = d
    ready = asyncio.get_running_loop().create_future()
    d.task = asyncio.ensure_future(_run(d, ready, cfg, folder, filename, sha256, await models.catalog_urls()))
    try:
        await ready
    except Exception:
        _downloads.pop(d.id, None)
        raise
    return d


def find(download_id):
    d = _downloads.get(str(download_id or ""))
    if d is None:
        raise ToolError(f"No download \"{download_id}\". Known: {', '.join(_downloads) or '(none since ComfyUI started)'}")
    return d


def cancel(download_id):
    d = find(download_id)
    if d.status not in ("starting", "running"):
        return f"{d.id} is already {d.status}."
    d.task.cancel()
    return f"cancelling {d.id} ({d.name}); the partial file is removed."


async def wait(download_id, seconds):
    d = find(download_id)
    deadline = time.time() + max(0, min(float(seconds or 0), 900))
    while d.status in ("starting", "running") and time.time() < deadline:
        await asyncio.sleep(1.0)
    return d


def status_text(download_id=None):
    rows = [find(download_id)] if download_id else sorted(_downloads.values(), key=lambda x: -x.started)[:12]
    if not rows:
        return "No downloads since ComfyUI started."
    return "\n".join(["downloads: id | file | state"] + [d.line() for d in rows])
