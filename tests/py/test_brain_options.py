"""Model and effort pickers: what each brain offers, and how the choice reaches it."""
import asyncio
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from sidekick import paths  # noqa: E402

paths.set_data_dir(tempfile.mkdtemp(prefix="sidekick_test_"))

from sidekick.agent import brain_options, cli_claude, cli_codex, loop_openai, runner  # noqa: E402

CLAUDE_HELP = """Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session (not, this one)
  --model <model>                       Model for the current session."""

CODEX_CACHE = {"fetched_at": "2026-09-18T23:32:14Z", "models": [
    {"slug": "gpt-5.5", "display_name": "GPT-5.5", "priority": 12, "visibility": "list", "default_reasoning_level": "medium",
     "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}]},
    {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "priority": 3, "visibility": "hide", "supported_reasoning_levels": ["low"]},
    {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "priority": 1, "visibility": "list", "default_reasoning_level": "medium",
     "supported_reasoning_levels": ["low", "medium", "high", "xhigh", "max", "ultra"]},
    "garbage", {"display_name": "no slug"}]}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class OptionTests(unittest.TestCase):
    def test_claude_effort_levels_come_from_its_help_text(self):
        self.assertEqual(brain_options.parse_claude_efforts(CLAUDE_HELP), ["low", "medium", "high", "xhigh", "max"])
        self.assertIsNone(brain_options.parse_claude_efforts("no such flag (a, b)"))
        self.assertIsNone(brain_options.parse_claude_efforts(""))

    def test_codex_models_come_from_its_own_cache(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "models_cache.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(CODEX_CACHE, f)
            models = brain_options.codex_models(path)
        self.assertEqual([m["id"] for m in models], ["gpt-6-astra", "gpt-5.5"], "hidden ones dropped, best first")
        self.assertEqual(models[0], {"id": "gpt-6-astra", "label": "GPT-6-Astra", "default_effort": "medium",
                                     "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"]})
        self.assertEqual(models[1]["efforts"], ["low", "medium", "high", "xhigh"], "each model has its own levels")
        self.assertEqual(brain_options.codex_models(os.path.join(tempfile.gettempdir(), "nope", "x.json")), [])

    def test_options_per_brain(self):
        async def go():
            real_help, real_list, real_codex = brain_options._claude_help, loop_openai.list_models, brain_options.codex_models
            brain_options._claude_help = lambda provider: CLAUDE_HELP
            brain_options.codex_models = lambda path=None: []
            calls = []

            async def fake_list(provider):
                calls.append(provider["id"])
                if not provider.get("api_key"):
                    raise RuntimeError("Provider returned HTTP 401: no key")
                return ["deepseek-chat", "deepseek-reasoner"]
            loop_openai.list_models = fake_list
            brain_options._cache.clear()
            try:
                claude = await brain_options.options({"id": "claude_cli", "kind": "claude_cli"})
                self.assertEqual([m["id"] for m in claude["models"]], ["fable", "opus", "sonnet", "haiku"])
                self.assertEqual(claude["efforts"], ["low", "medium", "high", "xhigh", "max"])
                codex = await brain_options.options({"id": "codex_cli", "kind": "codex_cli"})
                self.assertEqual(codex["models"], [])
                self.assertIn("Run the Codex CLI once", codex["note"])
                keyless = {"id": "deepseek", "kind": "openai", "base_url": "https://x/v1", "model": "deepseek-chat"}
                first = await brain_options.options(keyless)
                self.assertEqual(first["models"], [{"id": "deepseek-chat", "label": "deepseek-chat"}], "the configured model is still offered")
                self.assertIn("Could not list models", first["note"])
                await brain_options.options(keyless)
                self.assertEqual(calls, ["deepseek", "deepseek"], "a failure is not cached: a key may arrive any moment")
                keyed = dict(keyless, api_key="sk-1", model="my-finetune")
                ok = await brain_options.options(keyed)
                self.assertEqual([m["id"] for m in ok["models"]], ["my-finetune", "deepseek-chat", "deepseek-reasoner"])
                self.assertEqual(ok["efforts"], ["low", "medium", "high"])
                await brain_options.options(keyed)
                self.assertEqual(len(calls), 3, "a good list is cached")
                await brain_options.options(keyed, refresh=True)
                self.assertEqual(len(calls), 4)
            finally:
                brain_options._claude_help, loop_openai.list_models, brain_options.codex_models = real_help, real_list, real_codex
        run(go())


class PlumbingTests(unittest.TestCase):
    def test_effort_reaches_both_clis_as_arguments(self):
        claude = cli_claude.build_argv(["claude"], "mcp.json", "sys.txt", "opus", "sess-1", "xhigh")
        self.assertEqual(claude[claude.index("--effort") + 1], "xhigh")
        self.assertLess(claude.index("--effort"), claude.index("--resume"))
        self.assertNotIn("--effort", cli_claude.build_argv(["claude"], "mcp.json", "sys.txt", "opus"))
        codex = cli_codex.build_argv(["codex"], "ws", "http://127.0.0.1:8188/sidekick/mcp", "gpt-6-astra", "thread-1", effort="ultra")
        self.assertIn('model_reasoning_effort="ultra"', codex)
        self.assertLess(codex.index('model_reasoning_effort="ultra"'), codex.index("resume"), "options go before `resume`")
        self.assertFalse(any("model_reasoning_effort" in a for a in cli_codex.build_argv(["codex"], "ws", "u", "m")))

    def test_only_a_plain_word_gets_through(self):
        for good in ("low", "Medium", " xhigh ", "ultra"):
            self.assertEqual(runner.clean_effort(good), good.strip().lower())
        for bad in (None, "", "default", "high; rm -rf", "--dangerously-skip-permissions", "a" * 40, 'x"y', "hi gh", 3):
            self.assertIsNone(runner.clean_effort(bad), bad)


if __name__ == "__main__":
    unittest.main()
