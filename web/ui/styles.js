// Stylesheet for the Shadow DOM root. ComfyUI theme variables inherit through the
// shadow boundary, so the panel follows the active theme; nothing leaks in or out.
export const CSS = `
:host { all: initial; display: block; height: 100%; }
* { box-sizing: border-box; }
.sk {
  --bg: var(--comfy-menu-bg, #202020); --bg2: var(--comfy-input-bg, #2a2a2a);
  --fg: var(--input-text, #ddd); --dim: var(--descrip-text, #999); --line: var(--border-color, #4e4e4e);
  --accent: var(--p-primary-color, #64b5f6); --ok: #6cc070; --err: #e5676b; --warn: #e0b050;
  display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); color: var(--fg);
  font: 13px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
}
button, select, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--bg2); border-radius: 6px; padding: 4px 10px; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #111; font-weight: 600; }
button.ghost { border-color: transparent; background: transparent; padding: 4px 6px; }
select, input, textarea { background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; min-width: 0; }
select:focus, input:focus, textarea:focus, button:focus-visible { outline: 1px solid var(--accent); outline-offset: 0; }

.head { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.head .title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.banner { padding: 6px 10px; font-size: 12px; color: #111; background: var(--warn); border-bottom: 1px solid var(--line); }
.banner[hidden] { display: none; }
.body { flex: 1; min-height: 0; position: relative; }
.list { position: absolute; inset: 0; overflow-y: auto; padding: 12px 10px; display: flex; flex-direction: column; gap: 10px; }
.empty { margin: auto; text-align: center; color: var(--dim); max-width: 260px; }
.empty b { color: var(--fg); display: block; font-size: 15px; margin-bottom: 4px; }

.user { align-self: flex-end; max-width: 88%; background: var(--bg2); border: 1px solid var(--line); border-radius: 10px 10px 2px 10px; padding: 6px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.assistant { overflow-wrap: anywhere; }
.assistant p { margin: 0 0 8px; } .assistant p:last-child { margin-bottom: 0; }
.assistant ul, .assistant ol { margin: 0 0 8px; padding-left: 20px; }
.assistant h3, .assistant h4, .assistant h5, .assistant h6 { margin: 10px 0 4px; font-size: 13px; }
.assistant h3 { font-size: 15px; } .assistant h4 { font-size: 14px; }
.assistant a { color: var(--accent); }
code { font: 12px/1.4 ui-monospace, Consolas, monospace; background: var(--bg2); border-radius: 4px; padding: 1px 4px; }
pre { background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow-x: auto; margin: 0 0 8px; }
pre code { background: none; padding: 0; }
.reasoning { color: var(--dim); font-style: italic; border-left: 2px solid var(--line); padding-left: 8px; margin-bottom: 6px; white-space: pre-wrap; }

.card { border: 1px solid var(--line); border-radius: 8px; background: var(--bg2); }
.tool > summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; color: var(--dim); }
.tool > summary::-webkit-details-marker { display: none; }
.tool .name { color: var(--fg); font: 12px ui-monospace, Consolas, monospace; }
.tool .hint { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.tool .detail { border-top: 1px solid var(--line); padding: 6px 8px; font: 12px/1.4 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow-y: auto; color: var(--dim); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
.dot.running { background: var(--warn); animation: pulse 1s infinite; } .dot.ok { background: var(--ok); }
.dot.error, .dot.denied { background: var(--err); } .dot.interrupted { background: var(--dim); }
@keyframes pulse { 50% { opacity: .35; } }

.ask { padding: 10px; display: flex; flex-direction: column; gap: 10px; border-color: var(--accent); }
.ask .q { display: flex; flex-direction: column; gap: 6px; }
.ask .chip { align-self: flex-start; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); }
.ask .question { font-weight: 600; }
.ask .opt { text-align: left; display: flex; flex-direction: column; padding: 6px 10px; background: var(--bg); }
.ask .opt small { color: var(--dim); }
.ask .opt.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.ask .row { display: flex; gap: 6px; flex-wrap: wrap; }
.ask .row input { flex: 1; }
.ask.done { border-color: var(--line); color: var(--dim); }
.ask pre { margin: 0; max-height: 160px; }

.error { color: var(--err); border: 1px solid var(--err); border-radius: 8px; padding: 6px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.notice { color: var(--dim); text-align: center; font-size: 12px; }

.composer { border-top: 1px solid var(--line); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.composer textarea { width: 100%; resize: none; min-height: 54px; max-height: 200px; }
.composer .row { display: flex; gap: 6px; align-items: center; }
.composer .row select { flex: 1 1 110px; } .composer .row input { flex: 2 1 90px; }
.usage { color: var(--dim); font-size: 11px; }

.overlay { position: absolute; inset: 0; background: var(--bg); overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; z-index: 2; }
.overlay h4 { margin: 6px 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
.overlay label { display: flex; flex-direction: column; gap: 3px; }
.overlay label.check { flex-direction: row; align-items: center; gap: 6px; }
.overlay .hint { color: var(--dim); font-size: 12px; }
.sess { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.sess:hover, .sess.cur { border-color: var(--accent); }
.sess .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .d { color: var(--dim); font-size: 11px; }
`;
