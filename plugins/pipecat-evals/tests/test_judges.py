from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from pipecat_evals import ChatMessage, JudgeResult, OpenAIJudge
from pipecat_evals.judges import _payload_to_judge_result


class FakeCompletions:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=self.content),
                )
            ],
        )


class FakeClient:
    def __init__(self, content: str) -> None:
        self.completions = FakeCompletions(content)
        self.chat = SimpleNamespace(completions=self.completions)


@pytest.mark.asyncio
async def test_openai_judge_returns_judge_result_and_sends_schema_prompt():
    client = FakeClient(json.dumps({
        "success": True,
        "reasoning": "The answer directly greets the user.",
        "score": 0.95,
    }))
    judge = OpenAIJudge(model="judge-model", client=client)

    result = await judge.evaluate(
        message=ChatMessage(role="assistant", text_content="Hello there"),
        intent="Greet the user warmly.",
    )

    assert result == JudgeResult(
        success=True,
        reasoning="The answer directly greets the user.",
        score=0.95,
        raw=client.completions.content,
    )
    call = client.completions.calls[0]
    assert call["model"] == "judge-model"
    assert call["temperature"] == 0.0
    assert call["response_format"]["type"] == "json_schema"
    assert "Greet the user warmly." in call["messages"][1]["content"]
    assert "Hello there" in call["messages"][1]["content"]


@pytest.mark.asyncio
async def test_openai_judge_invalid_json_fails_closed():
    judge = OpenAIJudge(client=FakeClient("not json"))

    result = await judge.evaluate(
        message=ChatMessage(role="assistant", text_content="Hello there"),
        intent="Greet the user.",
    )

    assert result.success is False
    assert "invalid JSON" in result.reasoning
    assert result.raw == "not json"


def test_payload_to_judge_result_supports_verdict_shape_and_missing_success():
    assert _payload_to_judge_result(
        {"verdict": "pass", "reason": "ok", "score": "1"},
        raw="raw",
    ) == JudgeResult(success=True, reasoning="ok", score=1.0, raw="raw")

    assert _payload_to_judge_result(
        {"success": "false", "reasoning": "no"},
        raw="raw",
    ) == JudgeResult(success=False, reasoning="no", raw="raw")

    missing = _payload_to_judge_result({"reasoning": "no verdict"}, raw="raw")
    assert missing.success is False
    assert missing.reasoning == "no verdict"
