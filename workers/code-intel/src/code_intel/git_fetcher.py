from __future__ import annotations

import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .git_commands import GitCommandRunner
from .patch_parser import parse_numstat, parse_patch
from .ports import PullRequestRef, PullRequestSnapshot
from .snapshot_contracts import build_pull_request_snapshot


RemoteURLBuilder = Callable[[PullRequestRef], str]


@dataclass(frozen=True, slots=True)
class GitPullRequestFetcher:
    remote_url_builder: RemoteURLBuilder | None = None
    runner: GitCommandRunner = field(default_factory=GitCommandRunner)

    def fetch_pull_request(self, ref: PullRequestRef) -> PullRequestSnapshot:
        if ref.provider != "github":
            raise ValueError(f"unsupported provider: {ref.provider}")

        remote_url = ref.remote_url or self._remote_url(ref)
        with tempfile.TemporaryDirectory(prefix="heimdall-code-intel-") as temp_dir:
            repo_dir = Path(temp_dir) / "repo"
            self.runner.run(["git", "init", str(repo_dir)])
            self.runner.run(["git", "-C", str(repo_dir), "remote", "add", "origin", remote_url])

            default_branch = self.runner.default_branch(remote_url)
            self.runner.run(["git", "-C", str(repo_dir), "fetch", "origin", f"+refs/heads/{default_branch}:refs/remotes/origin/{default_branch}"])
            self.runner.run(["git", "-C", str(repo_dir), "fetch", "origin", f"+refs/pull/{ref.number}/head:refs/remotes/origin/pr/{ref.number}"])

            base_ref = f"refs/remotes/origin/{default_branch}"
            head_ref = f"refs/remotes/origin/pr/{ref.number}"
            base_sha = self.runner.run(["git", "-C", str(repo_dir), "rev-parse", base_ref])
            head_sha = self.runner.run(["git", "-C", str(repo_dir), "rev-parse", head_ref])
            merge_base_sha = self.runner.run(["git", "-C", str(repo_dir), "merge-base", base_ref, head_ref])
            patch = self.runner.run(["git", "-C", str(repo_dir), "diff", "--find-renames", "--patch", "--unified=3", merge_base_sha, head_sha])
            numstat = self.runner.run(["git", "-C", str(repo_dir), "diff", "--numstat", "--find-renames", merge_base_sha, head_sha])

        files = parse_patch(patch, parse_numstat(numstat))
        return build_pull_request_snapshot(
            ref=ref,
            remote_url=remote_url,
            default_branch=default_branch,
            base_sha=base_sha,
            head_sha=head_sha,
            merge_base_sha=merge_base_sha,
            files=files,
        )

    def _remote_url(self, ref: PullRequestRef) -> str:
        if self.remote_url_builder is not None:
            return self.remote_url_builder(ref)
        return f"https://github.com/{ref.owner}/{ref.repo}.git"
