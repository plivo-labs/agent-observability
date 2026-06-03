from __future__ import annotations

import argparse
import logging
import sys

import plivo

from truman_calling.caller.config import settings

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger("dial")


def dial(to_number: str | None = None, caller_name: str = "Cekura Spike") -> dict:
    target = to_number or settings.target_number
    client = plivo.RestClient(settings.plivo_auth_id, settings.plivo_auth_token)
    log.info(
        "placing call: from=%s to=%s answer_url=%s",
        settings.plivo_from_number,
        target,
        settings.public_answer_url,
    )
    resp = client.calls.create(
        from_=settings.plivo_from_number,
        to_=target,
        answer_url=settings.public_answer_url,
        answer_method="POST",
        hangup_url=f"{settings.public_base_url.rstrip('/')}/hangup",
        hangup_method="POST",
        caller_name=caller_name,
    )
    log.info("plivo response: %s", resp)
    return resp


def main() -> int:
    parser = argparse.ArgumentParser(description="Place an outbound test call.")
    parser.add_argument("--to", default=None, help="Override TARGET_NUMBER")
    parser.add_argument("--caller-name", default="Cekura Spike")
    args = parser.parse_args()
    try:
        dial(args.to, args.caller_name)
        return 0
    except Exception as e:
        log.exception("dial failed: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
