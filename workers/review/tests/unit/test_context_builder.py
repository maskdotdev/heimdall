import unittest

from contract_types import (
    ChangeRef,
    ChangeRequest,
    ChangedFile,
    Diff,
    DiffHunk,
    DiffLine,
    DiffSummary,
    Repository,
)
from review_worker.context_builder import DiffContextOptions, build_diff_context_bundle


class ContextBuilderTests(unittest.TestCase):
    def test_builds_diff_only_context_bundle(self) -> None:
        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(
                        path="review.py",
                        status="modified",
                        additions=1,
                        deletions=0,
                        language="Python",
                        hunks=[
                            DiffHunk(
                                oldStart=1,
                                oldLines=1,
                                newStart=1,
                                newLines=2,
                                lines=[
                                    DiffLine(kind="context", oldLine=1, newLine=1, content='print("old")'),
                                    DiffLine(kind="added", newLine=2, content='print("new")'),
                                ],
                            )
                        ],
                    )
                ]
            ),
        )

        self.assertEqual(bundle.id, "ctx_run_1")
        self.assertEqual(bundle.reviewRunId, "run_1")
        self.assertEqual(bundle.sourceSnippets[0].location.path, "review.py")
        self.assertIn('print("new")', bundle.sourceSnippets[0].content)
        self.assertFalse(bundle.limits.truncated)

    def test_marks_bundle_truncated_when_file_limit_is_exceeded(self) -> None:
        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(path="one.py", status="modified", additions=0, deletions=0, hunks=[]),
                    ChangedFile(path="two.py", status="modified", additions=0, deletions=0, hunks=[]),
                ]
            ),
            DiffContextOptions(max_files=1),
        )

        self.assertTrue(bundle.limits.truncated)
        self.assertEqual(bundle.limits.truncationReasons, ["file-count-limit"])

    def test_adds_python_scanner_signals_for_order_sensitive_diff_patterns(self) -> None:
        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(
                        path="review.py",
                        status="modified",
                        additions=3,
                        deletions=0,
                        language="Python",
                        hunks=[
                            DiffHunk(
                                oldStart=1,
                                oldLines=0,
                                newStart=1,
                                newLines=3,
                                lines=[
                                    DiffLine(kind="added", newLine=1, content='value = request.GET.get("id", load_id())'),
                                    DiffLine(kind="added", newLine=2, content="pairs = zip(requested_ids, rows.values())"),
                                    DiffLine(kind="added", newLine=3, content='if actor != integration.metadata["sender"]["login"]:'),
                                ],
                            )
                        ],
                    )
                ]
            ),
        )

        rule_ids = [signal.ruleId for signal in bundle.scannerSignals or []]
        self.assertEqual(rule_ids, ["python-eager-default-call", "ordered-inputs-with-mapping-values", "nested-metadata-indexing"])
        self.assertEqual((bundle.scannerSignals or [])[0].location.path, "review.py")


def change_request() -> ChangeRequest:
    repository = Repository(
        schemaVersion="1.0.0",
        id="repo_1",
        provider="github",
        owner="acme",
        name="heimdall",
        defaultBranch="main",
    )
    return ChangeRequest(
        schemaVersion="1.0.0",
        id="cr_1",
        repository=repository,
        provider="github",
        providerChangeRequestId="42",
        title="PR",
        state="open",
        base=ChangeRef(ref="main", sha="aaaaaaaa"),
        head=ChangeRef(ref="pull/42/head", sha="bbbbbbbb"),
    )


def diff(files: list[ChangedFile]) -> Diff:
    return Diff(
        schemaVersion="1.0.0",
        id="diff_1",
        changeRequestId="cr_1",
        baseSha="aaaaaaaa",
        headSha="bbbbbbbb",
        summary=DiffSummary(fileCount=len(files), additions=1, deletions=0),
        files=files,
    )


if __name__ == "__main__":
    unittest.main()
