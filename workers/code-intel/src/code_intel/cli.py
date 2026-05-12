from __future__ import annotations

import json
import sys

from contract_types import to_jsonable

from .git_fetcher import GitPullRequestFetcher
from .ports import PullRequestRef


def main() -> int:
    payload = json.load(sys.stdin)
    ref = PullRequestRef(
        provider=payload["provider"],
        owner=payload["owner"],
        repo=payload["repo"],
        number=int(payload["number"]),
        url=payload["url"],
        remote_url=payload.get("remoteUrl"),
    )
    snapshot = GitPullRequestFetcher().fetch_pull_request(ref)
    json.dump(
        {
            "repository": to_jsonable(snapshot.repository),
            "changeRequest": to_jsonable(snapshot.change_request),
            "diff": to_jsonable(snapshot.diff),
        },
        sys.stdout,
        separators=(",", ":"),
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
