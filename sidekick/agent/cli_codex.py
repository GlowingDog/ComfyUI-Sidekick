"""Codex CLI as the brain (headless `codex exec --json`). Verified against
codex-cli 0.155.0 — see tests/fixtures/codex_basic.jsonl."""
import json
import os

from .. import mcp_server, paths
from ..backend import loopback
from . import cli_common, prompt

TOKEN_ENV = "SIDEKICK_MCP_TOKEN"


class CodexEventMapper:
    """JSONL events -> chat items. Sidekick's own MCP calls are drawn by
    registry.dispatch; only Codex-native activity (web search) gets a card here."""

    def __init__(self, session):
        self.session = session
        self.usage_raw = None
        self.failed = None
        self.events = 0
        self.native = {}  # item id -> chat item

    def feed(self, line):
        line = line.strip()
        if not line.startswith("{"):
            return
        try:
            ev = json.loads(line)
        except ValueError:
            return
        self.events += 1
        etype = ev.get("type")
        if etype == "thread.started" and ev.get("thread_id"):
            self.session.cli["codex_cli"] = ev["thread_id"]
        elif etype == "turn.completed":
            self.usage_raw = ev.get("usage") or {}
        elif etype in ("error", "turn.failed"):
            msg = ev.get("message") or (ev.get("error") or {}).get("message") or "Codex reported an error."
            self.failed = _short_error(msg)
        elif etype in ("item.started", "item.updated", "item.completed"):
            self._item(etype, ev.get("item") or {})

    def _item(self, etype, item):
        kind = item.get("type")
        done = etype == "item.completed"
        if kind == "agent_message" and done and item.get("text"):
            self.session.add_item("assistant", text=item["text"].strip())
        elif kind == "reasoning" and done and item.get("text"):
            self.session.add_item("assistant", text="", reasoning=item["text"].strip())
        elif kind == "web_search":
            card = self.native.get(item.get("id"))
            if card is None:
                card = self.session.add_item("tool", name="web_search", status="running",
                                             args={"query": item.get("query", "")})
                self.native[item.get("id")] = card
            if done:
                self.session.update_item(card, status="ok", args={"query": item.get("query", "")})
        elif kind == "mcp_tool_call" and done and item.get("server") != "sidekick":
            self.session.add_item("tool", name=f"{item.get('server')}.{item.get('tool')}",
                                  args=item.get("arguments") or {},
                                  status="error" if item.get("error") else "ok")
        # 'error' items are Codex housekeeping warnings (skills budget…): ignored.

    def usage(self):
        u = self.usage_raw or {}
        return {"input_tokens": u.get("input_tokens", 0), "output_tokens": u.get("output_tokens", 0)}


def _short_error(msg):
    try:  # API errors arrive as a JSON string inside the message
        inner = json.loads(msg)
        msg = (inner.get("error") or {}).get("message") or msg
    except (ValueError, AttributeError):
        pass
    return str(msg)[:600]


def _toml(value):
    return json.dumps(value)  # JSON strings/numbers are valid TOML values


def build_argv(prefix, workspace, mcp_url, model=None, resume=None, web_search=True):
    argv = list(prefix) + [
        "exec", "--json", "--skip-git-repo-check",
        "--ignore-user-config",  # keeps the login, drops the user's own MCP servers/profiles
        "-C", workspace, "-s", "read-only",
        "-c", "mcp_servers.sidekick.url=" + _toml(mcp_url),
        "-c", "mcp_servers.sidekick.bearer_token_env_var=" + _toml(TOKEN_ENV),
        "-c", "mcp_servers.sidekick.tool_timeout_sec=3600",
        # exec mode never prompts, so without this every MCP call is refused
        "-c", "mcp_servers.sidekick.default_tools_approval_mode=" + _toml("approve"),
        "-c", "developer_instructions=" + _toml(prompt.build()),
    ]
    if web_search:
        argv += ["-c", "web_search=" + _toml("live")]
    if model:
        argv += ["-m", model]
    if resume:
        argv += ["resume", resume]
    return argv + ["-"]  # prompt comes from stdin


async def run(session, client_id, text, provider, model):
    prefix = cli_common.resolve("codex", provider.get("cli_path"))
    if not prefix:
        raise RuntimeError("Codex CLI not found. Install it (npm i -g @openai/codex), run `codex` "
                           "once to log in, then restart ComfyUI.")
    workspace = paths.sub_dir("cli_workspace")
    token = mcp_server.issue_token({"session": session, "client_id": client_id,
                                    "provider_kind": "codex_cli"})
    env = dict(os.environ, **{TOKEN_ENV: token})
    mcp_url = loopback.base_url() + "/sidekick/mcp"
    try:
        resume = session.cli.get("codex_cli")
        stdin_text = text if resume else prompt.history_preamble_before(session) + text
        mapper = CodexEventMapper(session)
        code, err = await cli_common.run_process(
            build_argv(prefix, workspace, mcp_url, model, resume), workspace, env, stdin_text,
            mapper.feed)
        if resume and mapper.usage_raw is None and (code != 0 or mapper.failed):
            # Thread no longer exists for this login: start a new one with the chat replayed.
            session.cli.pop("codex_cli", None)
            mapper = CodexEventMapper(session)
            code, err = await cli_common.run_process(
                build_argv(prefix, workspace, mcp_url, model, None), workspace, env,
                prompt.history_preamble_before(session) + text, mapper.feed)
        if mapper.failed:
            raise RuntimeError(mapper.failed)
        if code != 0 and mapper.usage_raw is None:
            raise RuntimeError(f"codex exited with code {code}. {err.strip()[-600:]}")
        return mapper.usage()
    finally:
        mcp_server.revoke_token(token)
