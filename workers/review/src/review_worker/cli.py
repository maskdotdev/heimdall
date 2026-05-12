from __future__ import annotations

import json
import os
import sys

from contract_types import ChangeRequest, ContextBundle, Diff, from_json, to_jsonable

from .engine import ReviewEngine
from .fake_provider import FakeReviewerProvider
from .openai_provider import OpenAICompatibleConfig, OpenAICompatibleReviewerProvider
from .ports import ReviewRequest
from .context_builder import build_diff_context_bundle


def main() -> int:
    payload = json.load(sys.stdin)
    provider_name = os.environ.get("HEIMDALL_REVIEW_PROVIDER", "fake")
    if provider_name == "openai-compatible":
        provider = OpenAICompatibleReviewerProvider(OpenAICompatibleConfig.from_env())
    elif provider_name == "fake":
        provider = FakeReviewerProvider()
    else:
        raise ValueError(f"unsupported review provider: {provider_name}")

    if "contextBundle" in payload:
        context_bundle = from_json(ContextBundle, payload["contextBundle"])
    else:
        context_bundle = build_diff_context_bundle(
            payload["reviewRunId"],
            from_json(ChangeRequest, payload["changeRequest"]),
            from_json(Diff, payload["diff"]),
        )

    result = ReviewEngine(provider).review(ReviewRequest(context_bundle=context_bundle))
    json.dump(
        {
            "rawOutput": to_jsonable(result.raw_output),
            "findings": to_jsonable(result.findings),
        },
        sys.stdout,
        separators=(",", ":"),
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
