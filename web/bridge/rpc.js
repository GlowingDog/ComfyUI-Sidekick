// Executes tool calls pushed by the backend (`sidekick.rpc`) against the live canvas
// and reports the outcome. Only the tab whose clientId owns the chat receives them.
import { api } from "../../../scripts/api.js";
import { runTool } from "../tools/index.js";

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

async function onRpc(event) {
  const { rid, tool, args } = event.detail ?? {};
  if (!rid) return;
  let body;
  try {
    body = { rid, ok: true, result: safeJson(await runTool(tool, args)) };
  } catch (e) {
    console.warn(`[Sidekick] tool ${tool} failed:`, e);
    body = { rid, ok: false, error: e?.message ?? String(e) };
  }
  try {
    await api.fetchApi("/sidekick/rpc_result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    console.error("[Sidekick] could not report tool result", e);
  }
}

export function startRpc() {
  api.addEventListener("sidekick.rpc", onRpc);
}
