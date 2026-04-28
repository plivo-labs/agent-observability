from __future__ import annotations

import pytest

from pipecat_evals import mock_tools
from pipecat_evals.tools import maybe_call


class FakeLLMService:
    def __init__(self):
        self._functions = {"existing": lambda *_args, **_kwargs: "kept"}

    def register_function(self, name, handler):
        self._functions[name] = handler


@pytest.mark.asyncio
async def test_mock_tools_registers_and_restores_handlers():
    service = FakeLLMService()
    original = dict(service._functions)

    with mock_tools(service, {
        "lookup_order": lambda args: {"id": args["id"]},
        "constant": {"ok": True},
    }):
        assert await maybe_call(service._functions["lookup_order"], {"id": "123"}) == {
            "id": "123",
        }
        assert await maybe_call(service._functions["constant"]) == {"ok": True}

    assert service._functions == original


def test_mock_tools_requires_register_function():
    with pytest.raises(TypeError):
        with mock_tools(object(), {"tool": "value"}):
            pass


def test_mock_tools_restores_multiple_registry_names_after_exception():
    class MultiRegistryService:
        def __init__(self):
            self._functions = {"original": "fn"}
            self._registered_functions = {"registered": "fn"}
            self._function_handlers = {"handler": "fn"}

        def register_function(self, name, handler):
            self._functions[name] = handler
            self._registered_functions[name] = handler
            self._function_handlers[name] = handler

    service = MultiRegistryService()
    originals = (
        dict(service._functions),
        dict(service._registered_functions),
        dict(service._function_handlers),
    )

    with pytest.raises(RuntimeError, match="boom"):
        with mock_tools(service, {"temporary": "value"}):
            assert "temporary" in service._functions
            assert "temporary" in service._registered_functions
            assert "temporary" in service._function_handlers
            raise RuntimeError("boom")

    assert service._functions == originals[0]
    assert service._registered_functions == originals[1]
    assert service._function_handlers == originals[2]
