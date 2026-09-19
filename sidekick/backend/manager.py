"""Client for ComfyUI-Manager's own HTTP routes on this server (verified against V3.40).

Reads: /customnode/getlist, /customnode/installed, /customnode/getmappings.
Changes go through the Manager's task queue exactly like its dialog does:
status (busy?) -> reset -> /manager/queue/<action> per pack -> start -> poll status.
The per-pack verdict is only pushed over the websocket, so the outcome is verified by
reading the installed list again (and, best effort, the Manager's result table)."""
import asyncio
import json
import math
import re
import sys
import time

from . import loopback
from ..registry import ToolError

LIST_TTL = 600
ACTIONS = {"install": "install", "enable": "install", "update": "update", "uninstall": "uninstall",
           "disable": "disable", "fix": "fix"}
NEEDS_INSTALLED = {"update", "uninstall", "disable", "fix"}

_cache = {"packs": None, "packs_at": 0.0, "maps": None, "maps_at": 0.0}


def invalidate():
    _cache.update(packs=None, packs_at=0.0)


async def version():
    try:
        status, text = await loopback.request("GET", "/manager/version", timeout=10)
    except Exception:
        return None
    return text.strip() if status == 200 else None


async def _require():
    v = await version()
    if v is None:
        raise ToolError("ComfyUI-Manager is not installed or not answering on this ComfyUI, so node packs cannot "
                        "be searched or installed from here. The user can install it from "
                        "https://github.com/Comfy-Org/ComfyUI-Manager.")
    return v


async def packs(refresh=False):
    """{pack id: {id, title, author, description, repository, files, state, version, cnr_latest, stars, …}}"""
    if not refresh and _cache["packs"] is not None and time.time() - _cache["packs_at"] < LIST_TTL:
        return _cache["packs"]
    await _require()
    data = await loopback.get_json("/customnode/getlist", {"mode": "cache", "skip_update": "true"}, timeout=180)
    _cache.update(packs=data.get("node_packs") or {}, packs_at=time.time())
    return _cache["packs"]


async def installed():
    return await loopback.get_json("/customnode/installed", timeout=60)


async def _mappings():
    if _cache["maps"] is None or time.time() - _cache["maps_at"] > LIST_TTL:
        await _require()
        _cache.update(maps=await loopback.get_json("/customnode/getmappings", {"mode": "cache"}, timeout=180),
                      maps_at=time.time())
    return _cache["maps"]


def _norm_url(url):
    return re.sub(r"(\.git)?/*$", "", str(url or "").strip().lower())


def _stars(p):
    s = p.get("stars")
    return s if isinstance(s, (int, float)) and s > 0 else 0


def _row(pid, p):
    ver = p.get("active_version") or p.get("version") or ""
    latest = p.get("cnr_latest") or ""
    state = p.get("state") or "?"
    if state != "not-installed" and ver:
        state += f" {ver}" + (f" (latest {latest})" if latest and latest != ver else "")
    elif latest:
        state += f" (latest {latest})"
    desc = " ".join(str(p.get("description") or "").split())[:110]
    return f"{pid} | {p.get('title', '')} | {p.get('author', '')} | ★{_stars(p)} | {state} | {desc}"


def find_pack(all_packs, ref):
    ref = str(ref or "").strip()
    if not ref:
        raise ToolError("id is required: a pack id from manager_nodes search.")
    low, url = ref.lower(), _norm_url(ref)
    for pid, p in all_packs.items():
        if pid.lower() == low or str(p.get("id", "")).lower() == low:
            return pid, p
    hits = [(pid, p) for pid, p in all_packs.items()
            if str(p.get("title", "")).lower() == low or _norm_url(p.get("repository")) == url
            or url in [_norm_url(f) for f in p.get("files") or []]]
    if not hits:
        hits = [(pid, p) for pid, p in all_packs.items() if low in pid.lower() or low in str(p.get("title", "")).lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise ToolError(f"No node pack matches \"{ref}\". Use manager_nodes action=search.")
    hits.sort(key=lambda x: -_stars(x[1]))
    raise ToolError(f"Several node packs match \"{ref}\"; use the exact id:\n" + "\n".join(_row(*h) for h in hits[:8]))


async def _node_names():
    """{pack id: "node names of the pack, lower case"} — people search for what a pack contains."""
    try:
        node_map, all_packs = await _mappings(), await packs()
    except Exception:
        return {}
    by_url = {_norm_url(p.get("repository")): pid for pid, p in all_packs.items()}
    out = {}
    for key, value in node_map.items():
        pid = key if key in all_packs else by_url.get(_norm_url(key))
        if pid and isinstance(value, list) and value:
            out[pid] = " ".join(value[0]).lower()
    return out


async def search(query, limit=10, only=None):
    all_packs = await packs()
    toks = [t for t in re.split(r"[^a-z0-9]+", str(query or "").lower()) if t]
    nodes = await _node_names() if toks else {}
    rows = []
    for pid, p in all_packs.items():
        state = p.get("state") or ""
        if only == "installed" and state == "not-installed":
            continue
        if only == "not-installed" and state != "not-installed":
            continue
        title = str(p.get("title", "")).lower()
        about = f"{pid} {title} {p.get('author', '')} {p.get('description', '')}".lower()
        if not all(t in about or t in nodes.get(pid, "") for t in toks):
            continue
        # Match quality plus popularity: a model picks from the top, and a 4000-star pack that fits is a
        # better answer than a 3-star pack whose title happens to contain the words.
        phrase = " ".join(toks)
        score = (sum(3 for t in toks if t in title or t in pid.lower()) + sum(1 for t in toks if t in about)
                 + (5 if phrase and phrase in title else 0) + (100 if phrase and phrase in (title, pid.lower()) else 0)
                 + 2 * math.log10(_stars(p) + 1))
        rows.append((score, _stars(p), pid, p))
    rows.sort(key=lambda r: (-r[0], -r[1], r[2]))
    if not rows:
        return f"No node pack matches \"{query}\". Try fewer or different words."
    limit = max(1, min(int(limit or 10), 40))
    lines = [f"{len(rows)} node pack(s){' matching ' + json.dumps(query) if toks else ''}: id | title | author | stars | state | about"]
    lines += [_row(pid, p) for _, _, pid, p in rows[:limit]]
    if len(rows) > limit:
        lines.append(f"…{len(rows) - limit} more; refine the query.")
    return "\n".join(lines)


async def info(ref):
    pid, p = find_pack(await packs(), ref)
    lines = [_row(pid, p), f"repository: {p.get('repository') or p.get('reference') or '?'}",
             f"install type: {p.get('install_type', '?')} | last update: {p.get('last_update', '?')} | "
             f"trusted list: {'yes' if p.get('trust') else 'no'}"]
    try:
        node_map = await _mappings()
        key = pid if pid in node_map else next((k for k in node_map if _norm_url(k) == _norm_url(p.get("repository"))), None)
        if key:
            names = node_map[key][0]
            lines.append(f"nodes ({len(names)}): {', '.join(names[:60])}{' …' if len(names) > 60 else ''}")
    except Exception:
        pass
    return "\n".join(lines)


async def packs_for_types(types):
    """{node class name: [(pack id, pack), …] best first} using the Manager's node -> pack map."""
    all_packs, node_map = await packs(), await _mappings()
    by_url = {}
    for pid, p in all_packs.items():
        for u in [p.get("repository"), *(p.get("files") or [])]:
            by_url.setdefault(_norm_url(u), (pid, p))
    out = {}
    for t in types:
        found = {}
        for key, (names, meta) in ((k, v) for k, v in node_map.items() if isinstance(v, list) and len(v) == 2):
            pattern = (meta or {}).get("nodename_pattern")
            if t in names or (pattern and _safe_match(pattern, t)):
                hit = (key, all_packs[key]) if key in all_packs else by_url.get(_norm_url(key))
                if hit:
                    found[hit[0]] = hit[1]
        out[t] = sorted(found.items(), key=lambda kv: -_stars(kv[1]))
    return out


def _safe_match(pattern, text):
    try:  # search, like the Manager's dialog (RegExp.test): many patterns are suffixes such as " \(rgthree\)$"
        return re.search(pattern, text) is not None
    except re.error:
        return False


async def for_types(types):
    types = [str(t) for t in (types or []) if str(t).strip()][:60]
    if not types:
        raise ToolError("types must list node class names.")
    found = await packs_for_types(types)
    lines = ["node type -> packs that provide it (best known first): id | title | author | stars | state | about"]
    for t in types:
        hits = found.get(t) or []
        lines.append(f"{t}:" + ("" if hits else " no pack in the Manager's list provides this type"))
        lines += ["  " + _row(pid, p) for pid, p in hits[:4]]
    return "\n".join(lines)


def _peek_results():
    """The Manager's own per-pack verdicts (same process). Best effort, read-only."""
    for mod in list(sys.modules.values()):
        if getattr(mod, "__name__", "").endswith("manager_server") and hasattr(mod, "nodepack_result"):
            try:
                return dict(getattr(mod, "nodepack_result") or {})
            except Exception:
                return {}
    return {}


async def _queue_status():
    return await loopback.get_json("/manager/queue/status", timeout=20)


async def act(action, ref, version_spec=None, poll=1.0, timeout=1200):
    if action not in ACTIONS:
        raise ToolError(f"action must be one of: {', '.join(ACTIONS)}.")
    await _require()
    pid, p = find_pack(await packs(refresh=True), ref)
    state = p.get("state") or "not-installed"
    if action == "install" and state != "not-installed":
        raise ToolError(f"{pid} is already installed ({state}). Use action update, enable or fix.")
    if action == "enable" and state != "disabled":
        raise ToolError(f"{pid} is not disabled (state: {state}).")
    if action in NEEDS_INSTALLED and state == "not-installed":
        raise ToolError(f"{pid} is not installed.")
    if (await _queue_status()).get("is_processing"):
        raise ToolError("ComfyUI-Manager is busy with other installs right now. Try again when it has finished.")

    body = dict(p)
    unknown = str(p.get("version")) == "unknown"
    body.update(selected_version="unknown" if unknown else (version_spec or "latest"), channel="default",
                mode="cache", ui_id=pid, skip_post_install=action == "enable")
    await loopback.request("POST", "/manager/queue/reset", json_body={})
    status, text = await loopback.request("POST", f"/manager/queue/{ACTIONS[action]}", json_body=body, timeout=120)
    if status == 403:
        raise ToolError("ComfyUI-Manager refused: its security_level does not allow this. The user can change "
                        "security_level in ComfyUI/user/__manager/config.ini (or install it from the Manager dialog).")
    if status == 404:
        raise ToolError("ComfyUI-Manager refused: at its current security level only packs from its default list "
                        "can be installed, and this one (or the requested version) is not on it.")
    if status != 200:
        raise ToolError(f"ComfyUI-Manager answered HTTP {status}: {text[:300]}")
    await loopback.request("POST", "/manager/queue/start", json_body={})

    deadline = time.time() + timeout
    await asyncio.sleep(poll)
    while (await _queue_status()).get("is_processing"):
        if time.time() > deadline:
            raise ToolError(f"{action} of {pid} is still running after {timeout}s; ask the user to watch the ComfyUI console.")
        await asyncio.sleep(poll)

    invalidate()
    verdict = str(_peek_results().get(pid, "")).strip()
    repo = _norm_url(p.get("repository"))
    names = {pid.lower(), str(p.get("id") or pid).lower()}  # list key and pack id differ for packs outside the registry

    def is_this_pack(folder, v):
        aux = str(v.get("aux_id") or "").lower()  # "author/repo" for git installs
        return (str(v.get("cnr_id") or "").lower() in names or folder.lower() in names
                or bool(aux and repo.endswith("/" + aux)))

    entry = next((v for k, v in (await installed()).items() if is_this_pack(k, v)), None)
    ok = {"install": bool(entry and entry.get("enabled", True)), "enable": bool(entry and entry.get("enabled", True)),
          "uninstall": entry is None, "disable": entry is None or not entry.get("enabled", True),
          "update": entry is not None, "fix": entry is not None}[action]
    if verdict and verdict.lower() not in ("success", "skip", "done") and action not in ("uninstall", "disable"):
        ok = False
    if not ok:
        raise ToolError(f"{action} of {pid} did not succeed{': ' + verdict if verdict else ''}. "
                        "The ComfyUI console has the full log.")
    done = {"install": f"installed {pid} {entry.get('ver', '') if entry else ''}".strip(), "enable": f"enabled {pid}",
            "uninstall": f"uninstalled {pid}", "disable": f"disabled {pid}",
            "update": f"updated {pid} (now {entry.get('ver', '?') if entry else '?'})", "fix": f"re-ran the install steps of {pid}"}[action]
    return (f"{done}. ComfyUI must RESTART before this takes effect: call restart_comfyui with a note of what to do "
            "afterwards (the user will be asked).")
