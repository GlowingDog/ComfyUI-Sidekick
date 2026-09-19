// Pure helpers for the DOM automation tools (no DOM access here; unit-tested in node).

const NAMED = {
  enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  tab: ["Tab", "Tab", 9], space: [" ", "Space", 32], backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46],
  del: ["Delete", "Delete", 46], insert: ["Insert", "Insert", 45], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34], arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  left: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
};
const MODS = { ctrl: "ctrlKey", control: "ctrlKey", shift: "shiftKey", alt: "altKey", option: "altKey", meta: "metaKey", cmd: "metaKey", win: "metaKey" };
const PUNCT = { ".": ["Period", 190], ",": ["Comma", 188], "/": ["Slash", 191], ";": ["Semicolon", 186], "'": ["Quote", 222], "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221], "\\": ["Backslash", 220], "-": ["Minus", 189], "=": ["Equal", 187], "`": ["Backquote", 192] };

/** "ctrl+shift+z", "Escape", "F2", "a" -> KeyboardEvent init ({key, code, keyCode, which, ctrlKey, …}) or {error}. */
export function parseKey(spec) {
  const raw = String(spec ?? "").trim();
  if (!raw) return { error: "key is required, e.g. \"Escape\", \"Enter\", \"ctrl+z\"." };
  // "+" is both the separator and a key: "ctrl++" and "+" mean the plus key.
  const plusKey = raw.endsWith("+");
  const parts = (plusKey ? raw.slice(0, -1) : raw).split("+").map((p) => p.trim()).filter(Boolean);
  const init = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, bubbles: true, cancelable: true, composed: true };
  const main = plusKey ? "+" : parts.pop() ?? "";
  for (const p of parts) {
    const mod = MODS[p.toLowerCase()];
    if (!mod) return { error: `Unknown modifier "${p}". Use ctrl, shift, alt, meta.` };
    init[mod] = true;
  }
  const low = main.toLowerCase();
  let key, code, keyCode;
  if (NAMED[low]) [key, code, keyCode] = NAMED[low];
  else if (/^f([1-9]|1[0-2])$/.test(low)) { key = code = low.toUpperCase(); keyCode = 111 + Number(low.slice(1)); }
  else if (/^[a-z]$/i.test(main)) { key = init.shiftKey ? main.toUpperCase() : main.toLowerCase(); code = "Key" + main.toUpperCase(); keyCode = main.toUpperCase().charCodeAt(0); }
  else if (/^[0-9]$/.test(main)) { key = main; code = "Digit" + main; keyCode = 48 + Number(main); }
  else if (PUNCT[main]) { key = main; [code, keyCode] = PUNCT[main]; }
  else if (main === "+") { key = "+"; code = "Equal"; keyCode = 187; }
  else return { error: `Unknown key "${main}". Use a letter, a digit, F1-F12, or: ${Object.keys(NAMED).filter((k) => k.length > 3).join(", ")}.` };
  return { ...init, key, code, keyCode, which: keyCode };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * One outline line for an interactive element.
 * d: {ref, role, label, value, checked, selected, expanded, disabled, options: [text], optionsTotal, secret, multiline}
 */
export function describeControl(d) {
  const bits = [`[${d.ref}]`, d.role || "element"];
  bits.push(JSON.stringify(clip(squash(d.label) || "(no label)", 90)));
  if (d.secret) bits.push("value=(hidden)");
  else if (d.value !== undefined && d.value !== null && d.value !== "") bits.push(`value=${JSON.stringify(clip(squash(d.value), d.multiline ? 200 : 80))}`);
  else if (d.value === "") bits.push('value=""');
  if (d.checked === true) bits.push("checked"); else if (d.checked === false) bits.push("unchecked");
  if (d.selected) bits.push("selected");
  if (d.expanded === true) bits.push("expanded"); else if (d.expanded === false) bits.push("collapsed");
  if (d.disabled) bits.push("disabled");
  if (Array.isArray(d.options) && d.options.length) {
    const shown = d.options.slice(0, 12).map((o) => clip(squash(o), 40));
    bits.push(`options: ${shown.join(" | ")}${(d.optionsTotal ?? d.options.length) > shown.length ? ` | …(${d.optionsTotal ?? d.options.length} in total)` : ""}`);
  }
  return bits.join(" ");
}

/** Keep the outline inside a budget: lines that match `query` (and headers) first, then the rest in order. */
export function limitLines(lines, { query, limit = 120 } = {}) {
  const q = squash(query).toLowerCase();
  let rows = lines;
  if (q) {
    const toks = q.split(" ");
    rows = lines.filter((l) => l.header || toks.every((t) => l.text.toLowerCase().includes(t)));
  }
  const out = rows.slice(0, limit).map((l) => l.text);
  if (rows.length > limit) out.push(`…${rows.length - limit} more line(s): pass query to narrow, or a higher limit.`);
  if (q && !rows.some((l) => !l.header)) out.push(`(nothing on screen matches "${query}")`);
  return out;
}

/** Pick one control by its label: exact (case-insensitive) first, then a unique partial match. */
export function pickByText(controls, want) {
  const w = squash(want).toLowerCase();
  if (!w) return { error: "text is empty." };
  const live = controls.filter((c) => !c.disabled);
  const exact = live.filter((c) => squash(c.label).toLowerCase() === w);
  if (exact.length === 1) return { control: exact[0] };
  const pool = exact.length ? exact : live.filter((c) => squash(c.label).toLowerCase().includes(w));
  if (pool.length === 1) return { control: pool[0] };
  if (!pool.length) return { error: `Nothing clickable is labelled "${want}". Take a ui_snapshot and use a ref.` };
  return { error: `${pool.length} elements match "${want}": ${pool.slice(0, 8).map((c) => `[${c.ref}] ${c.role} ${JSON.stringify(clip(squash(c.label), 40))}`).join(", ")}. Use the ref.` };
}
