"""Filesystem locations. Data lives in ComfyUI's protected system-user dir
(`user/__sidekick`), which the `/userdata` HTTP API cannot read."""
import os

_override = None


def set_data_dir(path):
    """Tests point this at a temp dir."""
    global _override
    _override = path


def data_dir():
    if _override:
        d = _override
    else:
        try:
            import folder_paths
            d = folder_paths.get_system_user_directory("sidekick")
        except Exception:
            d = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".data")
    os.makedirs(d, exist_ok=True)
    return d


def sub_dir(name):
    d = os.path.join(data_dir(), name)
    os.makedirs(d, exist_ok=True)
    return d
