// execute_js: the escape hatch. Off unless the user switches it on in Sidekick settings, and
// every single script is shown to the user first (sidekick/tooldefs/ui.py: per-call grants).
import { app, ToolError, graph } from "./graphCtx.js";
import { api } from "../../../scripts/api.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const LIMIT = 12000;

function toText(value) {
  if (value === undefined) return "undefined (the script returned nothing: end it with `return …`)";
  if (typeof value === "string") return value;
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, v) => {
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (typeof v === "bigint") return `${v}n`;
      if (v instanceof Node) return `[${v.nodeName.toLowerCase()}${v.id ? "#" + v.id : ""}]`;
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }, 1) ?? String(value);
  } catch (e) {
    return `[unserializable: ${e.message}] ${String(value)}`;
  }
}

export async function executeJs({ code, timeout_s } = {}) {
  if (typeof code !== "string" || !code.trim()) throw new ToolError("code is required: the body of an async function; use `return` for the result.");
  let fn;
  try {
    fn = new AsyncFunction("app", "api", "graph", "LiteGraph", code);
  } catch (e) {
    throw new ToolError(`Syntax error: ${e.message}`);
  }
  const limit = Math.max(1, Math.min(Number(timeout_s) || 30, 120)) * 1000;
  let timer;
  try {
    const result = await Promise.race([
      fn(app, api, graph(), window.LiteGraph),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new ToolError(`The script did not finish within ${limit / 1000}s (it may still be running).`)), limit); }),
    ]);
    const text = toText(result);
    return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…[${text.length - LIMIT} more characters: return less]` : text;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`${e?.name ?? "Error"}: ${e?.message ?? e}\n${String(e?.stack ?? "").split("\n").slice(1, 4).join("\n")}`);
  } finally {
    clearTimeout(timer);
  }
}
