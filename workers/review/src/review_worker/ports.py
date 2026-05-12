from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from contract_types import ContextBundle, Finding, ReviewerOutput


@dataclass(frozen=True, slots=True)
class ReviewRequest:
    context_bundle: ContextBundle


@dataclass(frozen=True, slots=True)
class ReviewResult:
    raw_output: ReviewerOutput
    findings: tuple[Finding, ...]


class ReviewerProvider(Protocol):
    def review(self, request: ReviewRequest) -> ReviewerOutput:
        ...
