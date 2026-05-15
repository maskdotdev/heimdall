import unittest

from review_worker.backends import create_reviewer_provider, registered_backend_names
from review_worker.fake_provider import FakeReviewerProvider


class BackendRegistryTests(unittest.TestCase):
    def test_creates_fake_provider_by_default(self) -> None:
        provider = create_reviewer_provider()

        self.assertIsInstance(provider, FakeReviewerProvider)

    def test_lists_registered_backend_names(self) -> None:
        self.assertIn("codex-app-server", registered_backend_names())
        self.assertIn("codex-app-server-agentic", registered_backend_names())
        self.assertIn("fake", registered_backend_names())
        self.assertIn("openai-chat", registered_backend_names())

    def test_reports_available_names_for_unknown_backend(self) -> None:
        with self.assertRaisesRegex(ValueError, "available providers"):
            create_reviewer_provider("missing")


if __name__ == "__main__":
    unittest.main()
