// REST helpers + the chat store. The server owns chat state; this store mirrors it from
// snapshots (GET /sidekick/sessions/{id}) and sequenced `sidekick.event` pushes, and
// survives the panel being unmounted (sidebar closed, pop-out moved).
import { api } from "../../../scripts/api.js";
import { app } from "../../../scripts/app.js";

export async function getJSON(path) {
  const r = await api.fetchApi(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export async function postJSON(path, body, method = "POST") {
  const r = await api.fetchApi(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error(data?.error ?? `${path}: HTTP ${r.status}`);
  return data;
}

const LS = { session: "sidekick.session", provider: "sidekick.provider", model: "sidekick.model" };
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null || v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const state = {
  sessionId: null, title: "New chat", items: [], seq: 0, running: false, usage: null,
  continuation: null, // note left by restart_comfyui, consumed by resumeAfterRestart()
  sessions: [], config: null, status: null,
  gesture: null, // pending requestGesture(), drawn by the panel
  mounted: 0, // how many panels are on screen
  provider: ls.get(LS.provider), model: ls.get(LS.model) ?? "",
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(change) { for (const fn of [...listeners]) { try { fn(change); } catch (e) { console.error("[Sidekick]", e); } } }

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function applySnapshot(snap) {
  state.sessionId = snap.id; state.title = snap.title; state.items = snap.items ?? [];
  state.seq = snap.seq ?? 0; state.running = !!snap.running;
  state.continuation = snap.continuation ?? null;
  ls.set(LS.session, snap.id);
  notify({ type: "full" });
}

/**
 * restart_comfyui leaves a note in the chat it was called from. Once ComfyUI is back (socket
 * reconnected, or the page was reloaded meanwhile) that note becomes the model's next turn.
 * The server hands the note out once, so several tabs cannot resume twice.
 */
async function resumeAfterRestart() {
  if (!state.continuation || state.running || !state.sessionId) return;
  state.continuation = null;
  try { await app.extensionManager?.command?.execute?.("Comfy.RefreshNodeDefinitions"); } catch { /* new node types just stay unknown until a reload */ }
  try {
    const r = await postJSON("/sidekick/chat/resume", { session_id: state.sessionId, client_id: api.clientId });
    if (r?.resumed) { state.running = true; notify({ type: "meta" }); }
  } catch (e) {
    console.warn("[Sidekick] could not resume after the restart", e);
  }
}

export const cancelDownload = (id) => postJSON("/sidekick/downloads/cancel", { id });

export async function loadSession(id) {
  try {
    applySnapshot(await getJSON(`/sidekick/sessions/${id}`));
  } catch {
    newChat();
  }
}

export function newChat() {
  state.sessionId = newId(); state.title = "New chat"; state.items = []; state.seq = 0; state.running = false; state.usage = null;
  ls.set(LS.session, null);
  notify({ type: "full" });
}

export async function refreshSessions() {
  state.sessions = (await getJSON("/sidekick/sessions")).sessions ?? [];
  notify({ type: "sessions" });
}

export async function deleteSession(id) {
  await postJSON(`/sidekick/sessions/${id}`, null, "DELETE");
  if (id === state.sessionId) newChat();
  await refreshSessions();
}

export function setProvider(provider, model) {
  state.provider = provider; state.model = model ?? "";
  ls.set(LS.provider, provider); ls.set(LS.model, state.model);
}

/**
 * Some browser APIs (tab sharing) only work inside a user gesture. A tool calls this; the panel
 * shows `text` with a button; the click runs `run()` inside the gesture and resolves with its
 * result. Rejects when the user declines, the browser refuses, or nobody answers.
 */
export function requestGesture({ text, button, run }) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      clearTimeout(timer);
      state.gesture = null;
      notify({ type: "gesture" });
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("The user did not answer the request in time.")), 150000);
    state.gesture = {
      text, button,
      accept: () => {
        let pending;
        try { pending = Promise.resolve(run()); } catch (e) { pending = Promise.reject(e); }
        pending.then((v) => finish(resolve, v), () => finish(reject, new Error("The user or the browser did not allow it.")));
      },
      decline: () => finish(reject, new Error("The user declined.")),
    };
    notify({ type: "gesture" });
    // Nobody can click a button in a closed sidebar tab.
    if (!state.mounted) app.extensionManager?.command?.execute?.("Workspace.ToggleSidebarTab.sidekick");
  });
}

/** Cheap poll; tells the panel when Sidekick's Python on disk is newer than the running server. */
export async function refreshStatus() {
  try {
    state.status = await getJSON("/sidekick/status");
    notify({ type: "status" });
  } catch { /* server is restarting */ }
}

export async function send(text) {
  refreshStatus();
  if (!state.sessionId) newChat();
  ls.set(LS.session, state.sessionId);
  state.running = true;
  notify({ type: "meta" });
  try {
    await postJSON("/sidekick/chat", { session_id: state.sessionId, client_id: api.clientId, text, provider: state.provider, model: state.model || null });
  } catch (e) {
    state.running = false;
    state.items.push({ id: "local-" + newId(), kind: "error", text: e.message });
    notify({ type: "full" });
  }
}

export const stop = () => postJSON("/sidekick/chat/stop", { session_id: state.sessionId });
export const answer = (request_id, payload) => postJSON("/sidekick/answer", { request_id, payload });

export async function loadConfig() {
  [state.config, state.status] = await Promise.all([getJSON("/sidekick/config"), getJSON("/sidekick/status")]);
  if (!state.provider || !state.config.providers.some((p) => p.id === state.provider)) state.provider = state.config.default_provider;
  notify({ type: "config" });
}

export async function saveConfig(patch) {
  state.config = await postJSON("/sidekick/config", patch);
  notify({ type: "config" });
}

function onEvent(e) {
  const ev = e.detail;
  if (!ev || ev.session_id !== state.sessionId) return;
  if (ev.seq <= state.seq) return;
  if (ev.seq > state.seq + 1 && state.seq > 0) { loadSession(state.sessionId); return; } // missed events
  state.seq = ev.seq;
  if (ev.type === "item_add") {
    state.items.push(ev.item);
    notify({ type: "item_add", item: ev.item });
  } else if (ev.type === "item_update") {
    const item = state.items.find((i) => i.id === ev.id);
    if (item) { Object.assign(item, ev.patch); notify({ type: "item_update", item }); }
  } else if (ev.type === "text_delta") {
    const item = state.items.find((i) => i.id === ev.id);
    if (item) { item[ev.field] = (item[ev.field] ?? "") + ev.delta; notify({ type: "text", item }); }
  } else if (ev.type === "turn_start") {
    state.running = true; state.title = ev.title ?? state.title; notify({ type: "meta" });
  } else if (ev.type === "turn_end") {
    state.running = false; state.usage = ev.usage ?? null; notify({ type: "meta" });
  }
}

let started = false;
export async function startClient() {
  if (started) return;
  started = true;
  api.addEventListener("sidekick.event", onEvent);
  api.addEventListener("reconnected", async () => {
    refreshStatus();
    if (state.sessionId && state.items.length) { await loadSession(state.sessionId); await resumeAfterRestart(); }
  });
  await loadConfig().catch((e) => console.error("[Sidekick] config load failed", e));
  const last = ls.get(LS.session);
  if (last) { await loadSession(last); await resumeAfterRestart(); } else newChat();
}
