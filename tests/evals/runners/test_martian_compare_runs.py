from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from martian_compare_runs import compare_runs, render_markdown


class MartianCompareRunsTests(unittest.TestCase):
    def test_compare_runs_reports_aggregate_and_case_deltas(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = root / "baseline"
            candidate = root / "candidate"
            write_run(
                baseline,
                case_rows=[
                    case_row("case_a", candidates=1, goldens=2, tp=1, fp=0, fn=1, turn_ms=100, prompt_chars=1000),
                    case_row("case_b", candidates=1, goldens=1, tp=1, fp=0, fn=0, turn_ms=50, prompt_chars=500),
                ],
            )
            write_run(
                candidate,
                case_rows=[
                    case_row("case_a", candidates=2, goldens=2, tp=1, fp=1, fn=1, turn_ms=80, prompt_chars=700),
                    case_row("case_b", candidates=0, goldens=1, tp=0, fp=0, fn=1, turn_ms=40, prompt_chars=350),
                ],
                findings_by_case={
                    "case_a": [{"title": "Concrete issue"}, {"title": "Speculative issue"}],
                    "case_b": [],
                },
                judgments_by_case={
                    "case_a": [{"caseId": "case_a", "candidateIndex": 0, "goldenIndex": 0, "sameIssue": True}],
                    "case_b": [],
                },
            )

            report = compare_runs(baseline, candidate, backend="codex-app-server")

        self.assertEqual(report["aggregateDelta"]["truePositives"]["delta"], -1)
        self.assertEqual(report["aggregateDelta"]["promptChars"]["delta"], -450)
        case_a = next(case for case in report["cases"] if case["caseId"] == "case_a")
        case_b = next(case for case in report["cases"] if case["caseId"] == "case_b")
        self.assertEqual(case_a["classification"], "mixed-misses-and-noise")
        self.assertEqual(case_a["unmatchedCandidateTitles"], ["Speculative issue"])
        self.assertEqual(case_a["unmatchedGoldenComments"], ["Golden issue 2"])
        self.assertEqual(case_b["classification"], "no-findings")

    def test_render_markdown_includes_quality_and_latency_deltas(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = root / "baseline"
            candidate = root / "candidate"
            write_run(baseline, case_rows=[case_row("case_a", candidates=1, goldens=1, tp=1, fp=0, fn=0, turn_ms=100, prompt_chars=1000)])
            write_run(candidate, case_rows=[case_row("case_a", candidates=1, goldens=1, tp=1, fp=0, fn=0, turn_ms=80, prompt_chars=700)])

            markdown = render_markdown(compare_runs(baseline, candidate, backend="codex-app-server"))

        self.assertIn("Precision", markdown)
        self.assertIn("Turn ms", markdown)
        self.assertIn("-20", markdown)
        self.assertIn("-300", markdown)


def write_run(
    run_dir: Path,
    *,
    case_rows: list[dict[str, object]],
    findings_by_case: dict[str, list[dict[str, object]]] | None = None,
    judgments_by_case: dict[str, list[dict[str, object]]] | None = None,
) -> None:
    backend_dir = run_dir / "codex-app-server"
    backend_dir.mkdir(parents=True)
    write_json(run_dir / "summary.json", case_rows)
    write_json(run_dir / "aggregate.json", aggregate(case_rows))
    write_json(run_dir / "run-metadata.json", {"schema_version": "1.0.0", "backend_names": ["codex-app-server"]})
    for row in case_rows:
        case_id = str(row["case_id"])
        case_dir = backend_dir / case_id
        case_dir.mkdir()
        write_json(case_dir / "comparison.json", row)
        write_json(
            case_dir / "martian-case.json",
            {
                "case_id": case_id,
                "golden_comments": [
                    {"comment": f"Golden issue {index + 1}", "severity": "medium"}
                    for index in range(int(row["golden_count"]))
                ],
            },
        )
        write_json(case_dir / "validated-findings.json", (findings_by_case or {}).get(case_id, []))
        write_json(case_dir / "judgments.json", {"matches": (judgments_by_case or {}).get(case_id, [])})


def case_row(
    case_id: str,
    *,
    candidates: int,
    goldens: int,
    tp: int,
    fp: int,
    fn: int,
    turn_ms: int,
    prompt_chars: int,
) -> dict[str, object]:
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "backend": "codex-app-server",
        "case_id": case_id,
        "reviewer_provider": "codex-app-server",
        "reviewer_model": "gpt-5.5",
        "judge_provider": "codex-app-server",
        "judge_model": "gpt-5.5",
        "candidate_count": candidates,
        "golden_count": goldens,
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": precision,
        "recall": recall,
        "duration_ms": turn_ms + 1,
        "error": None,
        "context_ms": 1,
        "review_ms": turn_ms,
        "judge_ms": 1,
        "total_ms": turn_ms + 2,
        "review_phase_ms": {"turnMs": turn_ms},
        "review_input_profile": {"promptChars": prompt_chars},
    }


def aggregate(rows: list[dict[str, object]]) -> dict[str, object]:
    tp = sum(int(row["true_positives"]) for row in rows)
    fp = sum(int(row["false_positives"]) for row in rows)
    fn = sum(int(row["false_negatives"]) for row in rows)
    return {
        "schemaVersion": "1.0.0",
        "caseCount": len(rows),
        "errorCount": 0,
        "candidateCount": sum(int(row["candidate_count"]) for row in rows),
        "goldenCount": sum(int(row["golden_count"]) for row in rows),
        "truePositives": tp,
        "falsePositives": fp,
        "falseNegatives": fn,
        "precision": tp / (tp + fp) if tp + fp else 0.0,
        "recall": tp / (tp + fn) if tp + fn else 0.0,
        "reviewMs": sum(int(row["review_ms"]) for row in rows),
        "judgeMs": sum(int(row["judge_ms"]) for row in rows),
        "durationMs": sum(int(row["duration_ms"]) for row in rows),
        "reviewPhaseMs": {"turnMs": sum(int(row["review_phase_ms"]["turnMs"]) for row in rows)},  # type: ignore[index]
        "reviewInputProfile": {"promptChars": sum(int(row["review_input_profile"]["promptChars"]) for row in rows)},  # type: ignore[index]
    }


def write_json(path: Path, value: object) -> None:
    path.write_text(f"{json.dumps(value, indent=2)}\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
