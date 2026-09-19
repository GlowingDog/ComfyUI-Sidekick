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

// ---------- auto_layout (dagLayout.js) ----------

const leaf = (id, w = 300, h = 120, x = 0, y = 0) => ({ id, w, h, x, y });
const hit = (a, b, gap = 0) => a[0] < b[0] + b[2] + gap && a[0] + a[2] + gap > b[0] && a[1] < b[1] + b[3] + gap && a[1] + a[3] + gap > b[1];
function leafRects(tree, res) {
  const out = [];
  const walk = (b) => b.children.forEach((c) => (c.children ? walk(c) : out.push([...res.leaves.get(c.id), c.w, c.h, c.id])));
  walk(tree);
  return out;
}
const noOverlaps = (rects, gap = 0) => rects.every((a, i) => rects.every((b, j) => i >= j || !hit(a, b, gap)));

test("layoutTree: a chain runs left to right on one line; sockets line up", async () => {
  const { layoutTree } = await import("../../web/tools/dagLayout.js");
  const tree = { id: "root", children: [leaf("c", 200, 80), leaf("a", 300, 200), leaf("b", 400, 100)] };
  const res = layoutTree(tree, [{ from: "a", to: "b" }, { from: "b", to: "c" }], { gapX: 80, gapY: 40 });
  assert.deepEqual([...["a", "b", "c"].map((id) => res.leaves.get(id))], [[0, 0], [380, 0], [860, 0]]);
  assert.deepEqual([res.w, res.h, res.columnsOf.get("root")], [1060, 200, 3]);
  // output socket 100px below a's top feeds an input 30px below b's top -> b sits 70px lower
  const tilted = layoutTree({ id: "root", children: [leaf("a", 300, 200), leaf("b", 400, 100)] }, [{ from: "a", to: "b", fromDy: 100, toDy: 30 }]);
  assert.equal(tilted.leaves.get("b")[1] - tilted.leaves.get("a")[1], 70);
});

test("layoutTree: random DAG has no overlaps and every link points right", async () => {
  const { layoutTree } = await import("../../web/tools/dagLayout.js");
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const leaves = Array.from({ length: 70 }, (_, i) => leaf(i, 140 + Math.floor(rnd() * 300), 60 + Math.floor(rnd() * 400), rnd() * 3000, rnd() * 3000));
  const edges = [];
  for (let j = 1; j < 70; j++) for (let k = 0; k < 2; k++) if (rnd() < 0.7) edges.push({ from: Math.floor(rnd() * j), to: j, fromDy: 40, toDy: 40 + 20 * k });
  const tree = { id: "root", children: leaves };
  const res = layoutTree(tree, edges, { gapX: 80, gapY: 40 });
  const rects = leafRects(tree, res);
  assert.equal(rects.length, 70);
  assert.ok(noOverlaps(rects, 39), "nodes keep their gap");
  for (const e of edges) assert.ok(res.leaves.get(e.to)[0] >= res.leaves.get(e.from)[0] + leaves[e.from].w + 80, `link ${e.from}->${e.to} points right`);
  assert.ok(rects.every((r) => r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= res.w + 1e-6 && r[1] + r[3] <= res.h + 1e-6), "everything inside the reported size");
  assert.deepEqual(layoutTree(tree, edges, { gapX: 80, gapY: 40 }), res, "deterministic");
});

test("layoutTree: cycles, self links and unknown ids do not hang or overlap", async () => {
  const { layoutTree } = await import("../../web/tools/dagLayout.js");
  const tree = { id: "root", children: [leaf("a"), leaf("b"), leaf("c"), leaf("d")] };
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "c", to: "c" }, { from: "c", to: "d" }, { from: "zz", to: "a" }];
  const res = layoutTree(tree, edges);
  assert.ok(noOverlaps(leafRects(tree, res), 39));
  assert.equal(res.columnsOf.get("root"), 4);
});

test("layoutTree: a lone feeder sits next to its consumer, loose nodes are packed not stacked", async () => {
  const { layoutTree } = await import("../../web/tools/dagLayout.js");
  const chain = ["a", "b", "c", "d"].map((id) => leaf(id));
  const tree = { id: "root", children: [...chain, leaf("seed", 200, 60)] };
  const res = layoutTree(tree, [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "seed", to: "d" }]);
  assert.equal(res.leaves.get("seed")[0], res.leaves.get("c")[0], "seed shares the column right before d");
  const loose = { id: "root", children: Array.from({ length: 30 }, (_, i) => leaf(i, 300, 100, (i % 6) * 500, Math.floor(i / 6) * 300)) };
  const packed = layoutTree(loose, []);
  assert.ok(noOverlaps(leafRects(loose, packed), 39));
  assert.ok(packed.w > packed.h, `30 loose nodes form a wide block, not one column (${packed.w}x${packed.h})`);
  assert.ok(packed.leaves.get(0)[1] < packed.leaves.get(29)[1] && packed.leaves.get(0)[0] <= packed.leaves.get(5)[0], "reading order kept");
});

test("layoutTree: groups are blocks — members stay inside, blocks never overlap, nesting works", async () => {
  const { layoutTree } = await import("../../web/tools/dagLayout.js");
  const tree = { id: "root", children: [
    { id: "g:models", pad: 20, head: 36, minW: 500, children: [leaf("ckpt", 320, 100), leaf("lora", 320, 130)] },
    { id: "g:sampling", pad: 20, head: 36, children: [
      leaf("pos", 400, 200), leaf("neg", 400, 200), leaf("ks", 320, 470),
      { id: "g:latent", pad: 20, head: 36, children: [leaf("empty", 320, 110)] },
    ] },
    leaf("decode", 210, 50), leaf("save", 320, 270), leaf("note", 250, 150, 0, 5000),
  ] };
  const edges = [
    { from: "ckpt", to: "lora" }, { from: "lora", to: "pos" }, { from: "lora", to: "neg" }, { from: "lora", to: "ks" },
    { from: "pos", to: "ks" }, { from: "neg", to: "ks" }, { from: "empty", to: "ks" }, { from: "ks", to: "decode" },
    { from: "ckpt", to: "decode" }, { from: "decode", to: "save" },
  ];
  const res = layoutTree(tree, edges);
  const rects = leafRects(tree, res);
  assert.ok(noOverlaps(rects, 39));
  const inside = (r, box, pad, head) => r[0] >= box[0] + pad - 1e-6 && r[1] >= box[1] + pad + head - 1e-6 && r[0] + r[2] <= box[0] + box[2] - pad + 1e-6 && r[1] + r[3] <= box[1] + box[3] - pad + 1e-6;
  const rectOf = (id) => rects.find((r) => r[4] === id);
  for (const id of ["ckpt", "lora"]) assert.ok(inside(rectOf(id), res.blocks.get("g:models"), 20, 36), id);
  for (const id of ["pos", "neg", "ks", "empty"]) assert.ok(inside(rectOf(id), res.blocks.get("g:sampling"), 20, 36), id);
  assert.ok(inside(rectOf("empty"), res.blocks.get("g:latent"), 20, 36));
  assert.ok(inside(res.blocks.get("g:latent"), res.blocks.get("g:sampling"), 20, 36), "nested group inside its parent");
  assert.ok(res.blocks.get("g:models")[2] >= 500, "minW (long title) respected");
  assert.deepEqual([res.columnsOf.get("g:models"), res.columnsOf.get("g:sampling"), res.columnsOf.get("root")], [2, 2, 4]);
  const top = [res.blocks.get("g:models"), res.blocks.get("g:sampling"), rectOf("decode"), rectOf("save"), rectOf("note")];
  assert.ok(noOverlaps(top, 39), "top-level blocks and loose nodes keep clear of each other");
  assert.ok(res.blocks.get("g:models")[0] < res.blocks.get("g:sampling")[0] && res.blocks.get("g:sampling")[0] < rectOf("decode")[0] && rectOf("decode")[0] < rectOf("save")[0], "flow order");
  for (const id of ["ckpt", "lora", "pos", "neg", "ks", "empty"]) assert.ok(!hit(rectOf(id), rectOf("note")) && !hit(rectOf(id), rectOf("decode")));
});

test("placeColumn keeps order, keeps gaps, centres a crowd on what it wants", async () => {
  const { placeColumn } = await import("../../web/tools/dagLayout.js");
  assert.deepEqual(placeColumn([{ want: 0, h: 100, weight: 1 }, { want: 500, h: 100, weight: 1 }], 40), [0, 500]);
  // three boxes all want top=200: they share the pain around it instead of piling downwards
  const tops = placeColumn([1, 2, 3].map(() => ({ want: 200, h: 100, weight: 1 })), 40);
  assert.deepEqual(tops, [60, 200, 340]);
  // a box with no opinion (weight 0) follows the others
  const mixed = placeColumn([{ want: 300, h: 100, weight: 2 }, { want: 0, h: 50, weight: 0 }], 40);
  assert.ok(Math.abs(mixed[0] - 300) < 1 && Math.abs(mixed[1] - 440) < 1, String(mixed));
});

test("context menu entries: labels lose their HTML, paths match exactly before partially", async () => {
  const { entryLabel, opensMenu, describeEntries, findEntry } = await import("../../web/tools/menuMatch.js");
  const menu = [
    { content: "Queue Selected Output Nodes (rgthree) &nbsp;", disabled: true }, null,
    { content: "Mode", has_submenu: true }, { content: '<span style="color:#f00">red</span>' },
    { content: "Colors", has_submenu: true }, "Always", { content: "Pin" }, { content: "Pin all &amp; lock" },
    { content: "Node Templates", submenu: { options: [] } }, { content: "" }, undefined,
  ];
  assert.equal(entryLabel(menu[0]), "Queue Selected Output Nodes (rgthree)");
  assert.equal(entryLabel(menu[3]), "red");
  assert.equal(entryLabel("Always"), "Always");
  assert.equal(entryLabel(menu[7]), "Pin all & lock");
  assert.ok(opensMenu(menu[2]) && opensMenu(menu[8]) && !opensMenu(menu[6]) && !opensMenu("Always") && !opensMenu(null));
  assert.deepEqual(describeEntries(menu), ["Queue Selected Output Nodes (rgthree) (disabled)", "Mode ▸", "red", "Colors ▸", "Always", "Pin", "Pin all & lock", "Node Templates ▸"]);
  assert.deepEqual(describeEntries(menu, 2), ["Queue Selected Output Nodes (rgthree) (disabled)", "Mode ▸", "…6 more"]);
  assert.equal(findEntry(menu, "pin").entry, menu[6]); // exact beats the partial "Pin all & lock"
  assert.equal(findEntry(menu, "Mode ▸").entry, menu[2]); // the marker from a listing is tolerated
  assert.equal(findEntry(menu, "templates").entry, menu[8]);
  assert.equal(findEntry(menu, "ALWAYS").entry, "Always");
  assert.match(findEntry(menu, "o").error, /Several entries match/);
  assert.match(findEntry(menu, "nope").error, /No entry matches "nope". Entries: .*Mode ▸/);
  assert.ok(findEntry(menu, "").error && findEntry(null, "x").error);
});

test("run reports: rejection, success with outputs, runtime error, interrupt", async () => {
  const { rejectionLines, finishedText } = await import("../../web/tools/runReport.js");
  const describe = (id) => `${id} (X)`;
  const rejected = {
    error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation", details: "" },
    node_errors: { 3: { class_type: "KSampler", errors: [
      { type: "required_input_missing", message: "Required input is missing", details: "model" },
      { type: "value_not_in_list", message: "Value not in list", details: "ckpt_name: 'x.safetensors' not in [...]" }] } },
  };
  assert.deepEqual(rejectionLines(rejected, describe), [
    "Prompt outputs failed validation",
    " node 3 (X): Required input is missing — model",
    " node 3 (X): Value not in list — ckpt_name: 'x.safetensors' not in [...]",
  ]);
  assert.deepEqual(rejectionLines(undefined), []);
  assert.deepEqual(rejectionLines({ error: "Queue is full" }), ["Queue is full"]);

  const ok = finishedText("abc", {
    status: { status_str: "success", completed: true, messages: [
      ["execution_start", { timestamp: 1000 }], ["execution_cached", { nodes: ["1", "2"], timestamp: 1001 }], ["execution_success", { timestamp: 13500 }]] },
    outputs: { "57:9": { images: [{ filename: "ComfyUI_00012_.png", subfolder: "", type: "output" }, { filename: "b.png", subfolder: "sub", type: "temp" }] }, 12: { text: ["a cat", "on a mat"] }, 4: {} },
  }, describe);
  assert.match(ok, /^prompt abc: SUCCESS after 12\.5s\n 2 node\(s\) came from the cache/);
  assert.match(ok, / node 57:9 \(X\): ComfyUI_00012_\.png \[output\], sub\/b\.png \[temp\]/);
  assert.match(ok, / node 12 \(X\): text: "a cat on a mat"/);
  assert.ok(!ok.includes("node 4 "), "nodes without files or text are not listed");

  const failed = finishedText("def", { status: { status_str: "error", completed: false, messages: [
    ["execution_start", { timestamp: 0 }],
    ["execution_error", { timestamp: 2000, node_id: "7", node_type: "SaveImage", exception_type: "Exception", exception_message: "Saving image outside the output folder is not allowed.\n", traceback: ["  File \"a.py\", line 1\n", "  File \"b.py\", line 2\n", "    raise Exception\n"] }]] }, outputs: {} }, describe);
  assert.match(failed, /^prompt def: ERROR after 2\.0s\n node 7 \(X\) failed: Exception: Saving image outside the output folder is not allowed\.\n traceback \(last lines\):\n/);
  assert.ok(failed.includes("raise Exception") && !failed.includes("no outputs were produced"));

  const stopped = finishedText("ghi", { status: { status_str: "error", messages: [["execution_start", { timestamp: 0 }], ["execution_interrupted", { timestamp: 500, node_id: "3" }]] }, outputs: {} }, describe);
  assert.equal(stopped, "prompt ghi: INTERRUPTED after 0.5s at node 3 (X)");
  assert.match(finishedText("jkl", { status: { status_str: "success", messages: [] }, outputs: {} }), /SUCCESS\nno outputs were produced/);
});

test("ui tools: keys, control lines, budgets, picking by label", async () => {
  const { parseKey, describeControl, limitLines, pickByText } = await import("../../web/tools/uiText.js");
  const k = (spec) => { const { key, code, keyCode, ctrlKey, shiftKey, altKey, metaKey, error } = parseKey(spec); return error ? "ERR" : [key, code, keyCode, [ctrlKey && "c", shiftKey && "s", altKey && "a", metaKey && "m"].filter(Boolean).join("")]; };
  assert.deepEqual(k("Escape"), ["Escape", "Escape", 27, ""]);
  assert.deepEqual(k("enter"), ["Enter", "Enter", 13, ""]);
  assert.deepEqual(k("ctrl+z"), ["z", "KeyZ", 90, "c"]);
  assert.deepEqual(k("Ctrl + Shift + Z"), ["Z", "KeyZ", 90, "cs"]);
  assert.deepEqual(k("alt+F4"), ["F4", "F4", 115, "a"]);
  assert.deepEqual(k("cmd+/"), ["/", "Slash", 191, "m"]);
  assert.deepEqual(k("ctrl++"), ["+", "Equal", 187, "c"]);
  assert.deepEqual(k("+"), ["+", "Equal", 187, ""]);
  assert.deepEqual(k("down"), ["ArrowDown", "ArrowDown", 40, ""]);
  assert.deepEqual(k("5"), ["5", "Digit5", 53, ""]);
  for (const bad of ["", "ctrl+banana", "hyper+a", "ab"]) assert.equal(k(bad), "ERR", bad);
  assert.equal(parseKey("x").bubbles && parseKey("x").composed, true);

  assert.equal(describeControl({ ref: "e3", role: "textbox", label: " Search\n nodes ", value: "" }), '[e3] textbox "Search nodes" value=""');
  assert.equal(describeControl({ ref: "e4", role: "checkbox", label: "Enable", checked: false, disabled: true }), '[e4] checkbox "Enable" unchecked disabled');
  assert.equal(describeControl({ ref: "e5", role: "textbox", label: "API key", secret: true, value: "sk-123" }), '[e5] textbox "API key" value=(hidden)');
  assert.equal(describeControl({ ref: "e6", role: "tab", label: "", selected: true, expanded: false }), '[e6] tab "(no label)" selected collapsed');
  const many = describeControl({ ref: "e7", role: "combobox", label: "Model", value: "a", options: Array.from({ length: 30 }, (_, i) => `opt${i}`) });
  assert.ok(many.includes("options: opt0 | opt1") && many.endsWith("…(30 in total)") && !many.includes("opt12"));
  assert.ok(describeControl({ ref: "e8", role: "button", label: "x".repeat(300) }).length < 110);

  const lines = [{ header: true, text: "dialog:" }, { text: '  [e1] button "Install"' }, { text: "  ComfyUI Impact Pack" }, { text: '  [e2] button "Uninstall"' }];
  assert.deepEqual(limitLines(lines, { query: "install" }), ["dialog:", '  [e1] button "Install"', '  [e2] button "Uninstall"']);
  assert.deepEqual(limitLines(lines, { limit: 2 }), ["dialog:", '  [e1] button "Install"', "…2 more line(s): pass query to narrow, or a higher limit."]);
  assert.deepEqual(limitLines(lines, { query: "zzz" }), ["dialog:", '(nothing on screen matches "zzz")']);

  const controls = [{ ref: "e1", role: "button", label: "Install" }, { ref: "e2", role: "button", label: "Uninstall" }, { ref: "e3", role: "button", label: "Close", disabled: true }, { ref: "e4", role: "tab", label: "Installed packs" }];
  assert.equal(pickByText(controls, "install").control.ref, "e1"); // exact beats "Uninstall" and "Installed packs"
  assert.equal(pickByText(controls, "packs").control.ref, "e4");
  assert.match(pickByText(controls, "inst").error, /3 elements match "inst": \[e1\] button "Install"/);
  assert.match(pickByText(controls, "close").error, /Nothing clickable/); // disabled controls are not offered
  assert.ok(pickByText(controls, " ").error);
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
