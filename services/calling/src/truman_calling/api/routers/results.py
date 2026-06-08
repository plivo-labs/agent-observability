from __future__ import annotations

import csv
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from io import StringIO

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from truman_calling.api.db import get_session
from truman_calling.api.deps import require_auth
from truman_calling.api.schemas.results import (
    ResultCompareRead,
    ResultCompareRunRead,
    ResultCreate,
    ResultDetailRead,
    ResultRead,
    ResultReportRead,
    ResultRerunCreate,
)
from truman_calling.core.models import Run, Scenario, Suite
from truman_calling.core.queue import PLACE_CALL_STREAM, publish

router = APIRouter(prefix="/v1/results", tags=["results"])

ACTIVE_STATUSES = {"queued", "dialing", "live", "recording", "evaluating"}


@router.get("", response_model=list[ResultRead])
async def list_results(
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    limit: int = Query(50, ge=1, le=200),
):
    suites = await _list_suites(session, org_id, limit)
    runs_by_suite = await _runs_by_suite(session, org_id, [suite.id for suite in suites])
    return [_summarize_result(suite, runs_by_suite.get(suite.id, [])) for suite in suites]


@router.post("", response_model=ResultDetailRead, status_code=status.HTTP_201_CREATED)
async def create_result(
    payload: ResultCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    scenario_ids = list(dict.fromkeys(payload.scenario_ids))
    result = await session.execute(
        select(Scenario).where(Scenario.org_id == org_id, Scenario.id.in_(scenario_ids))
    )
    scenarios = list(result.scalars().all())
    found_ids = {scenario.id for scenario in scenarios}
    missing = [scenario_id for scenario_id in scenario_ids if scenario_id not in found_ids]
    if missing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"scenario not found: {missing[0]}")

    scenario_by_id = {scenario.id: scenario for scenario in scenarios}
    ordered_scenarios = [scenario_by_id[scenario_id] for scenario_id in scenario_ids]
    suite = Suite(
        org_id=org_id,
        name=payload.name.strip() if payload.name and payload.name.strip() else "Ad hoc evaluation batch",
        status="queued",
    )
    session.add(suite)
    await session.flush()

    runs = [
        Run(
            org_id=org_id,
            agent_id=scenario.agent_id,
            scenario_id=scenario.id,
            suite_id=suite.id,
            status="queued",
        )
        for scenario in ordered_scenarios
    ]
    session.add_all(runs)
    await session.commit()

    for run in runs:
        await publish(PLACE_CALL_STREAM, {"run_id": str(run.id)})

    return _summarize_result(suite, runs, include_runs=True)


@router.post("/{result_id}/rerun", response_model=ResultDetailRead, status_code=status.HTTP_201_CREATED)
async def rerun_result(
    result_id: uuid.UUID,
    payload: ResultRerunCreate,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    suite = await _get_suite(session, org_id, result_id)
    runs = await _suite_runs(session, org_id, suite.id)
    source_runs = _rerun_source_runs(runs, payload.mode)
    if not source_runs:
        reason = "failed runs" if payload.mode == "failed" else "runs"
        raise HTTPException(status.HTTP_409_CONFLICT, f"result has no {reason} to rerun")

    new_suite = Suite(
        org_id=org_id,
        name=_rerun_suite_name(suite, payload),
        status="queued",
    )
    session.add(new_suite)
    await session.flush()

    new_runs = [
        Run(
            org_id=org_id,
            agent_id=run.agent_id,
            scenario_id=run.scenario_id,
            suite_id=new_suite.id,
            status="queued",
        )
        for run in source_runs
    ]
    session.add_all(new_runs)
    await session.commit()

    for run in new_runs:
        await publish(PLACE_CALL_STREAM, {"run_id": str(run.id)})

    return _summarize_result(new_suite, new_runs, include_runs=True)


@router.get("/{result_id}/compare", response_model=ResultCompareRead)
async def compare_result(
    result_id: uuid.UUID,
    baseline_id: uuid.UUID = Query(...),
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    if result_id == baseline_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "baseline must be a different result")
    suite = await _get_suite(session, org_id, result_id)
    baseline = await _get_suite(session, org_id, baseline_id)
    runs = await _suite_runs(session, org_id, suite.id)
    baseline_runs = await _suite_runs(session, org_id, baseline.id)
    return _build_compare(suite, runs, baseline, baseline_runs)


@router.get("/{result_id}", response_model=ResultDetailRead)
async def get_result(
    result_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    suite = await _get_suite(session, org_id, result_id)
    runs = await _suite_runs(session, org_id, suite.id)
    return _summarize_result(suite, runs, include_runs=True)


@router.get("/{result_id}/report", response_model=ResultReportRead)
async def get_result_report(
    result_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    suite = await _get_suite(session, org_id, result_id)
    runs = await _suite_runs(session, org_id, suite.id)
    return _build_report(suite, runs)


@router.get("/{result_id}/export.csv")
async def export_result_csv(
    result_id: uuid.UUID,
    org_id: uuid.UUID = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    suite = await _get_suite(session, org_id, result_id)
    runs = await _suite_runs(session, org_id, suite.id)
    body = _build_csv(runs)
    filename = f"result-{str(suite.id)[:8]}.csv"
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _list_suites(session: AsyncSession, org_id: uuid.UUID, limit: int) -> list[Suite]:
    result = await session.execute(
        select(Suite)
        .where(Suite.org_id == org_id)
        .order_by(Suite.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


async def _get_suite(session: AsyncSession, org_id: uuid.UUID, suite_id: uuid.UUID) -> Suite:
    result = await session.execute(
        select(Suite).where(Suite.id == suite_id, Suite.org_id == org_id)
    )
    suite = result.scalar_one_or_none()
    if suite is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "result not found")
    return suite


async def _suite_runs(session: AsyncSession, org_id: uuid.UUID, suite_id: uuid.UUID) -> list[Run]:
    result = await session.execute(
        select(Run)
        .where(Run.org_id == org_id, Run.suite_id == suite_id)
        .order_by(Run.created_at.desc())
    )
    return list(result.scalars().all())


async def _runs_by_suite(
    session: AsyncSession,
    org_id: uuid.UUID,
    suite_ids: list[uuid.UUID],
) -> dict[uuid.UUID, list[Run]]:
    if not suite_ids:
        return {}
    result = await session.execute(
        select(Run)
        .where(Run.org_id == org_id, Run.suite_id.in_(suite_ids))
        .order_by(Run.created_at.desc())
    )
    grouped: dict[uuid.UUID, list[Run]] = defaultdict(list)
    for run in result.scalars().all():
        if run.suite_id:
            grouped[run.suite_id].append(run)
    return grouped


def _summarize_result(
    suite: Suite,
    runs: list[Run],
    *,
    include_runs: bool = False,
) -> ResultRead | ResultDetailRead:
    passes = sum(1 for run in runs if run.verdict == "pass")
    failures = sum(1 for run in runs if run.verdict == "fail")
    pending = len(runs) - passes - failures
    finished = passes + failures
    durations = [_duration_seconds(run) for run in runs]
    durations = [seconds for seconds in durations if seconds > 0]
    data = {
        "id": suite.id,
        "name": suite.name,
        "status": _result_status(suite, runs),
        "created_at": suite.created_at,
        "run_count": len(runs),
        "scenario_count": len({run.scenario_id for run in runs}),
        "agent_count": len({run.agent_id for run in runs}),
        "pass_count": passes,
        "fail_count": failures,
        "pending_count": pending,
        "score": round((passes / finished) * 100) if finished else None,
        "avg_duration_seconds": round(sum(durations) / len(durations)) if durations else None,
        "scenario_ids": list(dict.fromkeys(run.scenario_id for run in runs)),
        "agent_ids": list(dict.fromkeys(run.agent_id for run in runs)),
        "latest_error": _latest_error(runs),
    }
    if include_runs:
        return ResultDetailRead(**data, runs=runs)
    return ResultRead(**data)


def _result_status(suite: Suite, runs: list[Run]) -> str:
    if any(run.status in ACTIVE_STATUSES for run in runs):
        return "running"
    if any(run.status == "failed" for run in runs):
        return "failed"
    if runs and all(run.status == "done" for run in runs):
        return "done"
    return suite.status


def _duration_seconds(run: Run) -> int:
    if not run.started_at or not run.ended_at:
        return 0
    return max(0, round((run.ended_at - run.started_at).total_seconds()))


def _latest_error(runs: list[Run]) -> str | None:
    for run in sorted(runs, key=lambda item: item.created_at, reverse=True):
        if run.error:
            return run.error
        if run.verdict == "fail" and run.judge_result:
            if notes := run.judge_result.get("notes"):
                return str(notes)
    return None


def _rerun_source_runs(runs: list[Run], mode: str) -> list[Run]:
    if mode == "all":
        return runs
    return [run for run in runs if run.verdict == "fail" or run.status == "failed"]


def _rerun_suite_name(suite: Suite, payload: ResultRerunCreate) -> str:
    if payload.name and payload.name.strip():
        return payload.name.strip()[:256]
    base = suite.name or f"Result {str(suite.id)[:8]}"
    prefix = "Rerun failed" if payload.mode == "failed" else "Rerun"
    return f"{prefix}: {base}"[:256]


def _build_compare(
    suite: Suite,
    runs: list[Run],
    baseline: Suite,
    baseline_runs: list[Run],
) -> ResultCompareRead:
    summary = _summarize_result(suite, runs)
    baseline_summary = _summarize_result(baseline, baseline_runs)
    rows = [_compare_row(current, previous) for _, current, previous in _comparison_pairs(runs, baseline_runs)]
    rows.sort(key=lambda row: (_outcome_rank(row.outcome), str(row.scenario_id)))
    return ResultCompareRead(
        result_id=suite.id,
        baseline_id=baseline.id,
        result_name=suite.name,
        baseline_name=baseline.name,
        result_score=summary.score,
        baseline_score=baseline_summary.score,
        score_delta=(
            summary.score - baseline_summary.score
            if summary.score is not None and baseline_summary.score is not None
            else None
        ),
        fixed_count=sum(1 for row in rows if row.outcome == "fixed"),
        regressed_count=sum(1 for row in rows if row.outcome == "regressed"),
        unchanged_pass_count=sum(1 for row in rows if row.outcome == "unchanged_pass"),
        unchanged_fail_count=sum(1 for row in rows if row.outcome == "unchanged_fail"),
        new_count=sum(1 for row in rows if row.outcome == "new"),
        removed_count=sum(1 for row in rows if row.outcome == "removed"),
        pending_count=sum(1 for row in rows if row.outcome == "pending"),
        rows=rows,
    )


def _comparison_pairs(
    runs: list[Run],
    baseline_runs: list[Run],
) -> list[tuple[uuid.UUID, Run | None, Run | None]]:
    current_by_scenario = _latest_run_by_scenario(runs)
    baseline_by_scenario = _latest_run_by_scenario(baseline_runs)
    scenario_ids = set(current_by_scenario) | set(baseline_by_scenario)
    return [
        (scenario_id, current_by_scenario.get(scenario_id), baseline_by_scenario.get(scenario_id))
        for scenario_id in scenario_ids
    ]


def _latest_run_by_scenario(runs: list[Run]) -> dict[uuid.UUID, Run]:
    latest: dict[uuid.UUID, Run] = {}
    for run in sorted(runs, key=lambda item: item.created_at):
        latest[run.scenario_id] = run
    return latest


def _compare_row(current: Run | None, previous: Run | None) -> ResultCompareRunRead:
    run = current or previous
    if run is None:
        raise ValueError("comparison row requires at least one run")
    previous_outcome = _run_outcome(previous)
    current_outcome = _run_outcome(current)
    outcome = _compare_outcome(current, previous, current_outcome, previous_outcome)
    return ResultCompareRunRead(
        scenario_id=run.scenario_id,
        agent_id=run.agent_id,
        baseline_run_id=previous.id if previous else None,
        current_run_id=current.id if current else None,
        baseline_status=previous.status if previous else None,
        current_status=current.status if current else None,
        baseline_verdict=previous.verdict if previous else None,
        current_verdict=current.verdict if current else None,
        outcome=outcome,
        note=_compare_note(current, previous, outcome),
    )


def _run_outcome(run: Run | None) -> str | None:
    if run is None:
        return None
    if run.verdict in {"pass", "fail"}:
        return run.verdict
    if run.status == "failed":
        return "fail"
    return None


def _compare_outcome(
    current: Run | None,
    previous: Run | None,
    current_outcome: str | None,
    previous_outcome: str | None,
) -> str:
    if current is None:
        return "removed"
    if previous is None:
        return "new"
    if current_outcome is None or previous_outcome is None:
        return "pending"
    if previous_outcome == "fail" and current_outcome == "pass":
        return "fixed"
    if previous_outcome == "pass" and current_outcome == "fail":
        return "regressed"
    if current_outcome == "fail":
        return "unchanged_fail"
    return "unchanged_pass"


def _compare_note(current: Run | None, previous: Run | None, outcome: str) -> str | None:
    if outcome == "fixed":
        return "Previously failed, now passing."
    if outcome == "regressed":
        return _run_note(current) or "Previously passed, now failing."
    if outcome in {"unchanged_fail", "pending"}:
        return _run_note(current) or _run_note(previous)
    if outcome == "removed":
        return "Scenario was not included in the current batch."
    if outcome == "new":
        return "Scenario was not present in the baseline batch."
    return None


def _outcome_rank(outcome: str) -> int:
    return {
        "regressed": 0,
        "unchanged_fail": 1,
        "pending": 2,
        "fixed": 3,
        "new": 4,
        "removed": 5,
        "unchanged_pass": 6,
    }.get(outcome, 99)


def _build_report(suite: Suite, runs: list[Run]) -> ResultReportRead:
    summary = _summarize_result(suite, runs)
    score_text = f"{summary.score}%" if summary.score is not None else "not scored yet"
    if summary.fail_count:
        failure_label = _plural(summary.fail_count, "failure", "failures")
        verb = "needs" if summary.fail_count == 1 else "need"
        headline = f"{summary.fail_count} {failure_label} {verb} review"
    elif summary.score is not None:
        headline = "No failures detected"
    else:
        headline = "Evaluation batch is still running"
    failure_summary = _failure_summary(runs)
    return ResultReportRead(
        id=suite.id,
        name=suite.name,
        generated_at=datetime.now(timezone.utc),
        status=summary.status,
        score=summary.score,
        headline=headline,
        summary=(
            f"{summary.run_count} {_plural(summary.run_count, 'run', 'runs')} across "
            f"{summary.scenario_count} {_plural(summary.scenario_count, 'scenario', 'scenarios')} and "
            f"{summary.agent_count} {_plural(summary.agent_count, 'agent', 'agents')}. "
            f"Score is {score_text} with "
            f"{summary.pass_count} {_plural(summary.pass_count, 'pass', 'passes')}, "
            f"{summary.fail_count} {_plural(summary.fail_count, 'fail', 'fails')}, and "
            f"{summary.pending_count} pending."
        ),
        failure_summary=failure_summary,
        recommended_actions=_recommended_actions(summary, failure_summary),
        run_count=summary.run_count,
        pass_count=summary.pass_count,
        fail_count=summary.fail_count,
        pending_count=summary.pending_count,
    )


def _failure_summary(runs: list[Run]) -> str | None:
    reasons = []
    for run in runs:
        if run.verdict != "fail" and run.status != "failed":
            continue
        if run.error:
            reasons.append(run.error)
        elif run.judge_result and run.judge_result.get("notes"):
            reasons.append(str(run.judge_result["notes"]))
        elif run.judge_result:
            for criterion in run.judge_result.get("criteria", []):
                if criterion.get("pass") is False and criterion.get("justification"):
                    reasons.append(str(criterion["justification"]))
                    break
    if not reasons:
        return None
    unique_reasons = list(dict.fromkeys(reasons))
    return " ".join(unique_reasons[:3])


def _recommended_actions(summary: ResultRead, failure_summary: str | None) -> list[str]:
    actions = []
    if summary.fail_count:
        actions.append("Open failed runs and review failed judge criteria before rerunning the batch.")
        actions.append("Compare the failed scenarios against their current version history and expected outcomes.")
    if summary.pending_count:
        actions.append("Wait for pending runs to finish before treating the score as final.")
    if failure_summary:
        actions.append("Use the failure summary as the release-gate note for the owning agent/scenario.")
    if not actions:
        actions.append("No immediate action required; keep this batch as release evidence.")
    return actions


def _build_csv(runs: list[Run]) -> str:
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "run_id",
            "scenario_id",
            "agent_id",
            "status",
            "verdict",
            "started_at",
            "ended_at",
            "duration_seconds",
            "failure_or_notes",
        ]
    )
    for run in runs:
        writer.writerow(
            [
                str(run.id),
                str(run.scenario_id),
                str(run.agent_id),
                run.status,
                run.verdict or "",
                run.started_at.isoformat() if run.started_at else "",
                run.ended_at.isoformat() if run.ended_at else "",
                _duration_seconds(run) or "",
                _run_note(run),
            ]
        )
    return output.getvalue()


def _run_note(run: Run) -> str:
    if run.error:
        return run.error
    if run.judge_result and run.judge_result.get("notes"):
        return str(run.judge_result["notes"])
    return ""


def _plural(count: int, singular: str, plural: str) -> str:
    return singular if count == 1 else plural
