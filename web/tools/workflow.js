// Workflow tabs, saved workflows, templates and loading workflow JSON. Everything that opens a
// workflow opens it in its OWN tab: the tab the user was on keeps its state.
// Risk per action is decided in sidekick/tooldefs/ui.py.
import { app, ToolError, allNodes, tick, withUndo } from "./graphCtx.js";
import { api } from "../../../scripts/api.js";
import { autoLayout } from "./autoLayout.js";

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

// ---------- templates ----------

let templateCache = null;

async function templates() {
  if (templateCache) return templateCache;
  const rows = [];
  try { // the template library that ships with ComfyUI
    const index = await (await fetch(api.fileURL("/templates/index.json"))).json();
    for (const cat of index ?? []) {
      for (const t of cat.templates ?? []) {
        rows.push({ name: t.name, title: t.title ?? t.name, category: cat.title ?? "", description: t.description ?? "", url: api.fileURL(`/templates/${t.name}.json`) });
      }
    }
  } catch { /* an old frontend without the index: node-pack templates may still exist */ }
  try { // example workflows shipped by node packs
    for (const [pack, names] of Object.entries((await api.getWorkflowTemplates()) ?? {})) {
      for (const n of names ?? []) rows.push({ name: n, title: n, category: `node pack ${pack}`, description: "", url: api.apiURL(`/workflow_templates/${pack}/${n}.json`) });
    }
  } catch { /* none */ }
  if (rows.length) templateCache = rows;
  return rows;
}

async function listTemplates(query) {
  const toks = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (await templates()).filter((t) => toks.every((k) => `${t.name} ${t.title} ${t.category} ${t.description}`.toLowerCase().includes(k)));
  if (!rows.length) return toks.length ? `No template matches "${query}". Try fewer words, e.g. "flux", "upscale", "inpaint", "video".` : "This ComfyUI has no templates.";
  const lines = rows.slice(0, 40).map((t) => `${t.name} | ${t.title} | ${t.category}${t.name.startsWith("api_") ? " | needs a paid Comfy API account" : ""}${t.description ? " | " + t.description.slice(0, 90) : ""}`);
  return [`templates (${rows.length}${toks.length ? "" : "; pass query to narrow"}): name | title | category | about`, ...lines, rows.length > 40 ? `…${rows.length - 40} more; refine the query.` : ""].filter(Boolean).join("\n");
}

/** Node types the open workflow uses but this ComfyUI does not have (red nodes), subgraphs included. */
export function missingNodeTypes() {
  const known = window.LiteGraph?.registered_node_types ?? {};
  const found = new Set();
  const walk = (g, depth) => {
    for (const n of g?._nodes ?? []) {
      if (n.isSubgraphNode?.()) { if (depth < 8) walk(n.subgraph, depth + 1); } else if (n.type && !(n.type in known)) found.add(n.type);
    }
  };
  walk(app.rootGraph ?? app.graph, 0);
  return [...found];
}
const missingTypes = missingNodeTypes;

function loadedReport(what) {
  const missing = missingTypes();
  const tab = store().activeWorkflow;
  return `${what}: ${JSON.stringify(tab?.filename ?? tab?.path ?? "?")} is now the active tab (${(store().openWorkflows ?? []).length} open), ${allNodes().length} nodes on the canvas.` + (missing.length
    ? `\nMISSING node types (red nodes; the pack that provides them is not installed): ${missing.slice(0, 25).join(", ")}`
    : "") + "\nIf ComfyUI shows a dialog about missing models or nodes, the user has to close it.";
}

/** A tab name that cannot collide with a saved file (loading under a saved name would bind the
 *  new content to that file, and the next save would overwrite it). */
function freeName(wanted) {
  const base = String(wanted || "Sidekick workflow").replace(/\.json$/i, "").replace(/[\\/:*?"<>|]/g, " ").trim() || "Sidekick workflow";
  const taken = new Set([...(store().workflows ?? []), ...(store().openWorkflows ?? [])].map((w) => String(w.filename ?? "").toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
  return name;
}

async function openTemplate(target) {
  if (!target) throw new ToolError("target is required: a template name from list_templates.");
  const all = await templates();
  const want = String(target).toLowerCase();
  const exact = all.filter((t) => t.name.toLowerCase() === want || t.title.toLowerCase() === want);
  const hits = exact.length ? exact : all.filter((t) => `${t.name} ${t.title}`.toLowerCase().includes(want));
  if (hits.length !== 1 && !exact.length) throw new ToolError(`${hits.length ? "Several templates match" : "No template matches"} "${target}"${hits.length ? ": " + hits.slice(0, 12).map((t) => t.name).join(", ") : ""}. Use list_templates.`);
  const t = hits[0];
  const res = await fetch(t.url);
  if (!res.ok) throw new ToolError(`Template ${t.name}: HTTP ${res.status}`);
  await app.loadGraphData(await res.json(), true, true, freeName(t.title));
  await tick(300);
  return loadedReport(`opened template "${t.title}" (${t.name}) in a new tab`);
}

export async function loadWorkflow({ workflow, name } = {}) {
  let data = workflow;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) { throw new ToolError(`workflow is not valid JSON: ${e.message}`); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ToolError("workflow must be a JSON object: a saved ComfyUI workflow, or an API-format prompt.");
  if (data.prompt && data.workflow === undefined && !data.nodes) data = data.prompt; // {"prompt": {...}} as POSTed to /prompt
  if (Array.isArray(data.nodes)) {
    await app.loadGraphData(data, true, true, freeName(name));
    await tick(300);
    return loadedReport("loaded the workflow in a new tab");
  }
  const entries = Object.entries(data);
  if (!entries.length || !entries.every(([, v]) => v && typeof v === "object" && typeof v.class_type === "string")) {
    throw new ToolError('Unrecognised workflow JSON. Expected a saved workflow ({"nodes": [...], "links": [...]}) or an API-format prompt ({"3": {"class_type": "KSampler", "inputs": {...}}, …}).');
  }
  const known = window.LiteGraph?.registered_node_types ?? {};
  const unknown = [...new Set(entries.map(([, v]) => v.class_type).filter((t) => !(t in known)))];
  if (unknown.length) throw new ToolError(`Not loaded: this ComfyUI does not have these node types: ${unknown.slice(0, 25).join(", ")}. Install the packs that provide them, or replace the nodes.`);
  await app.loadApiJson(data, freeName(name));
  await tick(300);
  let tidy = "";
  try { // API-format JSON has no positions
    const plan = await withUndo(() => autoLayout({}));
    tidy = ` and tidied (${plan.columns} columns)`;
  } catch { /* an empty or odd graph: leave it as ComfyUI arranged it */ }
  return loadedReport(`loaded the API-format prompt in a new tab${tidy}`);
}

export async function workflowTabs({ action = "list", target, query } = {}) {
  const run = (id) => app.extensionManager.command.execute(id);
  switch (action) {
    case "list_templates":
      return listTemplates(query ?? target);
    case "open_template":
      return openTemplate(target);
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
      throw new ToolError(`Unknown action "${action}". Use: list, new, switch, list_saved, open, list_templates, open_template, save, close.`);
  }
}
