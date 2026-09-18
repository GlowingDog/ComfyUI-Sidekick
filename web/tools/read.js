// Read tools: compact text outline of the canvas + full detail of one node.
import { app, graph, allNodes, allGroups, getLink, nodeById, nodeRect, round } from "./graphCtx.js";

const MODES = { 0: "active", 2: "muted", 4: "bypassed" };
const MAX_WIDGET_CHARS = 140;

export function comboValues(widget, node) {
  const v = widget.options?.values;
  if (typeof v === "function") {
    try { return v(widget, node) ?? []; } catch { return []; }
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v);
  return [];
}

function fmtValue(v) {
  if (typeof v === "string") {
    const s = v.length > MAX_WIDGET_CHARS ? v.slice(0, MAX_WIDGET_CHARS) + `…(${v.length} chars)` : v;
    return JSON.stringify(s);
  }
  if (v !== null && typeof v === "object") return JSON.stringify(v).slice(0, MAX_WIDGET_CHARS);
  return String(v);
}

export function visibleWidgets(node) {
  return (node.widgets ?? []).filter((w) => w && w.name && w.type !== "button" && !String(w.type).startsWith("converted-"));
}

export function slotInfo(node) {
  const inputs = (node.inputs ?? []).map((inp, index) => {
    const link = getLink(inp.link);
    return {
      index, name: inp.name, type: String(inp.type ?? "*"), linked: !!link, widget: !!inp.widget,
      from: link ? { node: link.origin_id, output: link.origin_slot } : null,
    };
  });
  const outputs = (node.outputs ?? []).map((out, index) => {
    const to = (out.links ?? []).map(getLink).filter(Boolean).map((l) => ({ node: l.target_id, input: l.target_slot }));
    return { index, name: out.name, type: String(out.type ?? "*"), linked: to.length > 0, to };
  });
  return { inputs, outputs };
}

function inputName(nodeId, slot) {
  const n = graph().getNodeById(nodeId);
  return n?.inputs?.[slot]?.name ?? slot;
}

function outputName(nodeId, slot) {
  const n = graph().getNodeById(nodeId);
  return n?.outputs?.[slot]?.name ?? slot;
}

function groupMembers(group) {
  const [gx, gy, gw, gh] = group._bounding ?? [...group.pos, ...group.size];
  return allNodes().filter((n) => {
    const [x, y, w, h] = nodeRect(n);
    const cx = x + w / 2, cy = y + h / 2;
    return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
  });
}

export function getWorkflow({ node_ids, include_widgets = true } = {}) {
  const want = Array.isArray(node_ids) && node_ids.length ? new Set(node_ids.map(Number)) : null;
  const nodes = allNodes().filter((n) => !want || want.has(n.id));
  const groups = allGroups();
  const wf = app.extensionManager?.workflow?.activeWorkflow;
  const inSubgraph = app.rootGraph && graph() !== app.rootGraph;

  let linkCount = 0;
  for (const n of allNodes()) for (const i of n.inputs ?? []) if (i.link !== null && i.link !== undefined) linkCount++;

  const lines = [];
  let head = `workflow ${JSON.stringify(wf?.filename ?? wf?.path ?? "unsaved")}${wf?.isModified ? " (modified)" : ""}` +
    ` | graph: ${inSubgraph ? "subgraph (not root)" : "root"} | ${allNodes().length} nodes, ${linkCount} links, ${groups.length} groups`;
  if (allNodes().length) {
    const rects = allNodes().map(nodeRect);
    const x0 = Math.min(...rects.map((r) => r[0])), y0 = Math.min(...rects.map((r) => r[1]));
    const x1 = Math.max(...rects.map((r) => r[0] + r[2])), y1 = Math.max(...rects.map((r) => r[1] + r[3]));
    head += ` | bounds ${round(x0)},${round(y0)}..${round(x1)},${round(y1)}`;
  }
  lines.push(head);
  if (!allNodes().length) lines.push("(canvas is empty)");

  if (groups.length && !want) {
    lines.push("groups (#id \"title\" [x,y,w,h] nodes):");
    for (const g of groups) {
      const b = (g._bounding ?? [...g.pos, ...g.size]).map(round);
      lines.push(` #${g.id} ${JSON.stringify(g.title)} [${b.join(",")}]${g.color ? " " + g.color : ""} nodes: ${groupMembers(g).map((n) => n.id).join(",") || "-"}`);
    }
  }

  if (nodes.length) lines.push("nodes (id|type|title|x,y|WxH|flags):");
  for (const n of nodes) {
    const flags = [];
    if (MODES[n.mode] && n.mode !== 0) flags.push(MODES[n.mode]);
    if (n.flags?.collapsed) flags.push("collapsed");
    if (n.flags?.pinned || n.pinned) flags.push("pinned");
    const title = n.title && n.title !== n.constructor?.title && n.title !== n.type ? JSON.stringify(n.title) : "";
    lines.push(` ${n.id}|${n.type}|${title}|${round(n.pos[0])},${round(n.pos[1])}|${round(n.size[0])}x${round(n.size[1])}|${flags.join(",")}`);
    if (include_widgets) {
      const ws = visibleWidgets(n).map((w) => `${w.name}=${fmtValue(w.value)}`);
      if (ws.length) lines.push(`   widgets: ${ws.join(", ")}`);
    }
    const { inputs, outputs } = slotInfo(n);
    const linkedIn = inputs.filter((i) => i.linked).map((i) => `${i.name}<-${i.from.node}.${outputName(i.from.node, i.from.output)}`);
    const openIn = inputs.filter((i) => !i.linked && !i.widget).map((i) => `${i.name}(${i.type})`);
    if (linkedIn.length || openIn.length) {
      lines.push(`   in: ${linkedIn.join("; ") || "-"}${openIn.length ? ` | open: ${openIn.join(", ")}` : ""}`);
    }
    const outs = outputs.map((o) => `${o.name}(${o.type})${o.to.length ? "->" + o.to.map((t) => `${t.node}.${inputName(t.node, t.input)}`).join(",") : ""}`);
    if (outs.length) lines.push(`   out: ${outs.join("; ")}`);
  }
  return lines.join("\n");
}

export function describeNode(node, { brief = false } = {}) {
  const { inputs, outputs } = slotInfo(node);
  const widgets = visibleWidgets(node).map((w) => {
    const d = { name: w.name, type: w.type, value: w.value };
    if (w.type === "combo") {
      const vals = comboValues(w, node);
      d.options = vals.slice(0, brief ? 6 : 30).map(String);
      if (vals.length > d.options.length) d.options_total = vals.length;
    } else if (w.type === "number" && !brief) {
      for (const k of ["min", "max", "step2", "precision"]) if (w.options?.[k] !== undefined) d[k === "step2" ? "step" : k] = w.options[k];
    }
    if (typeof d.value === "string" && d.value.length > 600) d.value = d.value.slice(0, 600) + `…(${w.value.length} chars)`;
    return d;
  });
  const out = {
    id: node.id, type: node.type, title: node.title,
    pos: [round(node.pos[0]), round(node.pos[1])], size: [round(node.size[0]), round(node.size[1])],
    mode: MODES[node.mode] ?? node.mode,
    inputs: inputs.map((i) => ({ name: i.name, type: i.type, ...(i.widget ? { widget: true } : {}), ...(i.from ? { from: i.from } : {}) })),
    outputs: outputs.map((o) => ({ name: o.name, type: o.type, ...(o.to.length ? { to: o.to } : {}) })),
    widgets,
  };
  if (!brief) {
    out.collapsed = !!node.flags?.collapsed;
    out.pinned = !!(node.flags?.pinned || node.pinned);
    if (node.color) out.color = node.color;
    if (node.bgcolor) out.bgcolor = node.bgcolor;
    if (node.isSubgraphNode?.()) out.is_subgraph = true;
  }
  return out;
}

export function getNode({ node_id }) {
  return describeNode(nodeById(node_id));
}
