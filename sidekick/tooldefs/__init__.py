from . import graph, misc, ui

_done = False


def register_all():
    global _done
    if _done:
        return
    graph.register_all()
    ui.register_all()
    misc.register_all()
    _done = True
