from __future__ import annotations

import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from contract_types import Finding, FindingEvidence, FindingValidation, ReviewerEvidence, ReviewerFinding, ReviewerOutput, SourceLocation
from review_worker.fake_provider import FakeReviewerProvider
from martian_benchmark import (
    MartianCase,
    MartianGoldenIssue,
    aggregate_rows,
    build_judge_prompt,
    case_id_for_url,
    compare_martian_result,
    context_bundle_for_case,
    judge_findings_with_codex,
    load_diff_text,
    format_table,
    load_martian_cases,
    parse_judge_output,
    parse_repo_roots,
    parse_unified_diff,
    resolve_case_repo_roots,
    run_martian_benchmark,
    write_cached_diff,
)


PULL_URL = "https://github.com/acme/payments/pull/101"
CASE_ID = "acme_payments_101"
DIFF_TEXT = """diff --git a/app/routes.py b/app/routes.py
index 1111111..2222222 100644
--- a/app/routes.py
+++ b/app/routes.py
@@ -4,3 +4,5 @@ def profile(request):
 def profile(request):
-    return get_profile(request.user.id)
+    user_id = request.GET["id"]
+    query = f"SELECT * FROM users WHERE id = {user_id}"
+    return db.execute(query).fetchone()
     return response
"""


class MartianBenchmarkTests(unittest.TestCase):
    def test_loads_golden_comment_cases_from_martian_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            golden_dir = Path(tmp)
            write_json(
                golden_dir / "payments.json",
                [
                    {
                        "pr_title": "Use request parameter in profile lookup",
                        "url": PULL_URL,
                        "comments": [{"comment": "The request id is interpolated into SQL.", "severity": "High"}],
                    }
                ],
            )

            cases = load_martian_cases(golden_dir=golden_dir)

        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0].case_id, CASE_ID)
        self.assertEqual(cases[0].golden_comments[0].severity, "high")

    def test_loads_cases_from_martian_benchmark_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "benchmark_data.json"
            write_json(
                path,
                {
                    PULL_URL: {
                        "pr_title": "Use request parameter in profile lookup",
                        "source_repo": "payments",
                        "golden_comments": [{"comment": "The request id is interpolated into SQL.", "severity": "High"}],
                    }
                },
            )

            cases = load_martian_cases(benchmark_data=path)

        self.assertEqual(cases[0].case_id, CASE_ID)
        self.assertEqual(cases[0].source_repo, "payments")

    def test_parses_unified_diff_into_heimdall_diff_contract(self) -> None:
        diff = parse_unified_diff(DIFF_TEXT, diff_id="diff_1", change_request_id="cr_1", base_sha="0000000", head_sha="1111111")

        self.assertEqual(diff.summary.fileCount, 1)
        self.assertEqual(diff.summary.additions, 3)
        self.assertEqual(diff.summary.deletions, 1)
        self.assertEqual(diff.files[0].path, "app/routes.py")
        self.assertEqual(diff.files[0].hunks[0].lines[1].kind, "deleted")
        self.assertEqual(diff.files[0].hunks[0].lines[2].newLine, 5)

    def test_builds_context_bundle_from_local_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            diff_dir = Path(tmp)
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")
            bundle = context_bundle_for_case(martian_case(), diff_dir=diff_dir, fetch_diffs=False)

        self.assertEqual(bundle.changeRequest.repository.fullName, "acme/payments")
        self.assertEqual(bundle.diff.files[0].path, "app/routes.py")
        self.assertTrue(bundle.sourceSnippets)

    def test_builds_context_bundle_with_repository_exploration_when_repo_root_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            diff_dir = root / "diffs"
            repo_root = root / "repo"
            diff_dir.mkdir()
            (repo_root / "app").mkdir(parents=True)
            (repo_root / "tests").mkdir()
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")
            (repo_root / "app" / "services.py").write_text(
                "def get_profile(user_id):\n    return user_id\n",
                encoding="utf-8",
            )
            (repo_root / "tests" / "test_routes.py").write_text(
                "def test_profile():\n    get_profile(user_id)\n",
                encoding="utf-8",
            )

            bundle = context_bundle_for_case(
                martian_case(),
                diff_dir=diff_dir,
                fetch_diffs=False,
                repository_root=repo_root,
            )

        self.assertTrue(bundle.dependencyFrontier)
        self.assertTrue(bundle.relatedTests)

    def test_reads_cached_diff_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            write_cached_diff(cache_dir, martian_case(), DIFF_TEXT)

            diff_text = load_diff_text(martian_case(), diff_dir=None, cache_diff_dir=cache_dir, fetch_diffs=False)

        self.assertEqual(diff_text, DIFF_TEXT)

    def test_compare_result_can_use_semantic_judgments_for_precision_recall(self) -> None:
        row = compare_martian_result(
            backend="fake",
            case=martian_case(),
            raw_output=ReviewerOutput(schemaVersion="1.0.0", findings=[raw_finding()]),
            findings=[validated_finding()],
            duration_ms=12,
            match_mode="judgments",
            judgments=[{"candidateIndex": 0, "goldenIndex": 0, "sameIssue": True}],
        )

        self.assertEqual(row.true_positives, 1)
        self.assertEqual(row.false_positives, 0)
        self.assertEqual(row.false_negatives, 0)
        self.assertEqual(row.precision, 1.0)
        self.assertEqual(row.recall, 1.0)
        self.assertIn("precision", format_table([row]))

    def test_aggregate_rows_reports_batch_precision_and_recall(self) -> None:
        row = compare_martian_result(
            backend="fake",
            case=martian_case(),
            raw_output=ReviewerOutput(schemaVersion="1.0.0", findings=[raw_finding()]),
            findings=[validated_finding()],
            duration_ms=12,
            match_mode="judgments",
            judgments=[{"candidateIndex": 0, "goldenIndex": 0, "sameIssue": True}],
        )

        timed_row = replace(
            row,
            context_ms=3,
            review_ms=9,
            judge_ms=5,
            total_ms=17,
            review_phase_ms={"turnMs": 7, "parseMs": 1},
            review_input_profile={"promptChars": 100, "changedFilesChars": 80},
        )
        aggregate = aggregate_rows([timed_row])

        self.assertEqual(aggregate["truePositives"], 1)
        self.assertEqual(aggregate["precision"], 1.0)
        self.assertEqual(aggregate["recall"], 1.0)
        self.assertEqual(aggregate["contextMs"], 3)
        self.assertEqual(aggregate["reviewMs"], 9)
        self.assertEqual(aggregate["judgeMs"], 5)
        self.assertEqual(aggregate["totalMs"], 17)
        self.assertEqual(aggregate["reviewPhaseMs"], {"turnMs": 7, "parseMs": 1})
        self.assertEqual(aggregate["reviewInputProfile"], {"promptChars": 100, "changedFilesChars": 80})

    def test_builds_and_parses_judge_output_for_all_pairs(self) -> None:
        pairs = [
            {
                "candidateIndex": 0,
                "goldenIndex": 0,
                "candidate": {"title": "Raw user id is interpolated into SQL"},
                "golden": {"comment": "The request id is interpolated into SQL."},
            }
        ]
        prompt = build_judge_prompt(martian_case(), pairs)

        judgments = parse_judge_output(
            '{"matches":[{"caseId":"acme_payments_101","candidateIndex":0,"goldenIndex":0,"sameIssue":true,"rationale":"same SQL injection"}]}',
            expected_pairs=pairs,
            judge_model="gpt-5.5",
        )

        self.assertIn("same underlying code review issue", prompt)
        self.assertEqual(judgments[0]["sameIssue"], True)
        self.assertEqual(judgments[0]["judge"]["model"], "gpt-5.5")

    def test_run_martian_benchmark_runs_registered_backend_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            golden_dir = root / "golden_comments"
            diff_dir = root / "diffs"
            out_dir = root / "run"
            golden_dir.mkdir()
            diff_dir.mkdir()
            write_json(
                golden_dir / "payments.json",
                [
                    {
                        "pr_title": "Use request parameter in profile lookup",
                        "url": PULL_URL,
                        "comments": [{"comment": "The fake reviewer produced deterministic finding output.", "severity": "Low"}],
                    }
                ],
            )
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")

            rows = run_martian_benchmark(["fake"], golden_dir=golden_dir, diff_dir=diff_dir, output_dir=out_dir, match_mode="lexical")
            pairs_exist = (out_dir / "fake" / CASE_ID / "candidate-golden-pairs.json").exists()

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].backend, "fake")
        self.assertEqual(rows[0].candidate_count, 1)
        self.assertEqual(rows[0].true_positives, 1)
        self.assertTrue(pairs_exist)

    def test_run_martian_benchmark_reuses_non_agentic_provider(self) -> None:
        second_url = "https://github.com/acme/payments/pull/102"
        second_case_id = case_id_for_url(second_url)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            golden_dir = root / "golden_comments"
            diff_dir = root / "diffs"
            out_dir = root / "run"
            golden_dir.mkdir()
            diff_dir.mkdir()
            write_json(
                golden_dir / "payments.json",
                [
                    {
                        "pr_title": "Use request parameter in profile lookup",
                        "url": PULL_URL,
                        "comments": [{"comment": "The fake reviewer produced deterministic finding output.", "severity": "Low"}],
                    },
                    {
                        "pr_title": "Use request parameter in profile lookup again",
                        "url": second_url,
                        "comments": [{"comment": "The fake reviewer produced deterministic finding output.", "severity": "Low"}],
                    },
                ],
            )
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")
            (diff_dir / f"{second_case_id}.diff").write_text(DIFF_TEXT, encoding="utf-8")

            with patch("martian_benchmark.create_reviewer_provider", return_value=FakeReviewerProvider()) as create_provider:
                rows = run_martian_benchmark(["fake"], golden_dir=golden_dir, diff_dir=diff_dir, output_dir=out_dir, match_mode="lexical")

        self.assertEqual(len(rows), 2)
        create_provider.assert_called_once_with("fake")

    def test_agentic_martian_backend_requires_explicit_repo_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            golden_dir = root / "golden_comments"
            diff_dir = root / "diffs"
            out_dir = root / "run"
            golden_dir.mkdir()
            diff_dir.mkdir()
            write_json(
                golden_dir / "payments.json",
                [{"pr_title": "Use request parameter in profile lookup", "url": PULL_URL, "comments": [{"comment": "Expected issue"}]}],
            )
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")

            with patch("martian_benchmark.create_reviewer_provider") as create_provider:
                rows = run_martian_benchmark(
                    ["codex-app-server-agentic"],
                    golden_dir=golden_dir,
                    diff_dir=diff_dir,
                    output_dir=out_dir,
                    match_mode="lexical",
                )

        create_provider.assert_not_called()
        self.assertIn("requires --repo-root", rows[0].error or "")

    def test_agentic_martian_backend_sets_case_repo_root_for_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            golden_dir = root / "golden_comments"
            diff_dir = root / "diffs"
            repo_root = root / "clean-checkout"
            out_dir = root / "run"
            golden_dir.mkdir()
            diff_dir.mkdir()
            repo_root.mkdir()
            write_json(
                golden_dir / "payments.json",
                [
                    {
                        "pr_title": "Use request parameter in profile lookup",
                        "url": PULL_URL,
                        "comments": [{"comment": "The fake reviewer produced deterministic finding output.", "severity": "Low"}],
                    }
                ],
            )
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")

            def create_provider(name: str):
                self.assertEqual(name, "codex-app-server-agentic")
                self.assertEqual(os.environ.get("HEIMDALL_CODEX_APP_SERVER_CWD"), str(repo_root))
                return FakeReviewerProvider()

            with patch("martian_benchmark.create_reviewer_provider", side_effect=create_provider):
                rows = run_martian_benchmark(
                    ["codex-app-server-agentic"],
                    golden_dir=golden_dir,
                    diff_dir=diff_dir,
                    output_dir=out_dir,
                    match_mode="lexical",
                    repo_roots={CASE_ID: repo_root},
                )

        self.assertEqual(rows[0].backend, "codex-app-server-agentic")
        self.assertNotIn("HEIMDALL_CODEX_APP_SERVER_CWD", os.environ)
        self.assertEqual(rows[0].true_positives, 1)

    def test_run_martian_benchmark_resumes_successful_case_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            golden_dir = root / "golden_comments"
            diff_dir = root / "diffs"
            out_dir = root / "run"
            golden_dir.mkdir()
            diff_dir.mkdir()
            write_json(
                golden_dir / "payments.json",
                [
                    {
                        "pr_title": "Use request parameter in profile lookup",
                        "url": PULL_URL,
                        "comments": [{"comment": "The fake reviewer produced deterministic finding output.", "severity": "Low"}],
                    }
                ],
            )
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")

            first_rows = run_martian_benchmark(["fake"], golden_dir=golden_dir, diff_dir=diff_dir, output_dir=out_dir, match_mode="lexical")
            (diff_dir / f"{CASE_ID}.diff").write_text("not a diff", encoding="utf-8")
            resumed_rows = run_martian_benchmark(["fake"], golden_dir=golden_dir, diff_dir=diff_dir, output_dir=out_dir, match_mode="lexical")
            metadata = json.loads((out_dir / "run-metadata.json").read_text(encoding="utf-8"))

        self.assertEqual(first_rows, resumed_rows)
        self.assertIn("git_head", metadata)
        self.assertIn("reviewer_config", metadata)

    def test_judge_pair_guardrail_runs_before_model_call(self) -> None:
        with self.assertRaisesRegex(ValueError, "exceeds --max-judge-pairs"):
            judge_findings_with_codex(martian_case(), [validated_finding()], max_judge_pairs=0)

    def test_run_martian_benchmark_honors_batch_time_guardrail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            golden_dir = root / "golden_comments"
            diff_dir = root / "diffs"
            out_dir = root / "run"
            golden_dir.mkdir()
            diff_dir.mkdir()
            write_json(
                golden_dir / "payments.json",
                [
                    {
                        "pr_title": "Use request parameter in profile lookup",
                        "url": PULL_URL,
                        "comments": [{"comment": "The fake reviewer produced deterministic finding output.", "severity": "Low"}],
                    }
                ],
            )
            (diff_dir / f"{CASE_ID}.diff").write_text(DIFF_TEXT, encoding="utf-8")

            rows = run_martian_benchmark(["fake"], golden_dir=golden_dir, diff_dir=diff_dir, output_dir=out_dir, max_run_seconds=0)

        self.assertIn("max run seconds exceeded", rows[0].error or "")

    def test_parse_repo_roots_requires_case_path_mapping(self) -> None:
        self.assertEqual(parse_repo_roots(["case_1=/repo"])["case_1"], Path("/repo"))

        with self.assertRaisesRegex(ValueError, "<case-id>=<path>"):
            parse_repo_roots(["/repo"])

    def test_resolve_case_repo_roots_maps_existing_case_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inferred = root / CASE_ID
            explicit = root / "explicit"
            inferred.mkdir()
            explicit.mkdir()

            resolved = resolve_case_repo_roots(
                [martian_case()],
                explicit_roots={},
                repo_root_dir=root,
            )
            explicit_resolved = resolve_case_repo_roots(
                [martian_case()],
                explicit_roots={CASE_ID: explicit},
                repo_root_dir=root,
            )

        self.assertEqual(resolved[CASE_ID], inferred)
        self.assertEqual(explicit_resolved[CASE_ID], explicit)


def martian_case() -> MartianCase:
    return MartianCase(
        case_id=case_id_for_url(PULL_URL),
        url=PULL_URL,
        pr_title="Use request parameter in profile lookup",
        source_repo="payments",
        golden_comments=[MartianGoldenIssue(comment="The request id is interpolated into SQL.", severity="high")],
    )


def raw_finding() -> ReviewerFinding:
    location = SourceLocation(path="app/routes.py", startLine=6)
    return ReviewerFinding(
        title="Raw user id is interpolated into SQL",
        body="The request id reaches a SQL string.",
        category="security",
        severity="high",
        confidence="high",
        location=location,
        evidence=[ReviewerEvidence(kind="diff-line", summary="The request id is interpolated into SQL.", location=location)],
    )


def validated_finding() -> Finding:
    location = SourceLocation(path="app/routes.py", startLine=6)
    return Finding(
        schemaVersion="1.0.0",
        id="finding_1",
        reviewRunId="run_1",
        source="llm",
        title="Raw user id is interpolated into SQL",
        body="The request id reaches a SQL string.",
        category="security",
        severity="high",
        confidence="high",
        location=location,
        evidence=[FindingEvidence(kind="diff-line", summary="The request id is interpolated into SQL.", location=location)],
        status="validated",
        validation=FindingValidation(schemaValid=True, locationValid=True, evidenceValid=True, redactionValid=True),
        dedupeKey="app/routes.py:6:security:raw-user-id-is-interpolated-into-sql",
        rank=1,
    )


def write_json(path: Path, value: object) -> None:
    path.write_text(f"{json.dumps(value, indent=2)}\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
