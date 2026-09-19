"""LLM-facing definitions of the graph tools. Frontend tools are implemented in
web/tools/*.js under the same names; catalog tools run here."""
from ..backend import node_catalog
from ..registry import Tool, register

# No "type" on these two: they accept integer or string, and union types
# (["integer","string"]) are rejected by some OpenAI-compatible providers.
NODE_REF = {"description": "Node id (integer), or inside edit_graph a \"$ref\" string of a node "
                           "added earlier in the batch."}
SLOT = {"description": "Slot name (string, preferred) or index (integer)."}
POS = {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2,
       "description": "[x, y] canvas position."}

ADD_NODE = {
    "type": {"type": "string", "description": "Exact node class name from search_node_types."},
    "title": {"type": "string"},
    "pos": POS,
    "near": {"type": "object", "description": "Place next to another node instead of pos.",
             "properties": {"node_id": NODE_REF,
                            "side": {"type": "string", "enum": ["right", "left", "below", "above"]}},
             "required": ["node_id"]},
    "group_id": {"type": "integer", "description": "Place the node inside this group (first free "
                 "spot); the group grows if needed. Instead of pos/near."},
    "widgets": {"type": "object", "description": "Widget values to set, e.g. {\"cfg\": 5, \"text\": \"a cat\"}."},
}
ARRANGE = {
    "node_ids": {"type": "array", "items": NODE_REF, "minItems": 1},
    "direction": {"type": "string", "enum": ["row", "column", "grid"],
                  "description": "row = left to right, column = top to bottom, grid = wrap into columns."},
    "columns": {"type": "integer", "description": "Grid only. Default: about square."},
    "gap": {"type": "number", "description": "Pixels between nodes. Default 40."},
    "origin": POS,
    "fit_group_id": {"type": "integer", "description": "Afterwards refit this group around the nodes."},
}
CONNECT = {
    "from_node": NODE_REF, "from_output": SLOT, "to_node": NODE_REF, "to_input": SLOT,
}
DISCONNECT = {"node_id": NODE_REF, "input": SLOT, "output": SLOT}
SET_WIDGETS = {"node_id": NODE_REF,
               "values": {"type": "object", "description": "{widget_name: value, …}"}}
UPDATE_NODE = {
    "node_id": NODE_REF, "title": {"type": "string"},
    "mode": {"type": "string", "enum": ["active", "muted", "bypassed"]},
    "collapsed": {"type": "boolean"}, "pinned": {"type": "boolean"},
    "color": {"type": "string", "description": "Title color, CSS hex. Empty string resets."},
    "bgcolor": {"type": "string"}, "pos": POS,
    "size": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
}
REMOVE_NODES = {"node_ids": {"type": "array", "items": NODE_REF}}
CREATE_GROUP = {
    "title": {"type": "string"},
    "node_ids": {"type": "array", "items": NODE_REF,
                 "description": "Group is fitted around these nodes (with padding)."},
    "bounds": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4,
               "description": "[x, y, w, h]; only when node_ids is not given."},
    "color": {"type": "string", "description": "CSS hex, e.g. #3f789e."},
    "font_size": {"type": "number"},
}
UPDATE_GROUP = dict(CREATE_GROUP, group_id={"type": "integer"},
                    fit_to_contents={"type": "boolean",
                                     "description": "Refit the box around the nodes currently inside it."})
REMOVE_GROUP = {"group_id": {"type": "integer"},
                "remove_nodes": {"type": "boolean", "description": "Also delete the nodes inside."}}

_OPS = {
    "add_node": (ADD_NODE, ["type"]), "connect": (CONNECT, ["from_node", "to_node"]),
    "disconnect": (DISCONNECT, ["node_id"]), "set_widgets": (SET_WIDGETS, ["node_id", "values"]),
    "update_node": (UPDATE_NODE, ["node_id"]), "remove_nodes": (REMOVE_NODES, ["node_ids"]),
    "create_group": (CREATE_GROUP, ["title"]), "update_group": (UPDATE_GROUP, ["group_id"]),
    "remove_group": (REMOVE_GROUP, ["group_id"]),
    "arrange_nodes": (ARRANGE, ["node_ids"]),
}


async def _search(ctx, a):
    info = await node_catalog.get_info()
    return node_catalog.search(info, a.get("query", ""), a.get("limit", 12), a.get("category"),
                               a.get("input_type"), a.get("output_type"))


async def _describe(ctx, a):
    return node_catalog.describe(await node_catalog.get_info(), a["type"])


async def _combo(ctx, a):
    return node_catalog.combo_options(await node_catalog.get_info(), a["type"], a["input"],
                                      a.get("query"), a.get("limit", 40))


def register_all():
    # ---- read ----
    register(Tool(
        "get_workflow",
        "Outline of the workflow open on the canvas: groups, nodes, links, widget values. Detail is "
        "reduced automatically so the whole graph always fits (the first line says which level you "
        "got): full = positions + widget values; outline = ids, types, titles, links; index = node "
        "lists per group. On big graphs narrow with group / query / node_ids to get full detail of "
        "one area, and re-check edits with those filters instead of re-reading everything.",
        {"node_ids": {"type": "array", "items": NODE_REF, "description": "Only these nodes."},
         "group": {"description": "Only nodes inside this group (group id or part of its title)."},
         "query": {"type": "string", "description": "Only nodes whose title or type contains this text."},
         "detail": {"type": "string", "enum": ["auto", "full", "outline", "index"],
                    "description": "Default auto: the most detailed level that fits."},
         "include_widgets": {"type": "boolean", "description": "Default true (full detail only)."}},
        max_chars=48000))
    register(Tool(
        "get_node", "Full detail of one or several nodes on the canvas: every input/output slot "
        "with type and links, every widget with type, value and allowed options. Pass node_ids to "
        "inspect up to 25 nodes in ONE call instead of calling this repeatedly.",
        {"node_id": NODE_REF, "node_ids": {"type": "array", "items": NODE_REF, "maxItems": 25}},
        max_chars=48000))
    register(Tool(
        "trace_connections",
        "Follow links from a node: everything upstream (what feeds it), downstream (what it "
        "feeds) or both, as a list of node ids, types and titles with their hop distance. Use it to "
        "find 'everything related to X' before removing or rewiring a chain.",
        {"node_id": NODE_REF,
         "direction": {"type": "string", "enum": ["upstream", "downstream", "both"]},
         "depth": {"type": "integer", "description": "Max hops, default 6."}},
        ["node_id"]))
    register(Tool(
        "search_node_types",
        "Search installed node types by keywords. Returns: class name | category | pack | socket types. "
        "Optionally filter by a socket type the node must accept or produce.",
        {"query": {"type": "string"}, "limit": {"type": "integer"}, "category": {"type": "string"},
         "input_type": {"type": "string", "description": "e.g. IMAGE"},
         "output_type": {"type": "string", "description": "e.g. LATENT"}},
        ["query"], side="backend", handler=_search))
    register(Tool(
        "get_node_type", "Definition of a node type: inputs (socket or widget, defaults, ranges, "
        "first combo options) and outputs. Use before add_node when unsure of names.",
        {"type": {"type": "string"}}, ["type"], side="backend", handler=_describe))
    register(Tool(
        "get_combo_options", "Search the full option list of a combo input (models, samplers, …).",
        {"type": {"type": "string"}, "input": {"type": "string"},
         "query": {"type": "string"}, "limit": {"type": "integer"}},
        ["type", "input"], side="backend", handler=_combo))

    # ---- edit (live, one undo step per call) ----
    register(Tool("add_node", "Add a node to the canvas. Returns its id, slots and widgets.",
                  ADD_NODE, ["type"], risk="edit"))
    register(Tool(
        "connect_nodes", "Link an output to an input. Omit from_output/to_input to auto-match by "
        "type. On failure the reply lists every slot so you can retry precisely.",
        CONNECT, ["from_node", "to_node"], risk="edit"))
    register(Tool("disconnect", "Remove the link(s) on one input or one output slot of a node.",
                  DISCONNECT, ["node_id"], risk="edit"))
    register(Tool(
        "set_widget_values", "Set widget values on a node (numbers, text boxes, combos, toggles). "
        "Combo values must be exact options; the reply shows the values actually applied.",
        SET_WIDGETS, ["node_id", "values"], risk="edit"))
    register(Tool("update_node", "Change node title, mode (active/muted/bypassed), collapsed, "
                  "pinned, colors, position or size.", UPDATE_NODE, ["node_id"], risk="edit"))
    register(Tool("remove_nodes", "Delete nodes (their links go with them).",
                  REMOVE_NODES, ["node_ids"], risk="edit"))
    register(Tool("create_group", "Create a titled group box around nodes (or at explicit bounds).",
                  CREATE_GROUP, ["title"], risk="edit"))
    register(Tool("update_group", "Rename, recolor, refit or move a group.",
                  UPDATE_GROUP, ["group_id"], risk="edit"))
    register(Tool("remove_group", "Delete a group box (nodes stay unless remove_nodes).",
                  REMOVE_GROUP, ["group_id"], risk="edit"))
    register(Tool(
        "arrange_nodes", "Tidy nodes into a row, column or grid using their real sizes (no manual "
        "coordinate math, no overlaps). Optionally refit a group around them afterwards. Use this "
        "to put nodes neatly inside a group or to make a group horizontal/vertical.",
        ARRANGE, ["node_ids"], risk="edit"))
    register(Tool(
        "edit_graph",
        "Apply many edits in one call and ONE undo step. Each operation is {\"op\": <name>, …args} "
        "with the same args as the single tools; ops: " + ", ".join(_OPS) + ". Give add_node a "
        "\"ref\" (e.g. \"ksampler\") and use \"$ksampler\" as a node id in later operations. Stops at "
        "the first failing operation and reports per-operation results.",
        {"operations": {"type": "array", "items": {
            "type": "object",
            "properties": {"op": {"type": "string", "enum": list(_OPS)},
                           "ref": {"type": "string"}},
            "required": ["op"], "additionalProperties": True}}},
        ["operations"], risk="edit", timeout=120))
