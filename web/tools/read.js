// Read tools: budgeted text outline of the canvas, node detail, link tracing.
import { app, ToolError, graph, allNodes, allGroups, getLink, nodeById, nodeRect, round, subgraphTrail } from "./graphCtx.js";

const MODES = { 0: "active", 2: "muted", 4: "bypassed" };
const MAX_WIDGET_CHARS = 140;
// Whole-graph outlines must fit the backend cap (48k) with room to spare. A 123-node graph is
// ~45k chars at full detail: blind truncation there cost one real session ~40 extra tool calls.
const BUDGET = 40000;

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

const inputName = (nodeId, slot) => graph().getNodeById(nodeId)?.inputs?.[slot]?.name ?? slot;
const outputName = (nodeId, slot) => graph().getNodeById(nodeId)?.outputs?.[slot]?.name ?? slot;
const groupBounds = (g) => g._bounding ?? [...g.pos, ...g.size];

export function groupMembers(group) {
  const [gx, gy, gw, gh] = groupBounds(group);
  return allNodes().filter((n) => {
    const [x, y, w, h] = nodeRect(n);
    const cx = x + w / 2, cy = y + h / 2;
    return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
  });
}

export function findGroup(ref) {
  const groups = allGroups();
  const byId = groups.find((g) => String(g.id) === String(ref));
  if (byId) return byId;
  const want = String(ref).toLowerCase();
  const hits = groups.filter((g) => String(g.title).toLowerCase().includes(want));
  if (hits.length === 1) return hits[0];
  const list = groups.map((g) => `#${g.id} ${JSON.stringify(g.title)}`).join(", ") || "(none)";
  throw new ToolError(`${hits.length ? "Several groups match" : "No group matches"} "${ref}". Groups: ${list}`);
}

const titleOf = (n) => (n.title && n.title !== n.constructor?.title && n.title !== n.type ? JSON.stringify(n.title) : "");
// A subgraph node's real type is a UUID: say what it is instead (the "subgraph" tool looks inside).
const typeOf = (n) => (n.isSubgraphNode?.() ? `subgraph ${JSON.stringify(n.subgraph?.name ?? n.title ?? "")} [${n.subgraph?._nodes?.length ?? "?"} nodes inside]` : n.type);

function flagsOf(n) {
  const flags = [];
  if (MODES[n.mode] && n.mode !== 0) flags.push(MODES[n.mode]);
  if (n.flags?.collapsed) flags.push("collapsed");
  if (n.flags?.pinned || n.pinned) flags.push("pinned");
  return flags.join(",");
}

function linkText(n) {
  const { inputs, outputs } = slotInfo(n);
  const ins = inputs.filter((i) => i.linked).map((i) => `${i.name}<-${i.from.node}.${outputName(i.from.node, i.from.output)}`);
  const outs = outputs.filter((o) => o.to.length).map((o) => `${o.name}->${o.to.map((t) => `${t.node}.${inputName(t.node, t.input)}`).join(",")}`);
  return { inputs, outputs, ins, outs };
}

function renderFull(nodes, includeWidgets) {
  const lines = ["nodes (id|type|title|x,y|WxH|flags):"];
  for (const n of nodes) {
    lines.push(` ${n.id}|${typeOf(n)}|${titleOf(n)}|${round(n.pos[0])},${round(n.pos[1])}|${round(n.size[0])}x${round(n.size[1])}|${flagsOf(n)}`);
    if (includeWidgets) {
      const ws = visibleWidgets(n).map((w) => `${w.name}=${fmtValue(w.value)}`);
      if (ws.length) lines.push(`   widgets: ${ws.join(", ")}`);
    }
    const { inputs, outputs, ins } = linkText(n);
    const open = inputs.filter((i) => !i.linked && !i.widget).map((i) => `${i.name}(${i.type})`);
    if (ins.length || open.length) lines.push(`   in: ${ins.join("; ") || "-"}${open.length ? ` | open: ${open.join(", ")}` : ""}`);
    const outs = outputs.map((o) => `${o.name}(${o.type})${o.to.length ? "->" + o.to.map((t) => `${t.node}.${inputName(t.node, t.input)}`).join(",") : ""}`);
    if (outs.length) lines.push(`   out: ${outs.join("; ")}`);
  }
  return lines;
}

function renderOutline(nodes) {
  const lines = ["nodes (id|type|title|flags | in: linked inputs | out: linked outputs):"];
  for (const n of nodes) {
    const { ins, outs } = linkText(n);
    lines.push(` ${n.id}|${typeOf(n)}|${titleOf(n)}|${flagsOf(n)}${ins.length ? ` | in: ${ins.join("; ")}` : ""}${outs.length ? ` | out: ${outs.join("; ")}` : ""}`);
  }
  return lines;
}

function renderIndex(nodes) {
  const groups = [...allGroups()].sort((a, b) => groupBounds(a)[2] * groupBounds(a)[3] - groupBounds(b)[2] * groupBounds(b)[3]);
  const owner = new Map(); // node -> smallest group containing it
  for (const g of groups) for (const n of groupMembers(g)) if (!owner.has(n)) owner.set(n, g);
  const short = (n) => `${n.id} ${typeOf(n)}${titleOf(n) ? " " + titleOf(n) : ""}${flagsOf(n) ? " [" + flagsOf(n) + "]" : ""}`;
  const lines = ["nodes per group (id type title):"];
  for (const g of allGroups()) {
    const mine = nodes.filter((n) => owner.get(n) === g);
    if (mine.length) lines.push(` #${g.id} ${JSON.stringify(g.title)}: ${mine.map(short).join("; ")}`);
  }
  const loose = nodes.filter((n) => !owner.has(n));
  if (loose.length) lines.push(` (no group): ${loose.map(short).join("; ")}`);
  return lines;
}

export function getWorkflow({ node_ids, group, query, detail = "auto", include_widgets = true } = {}) {
  const everything = allNodes();
  let nodes = everything;
  const filters = [];
  if (Array.isArray(node_ids) && node_ids.length) {
    const want = new Set(node_ids.map(String));
    nodes = nodes.filter((n) => want.has(String(n.id)));
    filters.push(`node_ids (${nodes.length} found)`);
  }
  if (group !== undefined && group !== null && group !== "") {
    const g = findGroup(group);
    const members = new Set(groupMembers(g));
    nodes = nodes.filter((n) => members.has(n));
    filters.push(`group #${g.id} ${JSON.stringify(g.title)}`);
  }
  if (query) {
    const q = String(query).toLowerCase();
    nodes = nodes.filter((n) => `${n.title ?? ""} ${n.type}`.toLowerCase().includes(q));
    filters.push(`query ${JSON.stringify(query)}`);
  }

  const groups = allGroups();
  const wf = app.extensionManager?.workflow?.activeWorkflow;
  const trail = subgraphTrail();
  const inSubgraph = app.rootGraph && graph() !== app.rootGraph;
  const where = trail.length
    ? `INSIDE subgraph ${JSON.stringify(trail[trail.length - 1].subgraph?.name ?? trail[trail.length - 1].title)} = root node ${trail.map((n) => n.id).join(":")} (ids below are local to it; the subgraph tool exits)`
    : inSubgraph ? "inside a subgraph" : "root";
  let linkCount = 0;
  for (const n of everything) for (const i of n.inputs ?? []) if (i.link !== null && i.link !== undefined) linkCount++;

  let head = `workflow ${JSON.stringify(wf?.filename ?? wf?.path ?? "unsaved")}${wf?.isModified ? " (modified)" : ""}` +
    ` | graph: ${where} | ${everything.length} nodes, ${linkCount} links, ${groups.length} groups`;
  if (everything.length) {
    const rects = everything.map(nodeRect);
    const x0 = Math.min(...rects.map((r) => r[0])), y0 = Math.min(...rects.map((r) => r[1]));
    const x1 = Math.max(...rects.map((r) => r[0] + r[2])), y1 = Math.max(...rects.map((r) => r[1] + r[3]));
    head += ` | bounds ${round(x0)},${round(y0)}..${round(x1)},${round(y1)}`;
  }

  const groupLines = [];
  if (groups.length && !filters.length) {
    groupLines.push("groups (#id \"title\" [x,y,w,h] nodes):");
    for (const g of groups) {
      groupLines.push(` #${g.id} ${JSON.stringify(g.title)} [${groupBounds(g).map(round).join(",")}]${g.color ? " " + g.color : ""} nodes: ${groupMembers(g).map((n) => n.id).join(",") || "-"}`);
    }
  }

  const renderers = { full: () => renderFull(nodes, include_widgets), outline: () => renderOutline(nodes), index: () => renderIndex(nodes) };
  const order = detail in renderers ? [detail] : ["full", "outline", "index"];
  let level = order[0], body = [];
  for (const candidate of order) {
    level = candidate;
    body = nodes.length ? renderers[candidate]() : [];
    if (body.join("\n").length + groupLines.join("\n").length <= BUDGET) break;
  }

  let detailLine = `showing ${nodes.length} of ${everything.length} nodes${filters.length ? ` (filter: ${filters.join(", ")})` : ""} | detail: ${level}`;
  if (order.length > 1 && level !== "full") {
    detailLine += ` (reduced from full so the whole graph fits; for positions and widget values call get_workflow with group=, query= or node_ids=, or get_node with node_ids)`;
  }
  const lines = [head, detailLine];
  if (!everything.length) lines.push("(canvas is empty)");
  else if (!nodes.length) lines.push("(no node matches the filter)");
  return [...lines, ...groupLines, ...body].join("\n");
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
  }
  if (node.isSubgraphNode?.()) {
    out.subgraph = { name: node.subgraph?.name ?? node.title, nodes_inside: node.subgraph?._nodes?.length ?? 0, look_inside: `subgraph action=enter node_id=${node.id}` };
  }
  return out;
}

export function getNode({ node_id, node_ids }) {
  if (Array.isArray(node_ids) && node_ids.length) {
    if (node_ids.length > 25) throw new ToolError("At most 25 node_ids per call.");
    // One bad id must not waste the whole batch.
    return node_ids.map((id) => { try { return describeNode(nodeById(id)); } catch (e) { return { id, error: e.message.split(".")[0] }; } });
  }
  if (node_id === undefined || node_id === null) throw new ToolError("Give node_id or node_ids.");
  return describeNode(nodeById(node_id));
}

export function traceConnections({ node_id, direction = "both", depth = 6 }) {
  const start = nodeById(node_id);
  const maxDepth = Math.max(1, Math.min(Number(depth) || 6, 30));
  const LIMIT = 150;
  const walk = (dir) => {
    const seen = new Map([[String(start.id), 0]]);
    let frontier = [start];
    const rows = [];
    for (let hop = 1; hop <= maxDepth && frontier.length && rows.length < LIMIT; hop++) {
      const next = [];
      for (const n of frontier) {
        const { inputs, outputs } = slotInfo(n);
        const edges = dir === "upstream"
          ? inputs.filter((i) => i.from).map((i) => ({ id: i.from.node, via: `${outputName(i.from.node, i.from.output)} -> ${n.id}.${i.name}` }))
          : outputs.flatMap((o) => o.to.map((t) => ({ id: t.node, via: `${n.id}.${o.name} -> ${inputName(t.node, t.input)}` })));
        for (const e of edges) {
          if (seen.has(String(e.id))) continue;
          const m = graph().getNodeById(e.id);
          if (!m) continue;
          seen.set(String(e.id), hop);
          rows.push(` ${hop}|${m.id}|${typeOf(m)}|${titleOf(m)}|${flagsOf(m)}|${e.via}`);
          next.push(m);
        }
      }
      frontier = next;
    }
    return rows;
  };
  const lines = [`trace from ${start.id} (${typeOf(start)}${titleOf(start) ? " " + titleOf(start) : ""}), max ${maxDepth} hops. Rows: hop|id|type|title|flags|via`];
  if (direction !== "downstream") { const up = walk("upstream"); lines.push(`upstream (feeds it): ${up.length || "none"}`, ...up); }
  if (direction !== "upstream") { const down = walk("downstream"); lines.push(`downstream (fed by it): ${down.length || "none"}`, ...down); }
  lines.push("Note: only real links are followed; wireless/virtual routing nodes (e.g. Remote IO, Set/Get, Anything Everywhere) connect nodes without links.");
  return lines.join("\n");
}
