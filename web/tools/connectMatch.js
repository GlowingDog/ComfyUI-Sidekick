// Pure slot-resolution and type-matching logic (no ComfyUI imports; unit-tested in node).
// Rules learned from prior art: never silently fall back to slot 0, never let a
// wildcard or COMBO match by accident, and on failure describe every slot.

const norm = (t) => String(t ?? "").trim().toUpperCase();
const parts = (t) => norm(t).split(",").map((s) => s.trim()).filter(Boolean);

export function isWildcard(t) {
  const n = norm(t);
  return n === "*" || n === "";
}

/** exact: a concrete shared type. wildcard: only compatible through "*". */
export function matchKind(outType, inType) {
  if (isWildcard(outType) || isWildcard(inType)) return "wildcard";
  const a = parts(outType);
  const b = parts(inType);
  if (a.includes("COMBO") || b.includes("COMBO")) return norm(outType) === norm(inType) ? "exact" : null;
  return a.some((x) => b.includes(x)) ? "exact" : null;
}

/** Resolve a slot reference (name or index) to an index, or -1. */
export function resolveSlot(slots, ref) {
  if (ref === undefined || ref === null || ref === "") return -1;
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    const i = Number(ref);
    return i >= 0 && i < slots.length ? i : -1;
  }
  const want = String(ref);
  let i = slots.findIndex((s) => s.name === want);
  if (i < 0) i = slots.findIndex((s) => String(s.name).toLowerCase() === want.toLowerCase());
  if (i < 0) i = slots.findIndex((s) => String(s.label ?? "").toLowerCase() === want.toLowerCase());
  if (i < 0) {
    // by type, only when unambiguous
    const byType = slots.map((s, k) => [s, k]).filter(([s]) => norm(s.type) === norm(want));
    if (byType.length === 1) i = byType[0][1];
  }
  return i;
}

/**
 * Pick (outputIndex, inputIndex). outputs/inputs: [{name, type, linked, widget}].
 * fromIdx/toIdx: already-resolved index or -1 for "choose for me".
 * Returns {out, in, kind} or {error}.
 */
export function autoMatch(outputs, inputs, fromIdx = -1, toIdx = -1) {
  const outs = fromIdx >= 0 ? [fromIdx] : outputs.map((_, i) => i);
  const ins = toIdx >= 0 ? [toIdx] : inputs.map((_, i) => i);
  const explicit = fromIdx >= 0 && toIdx >= 0;
  let best = null;
  for (const o of outs) {
    for (const i of ins) {
      const kind = matchKind(outputs[o].type, inputs[i].type);
      if (!kind) continue;
      if (kind === "wildcard" && !explicit && fromIdx < 0 && toIdx < 0) continue; // too vague
      let score = kind === "exact" ? 100 : 10;
      if (!inputs[i].linked) score += 20; // prefer filling open inputs
      if (!inputs[i].widget) score += 5; // prefer real sockets over widget-inputs
      score -= o * 0.01 + i * 0.001; // stable: earlier slots win ties
      if (!best || score > best.score) best = { out: o, in: i, kind, score };
    }
  }
  if (!best) {
    return { error: explicit ? "Those two slots have incompatible types." : "No type-compatible output/input pair." };
  }
  return best;
}

export function describeSlots(label, slots) {
  if (!slots.length) return `${label}: (none)`;
  return `${label}: ` + slots.map((s, i) => `${i}:${s.name}(${s.type}${s.linked ? ",linked" : ""}${s.widget ? ",widget" : ""})`).join(" ");
}
