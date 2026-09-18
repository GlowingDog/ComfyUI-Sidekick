"""Claude Code CLI as the brain (headless `claude -p`, stream-json output).
Verified against claude 2.1.274 — see tests/fixtures/claude_basic.jsonl."""
import json
import os

from .. import mcp_server, paths
from ..backend import loopback
from . import cli_common, prompt

MCP_PREFIX = "mcp__sidekick__"
NATIVE_TOOLS = "WebSearch,WebFetch"


class ClaudeEventMapper:
    """Turns stream-json lines into chat items. Sidekick's own tool calls are
    drawn by registry.dispatch, so only native tools (web) get cards here."""

    def __init__(self, session):
        self.session = session
        self.current = None  # assistant item receiving text deltas
        self.saw_stream = False
        self.native_tools = {}  # tool_use id -> item
        self.result = None
        self.events = 0

    def feed(self, line):
        line = line.strip()
        if not line.startswith("{"):
            return
        try:
            ev = json.loads(line)
        except ValueError:
            return
        self.events += 1
        handler = getattr(self, "_on_" + str(ev.get("type")), None)
        if handler:
            handler(ev)

    def _text(self, delta, field="text"):
        if not delta:
            return
        if self.current is None:
            self.current = self.session.add_item("assistant", text="")
        self.session.append_text(self.current, delta, field)

    def _on_system(self, ev):
        if ev.get("subtype") != "init":
            return
        if ev.get("session_id"):
            self.session.cli["claude_cli"] = ev["session_id"]
        for srv in ev.get("mcp_servers") or []:
            if srv.get("name") == "sidekick" and srv.get("status") != "connected":
                self.session.add_item("error", text="Claude could not connect to the Sidekick tools "
                                      f"(MCP status: {srv.get('status')}).")

    def _on_stream_event(self, ev):
        self.saw_stream = True
        e = ev.get("event") or {}
        etype = e.get("type")
        if etype == "message_start":
            self.current = None
        elif etype == "content_block_delta":
            delta = e.get("delta") or {}
            if delta.get("type") == "text_delta":
                self._text(delta.get("text"))
            elif delta.get("type") == "thinking_delta":
                self._text(delta.get("thinking"), "reasoning")

    def _on_assistant(self, ev):
        for block in (ev.get("message") or {}).get("content") or []:
            btype = block.get("type")
            if btype == "text" and not self.saw_stream:
                self.current = None
                self._text(block.get("text"))
            elif btype == "tool_use" and not str(block.get("name", "")).startswith(MCP_PREFIX):
                self.native_tools[block.get("id")] = self.session.add_item(
                    "tool", name=block.get("name"), args=block.get("input") or {}, status="running")
                self.current = None

    def _on_user(self, ev):
        content = (ev.get("message") or {}).get("content")
        if not isinstance(content, list):
            return
        for block in content:
            item = self.native_tools.pop(block.get("tool_use_id"), None)
            if block.get("type") != "tool_result" or item is None:
                continue
            body = block.get("content")
            if isinstance(body, list):
                body = "\n".join(str(b.get("text", "")) for b in body if isinstance(b, dict))
            self.session.update_item(item, status="error" if block.get("is_error") else "ok",
                                     summary=str(body or "")[:400])

    def _on_result(self, ev):
        self.result = ev
        if ev.get("is_error"):
            self.session.add_item("error", text=str(ev.get("result") or ev.get("subtype") or
                                                    "Claude reported an error."))

    def usage(self):
        r = self.result or {}
        u = r.get("usage") or {}
        return {"input_tokens": (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) +
                                 u.get("cache_creation_input_tokens", 0)),
                "output_tokens": u.get("output_tokens", 0),
                "cost_usd": r.get("total_cost_usd"), "turns": r.get("num_turns")}


def build_argv(prefix, mcp_config_path, system_prompt_path, model=None, resume=None):
    argv = list(prefix) + [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--mcp-config", mcp_config_path, "--strict-mcp-config",
        "--tools", NATIVE_TOOLS,
        "--allowedTools", "mcp__sidekick," + NATIVE_TOOLS,
        "--permission-prompts", "none",
        "--system-prompt-file", system_prompt_path,
        # Project-only settings: keeps the user's OAuth login but not their
        # global hooks/plugins, which would hijack the agent's behaviour.
        "--setting-sources", "project",
    ]
    if model:
        argv += ["--model", model]
    if resume:
        argv += ["--resume", resume]
    return argv


async def run(session, client_id, text, provider, model):
    prefix = cli_common.resolve("claude", provider.get("cli_path"))
    if not prefix:
        raise RuntimeError("Claude CLI not found. Install it (npm i -g @anthropic-ai/claude-code), "
                           "run `claude` once to log in, then restart ComfyUI.")
    workspace = paths.sub_dir("cli_workspace")
    tmp = paths.sub_dir("tmp")
    token = mcp_server.issue_token({"session": session, "client_id": client_id,
                                    "provider_kind": "claude_cli"})
    mcp_path = os.path.join(tmp, f"mcp_{session.id}.json")
    sys_path = os.path.join(tmp, "system_prompt.txt")
    try:
        with open(mcp_path, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {"sidekick": {
                "type": "http", "url": loopback.base_url() + "/sidekick/mcp",
                "headers": {"Authorization": "Bearer " + token}}}}, f)
        with open(sys_path, "w", encoding="utf-8") as f:
            f.write(prompt.build())
        env = dict(os.environ, MCP_TOOL_TIMEOUT="3600000", MCP_TIMEOUT="30000")

        resume = session.cli.get("claude_cli")
        stdin_text = text if resume else prompt.history_preamble_before(session) + text
        mapper = ClaudeEventMapper(session)
        code, err = await cli_common.run_process(
            build_argv(prefix, mcp_path, sys_path, model, resume), workspace, env, stdin_text,
            mapper.feed)
        if code != 0 and resume and mapper.result is None:
            # The CLI lost this conversation (history cleared, other machine): start fresh.
            session.cli.pop("claude_cli", None)
            mapper = ClaudeEventMapper(session)
            code, err = await cli_common.run_process(
                build_argv(prefix, mcp_path, sys_path, model, None), workspace, env,
                prompt.history_preamble_before(session) + text, mapper.feed)
        if code != 0 and mapper.result is None:
            raise RuntimeError(f"claude exited with code {code}. {err.strip()[-600:]}")
        return mapper.usage()
    finally:
        mcp_server.revoke_token(token)
        try:
            os.remove(mcp_path)
        except OSError:
            pass
