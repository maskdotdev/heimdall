from __future__ import annotations

from dataclasses import dataclass

from contract_types import (
    ChangeRequest,
    ContextBundle,
    ContextLimits,
    Diff,
    RedactionSummary,
    SourceLocation,
    SourceSnippet,
)


@dataclass(frozen=True, slots=True)
class DiffContextOptions:
    max_files: int = 50
    max_bytes: int = 200_000
    max_snippet_bytes: int = 40_000


def build_diff_context_bundle(
    review_run_id: str,
    change_request: ChangeRequest,
    diff: Diff,
    options: DiffContextOptions | None = None,
) -> ContextBundle:
    opts = options or DiffContextOptions()
    snippets: list[SourceSnippet] = []
    used_bytes = 0
    truncated = False
    truncation_reasons: list[str] = []

    for changed_file in diff.files[: opts.max_files]:
        for hunk in changed_file.hunks:
            content = "\n".join(line.content for line in hunk.lines if line.kind in ("context", "added"))
            if not content:
                continue
            encoded_size = len(content.encode("utf-8"))
            if encoded_size > opts.max_snippet_bytes:
                content = content.encode("utf-8")[: opts.max_snippet_bytes].decode("utf-8", errors="ignore")
                encoded_size = len(content.encode("utf-8"))
                truncated = True
                truncation_reasons.append("snippet-size-limit")
            if used_bytes + encoded_size > opts.max_bytes:
                truncated = True
                truncation_reasons.append("bundle-size-limit")
                break

            snippets.append(
                SourceSnippet(
                    location=SourceLocation(
                        path=changed_file.path,
                        startLine=hunk.newStart if hunk.newStart > 0 else None,
                        endLine=(hunk.newStart + max(hunk.newLines - 1, 0)) if hunk.newStart > 0 else None,
                        commitSha=diff.headSha,
                    ),
                    content=content,
                    reason="changed-file",
                )
            )
            used_bytes += encoded_size

    if len(diff.files) > opts.max_files:
        truncated = True
        truncation_reasons.append("file-count-limit")

    return ContextBundle(
        schemaVersion="1.0.0",
        id=f"ctx_{review_run_id}",
        reviewRunId=review_run_id,
        changeRequest=change_request,
        diff=diff,
        sourceSnippets=snippets,
        limits=ContextLimits(
            maxFiles=opts.max_files,
            maxBytes=opts.max_bytes,
            maxSnippetBytes=opts.max_snippet_bytes,
            truncated=truncated,
            truncationReasons=sorted(set(truncation_reasons)) or None,
        ),
        redaction=RedactionSummary(redacted=False, strategy="none"),
    )
