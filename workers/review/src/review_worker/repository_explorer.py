from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from contract_types import Diff, FrontierItem, RelatedTestRef, SourceLocation, SourceSnippet


SOURCE_SUFFIXES = {
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
SKIPPED_DIRS = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
}
COMMON_IDENTIFIERS = {
    "and",
    "args",
    "async",
    "await",
    "bool",
    "case",
    "class",
    "const",
    "data",
    "dict",
    "else",
    "false",
    "from",
    "func",
    "function",
    "interface",
    "list",
    "none",
    "null",
    "return",
    "self",
    "str",
    "this",
    "true",
    "type",
    "value",
    "with",
}
DEFINITION_PATTERNS = (
    re.compile(r"\b(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)"),
    re.compile(r"\b(?:function|interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]"),
    re.compile(r"\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)"),
    re.compile(r"\b(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)"),
    re.compile(r"\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[A-Za-z0-9_<>,.?[\] ]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\("),
)
CALL_PATTERN = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]{3,})\s*\(")
IDENTIFIER_PATTERN = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b")
MAX_ENCLOSING_SYMBOL_LINES = 80


@dataclass(frozen=True, slots=True)
class RepositoryExplorationOptions:
    root: Path
    max_files_scanned: int = 2_000
    max_file_bytes: int = 200_000
    max_symbols: int = 16
    max_related_snippets: int = 12
    max_related_tests: int = 8
    max_related_bytes: int = 80_000
    snippet_radius: int = 4


@dataclass(frozen=True, slots=True)
class RepositoryExplorationResult:
    source_snippets: list[SourceSnippet]
    dependency_frontier: list[FrontierItem]
    related_tests: list[RelatedTestRef]
    truncated: bool = False
    truncation_reasons: tuple[str, ...] = ()


def explore_repository_context(diff: Diff, options: RepositoryExplorationOptions) -> RepositoryExplorationResult:
    if not options.root.is_dir():
        return RepositoryExplorationResult([], [], [])

    changed_paths = {file.path for file in diff.files}
    symbols = _extract_changed_symbols(diff, max_symbols=options.max_symbols)
    if not symbols:
        return RepositoryExplorationResult([], [], [])

    files, file_scan_truncated = _bounded_repository_files(options.root, options.max_files_scanned)
    source_snippets: list[SourceSnippet] = []
    dependency_frontier: list[FrontierItem] = []
    related_tests: list[RelatedTestRef] = []
    used_bytes = 0
    truncated = file_scan_truncated
    truncation_reasons: list[str] = ["repository-file-scan-limit"] if file_scan_truncated else []
    seen_snippets: set[tuple[str, int | None, str | None]] = set()

    for changed_file in diff.files:
        changed_path = options.root / changed_file.path
        if len(source_snippets) >= options.max_related_snippets or not changed_path.is_file():
            continue
        try:
            content = changed_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for line_number in _changed_line_numbers(changed_file):
            if len(source_snippets) >= options.max_related_snippets:
                break
            snippet = _enclosing_symbol_snippet(changed_path, options.root, content, line_number, diff.headSha)
            if snippet is None:
                continue
            used_bytes = _append_snippet_with_budget(
                source_snippets,
                seen_snippets,
                snippet,
                used_bytes,
                options.max_related_bytes,
            )
            if used_bytes < 0:
                truncated = True
                truncation_reasons.append("repository-context-size-limit")
                used_bytes = options.max_related_bytes
                break
        if used_bytes >= options.max_related_bytes:
            break

    for path in files:
        relative_path = _relative_posix_path(path, options.root)
        if relative_path in changed_paths:
            continue
        if path.stat().st_size > options.max_file_bytes:
            truncated = True
            truncation_reasons.append("repository-file-size-limit")
            continue

        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        matched_symbol = _first_matching_symbol(content, symbols)
        if matched_symbol is None:
            continue

        if _is_test_path(relative_path):
            if len(related_tests) < options.max_related_tests:
                related_tests.append(
                    RelatedTestRef(
                        path=relative_path,
                        reason=f"mentions changed identifier {matched_symbol}",
                        confidence="medium",
                    )
            )
            if len(source_snippets) < options.max_related_snippets:
                snippet = _snippet_for_match(
                    path,
                    options.root,
                    content,
                    matched_symbol,
                    diff.headSha,
                    "test",
                    options.snippet_radius,
                )
                used_bytes = _append_snippet_with_budget(
                    source_snippets,
                    seen_snippets,
                    snippet,
                    used_bytes,
                    options.max_related_bytes,
                )
                if used_bytes < 0:
                    truncated = True
                    truncation_reasons.append("repository-context-size-limit")
                    used_bytes = options.max_related_bytes
                    break
            continue

        definition_symbol = _first_defined_symbol(content, symbols)
        matched_symbol = definition_symbol or matched_symbol
        if len(dependency_frontier) < options.max_related_snippets:
            dependency_frontier.append(
                FrontierItem(
                    kind="symbol" if definition_symbol is not None or _looks_like_symbol_file(relative_path) else "file",
                    path=relative_path,
                    symbolName=matched_symbol,
                    reason=(
                        f"repository file defines changed identifier {matched_symbol}"
                        if definition_symbol is not None
                        else f"repository file mentions changed identifier {matched_symbol}"
                    ),
                    confidence="medium",
                )
            )
        if len(source_snippets) < options.max_related_snippets:
            reason = "dependency" if definition_symbol is not None or _looks_like_symbol_file(relative_path) else "related-symbol"
            snippet = (
                _snippet_for_definition(path, options.root, content, matched_symbol, diff.headSha)
                if definition_symbol is not None
                else _snippet_for_match(
                    path,
                    options.root,
                    content,
                    matched_symbol,
                    diff.headSha,
                    reason,
                    options.snippet_radius,
                )
            )
            used_bytes = _append_snippet_with_budget(
                source_snippets,
                seen_snippets,
                snippet,
                used_bytes,
                options.max_related_bytes,
            )
            if used_bytes < 0:
                truncated = True
                truncation_reasons.append("repository-context-size-limit")
                used_bytes = options.max_related_bytes
                break

        if len(source_snippets) >= options.max_related_snippets and len(related_tests) >= options.max_related_tests:
            break

    return RepositoryExplorationResult(
        source_snippets=source_snippets,
        dependency_frontier=dependency_frontier,
        related_tests=related_tests,
        truncated=truncated,
        truncation_reasons=tuple(sorted(set(truncation_reasons))),
    )


def _extract_changed_symbols(diff: Diff, *, max_symbols: int) -> list[str]:
    scores: dict[str, int] = {}
    for changed_file in diff.files:
        for hunk in changed_file.hunks:
            for line in hunk.lines:
                if line.kind not in {"added", "context"}:
                    continue
                content = line.content
                for pattern in DEFINITION_PATTERNS:
                    for match in pattern.finditer(content):
                        _score_symbol(scores, match.group(1), 6)
                for match in CALL_PATTERN.finditer(content):
                    _score_symbol(scores, match.group(1), 2)
                for symbol in IDENTIFIER_PATTERN.findall(content):
                    _score_symbol(scores, symbol, 1)
    return [symbol for symbol, _ in sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:max_symbols]]


def _score_symbol(scores: dict[str, int], symbol: str, score: int) -> None:
    normalized = symbol.strip()
    if len(normalized) < 4 or normalized.casefold() in COMMON_IDENTIFIERS:
        return
    scores[normalized] = scores.get(normalized, 0) + score


def _bounded_repository_files(root: Path, max_files: int) -> tuple[list[Path], bool]:
    files: list[Path] = []
    truncated = False
    for directory, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in SKIPPED_DIRS)
        for filename in sorted(filenames):
            if len(files) >= max_files:
                truncated = True
                break
            path = Path(directory) / filename
            if path.suffix not in SOURCE_SUFFIXES:
                continue
            files.append(path)
        if truncated:
            break
    return sorted(files, key=lambda item: _relative_posix_path(item, root)), truncated


def _first_matching_symbol(content: str, symbols: list[str]) -> str | None:
    for symbol in symbols:
        if re.search(rf"\b{re.escape(symbol)}\b", content):
            return symbol
    return None


def _first_defined_symbol(content: str, symbols: list[str]) -> str | None:
    symbol_set = set(symbols)
    for line in content.splitlines():
        for pattern in DEFINITION_PATTERNS:
            match = pattern.search(line)
            if match is not None and match.group(1) in symbol_set:
                return match.group(1)
    return None


def _snippet_for_match(path: Path, root: Path, content: str, symbol: str, commit_sha: str, reason: str, radius: int) -> SourceSnippet:
    lines = content.splitlines()
    match_index = next((index for index, line in enumerate(lines) if re.search(rf"\b{re.escape(symbol)}\b", line)), 0)
    start = max(match_index - radius, 0)
    end = min(match_index + radius + 1, len(lines))
    return SourceSnippet(
        location=SourceLocation(
            path=_relative_posix_path(path, root),
            startLine=start + 1,
            endLine=end,
            commitSha=commit_sha,
        ),
        content="\n".join(lines[start:end]),
        reason=reason,
    )


def _snippet_for_definition(path: Path, root: Path, content: str, symbol: str, commit_sha: str) -> SourceSnippet:
    lines = content.splitlines()
    match_index = _definition_line_index(lines, symbol) or 0
    start = max(match_index - 4, 0)
    end = min(match_index + 12, len(lines))
    return SourceSnippet(
        location=SourceLocation(
            path=_relative_posix_path(path, root),
            startLine=start + 1,
            endLine=end,
            commitSha=commit_sha,
        ),
        content="\n".join(lines[start:end]),
        reason="dependency",
    )


def _enclosing_symbol_snippet(path: Path, root: Path, content: str, line_number: int, commit_sha: str) -> SourceSnippet | None:
    lines = content.splitlines()
    if line_number < 1 or line_number > len(lines):
        return None

    changed_index = line_number - 1
    start = _nearest_definition_start(lines, changed_index)
    if start is None:
        start = max(changed_index - 8, 0)
    end = _next_definition_start(lines, start + 1)
    if end is None or end <= changed_index:
        end = min(start + MAX_ENCLOSING_SYMBOL_LINES, len(lines))
    end = min(end, len(lines), max(changed_index + 8, start + 1))
    return SourceSnippet(
        location=SourceLocation(
            path=_relative_posix_path(path, root),
            startLine=start + 1,
            endLine=end,
            commitSha=commit_sha,
        ),
        content="\n".join(lines[start:end]),
        reason="related-symbol",
    )


def _changed_line_numbers(changed_file) -> list[int]:
    result: list[int] = []
    for hunk in changed_file.hunks:
        for line in hunk.lines:
            if line.kind == "added" and line.newLine is not None:
                result.append(line.newLine)
    return result


def _definition_line_index(lines: list[str], symbol: str) -> int | None:
    for index, line in enumerate(lines):
        for pattern in DEFINITION_PATTERNS:
            match = pattern.search(line)
            if match is not None and match.group(1) == symbol:
                return index
    return None


def _nearest_definition_start(lines: list[str], changed_index: int) -> int | None:
    for index in range(changed_index, -1, -1):
        if _line_defines_symbol(lines[index]):
            return index
    return None


def _next_definition_start(lines: list[str], start_index: int) -> int | None:
    for index in range(start_index, len(lines)):
        if _line_defines_symbol(lines[index]):
            return index
    return None


def _line_defines_symbol(line: str) -> bool:
    return any(pattern.search(line) for pattern in DEFINITION_PATTERNS)


def _append_snippet_with_budget(
    snippets: list[SourceSnippet],
    seen: set[tuple[str, int | None, str | None]],
    snippet: SourceSnippet,
    used_bytes: int,
    max_bytes: int,
) -> int:
    key = (snippet.location.path, snippet.location.startLine, snippet.reason)
    if key in seen:
        return used_bytes
    snippet_bytes = len(snippet.content.encode("utf-8"))
    if used_bytes + snippet_bytes > max_bytes:
        return -1
    snippets.append(snippet)
    seen.add(key)
    return used_bytes + snippet_bytes


def _relative_posix_path(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _is_test_path(path: str) -> bool:
    normalized = f"/{path.casefold()}"
    return (
        "/test/" in normalized
        or "/tests/" in normalized
        or normalized.endswith("_test.go")
        or normalized.endswith("_test.py")
        or ".test." in normalized
        or ".spec." in normalized
    )


def _looks_like_symbol_file(path: str) -> bool:
    normalized = path.casefold()
    return any(term in normalized for term in ("schema", "type", "contract", "model", "serializer", "validator"))
