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
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
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
  return h("details", { class: "card tool" },
    h("summary", {}, h("span", { class: `dot ${item.status}` }), h("span", { class: "name", textContent: item.name }),
      h("span", { class: "hint", textContent: toolHint(item) })),
    h("div", { class: "detail", textContent: `${pretty(item.args)}${item.summary ? "\n→ " + item.summary : ""}` }));
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
  return h("div", { class: "card ask" },
    h("div", { class: "question", textContent: `Allow Sidekick to run ${item.tool}?` }),
    h("pre", {}, h("code", { textContent: pretty(item.args) })),
    h("div", { class: "row" },
      h("button", { class: "primary", textContent: "Allow once", onclick: decide("allow") }),
      h("button", { textContent: "Allow for this chat", onclick: decide("allow_session") }),
      h("button", { textContent: "Deny", onclick: decide("deny") })));
}

function renderItem(item) {
  switch (item.kind) {
    case "user": return h("div", { class: "user", textContent: item.text });
    case "assistant": return renderAssistant(item);
    case "tool": return renderTool(item);
    case "question": return renderQuestion(item);
    case "permission": return renderPermission(item);
    case "error": return h("div", { class: "error", textContent: item.text });
    default: return h("div", { class: "notice", textContent: item.text ?? "" });
  }
}

// ---------- panel ----------

export function mountPanel(container) {
  const host = h("div", { style: "height:100%;min-height:0" });
  const root = host.attachShadow({ mode: "open" });
  const els = new Map(); // item id -> element
  let overlay = null;

  const title = h("span", { class: "title" });
  const list = h("div", { class: "list" });
  const body = h("div", { class: "body" }, list);
  const providerSel = h("select", { title: "Brain", onchange: () => { client.setProvider(providerSel.value, ""); modelInput.value = ""; syncModelPlaceholder(); } });
  const modelInput = h("input", { placeholder: "model (default)", title: "Model override", onchange: () => client.setProvider(providerSel.value, modelInput.value.trim()) });
  const usage = h("span", { class: "usage" });
  const sendBtn = h("button", { class: "primary", onclick: () => (client.state.running ? client.stop() : submit()) });
  const input = h("textarea", { placeholder: "Ask Sidekick to build or change this workflow…", rows: 2,
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } e.stopPropagation(); },
    onkeyup: (e) => e.stopPropagation(), onkeypress: (e) => e.stopPropagation(),
    oninput: () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight + 2, 200) + "px"; } });

  function submit() {
    const text = input.value.trim();
    if (!text || client.state.running) return;
    input.value = ""; input.style.height = "auto";
    client.send(text);
  }

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  function syncModelPlaceholder() {
    const p = client.state.config?.providers?.find((x) => x.id === providerSel.value);
    modelInput.placeholder = p?.model ? `model (${p.model})` : "model (default)";
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
    modelInput.value = s.model ?? "";
    syncModelPlaceholder();
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
    if (change.type === "config") return renderConfig();
    if (change.type === "sessions") { if (overlay?.kind === "sessions") showSessions(); return; }
    const stick = nearBottom();
    if (change.type === "item_add") {
      if (!els.size) list.replaceChildren();
      const el = renderItem(change.item);
      els.set(change.item.id, el);
      list.append(el);
    } else if (change.type === "item_update") {
      const old = els.get(change.item.id);
      if (old) { const el = renderItem(change.item); if (old.tagName === "DETAILS" && old.open) el.open = true; old.replaceWith(el); els.set(change.item.id, el); }
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
    const rows = client.state.sessions.map((m) => h("div", { class: `sess${m.id === client.state.sessionId ? " cur" : ""}`, onclick: () => { closeOverlay(); client.loadSession(m.id); } },
      h("span", { class: "t", textContent: m.title || "Untitled" }), h("span", { class: "d", textContent: new Date(m.updated * 1000).toLocaleDateString() }),
      h("button", { class: "ghost", title: "Delete chat", textContent: "🗑", onclick: (e) => { e.stopPropagation(); client.deleteSession(m.id); } })));
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
    // API providers: keys are write-only (the server only ever returns a hint)
    const saveProviders = (list) => client.saveConfig({ providers: list }).then(showSettings);
    const providerCards = (c.providers ?? []).filter((p) => p.kind === "openai").map((p) => {
      const patch = (field, value) => saveProviders(c.providers.map((x) => (x.id === p.id ? { ...x, [field]: value } : x)));
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
        h("label", {}, "API key", h("input", { type: "password", autocomplete: "off", placeholder: p.api_key_set ? `saved (${p.api_key_hint || "••••"}) — type to replace` : "not set",
          onchange: (e) => { if (e.target.value) patch("api_key", e.target.value); } })),
        h("label", {}, "Default model", h("div", { style: "display:flex;gap:6px" }, modelIn, fetchBtn), models));
    });
    const addProvider = h("button", { textContent: "＋ Add OpenAI-compatible provider", onclick: () => {
      const id = "custom" + Date.now().toString(36);
      saveProviders([...(c.providers ?? []), { id, kind: "openai", name: "Custom", base_url: "", model: "" }]);
    } });

    openOverlay("settings",
      h("h4", { textContent: "Behaviour" }), h("label", {}, "Permissions", mode), h("label", {}, "Default brain", def),
      h("h4", { textContent: "API providers" }), providerCards, addProvider,
      h("h4", { textContent: "CLIs" }), h("div", { class: "hint", textContent: `Claude CLI: ${cli("claude")}` }), h("div", { class: "hint", textContent: `Codex CLI: ${cli("codex")}` }),
      h("h4", { textContent: "Developer" }), h("label", { class: "check" }, dev, "Dev mode (enables /sidekick/dev/call_tool on localhost)"),
      h("div", { class: "hint", textContent: `Sidekick ${st.version ?? ""} · ${st.tools ?? "?"} tools` }));
  }

  root.append(h("style", { textContent: CSS }), h("div", { class: "sk" },
    h("div", { class: "head" }, title,
      h("button", { class: "ghost", title: "New chat", textContent: "＋", onclick: () => { closeOverlay(); client.newChat(); input.focus(); } }),
      h("button", { class: "ghost", title: "Chats", textContent: "☰", onclick: () => (overlay?.kind === "sessions" ? closeOverlay() : client.refreshSessions().then(showSessions)) }),
      h("button", { class: "ghost", title: "Settings", textContent: "⚙", onclick: () => (overlay?.kind === "settings" ? closeOverlay() : showSettings()) })),
    body,
    h("div", { class: "composer" }, input, h("div", { class: "row" }, providerSel, modelInput, sendBtn), usage)));

  container.replaceChildren(host);
  const unsubscribe = client.subscribe(onChange);
  renderConfig();
  renderAll();
  return () => { unsubscribe(); host.remove(); };
}
