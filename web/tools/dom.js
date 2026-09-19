// The rest of the interface: dialogs, the Manager's windows, sidebars, menus, text prompts.
// ui_snapshot reads what is on screen as an outline with refs; ui_act clicks, types, selects
// and presses keys on those refs. Sidekick's own panel lives in a Shadow root, which the walk
// never enters — so the assistant cannot see or press its own permission cards — and the
// floating window's frame is marked data-sidekick-ui and skipped.
import { ToolError, tick } from "./graphCtx.js";
import { describeControl, limitLines, parseKey, pickByText, squash } from "./uiText.js";

// Things that float above the page. When one is open, that is what the user is "in".
const OVERLAYS = [
  ".p-dialog", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', ".p-popover", ".p-overlaypanel", ".p-contextmenu",
  ".p-menu-overlay", ".p-tieredmenu-overlay", ".p-select-overlay", ".p-multiselect-overlay", ".p-autocomplete-overlay", ".p-dropdown-panel",
  ".p-toast-message", ".p-confirmpopup", ".litecontextmenu", ".litegraph.dialog", ".graphdialog", ".litesearchbox", ".comfy-modal",
].join(",");
const CONTROLS = [
  "a[href]", "button", "input", "select", "textarea", "summary", "[contenteditable='true']", "[contenteditable='']",
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="option"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="combobox"]', '[role="slider"]', '[role="spinbutton"]', '[role="textbox"]',
  '[role="treeitem"]', ".litemenu-entry", ".p-select", ".p-togglebutton", ".p-listbox-option", ".p-tree-node-content", "[onclick]",
].join(",");
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CANVAS", "SVG", "svg", "VIDEO", "AUDIO", "IFRAME", "LINK", "META"]);
// Parts of NODES that happen to be HTML (multiline text boxes, Vue-rendered nodes): the graph tools
// own those (set_widget_values …); listing every prompt box of a big workflow here would be noise.
const NODE_UI = ".dom-widget, [data-node-id]";
const FORM_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

let refs = new Map(); // ref -> WeakRef(element); replaced by every snapshot
let counter = 0;
const shownAs = new WeakMap(); // element -> the label the last outline gave it (may come from the text before it)

const isOurs = (el) => !!el.closest?.("[data-sidekick-ui]");

function visible(el) {
  if (!el.isConnected) return false;
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden") return false;
  return s.display === "contents" || el.getClientRects().length > 0; // "contents" wrappers have no box of their own
}

function roleOf(el) {
  const role = el.getAttribute("role");
  if (role) return role;
  const tag = el.tagName;
  if (tag === "A") return "link";
  if (tag === "BUTTON" || tag === "SUMMARY") return "button";
  if (tag === "SELECT") return "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return { checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", button: "button", submit: "button", reset: "button", file: "file input", color: "color input" }[t] ?? "textbox";
  }
  if (el.isContentEditable) return "textbox";
  if (el.classList.contains("litemenu-entry")) return "menuitem";
  if (el.classList.contains("p-select")) return "combobox";
  return "button";
}

function iconHint(el) {
  const icon = el.querySelector?.("[class*='pi-'], [class*='icon-[']") ?? (String(el.className).includes("pi-") ? el : null);
  const m = icon && /(?:pi-|icon-\[[\w-]+--)([\w-]+)/.exec(String(icon.className));
  return m ? `icon: ${m[1]}` : "";
}

function labelOf(el) {
  const byId = (ids) => squash(String(ids).split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  const own = () => squash(el.tagName === "SELECT" ? "" : el.innerText ?? el.textContent);
  return squash(el.getAttribute("aria-label")) || (el.getAttribute("aria-labelledby") && byId(el.getAttribute("aria-labelledby")))
    || (el.id && squash(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent)) || (FORM_TAGS.has(el.tagName) && squash(el.closest("label")?.textContent))
    || (!FORM_TAGS.has(el.tagName) && own()) || squash(el.getAttribute("placeholder")) || squash(el.getAttribute("title")) || squash(el.getAttribute("data-pr-tooltip"))
    || squash(el.getAttribute("alt")) || (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type) && squash(el.value))
    || iconHint(el) || squash(el.getAttribute("name")) || squash(el.id) || "";
}

function describe(el, ref) {
  const tag = el.tagName, type = (el.getAttribute("type") || "").toLowerCase();
  const d = { ref, role: roleOf(el), label: labelOf(el) };
  d.disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true" || el.classList.contains("p-disabled") || !!el.closest(".p-disabled");
  if (tag === "INPUT" && (type === "checkbox" || type === "radio")) d.checked = !!el.checked;
  else if (el.hasAttribute("aria-checked")) d.checked = el.getAttribute("aria-checked") === "true";
  else if (tag === "INPUT" || tag === "TEXTAREA") {
    d.secret = type === "password";
    d.value = d.secret ? undefined : el.value ?? "";
    d.multiline = tag === "TEXTAREA";
  } else if (tag === "SELECT") {
    d.value = el.selectedOptions?.[0]?.textContent ?? el.value;
    d.options = [...el.options].map((o) => o.textContent);
  } else if (el.isContentEditable) { d.value = el.innerText; d.multiline = true; }
  else if (el.classList.contains("p-select")) d.value = squash(el.querySelector(".p-select-label")?.textContent);
  if (el.getAttribute("aria-selected") === "true" || el.classList.contains("p-tab-active")) d.selected = true;
  if (el.hasAttribute("aria-expanded")) d.expanded = el.getAttribute("aria-expanded") === "true";
  return d;
}

/** DOM-order outline: text the user can read, and every control with a ref. */
function outline(root, lines, controls) {
  let buffer = [], lastText = "";
  const flush = (depth) => {
    const text = squash(buffer.join(" "));
    buffer = [];
    if (!text) return;
    lastText = text;
    lines.push({ text: `${"  ".repeat(depth)}${text.length > 220 ? text.slice(0, 219) + "…" : text}` });
  };
  const walk = (node, depth) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { if (child.nodeValue.trim()) buffer.push(child.nodeValue); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(child.tagName) || isOurs(child) || child.matches(NODE_UI) || !visible(child)) continue;
      if (child.matches(CONTROLS)) {
        flush(depth);
        const ref = `e${++counter}`;
        refs.set(ref, new WeakRef(child));
        const d = describe(child, ref);
        if (!d.label && lastText) d.label = lastText.slice(0, 60); // an unlabelled field is usually named by the text before it
        lastText = "";
        shownAs.set(child, d.label);
        controls.push({ ...d, el: child });
        lines.push({ text: `${"  ".repeat(depth)}${describeControl(d)}` });
        // a control inside a control (a checkbox in a menu row, an input in a button-like label) still counts;
        // PrimeVue's hidden focus inputs (.p-hidden-accessible) do not
        for (const inner of child.querySelectorAll("input, select, textarea")) {
          if (!inner.closest(".p-hidden-accessible") && visible(inner)) walk({ childNodes: [inner] }, depth + 1);
        }
        continue;
      }
      const block = !getComputedStyle(child).display.startsWith("inline");
      if (block) flush(depth);
      walk(child, depth + (block && /^(UL|OL|TABLE|FIELDSET|SECTION|FORM|NAV)$/.test(child.tagName) ? 1 : 0));
      if (block) flush(depth);
    }
  };
  walk(root, 1);
  flush(1);
}

function overlayRoots() {
  const all = [...document.querySelectorAll(OVERLAYS)].filter((el) => visible(el) && !isOurs(el));
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el))); // outermost only
}

function titleOf(root) {
  const t = root.querySelector?.(".p-dialog-title, [role='heading'], h1, h2, h3, .comfy-modal-title, legend");
  const kind = root.matches(".litecontextmenu, .p-contextmenu, .p-menu-overlay, .p-tieredmenu-overlay") ? "menu"
    : root.matches(".p-select-overlay, .p-multiselect-overlay, .p-autocomplete-overlay, .p-dropdown-panel") ? "option list"
      : root.matches(".p-toast-message") ? "notification" : root.matches(".graphdialog, .litegraph.dialog, .litesearchbox") ? "canvas prompt" : "dialog";
  return `${kind}${t ? ` ${JSON.stringify(squash(t.textContent).slice(0, 80))}` : ""}`;
}

function take({ scope = "auto", query, limit } = {}) {
  refs = new Map();
  const lines = [], controls = [];
  const overlays = overlayRoots();
  const wholePage = scope === "page" || (scope !== "overlays" && !overlays.length);
  if (wholePage) {
    lines.push({ header: true, text: "page (no dialog or menu is open): menus, sidebars, panels. The node graph itself is NOT here: use the graph tools for it." });
    outline(document.body, lines, controls);
  } else {
    for (const root of overlays) {
      lines.push({ header: true, text: `${titleOf(root)}:` });
      outline(root, lines, controls);
    }
    lines.push({ header: true, text: `(${overlays.length} overlay(s) open; the page behind them is left out: scope "page" shows it)` });
  }
  return { lines, controls, text: limitLines(lines, { query, limit: Math.max(10, Math.min(Number(limit) || 120, 400)) }).join("\n") };
}

export function uiSnapshot(args = {}) {
  if (args.scope && !["auto", "page", "overlays"].includes(args.scope)) throw new ToolError('scope must be "auto", "page" or "overlays".');
  return take(args).text || "(nothing readable on screen)";
}

// ---------- acting ----------

function resolve({ ref, text }) {
  if (ref !== undefined && ref !== null && ref !== "") {
    const el = refs.get(String(ref).replace(/^\[|\]$/g, ""))?.deref();
    if (!el || !el.isConnected) throw new ToolError(`Ref ${ref} is no longer on screen (refs only live until the next ui_snapshot). Take a new ui_snapshot.`);
    if (isOurs(el)) throw new ToolError("That element belongs to Sidekick itself.");
    return el;
  }
  if (text === undefined || text === null || text === "") throw new ToolError("Give ref (from ui_snapshot) or text (the label of the element).");
  const found = pickByText(take({}).controls, text);
  if (found.error) throw new ToolError(found.error);
  return found.control.el;
}

function mouse(el, type, init) {
  const Ctor = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
  return el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: "mouse", isPrimary: true, ...init }));
}

function click(el, { double = false, right = false } = {}) {
  el.scrollIntoView?.({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: right ? 2 : 0, buttons: right ? 2 : 1 };
  for (const type of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown"]) mouse(el, type, at);
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  for (const type of ["pointerup", "mouseup"]) mouse(el, type, { ...at, buttons: 0 });
  if (right) return void mouse(el, "contextmenu", at);
  el.click(); // the one event every framework listens to; also toggles checkboxes and follows labels
  if (double) { el.click(); mouse(el, "dblclick", { ...at, detail: 2 }); }
}

function setValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set; // past the framework's own property wrapper
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: String(value), inputType: "insertText" }));
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function press(target, init) {
  const go = (type) => target.dispatchEvent(new KeyboardEvent(type, init));
  const proceed = go("keydown");
  if (proceed && init.key.length === 1) go("keypress");
  go("keyup");
}

function type(el, { value, clear = true, submit = false }) {
  if (value === undefined || value === null) throw new ToolError("type needs value (the text).");
  const text = String(value);
  el.scrollIntoView?.({ block: "center" });
  el.focus?.({ preventScroll: true });
  if (el.isContentEditable) {
    if (clear) el.textContent = "";
    el.textContent += text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" }));
  } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    if (["checkbox", "radio", "file", "button", "submit"].includes(el.type)) throw new ToolError(`A ${el.type} input cannot be typed into; click it.`);
    if (el.type === "password") throw new ToolError("Sidekick does not type into password fields. Ask the user to enter it.");
    if (el.readOnly || el.disabled) throw new ToolError("That field is read-only or disabled.");
    setValue(el, clear ? text : `${el.value ?? ""}${text}`);
  } else {
    throw new ToolError(`${roleOf(el)} ${JSON.stringify(labelOf(el))} is not a text field. For a drop-down use action "select"; for a custom drop-down click it, take a ui_snapshot and click the option.`);
  }
  if (submit) {
    press(el, parseKey("Enter"));
    if (el.form && typeof el.form.requestSubmit === "function" && el.isConnected) { try { el.form.requestSubmit(); } catch { /* the form validates on its own */ } }
  }
}

function select(el, value) {
  if (el.tagName !== "SELECT") throw new ToolError(`${roleOf(el)} ${JSON.stringify(labelOf(el))} is not a native drop-down: click it, take a ui_snapshot, then click the option.`);
  const want = squash(value).toLowerCase();
  const opt = [...el.options].find((o) => squash(o.textContent).toLowerCase() === want || String(o.value).toLowerCase() === want)
    ?? [...el.options].filter((o) => squash(o.textContent).toLowerCase().includes(want))[0];
  if (!opt || !want) throw new ToolError(`No option "${value}". Options: ${[...el.options].map((o) => squash(o.textContent)).slice(0, 30).join(" | ")}`);
  setValue(el, opt.value);
}

export async function uiAct(args = {}) {
  const action = args.action ?? (args.key ? "key" : args.value !== undefined ? "type" : "click");
  let did;
  if (action === "key") {
    const init = parseKey(args.key);
    if (init.error) throw new ToolError(init.error);
    let target = args.ref || args.text ? resolve(args) : document.activeElement;
    if (!target || target === document.body || isOurs(target) || target.shadowRoot) target = document.querySelector(OVERLAYS) ?? document.body;
    press(target, init);
    did = `pressed ${args.key}`;
  } else {
    const el = resolve(args);
    const name = `${roleOf(el)} ${JSON.stringify((labelOf(el) || shownAs.get(el) || "").slice(0, 60))}`;
    if (action !== "hover" && (el.disabled === true || el.getAttribute("aria-disabled") === "true" || el.classList.contains("p-disabled"))) throw new ToolError(`${name} is disabled right now.`);
    if (action === "click") { click(el, { double: !!args.double, right: !!args.right }); did = `${args.right ? "right-clicked" : args.double ? "double-clicked" : "clicked"} ${name}`; }
    else if (action === "type") { type(el, args); did = `typed into ${name}${args.submit ? " and pressed Enter" : ""}`; }
    else if (action === "select") { select(el, args.value); did = `selected ${JSON.stringify(String(args.value))} in ${name}`; }
    else if (action === "hover") { el.scrollIntoView?.({ block: "center" }); const r = el.getBoundingClientRect(); for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(el, t, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); did = `hovering ${name}`; }
    else throw new ToolError('action must be "click", "type", "select", "key" or "hover".');
  }
  await tick(350); // let the interface react before looking again
  const now = take({ limit: args.limit ?? 60 });
  return `${did}.\nOn screen now (new refs):\n${now.text}`;
}
