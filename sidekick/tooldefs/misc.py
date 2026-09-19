"""Interaction tools."""
from .. import pending
from ..registry import Tool, ToolError, register


async def _ask_user(ctx, a):
    questions = a.get("questions")
    if not isinstance(questions, list) or not questions:
        raise ToolError("questions must be a non-empty array.")
    for q in questions:
        if not isinstance(q, dict) or not q.get("question") or not isinstance(q.get("options"), list):
            raise ToolError("Each question needs 'question' and an 'options' array.")
    answer = await pending.ask(ctx.session, "question", questions=questions[:4])
    return {"answers": (answer or {}).get("answers", {})}


STATUSES = ("pending", "in_progress", "done")


async def _todos(ctx, a):
    raw = a.get("todos")
    if not isinstance(raw, list) or not raw:
        raise ToolError("todos must be a non-empty array of {text, status}.")
    todos = []
    for t in raw[:30]:
        if isinstance(t, str):
            t = {"text": t}
        text = " ".join(str((t or {}).get("text") or "").split())[:200]
        status = str((t or {}).get("status") or "pending").lower().replace(" ", "_").replace("completed", "done")
        if not text:
            raise ToolError("Every todo needs text.")
        if status not in STATUSES:
            raise ToolError(f"status must be one of: {', '.join(STATUSES)}.")
        todos.append({"text": text, "status": status})
    # One card per turn: a plan is updated where it stands, a new request gets a new card.
    items = ctx.session.items
    last_user = max((i for i, it in enumerate(items) if it["kind"] == "user"), default=-1)
    card = next((it for it in reversed(items[last_user + 1:]) if it["kind"] == "todos"), None)
    if card is None:
        ctx.session.add_item("todos", todos=todos)
    else:
        ctx.session.update_item(card, todos=todos)
    done = sum(1 for t in todos if t["status"] == "done")
    doing = [t["text"] for t in todos if t["status"] == "in_progress"]
    return f"todo list shown to the user: {done}/{len(todos)} done" + (f"; in progress: {doing[0]}" if doing else "")


def register_all():
    register(Tool(
        "update_todos",
        "Show the user your plan as a checklist and keep it current. For work with three or more steps: send the "
        "WHOLE list every time (text + status pending / in_progress / done), mark a step in_progress when you start "
        "it and done as soon as it is finished. Not for one-step requests.",
        {"todos": {"type": "array", "minItems": 1, "maxItems": 30, "items": {
            "type": "object",
            "properties": {"text": {"type": "string"},
                           "status": {"type": "string", "enum": list(STATUSES)}},
            "required": ["text", "status"]}}},
        ["todos"], side="backend", handler=_todos, silent=True))
    register(Tool(
        "ask_user",
        "Ask the user 1-4 multiple-choice questions and wait for the answer. Use when a decision "
        "is genuinely theirs (style, which model, destructive choices); otherwise pick a sensible "
        "default. The user can always type a custom answer.",
        {"questions": {"type": "array", "minItems": 1, "maxItems": 4, "items": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "header": {"type": "string", "description": "Short label, max 12 chars."},
                "multi_select": {"type": "boolean"},
                "options": {"type": "array", "minItems": 2, "maxItems": 4, "items": {
                    "type": "object",
                    "properties": {"label": {"type": "string"}, "description": {"type": "string"}},
                    "required": ["label"]}}},
            "required": ["question", "options"]}}},
        ["questions"], side="backend", handler=_ask_user, silent=True, timeout=3600))
