// Pure layered-graph layout (no ComfyUI imports; unit-tested in node).
// Left-to-right flow: links decide the column, neighbours decide the height, and a group is laid
// out on its own first and then placed as ONE block among its siblings.
//
// Input tree:  leaf  {id, w, h, x?, y?}                        x,y = where it is now (ordering hint)
//              block {id, children: [...], pad?, head?, minW?, x?, y?}
// Edges join LEAF ids: {from, to, fromDy?, toDy?}  (Dy = socket height below the leaf's top, so
// links come out horizontal instead of merely centred). Ids must be unique across leaves+blocks.

const EPS = 1e-3;
const byHint = (a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0);

/**
 * Tops for a stack of boxes kept in order and never overlapping, as close as possible (weighted
 * least squares) to the tops they want. Isotonic regression, pool-adjacent-violators.
 * rows: [{want, h, weight}]
 */
export function placeColumn(rows, gap) {
  const off = [];
  let acc = 0;
  for (const r of rows) { off.push(acc); acc += r.h + gap; }
  const pools = [];
  rows.forEach((r, i) => {
    const w = r.weight > 0 ? r.weight : EPS;
    pools.push({ w, wt: w * (r.want - off[i]), n: 1 });
    while (pools.length > 1) {
      const a = pools[pools.length - 2], b = pools[pools.length - 1];
      if (a.wt / a.w <= b.wt / b.w) break;
      a.w += b.w; a.wt += b.wt; a.n += b.n;
      pools.pop();
    }
  });
  const tops = [];
  let i = 0;
  for (const p of pools) for (let k = 0; k < p.n; k++, i++) tops.push(p.wt / p.w + off[i]);
  return tops;
}

function splitComponents(items, edges) {
  const parent = new Map(items.map((it) => [it.id, it.id]));
  const find = (a) => {
    while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); }
    return a;
  };
  for (const e of edges) parent.set(find(e.from), find(e.to));
  const byRoot = new Map();
  for (const it of items) {
    const r = find(it.id);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(it);
  }
  return [...byRoot.values()];
}

/** Column per item: longest path from the sources, then everything slides right to sit next to
 *  its nearest consumer (short links). Links that close a cycle are ignored. */
function layerize(items, edges) {
  const ids = items.map((it) => it.id);
  const out = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) { out.get(e.from).push(e); indeg.set(e.to, indeg.get(e.to) + 1); }

  const state = new Map(), topo = [], dag = [];
  const visit = (start) => { // iterative DFS: deep chains must not blow the call stack
    const stack = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const es = out.get(top[0]);
      if (top[1] < es.length) {
        const e = es[top[1]++];
        const s = state.get(e.to) ?? 0;
        if (s === 1) continue; // target is still on the stack: this link closes a cycle
        dag.push(e);
        if (s === 0) { state.set(e.to, 1); stack.push([e.to, 0]); }
      } else {
        state.set(top[0], 2);
        topo.push(top[0]);
        stack.pop();
      }
    }
  };
  for (const id of ids) if (indeg.get(id) === 0 && !state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id); // pure cycles have no source
  topo.reverse();

  const next = new Map(ids.map((id) => [id, []]));
  for (const e of dag) next.get(e.from).push(e.to);
  const layer = new Map(ids.map((id) => [id, 0]));
  for (const u of topo) for (const v of next.get(u)) layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
  for (const u of [...topo].reverse()) {
    const vs = next.get(u);
    if (vs.length) layer.set(u, Math.max(layer.get(u), Math.min(...vs.map((v) => layer.get(v))) - 1));
  }
  const used = [...new Set(layer.values())].sort((a, b) => a - b); // sliding can empty a column
  for (const id of ids) layer.set(id, used.indexOf(layer.get(id)));
  return { layer, dag, count: used.length };
}

function layoutComponent(items, edges, { gapX, gapY }) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const { layer, dag, count } = layerize(items, edges);
  let cols = Array.from({ length: count }, () => []);
  for (const it of [...items].sort(byHint)) cols[layer.get(it.id)].push(it.id);

  const top = new Map();
  for (const col of cols) { let y = 0; for (const id of col) { top.set(id, y); y += byId.get(id).h + gapY; } }
  // wanted top of X = top(neighbour) + shift, so that the two sockets of the link line up
  const preds = new Map(items.map((it) => [it.id, []])), succs = new Map(items.map((it) => [it.id, []]));
  for (const e of dag) {
    const d = (e.fromDy ?? 0) - (e.toDy ?? 0);
    preds.get(e.to).push({ id: e.from, shift: d });
    succs.get(e.from).push({ id: e.to, shift: -d });
  }
  const sweep = (l, sides, resort) => {
    const rows = cols[l].map((id, i) => {
      const ns = sides.flatMap((m) => m.get(id));
      const want = ns.length ? ns.reduce((s, n) => s + top.get(n.id) + n.shift, 0) / ns.length : top.get(id);
      return { id, i, want, h: byId.get(id).h, weight: ns.length };
    });
    if (resort) rows.sort((a, b) => a.want - b.want || a.i - b.i);
    const tops = placeColumn(rows, gapY);
    rows.forEach((r, k) => top.set(r.id, tops[k]));
    cols[l] = rows.map((r) => r.id);
  };
  for (let round = 0; round < 2; round++) { // order: fewer crossings
    for (let l = 1; l < count; l++) sweep(l, [preds], true);
    for (let l = count - 2; l >= 0; l--) sweep(l, [succs], true);
  }
  for (let round = 0; round < 2; round++) { // heights: straighter links, order kept
    for (let l = 0; l < count; l++) sweep(l, [preds, succs], false);
  }

  const pos = new Map();
  const minTop = Math.min(...top.values());
  let x = 0, h = 0;
  for (const col of cols) {
    const colW = Math.max(...col.map((id) => byId.get(id).w));
    for (const id of col) {
      const y = top.get(id) - minTop;
      pos.set(id, [x, y]);
      h = Math.max(h, y + byId.get(id).h);
    }
    x += colW + gapX;
  }
  return { pos, w: x - gapX, h, columns: count };
}

/** Rows of boxes, wrapped to a roughly screen-shaped area; reading order follows where they are. */
function packShelves(boxes, { gapX, gapY, aspect = 2 }) {
  const area = boxes.reduce((s, b) => s + (b.w + gapX) * (b.h + gapY), 0);
  const limit = Math.max(...boxes.map((b) => b.w), Math.sqrt(area * aspect));
  const rows = [];
  let row = null;
  for (const b of [...boxes].sort(byHint)) {
    if (!row || row.w + gapX + b.w > limit) { row = { boxes: [], w: -gapX, h: 0 }; rows.push(row); }
    row.boxes.push(b);
    row.w += gapX + b.w;
    row.h = Math.max(row.h, b.h);
  }
  const pos = new Map();
  let y = 0, w = 0;
  for (const r of rows) {
    r.boxes.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    let x = 0;
    for (const b of r.boxes) { pos.set(b.id, [x, y]); x += b.w + gapX; }
    w = Math.max(w, x - gapX);
    y += r.h + gapY;
  }
  return { pos, w, h: y - gapY };
}

/** One level: every connected piece is layered on its own, then the pieces are packed. */
function layoutLevel(items, edges, opts) {
  if (!items.length) return { pos: new Map(), w: 0, h: 0, columns: 0 };
  const comps = splitComponents(items, edges);
  const compOf = new Map();
  comps.forEach((c, i) => c.forEach((it) => compOf.set(it.id, i)));
  const edgesOf = comps.map(() => []);
  for (const e of edges) edgesOf[compOf.get(e.from)].push(e);
  const laid = comps.map((c, i) => ({
    id: i, ...layoutComponent(c, edgesOf[i], opts),
    x: Math.min(...c.map((it) => it.x ?? 0)), y: Math.min(...c.map((it) => it.y ?? 0)),
  }));
  const packed = packShelves(laid, { gapX: opts.gapX, gapY: opts.gapY * 1.5 });
  const pos = new Map();
  for (const c of laid) {
    const [cx, cy] = packed.pos.get(c.id);
    for (const [id, p] of c.pos) pos.set(id, [cx + p[0], cy + p[1]]);
  }
  return { pos, w: packed.w, h: packed.h, columns: Math.max(...laid.map((c) => c.columns)) };
}

/**
 * Lay out a tree of leaves and blocks. Returns positions relative to the root's top-left:
 * {leaves: Map(id -> [x, y]), blocks: Map(id -> [x, y, w, h]), w, h, columnsOf: Map(block id -> n)}.
 */
export function layoutTree(root, edges, opts = {}) {
  const o = { gapX: 80, gapY: 40, ...opts };
  const links = edges.filter((e) => e.from !== e.to);
  const walk = (block, isRoot) => {
    const items = [], inner = new Map(), itemOf = new Map();
    for (const child of block.children) {
      if (Array.isArray(child.children)) {
        const sub = walk(child, false);
        inner.set(child.id, sub);
        items.push({ id: child.id, w: sub.w, h: sub.h, x: child.x, y: child.y });
        for (const leafId of sub.leaves.keys()) itemOf.set(leafId, child.id);
      } else {
        items.push({ id: child.id, w: child.w, h: child.h, x: child.x, y: child.y });
        itemOf.set(child.id, child.id);
      }
    }
    const itemEdges = [];
    for (const e of links) {
      const a = itemOf.get(e.from), b = itemOf.get(e.to);
      if (a === undefined || b === undefined || a === b) continue;
      itemEdges.push({
        from: a, to: b,
        fromDy: (inner.get(a)?.leaves.get(e.from)[1] ?? 0) + (e.fromDy ?? 0),
        toDy: (inner.get(b)?.leaves.get(e.to)[1] ?? 0) + (e.toDy ?? 0),
      });
    }
    const level = layoutLevel(items, itemEdges, o);
    const pad = isRoot ? 0 : block.pad ?? 20;
    const padTop = pad + (isRoot ? 0 : block.head ?? 36);
    const leaves = new Map(), blocks = new Map();
    columnsOf.set(block.id, level.columns);
    for (const it of items) {
      const [x, y] = level.pos.get(it.id);
      const sub = inner.get(it.id);
      if (!sub) { leaves.set(it.id, [pad + x, padTop + y]); continue; }
      blocks.set(it.id, [pad + x, padTop + y, sub.w, sub.h]);
      for (const [id, p] of sub.leaves) leaves.set(id, [pad + x + p[0], padTop + y + p[1]]);
      for (const [id, r] of sub.blocks) blocks.set(id, [pad + x + r[0], padTop + y + r[1], r[2], r[3]]);
    }
    return { leaves, blocks, w: Math.max(level.w + 2 * pad, isRoot ? 0 : block.minW ?? 0), h: level.h + padTop + pad };
  };
  const columnsOf = new Map(); // block id -> columns of its own flow ("root" included)
  return { ...walk(root, true), columnsOf };
}
