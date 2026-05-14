import json
import unittest

from review_worker.context_builder import build_diff_context_bundle
from review_worker.openai_provider import (
    PROMPT_VERSION,
    OpenAICompatibleConfig,
    OpenAICompatibleReviewerProvider,
    ReviewerRefusalError,
)
from review_worker.ports import ReviewRequest

from test_context_builder import change_request, diff


class OpenAIProviderTests(unittest.TestCase):
    def test_translates_openai_compatible_response_to_reviewer_output(self) -> None:
        def transport(endpoint, headers, payload):
            self.assertEqual(endpoint, "https://llm.example.test/chat/completions")
            self.assertEqual(headers["authorization"], "Bearer test-key")
            self.assertEqual(payload["model"], "test-model")
            self.assertEqual(payload["temperature"], 0.1)
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
        self.assertEqual(output.modelMetadata.temperature, 0.1)
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


if __name__ == "__main__":
    unittest.main()
