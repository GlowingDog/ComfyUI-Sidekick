"""Blocking user interactions (ask_user questions, permission prompts).
An item is added to the chat; the coroutine waits until the browser POSTs
/sidekick/answer for its request_id, or the turn is stopped."""
import asyncio
import uuid

_waiting = {}  # request_id -> (session_id, future)


async def ask(session, kind, **fields):
    """kind: 'question' | 'permission'. Returns the answer payload."""
    request_id = uuid.uuid4().hex[:12]
    fut = asyncio.get_running_loop().create_future()
    _waiting[request_id] = (session.id, fut)
    item = session.add_item(kind, request_id=request_id, status="pending", **fields)
    session.save()
    try:
        answer = await fut
        session.update_item(item, status="answered", answer=answer)
        return answer
    except asyncio.CancelledError:
        session.update_item(item, status="interrupted")
        raise
    finally:
        _waiting.pop(request_id, None)


def answer(request_id, payload):
    entry = _waiting.get(request_id)
    if entry is None or entry[1].done():
        return False
    entry[1].set_result(payload)
    return True


def cancel_session(session_id):
    for rid, (sid, fut) in list(_waiting.items()):
        if sid == session_id and not fut.done():
            fut.cancel()
