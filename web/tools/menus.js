// Right-click menus without a mouse: node, group and canvas context menus, including everything
// node packs add to them. LiteGraph opens a submenu by calling `new LiteGraph.ContextMenu(...)`
// from the parent entry's callback, so while a path is walked that constructor is swapped for a
// recorder: nothing is drawn, and the entries of every menu that "opens" are captured.
import { app, ToolError, nodeById, groupById, groupRect, tick, withUndo } from "./graphCtx.js";
import { describeEntries, entryLabel, findEntry, opensMenu } from "./menuMatch.js";

const given = (v) => v !== undefined && v !== null && v !== "";

async function withRecorder(fn) {
  const LG = window.LiteGraph;
  if (!LG?.ContextMenu) throw new ToolError("This ComfyUI frontend does not expose LiteGraph.ContextMenu.");
  const Real = LG.ContextMenu;
  const opened = [];
  function Recorder(values, options) {
    this.values = values ?? [];
    this.options = options ?? {};
    this.parentMenu = this.options.parentMenu;
    this.root = document.createElement("div"); // callbacks may poke at the menu element
    opened.push(this);
  }
  Recorder.prototype.close = function () {};
  Recorder.prototype.addItem = function () {};
  Recorder.prototype.getTopMenu = function () { return this.parentMenu?.getTopMenu?.() ?? this; };
  Recorder.prototype.getFirstEvent = function () { return this.parentMenu?.getFirstEvent?.() ?? this.options.event; };
  LG.ContextMenu = Recorder;
  try {
    return await fn(opened);
  } finally {
    LG.ContextMenu = Real;
  }
}

/** A right-click at a graph position (LiteGraph reads clientX/Y and canvasX/Y off the event). */
function eventAt(graphPos) {
  const c = app.canvas, r = c.canvas.getBoundingClientRect();
  const e = new MouseEvent("contextmenu", {
    clientX: (graphPos[0] + c.ds.offset[0]) * c.ds.scale + r.left,
    clientY: (graphPos[1] + c.ds.offset[1]) * c.ds.scale + r.top,
    cancelable: true,
  });
  e.canvasX = graphPos[0];
  e.canvasY = graphPos[1];
  return e;
}

/** What LiteGraph does when an entry is clicked: menu callback, entry callback, declared submenu. */
async function click(menu, v, event) {
  const el = document.createElement("div");
  el.value = v;
  const results = [];
  try {
    if (typeof menu.options.callback === "function") results.push(menu.options.callback.call(el, v, menu.options, event, menu, menu.options.node));
    if (v && typeof v === "object") {
      if (typeof v.callback === "function" && !menu.options.ignore_item_callbacks && v.disabled !== true) {
        results.push(v.callback.call(el, v, menu.options, event, menu, menu.options.extra));
      }
      if (v.submenu) {
        if (!v.submenu.options) throw new ToolError(`"${entryLabel(v)}" declares a submenu without entries.`);
        new window.LiteGraph.ContextMenu(v.submenu.options, {
          callback: v.submenu.callback, event, parentMenu: menu, title: v.submenu.title,
          ignore_item_callbacks: v.submenu.ignore_item_callbacks, extra: v.submenu.extra,
        });
      }
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`"${entryLabel(v)}" failed: ${e?.message ?? e}`);
  }
  const running = results.filter((r) => r && typeof r.then === "function");
  if (!running.length) return "done";
  // An entry that opens a dialog and awaits the user would hang the tool: give it a moment only.
  return Promise.race([Promise.allSettled(running).then(() => "done"), tick(1500).then(() => "waiting")]);
}

function openTop({ target, node_id, group_id, pos }) {
  const c = app.canvas;
  // LiteGraph's own entries (Mode, Colors, Shapes, …) act through LGraphCanvas.active_canvas,
  // which only a real mouse event sets.
  const LGC = window.LGraphCanvas ?? window.LiteGraph?.LGraphCanvas;
  if (LGC) LGC.active_canvas = c;
  if (target === "node") {
    const node = nodeById(node_id);
    c.deselectAll?.(); // a right-click selects the node first; several entries act on the selection
    if (typeof c.select === "function") c.select(node); else c.selectNode?.(node, false);
    const event = eventAt([node.pos[0] + 10, node.pos[1] + 10]);
    return { event, where: `node ${node.id} (${node.isSubgraphNode?.() ? "subgraph" : node.type})`, values: c.getNodeMenuOptions(node), options: { event, extra: node } };
  }
  if (target === "group") {
    const group = groupById(group_id);
    const r = groupRect(group);
    const event = eventAt([r[0] + 10, r[1] + 10]);
    return { event, where: `group #${group.id} ${JSON.stringify(group.title)}`, values: c.getGroupMenuOptions(group), options: { event, extra: group } };
  }
  if (target === "canvas") {
    const area = c.ds.visible_area ?? [0, 0, 0, 0];
    const at = Array.isArray(pos) ? [Number(pos[0]) || 0, Number(pos[1]) || 0] : [area[0] + area[2] / 2, area[1] + area[3] / 2];
    const event = eventAt(at);
    return { event, where: "canvas", values: c.getCanvasMenuOptions(), options: { event } };
  }
  throw new ToolError('target must be "node", "group" or "canvas".');
}

export async function contextMenu(args = {}) {
  const action = args.action ?? "list";
  if (!["list", "invoke"].includes(action)) throw new ToolError('action must be "list" or "invoke".');
  const steps = Array.isArray(args.path) ? args.path.map(String) : given(args.path) ? [String(args.path)] : [];
  if (action === "invoke" && !steps.length) throw new ToolError('invoke needs a path, e.g. ["Mode", "Never"]. List the menu first.');

  const run = () => withRecorder(async (opened) => {
    const top = openTop({ ...args, target: args.target ?? (given(args.group_id) ? "group" : given(args.node_id) ? "node" : "canvas") });
    let menu = new window.LiteGraph.ContextMenu(top.values, top.options);
    const walked = [];
    for (let i = 0; i < steps.length; i++) {
      const found = findEntry(menu.values, steps[i]);
      if (found.error) throw new ToolError(`${top.where} menu${walked.length ? " > " + walked.join(" > ") : ""}: ${found.error}`);
      const v = found.entry;
      if (v?.disabled) throw new ToolError(`"${entryLabel(v)}" is disabled right now.`);
      if (action === "list" && !opensMenu(v)) throw new ToolError(`"${entryLabel(v)}" is an action, not a submenu. Use action "invoke" to run it.`);
      const before = opened.length;
      const state = await click(menu, v, top.event);
      walked.push(entryLabel(v));
      if (opened.length > before) { menu = opened[opened.length - 1]; continue; }
      if (i < steps.length - 1) throw new ToolError(`"${walked.join(" > ")}" did not open a submenu, so "${steps[i + 1]}" cannot be reached. Nothing further was clicked.`);
      await tick(150);
      const dialogNow = document.querySelector(".graphdialog, .litegraph.dialog, .p-dialog, [role='dialog']");
      return `invoked on ${top.where}: ${walked.join(" > ")}` + (state === "waiting" || dialogNow
        ? " — it opened a prompt or dialog: read it with ui_snapshot and answer it with ui_act." : "");
    }
    const lines = describeEntries(menu.values);
    if (action === "invoke") return `"${walked.join(" > ")}" opened a submenu instead of running an action. Extend the path with one of:\n${lines.join("\n")}`;
    return [`${top.where} menu${walked.length ? " > " + walked.join(" > ") : ""} (▸ opens a submenu):`, ...lines].join("\n") || "(empty menu)";
  });
  return action === "invoke" ? withUndo(run) : run();
}
