import tempfile
import unittest
from pathlib import Path

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

    def test_adds_bounded_repository_exploration_context_when_repo_root_is_provided(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app").mkdir()
            (root / "tests").mkdir()
            (root / "app" / "users.py").write_text(
                "\n".join(
                    [
                        "from app.models import UserProfile",
                        "",
                        "def save_profile(profile: UserProfile):",
                        "    return profile.persist()",
                    ]
                ),
                encoding="utf-8",
            )
            (root / "tests" / "test_profiles.py").write_text(
                "\n".join(
                    [
                        "from app.users import save_profile",
                        "",
                        "def test_save_profile():",
                        "    assert save_profile(profile)",
                    ]
                ),
                encoding="utf-8",
            )

            bundle = build_diff_context_bundle(
                "run_1",
                change_request(),
                diff(
                    [
                        ChangedFile(
                            path="app/profiles.py",
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
                                        DiffLine(kind="context", oldLine=1, newLine=1, content="class UserProfile:"),
                                        DiffLine(kind="added", newLine=2, content="    def save_profile(self):"),
                                    ],
                                )
                            ],
                        )
                    ]
                ),
                DiffContextOptions(repository_root=str(root), max_related_snippets=4, max_related_tests=4),
            )

        related_paths = {snippet.location.path for snippet in bundle.sourceSnippets or []}
        frontier_paths = {item.path for item in bundle.dependencyFrontier or []}
        test_paths = {item.path for item in bundle.relatedTests or []}

        self.assertIn("app/users.py", related_paths)
        self.assertIn("tests/test_profiles.py", related_paths)
        self.assertIn("app/users.py", frontier_paths)
        self.assertIn("tests/test_profiles.py", test_paths)

    def test_adds_enclosing_changed_symbol_and_referenced_type_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app").mkdir()
            (root / "app" / "profiles.py").write_text(
                "\n".join(
                    [
                        "from app.models import ProfileStatus",
                        "",
                        "class UserProfile:",
                        "    def __init__(self, status):",
                        "        self.status = status",
                        "",
                        "    def save_profile(self, status: ProfileStatus):",
                        "        self.status = status",
                        "        return self.persist()",
                    ]
                ),
                encoding="utf-8",
            )
            (root / "app" / "models.py").write_text(
                "\n".join(
                    [
                        "class ProfileStatus:",
                        "    def __init__(self, value):",
                        "        self.value = value",
                    ]
                ),
                encoding="utf-8",
            )

            bundle = build_diff_context_bundle(
                "run_1",
                change_request(),
                diff(
                    [
                        ChangedFile(
                            path="app/profiles.py",
                            status="modified",
                            additions=1,
                            deletions=0,
                            language="Python",
                            hunks=[
                                DiffHunk(
                                    oldStart=7,
                                    oldLines=1,
                                    newStart=7,
                                    newLines=2,
                                    lines=[
                                        DiffLine(
                                            kind="context",
                                            oldLine=7,
                                            newLine=7,
                                            content="    def save_profile(self, status: ProfileStatus):",
                                        ),
                                        DiffLine(kind="added", newLine=8, content="        self.status = status"),
                                    ],
                                )
                            ],
                        )
                    ]
                ),
                DiffContextOptions(repository_root=str(root), max_related_snippets=6),
            )

        snippets = bundle.sourceSnippets or []
        enclosing = next(
            snippet
            for snippet in snippets
            if snippet.location.path == "app/profiles.py" and snippet.reason == "related-symbol"
        )
        dependency = next(
            snippet
            for snippet in snippets
            if snippet.location.path == "app/models.py" and snippet.reason == "dependency"
        )

        self.assertIn("def save_profile", enclosing.content)
        self.assertIn("class ProfileStatus", dependency.content)

    def test_repository_exploration_marks_truncation_at_file_scan_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.py").write_text("def changed_symbol():\n    return 1\n", encoding="utf-8")
            (root / "b.py").write_text("changed_symbol()\n", encoding="utf-8")

            bundle = build_diff_context_bundle(
                "run_1",
                change_request(),
                diff(
                    [
                        ChangedFile(
                            path="changed.py",
                            status="modified",
                            additions=1,
                            deletions=0,
                            language="Python",
                            hunks=[
                                DiffHunk(
                                    oldStart=1,
                                    oldLines=0,
                                    newStart=1,
                                    newLines=1,
                                    lines=[DiffLine(kind="added", newLine=1, content="changed_symbol()")],
                                )
                            ],
                        )
                    ]
                ),
                DiffContextOptions(repository_root=str(root), max_repository_files_scanned=1),
            )

        self.assertTrue(bundle.limits.truncated)
        self.assertIn("repository-file-scan-limit", bundle.limits.truncationReasons or [])


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
