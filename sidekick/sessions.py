"""Chat sessions. The server owns the chat state as a list of UI *items*; every
mutation is mirrored to browsers as a sequenced `sidekick.event`. A browser that
(re)mounts fetches the snapshot and applies only events with a higher seq."""
import json
import os
import re
import time
import uuid

from . import paths

EVENT = "sidekick.event"

_sessions = {}
_emit_hook = None  # tests replace this; default pushes over the ComfyUI websocket


def set_emit_hook(fn):
    global _emit_hook
    _emit_hook = fn


def _push(payload):
    if _emit_hook is not None:
        _emit_hook(payload)
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync(EVENT, payload)
    except Exception:
        pass


def _new_id():
    return uuid.uuid4().hex[:12]


def _without_pixels(msg):
    """Screenshots stay in memory for the running chat but are never written to
    disk: a few of them would turn every session file into megabytes."""
    content = msg.get("content")
    if not isinstance(content, list):
        return msg
    kept = [p for p in content if not (isinstance(p, dict) and p.get("type") == "image_url")]
    if len(kept) == len(content):
        return msg
    kept.append({"type": "text", "text": "[screenshot not kept in the saved history]"})
    return dict(msg, content=kept)


class Session:
    def __init__(self, sid=None, data=None):
        data = data or {}
        self.id = sid or data.get("id") or _new_id()
        self.title = data.get("title", "New chat")
        self.created = data.get("created", time.time())
        self.updated = data.get("updated", self.created)
        self.items = data.get("items", [])
        self.messages = data.get("messages", [])  # OpenAI-format transcript (API providers)
        self.cli = data.get("cli", {})  # {"claude_cli": session_id, "codex_cli": thread_id}
        self.continuation = data.get("continuation")  # set by restart_comfyui
        self.seq = data.get("seq", 0)
        # runtime only
        self.client_id = None
        self.task = None
        self.allowed_tools = set()  # "allow for session" grants
        self.provider_kind = None

    # ---- state ----
    @property
    def running(self):
        return self.task is not None and not self.task.done()

    def meta(self):
        return {"id": self.id, "title": self.title, "created": self.created,
                "updated": self.updated, "running": self.running}

    def snapshot(self):
        d = self.meta()
        d.update({"items": self.items, "seq": self.seq, "continuation": self.continuation})
        return d

    # ---- events ----
    def emit(self, etype, **data):
        self.seq += 1
        payload = {"session_id": self.id, "seq": self.seq, "type": etype}
        payload.update(data)
        _push(payload)

    def add_item(self, kind, **fields):
        item = {"id": _new_id(), "kind": kind, "ts": time.time()}
        item.update(fields)
        self.items.append(item)
        self.emit("item_add", item=item)
        return item

    def update_item(self, item, **patch):
        item.update(patch)
        self.emit("item_update", id=item["id"], patch=patch)

    def append_text(self, item, delta, field="text"):
        item[field] = item.get(field, "") + delta
        self.emit("text_delta", id=item["id"], field=field, delta=delta)

    def find_item(self, item_id):
        for it in self.items:
            if it["id"] == item_id:
                return it
        return None

    # ---- persistence ----
    def save(self):
        self.updated = time.time()
        data = {"id": self.id, "title": self.title, "created": self.created,
                "updated": self.updated, "items": self.items,
                "messages": [_without_pixels(m) for m in self.messages],
                "cli": self.cli, "continuation": self.continuation, "seq": self.seq}
        path = _path(self.id)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)


def _dir():
    return paths.sub_dir("sessions")


def _path(sid):
    if not re.fullmatch(r"[0-9a-f]{6,32}", sid or ""):
        raise ValueError("bad session id")
    return os.path.join(_dir(), sid + ".json")


def get(sid, create=False):
    if sid and sid in _sessions:
        return _sessions[sid]
    if sid:
        try:
            with open(_path(sid), "r", encoding="utf-8") as f:
                s = Session(data=json.load(f))
            # anything left "running"/"pending" by a crash or restart is dead now
            for it in s.items:
                if it.get("status") in ("running", "pending"):
                    it["status"] = "interrupted"
            _sessions[s.id] = s
            return s
        except (FileNotFoundError, ValueError):
            pass
    if not create:
        return None
    # The browser picks the id of a new chat so it can listen before the first event.
    s = Session(sid=sid if sid and re.fullmatch(r"[0-9a-f]{6,32}", sid) else None)
    _sessions[s.id] = s
    return s


def list_meta():
    out = {}
    for name in os.listdir(_dir()):
        if not name.endswith(".json"):
            continue
        sid = name[:-5]
        if sid in _sessions:
            continue
        try:
            with open(os.path.join(_dir(), name), "r", encoding="utf-8") as f:
                d = json.load(f)
            out[sid] = {"id": sid, "title": d.get("title", ""), "created": d.get("created", 0),
                        "updated": d.get("updated", 0), "running": False}
        except Exception:
            continue
    for sid, s in _sessions.items():
        if s.items:  # never list empty, unsaved chats
            out[sid] = s.meta()
    return sorted(out.values(), key=lambda m: m["updated"], reverse=True)


def delete(sid):
    s = _sessions.pop(sid, None)
    if s is not None and s.running:
        s.task.cancel()
    try:
        os.remove(_path(sid))
    except (FileNotFoundError, ValueError):
        pass
