"""Restart ComfyUI and pick the conversation up afterwards.

The tool only *books* the restart: the note is saved in the session, the model is told to
end its turn, and the restart happens when that turn is over — so the CLI brain's own
session file is complete and can be resumed. When the browser reconnects it calls
POST /sidekick/chat/resume, which turns the note into the next turn."""
import asyncio
import logging
import os
import sys
import time

from . import loopback

log = logging.getLogger("sidekick")

MAX_AGE = 30 * 60  # a note older than this is stale: the user has moved on
RESUME_TEXT = (
    "[Automatic message from Sidekick, not typed by the user] ComfyUI has restarted and is online again; "
    "node definitions were reloaded. Continue what you were doing: {note}\n"
    "First check that what you installed is really there (search_node_types / get_combo_options). If a newly "
    "installed node looks wrong or has no widgets, its JavaScript only loads with the page: ask the user to "
    "reload the browser tab (F5) and wait for them.")


def book(session, note, provider_id, model):
    session.continuation = {"note": " ".join(str(note or "").split())[:1500] or "tell the user the restart is done",
                            "provider": provider_id, "model": model, "ts": time.time()}
    session.restart_requested = True
    session.save()


def take_continuation(session):
    """Pop the note if there is a fresh one. Returns the dict or None."""
    c = session.continuation
    if not c:
        return None
    session.continuation = None
    try:
        session.save()
    except Exception:
        log.exception("[Sidekick] could not save session")
    return c if time.time() - float(c.get("ts") or 0) <= MAX_AGE else None


def _own_restart():
    """What ComfyUI-Manager does (legacy mode), for installs without the Manager."""
    if "__COMFY_CLI_SESSION__" in os.environ:  # started by comfy-cli: it relaunches when this marker appears
        with open(os.environ["__COMFY_CLI_SESSION__"] + ".reboot", "w"):
            pass
        os._exit(0)
    argv = [a for a in sys.argv if a != "--windows-standalone-build"]  # do not open a second browser tab
    if argv and argv[0].endswith("__main__.py"):
        cmds = [sys.executable, "-m", os.path.basename(os.path.dirname(argv[0]))] + argv[1:]
    elif sys.platform.startswith("win32"):
        cmds = ['"' + sys.executable + '"', '"' + argv[0] + '"'] + argv[1:]
    else:
        cmds = [sys.executable] + argv
    os.execv(sys.executable, cmds)


async def perform(stop_turns):
    """Stop what is running, then restart through the Manager (it knows the launcher) or on our own."""
    log.info("[Sidekick] restarting ComfyUI on request")
    try:
        await stop_turns()
    except Exception:
        log.exception("[Sidekick] could not stop running turns")
    try:
        status, _ = await loopback.request("POST", "/manager/reboot", json_body={}, timeout=15)
        if status not in (403, 404, 405):
            await asyncio.sleep(5)  # normally never reached: the process is replaced mid-request
    except Exception:
        await asyncio.sleep(3)  # the connection dying IS the restart
    _own_restart()
