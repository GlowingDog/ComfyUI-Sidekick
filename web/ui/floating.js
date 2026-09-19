// The chat as a floating window over the canvas: drag it by its bar, resize it from the corner,
// dock it back into the sidebar. Chat state lives in bridge/client.js, so moving the panel
// between the sidebar and this window loses nothing. Geometry is remembered per browser.
import { mountPanel } from "./panel.js";

const KEY = "sidekick.float";
const MIN_W = 320, MIN_H = 360;

let frame = null;
let unmount = null;
let onDock = null;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { return {}; }
}
function save(patch) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...patch })); } catch { /* private mode */ }
}

export const isFloating = () => !!frame;
export const wasFloating = () => !!load().open;

function clamp(g) {
  const w = Math.max(MIN_W, Math.min(g.w ?? 420, window.innerWidth - 16));
  const h = Math.max(MIN_H, Math.min(g.h ?? 640, window.innerHeight - 16));
  const x = Math.max(8, Math.min(g.x ?? window.innerWidth - w - 24, window.innerWidth - w - 8));
  const y = Math.max(8, Math.min(g.y ?? 64, window.innerHeight - h - 8));
  return { x, y, w, h };
}

function place(g) {
  Object.assign(frame.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
}

const geometry = () => ({ x: frame.offsetLeft, y: frame.offsetTop, w: frame.offsetWidth, h: frame.offsetHeight });

export function openFloating({ dock } = {}) {
  if (frame) return;
  onDock = dock ?? null;
  // data-sidekick-ui: ui_snapshot / ui_act skip everything inside (the assistant must not drive its own window)
  frame = document.createElement("div");
  frame.setAttribute("data-sidekick-ui", "");
  frame.style.cssText = "position:fixed;z-index:999;display:flex;flex-direction:column;min-width:320px;min-height:360px;resize:both;overflow:hidden;"
    + "border:1px solid var(--border-color,#4e4e4e);border-radius:10px;background:var(--comfy-menu-bg,#202020);box-shadow:0 12px 40px rgba(0,0,0,.55)";
  const bar = document.createElement("div");
  bar.textContent = "Sidekick";
  bar.title = "Drag to move";
  bar.style.cssText = "flex:none;cursor:move;user-select:none;touch-action:none;padding:5px 10px;font:600 12px system-ui,sans-serif;"
    + "color:var(--descrip-text,#999);background:var(--comfy-input-bg,#2a2a2a);border-bottom:1px solid var(--border-color,#4e4e4e)";
  const body = document.createElement("div");
  body.style.cssText = "flex:1;min-height:0";
  frame.append(bar, body);
  document.body.append(frame);
  place(clamp(load()));

  let drag = null;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { dx: e.clientX - frame.offsetLeft, dy: e.clientY - frame.offsetTop };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    place(clamp({ ...geometry(), x: e.clientX - drag.dx, y: e.clientY - drag.dy }));
  });
  const drop = () => { if (drag) { drag = null; save(geometry()); } };
  bar.addEventListener("pointerup", drop);
  bar.addEventListener("pointercancel", drop);
  bar.addEventListener("dblclick", () => { place(clamp({})); save(geometry()); }); // back to the default corner

  const sizes = new ResizeObserver(() => { if (frame) save(geometry()); });
  sizes.observe(frame);
  const refit = () => { if (frame) place(clamp(geometry())); };
  window.addEventListener("resize", refit);
  // The canvas must not see what happens in the window (wheel zoom, drag select, shortcuts).
  for (const type of ["wheel", "pointerdown", "mousedown", "dblclick", "contextmenu"]) frame.addEventListener(type, (e) => e.stopPropagation());

  const stopPanel = mountPanel(body, { floating: true, onToggleFloat: () => { const d = onDock; closeFloating(); d?.(); } });
  unmount = () => { sizes.disconnect(); window.removeEventListener("resize", refit); stopPanel(); };
  save({ open: true });
}

export function closeFloating() {
  if (!frame) return;
  save({ ...geometry(), open: false });
  unmount?.();
  frame.remove();
  frame = unmount = onDock = null;
}
