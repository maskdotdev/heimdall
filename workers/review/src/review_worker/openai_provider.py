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
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are Heimdall's code reviewer. Return only valid JSON matching "
                            "the reviewer output contract. schemaVersion must be exactly \"1.0.0\". "
                            "Use only these finding categories: correctness, security, reliability, "
                            "performance, maintainability, test, style, documentation, accessibility, other. "
                            "Use only these severities: critical, high, medium, low, info. "
                            "Use only these confidence values: high, medium, low. "
                            "Every finding must include at least one evidence item with kind "
                            "diff-line, source-snippet, scanner-signal, dependency-edge, test-signal, "
                            "review-standard, or other. Return {\"schemaVersion\":\"1.0.0\",\"findings\":[]} "
                            "when there are no concrete issues."
                        ),
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
    changed_files = ", ".join(file.path for file in bundle.diff.files[:20])
    snippets = "\n\n".join(snippet.content for snippet in (bundle.sourceSnippets or [])[:10])
    return (
        f"Review run: {bundle.reviewRunId}\n"
        f"Change request: {bundle.changeRequest.title}\n"
        f"Changed files: {changed_files}\n\n"
        f"Diff context:\n{snippets}\n\n"
        "Return exactly one JSON object with keys schemaVersion, summary, findings, and optional modelMetadata. "
        "The schemaVersion value must be \"1.0.0\". Findings must include title, body, category, severity, "
        "confidence, and evidence. Evidence must include kind and summary."
    )
