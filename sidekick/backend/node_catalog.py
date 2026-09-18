"""Searchable index over ComfyUI's /object_info. The raw dump is megabytes, so
the model only ever gets search hits and trimmed per-type details."""
import re
import time

from ..registry import ToolError
from . import loopback

CACHE_SECONDS = 300
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
MAX_OPTIONS = 8

_cache = {"at": 0.0, "info": None}


def invalidate():
    _cache["at"] = 0.0


async def get_info():
    if _cache["info"] is None or time.time() - _cache["at"] > CACHE_SECONDS:
        _cache["info"] = await loopback.get_json("/object_info")
        _cache["at"] = time.time()
    return _cache["info"]


# ---------- pure helpers (unit-tested) ----------

def iter_inputs(node):
    """Yield (name, type, opts, required, options_or_None) for visible inputs."""
    inp = node.get("input") or {}
    for section, required in (("required", True), ("optional", False)):
        for name, spec in (inp.get(section) or {}).items():
            if not isinstance(spec, (list, tuple)) or not spec:
                continue
            typ = spec[0]
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            options = None
            if isinstance(typ, list):  # legacy combo: the type *is* the option list
                options, typ = typ, "COMBO"
            elif typ == "COMBO":
                options = opts.get("options") or []
            yield name, str(typ), opts, required, options


def is_widget(typ, opts):
    return typ in WIDGET_TYPES and not opts.get("forceInput")


def outputs_of(node):
    types = node.get("output") or []
    names = node.get("output_name") or []
    out = []
    for i, t in enumerate(types):
        t = "COMBO" if isinstance(t, list) else str(t)
        out.append({"name": names[i] if i < len(names) else t, "type": t})
    return out


def _pack(node):
    mod = str(node.get("python_module") or "")
    if mod.startswith("custom_nodes."):
        return mod.split(".", 1)[1]
    return "core"  # nodes, comfy_extras.*, comfy_api_nodes.*


def _tokens(text):
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


def search(info, query, limit=12, category=None, input_type=None, output_type=None):
    toks = _tokens(query or "")
    q_compact = "".join(toks)
    hits = []
    for name, node in info.items():
        in_types = {t for _, t, o, _, _ in iter_inputs(node) if not is_widget(t, o)}
        out_types = {o["type"] for o in outputs_of(node)}
        if input_type and input_type.upper() not in in_types and "*" not in in_types:
            continue
        if output_type and output_type.upper() not in out_types and "*" not in out_types:
            continue
        cat = str(node.get("category") or "")
        if category and category.lower() not in cat.lower():
            continue
        lname = name.lower()
        display = str(node.get("display_name") or "").lower()
        desc = str(node.get("description") or "").lower()
        pack = _pack(node).lower()
        score = 0
        if q_compact and q_compact == re.sub(r"[^a-z0-9]", "", lname):
            score += 100
        for t in toks:
            hit = 0
            if t in lname:
                hit = 10
            elif t in display:
                hit = 8
            elif t in cat.lower():
                hit = 4
            elif t in pack:
                hit = 3
            elif t in desc:
                hit = 2
            if not hit:
                score = -1
                break
            score += hit
        if score < 0 or (toks and score == 0):
            continue
        if node.get("deprecated"):
            score -= 5
        if pack == "core":
            score += 1  # prefer built-ins on ties
        hits.append((score, -len(name), name, node))
    hits.sort(reverse=True)
    lines = []
    for _, _, name, node in hits[:max(1, min(int(limit or 12), 40))]:
        ins = sorted({t for _, t, o, _, _ in iter_inputs(node) if not is_widget(t, o)})
        outs = [o["type"] for o in outputs_of(node)]
        display = node.get("display_name") or name
        label = name if display == name else f"{name} ({display})"
        lines.append(f"{label} | {node.get('category', '')} | {_pack(node)} | "
                     f"in: {','.join(ins) or '-'} -> out: {','.join(outs) or '-'}")
    if not lines:
        return "No node types matched. Try fewer or different keywords."
    more = len(hits) - len(lines)
    return "\n".join(lines) + (f"\n…{more} more; refine the query." if more > 0 else "")


def describe(info, type_name):
    node = info.get(type_name)
    if node is None:
        close = [n for n in info if type_name.lower() in n.lower()][:8]
        raise ToolError(f"No node type '{type_name}'." +
                        (f" Did you mean: {', '.join(close)}?" if close else " Use search_node_types."))
    inputs = []
    for name, typ, opts, required, options in iter_inputs(node):
        d = {"name": name, "type": typ, "required": required, "widget": is_widget(typ, opts)}
        for k in ("default", "min", "max", "step", "multiline"):
            if k in opts:
                d[k] = opts[k]
        if options is not None:
            d["options"] = [str(o) for o in options[:MAX_OPTIONS]]
            if len(options) > MAX_OPTIONS:
                d["options_total"] = len(options)
                d["options_note"] = "truncated; use get_combo_options to search the full list"
        if opts.get("tooltip"):
            d["tooltip"] = str(opts["tooltip"])[:160]
        inputs.append(d)
    return {"type": type_name, "display_name": node.get("display_name") or type_name,
            "category": node.get("category", ""), "pack": _pack(node),
            "description": str(node.get("description") or "")[:300],
            "output_node": bool(node.get("output_node")),
            "inputs": inputs, "outputs": outputs_of(node)}


def combo_options(info, type_name, input_name, query=None, limit=40):
    node = info.get(type_name)
    if node is None:
        raise ToolError(f"No node type '{type_name}'.")
    for name, _, _, _, options in iter_inputs(node):
        if name == input_name:
            if options is None:
                raise ToolError(f"Input '{input_name}' of {type_name} is not a combo.")
            opts = [str(o) for o in options]
            if query:
                toks = _tokens(query)
                opts = [o for o in opts if all(t in o.lower() for t in toks)]
            limit = max(1, min(int(limit or 40), 200))
            return {"total_matching": len(opts), "options": opts[:limit]}
    raise ToolError(f"{type_name} has no input '{input_name}'.")
