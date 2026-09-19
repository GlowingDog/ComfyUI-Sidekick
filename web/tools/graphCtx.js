// The only place tools reach into ComfyUI globals. Everything resolves against the
// graph currently shown on the canvas (root OR an opened subgraph), never app.graph blindly.
import { app } from "../../../scripts/app.js";

export class ToolError extends Error {}

export const TITLE_H = () => window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;

export function graph() {
  return app.canvas?.graph ?? app.graph;
}

/** Subgraph nodes leading from the root graph to the graph on the canvas ([] on the root). */
export function subgraphTrail() {
  const target = graph(), root = app.rootGraph ?? app.graph;
  if (!root || target === root) return [];
  const walk = (g, trail, depth) => {
    for (const n of g._nodes ?? []) {
      if (!n.isSubgraphNode?.() || !n.subgraph) continue;
      if (n.subgraph === target) return [...trail, n];
      const deeper = depth < 8 ? walk(n.subgraph, [...trail, n], depth + 1) : null;
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(root, [], 0) ?? [];
}

export function allNodes() {
  const g = graph();
  return g._nodes ?? g.nodes ?? [];
}

export function allGroups() {
  const g = graph();
  return g._groups ?? g.groups ?? [];
}

/** graph.links is Map-backed in current frontends, a plain object in old ones. */
export function getLink(id) {
  if (id === null || id === undefined) return null;
  const g = graph();
  const links = g._links ?? g.links;
  if (links instanceof Map) return links.get(id) ?? null;
  return links?.[id] ?? null;
}

export function nodeById(id) {
  // Node ids may be numbers or strings depending on the frontend build: compare as strings.
  const n = graph().getNodeById(id) ?? allNodes().find((x) => String(x.id) === String(id));
  if (!n) {
    const ids = allNodes().map((x) => x.id).slice(0, 40).join(", ");
    throw new ToolError(`No node with id ${id} on the canvas. Existing ids: ${ids || "(none)"}`);
  }
  return n;
}

export function groupById(id) {
  const g = allGroups().find((x) => String(x.id) === String(id));
  if (!g) {
    const ids = allGroups().map((x) => `${x.id}:"${x.title}"`).join(", ");
    throw new ToolError(`No group with id ${id}. Existing groups: ${ids || "(none)"}`);
  }
  return g;
}

/** Visual rectangle of a node including its title bar: [x, y, w, h]. */
export function nodeRect(node) {
  const th = TITLE_H();
  if (node.flags?.collapsed) return [node.pos[0], node.pos[1] - th, node._collapsed_width ?? 160, th];
  return [node.pos[0], node.pos[1] - th, node.size[0], node.size[1] + th];
}

// ---------- group boxes ----------

export const GROUP_PAD = 20;
export const groupRect = (group) => [...(group._bounding ?? [...group.pos, ...group.size])];
export const groupHead = (group) => (group.font_size ?? 24) + 12; // title strip at the top of a group box

export function setGroupRect(group, b) {
  group.pos = [b[0], b[1]];
  group.size = [Math.max(b[2], 140), Math.max(b[3], 80)];
  group.recomputeInsideNodes?.();
}

/** A new, empty group box that is already in the graph (geometry setters need group.graph). */
export function addGroupBox(title) {
  const Group = window.LiteGraph?.LGraphGroup ?? window.LGraphGroup;
  const group = new Group(String(title));
  graph().add(group);
  if (group.id === undefined || group.id === null || group.id < 0) {
    group.id = Math.max(0, ...allGroups().filter((g) => g !== group).map((g) => Number(g.id) || 0)) + 1;
  }
  return group;
}

/** Single choke point for moving nodes (Vue-nodes mode routes geometry through a store). */
export function setNodePos(node, pos) {
  const p = [Math.round(Number(pos[0])), Math.round(Number(pos[1]))];
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new ToolError("pos must be [x, y] numbers.");
  node.pos = p;
}

export function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run mutations as ONE undo step and mark the workflow modified. */
export async function withUndo(fn) {
  const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  tracker?.beforeChange?.();
  try {
    return await fn();
  } finally {
    tracker?.afterChange?.();
    graph().setDirtyCanvas?.(true, true);
  }
}

export function round(n) {
  return Math.round(Number(n) || 0);
}

export { app };
