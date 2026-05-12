from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from contract_types import ChangedFile, DiffHunk, DiffLine


def parse_numstat(value: str) -> dict[str, tuple[int, int]]:
    stats: dict[str, tuple[int, int]] = {}
    for line in value.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        additions = 0 if parts[0] == "-" else int(parts[0])
        deletions = 0 if parts[1] == "-" else int(parts[1])
        path = _normalize_numstat_path(parts[-1])
        stats[path] = (additions, deletions)
    return stats


def parse_patch(patch: str, stats: dict[str, tuple[int, int]]) -> list[ChangedFile]:
    files: list[ChangedFile] = []
    current: _PatchFile | None = None
    current_hunk: DiffHunk | None = None
    old_line = 0
    new_line = 0

    for line in patch.splitlines():
        if line.startswith("diff --git "):
            if current is not None:
                files.append(current.to_changed_file(stats))
            current = _PatchFile.from_diff_header(line)
            current_hunk = None
            continue

        if current is None:
            continue

        if line.startswith("new file mode"):
            current.status = "added"
            continue
        if line.startswith("deleted file mode"):
            current.status = "deleted"
            continue
        if line.startswith("rename from "):
            current.previous_path = line.removeprefix("rename from ")
            current.status = "renamed"
            continue
        if line.startswith("rename to "):
            current.path = line.removeprefix("rename to ")
            current.status = "renamed"
            continue
        if line.startswith("@@ "):
            old_start, old_count, new_start, new_count = _parse_hunk_header(line)
            current_hunk = DiffHunk(
                oldStart=old_start,
                oldLines=old_count,
                newStart=new_start,
                newLines=new_count,
                lines=[],
                header=line,
            )
            current.hunks.append(current_hunk)
            old_line = old_start
            new_line = new_start
            continue
        if current_hunk is None or line.startswith(("+++", "---")):
            continue
        if line.startswith(" "):
            current_hunk.lines.append(DiffLine(kind="context", oldLine=old_line, newLine=new_line, content=line[1:]))
            old_line += 1
            new_line += 1
        elif line.startswith("+"):
            current_hunk.lines.append(DiffLine(kind="added", newLine=new_line, content=line[1:]))
            new_line += 1
        elif line.startswith("-"):
            current_hunk.lines.append(DiffLine(kind="deleted", oldLine=old_line, content=line[1:]))
            old_line += 1

    if current is not None:
        files.append(current.to_changed_file(stats))
    return files


@dataclass(slots=True)
class _PatchFile:
    path: str
    status: str
    hunks: list[DiffHunk]
    previous_path: str | None = None

    @classmethod
    def from_diff_header(cls, line: str) -> _PatchFile:
        parts = line.split()
        old_path = parts[2].removeprefix("a/")
        new_path = parts[3].removeprefix("b/")
        status = "modified"
        if old_path == "/dev/null":
            status = "added"
        elif new_path == "/dev/null":
            status = "deleted"
        return cls(path=new_path if new_path != "/dev/null" else old_path, status=status, hunks=[])

    def to_changed_file(self, stats: dict[str, tuple[int, int]]) -> ChangedFile:
        additions, deletions = stats.get(self.path, (0, 0))
        return ChangedFile(
            path=self.path,
            previousPath=self.previous_path,
            status=self.status,
            language=_language_for_path(self.path),
            additions=additions,
            deletions=deletions,
            hunks=self.hunks,
        )


def _parse_hunk_header(header: str) -> tuple[int, int, int, int]:
    match = re.match(r"@@ -(?P<old_start>\d+)(,(?P<old_count>\d+))? \+(?P<new_start>\d+)(,(?P<new_count>\d+))?", header)
    if match is None:
        raise ValueError(f"invalid hunk header: {header}")
    return (
        int(match.group("old_start")),
        int(match.group("old_count") or "1"),
        int(match.group("new_start")),
        int(match.group("new_count") or "1"),
    )


def _normalize_numstat_path(path: str) -> str:
    if " => " not in path:
        return path
    renamed = path.split(" => ", maxsplit=1)[1]
    return renamed.replace("{", "").replace("}", "")


def _language_for_path(path: str) -> str | None:
    suffix = Path(path).suffix.lower()
    return {
        ".go": "Go",
        ".js": "JavaScript",
        ".jsx": "JavaScript",
        ".md": "Markdown",
        ".py": "Python",
        ".ts": "TypeScript",
        ".tsx": "TypeScript",
    }.get(suffix)
