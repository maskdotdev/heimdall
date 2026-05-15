import json
import unittest

from review_worker.context_builder import DiffContextOptions, build_diff_context_bundle
from review_worker.openai_provider import (
    MAX_PROMPT_FILES,
    PROMPT_VERSION,
    REVIEW_TEMPERATURE,
    OpenAICompatibleConfig,
    OpenAICompatibleReviewerProvider,
    ReviewerRefusalError,
    build_prompt,
)
from review_worker.ports import ReviewRequest

from test_context_builder import change_request, diff


class OpenAIProviderTests(unittest.TestCase):
    def test_translates_openai_compatible_response_to_reviewer_output(self) -> None:
        def transport(endpoint, headers, payload):
            self.assertEqual(endpoint, "https://llm.example.test/chat/completions")
            self.assertEqual(headers["authorization"], "Bearer test-key")
            self.assertEqual(payload["model"], "test-model")
            self.assertEqual(payload["temperature"], REVIEW_TEMPERATURE)
            self.assertEqual(payload["response_format"]["type"], "json_schema")
            self.assertTrue(payload["response_format"]["json_schema"]["strict"])
            self.assertEqual(payload["response_format"]["json_schema"]["name"], "heimdall_reviewer_output")
            self.assertEqual(payload["response_format"]["json_schema"]["schema"]["properties"]["schemaVersion"]["enum"], ["1.0.0"])
            self.assertIn("Review only the changed files", payload["messages"][0]["content"])
            self.assertIn("Prefer no finding over a speculative finding", payload["messages"][0]["content"])
            self.assertIn('The "schemaVersion" value must be "1.0.0"', payload["messages"][1]["content"])
            self.assertIn('"changedFiles"', payload["messages"][1]["content"])
            self.assertIn("Return an empty findings array", payload["messages"][1]["content"])
            self.assertIn("Set modelMetadata to null", payload["messages"][1]["content"])
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "schemaVersion": "1.0.0",
                                    "summary": "One supported finding.",
                                    "findings": [
                                        {
                                            "title": "Finding",
                                            "body": "Body",
                                            "category": "maintainability",
                                            "severity": "low",
                                            "confidence": "high",
                                            "location": None,
                                            "evidence": [{"kind": "diff-line", "summary": "Evidence", "location": None}],
                                            "suggestedFix": None,
                                            "reviewStandardRuleIds": None,
                                        }
                                    ],
                                    "modelMetadata": None,
                                }
                            )
                        }
                    }
                ]
            }

        provider = OpenAICompatibleReviewerProvider(
            OpenAICompatibleConfig(base_url="https://llm.example.test", api_key="test-key", model="test-model"),
            transport=transport,
        )
        output = provider.review(ReviewRequest(build_diff_context_bundle("run_1", change_request(), diff([]))))

        self.assertEqual(output.findings[0].title, "Finding")
        self.assertEqual(output.modelMetadata.provider, "openai-compatible")
        self.assertEqual(output.modelMetadata.model, "test-model")
        self.assertEqual(output.modelMetadata.temperature, REVIEW_TEMPERATURE)
        self.assertEqual(output.modelMetadata.promptVersion, PROMPT_VERSION)

    def test_raises_clear_error_for_model_refusal(self) -> None:
        def transport(endpoint, headers, payload):
            return {"choices": [{"message": {"refusal": "I cannot review this input."}}]}

        provider = OpenAICompatibleReviewerProvider(
            OpenAICompatibleConfig(base_url="https://llm.example.test", api_key="test-key", model="test-model"),
            transport=transport,
        )

        with self.assertRaisesRegex(ReviewerRefusalError, "refused"):
            provider.review(ReviewRequest(build_diff_context_bundle("run_1", change_request(), diff([]))))

    def test_prompt_includes_deleted_lines_and_review_checklist(self) -> None:
        from contract_types import ChangedFile, DiffHunk, DiffLine

        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(
                        path="app.py",
                        status="modified",
                        additions=1,
                        deletions=1,
                        language="Python",
                        hunks=[
                            DiffHunk(
                                oldStart=1,
                                oldLines=2,
                                newStart=1,
                                newLines=2,
                                lines=[
                                    DiffLine(kind="context", oldLine=1, newLine=1, content="def handle(value):"),
                                    DiffLine(kind="deleted", oldLine=2, content="    return value or 0"),
                                    DiffLine(kind="added", newLine=2, content="    return value.id"),
                                ],
                            )
                        ],
                    )
                ]
            ),
        )

        prompt = build_prompt(ReviewRequest(bundle))

        self.assertIn('"kind": "deleted"', prompt)
        self.assertIn("return value or 0", prompt)
        self.assertIn("missing null/None checks", prompt)
        self.assertIn('"includedChangedFileCount"', prompt)
        self.assertIn('"scannerSignalCount"', prompt)

    def test_prompt_includes_scanner_signals(self) -> None:
        from contract_types import ChangedFile, DiffHunk, DiffLine

        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff(
                [
                    ChangedFile(
                        path="app.py",
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
                                lines=[DiffLine(kind="added", newLine=1, content='value = request.GET.get("id", load_id())')],
                            )
                        ],
                    )
                ]
            ),
        )

        prompt = build_prompt(ReviewRequest(bundle))

        self.assertIn('"scannerSignals"', prompt)
        self.assertIn('"ruleId": "python-eager-default-call"', prompt)
        self.assertIn("Python evaluates default arguments", prompt)

    def test_prompt_includes_portable_repository_exploration_context(self) -> None:
        import tempfile
        from pathlib import Path

        from contract_types import ChangedFile, DiffHunk, DiffLine

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "tests").mkdir()
            (root / "src" / "caller.py").write_text(
                "from src.service import load_account\n\nresult = load_account(user_id)\n",
                encoding="utf-8",
            )
            (root / "tests" / "test_service.py").write_text(
                "def test_load_account():\n    load_account(user_id)\n",
                encoding="utf-8",
            )
            bundle = build_diff_context_bundle(
                "run_1",
                change_request(),
                diff(
                    [
                        ChangedFile(
                            path="src/service.py",
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
                                    lines=[DiffLine(kind="added", newLine=1, content="def load_account(user_id):")],
                                )
                            ],
                        )
                    ]
                ),
                DiffContextOptions(repository_root=str(root)),
            )

        prompt = build_prompt(ReviewRequest(bundle))

        self.assertIn('"dependencyFrontier"', prompt)
        self.assertIn('"relatedTests"', prompt)
        self.assertIn('"path": "src/caller.py"', prompt)
        self.assertIn('"path": "tests/test_service.py"', prompt)

    def test_prompt_prioritizes_high_signal_changed_files_before_truncating(self) -> None:
        from contract_types import ChangedFile, DiffHunk, DiffLine

        low_signal_files = [
            ChangedFile(
                path=f"docs/generated_{index}.md",
                status="modified",
                additions=1,
                deletions=0,
                language="Markdown",
                hunks=[
                    DiffHunk(
                        oldStart=1,
                        oldLines=0,
                        newStart=1,
                        newLines=1,
                        lines=[DiffLine(kind="added", newLine=1, content=f"Generated note {index}")],
                    )
                ],
            )
            for index in range(MAX_PROMPT_FILES)
        ]
        high_signal_file = ChangedFile(
            path="src/app/api/auth_validator.py",
            status="modified",
            additions=1,
            deletions=1,
            language="Python",
            hunks=[
                DiffHunk(
                    oldStart=10,
                    oldLines=2,
                    newStart=10,
                    newLines=2,
                    lines=[
                        DiffLine(kind="deleted", oldLine=10, content="    token = state.get('token')"),
                        DiffLine(kind="added", newLine=10, content="    token = state['token']"),
                    ],
                )
            ],
        )
        bundle = build_diff_context_bundle(
            "run_1",
            change_request(),
            diff([*low_signal_files, high_signal_file]),
            DiffContextOptions(max_files=MAX_PROMPT_FILES + 1),
        )

        prompt = build_prompt(ReviewRequest(bundle))
        review_context = json.loads(prompt.split("\n\n", 2)[1])

        self.assertIn('"path": "src/app/api/auth_validator.py"', prompt)
        self.assertIn("state['token']", prompt)
        self.assertNotIn(
            f"docs/generated_{MAX_PROMPT_FILES - 1}.md",
            [file["path"] for file in review_context["changedFiles"]],
        )

    def test_prompt_respects_explicit_file_and_snippet_limits(self) -> None:
        from contract_types import ChangedFile, DiffHunk, DiffLine

        files = [
            ChangedFile(
                path=f"src/app/api/handler_{index}.py",
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
                        lines=[DiffLine(kind="added", newLine=1, content=f"    value_{index} = state.get('value')")],
                    )
                ],
            )
            for index in range(3)
        ]
        bundle = build_diff_context_bundle("run_1", change_request(), diff(files), DiffContextOptions(max_files=3))

        prompt = build_prompt(ReviewRequest(bundle), max_files=1, max_snippets=1)
        review_context = json.loads(prompt.split("\n\n", 2)[1])

        self.assertEqual(len(review_context["changedFiles"]), 1)
        self.assertEqual(len(review_context["sourceSnippets"]), 1)


if __name__ == "__main__":
    unittest.main()
