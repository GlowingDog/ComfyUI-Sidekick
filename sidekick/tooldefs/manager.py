"""Node packs (through ComfyUI-Manager), models, downloads, restart. All run in Python."""
from .. import bridge
from ..backend import downloads, manager, models, restart
from ..registry import Tool, ToolError, register


async def _manager_nodes(ctx, a):
    action = a.get("action") or "search"
    if action == "search":
        return await manager.search(a.get("query", ""), a.get("limit", 10), a.get("only"))
    if action == "info":
        return await manager.info(a.get("id") or a.get("query"))
    if action == "for_types":
        return await manager.for_types(a.get("types"))
    if action == "installed":
        return await manager.search(a.get("query", ""), a.get("limit", 40), "installed")
    if action == "missing":
        types = a.get("types")
        if not types:
            try:  # red nodes on the canvas: only the browser knows which types it could not create
                types = await bridge.call(ctx.client_id, "_missing_node_types", {}, 30)
            except bridge.BridgeError as e:
                raise ToolError(f"{e} Or pass the node class names as types.")
        if not types:
            return "No node on the canvas is missing its node pack: every node type is installed."
        return "Missing on this ComfyUI (red nodes on the canvas).\n" + await manager.for_types(types)
    raise ToolError("action must be search, info, for_types, missing or installed.")


async def _manager_action(ctx, a):
    return await manager.act(str(a.get("action") or ""), a.get("id"), a.get("version"))


async def _models(ctx, a):
    action = a.get("action") or "installed"
    if action == "folders":
        return models.folders()
    if action == "installed":
        return models.installed(a.get("folder"), a.get("query"), a.get("limit", 60))
    if action == "catalog":
        return await models.catalog(a.get("query", ""), a.get("limit", 15))
    if action == "search_hf":
        return await models.search_hf(a.get("query"), ctx.cfg, a.get("limit", 10))
    if action == "hf_files":
        return await models.hf_files(a.get("repo"), ctx.cfg, a.get("query"), a.get("limit", 40))
    if action == "search_civitai":
        return await models.search_civitai(a.get("query"), ctx.cfg, a.get("limit", 8), a.get("type"))
    raise ToolError("action must be folders, installed, catalog, search_hf, hf_files or search_civitai.")


def download_risk(args):
    action = args.get("action") or ("start" if args.get("url") else "status")
    return {"status": "read", "cancel": "edit"}.get(action, "risky")


async def _download(ctx, a):
    action = a.get("action") or ("start" if a.get("url") else "status")
    if action == "status":
        if a.get("id") and a.get("wait_s"):
            await downloads.wait(a["id"], a["wait_s"])
        return downloads.status_text(a.get("id"))
    if action == "cancel":
        return downloads.cancel(a.get("id"))
    if action != "start":
        raise ToolError("action must be start, status or cancel.")
    d = await downloads.start(ctx.session, ctx.cfg, a.get("url"), a.get("folder"), a.get("filename"), a.get("sha256"))
    size = models._size(d.total) if d.total else "unknown size"
    return (f"download {d.id} started: {d.folder}/{d.name} ({size}). It continues in the background and the user sees "
            f"its progress in the chat. Check with download_model action=status id={d.id} (add wait_s to wait). "
            "When it is done the model lists refresh by themselves; then select the file with set_widget_values.")


async def _restart(ctx, a):
    note = str(a.get("note") or "").strip()
    if not note:
        raise ToolError("note is required: what you will do after the restart (you lose your working memory of this turn).")
    provider_id = getattr(ctx.session, "provider_id", None)
    restart.book(ctx.session, note, provider_id, getattr(ctx.session, "model", None))
    return ("Restart booked. ComfyUI restarts as soon as this reply ends, and you will be called again automatically "
            "with your note. END YOUR TURN NOW: answer with one short sentence telling the user that ComfyUI is "
            "restarting, and call no more tools.")


def register_all():
    register(Tool(
        "manager_nodes",
        "Find custom node packs through ComfyUI-Manager's registry. action search (words → id | title | author | "
        "stars | state | about), info (one pack: repository, its node types), for_types (which pack provides these "
        "node class names), missing (the red nodes on the canvas → the packs that would fix them), installed.",
        {"action": {"type": "string", "enum": ["search", "info", "for_types", "missing", "installed"]},
         "query": {"type": "string"}, "id": {"type": "string", "description": "info: pack id."},
         "types": {"type": "array", "items": {"type": "string"}, "description": "for_types / missing: node class names."},
         "only": {"type": "string", "enum": ["installed", "not-installed"]}, "limit": {"type": "integer"}},
        side="backend", handler=_manager_nodes, timeout=240))
    register(Tool(
        "manager_node_action",
        "Install, update, uninstall, disable, enable or fix (re-run the install steps of) a custom node pack through "
        "ComfyUI-Manager. The user is asked first: a node pack is third-party code that runs inside ComfyUI. Prefer "
        "well-known packs (stars, trusted list) and say what you are about to install and why. Takes up to a few "
        "minutes. Afterwards ComfyUI must restart (restart_comfyui).",
        {"action": {"type": "string", "enum": ["install", "update", "uninstall", "disable", "enable", "fix"]},
         "id": {"type": "string", "description": "Pack id from manager_nodes."},
         "version": {"type": "string", "description": "install: a version, \"latest\" (default) or \"nightly\"."}},
        ["action", "id"], side="backend", handler=_manager_action, risk="risky", timeout=1500))
    register(Tool(
        "models",
        "Find models. action installed (files ComfyUI has, per folder; for the values a loader accepts use "
        "get_combo_options), folders (model folders and where they are), catalog (ComfyUI-Manager's vetted list of "
        "well-known models with direct URLs: the first place to look), search_hf (Hugging Face repositories), hf_files "
        "(model files of one repository with sizes and URLs), search_civitai.",
        {"action": {"type": "string", "enum": ["installed", "folders", "catalog", "search_hf", "hf_files", "search_civitai"]},
         "query": {"type": "string"}, "folder": {"type": "string", "description": "installed: e.g. loras."},
         "repo": {"type": "string", "description": "hf_files: owner/name."},
         "type": {"type": "string", "description": "search_civitai: Checkpoint, LORA, Controlnet, Upscaler, VAE, TextualInversion."},
         "limit": {"type": "integer"}},
        side="backend", handler=_models, timeout=240))
    register(Tool(
        "download_model",
        "Download a model file into ComfyUI's model folders (action start: url, folder, optional filename / sha256). The "
        "user is asked first and sees the progress in the chat; the download continues in the background, so you can "
        "keep working. Any host: .safetensors / .sft / .gguf. Formats that can run code when loaded (.ckpt .pt .pth "
        ".bin .onnx): only URLs from models action=catalog. Never overwrites. action status (id, optional wait_s) and "
        "cancel (id). Tell the user the size before you start a big one.",
        {"action": {"type": "string", "enum": ["start", "status", "cancel"]},
         "url": {"type": "string", "description": "Direct link to the file."},
         "folder": {"type": "string", "description": "Model folder, e.g. checkpoints, loras/SDXL, vae, controlnet."},
         "filename": {"type": "string", "description": "Default: the name the server gives."},
         "sha256": {"type": "string", "description": "Verify the file against this hash."},
         "id": {"type": "string", "description": "status / cancel: download id."},
         "wait_s": {"type": "integer", "description": "status: wait up to this long for it to finish (max 900)."}},
        side="backend", handler=_download, risk="risky", risk_fn=download_risk, timeout=960))
    register(Tool(
        "restart_comfyui",
        "Restart the ComfyUI server (needed after installing, updating or removing a node pack). The user is asked "
        "first; anything queued or running is lost. Your turn ends with the restart, and you are called again "
        "automatically once ComfyUI is back, with `note` as your instructions: write down exactly what is left to do.",
        {"note": {"type": "string", "description": "What to do after the restart, with the ids/names you will need."}},
        ["note"], side="backend", handler=_restart, risk="risky"))
