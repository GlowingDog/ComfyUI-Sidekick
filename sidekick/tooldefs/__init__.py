from . import graph, misc

_done = False


def register_all():
    global _done
    if _done:
        return
    graph.register_all()
    misc.register_all()
    _done = True
