"""Finding models: what is installed, the Manager's vetted model list, Hugging Face, Civitai.
Downloading is downloads.py; every outbound call goes through netguard."""
import json
import os
import re
import time
from urllib.parse import quote, quote_plus

from . import loopback, netguard
from ..registry import ToolError

MODEL_EXTS = (".safetensors", ".sft", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".onnx")
# The Manager's "type" -> ComfyUI folder, for list entries whose save_path is "default".
TYPE_DIRS = {"checkpoints": "checkpoints", "checkpoint": "checkpoints", "unclip": "checkpoints",
             "text_encoders": "text_encoders", "clip": "text_encoders", "vae": "vae", "lora": "loras",
             "t2i-adapter": "controlnet", "t2i-style": "controlnet", "controlnet": "controlnet",
             "clip_vision": "clip_vision", "gligen": "gligen", "upscale": "upscale_models",
             "embedding": "embeddings", "embeddings": "embeddings", "unet": "diffusion_models",
             "diffusion_model": "diffusion_models"}
_SKIP_FOLDERS = {"custom_nodes", "configs", "download_model_base"}

_catalog = {"at": 0.0, "models": None}


def _fp():
    import folder_paths  # ComfyUI module; imported late so unit tests can stub it
    return folder_paths


def _size(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit in ("B", "KB") else f"{n:.1f}{unit}"
        n /= 1024


def folders():
    fp = _fp()
    lines = ["model folders (name | files | where downloads go):"]
    for name in sorted(fp.folder_names_and_paths):
        if name in _SKIP_FOLDERS:
            continue
        paths = fp.folder_names_and_paths[name][0]
        try:
            count = len(fp.get_filename_list(name))
        except Exception:
            count = 0
        lines.append(f"{name} | {count} | {paths[0] if paths else '?'}")
    lines.append("download_model takes one of these names as folder, optionally with a subfolder like loras/SDXL.")
    return "\n".join(lines)


def installed(folder=None, query=None, limit=60):
    fp = _fp()
    names = [folder] if folder else [n for n in sorted(fp.folder_names_and_paths) if n not in _SKIP_FOLDERS]
    toks = [t for t in str(query or "").lower().split() if t]
    rows = []
    for name in names:
        if name not in fp.folder_names_and_paths:
            raise ToolError(f"No model folder \"{name}\". Folders: {', '.join(sorted(set(fp.folder_names_and_paths) - _SKIP_FOLDERS))}")
        try:
            files = fp.get_filename_list(name)
        except Exception:
            files = []
        rows += [(name, f) for f in files if all(t in f.lower() for t in toks)]
    if not rows:
        return f"No installed model matches{' ' + json.dumps(query) if query else ''}{' in ' + folder if folder else ''}."
    limit = max(1, min(int(limit or 60), 200))
    lines = [f"{len(rows)} installed model file(s): folder | file"] + [f"{a} | {b}" for a, b in rows[:limit]]
    if len(rows) > limit:
        lines.append(f"…{len(rows) - limit} more; pass folder and/or query.")
    return "\n".join(lines)


async def catalog_models():
    """ComfyUI-Manager's curated model list: [{name,type,base,save_path,filename,url,size,installed}]"""
    if _catalog["models"] is None or time.time() - _catalog["at"] > 600:
        data = await loopback.get_json("/externalmodel/getlist", {"mode": "cache"}, timeout=120)
        _catalog.update(models=data.get("models") or [], at=time.time())
    return _catalog["models"]


def catalog_folder(m):
    """Where a list entry belongs, as a download_model folder (None: not a models/ location)."""
    save = str(m.get("save_path") or "default").replace("\\", "/").strip("/")
    if save == "default":
        return TYPE_DIRS.get(str(m.get("type") or "").lower(), "etc")
    if save.startswith("custom_nodes") or ".." in save or ":" in save:
        return None
    return save


async def catalog(query, limit=15):
    try:
        models = await catalog_models()
    except Exception as e:
        raise ToolError(f"The Manager's model list is not available ({e}). Use search_hf or search_civitai.")
    toks = [t for t in re.split(r"\s+", str(query or "").lower()) if t]
    rows = [m for m in models if all(t in f"{m.get('name')} {m.get('type')} {m.get('base')} {m.get('filename')} {m.get('description')}".lower() for t in toks)]
    if not rows:
        return f"Nothing in the Manager's model list matches \"{query}\". Try search_hf or search_civitai."
    limit = max(1, min(int(limit or 15), 40))
    lines = [f"{len(rows)} model(s) in ComfyUI-Manager's vetted list: name | type | base | size | folder/filename | installed | url"]
    for m in rows[:limit]:
        folder = catalog_folder(m)
        lines.append(f"{m.get('name')} | {m.get('type')} | {m.get('base')} | {m.get('size')} | "
                     f"{folder or '(inside a node pack: not supported)'}/{m.get('filename')} | "
                     f"{'yes' if str(m.get('installed')) == 'True' else 'no'} | {m.get('url')}")
    if len(rows) > limit:
        lines.append(f"…{len(rows) - limit} more; refine the query.")
    lines.append("Download one with download_model (url, folder, filename exactly as listed).")
    return "\n".join(lines)


async def catalog_urls():
    try:
        return {str(m.get("url")) for m in await catalog_models()}
    except Exception:
        return set()


def _auth(cfg):
    tokens = (cfg or {}).get("tokens") or {}
    auth = {}
    if tokens.get("huggingface"):
        auth["huggingface.co"] = {"Authorization": f"Bearer {tokens['huggingface']}"}
    if tokens.get("civitai"):
        auth["civitai.com"] = {"Authorization": f"Bearer {tokens['civitai']}"}
    return auth


async def _api(url, cfg):
    try:
        final, status, _, body, _ = await netguard.fetch(url, max_bytes=4_000_000, timeout=30, auth=_auth(cfg),
                                                         headers={"Accept": "application/json"})
    except netguard.Blocked as e:
        raise ToolError(f"Blocked: {e}")
    except Exception as e:
        raise ToolError(f"Request failed: {type(e).__name__}: {e}")
    if status in (401, 403):
        raise ToolError(f"HTTP {status}: this needs an access token (gated or private). The user can add a Hugging Face / "
                        "Civitai token in Sidekick settings.")
    if status == 404:
        raise ToolError("HTTP 404: not found.")
    if status != 200:
        raise ToolError(f"HTTP {status}: {body[:200].decode('utf-8', 'replace')}")
    return json.loads(body.decode("utf-8", "replace"))


async def search_hf(query, cfg, limit=10):
    if not str(query or "").strip():
        raise ToolError("query is required.")
    limit = max(1, min(int(limit or 10), 25))
    data = await _api(f"https://huggingface.co/api/models?search={quote_plus(str(query))}&limit={limit}&sort=downloads&direction=-1", cfg)
    if not data:
        return f"No Hugging Face repository matches \"{query}\"."
    lines = ["Hugging Face repositories (most downloaded first): repo | downloads | likes | kind"]
    for r in data:
        tags = [t for t in (r.get("tags") or []) if t in ("gguf", "safetensors", "diffusers", "lora", "controlnet")]
        lines.append(f"{r.get('id') or r.get('modelId')} | {r.get('downloads', 0)} | {r.get('likes', 0)} | "
                     f"{r.get('pipeline_tag') or '-'} {' '.join(tags)}{' | GATED: needs a token and accepted terms' if r.get('gated') else ''}")
    lines.append("List a repository's files with action hf_files repo=<repo>.")
    return "\n".join(lines)


async def hf_files(repo, cfg, query=None, limit=40):
    repo = str(repo or "").strip().strip("/")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise ToolError("repo must look like owner/name.")
    data = await _api(f"https://huggingface.co/api/models/{quote(repo)}/tree/main?recursive=true", cfg)
    toks = [t for t in str(query or "").lower().split() if t]
    files = [f for f in data if f.get("type") == "file" and str(f.get("path", "")).lower().endswith(MODEL_EXTS)
             and all(t in str(f.get("path", "")).lower() for t in toks)]
    if not files:
        return f"{repo} has no model files{' matching ' + json.dumps(query) if query else ''} (looked for {', '.join(MODEL_EXTS)})."
    limit = max(1, min(int(limit or 40), 100))
    lines = [f"{repo}: {len(files)} model file(s): size | path | download url"]
    for f in files[:limit]:
        size = (f.get("lfs") or {}).get("size") or f.get("size")
        lines.append(f"{_size(size)} | {f['path']} | https://huggingface.co/{repo}/resolve/main/{quote(f['path'])}")
    if len(files) > limit:
        lines.append(f"…{len(files) - limit} more; pass query.")
    return "\n".join(lines)


async def search_civitai(query, cfg, limit=8, model_type=None):
    if not str(query or "").strip():
        raise ToolError("query is required.")
    limit = max(1, min(int(limit or 8), 20))
    url = f"https://civitai.com/api/v1/models?query={quote_plus(str(query))}&limit={limit}&nsfw=false"
    if model_type:
        url += f"&types={quote_plus(str(model_type))}"
    data = await _api(url, cfg)
    items = data.get("items") or []
    if not items:
        return f"No Civitai model matches \"{query}\"."
    lines = ["Civitai models: name | type | base model | downloads | newest version: file, size, download url"]
    for it in items:
        ver = (it.get("modelVersions") or [{}])[0]
        files = [f for f in ver.get("files") or [] if str(f.get("name", "")).lower().endswith(MODEL_EXTS)]
        f = next((x for x in files if (x.get("metadata") or {}).get("format") == "SafeTensor"), files[0] if files else None)
        where = (f"{f.get('name')}, {_size((f.get('sizeKB') or 0) * 1024)}, {f.get('downloadUrl')}" if f else "no downloadable model file")
        lines.append(f"{it.get('name')} | {it.get('type')} | {ver.get('baseModel', '?')} | "
                     f"{(it.get('stats') or {}).get('downloadCount', 0)} | {ver.get('name', '?')}: {where}")
    lines.append("Most Civitai downloads need the user's Civitai API key (Sidekick settings).")
    return "\n".join(lines)


def relative_to_models(path):
    try:
        return os.path.relpath(path, _fp().models_dir).replace("\\", "/")
    except Exception:
        return os.path.basename(path)
