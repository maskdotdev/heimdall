from __future__ import annotations

import json
import os
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from contract_types import (
    ModelMetadata,
    ReviewerOutput,
    from_json,
)

from .ports import ReviewRequest
from .context_ranking import rank_changed_files, rank_source_snippets
from .reviewer_output_schema import reviewer_output_response_format


Transport = Callable[[str, dict[str, str], dict[str, Any]], dict[str, Any]]
PROMPT_VERSION = "baseline-reviewer-v1"
REVIEW_TEMPERATURE = 0.1
MAX_PROMPT_FILES = 80
MAX_PROMPT_SNIPPETS = 50
MAX_PROMPT_RELATED_SNIPPETS = 16
PROMPT_JSON_SEPARATORS = (",", ":")
PROMPT_JSON_INDENT = 0
SYSTEM_PROMPT = (
    "You are Heimdall's code reviewer. The API enforces the reviewer output JSON schema. "
    'schemaVersion must be exactly "1.0.0". Review only the changed files, changed hunks, source snippets, '
    "dependency frontier, scanner signals, review standards, and related tests provided in the request. Do not report "
    "issues that "
    "are merely possible, pre-existing, outside the supplied changed-code context, or unsupported by concrete "
    "evidence. Every finding must describe a real correctness, security, reliability, performance, "
    "maintainability, test, documentation, accessibility, style, or other issue that a maintainer could act on. "
    "Prefer no finding over a speculative finding. When no concrete issue is supported by the supplied context, "
    'return {"schemaVersion":"1.0.0","summary":"No supported findings.","findings":[]}. '
    "Use only these finding categories: correctness, security, reliability, performance, maintainability, test, "
    "style, documentation, accessibility, other. Use only these severities: critical, high, medium, low, info. "
    "Use only these confidence values: high, medium, low. Every finding must include at least one evidence item "
    "with kind diff-line, source-snippet, scanner-signal, dependency-edge, test-signal, review-standard, or other. "
    "Evidence must identify the exact changed file and line whenever a line is available. Do not include secrets, "
    "tokens, private keys, or raw sensitive provider payloads in the response. Before finalizing, enumerate distinct "
    "root causes introduced by the change and keep each independently actionable issue as a separate finding when it "
    "has concrete changed-code evidence."
)


class ReviewerRefusalError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class OpenAICompatibleConfig:
    base_url: str
    api_key: str
    model: str

    @classmethod
    def from_env(cls) -> OpenAICompatibleConfig:
        base_url = os.environ.get("HEIMDALL_LLM_BASE_URL", "").rstrip("/")
        api_key = os.environ.get("HEIMDALL_LLM_API_KEY", "")
        model = os.environ.get("HEIMDALL_LLM_MODEL", "")
        if not base_url or not api_key or not model:
            raise ValueError("HEIMDALL_LLM_BASE_URL, HEIMDALL_LLM_API_KEY, and HEIMDALL_LLM_MODEL are required")
        return cls(base_url=base_url, api_key=api_key, model=model)


@dataclass(frozen=True, slots=True)
class PromptBuild:
    prompt: str
    review_context: dict[str, Any]
    context_json: str


class OpenAICompatibleReviewerProvider:
    def __init__(self, config: OpenAICompatibleConfig, transport: Transport | None = None) -> None:
        self.config = config
        self.transport = transport or urlopen_transport

    def review(self, request: ReviewRequest) -> ReviewerOutput:
        endpoint = f"{self.config.base_url}/chat/completions"
        response = self.transport(
            endpoint,
            {"authorization": f"Bearer {self.config.api_key}", "content-type": "application/json"},
            {
                "model": self.config.model,
                "temperature": REVIEW_TEMPERATURE,
                "response_format": reviewer_output_response_format(),
                "messages": [
                    {
                        "role": "system",
                        "content": SYSTEM_PROMPT,
                    },
                    {"role": "user", "content": build_prompt(request)},
                ],
            },
        )
        message = response["choices"][0]["message"]
        refusal = message.get("refusal")
        if refusal:
            raise ReviewerRefusalError(f"reviewer model refused the request: {refusal}")
        content = message["content"]
        output = from_json(ReviewerOutput, json.loads(content))
        output.modelMetadata = output.modelMetadata or ModelMetadata()
        output.modelMetadata.provider = "openai-compatible"
        output.modelMetadata.model = self.config.model
        output.modelMetadata.temperature = REVIEW_TEMPERATURE
        output.modelMetadata.promptVersion = PROMPT_VERSION
        return output


def urlopen_transport(endpoint: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def build_prompt(request: ReviewRequest, *, max_files: int = MAX_PROMPT_FILES, max_snippets: int = MAX_PROMPT_SNIPPETS) -> str:
    return build_prompt_with_context(request, max_files=max_files, max_snippets=max_snippets).prompt


def build_prompt_with_context(
    request: ReviewRequest,
    *,
    max_files: int = MAX_PROMPT_FILES,
    max_snippets: int = MAX_PROMPT_SNIPPETS,
) -> PromptBuild:
    review_context = build_review_context(request, max_files=max_files, max_snippets=max_snippets)
    context_json = json.dumps(
        review_context,
        indent=PROMPT_JSON_INDENT,
        separators=PROMPT_JSON_SEPARATORS,
        sort_keys=True,
    )
    prompt = (
        "Review the following condensed JSON context.\n\n"
        f"{context_json}\n\n"
        "Output requirements:\n"
        '- Return exactly one JSON object with keys "schemaVersion", "summary", "findings", and optional "modelMetadata".\n'
        '- The "schemaVersion" value must be "1.0.0".\n'
        "- Findings must include title, body, category, severity, confidence, and evidence.\n"
        "- Evidence must include kind and summary, and should include location.path and location.startLine when tied to a changed line.\n"
        "- Only report findings supported by the changedFiles, dependencyFrontier, relatedTests, scannerSignals, "
        "or sourceSnippets above.\n"
        "- Use dependencyFrontier and relatedTests as repository exploration evidence, but findings must still point to changed code.\n"
        "- Check changed code for contract changes, state transitions, shared mutable state, persistence effects, external API effects, input validation, error paths, resource lifetimes, ordering assumptions, data-shape assumptions, and test assertions that no longer prove the changed behavior.\n"
        "- Look for multiple independent root causes before returning. Do not collapse unrelated defects into one finding, and do not stop after the first valid finding when other changed hunks prove separate issues.\n"
        "- Return an empty findings array when the context does not prove a concrete issue.\n"
        "- Set modelMetadata to null; Heimdall fills provider metadata after parsing."
    )
    return PromptBuild(prompt=prompt, review_context=review_context, context_json=context_json)


def build_review_context(request: ReviewRequest, *, max_files: int = MAX_PROMPT_FILES, max_snippets: int = MAX_PROMPT_SNIPPETS) -> dict[str, Any]:
    bundle = request.context_bundle
    ranked_files = rank_changed_files(list(bundle.diff.files))
    ranked_path_index = {file.path: index for index, file in enumerate(ranked_files)}
    changed_files = [summarize_changed_file(file) for file in ranked_files[:max_files]]
    ranked_snippets = rank_source_snippets(list(bundle.sourceSnippets or []), ranked_path_index)
    selected_snippets = select_prompt_snippets(ranked_snippets, max_snippets=max_snippets)
    snippets = [
        {
            "path": snippet.location.path,
            "startLine": snippet.location.startLine,
            "endLine": snippet.location.endLine,
            "reason": snippet.reason,
            "content": snippet.content,
        }
        for snippet in selected_snippets
    ]
    scanner_signals = [
        {
            "tool": signal.tool,
            "ruleId": signal.ruleId,
            "severity": signal.severity,
            "message": signal.message,
            "location": (
                {
                    "path": signal.location.path,
                    "startLine": signal.location.startLine,
                    "endLine": signal.location.endLine,
                }
                if signal.location is not None
                else None
            ),
        }
        for signal in bundle.scannerSignals or []
    ]
    dependency_frontier = [
        {
            "kind": item.kind,
            "path": item.path,
            "symbolName": item.symbolName,
            "reason": item.reason,
            "confidence": item.confidence,
        }
        for item in bundle.dependencyFrontier or []
    ]
    related_tests = [
        {
            "path": item.path,
            "reason": item.reason,
            "confidence": item.confidence,
        }
        for item in bundle.relatedTests or []
    ]
    review_context = {
        "reviewRunId": bundle.reviewRunId,
        "changeRequest": {
            "id": bundle.changeRequest.id,
            "title": bundle.changeRequest.title,
            "provider": bundle.changeRequest.provider,
        },
        "limits": {
            "truncated": bundle.limits.truncated,
            "truncationReasons": bundle.limits.truncationReasons or [],
            "diffFileCount": len(bundle.diff.files),
            "includedChangedFileCount": len(changed_files),
            "sourceSnippetCount": len(bundle.sourceSnippets or []),
            "includedSourceSnippetCount": len(snippets),
            "includedRelatedSnippetCount": len(
                [snippet for snippet in selected_snippets if snippet.reason != "changed-file"]
            ),
            "dependencyFrontierCount": len(bundle.dependencyFrontier or []),
            "relatedTestCount": len(bundle.relatedTests or []),
            "scannerSignalCount": len(bundle.scannerSignals or []),
        },
        "changedFiles": changed_files,
        "dependencyFrontier": dependency_frontier,
        "relatedTests": related_tests,
        "scannerSignals": scanner_signals,
        "sourceSnippets": snippets,
    }
    return review_context


def prompt_input_profile(prompt: str, build: PromptBuild) -> dict[str, int]:
    review_context = build.review_context
    changed_line_profile = changed_file_line_profile(review_context.get("changedFiles"))
    return {
        "promptChars": len(prompt),
        "promptBytes": len(prompt.encode("utf-8")),
        "reviewPromptChars": len(build.prompt),
        "contextJsonChars": len(build.context_json),
        "changedFilesChars": json_section_chars(review_context.get("changedFiles")),
        "sourceSnippetsChars": json_section_chars(review_context.get("sourceSnippets")),
        "dependencyFrontierChars": json_section_chars(review_context.get("dependencyFrontier")),
        "relatedTestsChars": json_section_chars(review_context.get("relatedTests")),
        "scannerSignalsChars": json_section_chars(review_context.get("scannerSignals")),
        "includedChangedFileCount": int(review_context["limits"]["includedChangedFileCount"]),
        "includedSourceSnippetCount": int(review_context["limits"]["includedSourceSnippetCount"]),
        "includedRelatedSnippetCount": int(review_context["limits"]["includedRelatedSnippetCount"]),
        "diffFileCount": int(review_context["limits"]["diffFileCount"]),
        **changed_line_profile,
    }


def json_section_chars(value: Any) -> int:
    return len(
        json.dumps(
            value,
            indent=PROMPT_JSON_INDENT,
            separators=PROMPT_JSON_SEPARATORS,
            sort_keys=True,
        )
    )


def changed_file_line_profile(value: Any) -> dict[str, int]:
    counts = {"changedLineCount": 0, "addedLineCount": 0, "deletedLineCount": 0, "contextLineCount": 0}
    chars = {"changedLineChars": 0, "addedLineChars": 0, "deletedLineChars": 0, "contextLineChars": 0}
    if not isinstance(value, list):
        return {**counts, **chars}

    for changed_file in value:
        if not isinstance(changed_file, dict):
            continue
        hunks = changed_file.get("hunks")
        if not isinstance(hunks, list):
            continue
        for hunk in hunks:
            if not isinstance(hunk, dict):
                continue
            lines = hunk.get("lines")
            if not isinstance(lines, list):
                continue
            for line in lines:
                if not isinstance(line, dict):
                    continue
                kind = line.get("kind")
                content = line.get("content")
                if not isinstance(kind, str) or not isinstance(content, str):
                    continue
                counts["changedLineCount"] += 1
                chars["changedLineChars"] += len(content)
                if kind == "added":
                    counts["addedLineCount"] += 1
                    chars["addedLineChars"] += len(content)
                elif kind == "deleted":
                    counts["deletedLineCount"] += 1
                    chars["deletedLineChars"] += len(content)
                elif kind == "context":
                    counts["contextLineCount"] += 1
                    chars["contextLineChars"] += len(content)
    return {**counts, **chars}


def summarize_changed_file(changed_file: Any) -> dict[str, Any]:
    return {
        "path": changed_file.path,
        "status": changed_file.status,
        "language": changed_file.language,
        "additions": changed_file.additions,
        "deletions": changed_file.deletions,
        "hunks": [
            {
                "oldStart": hunk.oldStart,
                "oldLines": hunk.oldLines,
                "newStart": hunk.newStart,
                "newLines": hunk.newLines,
                "lines": [
                    summarize_diff_line(line)
                    for line in hunk.lines
                    if line.kind in ("context", "added", "deleted")
                ],
            }
            for hunk in changed_file.hunks
        ],
    }


def summarize_diff_line(line: Any) -> dict[str, Any]:
    summary = {
        "kind": line.kind,
        "content": line.content,
    }
    if line.oldLine is not None:
        summary["oldLine"] = line.oldLine
    if line.newLine is not None:
        summary["newLine"] = line.newLine
    return summary


def select_prompt_snippets(snippets: list[Any], *, max_snippets: int) -> list[Any]:
    if max_snippets <= 0:
        return []

    related = [snippet for snippet in snippets if snippet.reason != "changed-file"]
    if not related:
        return snippets[:max_snippets]

    related_budget = min(MAX_PROMPT_RELATED_SNIPPETS, max(max_snippets // 3, 1), len(related))
    changed_budget = max_snippets - related_budget
    selected = [snippet for snippet in snippets if snippet.reason == "changed-file"][:changed_budget]
    selected.extend(select_related_prompt_snippets(related, max_snippets=max_snippets - len(selected)))
    return selected


def select_related_prompt_snippets(snippets: list[Any], *, max_snippets: int) -> list[Any]:
    selected: list[Any] = []
    for reason in ("dependency", "test", "related-symbol"):
        for snippet in snippets:
            if len(selected) >= max_snippets:
                return selected
            if snippet.reason == reason and snippet not in selected:
                selected.append(snippet)
    for snippet in snippets:
        if len(selected) >= max_snippets:
            return selected
        if snippet not in selected:
            selected.append(snippet)
    return selected
