"""Finding and running the claude / codex CLIs. No shell is ever involved:
argv is a list, prompts travel over stdin or files (cmd.exe quoting is unsafe)."""
import asyncio
import inspect
import os
import shutil
import subprocess
import sys
import threading

IS_WIN = sys.platform == "win32"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_NPM_TARGETS = {
    "claude": os.path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    "codex": os.path.join("node_modules", "@openai", "codex", "bin", "codex.js"),
}


def resolve(name, override=None):
    """Return the argv prefix that launches CLI `name`, or None if not found.
    npm installs `.cmd` shims on Windows; spawn what they point at instead."""
    path = override or shutil.which(name)
    if not path:
        return None
    if not IS_WIN or path.lower().endswith(".exe"):
        return [path]
    target = os.path.join(os.path.dirname(path), _NPM_TARGETS.get(name, ""))
    if os.path.isfile(target):
        if target.endswith(".js"):
            node = shutil.which("node")
            return [node, target] if node else None
        return [target]
    return ["cmd", "/c", path]  # unknown shim layout: last resort


def version(argv_prefix, timeout=15):
    try:
        out = subprocess.run(argv_prefix + ["--version"], capture_output=True, timeout=timeout,
                             creationflags=NO_WINDOW)
        return out.stdout.decode("utf-8", "replace").strip() or None
    except Exception:
        return None


def kill_tree(proc):
    if proc.poll() is not None:
        return
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, creationflags=NO_WINDOW)
        else:
            proc.kill()
    except Exception:
        pass


async def run_process(argv, cwd, env, stdin_text, on_line):
    """Run a CLI, feeding `stdin_text`, calling `on_line(str)` on the event
    loop for every stdout line. Returns (returncode, stderr_tail). Cancelling
    the awaiting task kills the whole process tree."""
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()
    err_tail = []

    def post(item):
        try:
            loop.call_soon_threadsafe(queue.put_nowait, item)
        except RuntimeError:
            pass  # loop closed (ComfyUI shutting down)

    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=cwd, env=env, creationflags=NO_WINDOW)

    def pump_out():
        for raw in proc.stdout:
            post(("line", raw.decode("utf-8", "replace").rstrip("\r\n")))
        proc.wait()
        post(("exit", proc.returncode))

    def pump_err():
        for raw in proc.stderr:
            err_tail.append(raw.decode("utf-8", "replace"))
            del err_tail[:-40]

    def feed():
        try:
            if stdin_text:
                proc.stdin.write(stdin_text.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass

    for fn in (pump_out, pump_err, feed):
        threading.Thread(target=fn, daemon=True).start()

    try:
        while True:
            kind, value = await queue.get()
            if kind == "exit":
                return value, "".join(err_tail)[-2000:]
            result = on_line(value)
            if inspect.isawaitable(result):
                await result
    finally:
        kill_tree(proc)
