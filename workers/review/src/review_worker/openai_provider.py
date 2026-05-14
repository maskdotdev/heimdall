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


Transport = Callable[[str, dict[str, str], dict[str, Any]], dict[str, Any]]
PROMPT_VERSION = "baseline-reviewer-v1"
REVIEW_TEMPERATURE = 0.1
SYSTEM_PROMPT = (
    "You are Heimdall's code reviewer. Return only valid JSON matching the reviewer output contract. "
    'schemaVersion must be exactly "1.0.0". Review only the changed files, changed hunks, source snippets, '
    "scanner signals, review standards, and related tests provided in the request. Do not report issues that "
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
    "tokens, private keys, or raw sensitive provider payloads in the response."
)


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
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": SYSTEM_PROMPT,
                    },
                    {"role": "user", "content": build_prompt(request)},
                ],
            },
        )
        content = response["choices"][0]["message"]["content"]
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


def build_prompt(request: ReviewRequest) -> str:
    bundle = request.context_bundle
    changed_files = [summarize_changed_file(file) for file in bundle.diff.files[:20]]
    snippets = [
        {
            "path": snippet.location.path,
            "startLine": snippet.location.startLine,
            "endLine": snippet.location.endLine,
            "reason": snippet.reason,
            "content": snippet.content,
        }
        for snippet in (bundle.sourceSnippets or [])[:10]
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
        },
        "changedFiles": changed_files,
        "sourceSnippets": snippets,
    }
    return (
        "Review the following JSON context.\n\n"
        f"{json.dumps(review_context, indent=2, sort_keys=True)}\n\n"
        "Output requirements:\n"
        '- Return exactly one JSON object with keys "schemaVersion", "summary", "findings", and optional "modelMetadata".\n'
        '- The "schemaVersion" value must be "1.0.0".\n'
        "- Findings must include title, body, category, severity, confidence, and evidence.\n"
        "- Evidence must include kind and summary, and should include location.path and location.startLine when tied to a changed line.\n"
        "- Only report findings supported by the changedFiles or sourceSnippets above.\n"
        "- Return an empty findings array when the context does not prove a concrete issue."
    )


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
                    {
                        "kind": line.kind,
                        "oldLine": line.oldLine,
                        "newLine": line.newLine,
                        "content": line.content,
                    }
                    for line in hunk.lines
                    if line.kind in ("context", "added")
                ],
            }
            for hunk in changed_file.hunks
        ],
    }
