// Workflow tabs and saved workflows. Risk per action is decided in sidekick/tooldefs/ui.py.
import { app, ToolError, tick } from "./graphCtx.js";

const store = () => {
  const s = app.extensionManager?.workflow;
  if (!s) throw new ToolError("This ComfyUI frontend does not expose the workflow store.");
  return s;
};

const isActive = (w) => w === store().activeWorkflow || (w?.path && w.path === store().activeWorkflow?.path);

function row(w) {
  const flags = [isActive(w) ? "ACTIVE" : "", w.isModified ? "modified" : "", w.isPersisted === false ? "never saved" : ""].filter(Boolean).join(", ");
  return `${w.filename ?? w.path} | ${w.path}${flags ? " | " + flags : ""}`;
}

function listOpen() {
  const open = store().openWorkflows ?? [];
  return [`open tabs (${open.length}): name | path | flags`, ...open.map(row)].join("\n");
}

function pick(list, target, what) {
  if (!target) throw new ToolError(`target is required (${what} name or path).`);
  const want = String(target).toLowerCase();
  const exact = list.filter((w) => [w.path, w.filename, w.fullFilename].some((v) => String(v ?? "").toLowerCase() === want));
  const hits = exact.length ? exact : list.filter((w) => String(w.path ?? "").toLowerCase().includes(want));
  if (hits.length === 1) return hits[0];
  const names = list.slice(0, 30).map((w) => w.path).join(", ") || "(none)";
  throw new ToolError(`${hits.length ? "Several match" : "Nothing matches"} "${target}". Available: ${names}`);
}

/** What the frontend's own workflowService.openWorkflow does: load if needed, then load the
 *  tab's live state into the canvas bound to that workflow (the previous tab's state is kept). */
async function activate(w) {
  if (isActive(w)) return;
  if (!w.isLoaded) await w.load();
  const state = JSON.parse(JSON.stringify(w.activeState ?? w.initialState));
  await app.loadGraphData(state, true, true, w);
  await tick(150);
}

const saved = () => {
  const s = store();
  return s.persistedWorkflows ?? (s.workflows ?? []).filter((w) => w.isPersisted);
};

export async function workflowTabs({ action = "list", target, query } = {}) {
  const run = (id) => app.extensionManager.command.execute(id);
  switch (action) {
    case "list":
      return listOpen();
    case "new":
      await run("Comfy.NewBlankWorkflow");
      await tick(200);
      return "opened a new blank workflow tab\n" + listOpen();
    case "switch": {
      await activate(pick(store().openWorkflows ?? [], target, "open tab"));
      return listOpen();
    }
    case "list_saved": {
      try { await store().syncWorkflows?.(); } catch { /* listing what is cached is still useful */ }
      const q = String(query ?? "").toLowerCase();
      const rows = saved().filter((w) => !q || String(w.path).toLowerCase().includes(q));
      if (!rows.length) return q ? `No saved workflow matches "${query}".` : "No saved workflows.";
      return [`saved workflows (${rows.length}):`, ...rows.slice(0, 80).map((w) => w.path), rows.length > 80 ? `…${rows.length - 80} more; use query.` : ""].filter(Boolean).join("\n");
    }
    case "open": {
      await activate(pick(saved(), target, "saved workflow"));
      return listOpen();
    }
    case "save": {
      const w = store().activeWorkflow;
      await run("Comfy.SaveWorkflow");
      await tick(300);
      return w?.isPersisted === false
        ? "Save started. This workflow was never saved, so ComfyUI is now asking the user for a file name — tell them to confirm the dialog."
        : `saved ${w?.path ?? "workflow"}`;
    }
    case "close": {
      if (target) await activate(pick(store().openWorkflows ?? [], target, "open tab"));
      const w = store().activeWorkflow;
      await run("Workspace.CloseWorkflow");
      await tick(300);
      return (w?.isModified ? "Close started; the tab had unsaved changes, so ComfyUI may be asking the user what to do.\n" : "") + listOpen();
    }
    default:
      throw new ToolError(`Unknown action "${action}". Use: list, new, switch, list_saved, open, save, close.`);
  }
}
