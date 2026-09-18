"""One agent turn: user message in, streamed items out."""
import asyncio
import logging

from .. import config, pending
from . import cli_claude, loop_openai

log = logging.getLogger("sidekick")


async def _run_provider(session, client_id, text, provider, model, cfg):
    kind = provider.get("kind")
    if kind == "claude_cli":
        return await cli_claude.run(session, client_id, text, provider, model)
    if kind == "openai":
        return await loop_openai.run(session, client_id, text, provider, model, cfg)
    raise RuntimeError(f"Provider kind '{kind}' is not available yet.")


async def run_turn(session, client_id, text, provider_id, model):
    cfg = config.load()
    provider = config.get_provider(cfg, provider_id or cfg.get("default_provider"))
    usage = None
    session.client_id = client_id
    if not any(it["kind"] == "user" for it in session.items):
        session.title = " ".join(text.split())[:60] or "New chat"
    session.add_item("user", text=text)
    session.emit("turn_start", title=session.title)
    try:
        if provider is None:
            raise RuntimeError("No provider configured. Open Sidekick settings.")
        session.provider_kind = provider.get("kind")
        usage = await _run_provider(session, client_id, text, provider,
                                    model or provider.get("model") or None, cfg)
    except asyncio.CancelledError:
        session.add_item("notice", text="Stopped.")
    except Exception as e:
        log.exception("[Sidekick] turn failed")
        session.add_item("error", text=str(e) or type(e).__name__)
    finally:
        pending.cancel_session(session.id)
        session.task = None
        session.emit("turn_end", usage=usage)
        try:
            session.save()
        except Exception:
            log.exception("[Sidekick] could not save session")


def start_turn(session, client_id, text, provider_id, model):
    session.task = asyncio.get_running_loop().create_task(
        run_turn(session, client_id, text, provider_id, model))
    return session.task
