from __future__ import annotations

from collections.abc import Callable, Mapping

from review_worker.backends.codex_app_server import CodexAppServerConfig, CodexAppServerReviewerProvider
from review_worker.fake_provider import FakeReviewerProvider
from review_worker.openai_provider import OpenAICompatibleConfig, OpenAICompatibleReviewerProvider
from review_worker.ports import ReviewerProvider


BackendFactory = Callable[[], ReviewerProvider]


def create_reviewer_provider(name: str | None = None) -> ReviewerProvider:
    backend_name = name or "fake"
    try:
        return _backend_factories()[backend_name]()
    except KeyError as error:
        available = ", ".join(registered_backend_names())
        raise ValueError(f"unsupported review provider: {backend_name}. available providers: {available}") from error


def registered_backend_names() -> tuple[str, ...]:
    return tuple(sorted(_backend_factories().keys()))


def _backend_factories() -> Mapping[str, BackendFactory]:
    return {
        "codex-app-server": lambda: CodexAppServerReviewerProvider(CodexAppServerConfig.from_env()),
        "fake": FakeReviewerProvider,
        "openai-compatible": lambda: OpenAICompatibleReviewerProvider(OpenAICompatibleConfig.from_env()),
        "openai-chat": lambda: OpenAICompatibleReviewerProvider(OpenAICompatibleConfig.from_env()),
    }
