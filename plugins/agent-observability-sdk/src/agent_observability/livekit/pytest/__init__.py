"""pytest plugin that uploads LiveKit-agents eval results to agent-observability."""

from __future__ import annotations

from .collector import capture

__version__ = "0.1.0"
__all__ = ["capture", "__version__"]
