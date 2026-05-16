from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from martian_benchmark import MartianCase, MartianGoldenIssue
from prepare_martian_repos import prepare_repositories


class PrepareMartianReposTests(unittest.TestCase):
    def test_prepare_repositories_clones_fetches_and_writes_manifest(self) -> None:
        commands: list[tuple[list[str], Path | None]] = []

        def run_git(command: list[str], *, cwd: Path | None = None) -> str:
            commands.append((command, cwd))
            if command[:2] == ["git", "clone"]:
                Path(command[-1], ".git").mkdir(parents=True)
            if command == ["git", "rev-parse", "HEAD"]:
                return "abc123\n"
            return ""

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            with patch("prepare_martian_repos.run_git", side_effect=run_git):
                prepared = prepare_repositories([martian_case()], out)

            manifest = (out / "manifest.json").read_text(encoding="utf-8")

        self.assertEqual(prepared[0].case_id, "acme_payments_101")
        self.assertEqual(prepared[0].head_sha, "abc123")
        self.assertIn("acme_payments_101", manifest)
        self.assertEqual(commands[0][0][:3], ["git", "clone", "--filter=blob:none"])
        self.assertIn("--no-checkout", commands[0][0])
        self.assertEqual(commands[1][0], ["git", "fetch", "--depth=1", "origin", "pull/101/head"])
        self.assertEqual(commands[2][0], ["git", "checkout", "--detach", "FETCH_HEAD"])

    def test_prepare_repositories_reuses_existing_checkout_without_clone(self) -> None:
        commands: list[list[str]] = []

        def run_git(command: list[str], *, cwd: Path | None = None) -> str:
            commands.append(command)
            if command == ["git", "rev-parse", "HEAD"]:
                return "abc123\n"
            return ""

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "acme_payments_101" / ".git").mkdir(parents=True)
            with patch("prepare_martian_repos.run_git", side_effect=run_git):
                prepare_repositories([martian_case()], out)

        self.assertNotIn("clone", [part for command in commands for part in command])
        self.assertEqual(commands[0], ["git", "fetch", "--depth=1", "origin", "pull/101/head"])


def martian_case() -> MartianCase:
    return MartianCase(
        case_id="acme_payments_101",
        url="https://github.com/acme/payments/pull/101",
        pr_title="Use request parameter in profile lookup",
        source_repo="payments",
        golden_comments=[MartianGoldenIssue(comment="Expected issue.", severity="high")],
    )


if __name__ == "__main__":
    unittest.main()
