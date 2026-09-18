// Live, incremental graph edits. Every function verifies its own effect and returns a
// receipt of the state actually reached — third-party packs may veto or rewire links.
import { app, ToolError, TITLE_H, graph, allNodes, allGroups, getLink, nodeById, groupById, nodeRect, setNodePos, tick } from "./graphCtx.js";
import { autoMatch, describeSlots, resolveSlot } from "./connectMatch.js";
import { coerceWidgetValue } from "./widgetCoerce.js";
import { comboValues, describeNode, slotInfo, visibleWidgets } from "./read.js";

const GAP_X = 60;
const GAP_Y = 40;
const MODE_IDS = { active: 0, muted: 2, bypassed: 4 };

// ---------- placement ----------

function overlaps(a, b, pad = 10) {
  return a[0] < b[0] + b[2] + pad && a[0] + a[2] + pad > b[0] && a[1] < b[1] + b[3] + pad && a[1] + a[3] + pad > b[1];
}

/** Slide a rect along `axis` until it is clear of every other node. */
function freeSpot(rect, axis, skipNode) {
  const others = allNodes().filter((n) => n !== skipNode).map(nodeRect);
  const r = [...rect];
  for (let guard = 0; guard < 200; guard++) {
    const hit = others.find((o) => overlaps(r, o));
    if (!hit) break;
    if (axis === "y") r[1] = hit[1] + hit[3] + GAP_Y;
    else r[0] = hit[0] + hit[2] + GAP_X;
  }
  return r;
}

function choosePos(node, { pos, near }) {
  const th = TITLE_H();
  if (Array.isArray(pos)) return [pos[0], pos[1]];
  const [w, h] = [node.size[0], node.size[1] + th];
  let rect, axis = "y";
  if (near?.node_id !== undefined) {
    const [rx, ry, rw, rh] = nodeRect(nodeById(near.node_id));
    const side = near.side ?? "right";
    if (side === "left") rect = [rx - GAP_X - w, ry, w, h];
    else if (side === "below") { rect = [rx, ry + rh + GAP_Y, w, h]; axis = "x"; }
    else if (side === "above") { rect = [rx, ry - GAP_Y - h, w, h]; axis = "x"; }
    else rect = [rx + rw + GAP_X, ry, w, h];
  } else {
    const rects = allNodes().filter((n) => n !== node).map(nodeRect);
    if (!rects.length) return [100, 100 + th];
    const maxX = Math.max(...rects.map((r) => r[0] + r[2]));
    const minY = Math.min(...rects.map((r) => r[1]));
    rect = [maxX + GAP_X, minY, w, h];
  }
  const free = freeSpot(rect, axis, node);
  return [free[0], free[1] + th];
}

// ---------- widgets ----------

export function setWidgets(node, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new ToolError("values must be an object {widget_name: value}.");
  const widgets = visibleWidgets(node);
  const applied = {}, errors = {};
  for (const [name, raw] of Object.entries(values)) {
    const w = widgets.find((x) => x.name === name) ?? widgets.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!w) {
      errors[name] = `No widget "${name}". Widgets: ${widgets.map((x) => x.name).join(", ") || "(none)"}`;
      continue;
    }
    const input = node.inputs?.find((i) => i.widget?.name === w.name);
    if (input && input.link !== null && input.link !== undefined) {
      errors[name] = "This widget is driven by an incoming link; disconnect it first or change the source node.";
      continue;
    }
    const res = coerceWidgetValue({ type: w.type, options: { ...w.options, values: w.type === "combo" ? comboValues(w, node) : undefined } }, raw);
    if (!res.ok) { errors[name] = res.error; continue; }
    const old = w.value;
    w.value = res.value;
    try { w.callback?.(res.value, app.canvas, node, node.pos, undefined); } catch (e) { console.warn("[Sidekick] widget callback failed", e); }
    try { node.onWidgetChanged?.(w.name, res.value, old, w); } catch (e) { console.warn("[Sidekick] onWidgetChanged failed", e); }
    applied[w.name] = res.note ? `${JSON.stringify(w.value)} (${res.note})` : w.value;
  }
  if (node.graph) node.graph._version++;
  const out = { node_id: node.id, applied };
  if (Object.keys(errors).length) out.errors = errors;
  return out;
}

export function setWidgetValues({ node_id, values }) {
  const res = setWidgets(nodeById(node_id), values);
  if (res.errors && !Object.keys(res.applied).length) throw new ToolError(JSON.stringify(res.errors));
  return res;
}

// ---------- nodes ----------

export async function addNode(args) {
  const { type, title, widgets } = args;
  const node = window.LiteGraph.createNode(type);
  if (!node) throw new ToolError(`Unknown node type "${type}". Find the exact class name with search_node_types.`);
  if (title) node.title = String(title);
  graph().add(node);
  await tick(); // dynamic widgets/slots materialize after add
  setNodePos(node, choosePos(node, args));
  let widgetResult;
  if (widgets && Object.keys(widgets).length) widgetResult = setWidgets(node, widgets);
  const out = describeNode(node, { brief: true });
  if (widgetResult?.errors) out.widget_errors = widgetResult.errors;
  return out;
}

export function updateNode({ node_id, title, mode, collapsed, pinned, color, bgcolor, pos, size }) {
  const node = nodeById(node_id);
  if (title !== undefined) node.title = String(title);
  if (mode !== undefined) {
    if (!(mode in MODE_IDS)) throw new ToolError(`mode must be one of: ${Object.keys(MODE_IDS).join(", ")}`);
    if (typeof node.changeMode === "function") node.changeMode(MODE_IDS[mode]); else node.mode = MODE_IDS[mode];
  }
  if (collapsed !== undefined && !!node.flags?.collapsed !== !!collapsed) node.collapse(true);
  if (pinned !== undefined) { if (typeof node.pin === "function") node.pin(!!pinned); else node.flags.pinned = !!pinned; }
  if (color !== undefined) node.color = color || undefined;
  if (bgcolor !== undefined) node.bgcolor = bgcolor || undefined;
  if (pos !== undefined) setNodePos(node, pos);
  if (size !== undefined) {
    const min = node.computeSize?.() ?? [60, 30];
    const s = [Math.max(Number(size[0]), min[0]), Math.max(Number(size[1]), min[1])];
    if (typeof node.setSize === "function") node.setSize(s); else node.size = s;
  }
  return describeNode(node, { brief: true });
}

export function removeNodes({ node_ids }) {
  if (!Array.isArray(node_ids) || !node_ids.length) throw new ToolError("node_ids must be a non-empty array.");
  const nodes = node_ids.map(nodeById); // validate all before removing any
  for (const n of nodes) graph().remove(n);
  return { removed: nodes.map((n) => n.id) };
}

// ---------- links ----------

export function connectNodes({ from_node, from_output, to_node, to_input }) {
  const src = nodeById(from_node), dst = nodeById(to_node);
  if (src === dst) throw new ToolError("Cannot connect a node to itself.");
  const s = slotInfo(src), d = slotInfo(dst);
  const diag = () => `\n${describeSlots(`node ${src.id} (${src.type}) outputs`, s.outputs)}\n${describeSlots(`node ${dst.id} (${dst.type}) inputs`, d.inputs)}`;

  const given = (v) => v !== undefined && v !== null && v !== "";
  const fromIdx = given(from_output) ? resolveSlot(s.outputs, from_output) : -1;
  const toIdx = given(to_input) ? resolveSlot(d.inputs, to_input) : -1;
  if (given(from_output) && fromIdx < 0) throw new ToolError(`Node ${src.id} has no output "${from_output}".${diag()}`);
  if (given(to_input) && toIdx < 0) throw new ToolError(`Node ${dst.id} has no input "${to_input}".${diag()}`);

  const m = autoMatch(s.outputs, d.inputs, fromIdx, toIdx);
  if (m.error) throw new ToolError(`${m.error}${diag()}`);

  const replaced = d.inputs[m.in].from;
  src.connect(m.out, dst, m.in);

  const link = getLink(dst.inputs?.[m.in]?.link);
  if (!link || String(link.origin_id) !== String(src.id) || link.origin_slot !== m.out) {
    throw new ToolError(`The canvas refused or rewired this link (a node pack may veto it).${diag()}`);
  }
  let text = `connected ${src.id}.${s.outputs[m.out].name} -> ${dst.id}.${d.inputs[m.in].name} (${s.outputs[m.out].type})`;
  if (replaced && !(String(replaced.node) === String(src.id) && replaced.output === m.out)) text += `; replaced previous link from node ${replaced.node}`;
  if (m.kind === "wildcard") text += "; note: matched through a wildcard (*) type";
  return text;
}

export function disconnect({ node_id, input, output }) {
  const node = nodeById(node_id);
  const s = slotInfo(node);
  const given = (v) => v !== undefined && v !== null && v !== "";
  if (given(input) === given(output)) throw new ToolError("Give exactly one of: input, output.");
  if (given(input)) {
    const i = resolveSlot(s.inputs, input);
    if (i < 0) throw new ToolError(`No input "${input}". ${describeSlots("inputs", s.inputs)}`);
    if (!s.inputs[i].linked) return `input ${s.inputs[i].name} was not connected`;
    node.disconnectInput(i);
    return `disconnected input ${s.inputs[i].name}`;
  }
  const o = resolveSlot(s.outputs, output);
  if (o < 0) throw new ToolError(`No output "${output}". ${describeSlots("outputs", s.outputs)}`);
  node.disconnectOutput(o);
  return `disconnected ${s.outputs[o].to.length} link(s) from output ${s.outputs[o].name}`;
}

// ---------- groups ----------

function fitBounds(nodes, fontSize) {
  const pad = 20;
  const rects = nodes.map(nodeRect);
  const x0 = Math.min(...rects.map((r) => r[0])) - pad;
  const y0 = Math.min(...rects.map((r) => r[1])) - pad - (fontSize + 12);
  const x1 = Math.max(...rects.map((r) => r[0] + r[2])) + pad;
  const y1 = Math.max(...rects.map((r) => r[1] + r[3])) + pad;
  return [x0, y0, x1 - x0, y1 - y0];
}

function applyGroup(group, { title, node_ids, bounds, color, font_size }) {
  if (title !== undefined) group.title = String(title);
  if (font_size !== undefined) group.font_size = Number(font_size);
  if (color !== undefined) group.color = color || undefined;
  let b = null;
  if (Array.isArray(node_ids) && node_ids.length) b = fitBounds(node_ids.map(nodeById), group.font_size ?? 24);
  else if (Array.isArray(bounds) && bounds.length === 4) b = bounds.map(Number);
  if (b) {
    group.pos = [b[0], b[1]];
    group.size = [Math.max(b[2], 140), Math.max(b[3], 80)];
  }
  group.recomputeInsideNodes?.();
}

function describeGroup(group) {
  const b = (group._bounding ?? [...group.pos, ...group.size]).map(Math.round);
  return { group_id: group.id, title: group.title, bounds: [...b], color: group.color };
}

export function createGroup(args) {
  if (!args.title) throw new ToolError("title is required.");
  if (!(Array.isArray(args.node_ids) && args.node_ids.length) && !Array.isArray(args.bounds)) {
    throw new ToolError("Give node_ids (preferred) or bounds.");
  }
  const Group = window.LiteGraph?.LGraphGroup ?? window.LGraphGroup;
  const group = new Group(String(args.title));
  graph().add(group); // must be in a graph first: geometry setters dereference group.graph
  applyGroup(group, args);
  if (group.id === undefined || group.id === null || group.id < 0) {
    group.id = Math.max(0, ...allGroups().filter((g) => g !== group).map((g) => Number(g.id) || 0)) + 1;
  }
  group.recomputeInsideNodes?.();
  return describeGroup(group);
}

export function updateGroup(args) {
  const group = groupById(args.group_id);
  applyGroup(group, args);
  return describeGroup(group);
}

export function removeGroup({ group_id, remove_nodes }) {
  const group = groupById(group_id);
  let removed = [];
  if (remove_nodes) {
    group.recomputeInsideNodes?.();
    const inside = [...(group._children ?? group._nodes ?? [])].filter((c) => c && c.id !== undefined && allNodes().includes(c));
    for (const n of inside) graph().remove(n);
    removed = inside.map((n) => n.id);
  }
  graph().remove(group);
  return { removed_group: group_id, removed_nodes: removed };
}

// ---------- batch ----------

const OPS = {
  add_node: addNode, connect: connectNodes, disconnect, set_widgets: setWidgetValues, update_node: updateNode,
  remove_nodes: removeNodes, create_group: createGroup, update_group: updateGroup, remove_group: removeGroup,
};

function resolveRefs(op, refs) {
  const fix = (v) => {
    if (typeof v !== "string" || !v.startsWith("$")) return v;
    const key = v.slice(1);
    if (!(key in refs)) throw new ToolError(`Unknown ref "${v}". Known refs: ${Object.keys(refs).map((k) => "$" + k).join(", ") || "(none yet)"}`);
    return refs[key];
  };
  const out = { ...op };
  for (const k of ["node_id", "from_node", "to_node"]) if (k in out) out[k] = fix(out[k]);
  if (Array.isArray(out.node_ids)) out.node_ids = out.node_ids.map(fix);
  if (out.near && typeof out.near === "object") out.near = { ...out.near, node_id: fix(out.near.node_id) };
  return out;
}

export async function editGraph({ operations }) {
  if (!Array.isArray(operations) || !operations.length) throw new ToolError("operations must be a non-empty array.");
  const refs = {}, results = [];
  let failedAt = -1;
  for (let i = 0; i < operations.length; i++) {
    const raw = operations[i] ?? {};
    const fn = OPS[raw.op];
    try {
      if (!fn) throw new ToolError(`Unknown op "${raw.op}". Ops: ${Object.keys(OPS).join(", ")}`);
      const { op, ref, ...rest } = resolveRefs(raw, refs);
      const result = await fn(rest);
      if (op === "add_node") {
        if (ref) refs[String(ref).replace(/^\$/, "")] = result.id;
        results.push({ i, op, ok: true, id: result.id, ...(ref ? { ref } : {}), ...(result.widget_errors ? { widget_errors: result.widget_errors } : {}) });
      } else {
        results.push({ i, op, ok: true, result });
      }
    } catch (e) {
      results.push({ i, op: raw.op, ok: false, error: e?.message ?? String(e) });
      failedAt = i;
      break;
    }
  }
  const out = { ok: failedAt < 0, results, refs };
  if (failedAt >= 0) {
    out.note = `Stopped at operation ${failedAt}; operations before it were applied, ${operations.length - failedAt - 1} after it were skipped. Fix and resend only the failed and remaining operations (refs are gone: use the node ids above).`;
  }
  return out;
}
