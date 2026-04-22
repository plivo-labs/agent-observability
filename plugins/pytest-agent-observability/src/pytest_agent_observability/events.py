"""Serialize LiveKit RunResult events into the plain-dict form the server expects.

Philosophy: do the *minimum* transformation needed to make the event
JSON-serializable, and pass everything else through untouched. No field
hand-picking, no truncation, no silent drops of unknown event types.

The only transforms we apply:
 - Convert the event (and its nested `item`) from Pydantic / dataclass /
   arbitrary-object form into a plain dict. All fields are preserved,
   including `item.metrics`, timestamps, IDs, etc.
 - For `function_call`, parse `arguments` from JSON string → dict as a
   convenience (so the dashboard doesn't have to).
 - For `agent_handoff`, replace the `old_agent` / `new_agent` object
   references (which are full Agent instances — tools, context, not
   JSON-friendly) with their class names.
"""

from __future__ import annotations

import dataclasses
import json
from typing import Any, Iterable, Optional


def serialize_events(run_events: Optional[Iterable[Any]]) -> list[dict]:
    """Turn RunEvent instances into JSON-ready dicts.

    Never raises — the plugin must not break tests. Returns [] if
    `run_events` is None or empty.
    """
    if not run_events:
        return []
    out: list[dict] = []
    for ev in run_events:
        try:
            out.append(_serialize_event(ev))
        except Exception:
            # Last-resort: don't drop the event, just note we couldn't dump it.
            out.append({
                "type": str(getattr(ev, "type", "unknown")),
                "_serialize_error": True,
                "repr": str(ev),
            })
    return out


def _serialize_event(ev: Any) -> dict:
    """Convert an event to a plain JSON-friendly dict, preserving all fields."""
    ev_dict = _to_plain_dict(ev)
    ev_type = ev_dict.get("type") or getattr(ev, "type", None)

    # The event itself carries `item` for the known LiveKit types — ensure
    # the item is a plain dict too (not a Pydantic model reference).
    raw_item = getattr(ev, "item", None)
    if raw_item is not None:
        ev_dict["item"] = _to_plain_dict(raw_item)

    # Lift commonly-accessed fields from `item` to the top level so existing
    # consumers (dashboard timeline renderer) find them where they already
    # look — `role`, `content`, `name`, `arguments`, etc. — WITHOUT stripping
    # the nested `item` (which carries `metrics`, IDs, timestamps, …).
    item = ev_dict.get("item") or {}
    if ev_type == "message":
        content = item.get("text_content")
        if content is None:
            content = item.get("content")
            if isinstance(content, list):
                content = "".join(str(c) for c in content)
        ev_dict.setdefault("role", item.get("role"))
        ev_dict.setdefault("content", content)
        ev_dict.setdefault("interrupted", bool(item.get("interrupted", False)))
        # Propagate the metrics dict so the dashboard can render per-turn
        # latency (llm_node_ttft, started_speaking_at, …) without digging
        # into `item`.
        if "metrics" in item:
            ev_dict.setdefault("metrics", item.get("metrics"))

    elif ev_type == "function_call":
        raw_args = item.get("arguments")
        args = raw_args
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args)
            except Exception:
                args = raw_args
        ev_dict.setdefault("name", item.get("name"))
        ev_dict.setdefault("arguments", args)
        ev_dict.setdefault("call_id", item.get("call_id") or item.get("id"))

    elif ev_type == "function_call_output":
        ev_dict.setdefault("output", item.get("output"))
        ev_dict.setdefault("is_error", bool(item.get("is_error", False)))
        ev_dict.setdefault("call_id", item.get("call_id"))

    elif ev_type == "agent_handoff":
        # `old_agent` / `new_agent` are full Agent instances — replace them
        # with class names for JSON safety; keep the original keys around too
        # for reference but as strings.
        ev_dict["from_agent"] = _class_name(getattr(ev, "old_agent", None))
        ev_dict["to_agent"] = _class_name(getattr(ev, "new_agent", None))
        ev_dict.pop("old_agent", None)
        ev_dict.pop("new_agent", None)

    return ev_dict


def _to_plain_dict(obj: Any) -> dict:
    """Best-effort conversion of an arbitrary object to a plain dict.

    Tries Pydantic → dataclass → __dict__ → string fallback. Drops any
    private attributes (leading underscore) and callable attributes.
    """
    if isinstance(obj, dict):
        return dict(obj)
    if hasattr(obj, "model_dump"):  # pydantic v2
        try:
            return obj.model_dump()
        except Exception:
            pass
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        try:
            return dataclasses.asdict(obj)
        except Exception:
            pass
    if hasattr(obj, "__dict__"):
        try:
            return {
                k: v for k, v in vars(obj).items()
                if not k.startswith("_") and not callable(v)
            }
        except Exception:
            pass
    return {"repr": str(obj)}


def _class_name(obj: Any) -> Optional[str]:
    if obj is None:
        return None
    cls = getattr(obj, "__class__", None)
    return cls.__name__ if cls is not None else None
