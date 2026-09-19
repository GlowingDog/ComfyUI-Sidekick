// Subgraphs: every tool works on the graph shown on the canvas, so looking inside or editing a
// subgraph means navigating into it (the user sees the same thing). Node ids are local to each
// graph; ComfyUI names inner nodes in errors as "<subgraph node id>:<inner id>", e.g. "57:12".
import { app, ToolError, graph, nodeById, subgraphTrail, tick } from "./graphCtx.js";

export function whereText() {
  const trail = subgraphTrail();
  const g = graph();
  if (!trail.length) return g === (app.rootGraph ?? app.graph) ? "canvas shows: the root graph" : "canvas shows: a subgraph";
  const last = trail[trail.length - 1];
  return `canvas shows: subgraph ${JSON.stringify(last.subgraph?.name ?? last.title)} = node ${trail.map((n) => n.id).join(":")} of the root graph (${(g._nodes ?? []).length} nodes inside; ids here are local to it)`;
}

function tree(g, prefix, depth, lines, current) {
  for (const n of g._nodes ?? []) {
    if (!n.isSubgraphNode?.() || !n.subgraph) continue;
    const id = prefix ? `${prefix}:${n.id}` : String(n.id);
    const io = `${n.inputs?.length ?? 0} in / ${n.outputs?.length ?? 0} out`;
    lines.push(`${"  ".repeat(depth)}${id} ${JSON.stringify(n.title ?? n.subgraph.name)} — ${(n.subgraph._nodes ?? []).length} nodes, ${io}${n.subgraph === current ? "   <- on the canvas now" : ""}`);
    if (depth < 8) tree(n.subgraph, id, depth + 1, lines, current);
  }
}

function resolve(ref) {
  const parts = String(ref).split(":");
  if (parts.length === 1) return nodeById(ref); // a node on the canvas as it is now
  let g = app.rootGraph ?? app.graph, node = null; // "57:12": a path from the root graph
  for (const p of parts) {
    node = (g?._nodes ?? []).find((n) => String(n.id) === p) ?? null;
    if (!node) throw new ToolError(`No node "${p}" on the way to "${ref}". Use action "list" to see the subgraphs.`);
    g = node.subgraph;
  }
  return node;
}

export async function subgraph({ action = "list", node_id } = {}) {
  const c = app.canvas;
  if (action === "list") {
    const lines = [];
    tree(app.rootGraph ?? app.graph, "", 0, lines, graph());
    return [whereText(), lines.length ? "subgraphs (path id from the root | title | size):" : "This workflow has no subgraphs.", ...lines].join("\n");
  }
  if (action === "enter") {
    if (node_id === undefined || node_id === null || node_id === "") throw new ToolError("enter needs node_id: a subgraph node on the canvas, or a path from the root like \"57:12\".");
    const node = resolve(node_id);
    if (!node.isSubgraphNode?.() || !node.subgraph) throw new ToolError(`Node ${node.id} (${node.type}) is not a subgraph.`);
    if (typeof c.openSubgraph !== "function") throw new ToolError("This ComfyUI frontend cannot open subgraphs from code.");
    c.openSubgraph(node.subgraph, node);
    await tick(250);
    if (graph() !== node.subgraph) throw new ToolError("The canvas did not switch to the subgraph.");
    return `${whereText()}\nAll tools now read and edit this subgraph. Use action "exit" to go back up.`;
  }
  if (action === "exit" || action === "root") {
    const root = app.rootGraph ?? app.graph;
    if (graph() === root) return whereText();
    const trail = subgraphTrail();
    const up = action === "root" || trail.length < 2 ? root : trail[trail.length - 2].subgraph;
    if (typeof c.setGraph === "function") c.setGraph(up); else await app.extensionManager.command.execute("Comfy.Graph.ExitSubgraph");
    await tick(250);
    return whereText();
  }
  throw new ToolError('action must be "list", "enter", "exit" or "root".');
}
