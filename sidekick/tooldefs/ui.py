"""Tools that drive the ComfyUI interface itself (commands, workflow tabs).
Implemented in web/tools/commands.js and web/tools/workflow.js."""
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
    if action in ("list", "list_saved"):
        return "read"
    if action in ("new", "switch", "open"):
        return "edit"  # tabs keep their own state; nothing is lost
    return "risky"  # save (overwrites a file), close (may discard changes)


def register_all():
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
        "Work with workflow tabs and saved workflows. action: list (open tabs), new (blank tab), "
        "switch (to an open tab), list_saved (saved workflow files), open (a saved workflow by "
        "path), save (the active tab), close (a tab).",
        {"action": {"type": "string",
                    "enum": ["list", "new", "switch", "list_saved", "open", "save", "close"]},
         "target": {"type": "string", "description": "switch/close/open: tab filename, path, or "
                    "part of it. Default for close: the active tab."},
         "query": {"type": "string", "description": "list_saved: filter by name."}},
        ["action"], risk="risky", risk_fn=tabs_risk))
