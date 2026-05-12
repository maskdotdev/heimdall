from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from code_intel.git_fetcher import GitPullRequestFetcher
from code_intel.patch_parser import parse_numstat, parse_patch
from code_intel.ports import PullRequestRef
from code_intel.snapshot_contracts import build_pull_request_snapshot


class GitFetcherTests(unittest.TestCase):
    def test_fetch_pull_request_from_local_github_shaped_refs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            remote = create_remote_with_pull_ref(Path(temp_dir))
            fetcher = GitPullRequestFetcher(remote_url_builder=lambda _: str(remote))
            snapshot = fetcher.fetch_pull_request(
                PullRequestRef(
                    provider="github",
                    owner="acme",
                    repo="heimdall",
                    number=42,
                    url="https://github.com/acme/heimdall/pull/42",
                )
            )

        self.assertEqual(snapshot.repository.id, "repo_github_acme_heimdall")
        self.assertEqual(snapshot.change_request.number, 42)
        self.assertEqual(snapshot.diff.summary.fileCount, 1)
        self.assertEqual(snapshot.diff.files[0].path, "review.py")
        self.assertEqual(snapshot.diff.files[0].status, "modified")
        self.assertGreaterEqual(snapshot.diff.files[0].additions, 1)
        self.assertEqual(snapshot.diff.files[0].hunks[0].lines[-1].kind, "added")

    def test_parse_patch(self) -> None:
        patch = """diff --git a/review.py b/review.py
index 1111111..2222222 100644
--- a/review.py
+++ b/review.py
@@ -1 +1,2 @@
 print("old")
+print("new")
"""
        files = parse_patch(patch, parse_numstat("1\t0\treview.py"))

        self.assertEqual(files[0].language, "Python")
        self.assertEqual(files[0].hunks[0].lines[1].newLine, 2)

    def test_build_pull_request_snapshot_contracts(self) -> None:
        files = parse_patch(
            """diff --git a/review.py b/review.py
@@ -1 +1,2 @@
 print("old")
+print("new")
""",
            parse_numstat("1\t0\treview.py"),
        )

        snapshot = build_pull_request_snapshot(
            ref=PullRequestRef(
                provider="github",
                owner="acme",
                repo="heimdall",
                number=42,
                url="https://github.com/acme/heimdall/pull/42",
            ),
            remote_url="https://github.com/acme/heimdall.git",
            default_branch="main",
            base_sha="aaaaaaaa",
            head_sha="bbbbbbbb",
            merge_base_sha="cccccccc",
            files=files,
        )

        self.assertEqual(snapshot.repository.id, "repo_github_acme_heimdall")
        self.assertEqual(snapshot.change_request.id, "cr_github_acme_heimdall_42")
        self.assertEqual(snapshot.diff.summary.languages, ["Python"])


def create_remote_with_pull_ref(root: Path) -> Path:
    worktree = root / "worktree"
    remote = root / "remote.git"
    run(["git", "init", str(worktree)])
    run(["git", "-C", str(worktree), "config", "user.email", "dev@example.com"])
    run(["git", "-C", str(worktree), "config", "user.name", "Dev"])
    (worktree / "review.py").write_text('print("old")\n', encoding="utf-8")
    run(["git", "-C", str(worktree), "add", "review.py"])
    run(["git", "-C", str(worktree), "commit", "-m", "base"])
    run(["git", "-C", str(worktree), "branch", "-M", "main"])
    base_sha = run(["git", "-C", str(worktree), "rev-parse", "HEAD"])
    (worktree / "review.py").write_text('print("old")\nprint("new")\n', encoding="utf-8")
    run(["git", "-C", str(worktree), "commit", "-am", "pr"])
    head_sha = run(["git", "-C", str(worktree), "rev-parse", "HEAD"])
    run(["git", "init", "--bare", str(remote)])
    run(["git", "-C", str(worktree), "remote", "add", "origin", str(remote)])
    run(["git", "-C", str(worktree), "push", "origin", f"{base_sha}:refs/heads/main"])
    run(["git", "-C", str(worktree), "push", "origin", f"{head_sha}:refs/pull/42/head"])
    run(["git", "--git-dir", str(remote), "symbolic-ref", "HEAD", "refs/heads/main"])
    return remote


def run(command: list[str]) -> str:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise AssertionError(f"{' '.join(command)} failed: {result.stderr}")
    return result.stdout.strip()


if __name__ == "__main__":
    unittest.main()
