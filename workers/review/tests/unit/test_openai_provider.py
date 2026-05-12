import json
import unittest

from review_worker.context_builder import build_diff_context_bundle
from review_worker.openai_provider import OpenAICompatibleConfig, OpenAICompatibleReviewerProvider
from review_worker.ports import ReviewRequest

from test_context_builder import change_request, diff


class OpenAIProviderTests(unittest.TestCase):
    def test_translates_openai_compatible_response_to_reviewer_output(self) -> None:
        def transport(endpoint, headers, payload):
            self.assertEqual(endpoint, "https://llm.example.test/chat/completions")
            self.assertEqual(headers["authorization"], "Bearer test-key")
            self.assertEqual(payload["model"], "test-model")
            self.assertIn('schemaVersion must be exactly "1.0.0"', payload["messages"][0]["content"])
            self.assertIn('The schemaVersion value must be "1.0.0"', payload["messages"][1]["content"])
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "schemaVersion": "1.0.0",
                                    "findings": [
                                        {
                                            "title": "Finding",
                                            "body": "Body",
                                            "category": "maintainability",
                                            "severity": "low",
                                            "confidence": "high",
                                            "evidence": [{"kind": "diff-line", "summary": "Evidence"}],
                                        }
                                    ],
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


if __name__ == "__main__":
    unittest.main()
