from __future__ import annotations

NAME = "mamaearth_v1"

CRITERIA = [
    (
        "greeting",
        "Did the agent identify itself as Mamaearth support and ask how it could help?",
    ),
    (
        "lookup_detail",
        "Before sharing any order info, did the agent ask the caller for an order ID or"
        " mobile number?",
    ),
    (
        "language_mirroring",
        "The caller spoke English. Did the agent reply in English (not switching to Hindi)?",
    ),
    (
        "no_fabrication",
        "Did the agent avoid inventing order, delivery, courier, or tracking details that"
        " were not produced by an actual lookup?",
    ),
    (
        "graceful_failure",
        "If the lookup did not return an order, did the agent apologise briefly and offer"
        " to connect a support executive (instead of guessing or stalling)?",
    ),
]

JUDGE_SYSTEM_PROMPT = (
    "You are a strict evaluator scoring a recorded customer-support call. "
    "Only mark a criterion as pass if there is clear, quoted evidence in the transcript. "
    "If a criterion is not applicable (e.g. no lookup happened so graceful_failure can't"
    " be judged), mark it pass and explain why."
)

JUDGE_USER_TEMPLATE = """Score the call below against the criteria. Respond with STRICT JSON only — no prose, no markdown fences.

Schema:
{{
  "criteria": [
    {{"name": "<key>", "pass": true|false, "justification": "<one line, quote from transcript>"}}
  ],
  "overall": "pass" | "fail",
  "notes": "<one or two sentences of overall assessment>"
}}

Criteria (use these exact keys, in this order):
{criteria_block}

Transcript:
<<<
{transcript}
>>>
"""


def render_judge_user_prompt(transcript: str) -> str:
    criteria_block = "\n".join(f"- {key}: {q}" for key, q in CRITERIA)
    return JUDGE_USER_TEMPLATE.format(criteria_block=criteria_block, transcript=transcript)
