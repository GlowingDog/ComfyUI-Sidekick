// ComfyUI-Sidekick frontend entry: sidebar tab, floating window, and the tool bridge.
import { app } from "../../scripts/app.js";
import { startClient } from "./bridge/client.js";
import { startRpc } from "./bridge/rpc.js";
import { closeFloating, isFloating, openFloating, wasFloating } from "./ui/floating.js";
import { mountPanel } from "./ui/panel.js";

const TAB = "sidekick";
let unmount = null;

const sidebarOpen = () => app.extensionManager?.sidebarTab?.activeSidebarTabId === TAB;
const toggleSidebar = () => app.extensionManager.command.execute(`Workspace.ToggleSidebarTab.${TAB}`);

function popOut() {
  if (sidebarOpen()) toggleSidebar(); // one chat on screen is enough
  openFloating({ dock: () => { if (!sidebarOpen()) toggleSidebar(); } });
}

app.registerExtension({
  name: "Sidekick",
  commands: [
    { id: "Sidekick.ToggleFloating", label: "Sidekick: floating window on/off", function: () => (isFloating() ? closeFloating() : popOut()) },
  ],
  async setup() {
    startRpc(); // tools must work even while the chat is not on screen
    await startClient();
    app.extensionManager.registerSidebarTab({
      id: TAB,
      icon: "pi pi-sparkles",
      title: "Sidekick",
      tooltip: "Sidekick — AI agent",
      type: "custom",
      render: (el) => {
        unmount?.();
        el.style.height = "100%";
        unmount = mountPanel(el, { onToggleFloat: popOut });
      },
    });
    if (wasFloating()) openFloating({ dock: () => { if (!sidebarOpen()) toggleSidebar(); } });
  },
});
