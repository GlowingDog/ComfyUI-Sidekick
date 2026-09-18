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


def register_all():
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
