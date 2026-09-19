// Browser-side tool table. Names and argument shapes mirror sidekick/tooldefs/*.py.
import { withUndo } from "./graphCtx.js";
import { getNode, getWorkflow, traceConnections } from "./read.js";
import { addNode, arrangeNodes, connectNodes, createGroup, disconnect, editGraph, removeGroup, removeNodes, setWidgetValues, updateGroup, updateNode } from "./edit.js";
import { autoLayout } from "./autoLayout.js";
import { listCommands, runCommand } from "./commands.js";
import { contextMenu } from "./menus.js";
import { queuePrompt, waitForExecution } from "./run.js";
import { settings } from "./settings.js";
import { subgraph } from "./subgraph.js";
import { loadWorkflow, workflowTabs } from "./workflow.js";
import { screenshot } from "./vision.js";

// edit: true -> wrapped in ONE undo step of the active workflow.
// run_command / workflow_tabs / load_workflow / subgraph are deliberately NOT wrapped: they
// switch tabs or graphs mid-call, and closing the undo step then would capture the new graph into
// the old tab's history. ComfyUI's own commands do their own change tracking. context_menu wraps
// itself, and only when it invokes something. queue_prompt must not be wrapped either: the
// frontend rolls seed widgets after queueing and tracks that change on its own.
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
  auto_layout: { fn: autoLayout, edit: true },
  edit_graph: { fn: editGraph, edit: true },
  list_commands: { fn: listCommands },
  run_command: { fn: runCommand },
  workflow_tabs: { fn: workflowTabs },
  load_workflow: { fn: loadWorkflow },
  subgraph: { fn: subgraph },
  context_menu: { fn: contextMenu },
  settings: { fn: settings },
  queue_prompt: { fn: queuePrompt },
  wait_for_execution: { fn: waitForExecution },
  screenshot: { fn: screenshot },
};

export async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Tool "${name}" is not implemented in this browser build. Hard-refresh the ComfyUI page.`);
  const call = () => tool.fn(args ?? {});
  return tool.edit ? withUndo(call) : call();
}

export const toolNames = () => Object.keys(TOOLS);
