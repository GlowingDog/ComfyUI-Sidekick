// In-browser checks for what node cannot test: the panel's DOM, the floating window, the DOM
// automation tools. Nothing runs on import (ComfyUI imports every .js under web/). Run from the
// browser console or the Browser pane:
//   const t = await import("/extensions/ComfyUI-Sidekick/dev/paneTests.js"); await t.run()
// It swaps fixture items into the chat store and restores the open chat afterwards. No tokens.
import * as client from "../bridge/client.js";
import { mountPanel } from "../ui/panel.js";
import { closeFloating, isFloating, openFloating } from "../ui/floating.js";
import { uiAct, uiSnapshot } from "../tools/dom.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURES = [
  { id: "t1", kind: "user", text: "build me a workflow" },
  { id: "t2", kind: "assistant", text: "**Done.** Used `KSampler`.\n\n- one\n- two", reasoning: "thinking" },
  { id: "t3", kind: "tool", name: "edit_graph", status: "ok", args: { operations: [{ op: "add_node" }] }, summary: "ok" },
  { id: "t4", kind: "tool", name: "screenshot", status: "ok", args: {}, summary: "shot", thumb: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
  { id: "t5", kind: "question", status: "pending", request_id: "q", questions: [{ question: "Which model?", header: "Model", options: [{ label: "SDXL", description: "big" }, { label: "SD1.5" }] }] },
  { id: "t6", kind: "permission", status: "pending", request_id: "p", tool: "execute_js", note: "Read it first.", args: { code: "const a = 1;\nreturn a + 1;", timeout_s: 5 } },
  { id: "t7", kind: "permission", status: "pending", request_id: "p2", tool: "download_model", args: { url: "https://x.example/m.safetensors" } },
  { id: "t8", kind: "download", download_id: "d1", name: "m.safetensors", folder: "loras", total: 1000, done: 420, speed: 100, status: "running" },
  { id: "t9", kind: "download", download_id: "d2", name: "n.safetensors", folder: "vae", total: 1000, done: 1000, status: "done" },
  { id: "t10", kind: "todos", todos: [{ text: "add nodes", status: "done" }, { text: "connect", status: "in_progress" }, { text: "run", status: "pending" }] },
  { id: "t11", kind: "user", auto: true, text: "↻ ComfyUI restarted. Continuing: connect the nodes" },
  { id: "t12", kind: "error", text: "Provider returned HTTP 401" },
  { id: "t13", kind: "notice", text: "Stopped." },
];

export async function run() {
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail).slice(0, 300) }) });
  const guard = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, `threw: ${e?.message ?? e}`); } };

  const keepItems = client.state.items, keepId = client.state.sessionId;
  const box = document.createElement("div");
  box.setAttribute("data-sidekick-ui", "");
  box.style.cssText = "position:fixed;left:-2000px;top:0;width:420px;height:700px";
  document.body.append(box);
  let floatToggles = 0;
  const unmount = mountPanel(box, { onToggleFloat: () => { floatToggles++; } });
  const root = box.firstElementChild.shadowRoot;
  const button = (title) => [...root.querySelectorAll("button")].find((b) => b.title === title);

  await guard("items", async () => {
    client.showItemsForTest(FIXTURES);
    await sleep(50);
    const list = root.querySelector(".list");
    check("every item kind renders", list.children.length === FIXTURES.length, `${list.children.length} of ${FIXTURES.length}`);
    check("no [object …] text anywhere", !root.textContent.includes("[object"), root.textContent.match(/.{20}\[object.{20}/)?.[0]);
    check("markdown is rendered", !!list.querySelector(".assistant strong") && !!list.querySelector(".assistant code") && list.querySelectorAll(".assistant li").length === 2);
    check("screenshot thumbnail is shown", !!list.querySelector("img.shot"));
    check("question card has its options and a disabled Submit", list.querySelectorAll(".ask .opt").length === 2 && list.querySelector(".ask button.primary")?.disabled === true);
    const cards = [...list.querySelectorAll(".card.ask")].filter((c) => c.textContent.includes("Allow Sidekick"));
    check("a script is shown as written, not as escaped JSON", cards[0]?.querySelector("code")?.textContent.startsWith("const a = 1;\nreturn a + 1;"), cards[0]?.querySelector("code")?.textContent);
    check("scripts cannot be allowed for the whole chat", ![...cards[0].querySelectorAll("button")].some((b) => b.textContent.includes("this chat")));
    check("other tools can", [...cards[1].querySelectorAll("button")].some((b) => b.textContent.includes("this chat")));
    const dl = list.querySelectorAll(".card.dl");
    check("running download: bar at 42% and a cancel button", dl[0]?.querySelector(".bar > div")?.style.width === "42%" && !!dl[0].querySelector("button"));
    check("finished download: full bar, no cancel button", dl[1]?.querySelector(".bar > div")?.style.width === "100%" && !dl[1].querySelector("button"));
    const todos = list.querySelectorAll(".todo");
    check("plan card: 1/3, states styled", list.querySelector(".todos .head")?.textContent.includes("1/3") && todos[0]?.classList.contains("done") && todos[1]?.classList.contains("in_progress"));
    check("automatic message looks like a notice, not like the user", list.children[10]?.className === "notice");
  });

  await guard("overlays", async () => {
    button("Settings").click();
    await sleep(80);
    const ov = root.querySelector(".overlay");
    const heads = [...ov.querySelectorAll("h4")].map((x) => x.textContent);
    check("settings: all sections", ["Behaviour", "Web and downloads", "API providers", "CLIs", "Developer"].every((t) => heads.includes(t)), heads.join(", "));
    check("settings: no [object …]", !ov.textContent.includes("[object"));
    check("settings: secrets are password fields", ov.querySelectorAll("input[type=password]").length >= 4);
    check("settings: execute_js switch exists and is off by default", [...ov.querySelectorAll("label.check")].some((l) => l.textContent.includes("execute_js")));
    [...root.querySelectorAll("button")].find((b) => b.textContent.includes("Close")).click();
    button("Chats").click(); // loads the real list from the server
    await sleep(400);
    const rows = root.querySelectorAll(".overlay .sess");
    const complete = [...rows].every((r) => r.querySelector('button[title="Rename chat"]') && r.querySelector('button[title="Delete chat"]') && r.querySelector(".t")?.textContent);
    check("chats: every row has a title, rename and delete (or the list says it is empty)", rows.length ? complete : root.querySelector(".overlay")?.textContent.includes("No saved chats"), `${rows.length} rows`);
    check("chats: no [object …]", !root.querySelector(".overlay").textContent.includes("[object"));
    [...root.querySelectorAll("button")].find((b) => b.textContent.includes("Close"))?.click();
  });

  await guard("keys", async () => {
    let leaked = 0;
    const spy = () => { leaked++; };
    document.addEventListener("keydown", spy);
    document.addEventListener("paste", spy);
    const input = root.querySelector("textarea");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, composed: true }));
    input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, composed: true }));
    document.removeEventListener("keydown", spy);
    document.removeEventListener("paste", spy);
    check("typing in the panel never reaches ComfyUI's shortcuts", leaked === 0, `${leaked} events leaked`);
    button("Pop out into a floating window")?.click();
    check("pop-out button calls back", floatToggles === 1);
  });

  await guard("floating", async () => {
    const was = isFloating();
    if (!was) openFloating({});
    await sleep(80);
    const frame = [...document.querySelectorAll("[data-sidekick-ui]")].find((f) => f !== box && f.style.position === "fixed" && f.style.resize === "both");
    check("floating window opens with a chat inside", [...(frame?.querySelectorAll("div") ?? [])].some((d) => d.shadowRoot?.querySelector(".sk")));
    const tiny = window.innerWidth < 400; // a hidden or collapsed browser pane reports 0x0: nothing can fit
    check("it stays inside the viewport", !!frame && frame.offsetLeft >= 0 && frame.offsetTop >= 0 && (tiny || frame.offsetLeft + frame.offsetWidth <= window.innerWidth + 1));
    if (!was) closeFloating();
    check("and closes again", was || !isFloating());
  });

  await guard("dom tools", async () => {
    const dlg = document.createElement("div");
    dlg.className = "p-dialog";
    dlg.setAttribute("role", "dialog");
    dlg.style.cssText = "position:fixed;left:20px;top:20px;width:320px;padding:8px;background:#222;z-index:99999";
    dlg.innerHTML = `<span class="p-dialog-title">Pane test dialog</span><p>Pick a <b>name</b> below.</p>
      <label for="pt-name">Name</label><input id="pt-name" value="old"><input type="password" aria-label="Secret" value="hunter2">
      <label><input type="checkbox" id="pt-check"> Enable thing</label>
      <select aria-label="Mode"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <button id="pt-ok">Apply</button><button disabled>Nope</button><div style="display:none"><button>Hidden</button></div>`;
    document.body.append(dlg);
    let clicks = 0, keys = [];
    dlg.querySelector("#pt-ok").addEventListener("click", () => { clicks++; });
    dlg.addEventListener("keydown", (e) => keys.push(`${e.ctrlKey ? "ctrl+" : ""}${e.key}:${e.keyCode}`));
    try {
      const snap = uiSnapshot({});
      check("snapshot: the dialog, its text and its controls", /^dialog "Pane test dialog":/.test(snap) && snap.includes("Pick a name below.") && /\[e\d+\] textbox "Name" value="old"/.test(snap) && /checkbox "Enable thing" unchecked/.test(snap), snap);
      check("snapshot: drop-down with options, disabled state, nothing hidden", /combobox "Mode" value="Alpha" options: Alpha \| Beta/.test(snap) && /button "Nope" disabled/.test(snap) && !snap.includes("Hidden"), snap);
      check("snapshot: password values never leave the page", snap.includes('"Secret" value=(hidden)') && !snap.includes("hunter2"), snap);
      check("snapshot: Sidekick's own UI is invisible to it", !uiSnapshot({ scope: "page" }).includes("Ask Sidekick"));
      check("snapshot: query narrows", uiSnapshot({ query: "apply" }).split("\n").filter((l) => l.includes("[e")).length === 1);
      await uiAct({ action: "type", text: "Name", value: "new name" });
      check("type: value set and the framework told", dlg.querySelector("#pt-name").value === "new name");
      await uiAct({ action: "click", text: "Enable thing" });
      check("click: checkbox toggled", dlg.querySelector("#pt-check").checked === true);
      await uiAct({ action: "select", text: "Mode", value: "beta" });
      check("select: option chosen by its text", dlg.querySelector("select").value === "b");
      const reply = await uiAct({ action: "click", text: "Apply" });
      check("click: button handler ran once, reply shows the screen with new refs", clicks === 1 && reply.startsWith('clicked button "Apply".') && /\[e\d+\]/.test(reply), reply.slice(0, 200));
      await uiAct({ action: "key", key: "ctrl+Enter", text: "Name" });
      check("key: modifiers and legacy keyCode are set", keys.includes("ctrl+Enter:13"), keys.join(","));
      for (const [label, args, needle] of [["disabled control", { action: "click", text: "Nope" }, "Nothing clickable"], ["password field", { action: "type", text: "Secret", value: "x" }, "password"],
        ["stale ref", { action: "click", ref: "e1" }, "no longer on screen"], ["bad key", { action: "key", key: "ctrl+banana" }, "Unknown key"]]) {
        let message = "";
        try { await uiAct(args); } catch (e) { message = e.message; }
        check(`refused: ${label}`, message.includes(needle), message);
      }
    } finally {
      dlg.remove();
    }
  });

  unmount();
  box.remove();
  client.showItemsForTest(keepItems);
  if (keepId && keepItems.length) client.loadSession(keepId);
  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed: failed.length, failures: failed, checks: results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}`) };
}
