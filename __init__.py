"""ComfyUI-Sidekick: an AI agent chat panel that edits workflows live."""
import logging

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .sidekick import routes  # noqa: F401  (registers aiohttp routes at import)
except Exception:  # never break ComfyUI startup
    logging.getLogger("sidekick").exception("[Sidekick] failed to load")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
