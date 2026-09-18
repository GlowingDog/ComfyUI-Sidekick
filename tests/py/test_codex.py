"""Codex JSONL mapper + argv builder, replayed from recorded fixtures."""
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import paths, sessions  # noqa: E402
from sidekick.agent.cli_codex import CodexEventMapper, build_argv  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))
sessions.set_emit_hook(lambda payload: None)


def replay(name):
    s = sessions.Session()
    m = CodexEventMapper(s)
    with open(os.path.join(ROOT, "tests", "fixtures", name), encoding="utf-8") as f:
        for line in f:
            m.feed(line)
    return s, m


class CodexTests(unittest.TestCase):
    def test_successful_run(self):
        s, m = replay("codex_basic.jsonl")
        texts = [i["text"] for i in s.items if i["kind"] == "assistant"]
        self.assertEqual(texts[-1], "The cfg value is 8.")
        self.assertEqual(len(texts), 2)
        # sidekick MCP calls are drawn by registry.dispatch, never by the mapper
        self.assertFalse([i for i in s.items if i["kind"] == "tool"])
        self.assertTrue(s.cli["codex_cli"].startswith("01a0b6dc"))
        self.assertIsNone(m.failed)
        self.assertEqual(m.usage(), {"input_tokens": 58339, "output_tokens": 87})

    def test_denied_run_is_not_a_crash(self):
        s, m = replay("codex_mcp_denied.jsonl")
        self.assertIsNone(m.failed)  # the model explained the refusal itself
        self.assertIn("approval policy", s.items[-1]["text"])

    def test_top_level_error_is_unwrapped(self):
        m = CodexEventMapper(sessions.Session())
        m.feed('{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":'
               '{\\"message\\":\\"model not supported\\"}}"}')
        self.assertEqual(m.failed, "model not supported")

    def test_argv(self):
        argv = build_argv(["node", "codex.js"], "C:/ws", "http://127.0.0.1:8188/sidekick/mcp", "gpt-x", "tid")
        joined = " ".join(argv)
        self.assertEqual(argv[-3:], ["resume", "tid", "-"])
        self.assertIn('mcp_servers.sidekick.default_tools_approval_mode="approve"', joined)
        self.assertIn('mcp_servers.sidekick.bearer_token_env_var="SIDEKICK_MCP_TOKEN"', joined)
        self.assertEqual(argv[argv.index("-s") + 1], "read-only")
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", argv)
        self.assertNotIn("skip_host_skill_discovery", joined)  # under-development flag, no effect
        self.assertEqual(build_argv(["codex"], "w", "u")[-1], "-")


if __name__ == "__main__":
    unittest.main()
