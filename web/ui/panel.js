// The chat panel. Plain DOM inside a Shadow root; all state lives in bridge/client.js so
// the panel can be mounted into the sidebar, unmounted, and mounted again without loss.
import * as client from "../bridge/client.js";
import { renderMarkdown } from "./markdown.js";
import { CSS } from "./styles.js";

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v);
  }
  // Infinity: overlays pass arrays of cards inside a rest-args array (two levels deep);
  // a one-level flat() would append the inner array as "[object HTMLDivElement],…" text.
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const pretty = (v) => { try { return JSON.stringify(v, null, 1); } catch { return String(v); } };

function toolHint(item) {
  const a = item.args ?? {};
  if (Array.isArray(a.operations)) return `${a.operations.length} operations`;
  const parts = [];
  for (const k of ["type", "query", "title", "node_id", "from_node", "to_node", "group_id", "url"]) if (a[k] !== undefined) parts.push(`${k}=${typeof a[k] === "string" ? a[k] : JSON.stringify(a[k])}`);
  if (a.values) parts.push(Object.keys(a.values).join(","));
  return parts.join(" ");
}

// ---------- item renderers ----------

function renderAssistant(item) {
  return h("div", { class: "assistant" },
    item.reasoning ? h("div", { class: "reasoning", textContent: item.reasoning }) : null,
    h("div", { html: renderMarkdown(item.text) }));
}

function renderTool(item) {
  // item.thumb: what a screenshot showed the model — always visible, so the user sees it too.
  const shot = typeof item.thumb === "string" && item.thumb.startsWith("data:image/") ? h("img", { class: "shot", src: item.thumb, alt: "What Sidekick saw" }) : null;
  return h("div", {}, h("details", { class: "card tool" },
    h("summary", {}, h("span", { class: `dot ${item.status}` }), h("span", { class: "name", textContent: item.name }),
      h("span", { class: "hint", textContent: toolHint(item) })),
    h("div", { class: "detail", textContent: `${pretty(item.args)}${item.summary ? "\n→ " + item.summary : ""}` })), shot);
}

function renderQuestion(item) {
  if (item.status !== "pending") {
    const ans = item.answer?.answers ?? {};
    const lines = (item.questions ?? []).map((q) => `${q.header ?? q.question}: ${[].concat(ans[q.question] ?? "—").join(", ")}`);
    return h("div", { class: "card ask done", textContent: item.status === "answered" ? lines.join("\n") : "Question cancelled." });
  }
  const picks = (item.questions ?? []).map(() => ({ sel: new Set(), other: "" }));
  const submit = h("button", { class: "primary", textContent: "Submit", disabled: true });
  const refresh = () => { submit.disabled = !picks.every((p) => p.sel.size || p.other.trim()); };
  const blocks = (item.questions ?? []).map((q, qi) => {
    const buttons = (q.options ?? []).map((o) => {
      const b = h("button", { class: "opt", onclick: () => {
        const p = picks[qi];
        if (q.multi_select) { p.sel.has(o.label) ? p.sel.delete(o.label) : p.sel.add(o.label); } else { p.sel.clear(); p.sel.add(o.label); p.other = ""; other.value = ""; }
        buttons.forEach((x, xi) => x.classList.toggle("sel", p.sel.has(q.options[xi].label)));
        refresh();
      } }, h("span", { textContent: o.label }), o.description ? h("small", { textContent: o.description }) : null);
      return b;
    });
    const other = h("input", { placeholder: "Other…", oninput: (e) => {
      picks[qi].other = e.target.value;
      if (!q.multi_select && e.target.value.trim()) { picks[qi].sel.clear(); buttons.forEach((x) => x.classList.remove("sel")); }
      refresh();
    } });
    return h("div", { class: "q" }, q.header ? h("span", { class: "chip", textContent: q.header }) : null,
      h("div", { class: "question", textContent: q.question }), buttons, h("div", { class: "row" }, other));
  });
  submit.addEventListener("click", () => {
    submit.disabled = true;
    const answers = {};
    (item.questions ?? []).forEach((q, qi) => {
      const chosen = [...picks[qi].sel];
      if (picks[qi].other.trim()) chosen.push(picks[qi].other.trim());
      answers[q.question] = q.multi_select ? chosen : chosen[0];
    });
    client.answer(item.request_id, { answers }).catch(() => { submit.disabled = false; });
  });
  return h("div", { class: "card ask" }, blocks, h("div", { class: "row" }, submit));
}

function renderPermission(item) {
  if (item.status !== "pending") {
    const d = item.answer?.decision;
    return h("div", { class: "card ask done", textContent: `${item.tool}: ${d === "deny" || !d ? "denied" : "allowed"}` });
  }
  const decide = (decision) => () => client.answer(item.request_id, { decision });
  // A script must be readable as written, not as one JSON-escaped line.
  const { code, ...rest } = item.args ?? {};
  const shown = typeof code === "string" ? `${code}${Object.keys(rest).length ? "\n\n// other arguments: " + JSON.stringify(rest) : ""}` : pretty(item.args);
  return h("div", { class: "card ask" },
    h("div", { class: "question", textContent: `Allow Sidekick to run ${item.tool}?` }),
    item.note ? h("div", { textContent: item.note }) : null,
    h("pre", {}, h("code", { textContent: shown })),
    h("div", { class: "row" },
      h("button", { class: "primary", textContent: "Allow once", onclick: decide("allow") }),
      item.tool === "execute_js" ? null : h("button", { textContent: "Allow for this chat", onclick: decide("allow_session") }), // scripts: always one by one
      h("button", { textContent: "Deny", onclick: decide("deny") })));
}

const fmtBytes = (n) => { let v = Number(n) || 0; for (const u of ["B", "KB", "MB", "GB"]) { if (v < 1024 || u === "GB") return `${v.toFixed(u === "B" || u === "KB" ? 0 : 1)} ${u}`; v /= 1024; } return ""; };

function renderDownload(item) {
  const live = item.status === "running" || item.status === "starting";
  const pct = item.total ? Math.min(100, (100 * item.done) / item.total) : 0;
  const state = { running: `${item.total ? pct.toFixed(0) + "% · " : ""}${fmtBytes(item.done)}${item.total ? " of " + fmtBytes(item.total) : ""}${item.speed ? " · " + fmtBytes(item.speed) + "/s" : ""}`,
    done: `done · ${fmtBytes(item.done)}`, error: `failed: ${item.error ?? "?"}`, cancelled: "cancelled", interrupted: "interrupted (ComfyUI restarted)" }[item.status] ?? item.status;
  return h("div", { class: `card dl ${item.status}` },
    h("div", { class: "row", style: "display:flex;gap:6px;align-items:center" },
      h("span", { class: "name", style: "flex:1;overflow-wrap:anywhere", textContent: `⬇ ${item.folder ?? ""}/${item.name ?? ""}` }),
      live ? h("button", { class: "ghost", title: "Cancel download", textContent: "✕", onclick: (e) => { e.target.disabled = true; client.cancelDownload(item.download_id).catch(() => { e.target.disabled = false; }); } }) : null),
    live || item.status === "done" ? h("div", { class: "bar" }, h("div", { style: `width:${item.status === "done" ? 100 : pct}%` })) : null,
    h("div", { class: "hint", textContent: state }));
}

function renderTodos(item) {
  const todos = item.todos ?? [];
  const done = todos.filter((t) => t.status === "done").length;
  const mark = { done: "☑", in_progress: "◐", pending: "☐" };
  return h("div", { class: "card todos" },
    h("div", { class: "head", textContent: `Plan · ${done}/${todos.length}` }),
    todos.map((t) => h("div", { class: `todo ${t.status}` }, h("span", { class: "mark", textContent: mark[t.status] ?? "☐" }), h("span", { textContent: t.text }))));
}

function renderItem(item) {
  switch (item.kind) {
    case "user": return h("div", { class: item.auto ? "notice" : "user", textContent: item.text });
    case "download": return renderDownload(item);
    case "todos": return renderTodos(item);
    case "assistant": return renderAssistant(item);
    case "tool": return renderTool(item);
    case "question": return renderQuestion(item);
    case "permission": return renderPermission(item);
    case "error": return h("div", { class: "error", textContent: item.text });
    default: return h("div", { class: "notice", textContent: item.text ?? "" });
  }
}

// ---------- panel ----------

/** opts.floating: this panel sits in the floating window; opts.onToggleFloat: pop out / dock back. */
export function mountPanel(container, opts = {}) {
  const host = h("div", { style: "height:100%;min-height:0" });
  const root = host.attachShadow({ mode: "open" });
  const els = new Map(); // item id -> element
  let overlay = null;

  const title = h("span", { class: "title" });
  const list = h("div", { class: "list" });
  const body = h("div", { class: "body" }, list);
  const OTHER = "__other__"; // picker entry that opens a box for a model id the list does not have
  const providerSel = h("select", { title: "Brain", onchange: () => { client.setProvider(providerSel.value); renderBrain(); } });
  const modelSel = h("select", { class: "model", title: "Model", onchange: () => (modelSel.value === OTHER ? askModelId() : (client.setModel(modelSel.value), renderBrain())) });
  const effortSel = h("select", { class: "effort", title: "Effort: how long the model thinks before it acts", onchange: () => client.setEffort(effortSel.value) });
  const usage = h("span", { class: "usage" });
  const sendBtn = h("button", { class: "primary", onclick: () => (client.state.running ? client.stop() : submit()) });
  const input = h("textarea", { placeholder: "Ask Sidekick to build or change this workflow…", rows: 2,
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } },
    oninput: () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight + 2, 200) + "px"; } });

  function submit() {
    const text = input.value.trim();
    if (!text || client.state.running) return;
    input.value = ""; input.style.height = "auto";
    client.send(text);
  }

  // Tool definitions live in Python: after an update the model cannot see new tools until the
  // server restarts, and nothing else in the UI would tell the user why.
  const banner = h("div", { class: "banner", hidden: true,
    textContent: "Sidekick was updated on disk. Restart ComfyUI to load it — until then the assistant is missing the new tools." });
  function renderStatus() { banner.hidden = !client.state.status?.restart_needed; }

  // A tool needs a real click (tab sharing can only start inside a user gesture).
  const gestureBar = h("div", { class: "gesture", hidden: true });
  function renderGesture() {
    const g = client.state.gesture;
    gestureBar.hidden = !g;
    if (!g) return gestureBar.replaceChildren();
    gestureBar.replaceChildren(h("span", { textContent: g.text }),
      h("button", { class: "primary", textContent: g.button, onclick: () => g.accept() }),
      h("button", { textContent: "Not now", onclick: () => g.decline() }));
  }

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  // The two pickers next to Send. Models and effort levels come from the brain itself
  // (GET /sidekick/brain_options); each model may bring its own effort levels and default.
  const nice = (level) => ({ xhigh: "X-high" }[level] ?? level.charAt(0).toUpperCase() + level.slice(1));
  let brainSeq = 0;
  function drawBrain(opts, real = false) {
    const p = client.state.config?.providers?.find((x) => x.id === client.state.provider);
    const cur = client.state.model;
    const models = [...(opts.models ?? [])];
    if (cur && !models.some((m) => m.id === cur)) models.unshift({ id: cur, label: cur }); // typed by hand earlier
    modelSel.replaceChildren(
      h("option", { value: "", textContent: p?.model ? `Default (${p.model})` : "Default model" }),
      ...models.map((m) => h("option", { value: m.id, textContent: m.label, selected: m.id === cur })), // spread: replaceChildren() does not flatten
      h("option", { value: OTHER, textContent: "Other…" }));
    modelSel.title = opts.note ? `Model — ${opts.note}` : "Model";
    const chosen = models.find((m) => m.id === cur) ?? (cur ? null : (opts.models ?? []).find((m) => m.id === p?.model));
    const levels = chosen?.efforts?.length ? chosen.efforts : opts.efforts ?? [];
    // Only the brain's real answer may drop a remembered effort (this model has no such level) —
    // never the empty placeholder drawn first, and never a failed lookup.
    if (real && !opts.note && client.state.effort && !levels.includes(client.state.effort)) client.setEffort("");
    effortSel.replaceChildren(
      h("option", { value: "", textContent: chosen?.default_effort ? `Effort: ${nice(chosen.default_effort)} (default)` : "Default effort" }),
      ...levels.map((l) => h("option", { value: l, textContent: nice(l), selected: l === client.state.effort })));
    effortSel.hidden = !levels.length;
  }
  async function renderBrain(refresh = false) {
    const seq = ++brainSeq;
    drawBrain({ models: [], efforts: [] }); // right away: "Default" plus whatever is selected
    const opts = await client.brainOptions(client.state.provider, refresh);
    if (seq === brainSeq) drawBrain(opts, true); // the brain may have been switched meanwhile
  }
  function askModelId() {
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const id = box.value.trim();
      box.replaceWith(modelSel);
      if (keep && id) client.setModel(id);
      renderBrain();
    };
    const box = h("input", { class: "model", placeholder: "model id, then Enter", onblur: () => finish(true),
      onkeydown: (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); } });
    modelSel.replaceWith(box);
    box.focus();
  }

  function renderMeta() {
    const s = client.state;
    title.textContent = s.title || "New chat";
    sendBtn.textContent = s.running ? "Stop" : "Send";
    sendBtn.classList.toggle("primary", !s.running);
    const u = s.usage;
    usage.textContent = u ? `${u.input_tokens ?? 0} in · ${u.output_tokens ?? 0} out${typeof u.cost_usd === "number" ? ` · $${u.cost_usd.toFixed(4)}` : ""}` : "";
  }

  function renderConfig() {
    const s = client.state;
    providerSel.replaceChildren(...(s.config?.providers ?? []).map((p) => h("option", { value: p.id, textContent: p.name, selected: p.id === s.provider })));
    renderBrain();
  }

  function renderAll() {
    els.clear();
    const items = client.state.items;
    if (!items.length) {
      list.replaceChildren(h("div", { class: "empty" }, h("b", { textContent: "Sidekick" }),
        "Describe the workflow or change you want. Edits happen live on the canvas and can be undone with Ctrl+Z."));
    } else {
      list.replaceChildren(...items.map((it) => { const el = renderItem(it); els.set(it.id, el); return el; }));
    }
    renderMeta();
    toBottom();
  }

  let raf = 0;
  const dirty = new Set();
  function onChange(change) {
    if (change.type === "full") return renderAll();
    if (change.type === "meta") return renderMeta();
    if (change.type === "config") { renderStatus(); return renderConfig(); }
    if (change.type === "status") return renderStatus();
    if (change.type === "gesture") return renderGesture();
    if (change.type === "sessions") { if (overlay?.kind === "sessions") showSessions(); return; }
    const stick = nearBottom();
    if (change.type === "item_add") {
      if (!els.size) list.replaceChildren();
      const el = renderItem(change.item);
      els.set(change.item.id, el);
      list.append(el);
    } else if (change.type === "item_update") {
      const old = els.get(change.item.id);
      if (old) {
        const el = renderItem(change.item);
        if (old.querySelector?.("details")?.open) { const d = el.querySelector?.("details"); if (d) d.open = true; } // keep an expanded tool card expanded
        old.replaceWith(el);
        els.set(change.item.id, el);
      }
    } else if (change.type === "text") {
      dirty.add(change.item);
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        const keep = nearBottom();
        for (const it of dirty) { const old = els.get(it.id); if (old) { const el = renderItem(it); old.replaceWith(el); els.set(it.id, el); } }
        dirty.clear();
        if (keep) toBottom();
      });
      return;
    }
    if (stick) toBottom();
  }

  // ---------- overlays ----------
  function closeOverlay() { overlay?.el.remove(); overlay = null; }
  function openOverlay(kind, ...kids) {
    closeOverlay();
    const el = h("div", { class: "overlay" }, h("div", { class: "row", style: "display:flex;justify-content:flex-end" }, h("button", { class: "ghost", textContent: "✕ Close", onclick: closeOverlay })), kids);
    overlay = { kind, el };
    body.append(el);
  }

  function showSessions() {
    const rows = client.state.sessions.map((m) => {
      const name = h("span", { class: "t", textContent: m.title || "Untitled" });
      const rename = (e) => {
        e.stopPropagation();
        const box = h("input", { value: m.title || "", style: "flex:1;min-width:0", onclick: (ev) => ev.stopPropagation(),
          onkeydown: (ev) => { if (ev.key === "Enter") box.blur(); if (ev.key === "Escape") { box.value = m.title || ""; box.blur(); } },
          onblur: () => { const t = box.value.trim(); if (t && t !== m.title) client.renameSession(m.id, t); else box.replaceWith(name); } });
        name.replaceWith(box);
        box.focus(); box.select();
      };
      return h("div", { class: `sess${m.id === client.state.sessionId ? " cur" : ""}`, onclick: () => { closeOverlay(); client.loadSession(m.id); } },
        name, h("span", { class: "d", textContent: new Date(m.updated * 1000).toLocaleDateString() }),
        h("button", { class: "ghost", title: "Rename chat", textContent: "✎", onclick: rename }),
        h("button", { class: "ghost", title: "Delete chat", textContent: "🗑", onclick: (e) => { e.stopPropagation(); client.deleteSession(m.id); } }));
    });
    openOverlay("sessions", h("h4", { textContent: "Chats" }), rows.length ? rows : h("div", { class: "hint", textContent: "No saved chats yet." }));
  }

  function showSettings() {
    const c = client.state.config ?? {}, st = client.state.status ?? {};
    const cli = (n) => (st.cli?.[n]?.found ? `found (${st.cli[n].version ?? "?"})` : "not found on PATH");
    const mode = h("select", { onchange: () => client.saveConfig({ permission_mode: mode.value }) },
      [["confirm", "Ask before risky actions (recommended)"], ["auto", "Never ask"], ["readonly", "Read-only (no edits)"]]
        .map(([v, t]) => h("option", { value: v, textContent: t, selected: c.permission_mode === v })));
    const def = h("select", { onchange: () => client.saveConfig({ default_provider: def.value }) },
      (c.providers ?? []).map((p) => h("option", { value: p.id, textContent: p.name, selected: p.id === c.default_provider })));
    const dev = h("input", { type: "checkbox", checked: !!c.dev_mode, onchange: () => client.saveConfig({ dev_mode: dev.checked }) });
    const js = h("input", { type: "checkbox", checked: !!c.allow_execute_js, onchange: () => client.saveConfig({ allow_execute_js: js.checked }) });
    // API providers: keys are write-only (the server only ever returns a hint)
    const saveProviders = (list) => client.saveConfig({ providers: list }).then(showSettings);
    const providerCards = (c.providers ?? []).filter((p) => p.kind === "openai").map((p) => {
      // Field edits save without re-rendering the overlay (a re-render would steal focus from the
      // next field mid-typing) and always start from the freshest config, never the captured `c`.
      const patch = (field, value) => client.saveConfig({ providers: client.state.config.providers.map((x) => (x.id === p.id ? { ...x, [field]: value } : x)) });
      const savedHint = (prov) => `saved (${prov?.api_key_hint || "••••"}) — type to replace`;
      const keyIn = h("input", { type: "password", autocomplete: "off", placeholder: p.api_key_set ? savedHint(p) : "paste API key, then press Enter",
        onchange: async () => {
          if (!keyIn.value) return;
          await patch("api_key", keyIn.value);
          keyIn.value = "";
          keyIn.placeholder = savedHint(client.state.config.providers.find((x) => x.id === p.id));
        } });
      const listId = `models-${p.id}`;
      const models = h("datalist", { id: listId });
      const modelIn = h("input", { value: p.model ?? "", placeholder: "model id", onchange: (e) => patch("model", e.target.value.trim()) });
      modelIn.setAttribute("list", listId);
      const fetchBtn = h("button", { textContent: "Fetch models", onclick: async () => {
        fetchBtn.disabled = true; fetchBtn.textContent = "…";
        try {
          const r = await client.getJSON(`/sidekick/providers/models?provider=${encodeURIComponent(p.id)}`);
          models.replaceChildren(...r.models.map((m) => h("option", { value: m })));
          fetchBtn.textContent = `${r.models.length} models`;
        } catch (e) { fetchBtn.textContent = "Failed"; fetchBtn.title = e.message; }
        fetchBtn.disabled = false;
      } });
      return h("div", { class: "card", style: "padding:8px;display:flex;flex-direction:column;gap:6px" },
        h("div", { style: "display:flex;gap:6px;align-items:center" },
          h("input", { value: p.name ?? "", style: "flex:1;font-weight:600", onchange: (e) => patch("name", e.target.value.trim() || p.id) }),
          h("button", { class: "ghost", title: "Remove provider", textContent: "🗑", onclick: () => saveProviders(c.providers.filter((x) => x.id !== p.id)) })),
        h("label", {}, "Base URL", h("input", { value: p.base_url ?? "", placeholder: "https://…/v1", onchange: (e) => patch("base_url", e.target.value.trim()) })),
        h("label", {}, "API key", keyIn),
        h("label", {}, "Default model", h("div", { style: "display:flex;gap:6px" }, modelIn, fetchBtn), models),
        h("label", {}, "Can this model see images? (screenshots)", h("select", { onchange: (e) => patch("vision", e.target.value) },
          [["auto", "Auto — try, and remember if it refuses"], ["on", "Yes"], ["off", "No — never send screenshots"]]
            .map(([v, t]) => h("option", { value: v, textContent: t, selected: (p.vision ?? "auto") === v })))));
    });
    const addProvider = h("button", { textContent: "＋ Add OpenAI-compatible provider", onclick: () => {
      const id = "custom" + Date.now().toString(36);
      saveProviders([...(c.providers ?? []), { id, kind: "openai", name: "Custom", base_url: "", model: "" }]);
    } });

    // Web and downloads. Secrets are write-only, like provider keys: the server returns a hint only.
    const secret = (section, key, label, note) => {
      const cur = () => client.state.config?.[section] ?? {};
      const hint = () => (cur()[`${key}_set`] ? `saved (${cur()[`${key}_hint`] || "••••"}) — type to replace` : "paste, then press Enter");
      const box = h("input", { type: "password", autocomplete: "off", placeholder: hint(), onchange: async () => {
        if (!box.value) return;
        await client.saveConfig({ [section]: { [key]: box.value } });
        box.value = ""; box.placeholder = hint();
      } });
      const clear = h("button", { class: "ghost", title: "Forget this key", textContent: "🗑", onclick: async () => { await client.saveConfig({ [section]: { [`${key}_clear`]: true } }); box.placeholder = hint(); } });
      return h("label", {}, label, h("div", { style: "display:flex;gap:6px" }, box, clear), note ? h("span", { class: "hint", textContent: note }) : null);
    };
    const web = h("input", { type: "checkbox", checked: c.web_tools !== false, onchange: () => client.saveConfig({ web_tools: web.checked }) });
    const backend = h("select", { onchange: () => client.saveConfig({ search: { backend: backend.value } }) },
      [["ddg", "DuckDuckGo (no key needed)"], ["tavily", "Tavily"], ["brave", "Brave Search"], ["searxng", "SearXNG (your own instance)"]]
        .map(([v, t]) => h("option", { value: v, textContent: t, selected: (c.search?.backend ?? "ddg") === v })));
    const searx = h("input", { value: c.search?.searxng_url ?? "", placeholder: "http://localhost:8080", onchange: () => client.saveConfig({ search: { searxng_url: searx.value.trim() } }) });

    openOverlay("settings",
      h("h4", { textContent: "Behaviour" }), h("label", {}, "Permissions", mode), h("label", {}, "Default brain", def),
      h("h4", { textContent: "Web and downloads" }),
      h("label", { class: "check" }, web, "Let API brains search and read the web (Claude and Codex CLI use their own web tools)"),
      h("label", {}, "Search engine", backend), secret("search", "tavily_key", "Tavily API key"), secret("search", "brave_key", "Brave Search API key"),
      h("label", {}, "SearXNG address", searx),
      secret("tokens", "huggingface", "Hugging Face token", "For gated or private models. Only ever sent to huggingface.co."),
      secret("tokens", "civitai", "Civitai API key", "Most Civitai downloads need it. Only ever sent to civitai.com."),
      h("h4", { textContent: "API providers" }), providerCards, addProvider,
      h("h4", { textContent: "CLIs" }), h("div", { class: "hint", textContent: `Claude CLI: ${cli("claude")}` }), h("div", { class: "hint", textContent: `Codex CLI: ${cli("codex")}` }),
      h("h4", { textContent: "Developer" }), h("label", { class: "check" }, dev, "Dev mode (enables /sidekick/dev/call_tool on localhost)"),
      h("label", { class: "check" }, js, "Let the assistant run JavaScript in this page (execute_js). You are shown every script and must allow it each time."),
      h("div", { class: "hint", textContent: `Sidekick ${st.version ?? ""} · ${st.tools ?? "?"} tools` }));
  }

  const sk = h("div", { class: "sk" },
    h("div", { class: "head" }, title,
      opts.onToggleFloat ? h("button", { class: "ghost", title: opts.floating ? "Dock into the sidebar" : "Pop out into a floating window", textContent: opts.floating ? "⇤" : "⧉", onclick: () => opts.onToggleFloat() }) : null,
      h("button", { class: "ghost", title: "New chat", textContent: "＋", onclick: () => { closeOverlay(); client.newChat(); input.focus(); } }),
      h("button", { class: "ghost", title: "Chats", textContent: "☰", onclick: () => (overlay?.kind === "sessions" ? closeOverlay() : client.refreshSessions().then(showSessions)) }),
      h("button", { class: "ghost", title: "Settings", textContent: "⚙", onclick: () => (overlay?.kind === "settings" ? closeOverlay() : showSettings()) })),
    banner, body, gestureBar,
    h("div", { class: "composer" }, input, h("div", { class: "row" }, providerSel, modelSel, effortSel, sendBtn), usage));
  // Shadow DOM retargets events: outside the panel, a key press or paste in one of our inputs
  // looks like it came from a plain <div>, so ComfyUI/LiteGraph shortcuts (Delete, Ctrl+V paste
  // nodes, …) could fire while the user types or pastes an API key. Keep those events inside.
  for (const type of ["keydown", "keyup", "keypress", "paste", "copy", "cut"]) sk.addEventListener(type, (e) => e.stopPropagation());
  root.append(h("style", { textContent: CSS }), sk);

  container.replaceChildren(host);
  const unsubscribe = client.subscribe(onChange);
  client.state.mounted++;
  client.refreshStatus();
  renderStatus();
  renderGesture();
  renderConfig();
  renderAll();
  return () => { client.state.mounted = Math.max(0, client.state.mounted - 1); unsubscribe(); host.remove(); };
}
