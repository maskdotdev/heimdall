from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from contract_types import ChangeRequest, Diff, Repository


@dataclass(frozen=True, slots=True)
class PullRequestRef:
    provider: str
    owner: str
    repo: str
    number: int
    url: str
    remote_url: str | None = None


@dataclass(frozen=True, slots=True)
class PullRequestSnapshot:
    repository: Repository
    change_request: ChangeRequest
    diff: Diff


class PullRequestFetcher(Protocol):
    def fetch_pull_request(self, ref: PullRequestRef) -> PullRequestSnapshot:
        ...
