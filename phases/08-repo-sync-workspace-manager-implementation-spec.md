# #8 Repo Sync and Workspace Manager Implementation Spec

Status: Draft v1  
Target package: `/packages/repo-sync`  
Primary app users: `/apps/worker`, `/apps/indexer-cli`, `/packages/indexer-driver`, `/packages/review-engine`  
Primary runtime: Bun/Node-compatible TypeScript  
Primary external tool: Git CLI  
Primary storage dependency: local disk cache + Postgres metadata + optional object storage artifact references

---

## 1. Purpose

The repo sync and workspace manager is responsible for making a repository available on disk at an exact commit SHA so that other subsystems can index, retrieve, analyze, or review code.

It owns the lifecycle from:

```text
repo + commit SHA + installation credentials
  -> local cached Git mirror
  -> isolated checked-out workspace
  -> validated filesystem view
  -> cleanup / lease release
```

It should be fast, safe, deterministic, observable, and replaceable.

The rest of the system should not directly run arbitrary `git` commands. It should ask this package for a workspace, use the returned path, and release it.

---

## 2. Why this component matters

This system will review many pull requests across many repositories. Repo checkout is on the hot path for:

```text
- initial indexing
- incremental indexing
- PR review
- static analysis
- local test/lint execution
- artifact generation
- replay/debug workflows
```

If repo sync is slow, everything feels slow.

If repo sync is unsafe, customer source code, tokens, or worker machines can be exposed.

If repo sync is nondeterministic, review runs cannot be reproduced.

The main performance goal is:

```text
Do not clone from scratch for every job.
Fetch once into a durable mirror cache.
Create short-lived worktrees for exact commits.
Reuse unchanged Git objects and unchanged file content.
```

---

## 3. Design goals

### 3.1 Deterministic

Every workspace must be pinned to an exact commit SHA.

Good:

```text
repoId=repo_123 commitSha=abc123...
```

Bad:

```text
branch=main
```

Branches move. Commit SHAs do not.

### 3.2 Fast

The manager should avoid repeated network and disk work.

Use:

```text
- bare mirror cache
- worktrees
- content-addressed workspace metadata
- fetch dedupe locks
- shallow/partial clone strategies where safe
- LFS skip-smudge by default
- path and file filters before indexing
```

### 3.3 Safe

The manager handles private source code and provider tokens.

It must:

```text
- avoid logging tokens
- avoid writing tokens into repo config
- isolate workspaces per job
- enforce disk quotas
- enforce timeouts
- block path traversal
- scrub environment variables
- clean up reliably
- avoid following unsafe symlinks during scans
```

### 3.4 Provider-neutral core

The package may use GitHub installation tokens today, but the core should not be GitHub-specific.

Use a provider-neutral credential interface:

```ts
export type GitCredential =
  | { kind: "https-basic-token"; username: string; token: string }
  | { kind: "bearer-token"; token: string }
  | { kind: "ssh-key"; privateKeyRef: string };
```

GitHub-specific token generation should remain in `/packages/github`.

### 3.5 Clear lease lifecycle

A checked-out workspace is a leased resource.

The worker should acquire it, use it, and release it:

```ts
const lease = await workspaceManager.acquireWorkspace({ repoId, commitSha, purpose });
try {
  await indexer.index({ workspacePath: lease.path, commitSha });
} finally {
  await lease.release();
}
```

### 3.6 No business logic leakage

Repo sync should not know how to review PRs, embed chunks, post GitHub comments, or call LLMs.

It should only provide repository filesystem access.

---

## 4. Non-goals

The repo sync package should not implement:

```text
- PR review logic
- indexing logic
- retrieval logic
- LLM calls
- GitHub webhook routing
- provider token generation
- billing
- user-facing dashboard APIs
- long-term artifact storage decisions
```

It can expose metadata that those systems need, but it should not own their workflows.

---

## 5. High-level architecture

```text
/apps/worker
  |
  | acquire workspace
  v
/packages/repo-sync
  |
  +--> credential resolver
  |
  +--> repo mirror cache
  |
  +--> git command runner
  |
  +--> fetch lock manager
  |
  +--> worktree manager
  |
  +--> workspace validator
  |
  +--> cleanup manager
  |
  v
local filesystem
  |
  +--> /var/app/git-cache/mirrors/<repoId>.git
  +--> /var/app/git-cache/worktrees/<leaseId>
```

Recommended physical layout:

```text
/var/app/git-cache
  /mirrors
    /repo_<id>.git
  /worktrees
    /lease_<id>
  /tmp
    /clone_<id>
  /locks
    /repo_<id>.lock
```

For local development:

```text
.local/git-cache
  /mirrors
  /worktrees
  /tmp
  /locks
```

---

## 6. Package layout

```text
/packages/repo-sync
  package.json
  tsconfig.json
  src/
    index.ts
    types.ts
    errors.ts
    config.ts
    repo-syncer.ts
    workspace-manager.ts
    mirror-cache.ts
    git-runner.ts
    git-url.ts
    git-env.ts
    credential-resolver.ts
    lock-manager.ts
    disk-quota.ts
    path-utils.ts
    file-filter.ts
    generated-files.ts
    lfs.ts
    submodules.ts
    cleanup.ts
    metrics.ts
    test-utils.ts
  tests/
    fixtures/
    unit/
    integration/
```

Exports:

```ts
export * from "./types";
export * from "./errors";
export { createRepoSyncer } from "./repo-syncer";
export { createWorkspaceManager } from "./workspace-manager";
export { createGitRunner } from "./git-runner";
```

---

## 7. Main interfaces

### 7.1 RepoSyncer

The high-level entrypoint.

```ts
export interface RepoSyncer {
  ensureMirror(input: EnsureMirrorInput): Promise<MirrorRef>;
  ensureCommit(input: EnsureCommitInput): Promise<CommitAvailability>;
  acquireWorkspace(input: AcquireWorkspaceInput): Promise<WorkspaceLease>;
  cleanupExpiredLeases(input?: CleanupExpiredLeasesInput): Promise<CleanupResult>;
  getCacheStats(input?: CacheStatsInput): Promise<RepoCacheStats>;
}
```

### 7.2 EnsureMirrorInput

```ts
export type EnsureMirrorInput = {
  repoId: string;
  provider: "github" | "gitlab" | "bitbucket";
  cloneUrl: string;
  defaultBranch?: string;
  credential: GitCredential;
  options?: MirrorOptions;
  requestId?: string;
};
```

### 7.3 MirrorOptions

```ts
export type MirrorOptions = {
  strategy?: "full" | "partial-blobless" | "shallow";
  allowPartialClone?: boolean;
  allowShallowClone?: boolean;
  fetchTags?: boolean;
  maxFetchSeconds?: number;
  maxMirrorBytes?: number;
  lfsMode?: "skip" | "pointer-only" | "fetch";
};
```

Recommended defaults:

```ts
export const DEFAULT_MIRROR_OPTIONS: Required<MirrorOptions> = {
  strategy: "partial-blobless",
  allowPartialClone: true,
  allowShallowClone: false,
  fetchTags: false,
  maxFetchSeconds: 120,
  maxMirrorBytes: 20 * 1024 * 1024 * 1024,
  lfsMode: "skip",
};
```

Notes:

- `partial-blobless` is a good default for large repositories, but it can cause later blob fetches when files are actually read.
- `shallow` should be used carefully because review/index operations may need merge-base history or changed file context.
- `full` is safer for correctness but slower and more disk-heavy.

### 7.4 EnsureCommitInput

```ts
export type EnsureCommitInput = {
  repoId: string;
  commitSha: string;
  cloneUrl: string;
  credential: GitCredential;
  fetchRefHints?: string[];
  options?: MirrorOptions;
  requestId?: string;
};
```

`fetchRefHints` may include provider-specific refs or branch names:

```text
refs/pull/123/head
refs/pull/123/merge
main
feature/foo
```

The function must still validate that the requested `commitSha` exists after fetching.

### 7.5 AcquireWorkspaceInput

```ts
export type AcquireWorkspaceInput = {
  repoId: string;
  commitSha: string;
  cloneUrl: string;
  credential: GitCredential;
  purpose:
    | "index"
    | "review"
    | "static_analysis"
    | "debug"
    | "replay";
  fetchRefHints?: string[];
  options?: WorkspaceOptions;
  requestId?: string;
  reviewRunId?: string;
  jobId?: string;
};
```

### 7.6 WorkspaceOptions

```ts
export type WorkspaceOptions = {
  ttlSeconds?: number;
  readOnly?: boolean;
  sparsePaths?: string[];
  checkoutMode?: "worktree" | "archive" | "copy";
  maxWorkspaceBytes?: number;
  maxFileBytes?: number;
  includeSubmodules?: boolean;
  lfsMode?: "skip" | "pointer-only" | "fetch";
  cleanBeforeUse?: boolean;
  allowSymlinks?: boolean;
};
```

Recommended defaults:

```ts
export const DEFAULT_WORKSPACE_OPTIONS: Required<WorkspaceOptions> = {
  ttlSeconds: 60 * 30,
  readOnly: false,
  sparsePaths: [],
  checkoutMode: "worktree",
  maxWorkspaceBytes: 5 * 1024 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  includeSubmodules: false,
  lfsMode: "skip",
  cleanBeforeUse: true,
  allowSymlinks: true,
};
```

### 7.7 WorkspaceLease

```ts
export type WorkspaceLease = {
  leaseId: string;
  repoId: string;
  commitSha: string;
  path: string;
  mirrorPath: string;
  createdAt: string;
  expiresAt: string;
  purpose: AcquireWorkspaceInput["purpose"];
  readOnly: boolean;
  metadata: {
    checkoutMode: WorkspaceOptions["checkoutMode"];
    sparse: boolean;
    lfsMode: NonNullable<WorkspaceOptions["lfsMode"]>;
    gitVersion: string;
  };
  release(): Promise<void>;
};
```

---

## 8. Database metadata

The DB layer spec already owns durable tables. Repo sync should use those tables but not overload them.

Recommended tables from #2:

```text
repositories
repo_index_versions
review_runs
background_jobs
```

Additional useful tables or columns:

```text
repo_cache_entries
workspace_leases
```

### 8.1 repo_cache_entries

Tracks mirror state by worker host or storage volume.

```sql
create table repo_cache_entries (
  id text primary key,
  repo_id text not null references repositories(id),
  cache_node_id text not null,
  mirror_path text not null,
  clone_url_hash text not null,
  default_branch text,
  strategy text not null,
  last_fetch_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  approx_size_bytes bigint,
  git_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, cache_node_id)
);
```

Do not store the clone URL if it may contain credentials. Store a sanitized URL or a hash.

### 8.2 workspace_leases

Tracks active and recently released checkouts.

```sql
create table workspace_leases (
  id text primary key,
  repo_id text not null references repositories(id),
  commit_sha text not null,
  cache_node_id text not null,
  workspace_path text not null,
  mirror_path text not null,
  purpose text not null,
  job_id text,
  review_run_id text,
  status text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  cleanup_started_at timestamptz,
  cleanup_finished_at timestamptz,
  error text
);

create index workspace_leases_repo_commit_idx
  on workspace_leases (repo_id, commit_sha);

create index workspace_leases_expired_idx
  on workspace_leases (expires_at)
  where status in ('active', 'releasing', 'cleanup_failed');
```

Statuses:

```text
active
released
expired
releasing
cleanup_failed
```

MVP option: keep workspace leases in memory and logs only. Production should persist them to support cleanup after process crashes.

---

## 9. Core flows

## 9.1 Acquire workspace flow

```text
Worker
  |
  | acquireWorkspace(repoId, commitSha)
  v
RepoSyncer
  |
  | resolve credentials
  v
CredentialResolver
  |
  | ensure mirror exists
  v
MirrorCache
  |
  | acquire fetch lock
  v
LockManager
  |
  | git fetch requested refs/commit
  v
GitRunner
  |
  | verify commit exists
  v
MirrorCache
  |
  | create worktree for exact commit
  v
WorkspaceManager
  |
  | validate/clean/filter workspace
  v
WorkspaceLease
```

### Pseudocode

```ts
export async function acquireWorkspace(input: AcquireWorkspaceInput): Promise<WorkspaceLease> {
  const options = normalizeWorkspaceOptions(input.options);

  const mirror = await ensureMirror({
    repoId: input.repoId,
    cloneUrl: input.cloneUrl,
    credential: input.credential,
    options: optionsToMirrorOptions(options),
    requestId: input.requestId,
  });

  await ensureCommit({
    repoId: input.repoId,
    commitSha: input.commitSha,
    cloneUrl: input.cloneUrl,
    credential: input.credential,
    fetchRefHints: input.fetchRefHints,
    requestId: input.requestId,
  });

  const lease = await createWorkspaceLease({
    repoId: input.repoId,
    commitSha: input.commitSha,
    mirrorPath: mirror.path,
    purpose: input.purpose,
    options,
  });

  await validateWorkspace(lease.path, options);

  return lease;
}
```

---

## 9.2 Initial mirror creation flow

```text
ensureMirror(repoId)
  |
  | mirror exists?
  |--- yes ---> validate remote URL -> return
  |
  |--- no ----> acquire repo lock
                create temp mirror path
                git clone --bare/--mirror or partial clone
                verify origin URL
                atomically move into cache path
                record cache entry
                return
```

Prefer an atomic temporary path:

```text
/var/app/git-cache/tmp/clone_repo_123_<random>.git
  -> /var/app/git-cache/mirrors/repo_123.git
```

Never create the final path halfway and assume it is valid.

---

## 9.3 Fetch flow

```text
ensureCommit(repoId, commitSha)
  |
  | git cat-file -e <sha>^{commit}
  |--- found ---> return available
  |
  |--- missing -> acquire fetch lock
                 fetch ref hints
                 fetch default branch
                 fetch direct SHA if provider supports it
                 verify commit exists
                 return available or throw
```

Possible commands:

```bash
git -C <mirror> cat-file -e <commitSha>^{commit}

git -C <mirror> fetch --no-tags origin <refHint>

git -C <mirror> fetch --no-tags origin +refs/heads/*:refs/heads/*

git -C <mirror> fetch --no-tags origin +refs/pull/<pr>/head:refs/pull/<pr>/head
```

For GitHub PRs, useful refs include:

```text
refs/pull/<number>/head
refs/pull/<number>/merge
```

The GitHub adapter can provide these hints. Repo sync should just treat them as ref hints.

---

## 9.4 Worktree creation flow

```text
createWorkspaceLease(repoId, commitSha)
  |
  | generate leaseId
  | create workspace path
  | git worktree add --detach <workspacePath> <commitSha>
  | optionally configure sparse checkout
  | optionally set read-only permissions
  | record lease
  | return lease
```

Recommended command:

```bash
git -C <mirrorPath> worktree add --detach <workspacePath> <commitSha>
```

Then cleanup:

```bash
git -C <mirrorPath> worktree remove --force <workspacePath>
git -C <mirrorPath> worktree prune
```

Use `--detach` because a workspace should be pinned to an immutable commit, not a branch.

---

## 9.5 Release flow

```text
lease.release()
  |
  | mark releasing
  | remove worktree
  | prune stale worktree metadata
  | delete residual workspace path if needed
  | mark released
```

Release must be idempotent.

Calling `release()` twice should not throw unless the second call reveals a serious corruption.

---

## 9.6 Crash recovery cleanup flow

```text
cleanupExpiredLeases()
  |
  | find active leases past expiresAt
  | for each lease on this cache_node_id
  |   try git worktree remove --force
  |   rm -rf path if safe path
  |   git worktree prune
  |   update status
```

Run periodically:

```text
- worker startup
- every 5-10 minutes
- before disk pressure cleanup
```

---

## 10. Git command runner

Do not use raw `child_process.exec` scattered across the repo.

Create one command runner.

```ts
export type GitCommandInput = {
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  stdin?: string;
  redact?: string[];
  requestId?: string;
};

export type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export interface GitRunner {
  run(input: GitCommandInput): Promise<GitCommandResult>;
}
```

### 10.1 Safety requirements

The runner must:

```text
- avoid shell interpolation
- pass args as an array
- enforce timeout
- limit stdout/stderr capture size
- redact tokens in logs and errors
- include requestId/jobId/repoId in structured logs
- set safe environment variables
- support cancellation via AbortSignal
```

Use process spawning, not shell strings.

Good:

```ts
spawn("git", ["-C", mirrorPath, "fetch", "--no-tags", "origin", ref]);
```

Bad:

```ts
exec(`git -C ${mirrorPath} fetch origin ${ref}`);
```

### 10.2 Output limits

Git can produce large output. Store truncated stderr/stdout.

Recommended defaults:

```ts
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
```

Include a flag when truncated:

```ts
type CapturedOutput = {
  text: string;
  truncated: boolean;
  originalBytes: number;
};
```

### 10.3 Environment

Use a minimal environment:

```ts
const env = {
  HOME: safeHomeDir,
  PATH: process.env.PATH,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: askpassScriptPath,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  LC_ALL: "C",
};
```

`GIT_TERMINAL_PROMPT=0` prevents Git from hanging on credentials prompts.

`GIT_LFS_SKIP_SMUDGE=1` prevents automatic LFS downloads unless explicitly enabled.

### 10.4 Token injection

Avoid putting credentials in command arguments when possible because args may show up in process lists.

Preferred options:

```text
1. credential helper using a temp config isolated to the process
2. GIT_ASKPASS script that returns token
3. extraHeader if provider supports it, with careful redaction
```

For GitHub HTTPS, a common safe pattern is using an askpass helper:

```bash
GIT_ASKPASS=/tmp/git-askpass-<id>.sh git fetch https://github.com/org/repo.git
```

The askpass script should:

```text
- live in a private temp directory
- be chmod 0700 or 0600/0700 as appropriate
- be deleted immediately after the command
- never be logged
```

Alternative for GitHub:

```bash
git -c http.https://github.com/.extraheader="AUTHORIZATION: basic <redacted>" fetch ...
```

This is convenient but needs extra care because config may be visible in traces/errors if mishandled.

---

## 11. Git URL handling

### 11.1 Sanitization

Never store or log credential-bearing URLs.

Bad:

```text
https://x-access-token:ghs_abc123@github.com/org/repo.git
```

Good:

```text
https://github.com/org/repo.git
```

Implement:

```ts
export function sanitizeGitUrl(url: string): string;
export function hashGitUrl(url: string): string;
export function assertAllowedGitUrl(url: string): void;
```

### 11.2 Allowlist

For MVP, allow only expected provider hostnames:

```text
github.com
www.github.com
```

Later:

```text
gitlab.com
bitbucket.org
customer-owned GitHub Enterprise domains
```

Block suspicious schemes:

```text
file://
ssh:// unless explicitly configured
http:// unless internal/self-hosted policy allows
```

### 11.3 Clone URL source

The GitHub adapter should provide a sanitized HTTPS clone URL and installation token separately.

Repo sync should not parse tokens out of URLs.

---

## 12. Mirror cache strategy

### 12.1 Recommended MVP: bare mirror + worktrees

For each repository:

```text
/var/app/git-cache/mirrors/repo_<id>.git
```

Use linked worktrees for specific commits:

```text
/var/app/git-cache/worktrees/lease_<id>
```

This avoids re-cloning and allows concurrent checkouts.

### 12.2 Mirror vs bare clone

`--mirror` fetches all refs and configures the remote as a mirror. `--bare` creates a bare repository without a working tree.

Recommended for MVP:

```bash
git clone --bare --filter=blob:none --no-tags <url> <mirrorPath>
```

Then fetch specific refs as needed.

Why not always `--mirror`?

```text
- may fetch more refs than needed
- may include tags by default depending on command choices
- PR refs can be managed manually
```

A controlled bare clone with explicit fetch refspecs is often easier to reason about.

### 12.3 Partial clone

Recommended default for large repos:

```bash
git clone --bare --filter=blob:none --no-tags <url> <mirrorPath>
```

`--filter=blob:none` avoids downloading file contents until needed.

Tradeoffs:

```text
Pros:
- faster initial clone
- lower disk usage
- better for large repos

Cons:
- later file reads may trigger lazy blob fetches
- not every Git server supports every filter perfectly
- static analysis may end up needing many blobs anyway
```

For index jobs that read most files, a partial clone may defer rather than eliminate network cost. Still, it can be useful for PR-only review or repositories where ignored/generated/large files are skipped.

### 12.4 Shallow clone

Use shallow clone sparingly.

Potential issue:

```text
Review logic may need merge-base, history, renamed file context, or nearby refs.
```

Prefer partial clone over shallow clone for this product.

### 12.5 Tags

Default:

```text
--no-tags
```

Tags are usually unnecessary for PR review and can be expensive in large repos.

Allow per-repo override if a project relies on tags for version metadata.

### 12.6 Fetch deduplication

Multiple jobs may request the same repo at the same time.

Implement a lock:

```text
repo fetch lock key: repo-sync:fetch:<repoId>:<cacheNodeId>
```

Only one fetch per repo mirror should run at a time.

Other jobs should:

```text
- wait for lock up to a bounded timeout
- re-check whether the commit exists
- fail gracefully if fetch remains unavailable
```

---

## 13. Worktree strategy

### 13.1 Why worktrees

Worktrees let one repository have multiple checked-out directories attached to the same underlying repository object database.

This is ideal for concurrent jobs:

```text
same mirror object database
  -> worktree at baseSha for indexing
  -> worktree at headSha for indexing
  -> worktree at headSha for static analysis
  -> worktree for replay/debug
```

### 13.2 Worktree path

Use a generated lease ID:

```text
/var/app/git-cache/worktrees/lease_<ulid>
```

Do not include repo names or branch names in paths. They can contain unsafe or awkward characters and can leak customer info into logs.

### 13.3 Detached HEAD

Always use detached commit checkout:

```bash
git -C <mirrorPath> worktree add --detach <workspacePath> <commitSha>
```

Do not check out branches.

### 13.4 Cleanliness

New worktrees should be clean by construction. Still verify:

```bash
git -C <workspacePath> status --porcelain=v1
```

If a reused or debug workspace is ever allowed, run:

```bash
git -C <workspacePath> reset --hard
git -C <workspacePath> clean -fdx
```

MVP should avoid reusing worktrees. Create fresh short-lived worktrees.

### 13.5 Read-only mode

For indexing/retrieval, read-only workspaces are safer.

Possible approaches:

```text
- chmod files/directories read-only after checkout
- run indexer with user permissions that cannot write outside workspace
- run indexer in sandbox/container with workspace mounted read-only
```

Caveat: some tools expect to write caches. For static analysis, use a writable temp/cache directory outside the repo.

---

## 14. Sparse checkout strategy

Sparse checkout is optional.

Use it only when the caller has a clear path list, such as:

```text
- changed files
- files needed for PR-only review
- known config files
```

Do not use sparse checkout for full indexing unless you are intentionally indexing only part of the repo.

Potential flow:

```bash
git -C <workspacePath> sparse-checkout init --cone
git -C <workspacePath> sparse-checkout set src packages config
```

Recommended use cases:

```text
- huge monorepos
- PR-only context retrieval
- debug/replay of a small area
```

Avoid for:

```text
- initial full repo index
- language analyzers that need project-wide context
- package managers that expect many files
```

---

## 15. Git LFS handling

Default mode:

```text
lfsMode: skip
```

This means:

```text
GIT_LFS_SKIP_SMUDGE=1
```

Rationale:

```text
- LFS files are often large binaries
- review/indexing generally does not need full LFS objects
- automatic smudge can make clones slow and memory-heavy
```

Supported modes:

```ts
type LfsMode = "skip" | "pointer-only" | "fetch";
```

### 15.1 skip

Do not fetch LFS content. Leave pointer files as-is.

### 15.2 pointer-only

Same as skip, but detect and annotate pointer files during scans.

### 15.3 fetch

Fetch LFS content only for repos/settings where needed.

This should require explicit opt-in and stricter quotas.

---

## 16. Submodules

Default:

```text
includeSubmodules: false
```

Rationale:

```text
- submodules may point to private repos requiring separate credentials
- submodules may significantly increase sync time
- submodules can complicate trust boundaries
```

If enabled later:

```text
- resolve credentials per submodule host/repo
- enforce recursion depth
- enforce disk quota
- enforce allowlist
- store submodule metadata
- index submodule as separate repo or separate namespace
```

MVP behavior:

```text
- leave submodule directories uninitialized
- emit metadata that submodules exist
- let indexer skip uninitialized submodules
```

---

## 17. Path normalization and filesystem safety

Implement strict path utilities.

```ts
export function normalizeRepoPath(path: string): RepoPath;
export function assertInsideRoot(root: string, target: string): void;
export function safeJoin(root: string, relativePath: string): string;
```

Rules:

```text
- repo paths always use forward slash `/`
- no absolute paths
- no `..` segments
- no null bytes
- no Windows drive prefixes
- no paths resolving outside workspace
```

### 17.1 Symlinks

Symlinks exist in real repos. Do not blindly follow them during file walking.

Recommended indexer behavior:

```text
- record symlink metadata if useful
- do not follow symlinks outside workspace
- skip symlink targets outside workspace
- optionally skip all symlinks for static analysis sandboxing
```

Repo sync should provide `assertInsideRoot` and file traversal helpers to downstream packages.

### 17.2 File mode metadata

Preserve useful mode info:

```text
- regular file
- directory
- symlink
- executable bit
- submodule/gitlink
```

This can matter for security and scripts.

---

## 18. File filtering

The workspace manager should expose helpers for downstream file walking.

It should not decide what the indexer indexes, but it can provide common filter logic.

Recommended filters:

```text
- max file size
- binary detection
- generated file detection
- ignored path patterns
- hidden/system directories
- dependency directories
- build output directories
```

Default skip patterns:

```text
.git/**
node_modules/**
vendor/**
dist/**
build/**
out/**
.next/**
.turbo/**
.cache/**
coverage/**
*.min.js
*.map
*.lock?  # consider indexing package lock files separately; do not blanket-skip all lock files
```

Be careful with lock files. They are often relevant for dependency/security review.

Recommended treatment:

```text
- include known package lock files as dependency records
- do not embed huge lock files as normal code chunks
```

Known dependency files:

```text
package.json
package-lock.json
pnpm-lock.yaml
yarn.lock
bun.lock
bun.lockb
pyproject.toml
poetry.lock
requirements.txt
Pipfile
Pipfile.lock
go.mod
go.sum
Cargo.toml
Cargo.lock
pom.xml
build.gradle
gradle.lockfile
composer.json
composer.lock
Gemfile
Gemfile.lock
```

---

## 19. Generated file detection

Repo sync can provide utility detection, while indexer decides final behavior.

Signals:

```text
- path matches generated directories
- file contains generated-code comments
- extension indicates generated artifact
- very large minified files
- protobuf/grpc generated naming patterns
```

Example markers:

```text
@generated
AUTO-GENERATED
This file was generated
DO NOT EDIT
Code generated by
Generated by the protocol buffer compiler
```

Example paths:

```text
src/generated/**
generated/**
__generated__/**
*.pb.go
*.g.dart
*.gen.ts
*.generated.ts
*.generated.tsx
*.graphql.ts
```

Output:

```ts
type GeneratedFileSignal = {
  isGenerated: boolean;
  confidence: number;
  reasons: string[];
};
```

---

## 20. Workspace validation

After checkout, validate:

```text
- workspace path exists
- workspace path is inside configured cache root
- `.git` file points to expected mirror/worktree metadata
- requested commit is checked out
- workspace is not over max size
- no unexpected credential files exist
- Git status is clean unless writable tools have already run
```

Commands:

```bash
git -C <workspacePath> rev-parse HEAD
git -C <workspacePath> rev-parse --show-toplevel
git -C <workspacePath> status --porcelain=v1
```

Validation result:

```ts
export type WorkspaceValidationResult = {
  ok: boolean;
  headSha: string;
  rootPath: string;
  sizeBytes?: number;
  warnings: WorkspaceWarning[];
};
```

---

## 21. Disk quotas and cache eviction

### 21.1 Why quotas matter

Repos can be huge. Workers can die if disk fills.

Quotas should exist at multiple levels:

```text
- per workspace max bytes
- per mirror max bytes
- per repo cache max bytes
- per worker node total cache max bytes
- per org optional max cache bytes
```

### 21.2 Measuring size

Use filesystem traversal or platform command:

```bash
du -sb <path>
```

Prefer a small abstraction:

```ts
export interface DiskUsageProvider {
  getUsageBytes(path: string): Promise<number>;
}
```

### 21.3 Eviction policy

Recommended:

```text
1. remove released/expired worktrees
2. prune worktree metadata
3. remove least-recently-used mirrors not currently locked
4. run git maintenance/gc on large mirrors
5. reject new workspaces if still over quota
```

### 21.4 Cache stats

Expose:

```ts
export type RepoCacheStats = {
  cacheNodeId: string;
  cacheRoot: string;
  totalBytes: number;
  mirrors: Array<{
    repoId: string;
    path: string;
    bytes: number;
    lastAccessedAt?: string;
    activeWorktrees: number;
  }>;
  activeWorkspaces: Array<{
    leaseId: string;
    repoId: string;
    commitSha: string;
    path: string;
    bytes?: number;
    expiresAt: string;
  }>;
};
```

---

## 22. Git maintenance

Git repositories need periodic maintenance.

Recommended jobs:

```text
- git worktree prune
- git gc --auto or git maintenance run
- remove stale lock files
- remove stale temp clone paths
```

Do not run aggressive GC on hot repos by default. It can be slow and block other Git operations.

Maintenance should:

```text
- run under repo lock
- have strict timeout
- be scheduled during low traffic if possible
- emit metrics
```

Commands:

```bash
git -C <mirrorPath> worktree prune
git -C <mirrorPath> gc --auto
git -C <mirrorPath> maintenance run --auto
```

---

## 23. Concurrency model

### 23.1 Locks

Use locks for:

```text
- creating mirror
- fetching mirror
- deleting mirror
- pruning worktrees
- cleaning expired leases
```

Do not lock for:

```text
- reading files from a workspace
- indexing separate worktrees
- embedding
- review passes
```

### 23.2 Lock implementation options

MVP:

```text
Postgres advisory locks or Redis locks
```

Recommended:

```text
- local file lock for same-node mirror filesystem mutations
- Postgres/Redis lock for cross-process coordination on same cache node
```

Because mirrors are local to each node, cross-node locks are less important unless multiple containers share the same volume.

### 23.3 Fetch lock key

```ts
const fetchLockKey = `repo-sync:fetch:${cacheNodeId}:${repoId}`;
```

### 23.4 Worktree creation lock

Worktree metadata lives in the mirror. Protect worktree add/remove/prune operations with a mirror lock.

```ts
const worktreeLockKey = `repo-sync:worktree:${cacheNodeId}:${repoId}`;
```

---

## 24. Credentials and token handling

### 24.1 Token source

Credentials should be resolved by caller or injected dependency.

```ts
export interface CredentialResolver {
  getCredential(input: {
    provider: string;
    installationId: string;
    repoId: string;
  }): Promise<GitCredential>;
}
```

For GitHub, `/packages/github` should generate installation tokens.

### 24.2 Token lifetime

GitHub installation access tokens expire, so the repo sync manager must avoid assuming a token remains valid across long workflows.

For each network operation:

```text
- acquire fresh or cached valid credential
- run fetch/clone
- discard credential from memory as soon as possible
```

### 24.3 Never persist tokens

Do not store tokens in:

```text
- Git remote URLs
- repo config
- database rows
- logs
- traces
- review artifacts
- index artifacts
- prompt/context bundles
```

### 24.4 Redaction

Every error/log path must redact:

```text
ghs_*
ghu_*
gho_*
ghp_*
github_pat_*
Bearer *
Authorization: *
x-access-token:*
```

Implement generalized redaction:

```ts
export function redactSecrets(input: string, secrets: string[]): string;
```

Also include regex-based provider token redaction.

---

## 25. Security hardening

### 25.1 Do not trust repository contents

Repositories can contain malicious files.

The sync layer should assume repo contents are untrusted.

Risks:

```text
- malicious symlinks
- huge files
- zip-bomb-like generated files
- scripts that get run by tools later
- config files that affect Git behavior
- submodules pointing to unexpected locations
```

### 25.2 Disable hooks

Git hooks should not run during clone/fetch/checkout, but be careful if any command or later tooling might trigger hooks.

Do not execute repository scripts from this component.

### 25.3 Isolated HOME

Use a dedicated temporary HOME for Git commands to prevent reading user-level config.

```text
HOME=/tmp/repo-sync-home/<requestId>
GIT_CONFIG_NOSYSTEM=1
```

### 25.4 Safe directory

Git may refuse to operate on repositories owned by a different user. Prefer consistent container user ownership. Avoid global `safe.directory=*` unless you fully control the worker environment.

If needed, add exact known paths only:

```bash
git config --global --add safe.directory <workspacePath>
```

Do this inside an isolated HOME, not the real host user config.

### 25.5 Filesystem boundaries

All cleanup paths must be validated before deletion.

```ts
assertInsideRoot(cacheRoot, pathToDelete);
assertPathStartsWith(pathToDelete, `${cacheRoot}/worktrees/lease_`);
```

Never call `rm -rf` on unchecked paths.

### 25.6 Network restrictions

Repo sync needs outbound network to Git provider.

Later sandbox/static-analysis tools may not.

Keep these separate:

```text
repo-sync network: provider host only
static-analysis sandbox: usually no network
```

---

## 26. Error model

Define typed errors.

```ts
export type RepoSyncErrorCode =
  | "INVALID_GIT_URL"
  | "AUTH_FAILED"
  | "TOKEN_EXPIRED"
  | "MIRROR_CREATE_FAILED"
  | "FETCH_FAILED"
  | "COMMIT_NOT_FOUND"
  | "WORKTREE_CREATE_FAILED"
  | "WORKTREE_REMOVE_FAILED"
  | "WORKSPACE_VALIDATION_FAILED"
  | "DISK_QUOTA_EXCEEDED"
  | "LOCK_TIMEOUT"
  | "GIT_TIMEOUT"
  | "GIT_COMMAND_FAILED"
  | "UNSAFE_PATH"
  | "CACHE_CORRUPTION"
  | "UNKNOWN";
```

```ts
export class RepoSyncError extends Error {
  code: RepoSyncErrorCode;
  repoId?: string;
  commitSha?: string;
  command?: string;
  redactedStderr?: string;
  durationMs?: number;
  cause?: unknown;
}
```

### 26.1 Error behavior

| Error | Retry? | Notes |
|---|---:|---|
| `AUTH_FAILED` | sometimes | Refresh token once, then fail. |
| `TOKEN_EXPIRED` | yes | Refresh credential and retry. |
| `FETCH_FAILED` | yes | Retry with backoff. |
| `COMMIT_NOT_FOUND` | no/sometimes | Retry once after fetching PR refs. |
| `GIT_TIMEOUT` | yes | Backoff; may indicate large repo. |
| `DISK_QUOTA_EXCEEDED` | no | Trigger cleanup, then retry if policy allows. |
| `CACHE_CORRUPTION` | maybe | Delete mirror under lock and reclone. |
| `UNSAFE_PATH` | no | Security error. |

---

## 27. Observability

Emit structured logs and metrics for every major operation.

### 27.1 Logs

Log events:

```text
repo_sync.ensure_mirror.start
repo_sync.ensure_mirror.finish
repo_sync.fetch.start
repo_sync.fetch.finish
repo_sync.fetch.error
repo_sync.worktree.add.start
repo_sync.worktree.add.finish
repo_sync.worktree.remove.start
repo_sync.worktree.remove.finish
repo_sync.cleanup.start
repo_sync.cleanup.finish
repo_sync.disk_quota.exceeded
```

Include:

```text
requestId
jobId
reviewRunId
repoId
commitSha
cacheNodeId
durationMs
strategy
bytesBefore
bytesAfter
errorCode
```

Do not include:

```text
raw clone URL with credentials
tokens
file contents
customer code snippets
```

### 27.2 Metrics

Recommended counters:

```text
repo_sync_mirror_creates_total
repo_sync_fetches_total
repo_sync_fetch_errors_total
repo_sync_worktree_creates_total
repo_sync_worktree_removes_total
repo_sync_cleanup_failures_total
repo_sync_cache_evictions_total
```

Recommended histograms:

```text
repo_sync_fetch_duration_ms
repo_sync_worktree_create_duration_ms
repo_sync_workspace_validation_duration_ms
repo_sync_mirror_size_bytes
repo_sync_workspace_size_bytes
```

Recommended gauges:

```text
repo_sync_active_workspaces
repo_sync_cache_total_bytes
repo_sync_cache_free_bytes
repo_sync_stale_leases
```

---

## 28. Configuration

Package config:

```ts
export type RepoSyncConfig = {
  cacheRoot: string;
  cacheNodeId: string;
  gitBinaryPath: string;
  maxConcurrentFetches: number;
  maxConcurrentWorktrees: number;
  defaultFetchTimeoutMs: number;
  defaultWorktreeTimeoutMs: number;
  defaultLeaseTtlSeconds: number;
  maxTotalCacheBytes: number;
  maxMirrorBytes: number;
  maxWorkspaceBytes: number;
  allowedGitHosts: string[];
  enablePartialClone: boolean;
  enableSparseCheckout: boolean;
  enableLfsFetch: boolean;
  enableSubmodules: boolean;
};
```

Environment variables:

```text
REPO_SYNC_CACHE_ROOT=/var/app/git-cache
REPO_SYNC_CACHE_NODE_ID=worker-a
REPO_SYNC_GIT_BINARY=git
REPO_SYNC_MAX_CONCURRENT_FETCHES=4
REPO_SYNC_MAX_CONCURRENT_WORKTREES=16
REPO_SYNC_FETCH_TIMEOUT_MS=120000
REPO_SYNC_WORKTREE_TIMEOUT_MS=60000
REPO_SYNC_DEFAULT_LEASE_TTL_SECONDS=1800
REPO_SYNC_MAX_TOTAL_CACHE_BYTES=107374182400
REPO_SYNC_MAX_MIRROR_BYTES=21474836480
REPO_SYNC_MAX_WORKSPACE_BYTES=5368709120
REPO_SYNC_ALLOWED_GIT_HOSTS=github.com
REPO_SYNC_ENABLE_PARTIAL_CLONE=true
REPO_SYNC_ENABLE_SPARSE_CHECKOUT=true
REPO_SYNC_ENABLE_LFS_FETCH=false
REPO_SYNC_ENABLE_SUBMODULES=false
```

---

## 29. Integration with other sections

### 29.1 #0 Core contracts

Use shared primitives:

```text
RepoId
CommitSha
Provider
RepoPath
IsoDateTime
ReviewRunId
JobId
```

Do not redefine them locally.

### 29.2 #2 Database layer

Use DB helpers for:

```text
repo_cache_entries
workspace_leases
background_jobs
repositories
```

### 29.3 #3 GitHub App integration

GitHub package provides:

```text
- installation token
- sanitized clone URL
- PR ref hints
- repository metadata
```

Repo sync consumes these values.

### 29.4 #7 Job queue

Queue jobs call repo sync from worker handlers:

```text
repo.index
pr.review
static_analysis.run
```

### 29.5 #9 Indexer boundary

Indexer receives:

```text
workspacePath
commitSha
repoId
```

Indexer should not know how the workspace was created.

### 29.6 #11 TypeScript indexer

The indexer walks files under `workspacePath` using path and filter helpers from repo sync or contracts.

### 29.7 #23 Static analysis

Static analysis may require writable caches and dependency installs. It should acquire a workspace and then run in a separate sandbox layer.

Repo sync should not execute package manager commands.

---

## 30. Recommended command set

### 30.1 Check Git version

```bash
git --version
```

Run at worker startup and include in telemetry.

### 30.2 Create bare partial clone

```bash
git clone --bare --filter=blob:none --no-tags <url> <mirrorPath>
```

### 30.3 Set remote URL without credentials

```bash
git -C <mirrorPath> remote set-url origin <sanitizedUrl>
```

### 30.4 Fetch refs

```bash
git -C <mirrorPath> fetch --no-tags origin <ref>
```

### 30.5 Verify commit

```bash
git -C <mirrorPath> cat-file -e <commitSha>^{commit}
```

### 30.6 Create worktree

```bash
git -C <mirrorPath> worktree add --detach <workspacePath> <commitSha>
```

### 30.7 Verify checkout

```bash
git -C <workspacePath> rev-parse HEAD
```

### 30.8 Remove worktree

```bash
git -C <mirrorPath> worktree remove --force <workspacePath>
```

### 30.9 Prune worktree metadata

```bash
git -C <mirrorPath> worktree prune
```

### 30.10 Maintenance

```bash
git -C <mirrorPath> gc --auto
```

or:

```bash
git -C <mirrorPath> maintenance run --auto
```

---

## 31. Implementation details

## 31.1 `createRepoSyncer`

```ts
export function createRepoSyncer(deps: {
  config: RepoSyncConfig;
  git: GitRunner;
  locks: LockManager;
  db?: RepoSyncRepository;
  metrics?: RepoSyncMetrics;
  clock?: Clock;
  logger?: Logger;
}): RepoSyncer {
  return new DefaultRepoSyncer(deps);
}
```

## 31.2 `ensureMirror`

```ts
async function ensureMirror(input: EnsureMirrorInput): Promise<MirrorRef> {
  const cloneUrl = sanitizeGitUrl(input.cloneUrl);
  assertAllowedGitUrl(cloneUrl, config.allowedGitHosts);

  const mirrorPath = getMirrorPath(config.cacheRoot, input.repoId);

  if (await isValidMirror(mirrorPath, cloneUrl)) {
    await touchCacheEntry(input.repoId, mirrorPath);
    return { repoId: input.repoId, path: mirrorPath, cloneUrl };
  }

  return locks.withLock(`repo-sync:mirror:${config.cacheNodeId}:${input.repoId}`, async () => {
    if (await isValidMirror(mirrorPath, cloneUrl)) {
      return { repoId: input.repoId, path: mirrorPath, cloneUrl };
    }

    const tempPath = getTempMirrorPath(config.cacheRoot, input.repoId);

    await removePathIfSafe(tempPath);

    try {
      await git.run({
        args: buildCloneArgs({ cloneUrl, tempPath, options: input.options }),
        timeoutMs: input.options?.maxFetchSeconds
          ? input.options.maxFetchSeconds * 1000
          : config.defaultFetchTimeoutMs,
        env: buildGitEnv(input.credential),
        redact: credentialRedactions(input.credential),
      });

      await validateMirror(tempPath, cloneUrl);
      await atomicMove(tempPath, mirrorPath);
      await recordCacheEntry(input.repoId, mirrorPath, input.options);

      return { repoId: input.repoId, path: mirrorPath, cloneUrl };
    } catch (error) {
      await removePathIfSafe(tempPath);
      throw toRepoSyncError(error, "MIRROR_CREATE_FAILED", input);
    }
  });
}
```

## 31.3 `ensureCommit`

```ts
async function ensureCommit(input: EnsureCommitInput): Promise<CommitAvailability> {
  const mirror = await ensureMirror(input);

  if (await hasCommit(mirror.path, input.commitSha)) {
    return { available: true, repoId: input.repoId, commitSha: input.commitSha };
  }

  return locks.withLock(`repo-sync:fetch:${config.cacheNodeId}:${input.repoId}`, async () => {
    if (await hasCommit(mirror.path, input.commitSha)) {
      return { available: true, repoId: input.repoId, commitSha: input.commitSha };
    }

    const refs = normalizeFetchRefHints(input.fetchRefHints);

    for (const ref of refs) {
      await fetchRef({ mirrorPath: mirror.path, ref, credential: input.credential });
      if (await hasCommit(mirror.path, input.commitSha)) {
        return { available: true, repoId: input.repoId, commitSha: input.commitSha };
      }
    }

    await fetchDefaultRefs({ mirrorPath: mirror.path, credential: input.credential });

    if (await hasCommit(mirror.path, input.commitSha)) {
      return { available: true, repoId: input.repoId, commitSha: input.commitSha };
    }

    throw new RepoSyncError("Commit not found after fetch", {
      code: "COMMIT_NOT_FOUND",
      repoId: input.repoId,
      commitSha: input.commitSha,
    });
  });
}
```

## 31.4 `createWorkspaceLease`

```ts
async function createWorkspaceLease(input: {
  repoId: string;
  commitSha: string;
  mirrorPath: string;
  purpose: AcquireWorkspaceInput["purpose"];
  options: Required<WorkspaceOptions>;
}): Promise<WorkspaceLease> {
  const leaseId = createLeaseId();
  const workspacePath = getWorkspacePath(config.cacheRoot, leaseId);

  assertInsideRoot(getWorktreeRoot(config.cacheRoot), workspacePath);

  await locks.withLock(`repo-sync:worktree:${config.cacheNodeId}:${input.repoId}`, async () => {
    await git.run({
      args: ["-C", input.mirrorPath, "worktree", "add", "--detach", workspacePath, input.commitSha],
      timeoutMs: config.defaultWorktreeTimeoutMs,
    });
  });

  if (input.options.sparsePaths.length > 0) {
    await configureSparseCheckout(workspacePath, input.options.sparsePaths);
  }

  const validation = await validateWorkspace({
    workspacePath,
    expectedCommitSha: input.commitSha,
    options: input.options,
  });

  if (!validation.ok) {
    await removeWorkspace({ mirrorPath: input.mirrorPath, workspacePath });
    throw new RepoSyncError("Workspace validation failed", {
      code: "WORKSPACE_VALIDATION_FAILED",
      repoId: input.repoId,
      commitSha: input.commitSha,
    });
  }

  await persistLease({ leaseId, workspacePath, ...input });

  return createLeaseObject({ leaseId, workspacePath, ...input });
}
```

---

## 32. Local development behavior

Local cache root:

```text
.local/git-cache
```

Development commands:

```bash
pnpm repo-sync:inspect
pnpm repo-sync:cleanup
pnpm repo-sync:acquire --repo <repoId> --sha <sha>
pnpm repo-sync:fetch --repo <repoId>
```

Add a local CLI:

```text
/packages/repo-sync/src/cli.ts
```

Useful commands:

```bash
repo-sync inspect-cache
repo-sync cleanup --expired
repo-sync ensure-mirror --url https://github.com/org/repo.git
repo-sync acquire --url https://github.com/org/repo.git --sha abc123 --purpose debug
repo-sync release --lease lease_abc
```

For local private repo tests, use environment variable token injection but never commit it:

```bash
GITHUB_TOKEN=... repo-sync ensure-mirror ...
```

---

## 33. Testing strategy

### 33.1 Unit tests

Test:

```text
- URL sanitization
- allowed host validation
- path normalization
- safe join
- secret redaction
- git command arg construction
- generated file detection
- filter matching
- error mapping
- lease status transitions
```

### 33.2 Integration tests with local Git repos

Create fixture repos during tests:

```text
- simple repo with one commit
- repo with multiple branches
- repo with tags
- repo with large file
- repo with symlink
- repo with submodule placeholder
- repo with LFS pointer-like file
- repo with renamed files
```

Use local file remotes for most tests, but still block `file://` in production config.

Example fixture setup:

```bash
mkdir source
cd source
git init
echo 'hello' > README.md
git add README.md
git commit -m 'initial'
cd ..
git clone --bare source remote.git
```

Then test:

```text
ensureMirror(remote.git)
ensureCommit(sha)
acquireWorkspace(sha)
read README.md
release workspace
assert removed
```

### 33.3 Failure tests

Test:

```text
- invalid URL
- auth failure
- missing commit
- fetch timeout
- worktree creation failure
- stale workspace cleanup
- disk quota exceeded
- unsafe deletion path
- token redaction in thrown error
```

### 33.4 Concurrency tests

Test:

```text
- two jobs ensure same mirror concurrently
- two jobs fetch same missing commit concurrently
- many jobs create worktrees from same mirror
- cleanup does not remove active workspace
```

### 33.5 Snapshot tests

For command construction, snapshot the argv array, not shell strings.

```ts
expect(buildCloneArgs(input)).toEqual([
  "clone",
  "--bare",
  "--filter=blob:none",
  "--no-tags",
  "https://github.com/org/repo.git",
  "/cache/tmp/clone_repo_123",
]);
```

---

## 34. Performance guidelines

### 34.1 Avoid cold clones

A cold clone should happen once per repo per cache node, not once per job.

### 34.2 Keep mirror fetches serialized

Concurrent fetches into the same mirror can corrupt state or waste network.

### 34.3 Worktree creation should be cheap

If worktree creation is slow, likely causes:

```text
- partial clone fetching many blobs during checkout
- LFS smudge not disabled
- very large checkout
- antivirus/host filesystem slowness
- sparse checkout misconfiguration
```

### 34.4 Consider archive mode for read-only small snapshots

Alternative checkout mode:

```bash
git -C <mirrorPath> archive <commitSha> | tar -x -C <workspacePath>
```

Pros:

```text
- no worktree metadata
- clean plain filesystem
- easy cleanup
```

Cons:

```text
- no `.git` metadata
- less useful for tools that require Git context
- may be slower for large trees
```

MVP should use worktrees. Archive mode can be a useful later optimization for indexing-only paths.

### 34.5 Do not run dependency installs in repo sync

Dependency installs belong to sandbox/static-analysis.

Repo sync should not run:

```text
npm install
pnpm install
pip install
go mod download
cargo fetch
```

---

## 35. MVP implementation cut

Build first:

```text
- RepoSyncer interface
- GitRunner with timeout/redaction
- URL sanitizer/allowlist
- mirror cache with bare clone
- partial clone option
- fetch lock
- ensureCommit
- worktree add/remove
- WorkspaceLease
- path safety helpers
- cleanupExpiredLeases
- basic DB lease/cache metadata
- local integration tests
```

Skip initially:

```text
- sparse checkout
- submodule fetch
- LFS fetch
- archive checkout mode
- advanced disk eviction
- remote shared cache
- multi-provider SSH support
- Kubernetes volume-aware scheduling
```

---

## 36. Implementation PR sequence

### PR 1: Package skeleton and types

Deliver:

```text
/packages/repo-sync
  config
  types
  errors
  exports
```

Acceptance:

```text
- package builds
- types compile
- basic unit tests pass
```

### PR 2: GitRunner

Deliver:

```text
- spawn-based git runner
- timeout handling
- output capture limits
- secret redaction
- structured logging hooks
```

Acceptance:

```text
- can run git --version
- timeout test passes
- redaction test passes
```

### PR 3: Path and URL safety

Deliver:

```text
- sanitizeGitUrl
- assertAllowedGitUrl
- safeJoin
- assertInsideRoot
- cache path builders
```

Acceptance:

```text
- blocks unsafe schemes
- strips credentials
- blocks path traversal
- deletion helpers refuse unsafe paths
```

### PR 4: Mirror cache

Deliver:

```text
- ensureMirror
- clone into temp path
- atomic move
- validate mirror
- cache entry persistence optional
```

Acceptance:

```text
- clones local test repo
- does not clone twice
- handles failed temp clone cleanup
```

### PR 5: Fetch and commit availability

Deliver:

```text
- hasCommit
- fetchRef
- fetchDefaultRefs
- ensureCommit
- fetch lock
```

Acceptance:

```text
- fetches missing branch commit
- returns COMMIT_NOT_FOUND for unknown SHA
- concurrent fetch test passes
```

### PR 6: Workspace manager

Deliver:

```text
- worktree add --detach
- workspace validation
- WorkspaceLease.release
- worktree remove/prune
```

Acceptance:

```text
- checks out exact SHA
- release removes workspace
- double release is safe
```

### PR 7: Lease persistence and cleanup

Deliver:

```text
- workspace_leases integration
- cleanupExpiredLeases
- startup cleanup hook
```

Acceptance:

```text
- expired lease is removed
- active lease is not removed
- cleanup handles missing paths
```

### PR 8: Quotas and cache stats

Deliver:

```text
- disk usage provider
- workspace size validation
- cache stats
- basic released-worktree eviction
```

Acceptance:

```text
- rejects oversized workspace
- reports cache stats
- cleanup frees released worktree bytes
```

### PR 9: Integration with worker jobs

Deliver:

```text
- repo.index uses acquireWorkspace
- pr.review uses acquireWorkspace
- workspace is released in finally
- job logs include leaseId
```

Acceptance:

```text
- review/index fixtures run using actual workspace leases
- failed job still releases workspace
```

---

## 37. Example usage in worker

```ts
export async function handleIndexRepoCommit(job: IndexRepoCommitJob) {
  const repo = await repositories.getById(job.repoId);
  const credential = await githubCredentials.getInstallationCredential({
    installationId: repo.providerInstallationId,
    repoId: repo.id,
  });

  const lease = await repoSyncer.acquireWorkspace({
    repoId: repo.id,
    cloneUrl: repo.cloneUrl,
    credential,
    commitSha: job.commitSha,
    purpose: "index",
    jobId: job.id,
    options: {
      ttlSeconds: 60 * 30,
      lfsMode: "skip",
      includeSubmodules: false,
      readOnly: true,
    },
  });

  try {
    const artifact = await indexer.index({
      repoId: repo.id,
      commitSha: job.commitSha,
      workspacePath: lease.path,
    });

    await indexImporter.importArtifact({
      repoId: repo.id,
      commitSha: job.commitSha,
      artifactUri: artifact.artifactUri,
    });
  } finally {
    await lease.release();
  }
}
```

---

## 38. Definition of done

This section is done when:

```text
- workers can acquire a workspace for a GitHub repo at an exact commit SHA
- repeated jobs reuse a cached mirror instead of recloning
- concurrent jobs for the same repo do not corrupt mirror state
- workspaces are isolated per job
- workspace release removes the worktree
- expired workspace cleanup works after process crash
- tokens are never logged or stored
- path traversal cleanup attacks are blocked
- Git command failures are typed and redacted
- integration tests cover local repos and concurrency
- index/review workers use this package instead of raw Git commands
```

---

## 39. Key decisions

### Decision 1: Use Git CLI instead of a JS Git implementation

Use the Git CLI for correctness and feature completeness.

JS Git libraries can be useful, but this product needs mature support for:

```text
- partial clone
- worktrees
- fetch refspecs
- Git LFS behavior
- maintenance/gc
- provider-specific auth flows
```

### Decision 2: Use local bare mirrors plus worktrees

This gives the best MVP balance:

```text
- fast repeated access
- simple filesystem model
- direct compatibility with indexers/tools
- easy exact-commit checkouts
```

### Decision 3: Skip LFS and submodules by default

This avoids expensive and surprising network/disk behavior.

Allow opt-in later with quotas and explicit policy.

### Decision 4: Treat workspaces as leases

This gives clear lifecycle, cleanup, observability, and crash recovery.

### Decision 5: Keep repo sync separate from sandbox execution

Repo sync prepares code. Sandbox execution runs tools.

This avoids mixing credentialed fetch logic with untrusted command execution.

---

## 40. Open questions

These can be resolved after MVP:

```text
1. Should mirrors be local per worker node or backed by a shared persistent volume?
2. Should large enterprise customers get per-tenant cache isolation on disk?
3. Should partial clone be default for all repos or only large repos?
4. Should archive mode be used for read-only indexing to reduce worktree metadata overhead?
5. Should workspaces be mounted read-only into indexer/sandbox containers?
6. Should we use Qdrant/object-store metadata to avoid checking out unchanged repos for semantic-only retrieval?
7. How aggressively should cache eviction happen under disk pressure?
8. Should repo sync eventually run as a separate service rather than a worker package?
```

---

## 41. Reference docs

Useful upstream documentation to keep handy while implementing:

```text
Git worktree docs:
https://git-scm.com/docs/git-worktree

Git partial clone docs:
https://git-scm.com/docs/partial-clone

Git clone --filter docs:
https://git-scm.com/docs/git-clone

Git sparse-checkout docs:
https://git-scm.com/docs/git-sparse-checkout

Git maintenance docs:
https://git-scm.com/docs/git-maintenance

Git gc docs:
https://git-scm.com/docs/git-gc

GitHub App installation authentication:
https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

Git LFS config docs:
https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc
```
