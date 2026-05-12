from __future__ import annotations

import re

from contract_types import ChangeRef, ChangeRequest, ChangedFile, Diff, DiffSummary, RedactionSummary, Repository

from .ports import PullRequestRef, PullRequestSnapshot


def build_pull_request_snapshot(
    ref: PullRequestRef,
    remote_url: str,
    default_branch: str,
    base_sha: str,
    head_sha: str,
    merge_base_sha: str,
    files: list[ChangedFile],
) -> PullRequestSnapshot:
    repository_id = resource_id("repo", ref.provider, ref.owner, ref.repo)
    change_request_id = resource_id("cr", ref.provider, ref.owner, ref.repo, str(ref.number))
    repository = Repository(
        schemaVersion="1.0.0",
        id=repository_id,
        provider="github",
        owner=ref.owner,
        name=ref.repo,
        defaultBranch=default_branch,
        fullName=f"{ref.owner}/{ref.repo}",
        cloneUrl=remote_url if remote_url.startswith(("https://", "file://")) else None,
        webUrl=f"https://github.com/{ref.owner}/{ref.repo}",
        redaction=RedactionSummary(redacted=False, strategy="none"),
    )
    change_request = ChangeRequest(
        schemaVersion="1.0.0",
        id=change_request_id,
        repository=repository,
        provider="github",
        providerChangeRequestId=str(ref.number),
        title=f"GitHub PR #{ref.number}",
        state="open",
        base=ChangeRef(repositoryId=repository_id, ref=default_branch, sha=base_sha),
        head=ChangeRef(repositoryId=repository_id, ref=f"pull/{ref.number}/head", sha=head_sha),
        number=ref.number,
        webUrl=ref.url,
        redaction=RedactionSummary(redacted=False, strategy="none"),
    )
    diff = Diff(
        schemaVersion="1.0.0",
        id=resource_id("diff", ref.provider, ref.owner, ref.repo, str(ref.number)),
        changeRequestId=change_request_id,
        baseSha=base_sha,
        headSha=head_sha,
        mergeBaseSha=merge_base_sha,
        summary=DiffSummary(
            fileCount=len(files),
            additions=sum(file.additions for file in files),
            deletions=sum(file.deletions for file in files),
            languages=sorted({file.language for file in files if file.language}) or None,
        ),
        files=files,
        truncated=False,
        redaction=RedactionSummary(redacted=False, strategy="none"),
    )
    return PullRequestSnapshot(repository=repository, change_request=change_request, diff=diff)


def resource_id(prefix: str, *parts: str) -> str:
    value = "_".join([prefix, *parts])
    return re.sub(r"[^A-Za-z0-9_.:-]", "_", value)
