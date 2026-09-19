// Browser-side tool table. Names and argument shapes mirror sidekick/tooldefs/*.py.
import { withUndo } from "./graphCtx.js";
import { getNode, getWorkflow, traceConnections } from "./read.js";
import { addNode, arrangeNodes, connectNodes, createGroup, disconnect, editGraph, removeGroup, removeNodes, setWidgetValues, updateGroup, updateNode } from "./edit.js";
import { listCommands, runCommand } from "./commands.js";
import { workflowTabs } from "./workflow.js";
import { screenshot } from "./vision.js";

// edit: true -> wrapped in ONE undo step of the active workflow.
// run_command / workflow_tabs are deliberately NOT wrapped: they may switch tabs mid-call, and
// closing the undo step then would capture the new tab's graph into the old tab's history.
// ComfyUI's own commands do their own change tracking.
const TOOLS = {
  get_workflow: { fn: getWorkflow },
  get_node: { fn: getNode },
  trace_connections: { fn: traceConnections },
  add_node: { fn: addNode, edit: true },
  connect_nodes: { fn: connectNodes, edit: true },
  disconnect: { fn: disconnect, edit: true },
  set_widget_values: { fn: setWidgetValues, edit: true },
  update_node: { fn: updateNode, edit: true },
  remove_nodes: { fn: removeNodes, edit: true },
  create_group: { fn: createGroup, edit: true },
  update_group: { fn: updateGroup, edit: true },
  remove_group: { fn: removeGroup, edit: true },
  arrange_nodes: { fn: arrangeNodes, edit: true },
  edit_graph: { fn: editGraph, edit: true },
  list_commands: { fn: listCommands },
  run_command: { fn: runCommand },
  workflow_tabs: { fn: workflowTabs },
  screenshot: { fn: screenshot },
};

export async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Tool "${name}" is not implemented in this browser build. Hard-refresh the ComfyUI page.`);
  const call = () => tool.fn(args ?? {});
  return tool.edit ? withUndo(call) : call();
}

export const toolNames = () => Object.keys(TOOLS);
