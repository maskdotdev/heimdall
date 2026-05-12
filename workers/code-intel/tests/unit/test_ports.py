import unittest

from code_intel.ports import PullRequestRef


class PortTests(unittest.TestCase):
    def test_pull_request_ref_keeps_provider_details_at_boundary(self) -> None:
        ref = PullRequestRef(
            provider="github",
            owner="acme",
            repo="heimdall",
            number=42,
            url="https://github.com/acme/heimdall/pull/42",
        )

        self.assertEqual(ref.provider, "github")
        self.assertEqual(ref.number, 42)


if __name__ == "__main__":
    unittest.main()
