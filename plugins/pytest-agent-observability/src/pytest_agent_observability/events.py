"""Serialize LiveKit RunResult events into the plain-dict form the server expects."""

from __future__ import annotations

import json
from typing import Any, Iterable, Optional


# Field caps (mirrors the server's payload-size guidance).
MAX_CONTENT_CHARS = 10_000
MAX_EVENTS_PER_CASE = 500


def serialize_events(run_events: Optional[Iterable[Any]]) -> list[dict]:
    """Turn RunEvent dataclass instances into JSON-ready dicts.

    Returns an empty list when `run_events` is None/empty. Unknown event types
    are skipped silently rather than raising — the plugin must not break tests.
    """
    if not run_events:
        return []
    out: list[dict] = []
    for ev in run_events:
        d = _serialize_event(ev)
        if d is None:
            continue
        out.append(d)
        if len(out) >= MAX_EVENTS_PER_CASE:
            break
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
        return _trim_content({
            "type": "message",
            "role": role,
            "content": content,
            "interrupted": bool(_attr(item, "interrupted", default=False)),
        })

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
        return _trim_output({
            "type": "function_call_output",
            "output": _attr(item, "output"),
            "is_error": bool(_attr(item, "is_error", default=False)),
            "call_id": _attr(item, "call_id"),
        })

    if ev_type == "agent_handoff":
        old_agent = _attr(ev, "old_agent")
        new_agent = _attr(ev, "new_agent")
        return {
            "type": "agent_handoff",
            "from_agent": _class_name(old_agent),
            "to_agent": _class_name(new_agent),
        }

    return None


def _attr(obj: Any, name: str, *, default: Any = None) -> Any:
    if obj is None:
        return default
    return getattr(obj, name, default)


def _class_name(obj: Any) -> Optional[str]:
    if obj is None:
        return None
    cls = getattr(obj, "__class__", None)
    return cls.__name__ if cls is not None else None


def _trim_content(d: dict) -> dict:
    c = d.get("content")
    if isinstance(c, str) and len(c) > MAX_CONTENT_CHARS:
        d["content"] = c[:MAX_CONTENT_CHARS] + "…"
    return d


def _trim_output(d: dict) -> dict:
    o = d.get("output")
    if isinstance(o, str) and len(o) > MAX_CONTENT_CHARS:
        d["output"] = o[:MAX_CONTENT_CHARS] + "…"
    return d
