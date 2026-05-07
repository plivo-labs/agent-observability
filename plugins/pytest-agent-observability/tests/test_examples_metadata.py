from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


_PIPECAT_EXAMPLES = (
    "pipecat_agent.py",
    "pipecat_banking_agent.py",
    "pipecat_generated_agent.py",
)


def test_pipecat_examples_use_in_tree_observability_plugin():
    """Pipecat examples must use the local plugin while this branch is tested."""

    for filename in _PIPECAT_EXAMPLES:
        text = (ROOT / "examples" / "pytest" / filename).read_text()
        assert (
            '# pytest-agent-observability = { path = "../../pytest-agent-observability"'
            in text
        ), filename
        assert (
            '# pipecat-evals = { path = "../../pipecat-evals"'
            in text
        ), filename
        assert "editable = true" in text, filename
        assert (
            '# # pytest-agent-observability = { path = "../../pytest-agent-observability"'
            not in text
        ), filename


def test_pipecat_examples_install_real_pipecat_runtime_for_version_metadata():
    """Example uploads should include the installed pipecat-ai framework version."""

    for filename in _PIPECAT_EXAMPLES:
        text = (ROOT / "examples" / "pytest" / filename).read_text()
        assert '#     "pipecat-ai[openai]",' in text, filename
        assert '#     "websockets>=13",' in text, filename


def test_pipecat_examples_use_real_openai_llm_service():
    """Examples should drive the agent under test with a real OpenAI LLM."""

    for filename in _PIPECAT_EXAMPLES:
        text = (ROOT / "examples" / "pytest" / filename).read_text()
        assert (
            "from pipecat.services.openai.llm import OpenAILLMService" in text
        ), filename
        assert "OpenAILLMService(model=" in text, filename
        assert "from pipecat.pipeline.pipeline import Pipeline" in text, filename
        assert (
            "from pipecat.adapters.schemas.function_schema import FunctionSchema"
            in text
        ), filename
        assert (
            "from pipecat.adapters.schemas.tools_schema import ToolsSchema" in text
        ), filename
        assert "LLMContextAggregatorPair" in text, filename
        assert "Pipeline([" in text, filename
        assert ".register_function(" in text, filename
        # No deterministic stand-ins should remain in the published examples.
        assert "DeterministicLLMService" not in text, filename
        assert "KeywordJudge" not in text, filename
        assert "install_fake_pipecat" not in text, filename


def test_all_pipecat_examples_use_openai_judge():
    """Every Pipecat example should LLM-judge content rather than keyword match."""

    for filename in _PIPECAT_EXAMPLES:
        text = (ROOT / "examples" / "pytest" / filename).read_text()
        assert "OpenAIJudge" in text, filename
        assert "AGENT_OBSERVABILITY_JUDGE_MODEL" in text, filename
