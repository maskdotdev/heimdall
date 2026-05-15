from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import time
import urllib.request
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from contract_types import (
    ChangeRef,
    ChangeRequest,
    ChangedFile,
    ContextBundle,
    Diff,
    DiffHunk,
    DiffLine,
    DiffSummary,
    Finding,
    RedactionSummary,
    Repository,
    ReviewerOutput,
    to_jsonable,
)
from review_worker.backends import create_reviewer_provider
from review_worker.backends.codex_app_server import CodexAppServerClient, CodexAppServerConfig
from review_worker.context_builder import DiffContextOptions, build_diff_context_bundle
from review_worker.engine import ReviewEngine
from review_worker.ports import ReviewRequest


ROOT = Path(__file__).resolve().parents[3]
EVALS_DIR = ROOT / "tests" / "evals"
MARTIAN_RUNS_DIR = EVALS_DIR / "martian-runs"
DEFAULT_MAX_JUDGE_PAIRS = 100
AGENTIC_REVIEW_BACKENDS = {"codex-app-server-agentic"}
HUNK_RE = re.compile(r"^@@ -(?P<old_start>\d+)(?:,(?P<old_lines>\d+))? \+(?P<new_start>\d+)(?:,(?P<new_lines>\d+))? @@(?P<header>.*)$")
JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
STOPWORDS = {
    "about",
    "after",
    "before",
    "because",
    "being",
    "could",
    "does",
    "from",
    "have",
    "into",
    "should",
    "that",
    "their",
    "there",
    "this",
    "when",
    "where",
    "which",
    "with",
    "would",
}


@dataclass(frozen=True, slots=True)
class MartianGoldenIssue:
    comment: str
    severity: str


@dataclass(frozen=True, slots=True)
class MartianCase:
    case_id: str
    url: str
    pr_title: str
    source_repo: str
    golden_comments: list[MartianGoldenIssue]
    original_url: str | None = None
    golden_source_file: str | None = None


@dataclass(frozen=True, slots=True)
class MartianComparisonRow:
    backend: str
    case_id: str
    reviewer_provider: str | None
    reviewer_model: str | None
    judge_provider: str | None
    judge_model: str | None
    candidate_count: int
    golden_count: int
    true_positives: int | None
    false_positives: int | None
    false_negatives: int | None
    precision: float | None
    recall: float | None
    duration_ms: int
    error: str | None = None
    context_ms: int | None = None
    review_ms: int | None = None
    judge_ms: int | None = None
    total_ms: int | None = None
    review_phase_ms: dict[str, int] | None = None
    review_input_profile: dict[str, int] | None = None


@dataclass(frozen=True, slots=True)
class MatchResult:
    candidate_indexes: set[int]
    golden_indexes: set[int]


@dataclass(frozen=True, slots=True)
class MartianRunMetadata:
    schema_version: str
    started_at: str
    backend_names: list[str]
    case_count: int
    match_mode: str
    judge: str | None
    diff_dir: str | None
    cache_diff_dir: str | None
    fetch_diffs: bool
    resume: bool
    force: bool
    max_judge_pairs: int
    max_run_seconds: int | None
    repo_roots: dict[str, str] | None = None


def run_martian_benchmark(
    backends: list[str],
    *,
    golden_dir: Path | None = None,
    benchmark_data: Path | None = None,
    diff_dir: Path | None = None,
    cache_diff_dir: Path | None = None,
    fetch_diffs: bool = False,
    case_ids: list[str] | None = None,
    limit: int | None = None,
    output_dir: Path | None = None,
    match_mode: str = "unjudged",
    judgments_path: Path | None = None,
    judge: str | None = None,
    max_judge_pairs: int = DEFAULT_MAX_JUDGE_PAIRS,
    max_run_seconds: int | None = None,
    repo_roots: dict[str, Path] | None = None,
    resume: bool = True,
    force: bool = False,
) -> list[MartianComparisonRow]:
    cases = load_martian_cases(golden_dir=golden_dir, benchmark_data=benchmark_data, case_ids=case_ids, limit=limit)
    run_dir = output_dir or MARTIAN_RUNS_DIR / time.strftime("%Y%m%d-%H%M%S")
    run_started = time.monotonic()
    write_run_metadata(
        run_dir,
        MartianRunMetadata(
            schema_version="1.0.0",
            started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            backend_names=backends,
            case_count=len(cases),
            match_mode="judgments" if judge else match_mode,
            judge=judge,
            diff_dir=str(diff_dir) if diff_dir else None,
            cache_diff_dir=str(cache_diff_dir) if cache_diff_dir else None,
            fetch_diffs=fetch_diffs,
            resume=resume,
            force=force,
            max_judge_pairs=max_judge_pairs,
            max_run_seconds=max_run_seconds,
            repo_roots={case_id: str(path) for case_id, path in repo_roots.items()} if repo_roots else None,
        ),
    )
    judgments = load_judgments(judgments_path) if judgments_path else {}
    generated_judgments: list[dict[str, Any]] = []
    rows: list[MartianComparisonRow] = []

    for backend in backends:
        shared_provider = None
        shared_engine: ReviewEngine | None = None
        try:
            if backend not in AGENTIC_REVIEW_BACKENDS:
                shared_provider = create_reviewer_provider(backend)
                shared_engine = ReviewEngine(shared_provider)
            for case in cases:
                if max_run_seconds is not None and time.monotonic() - run_started >= max_run_seconds:
                    row = failed_row(
                        backend,
                        case.case_id,
                        None,
                        None,
                        judge,
                        None,
                        0,
                        len(case.golden_comments),
                        elapsed_ms(run_started),
                        TimeoutError(f"max run seconds exceeded before starting case: {max_run_seconds}"),
                    )
                    rows.append(row)
                    write_error_artifacts(run_dir, backend, case, row)
                    continue
                existing = load_existing_row(run_dir, backend, case) if resume and not force else None
                if existing is not None:
                    rows.append(existing)
                    continue
                started = time.monotonic()
                context_ms: int | None = None
                review_ms: int | None = None
                judge_ms: int | None = None
                review_phase_ms: dict[str, int] | None = None
                review_input_profile: dict[str, int] | None = None
                review_started: float | None = None
                active_provider: Any = None
                try:
                    context_started = time.monotonic()
                    context_bundle = context_bundle_for_case(
                        case,
                        diff_dir=diff_dir,
                        cache_diff_dir=cache_diff_dir,
                        fetch_diffs=fetch_diffs,
                        repository_root=(repo_roots or {}).get(case.case_id),
                    )
                    context_ms = elapsed_ms(context_started)
                    review_started = time.monotonic()
                    if backend in AGENTIC_REVIEW_BACKENDS:
                        with reviewer_backend_environment(backend, case, repo_roots or {}):
                            case_provider = create_reviewer_provider(backend)
                            active_provider = case_provider
                            try:
                                result = ReviewEngine(case_provider).review(ReviewRequest(context_bundle=context_bundle))
                                review_phase_ms = reviewer_phase_timing(case_provider)
                                review_input_profile = reviewer_input_profile(case_provider)
                            finally:
                                close_reviewer_provider(case_provider)
                    else:
                        if shared_engine is None or shared_provider is None:
                            raise RuntimeError(f"reviewer provider was not initialized for backend {backend}")
                        active_provider = shared_provider
                        result = shared_engine.review(ReviewRequest(context_bundle=context_bundle))
                        review_phase_ms = reviewer_phase_timing(shared_provider)
                        review_input_profile = reviewer_input_profile(shared_provider)
                    review_ms = elapsed_ms(review_started)
                    duration_ms = elapsed_ms(started)
                except Exception as error:
                    if review_ms is None and review_started is not None:
                        review_ms = elapsed_ms(review_started)
                    if review_phase_ms is None and active_provider is not None:
                        review_phase_ms = reviewer_phase_timing(active_provider)
                    if review_input_profile is None and active_provider is not None:
                        review_input_profile = reviewer_input_profile(active_provider)
                    row = failed_row(backend, case.case_id, None, None, None, None, 0, len(case.golden_comments), elapsed_ms(started), error)
                    row = replace(
                        row,
                        context_ms=context_ms,
                        review_ms=review_ms,
                        total_ms=elapsed_ms(started),
                        review_phase_ms=review_phase_ms,
                        review_input_profile=review_input_profile,
                    )
                    rows.append(row)
                    write_error_artifacts(run_dir, backend, case, row)
                    continue

                reviewer_provider = result.raw_output.modelMetadata.provider if result.raw_output.modelMetadata else None
                reviewer_model = result.raw_output.modelMetadata.model if result.raw_output.modelMetadata else None
                try:
                    judge_started = time.monotonic()
                    case_judgments = (
                        judge_findings(case, list(result.findings), judge=judge, max_judge_pairs=max_judge_pairs)
                        if judge
                        else judgments.get(case.case_id, [])
                    )
                    judge_ms = elapsed_ms(judge_started) if judge else 0
                except Exception as error:
                    row = failed_row(
                        backend,
                        case.case_id,
                        reviewer_provider,
                        reviewer_model,
                        judge,
                        None,
                        len(result.findings),
                        len(case.golden_comments),
                        duration_ms,
                        error,
                    )
                    row = replace(
                        row,
                        context_ms=context_ms,
                        review_ms=review_ms,
                        judge_ms=elapsed_ms(judge_started),
                        total_ms=elapsed_ms(started),
                        review_phase_ms=review_phase_ms,
                        review_input_profile=review_input_profile,
                    )
                    rows.append(row)
                    write_error_artifacts(run_dir, backend, case, row)
                    continue
                generated_judgments.extend(case_judgments if judge else [])
                row = compare_martian_result(
                    backend=backend,
                    case=case,
                    raw_output=result.raw_output,
                    findings=list(result.findings),
                    duration_ms=duration_ms,
                    match_mode="judgments" if judge else match_mode,
                    judgments=case_judgments,
                    judge=judge,
                )
                row = replace(
                    row,
                    context_ms=context_ms,
                    review_ms=review_ms,
                    judge_ms=judge_ms,
                    total_ms=elapsed_ms(started),
                    review_phase_ms=review_phase_ms,
                    review_input_profile=review_input_profile,
                )
                rows.append(row)
                write_case_artifacts(run_dir, backend, case, context_bundle, result.raw_output, list(result.findings), row, case_judgments if judge else None)
        finally:
            close_reviewer_provider(shared_provider)

    if generated_judgments:
        write_json(run_dir / "judgments.json", {"matches": generated_judgments})
    write_json(run_dir / "summary.json", [asdict(row) for row in rows])
    write_json(run_dir / "aggregate.json", aggregate_rows(rows))
    return rows


@contextlib.contextmanager
def reviewer_backend_environment(backend: str, case: MartianCase, repo_roots: dict[str, Path]):
    if backend not in AGENTIC_REVIEW_BACKENDS:
        yield
        return

    repo_root = repo_roots.get(case.case_id)
    if repo_root is None:
        raise ValueError(f"{backend} requires --repo-root {case.case_id}=<clean-checkout>")
    if not repo_root.is_dir():
        raise ValueError(f"{backend} repo root does not exist or is not a directory: {repo_root}")

    previous_cwd = os.environ.get("HEIMDALL_CODEX_APP_SERVER_CWD")
    os.environ["HEIMDALL_CODEX_APP_SERVER_CWD"] = str(repo_root)
    try:
        yield
    finally:
        if previous_cwd is None:
            os.environ.pop("HEIMDALL_CODEX_APP_SERVER_CWD", None)
        else:
            os.environ["HEIMDALL_CODEX_APP_SERVER_CWD"] = previous_cwd


def reviewer_phase_timing(provider: Any) -> dict[str, int] | None:
    timing = getattr(provider, "last_timing", None)
    if not isinstance(timing, dict):
        return None
    result: dict[str, int] = {}
    for key, value in timing.items():
        if isinstance(key, str) and isinstance(value, int):
            result[key] = value
    return result or None


def reviewer_input_profile(provider: Any) -> dict[str, int] | None:
    profile = getattr(provider, "last_input_profile", None)
    if not isinstance(profile, dict):
        return None
    result: dict[str, int] = {}
    for key, value in profile.items():
        if isinstance(key, str) and isinstance(value, int):
            result[key] = value
    return result or None


def close_reviewer_provider(provider: Any) -> None:
    if provider is None:
        return
    close = getattr(provider, "close", None)
    if callable(close):
        close()


def load_martian_cases(
    *,
    golden_dir: Path | None = None,
    benchmark_data: Path | None = None,
    case_ids: list[str] | None = None,
    limit: int | None = None,
) -> list[MartianCase]:
    if golden_dir is None and benchmark_data is None:
        raise ValueError("either golden_dir or benchmark_data is required")

    cases = load_cases_from_benchmark_data(benchmark_data) if benchmark_data else []
    if golden_dir is not None:
        cases.extend(load_cases_from_golden_dir(golden_dir))

    allowed = set(case_ids) if case_ids else None
    unique: dict[str, MartianCase] = {}
    for case in cases:
        if allowed is not None and case.case_id not in allowed:
            continue
        unique.setdefault(case.case_id, case)

    result = sorted(unique.values(), key=lambda case: case.case_id)
    if limit is not None:
        result = result[:limit]
    if not result:
        raise ValueError("no Martian benchmark cases matched the requested filters")
    return result


def cache_martian_diffs(cases: list[MartianCase], cache_diff_dir: Path, *, refresh: bool = False) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for case in cases:
        path = cached_diff_path(cache_diff_dir, case)
        if path.exists() and not refresh:
            rows.append({"caseId": case.case_id, "path": str(path), "status": "cached"})
            continue
        diff_text = fetch_pull_diff(case.original_url or case.url)
        write_cached_diff(cache_diff_dir, case, diff_text)
        rows.append({"caseId": case.case_id, "path": str(path), "status": "fetched", "bytes": len(diff_text.encode("utf-8"))})
    write_json(cache_diff_dir / "manifest.json", {"schemaVersion": "1.0.0", "diffs": rows})
    return rows


def load_cases_from_golden_dir(golden_dir: Path) -> list[MartianCase]:
    cases: list[MartianCase] = []
    for path in sorted(golden_dir.glob("*.json")):
        data = load_json(path)
        if not isinstance(data, list):
            raise ValueError(f"{path} must contain a JSON array")
        for entry in data:
            cases.append(case_from_entry(entry, source_file=path.name))
    return cases


def load_cases_from_benchmark_data(path: Path) -> list[MartianCase]:
    data = load_json(path)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    cases: list[MartianCase] = []
    for url, entry in data.items():
        value = dict(entry)
        value.setdefault("url", url)
        value.setdefault("comments", value.get("golden_comments", []))
        value.setdefault("source_file", value.get("golden_source_file"))
        cases.append(case_from_entry(value, source_file=value.get("source_file")))
    return cases


def case_from_entry(entry: dict[str, Any], *, source_file: str | None) -> MartianCase:
    url = require_string(entry, "url")
    comments = entry.get("comments")
    if not isinstance(comments, list):
        raise ValueError(f"Martian case {url} must contain comments")
    repo = parse_github_pull_url(entry.get("original_url") or url)
    return MartianCase(
        case_id=case_id_for_url(entry.get("original_url") or url),
        url=url,
        original_url=entry.get("original_url"),
        pr_title=entry.get("pr_title") or repo["title"],
        source_repo=entry.get("source_repo") or repo["repo"],
        golden_source_file=source_file,
        golden_comments=[
            MartianGoldenIssue(comment=require_string(comment, "comment"), severity=normalize_martian_severity(comment.get("severity")))
            for comment in comments
        ],
    )


def context_bundle_for_case(
    case: MartianCase,
    *,
    diff_dir: Path | None,
    cache_diff_dir: Path | None = None,
    fetch_diffs: bool = False,
    repository_root: Path | None = None,
) -> ContextBundle:
    diff_text = load_diff_text(case, diff_dir=diff_dir, cache_diff_dir=cache_diff_dir, fetch_diffs=fetch_diffs)
    repo = parse_github_pull_url(case.original_url or case.url)
    change_request = ChangeRequest(
        schemaVersion="1.0.0",
        id=f"cr_martian_{case.case_id}",
        repository=Repository(
            schemaVersion="1.0.0",
            id=f"repo_martian_{repo['owner']}_{repo['repo']}",
            provider="github",
            owner=repo["owner"],
            name=repo["repo"],
            fullName=f"{repo['owner']}/{repo['repo']}",
            defaultBranch="main",
            webUrl=f"https://github.com/{repo['owner']}/{repo['repo']}",
        ),
        provider="github",
        providerChangeRequestId=repo["number"],
        number=int(repo["number"]),
        title=case.pr_title,
        state="open",
        base=ChangeRef(ref="main", sha="0000000"),
        head=ChangeRef(ref=f"pull/{repo['number']}/head", sha="1111111"),
        webUrl=case.original_url or case.url,
        redaction=RedactionSummary(redacted=False, strategy="none"),
    )
    diff = parse_unified_diff(
        diff_text,
        diff_id=f"diff_martian_{case.case_id}",
        change_request_id=change_request.id,
        base_sha=change_request.base.sha,
        head_sha=change_request.head.sha,
    )
    return build_diff_context_bundle(
        review_run_id=f"run_martian_{case.case_id}",
        change_request=change_request,
        diff=diff,
        options=DiffContextOptions(repository_root=str(repository_root)) if repository_root is not None else None,
    )


def load_diff_text(case: MartianCase, *, diff_dir: Path | None, cache_diff_dir: Path | None, fetch_diffs: bool) -> str:
    if diff_dir is not None:
        path = diff_dir / f"{case.case_id}.diff"
        if path.exists():
            return path.read_text(encoding="utf-8")
    if cache_diff_dir is not None:
        path = cached_diff_path(cache_diff_dir, case)
        if path.exists():
            return path.read_text(encoding="utf-8")
    if fetch_diffs:
        diff_text = fetch_pull_diff(case.original_url or case.url)
        if cache_diff_dir is not None:
            write_cached_diff(cache_diff_dir, case, diff_text)
        return diff_text
    raise ValueError(f"missing diff for {case.case_id}; provide --diff-dir or --fetch-diffs")


def fetch_pull_diff(pull_url: str) -> str:
    with urllib.request.urlopen(f"{pull_url}.diff", timeout=60) as response:
        return response.read().decode("utf-8")


def cached_diff_path(cache_diff_dir: Path, case: MartianCase) -> Path:
    return cache_diff_dir / f"{case.case_id}.diff"


def write_cached_diff(cache_diff_dir: Path, case: MartianCase, diff_text: str) -> None:
    path = cached_diff_path(cache_diff_dir, case)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(diff_text, encoding="utf-8")
    write_json(path.with_suffix(".diff.meta.json"), {"caseId": case.case_id, "url": case.original_url or case.url, "sha256": sha256_text(diff_text)})


def parse_unified_diff(text: str, *, diff_id: str, change_request_id: str, base_sha: str, head_sha: str) -> Diff:
    files: list[ChangedFile] = []
    current_path: str | None = None
    old_path: str | None = None
    new_path: str | None = None
    hunks: list[DiffHunk] = []
    hunk_lines: list[DiffLine] | None = None
    old_line = 0
    new_line = 0
    additions = 0
    deletions = 0
    hunk_old_start = hunk_old_lines = hunk_new_start = hunk_new_lines = 0
    hunk_header: str | None = None

    def finish_hunk() -> None:
        nonlocal hunk_lines
        if hunk_lines is None:
            return
        hunks.append(
            DiffHunk(
                oldStart=hunk_old_start,
                oldLines=hunk_old_lines,
                newStart=hunk_new_start,
                newLines=hunk_new_lines,
                lines=hunk_lines,
                header=hunk_header,
            )
        )
        hunk_lines = None

    def finish_file() -> None:
        nonlocal current_path, old_path, new_path, hunks, additions, deletions
        finish_hunk()
        if current_path is None:
            return
        files.append(
            ChangedFile(
                path=current_path,
                status=file_status(old_path, new_path),
                additions=additions,
                deletions=deletions,
                language=language_for_path(current_path),
                hunks=hunks,
            )
        )
        current_path = old_path = new_path = None
        hunks = []
        additions = deletions = 0

    for raw_line in text.splitlines():
        if raw_line.startswith("diff --git "):
            finish_file()
            parts = raw_line.split()
            old_path = strip_diff_path(parts[2]) if len(parts) > 2 else None
            new_path = strip_diff_path(parts[3]) if len(parts) > 3 else old_path
            current_path = new_path or old_path
        elif raw_line.startswith("--- "):
            old_path = strip_diff_path(raw_line[4:].strip())
        elif raw_line.startswith("+++ "):
            new_path = strip_diff_path(raw_line[4:].strip())
            current_path = new_path or old_path
        elif raw_line.startswith("@@ "):
            finish_hunk()
            match = HUNK_RE.match(raw_line)
            if match is None:
                raise ValueError(f"unsupported unified diff hunk header: {raw_line}")
            hunk_old_start = int(match.group("old_start"))
            hunk_old_lines = int(match.group("old_lines") or "1")
            hunk_new_start = int(match.group("new_start"))
            hunk_new_lines = int(match.group("new_lines") or "1")
            hunk_header = match.group("header").strip() or None
            old_line = hunk_old_start
            new_line = hunk_new_start
            hunk_lines = []
        elif hunk_lines is not None:
            if raw_line.startswith("\\"):
                hunk_lines.append(DiffLine(kind="metadata", content=raw_line))
            elif raw_line.startswith("+"):
                hunk_lines.append(DiffLine(kind="added", content=raw_line[1:], newLine=new_line))
                additions += 1
                new_line += 1
            elif raw_line.startswith("-"):
                hunk_lines.append(DiffLine(kind="deleted", content=raw_line[1:], oldLine=old_line))
                deletions += 1
                old_line += 1
            else:
                content = raw_line[1:] if raw_line.startswith(" ") else raw_line
                hunk_lines.append(DiffLine(kind="context", content=content, oldLine=old_line, newLine=new_line))
                old_line += 1
                new_line += 1

    finish_file()
    if not files:
        raise ValueError("unified diff did not contain any changed files")
    return Diff(
        schemaVersion="1.0.0",
        id=diff_id,
        changeRequestId=change_request_id,
        baseSha=base_sha,
        headSha=head_sha,
        summary=DiffSummary(
            fileCount=len(files),
            additions=sum(file.additions for file in files),
            deletions=sum(file.deletions for file in files),
            languages=sorted({file.language for file in files if file.language}) or None,
        ),
        files=files,
    )


def compare_martian_result(
    *,
    backend: str,
    case: MartianCase,
    raw_output: ReviewerOutput,
    findings: list[Finding],
    duration_ms: int,
    match_mode: str,
    judgments: list[dict[str, Any]],
    judge: str | None = None,
) -> MartianComparisonRow:
    reviewer_provider = raw_output.modelMetadata.provider if raw_output.modelMetadata else None
    reviewer_model = raw_output.modelMetadata.model if raw_output.modelMetadata else None
    judge_provider = "codex-app-server" if judge == "codex-app-server" else judge_provider_from_judgments(judgments)
    judge_model = judge_model_from_judgments(judgments)
    match_result = match_findings(case, findings, match_mode=match_mode, judgments=judgments)
    if match_result is None:
        return MartianComparisonRow(
            backend=backend,
            case_id=case.case_id,
            reviewer_provider=reviewer_provider,
            reviewer_model=reviewer_model,
            judge_provider=judge_provider,
            judge_model=judge_model,
            candidate_count=len(findings),
            golden_count=len(case.golden_comments),
            true_positives=None,
            false_positives=None,
            false_negatives=None,
            precision=None,
            recall=None,
            duration_ms=duration_ms,
        )

    true_positives = len(match_result.candidate_indexes)
    false_positives = len(findings) - true_positives
    false_negatives = len(case.golden_comments) - len(match_result.golden_indexes)
    return MartianComparisonRow(
        backend=backend,
        case_id=case.case_id,
        reviewer_provider=reviewer_provider,
        reviewer_model=reviewer_model,
        judge_provider=judge_provider,
        judge_model=judge_model,
        candidate_count=len(findings),
        golden_count=len(case.golden_comments),
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=true_positives / len(findings) if findings else 0.0,
        recall=len(match_result.golden_indexes) / len(case.golden_comments) if case.golden_comments else 0.0,
        duration_ms=duration_ms,
    )


def match_findings(
    case: MartianCase,
    findings: list[Finding],
    *,
    match_mode: str,
    judgments: list[dict[str, Any]],
) -> MatchResult | None:
    if match_mode == "unjudged":
        return None
    if match_mode == "judgments":
        return match_from_judgments(judgments)
    if match_mode == "lexical":
        return lexical_match(case, findings)
    raise ValueError(f"unsupported match mode: {match_mode}")


def match_from_judgments(judgments: list[dict[str, Any]]) -> MatchResult:
    candidate_indexes: set[int] = set()
    golden_indexes: set[int] = set()
    for judgment in judgments:
        if not judgment.get("sameIssue", False):
            continue
        candidate_indexes.add(int(judgment["candidateIndex"]))
        golden_indexes.add(int(judgment["goldenIndex"]))
    return MatchResult(candidate_indexes=candidate_indexes, golden_indexes=golden_indexes)


def lexical_match(case: MartianCase, findings: list[Finding]) -> MatchResult:
    candidate_indexes: set[int] = set()
    golden_indexes: set[int] = set()
    for candidate_index, finding in enumerate(findings):
        candidate_tokens = tokenize(f"{finding.title} {finding.body} {' '.join(evidence.summary for evidence in finding.evidence)}")
        best_golden_index: int | None = None
        best_score = 0
        for golden_index, golden in enumerate(case.golden_comments):
            if golden_index in golden_indexes:
                continue
            score = len(candidate_tokens & tokenize(golden.comment))
            if score > best_score:
                best_score = score
                best_golden_index = golden_index
        if best_golden_index is not None and best_score >= 3:
            candidate_indexes.add(candidate_index)
            golden_indexes.add(best_golden_index)
    return MatchResult(candidate_indexes=candidate_indexes, golden_indexes=golden_indexes)


def candidate_golden_pairs(case: MartianCase, findings: list[Finding]) -> list[dict[str, Any]]:
    return [
        {
            "candidateIndex": candidate_index,
            "goldenIndex": golden_index,
            "candidate": {
                "title": finding.title,
                "body": finding.body,
                "severity": finding.severity,
                "location": to_jsonable(finding.location) if finding.location else None,
                "evidence": to_jsonable(finding.evidence),
            },
            "golden": asdict(golden),
        }
        for candidate_index, finding in enumerate(findings)
        for golden_index, golden in enumerate(case.golden_comments)
    ]


def judge_findings(case: MartianCase, findings: list[Finding], *, judge: str, max_judge_pairs: int) -> list[dict[str, Any]]:
    if judge == "codex-app-server":
        return judge_findings_with_codex(case, findings, max_judge_pairs=max_judge_pairs)
    raise ValueError(f"unsupported Martian judge: {judge}")


def judge_findings_with_codex(case: MartianCase, findings: list[Finding], *, max_judge_pairs: int) -> list[dict[str, Any]]:
    pairs = candidate_golden_pairs(case, findings)
    if not pairs:
        return []
    if len(pairs) > max_judge_pairs:
        raise ValueError(f"judge pair count {len(pairs)} exceeds --max-judge-pairs {max_judge_pairs}")
    config = codex_judge_config_from_env()
    client = CodexAppServerClient(config)
    try:
        text = client.complete_text(build_judge_prompt(case, pairs))
    finally:
        client.close()
    return parse_judge_output(text, expected_pairs=pairs, judge_model=config.model)


def codex_judge_config_from_env() -> CodexAppServerConfig:
    base = CodexAppServerConfig.from_env()
    return CodexAppServerConfig(
        command=base.command,
        model=os.environ.get("HEIMDALL_MARTIAN_JUDGE_MODEL", base.model),
        reasoning_effort=os.environ.get("HEIMDALL_MARTIAN_JUDGE_REASONING_EFFORT", base.reasoning_effort),
        cwd=base.cwd,
        timeout_seconds=float(os.environ.get("HEIMDALL_MARTIAN_JUDGE_TIMEOUT_SECONDS", str(base.timeout_seconds))),
    )


def build_judge_prompt(case: MartianCase, pairs: list[dict[str, Any]]) -> str:
    payload = {
        "caseId": case.case_id,
        "prTitle": case.pr_title,
        "instructions": (
            "For each candidate/golden pair, decide whether both describe the same underlying code review issue. "
            "Different wording is fine. Do not require identical severity or location. Return false when the candidate "
            "is only nearby, broader, narrower, or about a different failure mode."
        ),
        "pairs": pairs,
    }
    return (
        "You are the semantic judge for Heimdall's Martian Code Review Bench run. "
        "Return exactly one JSON object with a matches array. Each match object must include caseId, candidateIndex, "
        "goldenIndex, sameIssue, and rationale. Include every input pair exactly once.\n\n"
        f"{json.dumps(payload, indent=2, sort_keys=True)}"
    )


def parse_judge_output(text: str, *, expected_pairs: list[dict[str, Any]], judge_model: str) -> list[dict[str, Any]]:
    data = json_from_text(text)
    matches = data.get("matches")
    if not isinstance(matches, list):
        raise ValueError("judge output must contain a matches array")
    expected_keys = {(int(pair["candidateIndex"]), int(pair["goldenIndex"])) for pair in expected_pairs}
    parsed: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    for match in matches:
        if not isinstance(match, dict):
            raise ValueError("judge match entries must be objects")
        key = (int(match["candidateIndex"]), int(match["goldenIndex"]))
        if key not in expected_keys:
            raise ValueError(f"judge returned unexpected candidate/golden pair: {key}")
        seen.add(key)
        parsed.append(
            {
                "caseId": require_string(match, "caseId"),
                "candidateIndex": key[0],
                "goldenIndex": key[1],
                "sameIssue": bool(match.get("sameIssue", False)),
                "rationale": str(match.get("rationale", "")),
                "judge": {"provider": "codex-app-server", "model": judge_model},
            }
        )
    if seen != expected_keys:
        raise ValueError("judge did not return every candidate/golden pair")
    return parsed


def json_from_text(text: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = JSON_OBJECT_RE.search(text)
        if match is None:
            raise ValueError("judge output did not include a JSON object") from None
        data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise ValueError("judge output must be a JSON object")
    return data


def failed_row(
    backend: str,
    case_id: str,
    reviewer_provider: str | None,
    reviewer_model: str | None,
    judge_provider: str | None,
    judge_model: str | None,
    candidate_count: int,
    golden_count: int,
    duration_ms: int,
    error: Exception,
) -> MartianComparisonRow:
    return MartianComparisonRow(
        backend=backend,
        case_id=case_id,
        reviewer_provider=reviewer_provider,
        reviewer_model=reviewer_model,
        judge_provider=judge_provider,
        judge_model=judge_model,
        candidate_count=candidate_count,
        golden_count=golden_count,
        true_positives=None,
        false_positives=None,
        false_negatives=None,
        precision=None,
        recall=None,
        duration_ms=duration_ms,
        error=f"{type(error).__name__}: {error}",
        total_ms=duration_ms,
    )


def write_case_artifacts(
    run_dir: Path,
    backend: str,
    case: MartianCase,
    context_bundle: ContextBundle,
    raw_output: ReviewerOutput,
    findings: list[Finding],
    row: MartianComparisonRow,
    judgments: list[dict[str, Any]] | None = None,
) -> None:
    case_dir = run_dir / backend / case.case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    write_json(case_dir / "martian-case.json", asdict(case))
    write_json(case_dir / "context-bundle.json", to_jsonable(context_bundle))
    write_json(case_dir / "raw-output.json", to_jsonable(raw_output))
    write_json(case_dir / "validated-findings.json", to_jsonable(findings))
    write_json(case_dir / "candidate-golden-pairs.json", candidate_golden_pairs(case, findings))
    if judgments is not None:
        write_json(case_dir / "judgments.json", {"matches": judgments})
    write_json(case_dir / "comparison.json", asdict(row))


def write_error_artifacts(run_dir: Path, backend: str, case: MartianCase, row: MartianComparisonRow) -> None:
    case_dir = run_dir / backend / case.case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    write_json(case_dir / "martian-case.json", asdict(case))
    write_json(case_dir / "error.json", asdict(row))


def load_judgments(path: Path) -> dict[str, list[dict[str, Any]]]:
    data = load_json(path)
    if isinstance(data, dict) and isinstance(data.get("matches"), list):
        result: dict[str, list[dict[str, Any]]] = {}
        for match in data["matches"]:
            result.setdefault(require_string(match, "caseId"), []).append(match)
        return result
    if isinstance(data, dict):
        return {str(case_id): list(matches) for case_id, matches in data.items()}
    raise ValueError("judgments must be an object keyed by case id or an object with a matches array")


def load_existing_row(run_dir: Path, backend: str, case: MartianCase) -> MartianComparisonRow | None:
    path = run_dir / backend / case.case_id / "comparison.json"
    if not path.exists():
        return None
    return MartianComparisonRow(**load_json(path))


def parse_repo_roots(values: list[str]) -> dict[str, Path]:
    repo_roots: dict[str, Path] = {}
    for value in values:
        case_id, separator, path = value.partition("=")
        if not separator or not case_id or not path:
            raise ValueError(f"--repo-root must use <case-id>=<path>: {value}")
        repo_roots[case_id] = Path(path)
    return repo_roots


def aggregate_rows(rows: list[MartianComparisonRow]) -> dict[str, Any]:
    judged = [row for row in rows if row.true_positives is not None and row.false_positives is not None and row.false_negatives is not None]
    true_positives = sum(row.true_positives or 0 for row in judged)
    false_positives = sum(row.false_positives or 0 for row in judged)
    false_negatives = sum(row.false_negatives or 0 for row in judged)
    candidates = sum(row.candidate_count for row in rows)
    goldens = sum(row.golden_count for row in rows)
    context_ms = sum(row.context_ms or 0 for row in rows)
    review_ms = sum(row.review_ms or 0 for row in rows)
    judge_ms = sum(row.judge_ms or 0 for row in rows)
    total_ms = sum(row.total_ms or row.duration_ms for row in rows)
    review_phase_ms: dict[str, int] = {}
    for row in rows:
        for key, value in (row.review_phase_ms or {}).items():
            review_phase_ms[key] = review_phase_ms.get(key, 0) + value
    review_input_profile: dict[str, int] = {}
    for row in rows:
        for key, value in (row.review_input_profile or {}).items():
            review_input_profile[key] = review_input_profile.get(key, 0) + value
    return {
        "schemaVersion": "1.0.0",
        "caseCount": len(rows),
        "errorCount": sum(1 for row in rows if row.error),
        "judgedCaseCount": len(judged),
        "candidateCount": candidates,
        "goldenCount": goldens,
        "truePositives": true_positives,
        "falsePositives": false_positives,
        "falseNegatives": false_negatives,
        "precision": true_positives / (true_positives + false_positives) if true_positives + false_positives else None,
        "recall": true_positives / (true_positives + false_negatives) if true_positives + false_negatives else None,
        "durationMs": sum(row.duration_ms for row in rows),
        "contextMs": context_ms,
        "reviewMs": review_ms,
        "judgeMs": judge_ms,
        "totalMs": total_ms,
        "reviewPhaseMs": review_phase_ms,
        "reviewInputProfile": review_input_profile,
    }


def write_run_metadata(run_dir: Path, metadata: MartianRunMetadata) -> None:
    write_json(run_dir / "run-metadata.json", asdict(metadata))


def format_table(rows: list[MartianComparisonRow]) -> str:
    headers = [
        "backend",
        "case",
        "reviewer",
        "judge",
        "candidates",
        "goldens",
        "tp",
        "fp",
        "fn",
        "precision",
        "recall",
        "ms",
        "context",
        "review",
        "judge-ms",
        "total",
        "error",
    ]
    body = [
        [
            row.backend,
            row.case_id,
            format_model(row.reviewer_provider, row.reviewer_model),
            format_model(row.judge_provider, row.judge_model),
            str(row.candidate_count),
            str(row.golden_count),
            format_optional_int(row.true_positives),
            format_optional_int(row.false_positives),
            format_optional_int(row.false_negatives),
            format_optional_float(row.precision),
            format_optional_float(row.recall),
            str(row.duration_ms),
            format_optional_int(row.context_ms),
            format_optional_int(row.review_ms),
            format_optional_int(row.judge_ms),
            format_optional_int(row.total_ms),
            row.error or "",
        ]
        for row in rows
    ]
    widths = [max(len(item) for item in column) for column in zip(headers, *body, strict=False)]
    lines = [format_row(headers, widths), format_row(["-" * width for width in widths], widths)]
    lines.extend(format_row(row, widths) for row in body)
    return "\n".join(lines)


def parse_github_pull_url(url: str) -> dict[str, str]:
    parsed = urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if parsed.netloc != "github.com" or len(parts) < 4 or parts[2] != "pull":
        raise ValueError(f"expected GitHub pull request URL, got {url}")
    return {"owner": parts[0], "repo": parts[1], "number": parts[3], "title": f"{parts[0]}/{parts[1]}#{parts[3]}"}


def case_id_for_url(url: str) -> str:
    repo = parse_github_pull_url(url)
    return sanitize_id(f"{repo['owner']}_{repo['repo']}_{repo['number']}")


def sanitize_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.:-]+", "_", value).strip("_")


def strip_diff_path(path: str | None) -> str | None:
    if path is None or path == "/dev/null":
        return None
    if path.startswith("a/") or path.startswith("b/"):
        return path[2:]
    return path


def file_status(old_path: str | None, new_path: str | None) -> str:
    if old_path is None:
        return "added"
    if new_path is None:
        return "deleted"
    if old_path != new_path:
        return "renamed"
    return "modified"


def language_for_path(path: str) -> str | None:
    suffix = Path(path).suffix.lower()
    return {
        ".go": "Go",
        ".js": "JavaScript",
        ".jsx": "JavaScript",
        ".py": "Python",
        ".rs": "Rust",
        ".ts": "TypeScript",
        ".tsx": "TypeScript",
    }.get(suffix)


def normalize_martian_severity(value: Any) -> str:
    severity = str(value or "Medium").strip().casefold()
    return {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}.get(severity, "medium")


def judge_model_from_judgments(judgments: list[dict[str, Any]]) -> str | None:
    for judgment in judgments:
        judge = judgment.get("judge")
        if isinstance(judge, dict) and isinstance(judge.get("model"), str):
            return judge["model"]
    return None


def judge_provider_from_judgments(judgments: list[dict[str, Any]]) -> str | None:
    for judgment in judgments:
        judge = judgment.get("judge")
        if isinstance(judge, dict) and isinstance(judge.get("provider"), str):
            return judge["provider"]
    return None


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def tokenize(text: str) -> set[str]:
    return {token for token in re.findall(r"[a-z0-9_]{3,}", text.casefold()) if token not in STOPWORDS}


def require_string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"expected non-empty string field {key}")
    return result


def format_optional_int(value: int | None) -> str:
    return "" if value is None else str(value)


def format_optional_float(value: float | None) -> str:
    return "" if value is None else f"{value:.3f}"


def format_model(provider: str | None, model: str | None) -> str:
    if provider and model:
        return f"{provider}:{model}"
    return provider or model or ""


def format_row(values: list[str], widths: list[int]) -> str:
    return "  ".join(value.ljust(width) for value, width in zip(values, widths, strict=True))


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(value, indent=2, sort_keys=True)}\n", encoding="utf-8")


def elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Heimdall reviewer backends against Martian Code Review Bench offline cases.")
    parser.add_argument("--backend", action="append", required=True, help="Reviewer backend name. Repeat to compare.")
    parser.add_argument("--golden-dir", type=Path, help="Path to Martian offline/golden_comments.")
    parser.add_argument("--benchmark-data", type=Path, help="Path to Martian offline results/benchmark_data.json.")
    parser.add_argument("--diff-dir", type=Path, help="Directory containing <case-id>.diff files.")
    parser.add_argument("--cache-diff-dir", type=Path, help="Directory for stable cached Martian PR diffs.")
    parser.add_argument("--cache-diffs-only", action="store_true", help="Fetch/cache selected PR diffs and exit without running reviewers.")
    parser.add_argument("--refresh-diff-cache", action="store_true", help="Refetch cached diffs instead of reusing existing cache files.")
    parser.add_argument("--fetch-diffs", action="store_true", help="Fetch PR .diff files from GitHub. Opt-in network access.")
    parser.add_argument("--case", action="append", help="Martian case id, such as getsentry_sentry_93824. Repeat to include more.")
    parser.add_argument("--limit", type=int, help="Maximum number of Martian cases to run.")
    parser.add_argument("--match-mode", choices=("unjudged", "lexical", "judgments"), default="unjudged")
    parser.add_argument("--judgments", type=Path, help="JSON file containing semantic candidate/golden judgments.")
    parser.add_argument("--judge", choices=("codex-app-server",), help="Generate semantic judgments with an opt-in judge backend.")
    parser.add_argument("--max-judge-pairs", type=int, default=DEFAULT_MAX_JUDGE_PAIRS, help="Maximum candidate/golden pairs to judge per case.")
    parser.add_argument("--max-run-seconds", type=int, help="Stop scheduling new cases after this many wall-clock seconds.")
    parser.add_argument(
        "--repo-root",
        action="append",
        default=[],
        help="Map a Martian case id to a clean repository checkout as <case-id>=<path>. Required for agentic review backends.",
    )
    parser.add_argument("--force", action="store_true", help="Rerun cases even when successful comparison artifacts already exist.")
    parser.add_argument("--no-resume", action="store_true", help="Do not skip successful comparison artifacts in the output directory.")
    parser.add_argument("--out", type=Path, help="Output directory for run artifacts.")
    args = parser.parse_args()

    if args.cache_diffs_only:
        if args.cache_diff_dir is None:
            parser.error("--cache-diffs-only requires --cache-diff-dir")
        cases = load_martian_cases(golden_dir=args.golden_dir, benchmark_data=args.benchmark_data, case_ids=args.case, limit=args.limit)
        rows = cache_martian_diffs(cases, args.cache_diff_dir, refresh=args.refresh_diff_cache)
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0

    match_mode = "judgments" if args.judgments and args.match_mode == "unjudged" else args.match_mode
    rows = run_martian_benchmark(
        args.backend,
        golden_dir=args.golden_dir,
        benchmark_data=args.benchmark_data,
        diff_dir=args.diff_dir,
        cache_diff_dir=args.cache_diff_dir,
        fetch_diffs=args.fetch_diffs,
        case_ids=args.case,
        limit=args.limit,
        output_dir=args.out,
        match_mode=match_mode,
        judgments_path=args.judgments,
        judge=args.judge,
        max_judge_pairs=args.max_judge_pairs,
        max_run_seconds=args.max_run_seconds,
        repo_roots=parse_repo_roots(args.repo_root),
        resume=not args.no_resume,
        force=args.force,
    )
    print(format_table(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
