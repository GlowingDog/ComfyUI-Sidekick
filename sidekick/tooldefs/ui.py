"""Tools that drive the ComfyUI interface itself: screenshots, commands, workflow tabs and
templates, subgraphs, right-click menus, settings, running the workflow.
Implemented in web/tools/{vision,commands,workflow,subgraph,menus,settings,run}.js."""
import re

from ..registry import Tool, register

# Commands that only change the view, navigate, or start work the user can stop.
# Everything else (clear/close/save/export/delete, unknown third-party commands)
# goes through the permission card.
_SAFE_COMMANDS = re.compile(
    r"^(Comfy\.Canvas\.(FitView|ResetView|ZoomIn|ZoomOut|ToggleMinimap|ToggleLinkVisibility|"
    r"SelectAll|Lock|Unlock|ToggleLock|ToggleSelectedNodes\.\w+|ToggleSelected\.Pin|"
    r"MoveSelectedNodes\.\w+)"
    r"|Comfy\.(NewBlankWorkflow|OpenWorkflow|BrowseTemplates|Undo|Redo|QueuePrompt|QueuePromptFront|"
    r"QueueSelectedOutputNodes|Interrupt|RefreshNodeDefinitions|ShowSettingsDialog|OpenManagerDialog|"
    r"ToggleTheme|ToggleCanvasInfo|ToggleHelpCenter|OpenClipspace|DuplicateWorkflow)"
    r"|Comfy\.Graph\.(GroupSelectedNodes|FitGroupToContents|ConvertToSubgraph|UnpackSubgraph|ExitSubgraph)"
    r"|Comfy\.Queue\.ToggleOverlay"
    r"|Comfy\.Manager\.(CustomNodesManager\.\w+|ShowMissingPacks|ShowUpdateAvailablePacks|Menu\.ToggleVisibility)"
    r"|Workspace\.(ToggleSidebarTab\.[\w-]+|ToggleBottomPanel(\.\w+)?|ToggleFocusMode|SearchBox\.Toggle|"
    r"NextOpenedWorkflow|PreviousOpenedWorkflow))$")


def command_risk(args):
    return "edit" if _SAFE_COMMANDS.match(str(args.get("id") or "")) else "risky"


def tabs_risk(args):
    action = str(args.get("action") or "list")
    if action in ("list", "list_saved", "list_templates"):
        return "read"
    if action in ("new", "switch", "open", "open_template"):
        return "edit"  # tabs keep their own state; nothing is lost
    return "risky"  # save (overwrites a file), close (may discard changes)


def menu_risk(args):
    # Listing walks submenus only; invoking runs whatever the entry does (graph edits are one
    # undo step; a node pack's entry can do more, like any button the user could click).
    return "edit" if str(args.get("action") or "list") == "invoke" else "read"


def settings_risk(args):
    action = args.get("action") or ("set" if "value" in args else "get" if "id" in args else "search")
    # A setting outlives the workflow and Ctrl+Z does not bring it back: always ask.
    return "read" if action in ("search", "get") else "risky"


def register_all():
    register(Tool(
        "screenshot",
        "LOOK at ComfyUI. target \"graph\" (default): picture of the node graph framed on node_ids, "
        "a group, or the whole workflow — rendered off-screen, the user's view does not move. "
        "target \"viewport\": the canvas exactly as the user sees it now. target \"ui\": the whole "
        "browser tab (dialogs, menus, Manager, sidebar, image previews); the user must allow tab "
        "sharing once. Use it to check layout and overlaps after arranging, to see generated "
        "images or previews, and when the user talks about how something looks. For facts "
        "(values, links, types) the text tools are cheaper and exact.",
        {"target": {"type": "string", "enum": ["graph", "viewport", "ui"]},
         "node_ids": {"type": "array", "items": {"description": "Node id."},
                      "description": "graph: frame these nodes."},
         "group": {"description": "graph: frame this group (id or part of its title)."}},
        confirm=True, timeout=180,
        confirm_note="Screenshots are sent to the AI provider you selected. They can include "
                     "image previews shown on your nodes; \"ui\" captures this whole browser tab."))
    register(Tool(
        "list_commands",
        "Search ComfyUI's command registry (menu actions, keyboard-shortcut actions, sidebar/panel "
        "toggles, Manager dialogs, commands added by node packs). Returns id | label | source.",
        {"query": {"type": "string", "description": "Words to look for in id or label."},
         "limit": {"type": "integer"}}))
    register(Tool(
        "run_command",
        "Run a ComfyUI command by id (from list_commands): open/close panels and sidebar tabs, fit "
        "view, new blank workflow, queue prompt, open the Manager, browse templates, undo/redo, act "
        "on the current selection, … View, navigation and queue commands run directly; destructive "
        "or unknown ones ask the user first.",
        {"id": {"type": "string", "description": "Exact command id, e.g. Comfy.Canvas.FitView"}},
        ["id"], risk="risky", risk_fn=command_risk))
    register(Tool(
        "workflow_tabs",
        "Work with workflow tabs, saved workflows and the template library. action: list (open "
        "tabs), new (blank tab), switch (to an open tab), list_saved (saved workflow files), open "
        "(a saved workflow by path), list_templates (ready-made workflows shipped with ComfyUI and "
        "with node packs; pass query), open_template (by name, in a new tab), save (the active "
        "tab), close (a tab). Starting from a template is usually better than building a standard "
        "pipeline from nothing.",
        {"action": {"type": "string",
                    "enum": ["list", "new", "switch", "list_saved", "open", "list_templates",
                             "open_template", "save", "close"]},
         "target": {"type": "string", "description": "switch/close/open: tab filename, path, or "
                    "part of it (default for close: the active tab). open_template: template name."},
         "query": {"type": "string", "description": "list_saved / list_templates: filter words."}},
        ["action"], risk="risky", risk_fn=tabs_risk))
    register(Tool(
        "load_workflow",
        "Load workflow JSON into a NEW tab (the current tab is untouched). Accepts a saved "
        "workflow ({\"nodes\": [...], \"links\": [...]}) or an API-format prompt ({\"3\": "
        "{\"class_type\": …, \"inputs\": …}}), which is laid out automatically. Reports node types "
        "this ComfyUI is missing. For saved files use workflow_tabs open; to build or change a "
        "graph use the edit tools.",
        {"workflow": {"type": "object", "description": "The workflow JSON."},
         "name": {"type": "string", "description": "Tab name."}},
        ["workflow"], risk="edit", timeout=120))
    register(Tool(
        "subgraph",
        "Subgraphs are nodes that contain a graph (shown as type subgraph[N nodes inside]). Every "
        "tool works on the graph shown on the canvas, so to read or edit inside one, enter it. "
        "action: list (all subgraphs with their path ids), enter (node_id: a subgraph node on the "
        "canvas, or a path from the root like \"57:12\"), exit (up one level), root. Errors name "
        "inner nodes as \"<subgraph node id>:<inner id>\".",
        {"action": {"type": "string", "enum": ["list", "enter", "exit", "root"]},
         "node_id": {"description": "enter: subgraph node id, or a path like \"57:12\"."}},
        ["action"]))
    register(Tool(
        "context_menu",
        "The right-click menus of a node, a group or the canvas, including every entry node packs "
        "add (e.g. rgthree, Impact, KJNodes helpers, 'Convert to Subgraph', 'Colors', 'Shapes', "
        "'Bypass', 'Add Node'). action list shows the entries at path (▸ marks a submenu; pass the "
        "path to look inside it); action invoke clicks the entry at the end of path, e.g. "
        "[\"Colors\", \"red\"] or [\"Mode\", \"Never\"]. Graph changes are one undo step. Entries "
        "that open a text dialog need the user. Prefer the dedicated tools when one exists "
        "(update_node for mode/colour/title, remove_nodes, …); use this for pack-specific actions.",
        {"target": {"type": "string", "enum": ["node", "group", "canvas"]},
         "node_id": {"description": "target node: the node id."},
         "group_id": {"type": "integer", "description": "target group: the group id."},
         "pos": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2,
                 "description": "target canvas: [x, y] where the click lands (default: view centre)."},
         "path": {"type": "array", "items": {"type": "string"},
                  "description": "Entry labels from the top menu down. Empty = the top menu."},
         "action": {"type": "string", "enum": ["list", "invoke"]}},
        risk="edit", risk_fn=menu_risk))
    register(Tool(
        "settings",
        "ComfyUI's settings (the Settings dialog): link style, snapping, minimap, preview method, "
        "queue behaviour, node search, settings of node packs, … action search (words in id / name "
        "/ category) lists id | name | type | value | options; get shows one; set changes one "
        "(asks the user first: settings persist and are not covered by undo).",
        {"action": {"type": "string", "enum": ["search", "get", "set"]},
         "query": {"type": "string"}, "id": {"type": "string", "description": "Exact setting id."},
         "value": {"description": "set: the new value (boolean, number, or option text)."},
         "limit": {"type": "integer"}},
        risk="risky", risk_fn=settings_risk))
    register(Tool(
        "queue_prompt",
        "Run the workflow on the canvas (same as the Run button) and, by default, wait for the "
        "result. If ComfyUI rejects the workflow you get the validation errors per node (missing "
        "inputs, bad values, missing models) — fix them and queue again. On completion you get "
        "success / error (failing node, exception, traceback tail) / interrupted, and the output "
        "files per node. Long runs return \"still running\" with a prompt_id for "
        "wait_for_execution. Stop a run with run_command Comfy.Interrupt.",
        {"wait": {"type": "boolean", "description": "Default true."},
         "timeout_s": {"type": "integer", "description": "How long to wait, default 120, max 900."},
         "batch_count": {"type": "integer", "description": "Queue it this many times (default 1)."},
         "front": {"type": "boolean", "description": "Put it at the front of the queue."}},
        risk="edit", timeout=960))
    register(Tool(
        "wait_for_execution",
        "Wait for a queued or running prompt to finish and report the result (same report as "
        "queue_prompt). Without prompt_id: whatever is running now, else the last finished run — "
        "use it to read the error of a run the user started themselves.",
        {"prompt_id": {"type": "string"},
         "timeout_s": {"type": "integer", "description": "Default 120, max 900."}},
        timeout=960))
