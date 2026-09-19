// ComfyUI command registry: the same actions the menus, keybindings and node packs expose.
// Which ids need a permission card is decided in sidekick/tooldefs/ui.py (command_risk).
import { app, ToolError, tick } from "./graphCtx.js";

const registry = () => app.extensionManager?.command?.commands ?? [];

function labelOf(cmd) {
  try {
    const l = typeof cmd.label === "function" ? cmd.label() : cmd.label;
    return String(l ?? cmd.menubarLabel ?? "");
  } catch {
    return "";
  }
}

export function listCommands({ query, limit = 40 } = {}) {
  const toks = String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const rows = registry()
    .map((c) => ({ id: c.id, label: labelOf(c), source: c.source ?? "" }))
    .filter((c) => toks.every((t) => `${c.id} ${c.label}`.toLowerCase().includes(t)))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!rows.length) return `No command matches "${query}". Try one word, e.g. "workflow", "sidebar", "manager", "queue".`;
  const max = Math.max(1, Math.min(Number(limit) || 40, 150));
  const lines = rows.slice(0, max).map((c) => `${c.id} | ${c.label}${c.source ? " | " + c.source : ""}`);
  if (rows.length > max) lines.push(`…${rows.length - max} more; refine the query.`);
  return lines.join("\n");
}

export async function runCommand({ id }) {
  const cmd = registry().find((c) => c.id === id);
  if (!cmd) {
    const tail = String(id ?? "").split(".").pop().toLowerCase();
    const near = registry().filter((c) => tail && c.id.toLowerCase().includes(tail)).slice(0, 8).map((c) => c.id);
    throw new ToolError(`No command "${id}".${near.length ? ` Did you mean: ${near.join(", ")}?` : " Use list_commands."}`);
  }
  let failure = null;
  await app.extensionManager.command.execute(id, { errorHandler: (e) => { failure = e; } });
  if (failure) throw new ToolError(`Command ${id} failed: ${failure?.message ?? failure}`);
  await tick(150); // let dialogs / panels / tabs settle before the next tool looks at the UI
  return `ran ${id} (${labelOf(cmd)})`;
}
