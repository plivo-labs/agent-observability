"""Observer hooks used by integrations such as pytest-agent-observability."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


RunResultHook = Callable[[Any], None]
JudgmentHook = Callable[[str, Any], None]

_run_result_hooks: list[RunResultHook] = []
_judgment_hooks: list[JudgmentHook] = []


def register_run_result_hook(callback: RunResultHook) -> Callable[[], None]:
    _run_result_hooks.append(callback)

    def unregister() -> None:
        _remove_once(_run_result_hooks, callback)

    return unregister


def register_judgment_hook(callback: JudgmentHook) -> Callable[[], None]:
    _judgment_hooks.append(callback)

    def unregister() -> None:
        _remove_once(_judgment_hooks, callback)

    return unregister


def emit_run_result(result: Any) -> None:
    for callback in tuple(_run_result_hooks):
        callback(result)


def emit_judgment(intent: str, judgment: Any) -> None:
    for callback in tuple(_judgment_hooks):
        callback(intent, judgment)


def _remove_once(callbacks: list[Any], callback: Any) -> None:
    try:
        callbacks.remove(callback)
    except ValueError:
        pass
