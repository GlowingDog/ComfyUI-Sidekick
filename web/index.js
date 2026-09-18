// ComfyUI-Sidekick frontend entry: sidebar tab + the tool bridge.
import { app } from "../../scripts/app.js";
import { startClient } from "./bridge/client.js";
import { startRpc } from "./bridge/rpc.js";
import { mountPanel } from "./ui/panel.js";

let unmount = null;

app.registerExtension({
  name: "Sidekick",
  async setup() {
    startRpc(); // tools must work even while the sidebar tab is closed
    await startClient();
    app.extensionManager.registerSidebarTab({
      id: "sidekick",
      icon: "pi pi-sparkles",
      title: "Sidekick",
      tooltip: "Sidekick — AI agent",
      type: "custom",
      render: (el) => {
        unmount?.();
        el.style.height = "100%";
        unmount = mountPanel(el);
      },
    });
  },
});
