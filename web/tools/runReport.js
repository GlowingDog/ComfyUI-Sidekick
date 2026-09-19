// Pure text reports about queueing and execution (no ComfyUI imports; unit-tested in node).
// `describe(id)` turns a node id ("12", or "57:12" for a node inside subgraph node 57) into text.

/** Lines for a /prompt rejection: {error: {message, details}, node_errors: {id: {errors: [...]}}}. */
export function rejectionLines(resp, describe = String) {
  const lines = [];
  const err = resp?.error;
  if (err) lines.push(`${typeof err === "string" ? err : err.message ?? err.type ?? "rejected"}${err?.details ? `: ${err.details}` : ""}`);
  for (const [id, ne] of Object.entries(resp?.node_errors ?? {})) {
    for (const e of ne?.errors ?? []) lines.push(` node ${describe(id)}: ${e.message ?? e.type}${e.details ? ` — ${e.details}` : ""}`);
  }
  return lines;
}

export function outputLines(outputs, describe = String) {
  const lines = [];
  for (const [id, out] of Object.entries(outputs ?? {})) {
    const files = [];
    for (const key of ["images", "gifs", "audio", "video", "3d"]) {
      for (const f of Array.isArray(out?.[key]) ? out[key] : []) if (f?.filename) files.push(`${f.subfolder ? f.subfolder + "/" : ""}${f.filename} [${f.type ?? "output"}]`);
    }
    const text = Array.isArray(out?.text) ? out.text.map(String).join(" ").slice(0, 300) : "";
    if (!files.length && !text) continue;
    lines.push(` node ${describe(id)}: ${[files.slice(0, 8).join(", "), files.length > 8 ? `…${files.length - 8} more` : "", text ? `text: ${JSON.stringify(text)}` : ""].filter(Boolean).join(" ")}`);
  }
  return lines;
}

/** Report for one /history entry: {status: {status_str, messages: [[name, data], …]}, outputs}. */
export function finishedText(id, entry, describe = String) {
  const msgs = entry?.status?.messages ?? [];
  const msg = (name) => msgs.find((m) => m?.[0] === name)?.[1];
  const started = msg("execution_start")?.timestamp;
  const err = msg("execution_error"), stopped = msg("execution_interrupted"), done = msg("execution_success");
  const took = (t) => (Number.isFinite(started) && Number.isFinite(t) ? ` after ${((t - started) / 1000).toFixed(1)}s` : "");
  const lines = [];
  if (err) {
    lines.push(`prompt ${id}: ERROR${took(err.timestamp)}`);
    lines.push(` node ${describe(err.node_id)} failed: ${err.exception_type ?? "Error"}: ${String(err.exception_message ?? "").trim().slice(0, 1200)}`);
    const tb = (Array.isArray(err.traceback) ? err.traceback.join("") : String(err.traceback ?? "")).trim().split("\n").slice(-4).join("\n");
    if (tb) lines.push(` traceback (last lines):\n${tb.slice(0, 800)}`);
  } else if (stopped) {
    lines.push(`prompt ${id}: INTERRUPTED${took(stopped.timestamp)}${stopped.node_id !== undefined ? ` at node ${describe(stopped.node_id)}` : ""}`);
  } else {
    lines.push(`prompt ${id}: ${entry?.status?.status_str === "error" ? "ERROR" : "SUCCESS"}${took(done?.timestamp)}`);
    const cached = msg("execution_cached")?.nodes?.length;
    if (cached) lines.push(` ${cached} node(s) came from the cache (unchanged since the last run)`);
  }
  const outs = outputLines(entry?.outputs, describe);
  if (outs.length) lines.push("outputs:", ...outs, 'To look at a result: screenshot target "graph" with node_ids of the save/preview node.');
  else if (!err && !stopped) lines.push("no outputs were produced (everything was cached, or no output node ran)");
  return lines.join("\n");
}
