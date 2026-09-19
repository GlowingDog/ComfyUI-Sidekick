// Run: node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";
import { autoMatch, matchKind, resolveSlot } from "../../web/tools/connectMatch.js";
import { coerceWidgetValue } from "../../web/tools/widgetCoerce.js";
import { renderMarkdown } from "../../web/ui/markdown.js";

const ckptOut = [{ name: "MODEL", type: "MODEL" }, { name: "CLIP", type: "CLIP" }, { name: "VAE", type: "VAE" }];
const ksIn = [
  { name: "model", type: "MODEL", linked: false }, { name: "positive", type: "CONDITIONING", linked: true },
  { name: "negative", type: "CONDITIONING", linked: false }, { name: "latent_image", type: "LATENT", linked: false },
  { name: "seed", type: "INT", linked: false, widget: true },
];

test("matchKind", () => {
  assert.equal(matchKind("MODEL", "MODEL"), "exact");
  assert.equal(matchKind("IMAGE", "IMAGE,MASK"), "exact");
  assert.equal(matchKind("MODEL", "CLIP"), null);
  assert.equal(matchKind("*", "CLIP"), "wildcard");
  assert.equal(matchKind("COMBO", "STRING"), null);
  assert.equal(matchKind("COMBO", "COMBO"), "exact");
});

test("resolveSlot by name, case, index, unique type; never guesses", () => {
  assert.equal(resolveSlot(ksIn, "negative"), 2);
  assert.equal(resolveSlot(ksIn, "NEGATIVE"), 2);
  assert.equal(resolveSlot(ksIn, 3), 3);
  assert.equal(resolveSlot(ksIn, "LATENT"), 3);
  assert.equal(resolveSlot(ksIn, "CONDITIONING"), -1); // ambiguous type
  assert.equal(resolveSlot(ksIn, "nope"), -1);
  assert.equal(resolveSlot(ksIn, 99), -1);
});

test("autoMatch picks exact type and prefers open inputs", () => {
  assert.deepEqual(pick(autoMatch(ckptOut, ksIn)), [0, 0]);
  const cond = [{ name: "CONDITIONING", type: "CONDITIONING" }];
  assert.deepEqual(pick(autoMatch(cond, ksIn)), [0, 2]); // positive is taken -> negative
  assert.deepEqual(pick(autoMatch(cond, ksIn, -1, 1)), [0, 1]); // explicit input wins
  assert.ok(autoMatch([{ name: "IMAGE", type: "IMAGE" }], ksIn).error);
  assert.ok(autoMatch(ckptOut, ksIn, 1, 0).error); // CLIP -> model explicit mismatch
  assert.ok(autoMatch([{ name: "any", type: "*" }], ksIn).error); // wildcard never auto-picks
  assert.equal(autoMatch([{ name: "any", type: "*" }], ksIn, 0, 3).kind, "wildcard");
});
const pick = (m) => [m.out, m.in];

test("coerceWidgetValue", () => {
  const combo = { type: "combo", options: { values: ["normal", "karras", "sgm_uniform"] } };
  assert.equal(coerceWidgetValue(combo, "Karras").value, "karras");
  assert.equal(coerceWidgetValue(combo, "sgm").value, "sgm_uniform");
  const bad = coerceWidgetValue(combo, "exponential");
  assert.equal(bad.ok, false);
  assert.match(coerceWidgetValue(combo, "uniform_x").error, /not an option/);
  assert.equal(coerceWidgetValue({ type: "number", options: { min: 0, max: 100 } }, "7.5").value, 7.5);
  assert.equal(coerceWidgetValue({ type: "number", options: { min: 0, max: 100 } }, 500).value, 100);
  assert.equal(coerceWidgetValue({ type: "number", options: { precision: 0 } }, 20.6).value, 21);
  assert.equal(coerceWidgetValue({ type: "number", options: {} }, "abc").ok, false);
  assert.equal(coerceWidgetValue({ type: "toggle" }, "false").value, false);
  assert.equal(coerceWidgetValue({ type: "customtext" }, 42).value, "42");
});

test("arrange: row, column, grid use real sizes and never overlap", async () => {
  const { arrange, overlaps, freeSpotInArea, union } = await import("../../web/tools/layoutMath.js");
  const rects = [{ id: 1, w: 400, h: 230 }, { id: 2, w: 270, h: 100 }, { id: 3, w: 400, h: 230 }, { id: 4, w: 140, h: 76 }, { id: 5, w: 300, h: 300 }];
  const placed = (spots) => spots.map((s, i) => [s.x, s.y, rects[i].w, rects[i].h]);
  const clean = (rs) => rs.every((a, i) => rs.every((b, j) => i === j || !overlaps(a, b, 0)));

  const row = arrange(rects, { direction: "row", gap: 50, origin: [100, 200] });
  assert.deepEqual(row.map((s) => s.x), [100, 550, 870, 1320, 1510]);
  assert.ok(row.every((s) => s.y === 200) && clean(placed(row)));

  const col = arrange(rects, { direction: "column", gap: 40, origin: [0, 0] });
  assert.deepEqual(col.map((s) => s.y), [0, 270, 410, 680, 796]);
  assert.ok(clean(placed(col)));

  const grid = arrange(rects, { direction: "grid", columns: 2, gap: 40 });
  assert.deepEqual(grid.map((s) => [s.x, s.y]), [[0, 0], [440, 0], [0, 270], [440, 270], [0, 540]]);
  assert.ok(clean(placed(grid)));
  assert.equal(arrange(rects, { direction: "grid" }).filter((s) => s.y === 0).length, 3); // ~square: 3 columns

  assert.deepEqual(union([[0, 0, 10, 10], [20, 30, 10, 10]]), [0, 0, 30, 40]);
  // inside an 900-wide area with one node already there: next to it; when the row is full: wraps below
  const taken = [[0, 0, 400, 200]];
  assert.deepEqual(freeSpotInArea([0, 0, 900, 600], 400, 200, taken, { gapX: 60, gapY: 40 }), [460, 0]);
  taken.push([460, 0, 400, 200]);
  assert.deepEqual(freeSpotInArea([0, 0, 900, 600], 400, 200, taken, { gapX: 60, gapY: 40 }), [0, 240]);
});

test("markdown escapes html and only links http(s)", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **bold** `a<b` [x](javascript:alert(1)) [ok](https://a.b/c)');
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>a&lt;b</code>"));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('href="https://a.b/c"'));
  assert.ok(renderMarkdown("- a\n- b\n\n```\n<x>\n```").includes("<ul><li>a</li><li>b</li></ul><pre><code>&lt;x&gt;"));
});
