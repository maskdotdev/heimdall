from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from contract_types import ContextBundle, Finding, ReviewerOutput, from_json, to_jsonable
from review_worker.backends import create_reviewer_provider
from review_worker.engine import ReviewEngine
from review_worker.finding_quality import dedupe_key
from review_worker.ports import ReviewRequest


ROOT = Path(__file__).resolve().parents[3]
EVALS_DIR = ROOT / "tests" / "evals"
GOLDEN_CASES_DIR = EVALS_DIR / "golden-prs"
EXPECTED_FINDINGS_DIR = EVALS_DIR / "expected-findings"
LIVE_RUNS_DIR = EVALS_DIR / "live-runs"


@dataclass(frozen=True, slots=True)
class ComparisonRow:
    backend: str
    case_id: str
    raw_findings: int
    validated_findings: int
    expected_hits: int
    unsupported_or_dropped: int
    duplicate_count: int
    duration_ms: int
    error: str | None = None


def run_live_review(backends: list[str], case_ids: list[str] | None = None, output_dir: Path | None = None) -> list[ComparisonRow]:
    cases = load_cases(case_ids)
    run_dir = output_dir or LIVE_RUNS_DIR / time.strftime("%Y%m%d-%H%M%S")
    rows: list[ComparisonRow] = []

    for backend in backends:
        for case_id, context_bundle in cases:
            started = time.monotonic()
            expected = load_expected(case_id)
            try:
                result = ReviewEngine(create_reviewer_provider(backend)).review(ReviewRequest(context_bundle=context_bundle))
                duration_ms = elapsed_ms(started)
            except Exception as error:
                row = failed_row(backend, case_id, elapsed_ms(started), error)
                rows.append(row)
                write_error_artifacts(run_dir, backend, case_id, row)
                continue

            row = compare_result(backend, case_id, result.raw_output, list(result.findings), expected, duration_ms)
            rows.append(row)
            write_artifacts(run_dir, backend, case_id, result.raw_output, list(result.findings), row)

    write_summary(run_dir, rows)
    return rows


def load_cases(case_ids: list[str] | None) -> list[tuple[str, ContextBundle]]:
    allowed = set(case_ids) if case_ids else None
    cases: list[tuple[str, ContextBundle]] = []
    for path in sorted(GOLDEN_CASES_DIR.glob("*.context-bundle.json")):
        case_id = path.name.removesuffix(".context-bundle.json")
        if allowed is not None and case_id not in allowed:
            continue
        cases.append((case_id, from_json(ContextBundle, load_json(path))))
    if not cases:
        raise ValueError("no eval cases matched the requested filters")
    return cases


def compare_result(
    backend: str,
    case_id: str,
    raw_output: ReviewerOutput,
    findings: list[Finding],
    expected: dict[str, Any],
    duration_ms: int,
) -> ComparisonRow:
    expected_hits = count_expected_hits(findings, expected.get("findings", []))
    raw_dedupe_keys = [dedupe_key(finding) for finding in raw_output.findings]
    return ComparisonRow(
        backend=backend,
        case_id=case_id,
        raw_findings=len(raw_output.findings),
        validated_findings=len(findings),
        expected_hits=expected_hits,
        unsupported_or_dropped=max(len(raw_output.findings) - len(findings), 0),
        duplicate_count=len(raw_dedupe_keys) - len(set(raw_dedupe_keys)),
        duration_ms=duration_ms,
    )


def failed_row(backend: str, case_id: str, duration_ms: int, error: Exception) -> ComparisonRow:
    return ComparisonRow(
        backend=backend,
        case_id=case_id,
        raw_findings=0,
        validated_findings=0,
        expected_hits=0,
        unsupported_or_dropped=0,
        duplicate_count=0,
        duration_ms=duration_ms,
        error=f"{type(error).__name__}: {error}",
    )


def count_expected_hits(findings: list[Finding], expected_findings: list[dict[str, Any]]) -> int:
    return sum(1 for expected in expected_findings if any(matches_expected(finding, expected) for finding in findings))


def matches_expected(finding: Finding, expected: dict[str, Any]) -> bool:
    if expected.get("category") and finding.category != expected["category"]:
        return False
    if expected.get("severity") and finding.severity != expected["severity"]:
        return False
    if expected.get("path") and not finding_has_expected_location(finding, expected):
        return False
    if not any(expected.get(key) for key in ("category", "severity", "path", "startLine")):
        return finding.title == expected["title"]
    return True


def finding_has_expected_location(finding: Finding, expected: dict[str, Any]) -> bool:
    locations = [finding.location, *(evidence.location for evidence in finding.evidence)]
    return any(
        location is not None
        and location.path == expected["path"]
        and (expected.get("startLine") is None or location.startLine == expected["startLine"])
        for location in locations
    )


def write_artifacts(
    run_dir: Path,
    backend: str,
    case_id: str,
    raw_output: ReviewerOutput,
    findings: list[Finding],
    row: ComparisonRow,
) -> None:
    case_dir = run_dir / backend / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    write_json(case_dir / "raw-output.json", to_jsonable(raw_output))
    write_json(case_dir / "validated-findings.json", to_jsonable(findings))
    write_json(case_dir / "comparison.json", asdict(row))


def write_error_artifacts(run_dir: Path, backend: str, case_id: str, row: ComparisonRow) -> None:
    case_dir = run_dir / backend / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    write_json(case_dir / "error.json", asdict(row))


def write_summary(run_dir: Path, rows: list[ComparisonRow]) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(run_dir / "summary.json", [asdict(row) for row in rows])


def format_table(rows: list[ComparisonRow]) -> str:
    headers = ["backend", "case", "raw", "validated", "hits", "dropped", "dupes", "ms", "error"]
    body = [
        [
            row.backend,
            row.case_id,
            str(row.raw_findings),
            str(row.validated_findings),
            str(row.expected_hits),
            str(row.unsupported_or_dropped),
            str(row.duplicate_count),
            str(row.duration_ms),
            row.error or "",
        ]
        for row in rows
    ]
    widths = [max(len(item) for item in column) for column in zip(headers, *body, strict=False)]
    lines = [format_row(headers, widths), format_row(["-" * width for width in widths], widths)]
    lines.extend(format_row(row, widths) for row in body)
    return "\n".join(lines)


def format_row(values: list[str], widths: list[int]) -> str:
    return "  ".join(value.ljust(width) for value, width in zip(values, widths, strict=True))


def load_expected(case_id: str) -> dict[str, Any]:
    return load_json(EXPECTED_FINDINGS_DIR / f"{case_id}.expected.json")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(f"{json.dumps(value, indent=2, sort_keys=True)}\n", encoding="utf-8")


def elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run live reviewer backends against Heimdall eval context bundles.")
    parser.add_argument("--backend", action="append", required=True, help="Reviewer backend name. Repeat to compare.")
    parser.add_argument("--case", action="append", help="Eval case id. Defaults to all golden cases.")
    parser.add_argument("--out", type=Path, help="Output directory for run artifacts.")
    args = parser.parse_args()

    rows = run_live_review(args.backend, args.case, args.out)
    print(format_table(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
