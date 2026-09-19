"""One agent turn: user message in, streamed items out."""
import asyncio
import logging

from .. import config, pending, sessions
from ..backend import restart
from . import cli_claude, cli_codex, loop_openai

log = logging.getLogger("sidekick")


async def _run_provider(session, client_id, text, provider, model, cfg, effort=None):
    kind = provider.get("kind")
    if kind == "claude_cli":
        return await cli_claude.run(session, client_id, text, provider, model, effort)
    if kind == "codex_cli":
        return await cli_codex.run(session, client_id, text, provider, model, effort)
    if kind == "openai":
        return await loop_openai.run(session, client_id, text, provider, model, cfg, effort)
    raise RuntimeError(f"Provider kind '{kind}' is not available yet.")


def clean_effort(value):
    """A word such as low / medium / high / xhigh / max / ultra, or None. It ends up in a CLI
    argument and a request body, so nothing but a short lowercase word gets through."""
    word = str(value or "").strip().lower()
    return word if word.isalpha() and len(word) <= 12 and word != "default" else None


async def stop_all(grace=8.0):
    """Cancel every running turn (CLI subprocesses die with their turn) and wait for them."""
    tasks = [s.task for s in sessions.running() if s.task is not asyncio.current_task()]
    for t in tasks:
        t.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=grace)


async def run_turn(session, client_id, text, provider_id, model, shown=None, effort=None):
    """`shown`: what the chat displays instead of `text` (automatic messages such as the
    resume after a restart, which carry instructions the user does not need to read)."""
    cfg = config.load()
    provider = config.get_provider(cfg, provider_id or cfg.get("default_provider"))
    usage = None
    effort = clean_effort(effort)
    session.client_id = client_id
    session.provider_id, session.model, session.effort = provider_id, model, effort
    if not any(it["kind"] == "user" for it in session.items):
        session.title = " ".join(text.split())[:60] or "New chat"
    if shown:
        session.add_item("user", text=shown, auto=True)
    else:
        session.add_item("user", text=text)
    session.emit("turn_start", title=session.title)
    try:
        if provider is None:
            raise RuntimeError("No provider configured. Open Sidekick settings.")
        session.provider_kind = provider.get("kind")
        usage = await _run_provider(session, client_id, text, provider,
                                    model or provider.get("model") or None, cfg, effort)
    except asyncio.CancelledError:
        if session.restart_requested:  # the user pressed Stop: that cancels the booked restart too
            session.restart_requested, session.continuation = False, None
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
        if session.restart_requested:  # booked by restart_comfyui; the turn is over and saved: go
            session.restart_requested = False
            session.add_item("notice", text="Restarting ComfyUI… the chat continues by itself when it is back.")
            session.save()
            asyncio.get_running_loop().create_task(restart.perform(stop_all))


def start_turn(session, client_id, text, provider_id, model, shown=None, effort=None):
    session.task = asyncio.get_running_loop().create_task(
        run_turn(session, client_id, text, provider_id, model, shown, effort))
    return session.task
