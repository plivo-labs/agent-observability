"""The conversation-goal type shared across the SDK.

A :class:`Goal` is used both by the observability bootstrap
(:func:`agent_observability.livekit.init_observability`, which emits
``goal:`` tags the server judges post-session) and by the client-side
:func:`agent_observability.livekit.judges.goal_evaluation_judge`. One
type, one contract — there is no looser string/tuple/dict form.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Goal:
    """A conversation goal: a stable ``name`` plus a ``description`` of what
    the LLM judge should verify. Both are required.

    ``name`` is the goal's stable, filterable identity (it keys the
    "sessions where goal X was met" filter and is stored in
    ``session_external_evals.tag``). It must not contain a colon: the
    server splits ``goal:`` tags at the first colon after the prefix, so a
    colon in the name would corrupt the identity — put colons in the
    description instead.

    ``description`` is what the judge evaluates (stored in
    ``instructions``). Both fields are stripped and validated at
    construction, so a constructed ``Goal`` is always valid.
    """

    name: str
    description: str

    def __post_init__(self) -> None:
        name = self.name.strip()
        if not name:
            raise ValueError("goal name must be non-empty")
        if ":" in name:
            raise ValueError(
                f"goal name {name!r} must not contain a colon — "
                "the server splits goal tags at the first colon, so a colon in "
                "the name would corrupt the goal's identity. Put colons in the "
                "description instead."
            )
        description = self.description.strip()
        if not description:
            raise ValueError(
                f"goal {name!r} must have a non-empty description — it is what "
                "the judge evaluates."
            )
        # Frozen dataclass: write the stripped values back through the base.
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "description", description)
