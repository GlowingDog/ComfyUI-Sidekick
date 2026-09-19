// Pure helpers for LiteGraph context-menu entries (no ComfyUI imports; unit-tested in node).
// An entry is null (separator), a string, or {content, has_submenu, submenu, callback, disabled}.
// Node packs put HTML and entities into `content`.

export function entryLabel(v) {
  if (v === null || v === undefined) return "";
  const raw = typeof v === "string" ? v : v.content ?? v.title ?? "";
  return String(raw).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

export const opensMenu = (v) => !!v && typeof v === "object" && !!(v.has_submenu || v.submenu);

/** One line per entry: "Mode ▸", "Pin", "Queue … (disabled)". Separators and blanks are dropped. */
export function describeEntries(values, limit = 80) {
  const rows = (values ?? []).filter((v) => entryLabel(v)).map((v) => `${entryLabel(v)}${opensMenu(v) ? " ▸" : ""}${v?.disabled ? " (disabled)" : ""}`);
  return rows.length > limit ? [...rows.slice(0, limit), `…${rows.length - limit} more`] : rows;
}

/** Exact label first (case-insensitive), then a unique partial match. Returns {entry} or {error}. */
export function findEntry(values, want) {
  const items = (values ?? []).filter((v) => entryLabel(v));
  const w = String(want ?? "").toLowerCase().replace(/[▸>]\s*$/, "").trim();
  if (!w) return { error: "Empty path segment." };
  const exact = items.filter((v) => entryLabel(v).toLowerCase() === w);
  if (exact.length) return { entry: exact[0] };
  const part = items.filter((v) => entryLabel(v).toLowerCase().includes(w));
  if (part.length === 1) return { entry: part[0] };
  return { error: `${part.length ? "Several entries match" : "No entry matches"} "${want}". Entries: ${describeEntries(items, 40).join(" | ") || "(none)"}` };
}
