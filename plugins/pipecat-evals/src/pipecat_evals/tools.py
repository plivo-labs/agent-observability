"""Tool mocking helpers for Pipecat evals."""

from __future__ import annotations

import contextlib
import inspect
from typing import Any, Callable, Iterator, Mapping, Union


@contextlib.contextmanager
def mock_tools(
    llm_service: Any,
    tools: Mapping[str, Union[Callable[..., Any], Any]],
) -> Iterator[None]:
    """Temporarily register deterministic Pipecat function handlers.

    The helper uses Pipecat's public ``register_function`` method when present
    and restores the service's function registry if the implementation exposes
    one under a common private name.
    """

    register = getattr(llm_service, "register_function", None)
    if not callable(register):
        raise TypeError("llm_service must expose register_function(name, handler)")

    snapshots = _snapshot_function_registries(llm_service)
    try:
        for name, value in tools.items():
            register(name, _as_handler(value))
        yield
    finally:
        _restore_function_registries(llm_service, snapshots)


def _as_handler(value: Union[Callable[..., Any], Any]) -> Callable[..., Any]:
    if callable(value):
        return value

    async def _handler(*_args: Any, **_kwargs: Any) -> Any:
        return value

    return _handler


def _snapshot_function_registries(llm_service: Any) -> dict[str, Any]:
    snapshots: dict[str, Any] = {}
    for attr in ("_functions", "_registered_functions", "_function_handlers"):
        registry = getattr(llm_service, attr, None)
        if registry is None:
            continue
        if hasattr(registry, "copy"):
            snapshots[attr] = registry.copy()
        else:
            snapshots[attr] = registry
    return snapshots


def _restore_function_registries(llm_service: Any, snapshots: dict[str, Any]) -> None:
    for attr, snapshot in snapshots.items():
        registry = getattr(llm_service, attr, None)
        if isinstance(registry, dict):
            registry.clear()
            registry.update(snapshot)
        else:
            setattr(llm_service, attr, snapshot)


async def maybe_call(handler: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    value = handler(*args, **kwargs)
    if inspect.isawaitable(value):
        return await value
    return value
