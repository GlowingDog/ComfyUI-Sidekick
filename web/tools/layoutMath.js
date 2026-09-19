// Pure layout arithmetic (no ComfyUI imports; unit-tested in node).
// Rects are VISUAL rectangles: {id, w, h} including the node title bar.

/** Positions (top-left of each visual rect) for a row, column or grid. Order is kept. */
export function arrange(rects, { direction = "row", gap = 40, columns, origin = [0, 0] } = {}) {
  const g = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 40;
  const [ox, oy] = [Number(origin[0]) || 0, Number(origin[1]) || 0];
  const out = [];
  if (direction === "column") {
    let y = oy;
    for (const r of rects) { out.push({ id: r.id, x: ox, y }); y += r.h + g; }
    return out;
  }
  if (direction === "grid") {
    const cols = Math.max(1, Math.min(rects.length, Math.round(Number(columns)) || Math.ceil(Math.sqrt(rects.length))));
    const colW = [], rowH = [];
    rects.forEach((r, i) => {
      const c = i % cols, row = Math.floor(i / cols);
      colW[c] = Math.max(colW[c] ?? 0, r.w);
      rowH[row] = Math.max(rowH[row] ?? 0, r.h);
    });
    const colX = [], rowY = [];
    colW.reduce((x, w, c) => { colX[c] = x; return x + w + g; }, ox);
    rowH.reduce((y, h, row) => { rowY[row] = y; return y + h + g; }, oy);
    rects.forEach((r, i) => out.push({ id: r.id, x: colX[i % cols], y: rowY[Math.floor(i / cols)] }));
    return out;
  }
  let x = ox; // row
  for (const r of rects) { out.push({ id: r.id, x, y: oy }); x += r.w + g; }
  return out;
}

export function overlaps(a, b, pad = 10) {
  return a[0] < b[0] + b[2] + pad && a[0] + a[2] + pad > b[0] && a[1] < b[1] + b[3] + pad && a[1] + a[3] + pad > b[1];
}

/** Union of [x, y, w, h] rects. */
export function union(rects) {
  const x0 = Math.min(...rects.map((r) => r[0])), y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2])), y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * First free spot for a w×h rect inside an area [x, y, w, h], scanning left→right then
 * wrapping to a new row. `taken` are rects to avoid. May end below the area (caller grows it).
 */
export function freeSpotInArea(area, w, h, taken, { gapX = 60, gapY = 40 } = {}) {
  const [ax, ay, aw] = area;
  let x = ax, y = ay;
  for (let guard = 0; guard < 500; guard++) {
    const r = [x, y, w, h];
    const hit = taken.find((o) => overlaps(r, o));
    if (!hit) break;
    x = hit[0] + hit[2] + gapX;
    if (x + w > ax + aw && aw >= w) { // no room left on this row: wrap
      const band = taken.filter((o) => o[1] < y + h && o[1] + o[3] > y && o[0] + o[2] > ax && o[0] < ax + aw);
      y = Math.max(y + h, ...band.map((o) => o[1] + o[3])) + gapY;
      x = ax;
    }
  }
  return [x, y];
}
