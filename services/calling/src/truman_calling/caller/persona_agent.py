from __future__ import annotations

import logging

from livekit.agents import Agent

from truman_calling.core.persona_prompts import (
    NATURAL_CALLER_BEHAVIOR_PROMPT,
    NATURAL_OPENER_BEHAVIOR_PROMPT,
)

log = logging.getLogger("spike.persona")


def build_persona_instructions(persona_prompt: str) -> str:
    return f"{persona_prompt.strip()}\n\n{NATURAL_CALLER_BEHAVIOR_PROMPT}"


def build_opener_instructions(opener_instructions: str) -> str:
    return f"{opener_instructions.strip()}\n\n{NATURAL_OPENER_BEHAVIOR_PROMPT}"


class PersonaAgent(Agent):
    def __init__(
        self,
        *,
        persona_prompt: str,
        opener_instructions: str,
        stt,
        llm,
        tts,
    ) -> None:
        super().__init__(
            instructions=build_persona_instructions(persona_prompt),
            stt=stt,
            llm=llm,
            tts=tts,
        )
        self._opener_instructions = build_opener_instructions(opener_instructions)

    async def on_enter(self) -> None:
        log.info("persona on_enter — generating opener")
        await self.session.generate_reply(instructions=self._opener_instructions)
