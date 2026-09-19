// auto_layout: tidy the whole workflow, one group or a set of nodes by following the links.
// The geometry is pure (dagLayout.js); this file turns the live canvas into its input tree,
// applies the result and makes room for it. Must not import edit.js (edit.js imports this).
import { ToolError, TITLE_H, GROUP_PAD, allNodes, allGroups, getLink, nodeById, nodeRect, groupRect, groupHead, setGroupRect, addGroupBox, setNodePos } from "./graphCtx.js";
import { findGroup, groupMembers } from "./read.js";
import { layoutTree } from "./dagLayout.js";
import { overlaps, union } from "./layoutMath.js";

const PALETTE = ["#3f789e", "#8A8", "#b58b2a", "#a1309b", "#88A", "#A88", "#b06634", "#8AA"];
const area = (r) => r[2] * r[3];
const centre = (r) => [r[0] + r[2] / 2, r[1] + r[3] / 2];
const holds = (box, [cx, cy]) => cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3];
const isPinned = (x) => !!(x.flags?.pinned || x.pinned);
const given = (v) => v !== undefined && v !== null && v !== "";
const titleWidth = (title, fontSize) => Math.min(1600, Math.ceil(String(title ?? "").length * (fontSize ?? 24) * 0.58) + 2 * GROUP_PAD);
const padded = (r, head) => [r[0] - GROUP_PAD, r[1] - GROUP_PAD - head, r[2] + 2 * GROUP_PAD, r[3] + 2 * GROUP_PAD + head];

/** How far below the node's visual top a socket sits (so linked sockets end up level). */
function socketDy(node, slot, isInput) {
  const rect = nodeRect(node);
  if (node.flags?.collapsed) return rect[3] / 2;
  try {
    const p = isInput ? node.getInputPos(slot) : node.getOutputPos(slot);
    const dy = p[1] - rect[1];
    if (Number.isFinite(dy) && dy >= 0 && dy <= rect[3]) return dy;
  } catch { /* older builds: estimate below */ }
  return TITLE_H() + (slot + 0.7) * (window.LiteGraph?.NODE_SLOT_HEIGHT ?? 20);
}

/**
 * Things outside the layout that sit right of / below the old footprint move over by as much as
 * the footprint grew. A group nobody touched moves as one unit with everything inside it.
 */
function makeRoom(before, after, liveSet, skipGroups, membersOf) {
  const dW = Math.round(after[0] + after[2] - (before[0] + before[2]));
  const dH = Math.round(after[1] + after[3] - (before[1] + before[3]));
  if (dW <= 0 && dH <= 0) return null;
  const untouched = allGroups().filter((g) => !skipGroups.has(g) && !membersOf.get(g)?.some((n) => liveSet.has(n)))
    .sort((a, b) => area(groupRect(b)) - area(groupRect(a))); // big first: outermost boxes become the units
  const units = [], unitOf = new Map(), claimed = new Set();
  for (const g of untouched) {
    const c = centre(groupRect(g));
    const outer = untouched.find((p) => p !== g && unitOf.has(p) && area(groupRect(p)) >= area(groupRect(g)) && holds(groupRect(p), c));
    const unit = outer ? unitOf.get(outer) : { rect: groupRect(g), groups: [], nodes: [], fixed: false };
    if (!outer) units.push(unit);
    unitOf.set(g, unit);
    unit.groups.push(g);
    if (isPinned(g)) unit.fixed = true;
    for (const n of membersOf.get(g) ?? []) {
      if (claimed.has(n) || liveSet.has(n)) continue;
      claimed.add(n);
      unit.nodes.push(n);
      if (isPinned(n)) unit.fixed = true;
    }
  }
  for (const n of allNodes()) {
    if (!liveSet.has(n) && !claimed.has(n)) units.push({ rect: nodeRect(n), groups: [], nodes: [n], fixed: isPinned(n) });
  }
  const right = before[0] + before[2], bottom = before[1] + before[3];
  let nodes = 0, groups = 0;
  for (const u of units) {
    if (u.fixed) continue;
    const dx = dW > 0 && u.rect[0] >= right - 1 ? dW : 0;
    const dy = dH > 0 && u.rect[1] >= bottom - 1 ? dH : 0;
    if (!dx && !dy) continue;
    for (const n of u.nodes) setNodePos(n, [n.pos[0] + dx, n.pos[1] + dy]);
    for (const g of u.groups) { const r = groupRect(g); setGroupRect(g, [r[0] + dx, r[1] + dy, r[2], r[3]]); }
    nodes += u.nodes.length;
    groups += u.groups.length;
  }
  return nodes || groups ? { nodes, groups, by: [Math.max(dW, 0), Math.max(dH, 0)] } : null;
}

export function autoLayout({ group, node_ids, new_groups, spacing, dry_run = false } = {}) {
  const k = Math.max(0.5, Math.min(Number(spacing) || 1, 3));
  const everyGroup = [...allGroups()];
  const gid = new Map(everyGroup.map((g, i) => [g, `group:${i}`]));
  const membersOf = new Map(everyGroup.map((g) => [g, groupMembers(g)]));

  // ---- what is being laid out ----
  let scopeGroup = null, nodes, scope;
  const byIds = Array.isArray(node_ids) && node_ids.length > 0;
  if (byIds) {
    nodes = [...new Set(node_ids.map(nodeById))];
    scope = `${nodes.length} node(s)`;
  } else if (given(group)) {
    scopeGroup = findGroup(group);
    nodes = membersOf.get(scopeGroup);
    if (!nodes.length) throw new ToolError(`Group #${scopeGroup.id} has no nodes inside it.`);
    scope = `group #${scopeGroup.id} ${JSON.stringify(scopeGroup.title)}`;
  } else {
    nodes = [...allNodes()];
    scope = "whole workflow";
  }
  if (!nodes.length) throw new ToolError("The canvas is empty; there is nothing to lay out.");
  const inScope = new Set(nodes);

  let groups;
  if (scopeGroup) {
    const box = groupRect(scopeGroup);
    groups = everyGroup.filter((g) => g === scopeGroup || (area(groupRect(g)) < area(box) && holds(box, centre(groupRect(g)))));
  } else if (byIds) {
    groups = everyGroup.filter((g) => membersOf.get(g).length && membersOf.get(g).every((n) => inScope.has(n)));
  } else {
    groups = [...everyGroup];
  }
  groups.sort((a, b) => area(groupRect(a)) - area(groupRect(b))); // small first: the innermost box owns a node

  const parentOf = new Map();
  groups.forEach((g, i) => {
    if (g === scopeGroup) return;
    const c = centre(groupRect(g));
    parentOf.set(g, groups.slice(i + 1).find((p) => holds(groupRect(p), c)) ?? null);
  });
  const ownerOf = new Map();
  for (const n of nodes) {
    const c = centre(nodeRect(n));
    ownerOf.set(n, groups.find((g) => holds(groupRect(g), c)) ?? null);
  }

  // ---- pinned things do not move, and neither does a group that holds one ----
  const frozen = new Set();
  for (const g of [...groups].reverse()) { // big first, so a frozen box freezes the boxes inside it
    if (isPinned(g) || membersOf.get(g).some(isPinned) || frozen.has(parentOf.get(g))) frozen.add(g);
  }
  if (scopeGroup && frozen.has(scopeGroup)) {
    const ids = nodes.filter(isPinned).map((n) => n.id).join(", ");
    throw new ToolError(`Group #${scopeGroup.id} is pinned or holds pinned node(s) ${ids}. Unpin first (update_node pinned=false) or pass node_ids.`);
  }
  const live = nodes.filter((n) => !isPinned(n) && !frozen.has(ownerOf.get(n)));
  if (!live.length) throw new ToolError("Every node in scope is pinned or sits in a group with a pinned node. Unpin with update_node pinned=false.");
  const liveSet = new Set(live);
  const liveById = new Map(live.map((n) => [String(n.id), n]));
  const liveGroups = groups.filter((g) => !frozen.has(g));

  // ---- groups to create around nodes the caller names ----
  const fresh = [], taken = new Set();
  (Array.isArray(new_groups) ? new_groups : []).forEach((ng, i) => {
    if (!ng?.title || !Array.isArray(ng.node_ids) || !ng.node_ids.length) throw new ToolError(`new_groups[${i}] needs a title and node_ids.`);
    const members = [...new Set(ng.node_ids.map(nodeById))];
    for (const n of members) {
      if (!liveSet.has(n)) throw new ToolError(`new_groups[${i}] ${JSON.stringify(ng.title)}: node ${n.id} is ${inScope.has(n) ? "pinned or in a pinned group" : "outside this layout (add it to node_ids or drop the scope)"}.`);
      if (taken.has(n)) throw new ToolError(`Node ${n.id} is listed in two new_groups; a node can be in only one.`);
      taken.add(n);
    }
    fresh.push({ title: String(ng.title), color: ng.color, members });
  });

  // ---- tree for the pure layout ----
  const root = { id: "root", children: [] };
  const blockOf = new Map(liveGroups.map((g) => {
    const r = groupRect(g);
    return [g, { id: gid.get(g), children: [], pad: GROUP_PAD, head: groupHead(g), minW: titleWidth(g.title, g.font_size), x: r[0], y: r[1] }];
  }));
  const home = (g) => blockOf.get(g) ?? root;
  for (const g of liveGroups) home(parentOf.get(g)).children.push(blockOf.get(g));
  const freshBlockOf = new Map();
  fresh.forEach((f, i) => {
    const owners = new Set(f.members.map((n) => ownerOf.get(n)));
    const u = union(f.members.map(nodeRect));
    f.block = { id: `new:${i}`, children: [], pad: GROUP_PAD, head: 36, minW: titleWidth(f.title, 24), x: u[0], y: u[1] };
    home(owners.size === 1 ? [...owners][0] : null).children.push(f.block);
    for (const n of f.members) freshBlockOf.set(n, f.block);
  });
  for (const n of live) {
    const r = nodeRect(n);
    (freshBlockOf.get(n) ?? home(ownerOf.get(n))).children.push({ id: String(n.id), w: r[2], h: r[3], x: r[0], y: r[1] });
  }
  const emptyGroups = new Map(); // a box with nothing left inside keeps its size and is placed like a node
  for (const g of liveGroups) {
    const b = blockOf.get(g);
    if (b.children.length) continue;
    const r = groupRect(g);
    delete b.children;
    b.w = r[2];
    b.h = r[3];
    emptyGroups.set(b.id, g);
  }

  const edges = [];
  for (const n of live) {
    (n.inputs ?? []).forEach((inp, i) => {
      const link = getLink(inp.link);
      const src = link ? liveById.get(String(link.origin_id)) : null;
      if (src) edges.push({ from: String(src.id), to: String(n.id), fromDy: socketDy(src, link.origin_slot, false), toDy: socketDy(n, i, true) });
    });
  }

  const plan = layoutTree(root, edges, { gapX: Math.round(80 * k), gapY: Math.round(40 * k) });
  const before = union([...live.map(nodeRect), ...liveGroups.map(groupRect)]);
  const anchor = [Math.round(before[0]), Math.round(before[1])];
  const at = (p) => [Math.round(anchor[0] + p[0]), Math.round(anchor[1] + p[1])];
  const after = [anchor[0], anchor[1], Math.round(plan.w), Math.round(plan.h)];
  const planned = (id) => { const r = plan.blocks.get(id); return r ? [...at(r), Math.round(r[2]), Math.round(r[3])] : null; };

  const out = { scope, nodes: live.length, columns: plan.columnsOf.get(scopeGroup ? gid.get(scopeGroup) : "root"), bounds: after };
  const freshBoxes = fresh.map((f) => ({ title: f.title, bounds: planned(f.block.id), created: !dry_run }));
  const boxes = [
    ...liveGroups.filter((g) => !emptyGroups.has(gid.get(g))).map((g) => ({ group_id: g.id, title: g.title, bounds: planned(gid.get(g)) })),
    ...freshBoxes,
  ];
  if (boxes.length) out.groups = boxes.slice(0, 40);
  const leftInPlace = nodes.filter((n) => !liveSet.has(n)).map((n) => n.id);
  if (leftInPlace.length) out.left_in_place = leftInPlace;

  if (dry_run) {
    out.dry_run = true;
    out.note = "Nothing was moved. Call again without dry_run to apply.";
    return out;
  }

  // ---- apply ----
  const th = TITLE_H();
  for (const [id, p] of plan.leaves) {
    const [x, y] = at(p);
    const box = emptyGroups.get(id);
    if (box) setGroupRect(box, [x, y, ...groupRect(box).slice(2)]);
    else setNodePos(liveById.get(id), [x, y + th]);
  }
  for (const g of liveGroups) { const r = planned(gid.get(g)); if (r) setGroupRect(g, r); }
  const startColor = everyGroup.length;
  fresh.forEach((f, i) => {
    f.group = addGroupBox(f.title);
    f.group.color = f.color || PALETTE[(startColor + i) % PALETTE.length];
    setGroupRect(f.group, planned(f.block.id));
    freshBoxes[i].group_id = f.group.id;
  });

  // ---- the rest of the canvas ----
  const laidOut = [...liveGroups.map((g) => ({ box: g, members: membersOf.get(g) })), ...fresh.map((f) => ({ box: f.group, members: f.members }))];
  const skip = new Set(laidOut.map((l) => l.box));
  const grown = [];
  if (byIds || scopeGroup) {
    const pushed = makeRoom(before, after, liveSet, skip, membersOf);
    if (pushed) out.pushed_aside = pushed;
    // A box that holds some of the moved nodes (the parent of the tidied group, a half-selected
    // group) grows to keep its nodes and the boxes that were inside it.
    const touched = everyGroup.filter((g) => !skip.has(g) && !isPinned(g) && membersOf.get(g).some((n) => liveSet.has(n)))
      .sort((a, b) => area(groupRect(a)) - area(groupRect(b)));
    for (const g of touched) {
      const mine = new Set(membersOf.get(g));
      const inner = [...laidOut, ...grown].filter((l) => l.members.length && l.members.every((n) => mine.has(n))).map((l) => groupRect(l.box));
      const need = padded(union([...membersOf.get(g).map(nodeRect), ...inner]), groupHead(g));
      setGroupRect(g, union([groupRect(g), need]));
      grown.push({ box: g, members: membersOf.get(g) });
    }
  }
  const placed = live.map(nodeRect);
  const footprint = [...placed, ...laidOut.map((l) => groupRect(l.box))];
  const bumped = allNodes().filter((o) => !liveSet.has(o) && placed.some((r) => overlaps(r, nodeRect(o), 0))).map((o) => o.id);
  const held = new Set(grown.map((l) => l.box)); // boxes around the layout overlap it on purpose
  const bumpedBoxes = allGroups().filter((o) => !skip.has(o) && !held.has(o) && footprint.some((r) => overlaps(r, groupRect(o), 0))).map((o) => o.id);
  if (bumped.length) out.overlaps_nodes = bumped.slice(0, 30);
  if (bumpedBoxes.length) out.overlaps_groups = bumpedBoxes.slice(0, 30);
  if (bumped.length || bumpedBoxes.length) {
    out.note = "The new layout overlaps things that were not part of it (pinned, or outside the scope). Move them, or lay out the whole workflow.";
  }
  return out;
}
