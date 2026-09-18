"""HTTP calls to this same ComfyUI server (core + ComfyUI-Manager routes)."""
import aiohttp


def base_url():
    port, scheme = 8188, "http"
    try:
        from server import PromptServer
        port = getattr(PromptServer.instance, "port", None) or port
        from comfy.cli_args import args
        if getattr(args, "tls_keyfile", None):
            scheme = "https"
    except Exception:
        pass
    return f"{scheme}://127.0.0.1:{port}"


async def request(method, path, json_body=None, params=None, timeout=60):
    url = base_url() + path
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as http:
        # Always JSON: ComfyUI-Manager rejects simple-form content types (CSRF guard).
        async with http.request(method, url, json=json_body if json_body is not None else None,
                                params=params, ssl=False,
                                headers={"Content-Type": "application/json"}) as resp:
            text = await resp.text()
            return resp.status, text


async def get_json(path, params=None, timeout=60):
    import json
    status, text = await request("GET", path, params=params, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"GET {path} -> HTTP {status}")
    return json.loads(text)
