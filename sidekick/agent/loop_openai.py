"""Agent loop for any OpenAI-compatible /chat/completions endpoint (OpenRouter,
DeepSeek, NanoGPT, local servers…). Raw aiohttp + SSE: no SDK dependency."""
import json

import aiohttp

from .. import registry
from . import prompt

MAX_ITERATIONS = 40
HISTORY_BUDGET_CHARS = 240_000
TRIMMED = "[older tool result trimmed to save context]"


class StreamAccumulator:
    """Folds streamed chat.completion chunks into one assistant message."""

    def __init__(self, on_text=None, on_reasoning=None):
        self.content = ""
        self.tool_calls = {}  # index -> {"id", "name", "arguments"}
        self.usage = None
        self.finish_reason = None
        self._on_text = on_text or (lambda s: None)
        self._on_reasoning = on_reasoning or (lambda s: None)

    def feed(self, chunk):
        if isinstance(chunk.get("error"), dict):
            raise RuntimeError(chunk["error"].get("message") or json.dumps(chunk["error"]))
        if chunk.get("usage"):
            self.usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            if choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]
            delta = choice.get("delta") or {}
            reasoning = delta.get("reasoning_content") or delta.get("reasoning")
            if isinstance(reasoning, str) and reasoning:
                self._on_reasoning(reasoning)
            text = delta.get("content")
            if isinstance(text, str) and text:
                self.content += text
                self._on_text(text)
            for pos, tc in enumerate(delta.get("tool_calls") or []):
                index = tc.get("index", pos)
                slot = self.tool_calls.setdefault(index, {"id": None, "name": "", "arguments": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"] if not slot["name"] else ""
                if isinstance(fn.get("arguments"), str):
                    slot["arguments"] += fn["arguments"]

    def message(self):
        msg = {"role": "assistant", "content": self.content or None}
        calls = []
        for index in sorted(self.tool_calls):
            tc = self.tool_calls[index]
            if not tc["name"]:
                continue
            calls.append({"id": tc["id"] or f"call_{index}", "type": "function",
                          "function": {"name": tc["name"], "arguments": tc["arguments"] or "{}"}})
        if calls:
            msg["tool_calls"] = calls
        return msg


KEEP_IMAGES = 2  # every request re-uploads the images still in history
IMAGE_GONE = "[earlier screenshot removed to save context; take a new one if you need it]"
NO_VISION_NOTE = ("\n(This model or provider did not accept images, so the screenshot was shown to the "
                  "user only. Work from get_workflow / get_node instead.)")
_no_vision = set()  # (base_url, model) pairs that rejected image input in this process


def has_images(msg):
    c = msg.get("content")
    return isinstance(c, list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in c)


def strip_old_images(messages, keep=KEEP_IMAGES):
    """In place: only the newest `keep` screenshot messages keep their pixels."""
    seen = 0
    for m in reversed(messages):
        if has_images(m):
            seen += 1
            if seen > keep:
                m["content"] = IMAGE_GONE


def image_message(images):
    parts = [{"type": "text", "text": "[Image(s) returned by the screenshot tool call above]"}]
    parts += [{"type": "image_url", "image_url": {"url": f"data:{i['mime']};base64,{i['data']}"}}
              for i in images]
    return {"role": "user", "content": parts}


def _text_len(content):
    if isinstance(content, list):  # multimodal: count the text parts only
        return sum(len(p.get("text") or "") for p in content if isinstance(p, dict))
    return len(content or "")


def trim_messages(messages, budget=HISTORY_BUDGET_CHARS):
    """Shrink the oldest tool results until the transcript fits. Message order
    and tool_call/tool pairing are never touched."""
    def size(m):
        return _text_len(m.get("content")) + len(json.dumps(m.get("tool_calls") or ""))
    total = sum(size(m) for m in messages)
    out = list(messages)
    for i, m in enumerate(out):
        if total <= budget:
            break
        if m.get("role") == "tool" and m.get("content") != TRIMMED:
            total -= len(m.get("content") or "") - len(TRIMMED)
            out[i] = dict(m, content=TRIMMED)
    return out


async def _stream(http, url, headers, body, acc):
    async with http.post(url, json=body, headers=headers) as resp:
        if resp.status != 200:
            detail = (await resp.text())[:600]
            raise ProviderHTTPError(resp.status, detail)
        async for raw in resp.content:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue  # comments / keep-alives (": OPENROUTER PROCESSING")
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                acc.feed(json.loads(data))
            except ValueError:
                continue


class ProviderHTTPError(RuntimeError):
    def __init__(self, status, detail):
        super().__init__(f"Provider returned HTTP {status}: {detail}")
        self.status = status


async def run(session, client_id, text, provider, model, cfg):
    base_url = str(provider.get("base_url") or "").rstrip("/")
    if not base_url:
        raise RuntimeError(f"Provider '{provider.get('name')}' has no base URL. Open Sidekick settings.")
    if not model:
        raise RuntimeError(f"Choose a model for '{provider.get('name')}' (Sidekick settings, or the "
                           "model box next to Send).")
    headers = {"Content-Type": "application/json", "X-Title": "ComfyUI-Sidekick"}
    if provider.get("api_key"):
        headers["Authorization"] = "Bearer " + provider["api_key"]
    url = base_url + "/chat/completions"
    ctx = registry.ToolContext(session, client_id, cfg)
    tools = registry.to_openai(registry.all_tools("openai", cfg))

    if not session.messages:
        text = prompt.history_preamble_before(session) + text  # chat started on another brain
    session.messages.append({"role": "user", "content": text})
    totals = {"input_tokens": 0, "output_tokens": 0}
    send_usage_option = True
    vision_key = (base_url, model)
    vision_pref = str(provider.get("vision") or "auto")  # auto: try, remember a rejection

    def can_see():
        return vision_pref != "off" and (vision_pref == "on" or vision_key not in _no_vision)

    timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=300)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        for _ in range(MAX_ITERATIONS):
            item = {"ref": None}

            def on_text(delta, field="text"):
                if item["ref"] is None:
                    item["ref"] = session.add_item("assistant", text="")
                session.append_text(item["ref"], delta, field)

            acc = StreamAccumulator(on_text, lambda d: on_text(d, "reasoning"))
            strip_old_images(session.messages)

            def make_body():
                body = {"model": model, "stream": True, "tools": tools,
                        "messages": [{"role": "system", "content": prompt.build()}] +
                        trim_messages(session.messages)}
                if send_usage_option:
                    body["stream_options"] = {"include_usage": True}
                return body
            try:
                await _stream(http, url, headers, make_body(), acc)
            except ProviderHTTPError as e:
                dropped_pixels = False
                if e.status == 400 and send_usage_option and "stream_options" in str(e):
                    send_usage_option = False
                elif e.status in (400, 404, 415, 422) and any(has_images(m) for m in session.messages):
                    # Probably a text-only model (e.g. DeepSeek): drop the pixels and try again.
                    dropped_pixels = True
                    for m in session.messages:
                        if has_images(m):
                            m["content"] = NO_VISION_NOTE.strip()
                else:
                    raise
                acc = StreamAccumulator(on_text, lambda d: on_text(d, "reasoning"))
                await _stream(http, url, headers, make_body(), acc)
                if dropped_pixels:  # the retry worked, so images really were the problem: remember
                    _no_vision.add(vision_key)
            if acc.usage:
                totals["input_tokens"] += acc.usage.get("prompt_tokens", 0) or 0
                totals["output_tokens"] += acc.usage.get("completion_tokens", 0) or 0
            msg = acc.message()
            session.messages.append(msg)
            if not msg.get("tool_calls"):
                return totals
            shots = []
            for call in msg["tool_calls"]:
                _, result, images = await registry.dispatch_full(ctx, call["function"]["name"],
                                                                 call["function"]["arguments"])
                if images and not can_see():
                    result += NO_VISION_NOTE
                    images = []
                shots += images
                session.messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
            if shots:
                # Tool messages are text-only in the chat-completions format, so pixels travel in
                # a user message right after the whole batch of tool results.
                session.messages.append(image_message(shots))
        session.add_item("notice", text=f"Paused after {MAX_ITERATIONS} steps. Say \"continue\" to go on.")
    return totals


async def list_models(provider):
    base_url = str(provider.get("base_url") or "").rstrip("/")
    headers = {"Authorization": "Bearer " + provider["api_key"]} if provider.get("api_key") else {}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as http:
        async with http.get(base_url + "/models", headers=headers) as resp:
            if resp.status != 200:
                raise ProviderHTTPError(resp.status, (await resp.text())[:300])
            data = await resp.json(content_type=None)
    rows = data.get("data") if isinstance(data, dict) else data
    return sorted({str(m.get("id")) for m in rows or [] if isinstance(m, dict) and m.get("id")})
