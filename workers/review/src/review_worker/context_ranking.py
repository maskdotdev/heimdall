from __future__ import annotations

from typing import Any


SOURCE_EXTENSIONS = {
    ".go",
    ".js",
    ".jsx",
    ".kt",
    ".py",
    ".rb",
    ".rs",
    ".ts",
    ".tsx",
}
HIGH_SIGNAL_PATH_TERMS = (
    "api",
    "auth",
    "bulk",
    "cache",
    "cursor",
    "delete",
    "endpoint",
    "error",
    "exception",
    "integration",
    "oauth",
    "pagination",
    "permission",
    "query",
    "response",
    "schema",
    "security",
    "serializer",
    "state",
    "token",
    "validator",
    "webhook",
    "workflow",
)
LOW_SIGNAL_PATH_TERMS = (
    "__snapshots__",
    ".generated.",
    "/assets/",
    "/docs/",
    "/fixtures/",
    "/generated/",
    "/migrations/",
    "/test/",
    "/tests/",
    "changelog",
    "package-lock",
    "pnpm-lock",
    "snapshot",
)
HIGH_SIGNAL_CODE_TERMS = (
    ".get(",
    "auth",
    "delete",
    "except",
    "exception",
    "none",
    "null",
    "permission",
    "raise",
    "response",
    "state",
    "token",
    "validate",
)


def rank_changed_files(changed_files: list[Any]) -> list[Any]:
    indexed_files = list(enumerate(changed_files))
    return [file for _, file in sorted(indexed_files, key=lambda item: (-score_changed_file(item[1]), item[0]))]


def rank_source_snippets(snippets: list[Any], changed_file_rank: dict[str, int]) -> list[Any]:
    indexed_snippets = list(enumerate(snippets))
    missing_path_rank = len(changed_file_rank) + len(indexed_snippets)
    return [
        snippet
        for _, snippet in sorted(
            indexed_snippets,
            key=lambda item: (
                changed_file_rank.get(item[1].location.path, missing_path_rank),
                item[1].location.startLine or 0,
                item[0],
            ),
        )
    ]


def score_changed_file(changed_file: Any) -> int:
    normalized_path = f"/{changed_file.path.casefold()}"
    score = 0

    if any(normalized_path.endswith(extension) for extension in SOURCE_EXTENSIONS):
        score += 20
    if any(term in normalized_path for term in LOW_SIGNAL_PATH_TERMS):
        score -= 14
    if "/test" in normalized_path or "_test." in normalized_path or "spec." in normalized_path:
        score -= 8

    for term in HIGH_SIGNAL_PATH_TERMS:
        if term in normalized_path:
            score += 6

    additions = int(changed_file.additions or 0)
    deletions = int(changed_file.deletions or 0)
    if additions and deletions:
        score += 5
    score += min(len(changed_file.hunks or []), 5)
    score += min(additions + deletions, 80) // 16
    score += score_changed_lines(changed_file)
    return score


def score_changed_lines(changed_file: Any) -> int:
    score = 0
    for hunk in changed_file.hunks or []:
        for line in hunk.lines:
            if line.kind not in ("added", "deleted"):
                continue
            content = line.content.casefold()
            for term in HIGH_SIGNAL_CODE_TERMS:
                if term in content:
                    score += 1
    return min(score, 12)

