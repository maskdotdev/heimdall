from __future__ import annotations

import json
import os
import re
import select
import shlex
import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from contract_types import ModelMetadata, ReviewerOutput, from_json

from review_worker.openai_provider import PROMPT_VERSION, build_prompt_with_context, prompt_input_profile
from review_worker.ports import ReviewRequest


DEFAULT_MODEL = "gpt-5.5"
DEFAULT_REASONING_EFFORT = "low"
DEFAULT_TIMEOUT_SECONDS = 300.0
DEFAULT_MAX_REVIEWS_PER_PROCESS = 6
JSON_OBJECT_PATTERN = re.compile(r"\{.*\}", re.DOTALL)
CODEX_PROMPT_MAX_FILES = 8
CODEX_PROMPT_MAX_SNIPPETS = 12
CODEX_LARGE_PROMPT_CHAR_THRESHOLD = 0
CODEX_LARGE_PROMPT_MAX_FILES = 4


@dataclass(frozen=True, slots=True)
class CodexAppServerConfig:
    command: tuple[str, ...]
    model: str
    reasoning_effort: str = DEFAULT_REASONING_EFFORT
    cwd: str | None = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_reviews_per_process: int = DEFAULT_MAX_REVIEWS_PER_PROCESS
    prompt_max_files: int = CODEX_PROMPT_MAX_FILES
    prompt_max_snippets: int = CODEX_PROMPT_MAX_SNIPPETS
    large_prompt_char_threshold: int = CODEX_LARGE_PROMPT_CHAR_THRESHOLD
    large_prompt_max_files: int = CODEX_LARGE_PROMPT_MAX_FILES

    @classmethod
    def from_env(cls) -> CodexAppServerConfig:
        command = shlex.split(os.environ.get("HEIMDALL_CODEX_APP_SERVER_COMMAND", "codex app-server"))
        model = os.environ.get("HEIMDALL_CODEX_APP_SERVER_MODEL", DEFAULT_MODEL)
        reasoning_effort = os.environ.get("HEIMDALL_CODEX_APP_SERVER_REASONING_EFFORT", DEFAULT_REASONING_EFFORT)
        cwd = os.environ.get("HEIMDALL_CODEX_APP_SERVER_CWD") or None
        timeout_seconds = float(os.environ.get("HEIMDALL_CODEX_APP_SERVER_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
        max_reviews_per_process = int(os.environ.get("HEIMDALL_CODEX_APP_SERVER_MAX_REVIEWS_PER_PROCESS", str(DEFAULT_MAX_REVIEWS_PER_PROCESS)))
        prompt_max_files = int(os.environ.get("HEIMDALL_CODEX_APP_SERVER_PROMPT_MAX_FILES", str(CODEX_PROMPT_MAX_FILES)))
        prompt_max_snippets = int(os.environ.get("HEIMDALL_CODEX_APP_SERVER_PROMPT_MAX_SNIPPETS", str(CODEX_PROMPT_MAX_SNIPPETS)))
        large_prompt_char_threshold = int(
            os.environ.get("HEIMDALL_CODEX_APP_SERVER_LARGE_PROMPT_CHAR_THRESHOLD", str(CODEX_LARGE_PROMPT_CHAR_THRESHOLD))
        )
        large_prompt_max_files = int(os.environ.get("HEIMDALL_CODEX_APP_SERVER_LARGE_PROMPT_MAX_FILES", str(CODEX_LARGE_PROMPT_MAX_FILES)))
        return cls(
            command=tuple(command),
            model=model,
            reasoning_effort=reasoning_effort,
            cwd=cwd,
            timeout_seconds=timeout_seconds,
            max_reviews_per_process=max_reviews_per_process,
            prompt_max_files=prompt_max_files,
            prompt_max_snippets=prompt_max_snippets,
            large_prompt_char_threshold=large_prompt_char_threshold,
            large_prompt_max_files=large_prompt_max_files,
        )


class CodexAppServerReviewerProvider:
    def __init__(self, config: CodexAppServerConfig | None = None) -> None:
        self.config = config or CodexAppServerConfig.from_env()
        self.client: CodexAppServerClient | None = None
        self.last_timing: dict[str, int] | None = None
        self.last_input_profile: dict[str, int] | None = None
        self.reviews_on_client = 0

    def review(self, request: ReviewRequest) -> ReviewerOutput:
        client = self._client()
        try:
            output = client.review(request)
        except Exception:
            self.last_timing = client.last_timing
            self.last_input_profile = client.last_input_profile
            self.close()
            raise
        self.reviews_on_client += 1
        self.last_timing = client.last_timing
        self.last_input_profile = client.last_input_profile
        output.modelMetadata = output.modelMetadata or ModelMetadata()
        output.modelMetadata.provider = "codex-app-server"
        output.modelMetadata.model = self.config.model
        output.modelMetadata.promptVersion = PROMPT_VERSION
        return output

    def _client(self) -> CodexAppServerClient:
        if self.client is not None and self.reviews_on_client >= self.config.max_reviews_per_process:
            self.close()
        if self.client is None:
            self.client = CodexAppServerClient(self.config)
            self.reviews_on_client = 0
        return self.client

    def close(self) -> None:
        if self.client is not None:
            self.client.close()
            self.client = None
            self.reviews_on_client = 0


class CodexAppServerAgenticReviewerProvider:
    def __init__(self, config: CodexAppServerConfig | None = None) -> None:
        self.config = config or CodexAppServerConfig.from_env()
        self.last_timing: dict[str, int] | None = None
        self.last_input_profile: dict[str, int] | None = None

    def review(self, request: ReviewRequest) -> ReviewerOutput:
        if self.config.cwd is None:
            raise ValueError("codex-app-server-agentic requires HEIMDALL_CODEX_APP_SERVER_CWD to point at a checked-out repository")

        client = CodexAppServerClient(self.config)
        try:
            prompt, input_profile = build_agentic_codex_review_prompt_with_profile(request)
            client.last_input_profile = input_profile
            text = client.complete_text(prompt, turn_options=read_only_repository_turn_options(self.config))
            parse_started = time.monotonic()
            output = parse_reviewer_output(text)
            timing = dict(client.last_timing or {})
            timing["parseMs"] = elapsed_ms(parse_started)
            client.last_timing = timing
            self.last_timing = client.last_timing
            self.last_input_profile = client.last_input_profile
        finally:
            client.close()
        output.modelMetadata = output.modelMetadata or ModelMetadata()
        output.modelMetadata.provider = "codex-app-server-agentic"
        output.modelMetadata.model = self.config.model
        output.modelMetadata.promptVersion = f"{PROMPT_VERSION}+agentic-v1"
        return output


class CodexAppServerClient:
    def __init__(self, config: CodexAppServerConfig) -> None:
        self.config = config
        self.next_id = 1
        started = time.monotonic()
        self.process = subprocess.Popen(
            list(config.command),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=config.cwd,
        )
        self.process_start_ms = elapsed_ms(started)
        self.report_process_start = True
        self.initialized = False
        self.last_timing: dict[str, int] | None = None
        self.last_input_profile: dict[str, int] | None = None

    def review(self, request: ReviewRequest) -> ReviewerOutput:
        prompt, input_profile = build_codex_review_prompt_with_profile(
            request,
            max_files=self.config.prompt_max_files,
            max_snippets=self.config.prompt_max_snippets,
            large_prompt_char_threshold=self.config.large_prompt_char_threshold,
            large_prompt_max_files=self.config.large_prompt_max_files,
        )
        self.last_input_profile = input_profile
        text = self.complete_text(prompt)
        parse_started = time.monotonic()
        try:
            return parse_reviewer_output(text)
        finally:
            timing = dict(self.last_timing or {})
            timing["parseMs"] = elapsed_ms(parse_started)
            self.last_timing = timing

    def complete_text(self, prompt: str, *, turn_options: dict[str, Any] | None = None) -> str:
        deadline = time.monotonic() + self.config.timeout_seconds
        timing = {"processStartMs": self.process_start_ms if self.report_process_start else 0}
        self.report_process_start = False
        initialize_started = time.monotonic()
        self.ensure_initialized(deadline)
        timing["initializeMs"] = elapsed_ms(initialize_started)
        thread_started = time.monotonic()
        thread_result = self.request(
            "thread/start",
            {
                "model": self.config.model,
                "reasoningEffort": self.config.reasoning_effort,
                "serviceName": "heimdall-review-worker",
            },
            deadline,
        )
        timing["threadStartMs"] = elapsed_ms(thread_started)
        thread_id = thread_result["thread"]["id"]
        try:
            turn_started = time.monotonic()
            text = self._complete_text_in_thread(prompt, thread_id, deadline, turn_options=turn_options)
            timing["turnMs"] = elapsed_ms(turn_started)
            return text
        finally:
            archive_started = time.monotonic()
            self.archive_thread(thread_id)
            timing["archiveMs"] = elapsed_ms(archive_started)
            self.last_timing = timing

    def ensure_initialized(self, deadline: float) -> None:
        if self.initialized:
            return
        self.request("initialize", {"clientInfo": {"name": "heimdall", "title": "Heimdall", "version": "0.1.0"}}, deadline)
        self.notify("initialized", {})
        self.initialized = True

    def _complete_text_in_thread(
        self,
        prompt: str,
        thread_id: str,
        deadline: float,
        *,
        turn_options: dict[str, Any] | None = None,
    ) -> str:
        turn_id = self.next_id
        self.next_id += 1
        turn_params: dict[str, Any] = {"threadId": thread_id, "input": [{"type": "text", "text": prompt}]}
        if turn_options:
            turn_params.update(turn_options)
        self.send({"method": "turn/start", "id": turn_id, "params": turn_params})

        agent_text_by_item: dict[str, str] = {}
        agent_text_parts: list[str] = []
        saw_turn_response = False
        while time.monotonic() < deadline:
            message = self.read_message(deadline)
            if message.get("id") == turn_id:
                if "error" in message:
                    raise RuntimeError(f"codex app-server turn/start failed: {message['error']}")
                saw_turn_response = True
                continue

            method = message.get("method")
            params = message.get("params", {})
            if method == "item/agentMessage/delta":
                delta = _extract_text_delta(params)
                if delta:
                    item_id = _extract_item_id(params)
                    if item_id:
                        agent_text_by_item[item_id] = f"{agent_text_by_item.get(item_id, '')}{delta}"
                    else:
                        agent_text_parts.append(delta)
            elif method == "item/completed":
                text = _extract_completed_item_text(params)
                item_id = _extract_item_id(params)
                if text and (not item_id or item_id not in agent_text_by_item):
                    agent_text_parts.append(text)
            elif method == "turn/completed" and saw_turn_response:
                return _combined_agent_text(agent_text_parts, agent_text_by_item)
            elif method == "thread/status/changed" and saw_turn_response and _thread_is_idle(params):
                text = _combined_agent_text(agent_text_parts, agent_text_by_item)
                if text:
                    return text

            if "id" in message and isinstance(method, str):
                self.send({"id": message["id"], "result": {"decision": "decline"}})

        raise TimeoutError("timed out waiting for codex app-server review turn to complete")

    def archive_thread(self, thread_id: str) -> None:
        try:
            self.request("thread/archive", {"threadId": thread_id}, time.monotonic() + min(self.config.timeout_seconds, 5.0))
        except Exception:
            return

    def request(self, method: str, params: dict[str, Any], deadline: float) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        self.send({"method": method, "id": request_id, "params": params})
        while time.monotonic() < deadline:
            message = self.read_message(deadline)
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(f"codex app-server {method} failed: {message['error']}")
            result = message.get("result")
            if not isinstance(result, dict):
                raise RuntimeError(f"codex app-server {method} returned a non-object result")
            return result
        raise TimeoutError(f"timed out waiting for codex app-server {method}")

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"method": method, "params": params})

    def send(self, message: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("codex app-server stdin is closed")
        self.process.stdin.write(f"{json.dumps(message, separators=(',', ':'))}\n")
        self.process.stdin.flush()

    def read_message(self, deadline: float) -> dict[str, Any]:
        if self.process.stdout is None:
            raise RuntimeError("codex app-server stdout is closed")
        remaining = max(deadline - time.monotonic(), 0)
        readable, _, _ = select.select([self.process.stdout], [], [], remaining)
        if not readable:
            raise TimeoutError("timed out while reading codex app-server message")
        line = self.process.stdout.readline()
        if line == "":
            stderr = self.process.stderr.read() if self.process.stderr is not None else ""
            raise RuntimeError(f"codex app-server exited before completing review: {stderr.strip()}")
        message = json.loads(line)
        if not isinstance(message, dict):
            raise RuntimeError("codex app-server emitted a non-object JSON-RPC message")
        if time.monotonic() >= deadline:
            raise TimeoutError("timed out while reading codex app-server message")
        return message

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            close = getattr(stream, "close", None)
            if close is not None:
                close()


def build_codex_review_prompt(request: ReviewRequest) -> str:
    return build_codex_review_prompt_with_profile(request)[0]


def build_codex_review_prompt_with_profile(
    request: ReviewRequest,
    *,
    max_files: int = CODEX_PROMPT_MAX_FILES,
    max_snippets: int = CODEX_PROMPT_MAX_SNIPPETS,
    large_prompt_char_threshold: int = CODEX_LARGE_PROMPT_CHAR_THRESHOLD,
    large_prompt_max_files: int = CODEX_LARGE_PROMPT_MAX_FILES,
) -> tuple[str, dict[str, int]]:
    prompt, profile = build_codex_review_prompt_for_budget(request, max_files=max_files, max_snippets=max_snippets)
    profile["promptMaxFiles"] = max_files
    profile["promptMaxSnippets"] = max_snippets
    profile["largePromptAdapted"] = 0
    profile["initialPromptChars"] = profile["promptChars"]
    initial_prompt_chars = profile["promptChars"]
    if (
        large_prompt_char_threshold > 0
        and profile["promptChars"] > large_prompt_char_threshold
        and large_prompt_max_files < max_files
    ):
        prompt, profile = build_codex_review_prompt_for_budget(request, max_files=large_prompt_max_files, max_snippets=max_snippets)
        profile["promptMaxFiles"] = large_prompt_max_files
        profile["promptMaxSnippets"] = max_snippets
        profile["largePromptAdapted"] = 1
        profile["initialPromptChars"] = initial_prompt_chars
    return prompt, profile


def build_codex_review_prompt_for_budget(request: ReviewRequest, *, max_files: int, max_snippets: int) -> tuple[str, dict[str, int]]:
    prompt_build = build_prompt_with_context(
        request,
        max_files=max_files,
        max_snippets=max_snippets,
    )
    prompt = (
        "You are the Codex backend for Heimdall's review worker. Review only the supplied Heimdall context bundle. "
        "Do not inspect or edit files. Return only one JSON object matching Heimdall's ReviewerOutput contract.\n"
        "Contract requirements:\n"
        '- The top-level object must contain "schemaVersion", "summary", and "findings".\n'
        '- "findings" must be an array. Use an empty array when there are no concrete findings.\n'
        '- Finding "category" must be one of: "correctness", "security", "reliability", "performance", '
        '"maintainability", "test", "style", "documentation", "accessibility", or "other". Use "correctness" for bugs.\n'
        '- Finding "severity" must be one of: "critical", "high", "medium", "low", or "info".\n'
        '- Finding "confidence" must be one of: "high", "medium", or "low".\n'
        '- Each finding "evidence" value must be an array, even when there is only one evidence item.\n'
        '- Evidence "kind" must be one of: "diff-line", "source-snippet", "scanner-signal", "dependency-edge", '
        '"test-signal", "review-standard", or "other". Use "diff-line" for changed diff lines; never use "changed_line".\n'
        '- Line locations must use objects like {"path":"app/routes.py","startLine":6}.\n\n'
        f"{prompt_build.prompt}"
    )
    return prompt, prompt_input_profile(prompt, prompt_build)


def build_agentic_codex_review_prompt(request: ReviewRequest) -> str:
    return build_agentic_codex_review_prompt_with_profile(request)[0]


def build_agentic_codex_review_prompt_with_profile(request: ReviewRequest) -> tuple[str, dict[str, int]]:
    prompt_build = build_prompt_with_context(request)
    prompt = (
        "You are the Codex backend for Heimdall's agentic review worker. Review the supplied Heimdall context bundle "
        "and use the current working directory as a read-only checkout of the repository under review. You may inspect "
        "files to understand changed code, nearby definitions, call sites, and directly related tests. First use the "
        "supplied dependencyFrontier, relatedTests, and sourceSnippets as the exploration seed. Do not edit files, "
        "publish comments, install dependencies, fetch remote resources, or run broad/slow test suites. Use short "
        "read-only commands such as git diff, rg, sed, and targeted test discovery, and stop exploring once the supplied "
        "diff and nearby repository context are enough to decide. Do not inspect benchmark goldens, expected findings, "
        "cached judgments, prior run outputs, or any evaluation answer keys even if they exist in the checkout. Return "
        "only one JSON object matching Heimdall's ReviewerOutput contract.\n"
        "Contract requirements:\n"
        '- The top-level object must contain "schemaVersion", "summary", and "findings".\n'
        '- "findings" must be an array. Use an empty array when there are no concrete findings.\n'
        '- Finding "category" must be one of: "correctness", "security", "reliability", "performance", '
        '"maintainability", "test", "style", "documentation", "accessibility", or "other". Use "correctness" for bugs.\n'
        '- Finding "severity" must be one of: "critical", "high", "medium", "low", or "info".\n'
        '- Finding "confidence" must be one of: "high", "medium", or "low".\n'
        '- Each finding "evidence" value must be an array, even when there is only one evidence item.\n'
        '- Evidence "kind" must be one of: "diff-line", "source-snippet", "scanner-signal", "dependency-edge", '
        '"test-signal", "review-standard", or "other". Use "diff-line" for changed diff lines; never use "changed_line".\n'
        '- Line locations must use objects like {"path":"app/routes.py","startLine":6} and must refer to changed files.\n\n'
        f"{prompt_build.prompt}"
    )
    return prompt, prompt_input_profile(prompt, prompt_build)


def read_only_repository_turn_options(config: CodexAppServerConfig) -> dict[str, Any]:
    if config.cwd is None:
        raise ValueError("read-only repository turn options require a repository cwd")
    return {
        "cwd": config.cwd,
        "model": config.model,
        "effort": config.reasoning_effort,
        "approvalPolicy": "never",
        "sandboxPolicy": {"type": "readOnly"},
    }


def parse_reviewer_output(text: str) -> ReviewerOutput:
    try:
        return from_json(ReviewerOutput, json.loads(text))
    except json.JSONDecodeError:
        match = JSON_OBJECT_PATTERN.search(text)
        if match is None:
            raise ValueError("codex app-server review did not include a JSON object") from None
        return from_json(ReviewerOutput, json.loads(match.group(0)))


def _extract_text_delta(params: Any) -> str | None:
    if not isinstance(params, dict):
        return None
    for key in ("delta", "text", "content"):
        value = params.get(key)
        if isinstance(value, str):
            return value
    item = params.get("item")
    if isinstance(item, dict):
        return _extract_text_delta(item)
    return None


def _extract_item_id(params: Any) -> str | None:
    if not isinstance(params, dict):
        return None
    value = params.get("itemId")
    if isinstance(value, str):
        return value
    item = params.get("item")
    if isinstance(item, dict) and isinstance(item.get("id"), str):
        return item["id"]
    return None


def _extract_completed_item_text(params: Any) -> str | None:
    if not isinstance(params, dict):
        return None
    item = params.get("item")
    if not isinstance(item, dict):
        return None
    if item.get("type") not in {"agentMessage", "message"}:
        return None
    for key in ("text", "content"):
        value = item.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, Sequence) and not isinstance(value, str):
            parts = [part.get("text") for part in value if isinstance(part, dict) and isinstance(part.get("text"), str)]
            if parts:
                return "".join(parts)
    return None


def _thread_is_idle(params: Any) -> bool:
    if not isinstance(params, dict):
        return False
    status = params.get("status")
    return isinstance(status, dict) and status.get("type") == "idle"


def _combined_agent_text(parts: list[str], by_item: dict[str, str]) -> str:
    return "".join([*parts, *by_item.values()])


def elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
