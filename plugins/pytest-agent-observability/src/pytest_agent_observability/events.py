"""Serialize LiveKit RunResult events into the plain-dict form the server expects.

No length or count caps — the dashboard needs the full trace. Unknown event
types are forwarded as-is (shape: `{"type": "<whatever>", ...passthrough}`) so
future LiveKit event kinds land in the UI without a plugin release.
"""

from __future__ import annotations

import dataclasses
import json
from typing import Any, Iterable, Optional


def serialize_events(run_events: Optional[Iterable[Any]]) -> list[dict]:
    """Turn RunEvent dataclass instances into JSON-ready dicts.

    Returns an empty list when `run_events` is None/empty. Never raises — the
    plugin must not break tests.
    """
    if not run_events:
        return []
    out: list[dict] = []
    for ev in run_events:
        try:
            d = _serialize_event(ev)
        except Exception:
            d = None
        if d is None:
            continue
        out.append(d)
    return out


def _serialize_event(ev: Any) -> Optional[dict]:
    ev_type = getattr(ev, "type", None)
    if ev_type == "message":
        item = getattr(ev, "item", None)
        role = _attr(item, "role")
        # LiveKit ChatMessage exposes text_content as a convenience property.
        content = _attr(item, "text_content")
        if content is None:
            content = _attr(item, "content")
            if isinstance(content, list):
                content = "".join(str(c) for c in content)
        return {
            "type": "message",
            "role": role,
            "content": content,
            "interrupted": bool(_attr(item, "interrupted", default=False)),
        }

    if ev_type == "function_call":
        item = getattr(ev, "item", None)
        raw_args = _attr(item, "arguments")
        args = raw_args
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args)
            except Exception:
                args = raw_args  # keep as string if not valid JSON
        return {
            "type": "function_call",
            "name": _attr(item, "name"),
            "arguments": args,
            "call_id": _attr(item, "call_id") or _attr(item, "id"),
        }

    if ev_type == "function_call_output":
        item = getattr(ev, "item", None)
        return {
            "type": "function_call_output",
            "output": _attr(item, "output"),
            "is_error": bool(_attr(item, "is_error", default=False)),
            "call_id": _attr(item, "call_id"),
        }

    if ev_type == "agent_handoff":
        old_agent = _attr(ev, "old_agent")
        new_agent = _attr(ev, "new_agent")
        return {
            "type": "agent_handoff",
            "from_agent": _class_name(old_agent),
            "to_agent": _class_name(new_agent),
        }

    # Unknown event type — pass the entire object through as a plain dict so
    # the dashboard still has something to render. Uses dataclass/vars/__dict__
    # to extract fields, falling back to str(ev).
    if ev_type is not None:
        return _to_plain_dict(ev)

    return None


def _to_plain_dict(ev: Any) -> dict:
    """Best-effort conversion of an unknown event object to a JSON-friendly dict."""
    if dataclasses.is_dataclass(ev) and not isinstance(ev, type):
        try:
            return dataclasses.asdict(ev)
        except Exception:
            pass
    if hasattr(ev, "model_dump"):  # pydantic v2
        try:
            return ev.model_dump()
        except Exception:
            pass
    if hasattr(ev, "__dict__"):
        try:
            return {k: v for k, v in vars(ev).items() if not k.startswith("_")}
        except Exception:
            pass
    return {"type": str(getattr(ev, "type", "unknown")), "repr": str(ev)}


def _attr(obj: Any, name: str, *, default: Any = None) -> Any:
    if obj is None:
        return default
    return getattr(obj, name, default)


def _class_name(obj: Any) -> Optional[str]:
    if obj is None:
        return None
    cls = getattr(obj, "__class__", None)
    return cls.__name__ if cls is not None else None
