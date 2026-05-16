from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

from martian_benchmark import MartianCase, load_martian_cases, parse_github_pull_url


@dataclass(frozen=True, slots=True)
class PreparedRepo:
    case_id: str
    url: str
    path: str
    head_sha: str
    refreshed: bool


def prepare_repositories(cases: Sequence[MartianCase], output_dir: Path, *, refresh: bool = False) -> list[PreparedRepo]:
    output_dir.mkdir(parents=True, exist_ok=True)
    prepared: list[PreparedRepo] = []
    for case in cases:
        prepared.append(prepare_repository(case, output_dir / case.case_id, refresh=refresh))
    write_manifest(output_dir, prepared)
    return prepared


def prepare_repository(case: MartianCase, path: Path, *, refresh: bool = False) -> PreparedRepo:
    url = case.original_url or case.url
    repo = parse_github_pull_url(url)
    clone_url = f"https://github.com/{repo['owner']}/{repo['repo']}.git"
    if refresh and path.exists():
        shutil.rmtree(path)
    if not (path / ".git").is_dir():
        path.parent.mkdir(parents=True, exist_ok=True)
        run_git(["git", "clone", "--filter=blob:none", "--no-checkout", clone_url, str(path)])

    run_git(["git", "fetch", "--depth=1", "origin", f"pull/{repo['number']}/head"], cwd=path)
    run_git(["git", "checkout", "--detach", "FETCH_HEAD"], cwd=path)
    head_sha = run_git(["git", "rev-parse", "HEAD"], cwd=path).strip()
    return PreparedRepo(case_id=case.case_id, url=url, path=str(path), head_sha=head_sha, refreshed=refresh)


def run_git(command: list[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout


def write_manifest(output_dir: Path, prepared: Sequence[PreparedRepo]) -> None:
    manifest = {
        "schemaVersion": "1.0.0",
        "repositories": [asdict(repo) for repo in prepared],
    }
    (output_dir / "manifest.json").write_text(f"{json.dumps(manifest, indent=2, sort_keys=True)}\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare clean PR-head repository checkouts for Martian benchmark cases.")
    parser.add_argument("--golden-dir", type=Path, help="Path to Martian offline/golden_comments.")
    parser.add_argument("--benchmark-data", type=Path, help="Path to Martian offline results/benchmark_data.json.")
    parser.add_argument("--case", action="append", help="Martian case id. Repeat to include more.")
    parser.add_argument("--limit", type=int, help="Maximum number of Martian PR cases to prepare.")
    parser.add_argument("--out", type=Path, required=True, help="Output directory for case-id-named clean checkouts.")
    parser.add_argument("--refresh", action="store_true", help="Delete and recreate existing checkouts.")
    args = parser.parse_args()

    cases = load_martian_cases(golden_dir=args.golden_dir, benchmark_data=args.benchmark_data, case_ids=args.case, limit=args.limit)
    prepared = prepare_repositories(cases, args.out, refresh=args.refresh)
    print(json.dumps([asdict(repo) for repo in prepared], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
