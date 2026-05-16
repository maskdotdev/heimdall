from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class RunCase:
    case_id: str
    row: dict[str, Any]
    findings: list[dict[str, Any]]
    martian_case: dict[str, Any] | None
    judgments: list[dict[str, Any]]


@dataclass(frozen=True, slots=True)
class CaseDelta:
    case_id: str
    baseline: dict[str, Any] | None
    candidate: dict[str, Any] | None
    delta: dict[str, Any]
    classification: str
    candidate_titles: list[str]
    unmatched_golden_comments: list[str]
    unmatched_candidate_titles: list[str]


def compare_runs(baseline_dir: Path, candidate_dir: Path, *, backend: str | None = None, top: int | None = None) -> dict[str, Any]:
    baseline_backend = resolve_backend_dir(baseline_dir, backend)
    candidate_backend = resolve_backend_dir(candidate_dir, backend)
    baseline_cases = load_cases(baseline_backend)
    candidate_cases = load_cases(candidate_backend)
    case_ids = sorted(set(baseline_cases) | set(candidate_cases))
    deltas = [
        compare_case(case_id, baseline_cases.get(case_id), candidate_cases.get(case_id))
        for case_id in case_ids
    ]
    deltas.sort(key=delta_sort_key)
    if top is not None:
        deltas = deltas[:top]

    return {
        "schemaVersion": "1.0.0",
        "baseline": run_summary(baseline_dir),
        "candidate": run_summary(candidate_dir),
        "backend": candidate_backend.name,
        "aggregateDelta": aggregate_delta(load_optional_json(baseline_dir / "aggregate.json"), load_optional_json(candidate_dir / "aggregate.json")),
        "cases": [case_delta_to_json(delta) for delta in deltas],
    }


def resolve_backend_dir(run_dir: Path, backend: str | None) -> Path:
    if backend is not None:
        path = run_dir / backend
        if not path.is_dir():
            raise ValueError(f"backend directory does not exist: {path}")
        return path

    candidates = [
        path
        for path in run_dir.iterdir()
        if path.is_dir()
        and any(
            (case_dir / "comparison.json").exists() or (case_dir / "error.json").exists()
            for case_dir in path.iterdir()
            if case_dir.is_dir()
        )
    ]
    if len(candidates) != 1:
        names = ", ".join(sorted(path.name for path in candidates)) or "<none>"
        raise ValueError(f"expected exactly one backend directory in {run_dir}; found {names}. Pass --backend.")
    return candidates[0]


def load_cases(backend_dir: Path) -> dict[str, RunCase]:
    cases: dict[str, RunCase] = {}
    for case_dir in sorted(path for path in backend_dir.iterdir() if path.is_dir()):
        row = load_optional_json(case_dir / "comparison.json") or load_optional_json(case_dir / "error.json")
        if not isinstance(row, dict):
            continue
        case_id = str(row.get("case_id") or case_dir.name)
        findings = load_optional_json(case_dir / "validated-findings.json") or []
        martian_case = load_optional_json(case_dir / "martian-case.json")
        judgments_data = load_optional_json(case_dir / "judgments.json") or {}
        judgments = judgments_data.get("matches", []) if isinstance(judgments_data, dict) else []
        cases[case_id] = RunCase(
            case_id=case_id,
            row=row,
            findings=findings if isinstance(findings, list) else [],
            martian_case=martian_case if isinstance(martian_case, dict) else None,
            judgments=judgments if isinstance(judgments, list) else [],
        )
    return cases


def compare_case(case_id: str, baseline: RunCase | None, candidate: RunCase | None) -> CaseDelta:
    baseline_row = baseline.row if baseline else None
    candidate_row = candidate.row if candidate else None
    candidate_findings = candidate.findings if candidate else []
    candidate_case = candidate.martian_case if candidate else None
    candidate_judgments = candidate.judgments if candidate else []
    return CaseDelta(
        case_id=case_id,
        baseline=compact_row(baseline_row),
        candidate=compact_row(candidate_row),
        delta=row_delta(baseline_row, candidate_row),
        classification=classify_case(candidate_row),
        candidate_titles=finding_titles(candidate_findings),
        unmatched_golden_comments=unmatched_golden_comments(candidate_case, candidate_judgments),
        unmatched_candidate_titles=unmatched_candidate_titles(candidate_findings, candidate_judgments),
    )


def compact_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "candidateCount": row.get("candidate_count"),
        "goldenCount": row.get("golden_count"),
        "truePositives": row.get("true_positives"),
        "falsePositives": row.get("false_positives"),
        "falseNegatives": row.get("false_negatives"),
        "precision": row.get("precision"),
        "recall": row.get("recall"),
        "reviewMs": row.get("review_ms"),
        "turnMs": (row.get("review_phase_ms") or {}).get("turnMs") if isinstance(row.get("review_phase_ms"), dict) else None,
        "promptChars": (row.get("review_input_profile") or {}).get("promptChars") if isinstance(row.get("review_input_profile"), dict) else None,
        "error": row.get("error"),
    }


def row_delta(baseline: dict[str, Any] | None, candidate: dict[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, key in (
        ("candidateCount", "candidate_count"),
        ("truePositives", "true_positives"),
        ("falsePositives", "false_positives"),
        ("falseNegatives", "false_negatives"),
        ("precision", "precision"),
        ("recall", "recall"),
        ("reviewMs", "review_ms"),
    ):
        result[name] = numeric_delta(value_at(baseline, key), value_at(candidate, key))
    result["turnMs"] = numeric_delta(nested_value(baseline, "review_phase_ms", "turnMs"), nested_value(candidate, "review_phase_ms", "turnMs"))
    result["promptChars"] = numeric_delta(
        nested_value(baseline, "review_input_profile", "promptChars"),
        nested_value(candidate, "review_input_profile", "promptChars"),
    )
    result["errorChanged"] = (baseline or {}).get("error") != (candidate or {}).get("error")
    return result


def aggregate_delta(baseline: dict[str, Any] | None, candidate: dict[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("candidateCount", "truePositives", "falsePositives", "falseNegatives", "precision", "recall", "reviewMs", "judgeMs", "durationMs"):
        result[key] = numeric_delta(value_at(baseline, key), value_at(candidate, key))
    result["f1"] = numeric_delta(f1_score(baseline), f1_score(candidate))
    result["turnMs"] = numeric_delta(nested_value(baseline, "reviewPhaseMs", "turnMs"), nested_value(candidate, "reviewPhaseMs", "turnMs"))
    result["promptChars"] = numeric_delta(nested_value(baseline, "reviewInputProfile", "promptChars"), nested_value(candidate, "reviewInputProfile", "promptChars"))
    result["errorCount"] = numeric_delta(value_at(baseline, "errorCount"), value_at(candidate, "errorCount"))
    return result


def classify_case(row: dict[str, Any] | None) -> str:
    if row is None:
        return "missing"
    if row.get("error"):
        return "runtime-error"
    candidates = int(row.get("candidate_count") or 0)
    goldens = int(row.get("golden_count") or 0)
    tp = row.get("true_positives")
    fp = row.get("false_positives")
    fn = row.get("false_negatives")
    if candidates == 0 and goldens > 0:
        return "no-findings"
    if tp is None or fp is None or fn is None:
        return "unjudged"
    if tp == 0 and fp > 0:
        return "only-false-positives"
    if fn > 0 and fp > 0:
        return "mixed-misses-and-noise"
    if fn > 0:
        return "missed-goldens"
    if fp > 0:
        return "extra-findings"
    return "clean"


def unmatched_golden_comments(martian_case: dict[str, Any] | None, judgments: list[dict[str, Any]]) -> list[str]:
    if not martian_case:
        return []
    matched = {int(match["goldenIndex"]) for match in judgments if match.get("sameIssue") is True and isinstance(match.get("goldenIndex"), int)}
    comments = martian_case.get("golden_comments")
    if not isinstance(comments, list):
        return []
    return [
        str(comment.get("comment", ""))
        for index, comment in enumerate(comments)
        if index not in matched and isinstance(comment, dict)
    ]


def unmatched_candidate_titles(findings: list[dict[str, Any]], judgments: list[dict[str, Any]]) -> list[str]:
    matched = {int(match["candidateIndex"]) for match in judgments if match.get("sameIssue") is True and isinstance(match.get("candidateIndex"), int)}
    return [
        str(finding.get("title", ""))
        for index, finding in enumerate(findings)
        if index not in matched
    ]


def finding_titles(findings: list[dict[str, Any]]) -> list[str]:
    return [str(finding.get("title", "")) for finding in findings]


def delta_sort_key(delta: CaseDelta) -> tuple[float, str]:
    score = 0.0
    for key in ("truePositives", "falsePositives", "falseNegatives", "turnMs", "promptChars"):
        value = delta.delta.get(key)
        if isinstance(value, dict) and isinstance(value.get("delta"), (int, float)):
            score += abs(float(value["delta"]))
    return (-score, delta.case_id)


def case_delta_to_json(delta: CaseDelta) -> dict[str, Any]:
    return {
        "caseId": delta.case_id,
        "classification": delta.classification,
        "baseline": delta.baseline,
        "candidate": delta.candidate,
        "delta": delta.delta,
        "candidateTitles": delta.candidate_titles,
        "unmatchedCandidateTitles": delta.unmatched_candidate_titles,
        "unmatchedGoldenComments": delta.unmatched_golden_comments,
    }


def render_markdown(report: dict[str, Any]) -> str:
    aggregate = report["aggregateDelta"]
    lines = [
        f"# Martian Run Comparison",
        "",
        f"- Backend: `{report['backend']}`",
        metric_line("Precision", aggregate["precision"]),
        metric_line("Recall", aggregate["recall"]),
        metric_line("F1", aggregate["f1"]),
        metric_line("TP", aggregate["truePositives"]),
        metric_line("FP", aggregate["falsePositives"]),
        metric_line("FN", aggregate["falseNegatives"]),
        metric_line("Turn ms", aggregate["turnMs"]),
        metric_line("Prompt chars", aggregate["promptChars"]),
        metric_line("Errors", aggregate["errorCount"]),
        "",
        "| Case | Class | TP | FP | FN | Turn ms | Prompt chars |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for case in report["cases"]:
        delta = case["delta"]
        lines.append(
            "| {case} | {classification} | {tp} | {fp} | {fn} | {turn} | {prompt} |".format(
                case=case["caseId"],
                classification=case["classification"],
                tp=format_delta(delta["truePositives"]),
                fp=format_delta(delta["falsePositives"]),
                fn=format_delta(delta["falseNegatives"]),
                turn=format_delta(delta["turnMs"]),
                prompt=format_delta(delta["promptChars"]),
            )
        )
    return "\n".join(lines)


def metric_line(label: str, delta: dict[str, Any]) -> str:
    return f"- {label}: {format_value(delta.get('candidate'))} ({format_delta(delta)})"


def numeric_delta(baseline: Any, candidate: Any) -> dict[str, Any]:
    if not isinstance(baseline, (int, float)) or not isinstance(candidate, (int, float)):
        return {"baseline": baseline, "candidate": candidate, "delta": None}
    return {"baseline": baseline, "candidate": candidate, "delta": candidate - baseline}


def format_delta(delta: dict[str, Any]) -> str:
    value = delta.get("delta")
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:+.3f}"
    return f"{value:+}"


def format_value(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def f1_score(row: dict[str, Any] | None) -> float | None:
    precision = value_at(row, "precision")
    recall = value_at(row, "recall")
    if not isinstance(precision, (int, float)) or not isinstance(recall, (int, float)):
        return None
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def run_summary(run_dir: Path) -> dict[str, Any]:
    metadata = load_optional_json(run_dir / "run-metadata.json")
    aggregate = load_optional_json(run_dir / "aggregate.json")
    return {
        "path": str(run_dir),
        "metadata": metadata,
        "aggregate": aggregate,
    }


def value_at(row: dict[str, Any] | None, key: str) -> Any:
    return row.get(key) if isinstance(row, dict) else None


def nested_value(row: dict[str, Any] | None, key: str, nested_key: str) -> Any:
    value = value_at(row, key)
    return value.get(nested_key) if isinstance(value, dict) else None


def load_optional_json(path: Path) -> Any:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare two Martian benchmark run artifact directories.")
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--backend", help="Backend directory name. Required when a run contains multiple backends.")
    parser.add_argument("--top", type=int, help="Only show the top N most changed cases.")
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    args = parser.parse_args()

    report = compare_runs(args.baseline, args.candidate, backend=args.backend, top=args.top)
    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
