// Sight for the agent. Two sources:
//  - the LiteGraph canvas, re-rendered off-view at a size WE choose (works whatever the window
//    size or zoom is, and never moves what the user is looking at);
//  - the whole browser tab through getDisplayMedia, behind the browser's own consent prompt.
// Result shape understood by sidekick/registry.py: {__images__: [{mime, data}], text, thumb}.
import { app, ToolError, allNodes, allGroups, nodeById, nodeRect } from "./graphCtx.js";
import { union } from "./layoutMath.js";
import { findGroup } from "./read.js";
import { requestGesture } from "../bridge/client.js";

const MAX_EDGE = 1568; // larger images are downscaled by vision models anyway
const THUMB_EDGE = 360;
const PAD = 40;

function encode(source, sx, sy, sw, sh, maxEdge, quality) {
  const k = Math.min(1, maxEdge / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * k));
  out.height = Math.max(1, Math.round(sh * k));
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return { url: out.toDataURL("image/jpeg", quality), w: out.width, h: out.height };
}

function pack(source, sx, sy, sw, sh, text) {
  const full = encode(source, sx, sy, sw, sh, MAX_EDGE, 0.85);
  const thumb = encode(source, sx, sy, sw, sh, THUMB_EDGE, 0.7);
  return {
    __images__: [{ mime: "image/jpeg", data: full.url.slice(full.url.indexOf(",") + 1) }],
    thumb: thumb.url,
    text: `${text} | image ${full.w}x${full.h}px`,
  };
}

// ---------- graph canvas ----------

function regionFor({ node_ids, group }) {
  if (Array.isArray(node_ids) && node_ids.length) {
    return { rect: union(node_ids.map(nodeById).map(nodeRect)), label: `${node_ids.length} node(s)` };
  }
  if (group !== undefined && group !== null && group !== "") {
    const g = findGroup(group);
    return { rect: [...(g._bounding ?? [...g.pos, ...g.size])], label: `group #${g.id} ${JSON.stringify(g.title)}` };
  }
  const rects = [...allNodes().map(nodeRect), ...allGroups().map((g) => [...(g._bounding ?? [...g.pos, ...g.size])])];
  if (!rects.length) throw new ToolError("The canvas is empty; there is nothing to look at.");
  return { rect: union(rects), label: "whole workflow" };
}

function captureGraph(args, viewportOnly) {
  const c = app.canvas, el = c.canvas;
  const ctx2d = el.getContext("2d");
  let rect, label, scale;
  const cssW = el.clientWidth, cssH = el.clientHeight;
  if (viewportOnly && cssW > 0 && cssH > 0) {
    scale = c.ds.scale;
    rect = [-c.ds.offset[0], -c.ds.offset[1], cssW / scale, cssH / scale];
    label = "the user's current view";
  } else {
    ({ rect, label } = regionFor(args));
    rect = [rect[0] - PAD, rect[1] - PAD, rect[2] + 2 * PAD, rect[3] + 2 * PAD];
    scale = Math.min(1, MAX_EDGE / Math.max(rect[2], rect[3]));
    if (viewportOnly) label += " (the canvas is not visible right now, so the whole workflow is shown)";
  }
  const W = Math.max(64, Math.round(rect[2] * scale)), H = Math.max(64, Math.round(rect[3] * scale));

  // Re-render the real canvas at our size and framing, grab it, put everything back — all in one
  // synchronous task, so the browser never paints the intermediate state.
  const saved = { w: el.width, h: el.height, scale: c.ds.scale, off: [c.ds.offset[0], c.ds.offset[1]], tf: ctx2d.getTransform(), lq: c._lowQualityZoomThreshold, info: c.show_info };
  let shot;
  try {
    c.show_info = false; // LiteGraph's FPS/debug overlay is noise in a screenshot
    c.resize(W, H); // resets the 2D context: identity transform, 1 bitmap px = 1 unit
    c.ds.scale = scale;
    c.ds.offset[0] = -rect[0];
    c.ds.offset[1] = -rect[1];
    if ("_lowQualityZoomThreshold" in c) c._lowQualityZoomThreshold = 0; // keep text when zoomed out
    c.draw(true, true);
    const vue = !!app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled");
    const notes = [
      `screenshot of ${label} | graph region ${rect.slice(0, 2).map(Math.round).join(",")}..${Math.round(rect[0] + rect[2])},${Math.round(rect[1] + rect[3])} | zoom ${scale.toFixed(2)}`,
    ];
    if (scale < 0.5) notes.push("Zoomed out this far, text is not readable: use it for layout, and frame a group or node_ids to read labels and values.");
    notes.push(vue
      ? "WARNING: the new Vue node renderer is on, so nodes are HTML and are NOT in this picture (only links, groups, background). Use target \"ui\" to see nodes."
      : "Multiline text boxes and other HTML widgets are not drawn on the canvas (their values are in get_workflow).");
    shot = pack(el, 0, 0, W, H, notes.join("\n"));
  } finally {
    c.show_info = saved.info;
    if ("_lowQualityZoomThreshold" in c) c._lowQualityZoomThreshold = saved.lq;
    c.ds.scale = saved.scale;
    c.ds.offset[0] = saved.off[0];
    c.ds.offset[1] = saved.off[1];
    c.resize(saved.w, saved.h);
    ctx2d.setTransform(saved.tf); // resize dropped ComfyUI's devicePixelRatio scale
    c.draw(true, true);
  }
  return shot;
}

// ---------- whole tab ----------

let stream = null;
let video = null;

async function ensureTabStream() {
  if (stream?.active) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
    throw new ToolError("This browser/page cannot share the tab (needs http://127.0.0.1, localhost or https, and a desktop browser). Use target \"graph\" instead.");
  }
  // getDisplayMedia must be called from a user gesture: the panel shows a button for it.
  stream = await requestGesture({
    text: "Sidekick wants to look at this browser tab.",
    button: "Share this tab",
    run: () => navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude",
    }),
  });
  stream.getVideoTracks()[0]?.addEventListener("ended", () => { stream = null; video = null; });
  video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
}

async function captureTab() {
  await ensureTabStream();
  await new Promise((r) => setTimeout(r, 500)); // let the share bar close and fresh frames arrive
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new ToolError("Tab sharing is on but no frame arrived yet; try again.");
  return pack(video, 0, 0, w, h, "screenshot of the whole browser tab (what the user sees right now)");
}

export async function screenshot(args = {}) {
  const target = args.target ?? "graph";
  if (target === "ui") return captureTab();
  if (target === "viewport") return captureGraph(args, true);
  if (target === "graph") return captureGraph(args, false);
  throw new ToolError('target must be "graph", "viewport" or "ui".');
}
