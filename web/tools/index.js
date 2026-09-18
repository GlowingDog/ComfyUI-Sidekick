// Browser-side tool table. Names and argument shapes mirror sidekick/tooldefs/*.py.
import { withUndo } from "./graphCtx.js";
import { getNode, getWorkflow } from "./read.js";
import { addNode, connectNodes, createGroup, disconnect, editGraph, removeGroup, removeNodes, setWidgetValues, updateGroup, updateNode } from "./edit.js";

// edit: true -> wrapped in ONE undo step
const TOOLS = {
  get_workflow: { fn: getWorkflow },
  get_node: { fn: getNode },
  add_node: { fn: addNode, edit: true },
  connect_nodes: { fn: connectNodes, edit: true },
  disconnect: { fn: disconnect, edit: true },
  set_widget_values: { fn: setWidgetValues, edit: true },
  update_node: { fn: updateNode, edit: true },
  remove_nodes: { fn: removeNodes, edit: true },
  create_group: { fn: createGroup, edit: true },
  update_group: { fn: updateGroup, edit: true },
  remove_group: { fn: removeGroup, edit: true },
  edit_graph: { fn: editGraph, edit: true },
};

export async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Tool "${name}" is not implemented in this browser build. Hard-refresh the ComfyUI page.`);
  const call = () => tool.fn(args ?? {});
  return tool.edit ? withUndo(call) : call();
}

export const toolNames = () => Object.keys(TOOLS);
