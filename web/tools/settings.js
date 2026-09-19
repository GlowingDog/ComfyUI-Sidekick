// ComfyUI's own settings (what the Settings dialog edits), by id: search, read, change.
// Changing one is persistent and not covered by Ctrl+Z, so sidekick/tooldefs/ui.py makes
// action "set" go through the permission card.
import { app, ToolError } from "./graphCtx.js";

const SECRET = /key|token|secret|password|passwd|credential/i;
const NUMERIC = new Set(["number", "slider", "knob"]);

function store() {
  const s = app.extensionManager?.setting;
  if (typeof s?.get !== "function" || typeof s?.set !== "function") throw new ToolError("This ComfyUI frontend does not expose its settings.");
  return s;
}

function definitions() {
  const d = store().settings ?? app.ui?.settings?.settingsLookup ?? {};
  return Array.isArray(d) ? d : Object.values(d);
}

const typeOf = (d) => (typeof d.type === "function" ? "custom" : String(d.type ?? "text"));
const isSecret = (d) => SECRET.test(d.id) || SECRET.test(String(d.name ?? ""));

function optionsOf(d) {
  let o = d.options;
  if (typeof o === "function") { try { o = o(store().get(d.id)); } catch { o = null; } }
  if (!Array.isArray(o)) return null;
  return o.map((x) => (x !== null && typeof x === "object" ? { value: x.value, text: String(x.text ?? x.value) } : { value: x, text: String(x) }));
}

function show(d, v) {
  if (isSecret(d)) return v ? "(hidden)" : "(empty)";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v ?? null);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

function row(d) {
  const s = store(), value = s.get(d.id), opts = optionsOf(d);
  const parts = [d.id, String(d.name ?? ""), typeOf(d), `value=${show(d, value)}`];
  if (JSON.stringify(value) !== JSON.stringify(d.defaultValue) && typeof d.defaultValue !== "function") parts.push(`default=${show(d, d.defaultValue)}`);
  if (opts) parts.push(`options: ${opts.slice(0, 12).map((o) => (o.text === String(o.value) ? o.text : `${o.text} (=${JSON.stringify(o.value)})`)).join(", ")}${opts.length > 12 ? ", …" : ""}`);
  return parts.join(" | ");
}

function find(id) {
  const all = definitions();
  const d = all.find((x) => x.id === id) ?? all.find((x) => x.id.toLowerCase() === String(id ?? "").toLowerCase());
  if (d) return d;
  const tail = String(id ?? "").split(".").pop().toLowerCase();
  const near = all.filter((x) => tail && x.id.toLowerCase().includes(tail)).slice(0, 8).map((x) => x.id);
  throw new ToolError(`No setting "${id}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ' Use action "search".'}`);
}

function coerce(d, raw) {
  const type = typeOf(d), opts = optionsOf(d);
  if (opts) {
    const want = String(raw).toLowerCase();
    const hit = opts.find((o) => o.value === raw) ?? opts.find((o) => String(o.value).toLowerCase() === want || o.text.toLowerCase() === want);
    if (!hit) throw new ToolError(`"${raw}" is not an option of ${d.id}. Options: ${opts.map((o) => o.text).join(", ")}`);
    return hit.value;
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const t = String(raw).toLowerCase();
    if (["true", "on", "yes", "1"].includes(t)) return true;
    if (["false", "off", "no", "0"].includes(t)) return false;
    throw new ToolError(`${d.id} is a boolean: pass true or false.`);
  }
  if (NUMERIC.has(type)) {
    let n = Number(raw);
    if (!Number.isFinite(n)) throw new ToolError(`${d.id} is a number.`);
    if (Number.isFinite(Number(d.attrs?.min))) n = Math.max(n, Number(d.attrs.min));
    if (Number.isFinite(Number(d.attrs?.max))) n = Math.min(n, Number(d.attrs.max));
    return n;
  }
  if (type === "text" || type === "color") return String(raw);
  throw new ToolError(`${d.id} is a "${type}" setting; it cannot be changed from here. Open the Settings dialog (run_command Comfy.ShowSettingsDialog).`);
}

export async function settings({ action, query, id, value, limit = 30 } = {}) {
  const act = action ?? (id !== undefined && value !== undefined ? "set" : id !== undefined ? "get" : "search");
  if (act === "search") {
    const toks = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const rows = definitions()
      .filter((d) => typeOf(d) !== "hidden" || toks.some((t) => d.id.toLowerCase() === t))
      .filter((d) => { const hay = `${d.id} ${d.name ?? ""} ${(d.category ?? []).join(" ")} ${d.tooltip ?? ""}`.toLowerCase(); return toks.every((t) => hay.includes(t)); })
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!rows.length) return `No setting matches "${query}". Try one word, e.g. "link", "snap", "minimap", "preview", "queue".`;
    const max = Math.max(1, Math.min(Number(limit) || 30, 80));
    const lines = [`settings (${rows.length}${toks.length ? "" : " in total; pass a query"}): id | name | type | value`, ...rows.slice(0, max).map(row)];
    if (rows.length > max) lines.push(`…${rows.length - max} more; refine the query.`);
    return lines.join("\n");
  }
  if (act === "get") {
    const d = find(id);
    const extra = [d.tooltip ? `tooltip: ${d.tooltip}` : "", Array.isArray(d.category) ? `category: ${d.category.join(" > ")}` : "",
      d.attrs ? `range: ${JSON.stringify(d.attrs)}` : "", d.experimental ? "experimental" : ""].filter(Boolean);
    return [row(d), ...extra].join("\n");
  }
  if (act === "set") {
    if (value === undefined) throw new ToolError("set needs a value.");
    const d = find(id);
    if (typeOf(d) === "hidden") throw new ToolError(`${d.id} is internal state of ComfyUI, not a user setting.`);
    const next = coerce(d, value);
    const s = store(), old = s.get(d.id);
    await s.set(d.id, next);
    const now = s.get(d.id);
    if (JSON.stringify(now) !== JSON.stringify(next)) throw new ToolError(`ComfyUI did not accept the value: ${d.id} is still ${show(d, now)}.`);
    return `${d.id} (${d.name ?? ""}): ${show(d, old)} -> ${show(d, now)}. Not covered by undo: to revert, set it back to ${show(d, old)}.`;
  }
  throw new ToolError('action must be "search", "get" or "set".');
}
