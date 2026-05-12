import unittest

from review_worker.ports import ReviewRequest


class PortTests(unittest.TestCase):
    def test_review_request_requires_context_bundle(self) -> None:
        annotations = ReviewRequest.__annotations__

        self.assertIn("context_bundle", annotations)


if __name__ == "__main__":
    unittest.main()
