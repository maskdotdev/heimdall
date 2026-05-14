from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from contract_types import ContextBundle, ReviewerOutput, from_json
from review_worker.finding_quality import validated_findings_from_reviewer_output


ROOT = Path(__file__).resolve().parents[3]
EVALS_DIR = ROOT / "tests" / "evals"
GOLDEN_CASES_DIR = EVALS_DIR / "golden-prs"
SAVED_OUTPUTS_DIR = EVALS_DIR / "saved-outputs"
EXPECTED_FINDINGS_DIR = EVALS_DIR / "expected-findings"


@dataclass(frozen=True, slots=True)
class EvalFailure:
    case_id: str
    message: str


def run_eval_suite() -> list[EvalFailure]:
    failures: list[EvalFailure] = []
    case_paths = sorted(GOLDEN_CASES_DIR.glob("*.context-bundle.json"))
    if not case_paths:
        return [EvalFailure(case_id="<suite>", message="no review eval cases found")]

    for context_path in case_paths:
        case_id = context_path.name.removesuffix(".context-bundle.json")
        failures.extend(run_eval_case(case_id, context_path))
    return failures


def run_eval_case(case_id: str, context_path: Path) -> list[EvalFailure]:
    output_path = SAVED_OUTPUTS_DIR / f"{case_id}.reviewer-output.json"
    expected_path = EXPECTED_FINDINGS_DIR / f"{case_id}.expected.json"
    missing = [path for path in (output_path, expected_path) if not path.exists()]
    if missing:
        return [EvalFailure(case_id=case_id, message=f"missing eval artifact: {missing[0]}")]

    context_bundle = from_json(ContextBundle, load_json(context_path))
    reviewer_output = from_json(ReviewerOutput, load_json(output_path))
    expected = load_json(expected_path)
    findings = validated_findings_from_reviewer_output(context_bundle, reviewer_output)

    failures: list[EvalFailure] = []
    if expected.get("caseId") != case_id:
        failures.append(EvalFailure(case_id=case_id, message="expected caseId does not match filename"))
    if expected.get("rawFindingCount") != len(reviewer_output.findings):
        failures.append(
            EvalFailure(
                case_id=case_id,
                message=f"raw finding count: expected {expected.get('rawFindingCount')}, got {len(reviewer_output.findings)}",
            )
        )
    if expected.get("validatedFindingCount") != len(findings):
        failures.append(
            EvalFailure(
                case_id=case_id,
                message=f"validated finding count: expected {expected.get('validatedFindingCount')}, got {len(findings)}",
            )
        )

    actual_summaries = [summarize_finding(finding) for finding in findings]
    expected_summaries = expected.get("findings", [])
    if expected_summaries != actual_summaries:
        failures.append(
            EvalFailure(
                case_id=case_id,
                message=(
                    "validated findings differed:\n"
                    f"expected={json.dumps(expected_summaries, sort_keys=True)}\n"
                    f"actual={json.dumps(actual_summaries, sort_keys=True)}"
                ),
            )
        )
    return failures


def summarize_finding(finding: Any) -> dict[str, Any]:
    return {
        "title": finding.title,
        "category": finding.category,
        "severity": finding.severity,
        "confidence": finding.confidence,
        "path": finding.location.path if finding.location else None,
        "startLine": finding.location.startLine if finding.location else None,
        "dedupeKey": finding.dedupeKey,
        "rank": finding.rank,
    }


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    failures = run_eval_suite()
    if not failures:
        print("Review evals passed.")
        return 0
    for failure in failures:
        print(f"{failure.case_id}: {failure.message}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
