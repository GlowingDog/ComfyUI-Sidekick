// Pure widget value coercion/validation (no ComfyUI imports; unit-tested in node).

function closest(options, want, max = 10) {
  const w = want.toLowerCase();
  const toks = w.split(/[^a-z0-9]+/).filter(Boolean);
  const scored = options
    .map((o) => {
      const l = String(o).toLowerCase();
      let s = 0;
      for (const t of toks) if (l.includes(t)) s += t.length;
      return [s, o];
    })
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0]);
  return scored.slice(0, max).map(([, o]) => o);
}

/**
 * spec: {type, options: {min, max, step, precision, round, values}} — a LiteGraph widget shape,
 * with `values` already resolved to an array. Returns {ok, value} or {ok:false, error}.
 */
export function coerceWidgetValue(spec, raw) {
  const type = String(spec.type ?? "").toLowerCase();
  const opt = spec.options ?? {};

  if (type === "combo") {
    const values = Array.isArray(opt.values) ? opt.values : [];
    if (!values.length) return { ok: true, value: raw };
    const want = String(raw);
    let hit = values.find((v) => String(v) === want);
    if (hit === undefined) hit = values.find((v) => String(v).toLowerCase() === want.toLowerCase());
    if (hit === undefined) {
      const partial = values.filter((v) => String(v).toLowerCase().includes(want.toLowerCase()));
      if (partial.length === 1) hit = partial[0];
    }
    if (hit === undefined) {
      const near = closest(values, want);
      return {
        ok: false,
        error: `"${want}" is not an option (${values.length} options).` +
          (near.length ? ` Closest: ${near.map((v) => JSON.stringify(v)).join(", ")}` : " Use get_combo_options to search."),
      };
    }
    return { ok: true, value: hit };
  }

  if (type === "number" || type === "slider" || type === "knob") {
    let n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `"${raw}" is not a number.` };
    if (opt.precision === 0) n = Math.round(n); // ComfyUI marks INT widgets with precision 0
    let note;
    if (typeof opt.min === "number" && n < opt.min) { note = `clamped to min ${opt.min}`; n = opt.min; }
    if (typeof opt.max === "number" && n > opt.max) { note = `clamped to max ${opt.max}`; n = opt.max; }
    return { ok: true, value: n, note };
  }

  if (type === "toggle" || type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const s = String(raw).toLowerCase();
    if (["true", "1", "yes", "on", "enable", "enabled"].includes(s)) return { ok: true, value: true };
    if (["false", "0", "no", "off", "disable", "disabled"].includes(s)) return { ok: true, value: false };
    return { ok: false, error: `"${raw}" is not a boolean.` };
  }

  if (type === "text" || type === "string" || type === "customtext" || type === "textarea" || type === "markdown") {
    return { ok: true, value: raw === null || raw === undefined ? "" : String(raw) };
  }

  if (type === "button") return { ok: false, error: "This is a button, not a value." };
  return { ok: true, value: raw };
}
