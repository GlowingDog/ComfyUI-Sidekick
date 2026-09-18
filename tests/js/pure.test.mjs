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

test("markdown escapes html and only links http(s)", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **bold** `a<b` [x](javascript:alert(1)) [ok](https://a.b/c)');
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>a&lt;b</code>"));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('href="https://a.b/c"'));
  assert.ok(renderMarkdown("- a\n- b\n\n```\n<x>\n```").includes("<ul><li>a</li><li>b</li></ul><pre><code>&lt;x&gt;"));
});
