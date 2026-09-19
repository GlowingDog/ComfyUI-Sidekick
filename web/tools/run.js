// Run the workflow and watch it: queue through the frontend's own Run path (seed widgets roll,
// errors light up on the canvas, the progress UI tracks the job), then poll history — polling is
// stateless, so a finished-in-5ms cached run or a dropped websocket cannot be missed.
// The wording of the reports lives in runReport.js (pure, unit-tested).
import { app, ToolError, tick } from "./graphCtx.js";
import { api } from "../../../scripts/api.js";
import { finishedText, rejectionLines } from "./runReport.js";

const clamp = (v, lo, hi, dflt) => Math.max(lo, Math.min(Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt, hi));

/** "12" or "57:12" (node 12 inside subgraph node 57) -> readable. */
export function describeNodeRef(id) {
  const parts = String(id).split(":");
  let g = app.rootGraph ?? app.graph, node = null;
  for (const p of parts) {
    node = (g?._nodes ?? []).find((n) => String(n.id) === p) ?? null;
    if (!node) return String(id);
    g = node.subgraph;
  }
  const type = node.isSubgraphNode?.() ? "subgraph" : node.type;
  const title = node.title && node.title !== type ? ` ${JSON.stringify(node.title)}` : "";
  return `${id} (${type}${title})${parts.length > 1 ? ` inside subgraph node ${parts.slice(0, -1).join(":")}` : ""}`;
}

async function getJson(path) {
  const r = await api.fetchApi(path);
  if (!r.ok) throw new ToolError(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function watch(ids, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  const live = { node: null, value: 0, max: 0 };
  const onProgress = (e) => { live.value = e.detail?.value ?? 0; live.max = e.detail?.max ?? 0; if (e.detail?.node) live.node = e.detail.node; };
  const onExecuting = (e) => { const d = e.detail; live.node = (d && typeof d === "object" ? d.node ?? d.display_node : d) ?? live.node; live.value = 0; live.max = 0; };
  api.addEventListener("progress", onProgress);
  api.addEventListener("executing", onExecuting);
  const reports = [];
  try {
    for (const id of ids) {
      let misses = 0;
      for (;;) {
        const entry = (await getJson(`/history/${encodeURIComponent(id)}`))?.[id];
        if (entry) { reports.push(finishedText(id, entry, describeNodeRef)); break; }
        const q = await getJson("/queue");
        const running = (q.queue_running ?? []).some((t) => t?.[1] === id);
        const ahead = (q.queue_pending ?? []).findIndex((t) => t?.[1] === id);
        if (!running && ahead < 0 && ++misses >= 3) { // history is written a moment after the queue empties
          reports.push(`prompt ${id}: not in the queue and not in the history (deleted from the queue, or the history was cleared).`);
          break;
        }
        if (Date.now() > deadline) {
          const where = running
            ? `RUNNING${live.node ? `, at node ${describeNodeRef(live.node)}` : ""}${live.max ? `, step ${live.value}/${live.max}` : ""}`
            : `PENDING (${Math.max(ahead, 0)} job(s) ahead of it in the queue)`;
          reports.push(`prompt ${id}: still ${where} after ${timeoutS}s. Call wait_for_execution with this prompt_id to keep waiting; run_command Comfy.Interrupt stops it.`);
          return reports.join("\n\n");
        }
        await tick(running || ahead >= 0 ? 700 : 300);
      }
    }
  } finally {
    api.removeEventListener("progress", onProgress);
    api.removeEventListener("executing", onExecuting);
  }
  return reports.join("\n\n");
}

export async function queuePrompt({ front = false, batch_count, wait = true, timeout_s } = {}) {
  const count = Math.round(clamp(batch_count, 1, 50, 1));
  // app.queuePrompt hands back neither the prompt id nor the server's verdict: listen in on the
  // API call it makes. Restored in `finally`, whatever happens.
  const seen = [];
  const original = api.queuePrompt;
  api.queuePrompt = async function (...a) {
    try {
      const r = await original.apply(this, a);
      seen.push({ response: r });
      return r;
    } catch (e) {
      seen.push({ error: e });
      throw e;
    }
  };
  let accepted;
  try {
    accepted = await app.queuePrompt(front ? -1 : 0, count);
  } catch (e) {
    throw new ToolError(`Queueing failed: ${e?.message ?? e}`);
  } finally {
    api.queuePrompt = original;
  }
  const ids = seen.map((s) => s.response?.prompt_id).filter(Boolean);
  if (!ids.length) {
    const failure = seen.find((s) => s.error)?.error;
    const lines = rejectionLines(failure?.response ?? failure, describeNodeRef);
    if (!lines.length && app.lastNodeErrors) lines.push(...rejectionLines({ node_errors: app.lastNodeErrors }, describeNodeRef));
    if (!lines.length) {
      lines.push(failure?.message ? String(failure.message) : accepted === false
        ? 'ComfyUI did not send the workflow (it may be showing a dialog about missing nodes or models: screenshot target "ui").'
        : "No prompt id came back.");
    }
    throw new ToolError(`NOT queued — ComfyUI rejected the workflow:\n${lines.join("\n")}\nFix this and queue again.`);
  }
  const warnings = seen.flatMap((s) => rejectionLines({ node_errors: s.response?.node_errors }, describeNodeRef));
  const head = `queued ${ids.length} prompt(s): ${ids.join(", ")}${warnings.length ? `\nwarnings (these outputs were skipped):\n${warnings.join("\n")}` : ""}`;
  if (wait === false) return `${head}\nNot waiting. Use wait_for_execution to get the result.`;
  return `${head}\n${await watch(ids, clamp(timeout_s, 1, 900, 120))}`;
}

export async function waitForExecution({ prompt_id, timeout_s } = {}) {
  let id = prompt_id;
  if (!id) {
    const q = await getJson("/queue");
    id = (q.queue_running ?? [])[0]?.[1] ?? (q.queue_pending ?? []).slice(-1)[0]?.[1];
    if (!id) id = Object.keys((await getJson("/history?max_items=1")) ?? {}).slice(-1)[0];
    if (!id) throw new ToolError("Nothing is running or queued, and the history is empty.");
  }
  return watch([String(id)], clamp(timeout_s, 1, 900, 120));
}
