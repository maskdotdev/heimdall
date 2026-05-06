import "./styles.css";

/** Structured failure detail shown by admin inspectors. */
type AdminFailureDetail = {
  /** Source table or event that produced the failure. */
  readonly source: string;
  /** Machine-readable failure code. */
  readonly code: string;
  /** Human-readable failure message. */
  readonly message: string;
  /** Whether retrying the operation is expected to be safe. */
  readonly retryable?: boolean;
};

/** Durable background job summary shown by inspectors. */
type AdminBackgroundJobDebugSummary = {
  /** Durable background job row ID. */
  readonly backgroundJobId: string;
  /** Queue that owns the job. */
  readonly queueName: string;
  /** Durable idempotency key. */
  readonly jobKey: string;
  /** Handler type carried by the job envelope. */
  readonly jobType: string;
  /** Current durable job status. */
  readonly status: string;
};

/** Replay audit row shown by inspectors. */
type AdminReplayAuditSummary = {
  /** Actor category stored in the audit log. */
  readonly actorType: string;
  /** Stable actor ID when available. */
  readonly actorUserId?: string;
  /** Replay action that was confirmed. */
  readonly action: string;
  /** ISO timestamp for the audited decision. */
  readonly occurredAt: string;
  /** Replay plan and result metadata recorded with the decision. */
  readonly metadata?: unknown;
};

/** Webhook debug response consumed by the dashboard. */
type AdminWebhookDebugDetails = {
  /** Webhook event summary. */
  readonly webhookEvent: {
    /** Current webhook status. */
    readonly status: string;
    /** Provider event name. */
    readonly eventName: string;
    /** Provider action when available. */
    readonly action?: string;
  };
  /** Expected durable job keys. */
  readonly expectedJobKeys: readonly string[];
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Audited replay decisions. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Review debug response consumed by the dashboard. */
type AdminReviewDebugDetails = {
  /** Review run summary. */
  readonly reviewRun: {
    /** Review run ID. */
    readonly reviewRunId?: string;
    /** Repository ID that owns this review. */
    readonly repoId?: string;
    /** Current review status. */
    readonly status: string;
    /** Provider pull request number. */
    readonly pullRequestNumber: number;
    /** Review summary when available. */
    readonly summary?: string;
    /** Persisted finding counts. */
    readonly counts?: AdminReviewFindingCounts;
  };
  /** Pull request snapshot summary when available. */
  readonly snapshot?: {
    /** Pull request title. */
    readonly title?: string;
    /** Pull request author login. */
    readonly authorLogin?: string;
    /** Head SHA. */
    readonly headSha: string;
    /** Base SHA. */
    readonly baseSha: string;
    /** Changed file count. */
    readonly changedFileCount: number;
    /** Diff hash. */
    readonly diffHash: string;
  };
  /** Stage timeline. */
  readonly stageEvents: readonly {
    /** Stage name. */
    readonly stage: string;
    /** Stage status. */
    readonly status: string;
    /** ISO event timestamp. */
    readonly occurredAt: string;
  }[];
  /** Durable dependencies attached to the review run. */
  readonly dependencies?: readonly AdminReviewDependencySummary[];
  /** Review artifacts attached to the review run. */
  readonly artifacts?: readonly AdminReviewArtifactSummary[];
  /** Candidate finding summaries. */
  readonly candidateFindings: readonly AdminCandidateFindingSummary[];
  /** Validated finding summaries. */
  readonly validatedFindings: readonly AdminValidatedFindingSummary[];
  /** LLM call summaries linked to the review run. */
  readonly llmCalls?: readonly AdminLlmCallSummary[];
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Audited replay decisions. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Structured failures. */
  readonly failures: readonly AdminFailureDetail[];
};

/** Finding counts attached to one review run. */
type AdminReviewFindingCounts = {
  /** Candidate findings emitted before validation. */
  readonly candidateFindings: number;
  /** Findings accepted by validation. */
  readonly validatedFindings: number;
  /** Findings published to the provider. */
  readonly publishedFindings: number;
  /** Findings rejected by validation. */
  readonly rejectedFindings: number;
};

/** Durable dependency summary shown on review inspectors. */
type AdminReviewDependencySummary = {
  /** Dependency type. */
  readonly dependencyType: string;
  /** Dependency row ID. */
  readonly dependencyId: string;
};

/** Review artifact summary shown on review inspectors. */
type AdminReviewArtifactSummary = {
  /** Artifact row ID. */
  readonly reviewArtifactId: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Artifact display name. */
  readonly name: string;
  /** Artifact URI. */
  readonly uri: string;
  /** Artifact byte size. */
  readonly sizeBytes: number;
  /** Artifact creation timestamp. */
  readonly createdAt: string;
};

/** Candidate finding summary shown on review inspectors. */
type AdminCandidateFindingSummary = {
  /** Finding ID. */
  readonly findingId: string;
  /** Finding source. */
  readonly source: string;
  /** Source pass or tool name. */
  readonly sourceName: string;
  /** Finding category. */
  readonly category: string;
  /** Finding severity. */
  readonly severity: string;
  /** Finding title. */
  readonly title: string;
  /** Finding location. */
  readonly location: unknown;
  /** Finding confidence. */
  readonly confidence: number;
  /** Finding fingerprint. */
  readonly fingerprint: string;
  /** Candidate creation timestamp. */
  readonly createdAt: string;
};

/** Validated finding summary shown on review inspectors. */
type AdminValidatedFindingSummary = {
  /** Finding ID. */
  readonly findingId: string;
  /** Candidate finding ID. */
  readonly candidateFindingId: string;
  /** Validation decision. */
  readonly decision: string;
  /** Finding category. */
  readonly category: string;
  /** Finding severity. */
  readonly severity: string;
  /** Finding title. */
  readonly title: string;
  /** Finding location. */
  readonly location: unknown;
  /** Finding rank when publishable. */
  readonly rank?: number;
  /** Finding fingerprint. */
  readonly fingerprint: string;
  /** Validation payload. */
  readonly validation: unknown;
};

/** LLM call summary shown on review inspectors. */
type AdminLlmCallSummary = {
  /** LLM call row ID. */
  readonly llmCallId: string;
  /** Provider used by the call. */
  readonly provider: string;
  /** Model used by the call. */
  readonly model: string;
  /** Call purpose. */
  readonly purpose: string;
  /** Call status. */
  readonly status: string;
  /** Input token count. */
  readonly inputTokens: number;
  /** Output token count. */
  readonly outputTokens: number;
  /** Cost in micros. */
  readonly costMicros: number;
  /** Start timestamp. */
  readonly startedAt: string;
};

/** Publisher reconciliation issue shown in dashboard state. */
type PublisherReconciliationIssue = {
  /** Machine-readable issue code. */
  readonly code: string;
  /** Human-readable issue message. */
  readonly message: string;
};

/** Publisher debug response consumed by the dashboard. */
type AdminPublisherDebugDetails = {
  /** Repository that owns the review run. */
  readonly repoId: string;
  /** Publish run summaries. */
  readonly publishRuns: readonly unknown[];
  /** Low-level publisher operation summaries. */
  readonly operations: readonly unknown[];
  /** Durable publisher output rows. */
  readonly outputs: {
    /** Provider check runs. */
    readonly checkRuns: readonly unknown[];
    /** Provider reviews. */
    readonly reviews: readonly unknown[];
    /** Fallback summary comments. */
    readonly summaryComments: readonly unknown[];
    /** Published findings. */
    readonly findings: readonly unknown[];
  };
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Audited replay decisions. */
  readonly replayAudits: readonly AdminReplayAuditSummary[];
  /** Reconciliation report. */
  readonly reconciliation: {
    /** Current publisher durable state. */
    readonly status: string;
    /** Check-run row count. */
    readonly checkRunCount: number;
    /** Provider review row count. */
    readonly reviewCount: number;
    /** Summary comment row count. */
    readonly summaryCommentCount: number;
    /** Published finding row count. */
    readonly publishedFindingCount: number;
    /** Reconciliation issues. */
    readonly issues: readonly PublisherReconciliationIssue[];
  };
  /** Structured failures. */
  readonly failures: readonly AdminFailureDetail[];
};

/** One durable replay job plan shown by replay planning. */
type AdminReplayJobPlan = {
  /** Queue that should receive the replay job. */
  readonly queueName: string;
  /** Handler type carried by the replay envelope. */
  readonly jobType: string;
  /** New idempotency key for the replay row. */
  readonly replayJobKey: string;
};

/** Webhook replay plan response. */
type WebhookReplayPlan = {
  /** Replay action. */
  readonly action: "webhook.requeue_jobs";
  /** Durable job IDs blocked from replay. */
  readonly blockedJobIds: readonly string[];
  /** Expected job keys missing from durable state. */
  readonly missingJobKeys: readonly string[];
  /** Replay jobs that can be inserted. */
  readonly jobs: readonly AdminReplayJobPlan[];
  /** Current failures. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token for this plan. */
  readonly confirmationToken: string;
};

/** Review replay plan response. */
type ReviewReplayPlan = {
  /** Replay action. */
  readonly action: "review.requeue";
  /** Current review status. */
  readonly currentStatus: string;
  /** Related durable jobs. */
  readonly relatedJobs: readonly AdminBackgroundJobDebugSummary[];
  /** Replay job that can be inserted. */
  readonly job: AdminReplayJobPlan;
  /** Worker payload to replay. */
  readonly payload: unknown;
  /** Current failures. */
  readonly failures: readonly AdminFailureDetail[];
  /** Confirmation token for this plan. */
  readonly confirmationToken: string;
};

/** Publisher replay plan response. */
type PublisherReplayPlan = {
  /** Replay action. */
  readonly action: "publish.review";
  /** Replay job that can be inserted. */
  readonly job: AdminReplayJobPlan;
  /** Worker payload to replay. */
  readonly payload: unknown;
  /** Non-mutating publisher dry-run. */
  readonly dryRun: {
    /** Total publishable findings. */
    readonly findingCount: number;
    /** Planned comment outputs. */
    readonly comments: {
      /** Inline comment count. */
      readonly inlineCommentCount: number;
      /** Summary fallback count. */
      readonly summaryFallbackCount: number;
    };
  };
  /** Reconciliation report. */
  readonly reconciliation: {
    /** Current publisher durable state. */
    readonly status: string;
    /** Reconciliation issues. */
    readonly issues: readonly PublisherReconciliationIssue[];
  };
  /** Confirmation token for this plan. */
  readonly confirmationToken: string;
};

/** Replay execution result returned after dispatch. */
type AdminReplayExecutionResult = {
  /** Replay action that was confirmed. */
  readonly action: string;
  /** Audit log row ID when an actor was provided. */
  readonly auditLogId?: string | undefined;
  /** Durable job row IDs inserted for this replay. */
  readonly insertedJobIds: readonly string[];
  /** Durable job row IDs that already existed for the replay keys. */
  readonly existingJobIds: readonly string[];
  /** Replay jobs currently present in the durable outbox. */
  readonly replayJobs: readonly AdminBackgroundJobDebugSummary[];
};

/** Inspector kind available in the support console. */
type InspectorKind = "webhook" | "review" | "publisher";

/** Primary dashboard view. */
type ViewKind = "overview" | "inspectors" | "settings" | "audit";

/** API envelope returned by the admin API for successful requests. */
type ApiEnvelope<T> = {
  /** Response data payload. */
  readonly data: T;
};

/** API envelope returned by the admin API for failed requests. */
type ApiErrorEnvelope = {
  /** Structured API error. */
  readonly error: {
    /** Machine-readable error code. */
    readonly code: string;
    /** Human-readable error message. */
    readonly message: string;
  };
};

/** Header names accepted by the admin API for trusted identity assertions. */
const ADMIN_IDENTITY_HEADER_NAMES = {
  assertion: "x-heimdall-idp-assertion",
  signature: "x-heimdall-idp-signature",
  timestamp: "x-heimdall-idp-timestamp",
} as const;

/** Gateway-issued identity assertion headers accepted by the admin API. */
type AdminIdentityRequestHeaders = {
  /** Base64url-encoded identity assertion emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.assertion]: string;
  /** Assertion signature emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.signature]: string;
  /** Assertion timestamp emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: string;
};

/** Authenticated admin session returned by the API. */
type AdminSession = {
  /** Authenticated actor. */
  readonly actor: {
    /** Actor category. */
    readonly actorType: string;
    /** Stable actor user ID. */
    readonly userId: string;
    /** Granted access role. */
    readonly role: "support" | "admin";
    /** Display name when available. */
    readonly displayName?: string | undefined;
    /** Email when available. */
    readonly email?: string | undefined;
    /** Identity provider that authenticated the actor. */
    readonly provider?: string | undefined;
  };
  /** Capabilities granted to the actor. */
  readonly capabilities: {
    /** Whether the actor can inspect debug state. */
    readonly canInspect: boolean;
    /** Whether the actor can create replay plans. */
    readonly canPlanReplay: boolean;
    /** Whether the actor can execute replay. */
    readonly canExecuteReplay: boolean;
    /** Whether the actor can manage repository settings. */
    readonly canManageSettings: boolean;
    /** Whether the actor can view audit history. */
    readonly canViewAuditHistory: boolean;
  };
  /** Session-bound CSRF token used for mutations. */
  readonly csrfToken: string;
  /** Session expiration timestamp. */
  readonly expiresAt: string;
  /** Granular permissions granted to the actor. */
  readonly permissions: readonly string[];
  /** Granted organization and repository scopes. */
  readonly scopes: {
    /** Organization scope IDs. */
    readonly orgIds: readonly string[];
    /** Repository scope IDs. */
    readonly repoIds: readonly string[];
  };
  /** Opaque session ID. */
  readonly sessionId: string;
};

/** Repository summary returned by settings APIs. */
type ControlPlaneRepository = {
  /** Repository ID. */
  readonly repoId: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Repository full name. */
  readonly fullName: string;
  /** Whether review automation is enabled. */
  readonly enabled: boolean;
};

/** Repository discovery row returned by admin overview routes. */
type AdminRepositorySummary = ControlPlaneRepository & {
  /** Repository visibility. */
  readonly visibility: string;
  /** Default branch when known. */
  readonly defaultBranch?: string;
  /** Repository update timestamp. */
  readonly updatedAt: string;
  /** Latest review run ID when available. */
  readonly latestReviewRunId?: string;
  /** Latest review status when available. */
  readonly latestReviewStatus?: string;
  /** Latest review update timestamp when available. */
  readonly latestReviewUpdatedAt?: string;
};

/** Review history row returned by admin overview routes. */
type AdminReviewRunSummary = {
  /** Review run ID. */
  readonly reviewRunId: string;
  /** Repository ID. */
  readonly repoId: string;
  /** Organization ID. */
  readonly orgId: string;
  /** Repository full name. */
  readonly repoFullName: string;
  /** Provider pull request number. */
  readonly pullRequestNumber: number;
  /** Pull request title when available. */
  readonly pullRequestTitle?: string;
  /** Pull request author when available. */
  readonly authorLogin?: string;
  /** Changed file count when available. */
  readonly changedFileCount?: number;
  /** Review trigger. */
  readonly trigger: string;
  /** Review status. */
  readonly status: string;
  /** Base commit SHA. */
  readonly baseSha: string;
  /** Head commit SHA. */
  readonly headSha: string;
  /** Review summary when available. */
  readonly summary?: string;
  /** Finding counts. */
  readonly counts: AdminReviewFindingCounts;
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Update timestamp. */
  readonly updatedAt: string;
  /** Start timestamp when available. */
  readonly startedAt?: string;
  /** Completion timestamp when available. */
  readonly completedAt?: string;
};

/** Dashboard overview response. */
type AdminDashboardOverview = {
  /** Scoped repositories available to the actor. */
  readonly repositories: readonly AdminRepositorySummary[];
  /** Recent review runs available to the actor. */
  readonly recentReviews: readonly AdminReviewRunSummary[];
  /** Recent audit entries when the actor has audit access. */
  readonly recentAuditLogs: readonly AdminAuditLogSummary[];
};

/** Repository settings returned by settings APIs. */
type ControlPlaneSettings = {
  /** Review policy. */
  readonly reviewPolicy: string;
  /** Minimum severity threshold. */
  readonly severityThreshold: string;
  /** Maximum inline comments per review. */
  readonly maxCommentsPerReview: number;
  /** Ignored path globs. */
  readonly ignoredPaths: readonly string[];
  /** Ignored pull request authors. */
  readonly ignoredAuthors: readonly string[];
  /** Ignored pull request labels. */
  readonly ignoredLabels: readonly string[];
  /** Required label for reviews when configured. */
  readonly requireLabel?: string | undefined;
  /** Whether generated files are skipped. */
  readonly skipGeneratedFiles: boolean;
  /** Whether draft pull requests are skipped. */
  readonly skipDraftPullRequests: boolean;
  /** Custom instructions for this repository. */
  readonly customInstructions?: string | undefined;
};

/** Control-plane settings payload. */
type ControlPlaneSettingsResponse = {
  /** Repository being controlled. */
  readonly repository: ControlPlaneRepository;
  /** Mutable review settings. */
  readonly settings: ControlPlaneSettings;
};

/** Repository or organization rule row shown by repository settings UX. */
type AdminRepoRuleSummary = {
  /** Rule row ID. */
  readonly repoRuleId: string;
  /** Organization ID that owns the rule. */
  readonly orgId: string;
  /** Repository ID when the rule is repository-scoped. */
  readonly repoId?: string;
  /** Rule scope label. */
  readonly scope: string;
  /** Rule type label. */
  readonly ruleType: string;
  /** Rule body or instruction. */
  readonly body: string;
  /** Whether the rule currently applies. */
  readonly isEnabled: boolean;
  /** Rule creation timestamp. */
  readonly createdAt: string;
  /** Rule update timestamp. */
  readonly updatedAt: string;
};

/** Mutable settings form state. */
type SettingsFormState = {
  /** Whether the repository is enabled. */
  repositoryEnabled: boolean;
  /** Review policy. */
  reviewPolicy: string;
  /** Minimum severity threshold. */
  severityThreshold: string;
  /** Maximum inline comments per review. */
  maxCommentsPerReview: string;
  /** Ignored path globs, one per line. */
  ignoredPaths: string;
  /** Ignored authors, one per line. */
  ignoredAuthors: string;
  /** Ignored labels, one per line. */
  ignoredLabels: string;
  /** Required label. */
  requireLabel: string;
  /** Whether generated files are skipped. */
  skipGeneratedFiles: boolean;
  /** Whether draft pull requests are skipped. */
  skipDraftPullRequests: boolean;
  /** Custom instructions. */
  customInstructions: string;
};

/** Mutable overview view state. */
type OverviewViewState = {
  /** Repository search text. */
  repositorySearch: string;
  /** Repository filter applied to review history. */
  reviewRepoId: string;
  /** Review status filter. */
  reviewStatus: string;
  /** Review search text. */
  reviewSearch: string;
  /** Loaded repositories. */
  repositories: readonly AdminRepositorySummary[];
  /** Loaded recent or filtered reviews. */
  reviews: readonly AdminReviewRunSummary[];
  /** Loaded recent audit entries. */
  auditLogs: readonly AdminAuditLogSummary[];
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Mutable settings view state. */
type SettingsViewState = {
  /** Repository ID input. */
  repoId: string;
  /** Loaded settings payload. */
  data?: ControlPlaneSettingsResponse | undefined;
  /** Editable form state. */
  form?: SettingsFormState | undefined;
  /** Rules that currently affect the loaded repository. */
  rules: readonly AdminRepoRuleSummary[];
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
  /** Save confirmation message. */
  saved?: string | undefined;
};

/** Audit log row returned by the API. */
type AdminAuditLogSummary = {
  /** Audit log row ID. */
  readonly auditLogId: string;
  /** Organization ID when available. */
  readonly orgId?: string | undefined;
  /** Actor category. */
  readonly actorType: string;
  /** Actor user ID when available. */
  readonly actorUserId?: string | undefined;
  /** Audit action. */
  readonly action: string;
  /** Resource type. */
  readonly resourceType: string;
  /** Resource ID when available. */
  readonly resourceId?: string | undefined;
  /** Event timestamp. */
  readonly occurredAt: string;
  /** Event metadata. */
  readonly metadata?: unknown;
};

/** Mutable audit history view state. */
type AuditViewState = {
  /** Organization filter. */
  orgId: string;
  /** Action filter. */
  action: string;
  /** Resource type filter. */
  resourceType: string;
  /** Resource ID filter. */
  resourceId: string;
  /** Actor user ID filter. */
  actorUserId: string;
  /** Free-text search. */
  search: string;
  /** Loaded audit rows. */
  rows: readonly AdminAuditLogSummary[];
  /** Loading label. */
  loading?: string | undefined;
  /** Error message. */
  error?: string | undefined;
};

/** Inspector API route builder configuration. */
type InspectorConfig = {
  /** Inspector kind. */
  readonly kind: InspectorKind;
  /** Short tab label. */
  readonly label: string;
  /** Main heading for the inspector. */
  readonly title: string;
  /** ID input label. */
  readonly idLabel: string;
  /** ID input placeholder. */
  readonly placeholder: string;
  /** Builds the debug details route. */
  readonly detailsPath: (id: string) => string;
  /** Builds the replay plan route. */
  readonly replayPlanPath: (id: string) => string;
  /** Builds the replay execution route. */
  readonly replayPath: (id: string) => string;
};

/** Inspector detail response union. */
type InspectorDetails =
  | AdminWebhookDebugDetails
  | AdminReviewDebugDetails
  | AdminPublisherDebugDetails;

/** Inspector replay plan response union. */
type InspectorReplayPlan = WebhookReplayPlan | ReviewReplayPlan | PublisherReplayPlan;

/** Mutable view state for one inspector. */
type InspectorViewState = {
  /** Current resource ID input. */
  id: string;
  /** Loaded debug details. */
  details?: InspectorDetails | undefined;
  /** Loaded replay plan. */
  plan?: InspectorReplayPlan | undefined;
  /** Last replay execution result. */
  result?: AdminReplayExecutionResult | undefined;
  /** Typed confirmation token for replay execution. */
  confirmationTokenInput: string;
  /** Current inspector-specific error. */
  error?: string | undefined;
  /** Current inspector-specific loading label. */
  loading?: string | undefined;
};

/** Mutable application state. */
type AppState = {
  /** Active primary dashboard view. */
  activeView: ViewKind;
  /** Active inspector tab. */
  activeKind: InspectorKind;
  /** API base URL. Empty string means same origin. */
  apiBaseUrl: string;
  /** Admin gateway base URL. Empty string means same origin. */
  gatewayBaseUrl: string;
  /** Authenticated admin session. */
  session?: AdminSession | undefined;
  /** Current authentication loading label. */
  authLoading?: string | undefined;
  /** Global authentication error. */
  authError?: string | undefined;
  /** Per-inspector state. */
  inspectors: Record<InspectorKind, InspectorViewState>;
  /** Overview view state. */
  overview: OverviewViewState;
  /** Settings view state. */
  settings: SettingsViewState;
  /** Audit history view state. */
  audit: AuditViewState;
};

const appRoot = document.querySelector<HTMLElement>("#app");

if (!appRoot) {
  throw new Error("Missing app root");
}

const app = appRoot;

const apiBaseUrl = import.meta.env.VITE_HEIMDALL_API_BASE_URL ?? "";
const gatewayBaseUrl = import.meta.env.VITE_HEIMDALL_ADMIN_GATEWAY_BASE_URL ?? "";
const API_BASE_URL_STORAGE_KEY = "heimdall:admin-api-base-url";
const GATEWAY_BASE_URL_STORAGE_KEY = "heimdall:admin-gateway-base-url";
const PENDING_GATEWAY_LOGIN_STORAGE_KEY = "heimdall:pending-admin-gateway-login";

const inspectorConfigs: Record<InspectorKind, InspectorConfig> = {
  webhook: {
    kind: "webhook",
    label: "Webhook",
    title: "Webhook Inspector",
    idLabel: "Webhook event ID",
    placeholder: "webhook_...",
    detailsPath: (id) => `/admin/debug/webhooks/${encodeURIComponent(id)}`,
    replayPlanPath: (id) => `/admin/debug/webhooks/${encodeURIComponent(id)}/replay-plan`,
    replayPath: (id) => `/admin/debug/webhooks/${encodeURIComponent(id)}/replay`,
  },
  review: {
    kind: "review",
    label: "Review",
    title: "Review Inspector",
    idLabel: "Review run ID",
    placeholder: "rrn_...",
    detailsPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}`,
    replayPlanPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}/replay-plan`,
    replayPath: (id) => `/admin/debug/reviews/${encodeURIComponent(id)}/replay`,
  },
  publisher: {
    kind: "publisher",
    label: "Publisher",
    title: "Publisher Inspector",
    idLabel: "Review run ID",
    placeholder: "rrn_...",
    detailsPath: (id) => `/admin/debug/publisher/${encodeURIComponent(id)}`,
    replayPlanPath: (id) => `/admin/debug/publisher/${encodeURIComponent(id)}/replay-plan`,
    replayPath: (id) => `/admin/debug/publisher/${encodeURIComponent(id)}/replay`,
  },
};

const state: AppState = {
  activeView: "overview",
  activeKind: "webhook",
  apiBaseUrl: sessionStorage.getItem(API_BASE_URL_STORAGE_KEY) ?? apiBaseUrl,
  gatewayBaseUrl: sessionStorage.getItem(GATEWAY_BASE_URL_STORAGE_KEY) ?? gatewayBaseUrl,
  inspectors: {
    webhook: { id: "", confirmationTokenInput: "" },
    review: { id: "", confirmationTokenInput: "" },
    publisher: { id: "", confirmationTokenInput: "" },
  },
  overview: {
    repositorySearch: "",
    reviewRepoId: "",
    reviewStatus: "",
    reviewSearch: "",
    repositories: [],
    reviews: [],
    auditLogs: [],
  },
  settings: { repoId: "", rules: [] },
  audit: {
    orgId: "",
    action: "",
    resourceType: "",
    resourceId: "",
    actorUserId: "",
    search: "",
    rows: [],
  },
};

app.addEventListener("click", (event) => {
  void handleClick(event);
});
app.addEventListener("input", handleInput);

render();
void completePendingGatewayLogin();

/** Handles delegated click events from the dashboard. */
async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target instanceof HTMLElement ? event.target : undefined;
  const element = target?.closest<HTMLElement>("[data-action],[data-tab],[data-view]");
  if (!element) {
    return;
  }

  const view = element.dataset.view as ViewKind | undefined;
  if (view && isViewKind(view)) {
    state.activeView = view;
    render();
    if (view === "overview" && state.session && state.overview.repositories.length === 0) {
      await loadOverview();
    }
    return;
  }

  const tab = element.dataset.tab as InspectorKind | undefined;
  if (tab && isInspectorKind(tab)) {
    state.activeKind = tab;
    render();
    return;
  }

  const action = element.dataset.action;
  if (!action) {
    return;
  }

  event.preventDefault();
  if (action === "login-github") {
    startGitHubLogin();
    return;
  }

  if (action === "connect-admin-session") {
    await connectAdminSession();
    return;
  }

  if (action === "refresh-session") {
    await refreshAdminSession();
    return;
  }

  if (action === "clear-auth") {
    await clearAuth();
    return;
  }

  if (action === "load-details") {
    await loadDetails(state.activeKind);
    return;
  }

  if (action === "load-overview") {
    await loadOverview();
    return;
  }

  if (action === "search-repositories") {
    await loadRepositories();
    return;
  }

  if (action === "search-reviews") {
    await loadReviewHistory();
    return;
  }

  if (action === "clear-review-filter") {
    state.overview.reviewRepoId = "";
    await loadReviewHistory();
    return;
  }

  if (action === "open-settings") {
    await openRepositorySettings(requiredDatasetValue(element, "repoId"));
    return;
  }

  if (action === "filter-reviews-repo") {
    state.activeView = "overview";
    state.overview.reviewRepoId = requiredDatasetValue(element, "repoId");
    await loadReviewHistory();
    return;
  }

  if (action === "open-repository-audit") {
    await openAuditSearch({
      resourceId: requiredDatasetValue(element, "repoId"),
      resourceType: "repository",
    });
    return;
  }

  if (action === "open-review-inspector") {
    await openInspector("review", requiredDatasetValue(element, "reviewRunId"));
    return;
  }

  if (action === "open-publisher-inspector") {
    await openInspector("publisher", requiredDatasetValue(element, "reviewRunId"));
    return;
  }

  if (action === "open-review-audit") {
    await openAuditSearch({
      resourceId: requiredDatasetValue(element, "reviewRunId"),
      search: requiredDatasetValue(element, "reviewRunId"),
    });
    return;
  }

  if (action === "open-audit-row") {
    await openAuditSearch({
      resourceId: element.dataset.resourceId,
      resourceType: element.dataset.resourceType,
      search: element.dataset.search,
    });
    return;
  }

  if (action === "create-plan") {
    await createReplayPlan(state.activeKind);
    return;
  }

  if (action === "execute-replay") {
    await executeReplay(state.activeKind);
    return;
  }

  if (action === "load-settings") {
    await loadSettings();
    return;
  }

  if (action === "save-settings") {
    await saveSettings();
    return;
  }

  if (action === "load-audit") {
    await loadAuditHistory();
  }
}

/** Handles delegated input events from the dashboard. */
function handleInput(event: Event): void {
  const target = event.target;
  if (
    !(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    )
  ) {
    return;
  }

  const field = target.dataset.field;
  if (field === "api-base-url") {
    state.apiBaseUrl = target.value;
    return;
  }

  if (field === "gateway-base-url") {
    state.gatewayBaseUrl = target.value;
    return;
  }

  if (field === "resource-id") {
    const inspector = currentInspectorState();
    inspector.id = target.value;
    inspector.error = undefined;
    return;
  }

  if (field === "confirmation-token") {
    currentInspectorState().confirmationTokenInput = target.value;
    return;
  }

  if (field?.startsWith("overview.")) {
    updateOverviewField(field.slice("overview.".length), target.value);
    return;
  }

  if (field === "settings-repo-id") {
    state.settings.repoId = target.value;
    state.settings.error = undefined;
    return;
  }

  if (field?.startsWith("settings.")) {
    updateSettingsFormField(field.slice("settings.".length), target);
    return;
  }

  if (field?.startsWith("audit.")) {
    updateAuditField(field.slice("audit.".length), target.value);
  }
}

/** Continues the GitHub login return path when OAuth redirected back to the dashboard. */
async function completePendingGatewayLogin(): Promise<void> {
  if (sessionStorage.getItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY) !== "true") {
    return;
  }

  await connectAdminSession();
}

/** Starts the GitHub OAuth login flow through the configured admin gateway. */
function startGitHubLogin(): void {
  state.authError = undefined;
  persistLoginConfig();
  sessionStorage.setItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY, "true");
  window.location.assign(githubLoginStartUrl());
}

/** Connects the dashboard to the admin API using a gateway-issued identity assertion. */
async function connectAdminSession(): Promise<void> {
  state.authError = undefined;
  state.authLoading = "Connecting admin session";
  render();
  try {
    persistLoginConfig();
    const assertion = await requestGatewayAssertion();
    await requestAdminData<AdminSession>("/admin/auth/login", {
      headers: identityAssertionHeaders(assertion),
      method: "POST",
    });
    const session = await requestAdminData<AdminSession>("/admin/session");
    state.session = session;
    sessionStorage.removeItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY);
    await loadOverview();
  } catch (error) {
    state.session = undefined;
    state.authError = errorMessage(error);
  } finally {
    state.authLoading = undefined;
    render();
  }
}

/** Refreshes the current API session cookie and reloads the overview. */
async function refreshAdminSession(): Promise<void> {
  state.authError = undefined;
  state.authLoading = "Refreshing admin session";
  render();
  try {
    persistLoginConfig();
    const session = await requestAdminData<AdminSession>("/admin/session");
    state.session = session;
    await loadOverview();
  } catch (error) {
    state.session = undefined;
    state.authError = errorMessage(error);
  } finally {
    state.authLoading = undefined;
    render();
  }
}

/** Clears authentication state from memory and session storage. */
async function clearAuth(): Promise<void> {
  state.authError = undefined;
  state.authLoading = "Logging out";
  render();
  try {
    if (state.session) {
      await requestAdminData<{ readonly ok: boolean }>("/admin/auth/logout", { method: "POST" });
    }
  } catch (error) {
    state.authError = errorMessage(error);
  } finally {
    sessionStorage.removeItem(PENDING_GATEWAY_LOGIN_STORAGE_KEY);
    state.session = undefined;
    state.authLoading = undefined;
    render();
  }
}

/** Loads debug details for the selected inspector. */
async function loadDetails(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Loading inspector";
  inspector.error = undefined;
  try {
    inspector.details = await requestAdminData<InspectorDetails>(config.detailsPath(id));
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Creates a replay plan for the selected inspector. */
async function createReplayPlan(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  if (!id) {
    inspector.error = `${config.idLabel} is required.`;
    render();
    return;
  }

  inspector.loading = "Creating replay plan";
  inspector.error = undefined;
  inspector.result = undefined;
  inspector.confirmationTokenInput = "";
  try {
    inspector.plan = await requestAdminData<InspectorReplayPlan>(config.replayPlanPath(id), {
      method: "POST",
    });
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Executes a confirmed replay plan for the selected inspector. */
async function executeReplay(kind: InspectorKind): Promise<void> {
  const config = inspectorConfigs[kind];
  const inspector = state.inspectors[kind];
  const id = inspector.id.trim();
  const expectedToken = inspector.plan?.confirmationToken;
  const providedToken = inspector.confirmationTokenInput.trim();
  if (!expectedToken) {
    inspector.error = "Create a replay plan before dispatch.";
    render();
    return;
  }
  if (providedToken !== expectedToken) {
    inspector.error = "Confirmation token does not match the current plan.";
    render();
    return;
  }

  inspector.loading = "Dispatching replay";
  inspector.error = undefined;
  try {
    inspector.result = await requestAdminData<AdminReplayExecutionResult>(config.replayPath(id), {
      method: "POST",
      body: JSON.stringify({ confirmationToken: providedToken }),
    });
    inspector.details = await requestAdminData<InspectorDetails>(config.detailsPath(id));
  } catch (error) {
    inspector.error = errorMessage(error);
  } finally {
    inspector.loading = undefined;
    render();
  }
}

/** Loads the dashboard overview for repository and review discovery. */
async function loadOverview(): Promise<void> {
  state.overview.loading = "Loading dashboard overview";
  state.overview.error = undefined;
  try {
    const data = await requestAdminData<AdminDashboardOverview>("/admin/overview?limit=12");
    state.overview.repositories = data.repositories;
    state.overview.reviews = data.recentReviews;
    state.overview.auditLogs = data.recentAuditLogs;
  } catch (error) {
    state.overview.error = errorMessage(error);
  } finally {
    state.overview.loading = undefined;
    render();
  }
}

/** Searches repositories available to the current admin actor. */
async function loadRepositories(): Promise<void> {
  state.overview.loading = "Searching repositories";
  state.overview.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "search", state.overview.repositorySearch);
    params.set("limit", "50");
    const data = await requestAdminData<{
      readonly repositories: readonly AdminRepositorySummary[];
    }>(`/admin/repos?${params.toString()}`);
    state.overview.repositories = data.repositories;
  } catch (error) {
    state.overview.error = errorMessage(error);
  } finally {
    state.overview.loading = undefined;
    render();
  }
}

/** Searches review history available to the current admin actor. */
async function loadReviewHistory(): Promise<void> {
  state.overview.loading = "Loading review history";
  state.overview.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "repoId", state.overview.reviewRepoId);
    appendQueryParam(params, "status", state.overview.reviewStatus);
    appendQueryParam(params, "search", state.overview.reviewSearch);
    params.set("limit", "50");
    const data = await requestAdminData<{ readonly reviews: readonly AdminReviewRunSummary[] }>(
      `/admin/reviews?${params.toString()}`,
    );
    state.overview.reviews = data.reviews;
  } catch (error) {
    state.overview.error = errorMessage(error);
  } finally {
    state.overview.loading = undefined;
    render();
  }
}

/** Opens repository settings for a discovered repository. */
async function openRepositorySettings(repoId: string): Promise<void> {
  state.activeView = "settings";
  state.settings.repoId = repoId;
  await loadSettings();
}

/** Opens one inspector with a discovered resource ID. */
async function openInspector(kind: InspectorKind, resourceId: string): Promise<void> {
  state.activeView = "inspectors";
  state.activeKind = kind;
  state.inspectors[kind].id = resourceId;
  await loadDetails(kind);
}

/** Opens audit history with prefilled filters. */
async function openAuditSearch(input: {
  /** Resource type filter. */
  readonly resourceType?: string | undefined;
  /** Resource ID filter. */
  readonly resourceId?: string | undefined;
  /** Search text. */
  readonly search?: string | undefined;
}): Promise<void> {
  state.activeView = "audit";
  state.audit.resourceType = input.resourceType ?? "";
  state.audit.resourceId = input.resourceId ?? "";
  state.audit.search = input.search ?? "";
  await loadAuditHistory();
}

/** Loads repository settings into the settings form. */
async function loadSettings(): Promise<void> {
  const repoId = state.settings.repoId.trim();
  if (!repoId) {
    state.settings.error = "Repository ID is required.";
    render();
    return;
  }

  state.settings.loading = "Loading repository settings";
  state.settings.error = undefined;
  state.settings.saved = undefined;
  try {
    const [data, rulesData] = await Promise.all([
      requestAdminData<ControlPlaneSettingsResponse>(
        `/admin/repos/${encodeURIComponent(repoId)}/settings`,
      ),
      requestAdminData<{ readonly rules: readonly AdminRepoRuleSummary[] }>(
        `/admin/repos/${encodeURIComponent(repoId)}/rules`,
      ),
    ]);
    state.settings.data = data;
    state.settings.form = settingsFormFromResponse(data);
    state.settings.rules = rulesData.rules;
  } catch (error) {
    state.settings.error = errorMessage(error);
  } finally {
    state.settings.loading = undefined;
    render();
  }
}

/** Saves the current repository settings form. */
async function saveSettings(): Promise<void> {
  const repoId = state.settings.repoId.trim();
  const form = state.settings.form;
  if (!repoId || !form) {
    state.settings.error = "Load repository settings before saving.";
    render();
    return;
  }

  state.settings.loading = "Saving repository settings";
  state.settings.error = undefined;
  state.settings.saved = undefined;
  try {
    const data = await requestAdminData<ControlPlaneSettingsResponse>(
      `/admin/repos/${encodeURIComponent(repoId)}/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(settingsPatchFromForm(form)),
      },
    );
    state.settings.data = data;
    state.settings.form = settingsFormFromResponse(data);
    state.settings.saved = "Settings saved.";
  } catch (error) {
    state.settings.error = errorMessage(error);
  } finally {
    state.settings.loading = undefined;
    render();
  }
}

/** Loads audit history using the current filters. */
async function loadAuditHistory(): Promise<void> {
  state.audit.loading = "Loading audit history";
  state.audit.error = undefined;
  try {
    const params = new URLSearchParams();
    appendQueryParam(params, "orgId", state.audit.orgId);
    appendQueryParam(params, "action", state.audit.action);
    appendQueryParam(params, "resourceType", state.audit.resourceType);
    appendQueryParam(params, "resourceId", state.audit.resourceId);
    appendQueryParam(params, "actorUserId", state.audit.actorUserId);
    appendQueryParam(params, "search", state.audit.search);
    params.set("limit", "50");
    const result = await requestAdminData<{ readonly auditLogs: readonly AdminAuditLogSummary[] }>(
      `/admin/audit-logs?${params.toString()}`,
    );
    state.audit.rows = result.auditLogs;
  } catch (error) {
    state.audit.error = errorMessage(error);
  } finally {
    state.audit.loading = undefined;
    render();
  }
}

/** Requests a typed data payload from the admin API. */
async function requestAdminData<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!isSafeMethod(method) && state.session?.csrfToken) {
    headers.set("x-csrf-token", state.session.csrfToken);
  }

  const response = await fetch(adminUrl(path), {
    ...init,
    credentials: "include",
    headers,
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401) {
      state.session = undefined;
    }
    throw new Error(apiErrorMessage(body, response.status));
  }

  return (body as ApiEnvelope<T>).data;
}

/** Requests a signed identity assertion from the configured admin gateway. */
async function requestGatewayAssertion(): Promise<AdminIdentityRequestHeaders> {
  const response = await fetch(gatewayAssertionUrl(), {
    body: JSON.stringify({ purpose: "dashboard-login" }),
    credentials: "include",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(apiErrorMessage(body, response.status));
  }

  return identityAssertionFromGatewayBody(body);
}

/** Returns a complete admin API URL for a route path. */
function adminUrl(path: string): string {
  const baseUrl = state.apiBaseUrl.trim().replace(/\/$/u, "");
  return `${baseUrl}${path}`;
}

/** Returns the GitHub OAuth start URL for the configured admin gateway. */
function githubLoginStartUrl(): string {
  const url = new URL("/auth/github/start", gatewayBaseOriginUrl());
  url.searchParams.set("returnTo", window.location.href);
  return url.toString();
}

/** Returns the signed assertion endpoint URL for the configured admin gateway. */
function gatewayAssertionUrl(): string {
  const configured = state.gatewayBaseUrl.trim();
  if (configured.length === 0) {
    return "/heimdall/assertion";
  }

  const url = new URL(configured, window.location.origin);
  if (url.pathname.endsWith("/assertion")) {
    return url.toString();
  }

  return new URL("/heimdall/assertion", url).toString();
}

/** Returns the gateway origin used by the OAuth start endpoint. */
function gatewayBaseOriginUrl(): string {
  const configured = state.gatewayBaseUrl.trim();
  if (configured.length === 0) {
    return window.location.origin;
  }

  return new URL(configured, window.location.origin).origin;
}

/** Persists login endpoint configuration for redirects and browser reloads. */
function persistLoginConfig(): void {
  sessionStorage.setItem(API_BASE_URL_STORAGE_KEY, state.apiBaseUrl);
  sessionStorage.setItem(GATEWAY_BASE_URL_STORAGE_KEY, state.gatewayBaseUrl);
}

/** Converts a gateway assertion tuple into API login headers. */
function identityAssertionHeaders(assertion: AdminIdentityRequestHeaders): Headers {
  const headers = new Headers();
  headers.set(
    ADMIN_IDENTITY_HEADER_NAMES.assertion,
    assertion[ADMIN_IDENTITY_HEADER_NAMES.assertion],
  );
  headers.set(
    ADMIN_IDENTITY_HEADER_NAMES.signature,
    assertion[ADMIN_IDENTITY_HEADER_NAMES.signature],
  );
  headers.set(
    ADMIN_IDENTITY_HEADER_NAMES.timestamp,
    assertion[ADMIN_IDENTITY_HEADER_NAMES.timestamp],
  );
  return headers;
}

/** Parses a gateway assertion response into API login headers. */
function identityAssertionFromGatewayBody(body: unknown): AdminIdentityRequestHeaders {
  const record = asRecord(body);
  const headerRecord = asRecord(record?.headers);
  const encodedAssertion =
    stringField(record, "encodedAssertion") ??
    stringField(record, "assertion") ??
    stringField(headerRecord, ADMIN_IDENTITY_HEADER_NAMES.assertion);
  const signature =
    stringField(record, "signature") ??
    stringField(headerRecord, ADMIN_IDENTITY_HEADER_NAMES.signature);
  const timestamp =
    stringField(record, "timestamp") ??
    stringField(headerRecord, ADMIN_IDENTITY_HEADER_NAMES.timestamp);

  if (!encodedAssertion || !signature || !timestamp) {
    throw new Error("Admin gateway response did not include a complete identity assertion.");
  }

  return {
    [ADMIN_IDENTITY_HEADER_NAMES.assertion]: encodedAssertion,
    [ADMIN_IDENTITY_HEADER_NAMES.signature]: signature,
    [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: timestamp,
  };
}

/** Extracts a useful API error message from an unknown response body. */
function apiErrorMessage(body: unknown, status: number): string {
  const record = asRecord(body);
  const error = asRecord(record?.error) as ApiErrorEnvelope["error"] | undefined;
  if (error?.message) {
    return `${error.code}: ${error.message}`;
  }

  return `Request failed with HTTP ${status}.`;
}

/** Renders the complete dashboard. */
function render(): void {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Heimdall Admin</p>
          <h1>Operator Console</h1>
        </div>
        ${renderSessionBadge()}
      </header>
      ${renderAuthPanel()}
      ${renderPrimaryNav()}
      ${renderActiveView()}
    </div>
  `;
}

/** Renders the current session badge. */
function renderSessionBadge(): string {
  if (!state.session) {
    return `<span class="status muted">Disconnected</span>`;
  }

  const actor = state.session.actor;
  const label = actor.displayName ?? actor.email ?? actor.userId;
  return `
    <div class="actor">
      <span class="status ${actor.role === "admin" ? "ok" : "warn"}">${escapeHtml(actor.role)}</span>
      <strong>${escapeHtml(label)}</strong>
    </div>
  `;
}

/** Renders the authentication controls. */
function renderAuthPanel(): string {
  const disabled = state.authLoading ? "disabled" : "";
  const sessionLabel = state.authLoading ?? (state.session ? "Active" : "No session cookie");
  return `
    <section class="auth-panel">
      <label>
        <span>API URL</span>
        <input data-field="api-base-url" value="${escapeAttribute(state.apiBaseUrl)}" />
      </label>
      <label>
        <span>Gateway URL</span>
        <input data-field="gateway-base-url" value="${escapeAttribute(state.gatewayBaseUrl)}" />
      </label>
      <div class="session-copy">
        <span>Identity session</span>
        <strong>${escapeHtml(sessionLabel)}</strong>
      </div>
      <button data-action="login-github" type="button" ${disabled}>Login with GitHub</button>
      <button class="primary" data-action="connect-admin-session" type="button" ${disabled}>
        Connect admin session
      </button>
      <button class="ghost" data-action="refresh-session" type="button" ${disabled}>Refresh</button>
      <button class="ghost" data-action="clear-auth" type="button" ${disabled}>Logout</button>
      ${state.authError ? `<p class="error-line">${escapeHtml(state.authError)}</p>` : ""}
    </section>
  `;
}

/** Renders primary control-plane navigation. */
function renderPrimaryNav(): string {
  const views: readonly { readonly kind: ViewKind; readonly label: string }[] = [
    { kind: "overview", label: "Overview" },
    { kind: "inspectors", label: "Inspectors" },
    { kind: "settings", label: "Settings" },
    { kind: "audit", label: "Audit" },
  ];
  return `
    <nav class="primary-nav" aria-label="Control-plane views">
      ${views
        .map(
          (view) => `
            <button
              class="tab ${state.activeView === view.kind ? "active" : ""}"
              data-view="${view.kind}"
              type="button"
            >
              ${escapeHtml(view.label)}
            </button>
          `,
        )
        .join("")}
    </nav>
  `;
}

/** Renders the active primary control-plane view. */
function renderActiveView(): string {
  if (state.activeView === "overview") {
    return renderOverviewView();
  }
  if (state.activeView === "settings") {
    return renderSettingsView();
  }
  if (state.activeView === "audit") {
    return renderAuditView();
  }

  return `
    <section class="workspace">
      <nav class="tabs" aria-label="Inspector views">
        ${objectValues(inspectorConfigs)
          .map((config) => renderTab(config))
          .join("")}
      </nav>
      ${renderInspector()}
    </section>
  `;
}

/** Renders the dashboard overview with discovery and activity. */
function renderOverviewView(): string {
  const overview = state.overview;
  return `
    <main class="inspector overview-view">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Dashboard</p>
          <h2>Control Overview</h2>
        </div>
        <button class="primary" data-action="load-overview" type="button">Refresh</button>
      </section>
      ${renderOverviewNotice(overview)}
      <section class="overview-grid">
        ${renderRepositoryDiscovery(overview)}
        ${renderReviewHistoryDiscovery(overview)}
      </section>
      ${renderRecentActivity(overview.auditLogs)}
    </main>
  `;
}

/** Renders overview loading and error state. */
function renderOverviewNotice(overview: OverviewViewState): string {
  if (overview.loading) {
    return `<p class="notice">${escapeHtml(overview.loading)}</p>`;
  }
  if (overview.error) {
    return `<p class="error-line">${escapeHtml(overview.error)}</p>`;
  }
  if (!state.session) {
    return `<p class="notice">Refresh the identity session to load repositories and reviews.</p>`;
  }

  return "";
}

/** Renders repository discovery cards. */
function renderRepositoryDiscovery(overview: OverviewViewState): string {
  return `
    <section class="panel discovery-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Repositories</p>
          <h3>Repository Discovery</h3>
        </div>
        <div class="inline-controls">
          <label>
            <span>Search</span>
            <input
              data-field="overview.repositorySearch"
              placeholder="owner/name"
              value="${escapeAttribute(overview.repositorySearch)}"
            />
          </label>
          <button data-action="search-repositories" type="button">Search</button>
        </div>
      </div>
      ${
        overview.repositories.length === 0
          ? `<p class="inline-empty">No repositories loaded.</p>`
          : `<div class="repo-list">${overview.repositories.map(renderRepositoryCard).join("")}</div>`
      }
    </section>
  `;
}

/** Renders one repository discovery card. */
function renderRepositoryCard(repository: AdminRepositorySummary): string {
  return `
    <article class="repo-card">
      <div>
        <div class="repo-title">
          <strong>${escapeHtml(repository.fullName)}</strong>
          <span class="status ${repository.enabled ? "ok" : "muted"}">
            ${repository.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <p class="muted-text">
          ${escapeHtml(repository.visibility)}
          ${repository.defaultBranch ? ` / ${escapeHtml(repository.defaultBranch)}` : ""}
        </p>
        ${
          repository.latestReviewRunId
            ? `<p class="muted-text">
                Latest review ${escapeHtml(repository.latestReviewRunId)}
                ${repository.latestReviewStatus ? ` / ${escapeHtml(repository.latestReviewStatus)}` : ""}
              </p>`
            : `<p class="muted-text">No review runs found.</p>`
        }
      </div>
      <div class="card-actions">
        <button data-action="open-settings" data-repo-id="${escapeAttribute(repository.repoId)}" type="button">
          Settings
        </button>
        <button data-action="filter-reviews-repo" data-repo-id="${escapeAttribute(repository.repoId)}" type="button">
          Reviews
        </button>
        <button data-action="open-repository-audit" data-repo-id="${escapeAttribute(repository.repoId)}" type="button">
          Audit
        </button>
      </div>
    </article>
  `;
}

/** Renders review history search and rows. */
function renderReviewHistoryDiscovery(overview: OverviewViewState): string {
  return `
    <section class="panel discovery-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Reviews</p>
          <h3>Review History</h3>
        </div>
        <button data-action="search-reviews" type="button">Refresh</button>
      </div>
      <div class="form-grid compact-form">
        ${renderTextInput("overview.reviewSearch", "Search", overview.reviewSearch, "PR title, author, #")}
        ${renderTextInput("overview.reviewRepoId", "Repository filter", overview.reviewRepoId, "selected repository")}
        ${renderReviewStatusSelect(overview.reviewStatus)}
      </div>
      ${
        overview.reviewRepoId
          ? `<button class="ghost" data-action="clear-review-filter" type="button">Clear repository filter</button>`
          : ""
      }
      ${renderReviewRows(overview.reviews)}
    </section>
  `;
}

/** Renders the review status filter. */
function renderReviewStatusSelect(value: string): string {
  const statuses = ["", "queued", "reviewing", "completed", "failed", "cancelled"];
  return `
    <label>
      <span>Status</span>
      <select data-field="overview.reviewStatus">
        ${statuses
          .map(
            (status) => `
              <option value="${escapeAttribute(status)}" ${status === value ? "selected" : ""}>
                ${escapeHtml(status || "Any")}
              </option>
            `,
          )
          .join("")}
      </select>
    </label>
  `;
}

/** Renders review history rows. */
function renderReviewRows(rows: readonly AdminReviewRunSummary[]): string {
  if (rows.length === 0) {
    return `<p class="inline-empty">No review history loaded.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Review</th>
            <th>Status</th>
            <th>Findings</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(renderReviewRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders one review history row. */
function renderReviewRow(review: AdminReviewRunSummary): string {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(review.repoFullName)} #${review.pullRequestNumber}</strong>
        <p class="muted-text">${escapeHtml(review.pullRequestTitle ?? review.summary ?? review.reviewRunId)}</p>
        <code>${escapeHtml(formatSha(review.headSha))}</code>
      </td>
      <td><span class="status ${statusClass(review.status)}">${escapeHtml(review.status)}</span></td>
      <td>
        ${review.counts.validatedFindings} validated /
        ${review.counts.publishedFindings} published
      </td>
      <td>${formatTime(review.updatedAt)}</td>
      <td>
        <div class="row-actions">
          <button data-action="open-review-inspector" data-review-run-id="${escapeAttribute(review.reviewRunId)}" type="button">
            Inspect
          </button>
          <button data-action="open-publisher-inspector" data-review-run-id="${escapeAttribute(review.reviewRunId)}" type="button">
            Publisher
          </button>
          <button data-action="open-review-audit" data-review-run-id="${escapeAttribute(review.reviewRunId)}" type="button">
            Audit
          </button>
        </div>
      </td>
    </tr>
  `;
}

/** Renders recent audit activity from the overview. */
function renderRecentActivity(rows: readonly AdminAuditLogSummary[]): string {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Activity</p>
          <h3>Recent Audit Entries</h3>
        </div>
        <button data-view="audit" type="button">Open audit search</button>
      </div>
      ${
        rows.length === 0
          ? `<p class="inline-empty">No recent audit entries loaded.</p>`
          : renderAuditActivityRows(rows)
      }
    </section>
  `;
}

/** Renders recent audit rows in a compact table. */
function renderAuditActivityRows(rows: readonly AdminAuditLogSummary[]): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Open</th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>${formatTime(row.occurredAt)}</td>
                  <td>${escapeHtml(row.actorUserId ?? row.actorType)}</td>
                  <td>${escapeHtml(row.action)}</td>
                  <td>${escapeHtml(row.resourceId ?? row.resourceType)}</td>
                  <td>
                    <button
                      data-action="open-audit-row"
                      data-resource-id="${escapeAttribute(row.resourceId ?? "")}"
                      data-resource-type="${escapeAttribute(row.resourceType)}"
                      data-search="${escapeAttribute(row.action)}"
                      type="button"
                    >
                      Filter
                    </button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders repository settings controls. */
function renderSettingsView(): string {
  const settings = state.settings;
  const form = settings.form;
  const canSave = Boolean(state.session?.capabilities.canManageSettings && form);
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">Repository</p>
          <h2>Review Settings</h2>
        </div>
        <div class="resource-controls compact-controls">
          <label>
            <span>Repository ID</span>
            <input
              data-field="settings-repo-id"
              placeholder="repo_..."
              value="${escapeAttribute(settings.repoId)}"
            />
          </label>
          <button data-action="load-settings" type="button">Load</button>
          <button
            class="primary"
            data-action="save-settings"
            type="button"
            ${canSave ? "" : "disabled"}
          >
            Save
          </button>
        </div>
      </section>
      ${renderSettingsNotice(settings)}
      ${form ? renderSettingsForm(form, settings.data, settings.rules) : renderEmptyState()}
    </main>
  `;
}

/** Renders settings loading, error, or saved state. */
function renderSettingsNotice(settings: SettingsViewState): string {
  if (settings.loading) {
    return `<p class="notice">${escapeHtml(settings.loading)}</p>`;
  }
  if (settings.error) {
    return `<p class="error-line">${escapeHtml(settings.error)}</p>`;
  }
  if (settings.saved) {
    return `<p class="notice">${escapeHtml(settings.saved)}</p>`;
  }

  return "";
}

/** Renders the repository settings form. */
function renderSettingsForm(
  form: SettingsFormState,
  data: ControlPlaneSettingsResponse | undefined,
  rules: readonly AdminRepoRuleSummary[],
): string {
  return `
    <section class="panel">
      ${
        data
          ? `
            <div class="summary-grid">
              <div class="metric">
                <span>Repository</span>
                <strong>${escapeHtml(data.repository.fullName)}</strong>
              </div>
              <div class="metric">
                <span>Organization</span>
                <strong>${escapeHtml(data.repository.orgId)}</strong>
              </div>
              <div class="metric">
                <span>Automation</span>
                <strong>${data.repository.enabled ? "Enabled" : "Disabled"}</strong>
              </div>
            </div>
          `
          : ""
      }
      <div class="form-grid">
        ${renderCheckbox("settings.repositoryEnabled", "Review automation", form.repositoryEnabled)}
        ${renderSelect("settings.reviewPolicy", "Review policy", form.reviewPolicy, [
          "disabled",
          "summary_only",
          "inline_comments",
          "inline_comments_and_summary",
          "check_run_only",
          "inline_comments_summary_and_check_run",
        ])}
        ${renderSelect("settings.severityThreshold", "Severity threshold", form.severityThreshold, [
          "low",
          "medium",
          "high",
          "critical",
        ])}
        <label>
          <span>Max comments</span>
          <input
            data-field="settings.maxCommentsPerReview"
            min="0"
            max="50"
            type="number"
            value="${escapeAttribute(form.maxCommentsPerReview)}"
          />
        </label>
        <label>
          <span>Required label</span>
          <input
            data-field="settings.requireLabel"
            placeholder="security-review"
            value="${escapeAttribute(form.requireLabel)}"
          />
        </label>
        ${renderCheckbox("settings.skipGeneratedFiles", "Skip generated files", form.skipGeneratedFiles)}
        ${renderCheckbox(
          "settings.skipDraftPullRequests",
          "Skip draft pull requests",
          form.skipDraftPullRequests,
        )}
      </div>
      <div class="form-grid textareas">
        ${renderTextarea("settings.ignoredPaths", "Ignored paths", form.ignoredPaths)}
        ${renderTextarea("settings.ignoredAuthors", "Ignored authors", form.ignoredAuthors)}
        ${renderTextarea("settings.ignoredLabels", "Ignored labels", form.ignoredLabels)}
      </div>
      <label>
        <span>Custom instructions</span>
        <textarea
          data-field="settings.customInstructions"
          rows="8"
        >${escapeHtml(form.customInstructions)}</textarea>
      </label>
      ${renderRepositoryRules(rules)}
    </section>
  `;
}

/** Renders repository rules that affect the loaded repository. */
function renderRepositoryRules(rules: readonly AdminRepoRuleSummary[]): string {
  return `
    <section class="settings-subsection">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Rules</p>
          <h3>Effective Rules</h3>
        </div>
        <span class="status muted">${rules.length} rule${rules.length === 1 ? "" : "s"}</span>
      </div>
      ${
        rules.length === 0
          ? `<p class="inline-empty">No repository or organization rules found.</p>`
          : renderRepositoryRuleRows(rules)
      }
    </section>
  `;
}

/** Renders repository rule rows. */
function renderRepositoryRuleRows(rules: readonly AdminRepoRuleSummary[]): string {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>State</th><th>Scope</th><th>Type</th><th>Body</th><th>Updated</th></tr>
        </thead>
        <tbody>
          ${rules
            .map(
              (rule) => `
                <tr>
                  <td>
                    <span class="status ${rule.isEnabled ? "ok" : "muted"}">
                      ${rule.isEnabled ? "enabled" : "disabled"}
                    </span>
                  </td>
                  <td>${escapeHtml(rule.repoId ? "repository" : "organization")}</td>
                  <td>${escapeHtml(`${rule.scope}:${rule.ruleType}`)}</td>
                  <td>${escapeHtml(rule.body)}</td>
                  <td>${formatTime(rule.updatedAt)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

/** Renders an audit history search view. */
function renderAuditView(): string {
  const audit = state.audit;
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">History</p>
          <h2>Audit Events</h2>
        </div>
        <button class="primary" data-action="load-audit" type="button">Search</button>
      </section>
      ${audit.loading ? `<p class="notice">${escapeHtml(audit.loading)}</p>` : ""}
      ${audit.error ? `<p class="error-line">${escapeHtml(audit.error)}</p>` : ""}
      <section class="panel">
        <div class="form-grid">
          ${renderTextInput("audit.orgId", "Organization ID", audit.orgId, "org_...")}
          ${renderTextInput("audit.search", "Search", audit.search, "request, actor, action")}
          ${renderTextInput("audit.action", "Action", audit.action, "repo.settings.updated")}
          ${renderTextInput("audit.resourceType", "Resource type", audit.resourceType, "repository")}
          ${renderTextInput("audit.resourceId", "Resource ID", audit.resourceId, "repo_...")}
          ${renderTextInput("audit.actorUserId", "Actor", audit.actorUserId, "oidc:...")}
        </div>
      </section>
      ${renderAuditRows(audit.rows)}
    </main>
  `;
}

/** Renders audit result rows. */
function renderAuditRows(rows: readonly AdminAuditLogSummary[]): string {
  if (rows.length === 0) {
    return renderEmptyState();
  }

  return `
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Request</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <td>${formatTime(row.occurredAt)}</td>
                    <td>${escapeHtml(row.actorUserId ?? row.actorType)}</td>
                    <td>${escapeHtml(row.action)}</td>
                    <td>${escapeHtml(row.resourceId ?? row.resourceType)}</td>
                    <td><code>${escapeHtml(requestIdFromMetadata(row.metadata) ?? "n/a")}</code></td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders one inspector tab. */
function renderTab(config: InspectorConfig): string {
  const active = state.activeKind === config.kind;
  return `
    <button class="tab ${active ? "active" : ""}" data-tab="${config.kind}" type="button">
      ${escapeHtml(config.label)}
    </button>
  `;
}

/** Renders the active inspector. */
function renderInspector(): string {
  const config = inspectorConfigs[state.activeKind];
  const inspector = currentInspectorState();
  return `
    <main class="inspector">
      <section class="inspector-header">
        <div>
          <p class="eyebrow">${escapeHtml(config.label)}</p>
          <h2>${escapeHtml(config.title)}</h2>
        </div>
        <div class="resource-controls">
          <label>
            <span>${escapeHtml(config.idLabel)}</span>
            <input
              data-field="resource-id"
              placeholder="${escapeAttribute(config.placeholder)}"
              value="${escapeAttribute(inspector.id)}"
            />
          </label>
          <button data-action="load-details" type="button">Load</button>
          <button data-action="create-plan" type="button">Plan replay</button>
        </div>
      </section>
      ${renderInspectorNotice(inspector)}
      ${inspector.details ? renderDetails(inspector.details) : renderEmptyState()}
      ${inspector.plan ? renderReplayPlan(inspector.plan) : ""}
      ${inspector.result ? renderReplayResult(inspector.result) : ""}
    </main>
  `;
}

/** Renders current loading or error state for an inspector. */
function renderInspectorNotice(inspector: InspectorViewState): string {
  if (inspector.loading) {
    return `<p class="notice">${escapeHtml(inspector.loading)}</p>`;
  }
  if (inspector.error) {
    return `<p class="error-line">${escapeHtml(inspector.error)}</p>`;
  }

  return "";
}

/** Renders the empty inspector state. */
function renderEmptyState(message = "No inspector data loaded."): string {
  return `
    <section class="empty-state">
      <div class="empty-mark"></div>
      <p>${escapeHtml(message)}</p>
    </section>
  `;
}

/** Renders debug details for any inspector. */
function renderDetails(details: InspectorDetails): string {
  if (isWebhookDetails(details)) {
    return renderWebhookDetails(details);
  }
  if (isReviewDetails(details)) {
    return renderReviewDetails(details);
  }

  return renderPublisherDetails(details);
}

/** Renders webhook debug details. */
function renderWebhookDetails(details: AdminWebhookDebugDetails): string {
  const event = details.webhookEvent;
  return `
    <section class="summary-grid">
      ${renderMetric("Status", event.status)}
      ${renderMetric("Event", `${event.eventName}${event.action ? `:${event.action}` : ""}`)}
      ${renderMetric("Expected jobs", String(details.expectedJobKeys.length))}
      ${renderMetric("Failures", String(details.failures.length), details.failures.length > 0)}
    </section>
    ${renderKeyList("Expected job keys", details.expectedJobKeys)}
    ${renderFailures(details.failures)}
    ${renderJobs(details.relatedJobs)}
    ${renderAudits(details.replayAudits)}
  `;
}

/** Renders review debug details. */
function renderReviewDetails(details: AdminReviewDebugDetails): string {
  const run = details.reviewRun;
  return `
    <section class="summary-grid">
      ${renderMetric("Status", run.status)}
      ${renderMetric("Pull request", `#${run.pullRequestNumber}`)}
      ${renderMetric("Candidates", String(details.candidateFindings.length))}
      ${renderMetric("Validated", String(details.validatedFindings.length))}
      ${renderMetric("Failures", String(details.failures.length), details.failures.length > 0)}
    </section>
    <section class="split">
      ${renderTimeline(details.stageEvents)}
      ${renderSnapshot(details)}
    </section>
    ${renderCandidateFindings(details.candidateFindings)}
    ${renderValidatedFindings(details.validatedFindings)}
    ${renderReviewArtifacts(details.artifacts ?? [])}
    ${renderReviewDependencies(details.dependencies ?? [])}
    ${renderLlmCalls(details.llmCalls ?? [])}
    ${renderFailures(details.failures)}
    ${renderJobs(details.relatedJobs)}
    ${renderAudits(details.replayAudits)}
  `;
}

/** Renders publisher debug details. */
function renderPublisherDetails(details: AdminPublisherDebugDetails): string {
  const outputCount =
    details.outputs.checkRuns.length +
    details.outputs.reviews.length +
    details.outputs.summaryComments.length +
    details.outputs.findings.length;
  return `
    <section class="summary-grid">
      ${renderMetric("Publish runs", String(details.publishRuns.length))}
      ${renderMetric("Operations", String(details.operations.length))}
      ${renderMetric("Outputs", String(outputCount))}
      ${renderMetric(
        "Reconciliation issues",
        String(details.reconciliation.issues.length),
        details.reconciliation.issues.length > 0,
      )}
      ${renderMetric("Failures", String(details.failures.length), details.failures.length > 0)}
    </section>
    ${renderReconciliation(details.reconciliation)}
    ${renderFailures(details.failures)}
    ${renderJobs(details.relatedJobs)}
    ${renderAudits(details.replayAudits)}
  `;
}

/** Renders one dashboard metric. */
function renderMetric(label: string, value: string, alert = false): string {
  return `
    <article class="metric ${alert ? "alert" : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

/** Renders a list of opaque keys. */
function renderKeyList(title: string, values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>${escapeHtml(title)}</h3>
      <div class="key-list">
        ${values.map((value) => `<code>${escapeHtml(value)}</code>`).join("")}
      </div>
    </section>
  `;
}

/** Renders review stage events as a timeline. */
function renderTimeline(events: AdminReviewDebugDetails["stageEvents"]): string {
  return `
    <section class="panel">
      <h3>Stage timeline</h3>
      <ol class="timeline">
        ${events
          .map(
            (event) => `
              <li>
                <span class="dot ${event.status === "failed" ? "failed" : ""}"></span>
                <strong>${escapeHtml(event.stage)}</strong>
                <span>${escapeHtml(event.status)}</span>
                <time>${formatTime(event.occurredAt)}</time>
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

/** Renders pull request snapshot metadata for a review run. */
function renderSnapshot(details: AdminReviewDebugDetails): string {
  if (!details.snapshot) {
    return `
      <section class="panel">
        <h3>Snapshot</h3>
        <p class="muted-text">No snapshot row found.</p>
      </section>
    `;
  }

  const snapshot = details.snapshot;
  return `
    <section class="panel">
      <h3>Snapshot</h3>
      <dl class="data-list">
        <div><dt>Head</dt><dd>${escapeHtml(snapshot.headSha)}</dd></div>
        <div><dt>Base</dt><dd>${escapeHtml(snapshot.baseSha)}</dd></div>
        <div><dt>Files</dt><dd>${snapshot.changedFileCount}</dd></div>
        <div><dt>Diff hash</dt><dd>${escapeHtml(snapshot.diffHash)}</dd></div>
      </dl>
    </section>
  `;
}

/** Renders candidate finding summaries for a review. */
function renderCandidateFindings(findings: readonly AdminCandidateFindingSummary[]): string {
  if (findings.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Candidate Findings</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Finding</th><th>Severity</th><th>Source</th><th>Location</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            ${findings
              .map(
                (finding) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(finding.title)}</strong>
                      <p class="muted-text"><code>${escapeHtml(finding.findingId)}</code></p>
                    </td>
                    <td>${escapeHtml(finding.severity)}</td>
                    <td>${escapeHtml(`${finding.source}:${finding.sourceName}`)}</td>
                    <td>${escapeHtml(locationLabel(finding.location))}</td>
                    <td>${Math.round(finding.confidence * 100)}%</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders validated finding summaries for a review. */
function renderValidatedFindings(findings: readonly AdminValidatedFindingSummary[]): string {
  if (findings.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Validated Findings</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Finding</th><th>Decision</th><th>Severity</th><th>Location</th><th>Validation</th></tr>
          </thead>
          <tbody>
            ${findings
              .map(
                (finding) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(finding.title)}</strong>
                      <p class="muted-text"><code>${escapeHtml(finding.findingId)}</code></p>
                    </td>
                    <td><span class="status ${finding.decision === "publish" ? "ok" : "muted"}">${escapeHtml(finding.decision)}</span></td>
                    <td>${escapeHtml(finding.severity)}</td>
                    <td>${escapeHtml(locationLabel(finding.location))}</td>
                    <td>${escapeHtml(validationReasons(finding.validation))}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders review artifact summaries. */
function renderReviewArtifacts(artifacts: readonly AdminReviewArtifactSummary[]): string {
  if (artifacts.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Artifacts</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Kind</th><th>Size</th><th>URI</th><th>Created</th></tr>
          </thead>
          <tbody>
            ${artifacts
              .map(
                (artifact) => `
                  <tr>
                    <td>${escapeHtml(artifact.name)}</td>
                    <td>${escapeHtml(artifact.kind)}</td>
                    <td>${formatBytes(artifact.sizeBytes)}</td>
                    <td><code>${escapeHtml(artifact.uri)}</code></td>
                    <td>${formatTime(artifact.createdAt)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders durable dependencies attached to a review. */
function renderReviewDependencies(dependencies: readonly AdminReviewDependencySummary[]): string {
  if (dependencies.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Dependencies</h3>
      <div class="key-list">
        ${dependencies
          .map(
            (dependency) =>
              `<code>${escapeHtml(`${dependency.dependencyType}:${dependency.dependencyId}`)}</code>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

/** Renders LLM call summaries linked to a review. */
function renderLlmCalls(calls: readonly AdminLlmCallSummary[]): string {
  if (calls.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Model Calls</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Purpose</th><th>Model</th><th>Tokens</th><th>Cost</th></tr>
          </thead>
          <tbody>
            ${calls
              .map(
                (call) => `
                  <tr>
                    <td><span class="status ${statusClass(call.status)}">${escapeHtml(call.status)}</span></td>
                    <td>${escapeHtml(call.purpose)}</td>
                    <td>${escapeHtml(`${call.provider}/${call.model}`)}</td>
                    <td>${call.inputTokens + call.outputTokens}</td>
                    <td>${formatMicros(call.costMicros)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders publisher reconciliation state. */
function renderReconciliation(
  reconciliation: AdminPublisherDebugDetails["reconciliation"],
): string {
  return `
    <section class="panel">
      <h3>Reconciliation</h3>
      <dl class="data-list compact">
        <div><dt>Status</dt><dd>${escapeHtml(reconciliation.status)}</dd></div>
        <div><dt>Check runs</dt><dd>${reconciliation.checkRunCount}</dd></div>
        <div><dt>Reviews</dt><dd>${reconciliation.reviewCount}</dd></div>
        <div><dt>Summary comments</dt><dd>${reconciliation.summaryCommentCount}</dd></div>
        <div><dt>Published findings</dt><dd>${reconciliation.publishedFindingCount}</dd></div>
      </dl>
      ${renderIssueList(reconciliation.issues)}
    </section>
  `;
}

/** Renders replay plan details. */
function renderReplayPlan(plan: InspectorReplayPlan): string {
  const inspector = currentInspectorState();
  return `
    <section class="replay-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Replay Plan</p>
          <h3>${escapeHtml(plan.action)}</h3>
        </div>
        <span class="status warn">Confirmation required</span>
      </div>
      ${renderPlanDiff(plan)}
      <div class="confirmation">
        <label>
          <span>Confirmation token</span>
          <code>${escapeHtml(plan.confirmationToken)}</code>
        </label>
        <label>
          <span>Type token to dispatch</span>
          <input
            data-field="confirmation-token"
            value="${escapeAttribute(inspector.confirmationTokenInput)}"
          />
        </label>
        <button
          class="danger"
          data-action="execute-replay"
          ${state.session?.capabilities.canExecuteReplay ? "" : "disabled"}
          type="button"
        >
          Dispatch replay
        </button>
      </div>
    </section>
  `;
}

/** Renders the current-state versus replay-plan comparison. */
function renderPlanDiff(plan: InspectorReplayPlan): string {
  if (isWebhookReplayPlan(plan)) {
    return `
      <section class="diff-grid">
        ${renderDiffColumn("Blocked jobs", plan.blockedJobIds)}
        ${renderDiffColumn("Missing jobs", plan.missingJobKeys)}
        ${renderDiffColumn(
          "Replay jobs",
          plan.jobs.map((job) => `${job.queueName} / ${job.jobType} / ${job.replayJobKey}`),
        )}
      </section>
      ${renderFailures(plan.failures)}
    `;
  }

  if (isReviewReplayPlan(plan)) {
    return `
      <section class="diff-grid">
        ${renderDiffColumn("Current status", [plan.currentStatus])}
        ${renderDiffColumn(
          "Related jobs",
          plan.relatedJobs.map((job) => job.backgroundJobId),
        )}
        ${renderDiffColumn("Replay jobs", [plan.job.replayJobKey])}
      </section>
      ${renderFailures(plan.failures)}
      ${renderJsonBlock("Payload", plan.payload)}
    `;
  }

  return `
    <section class="diff-grid">
      ${renderDiffColumn("Durable state", [
        plan.reconciliation.status,
        ...plan.reconciliation.issues.map((issue) => issue.code),
      ])}
      ${renderDiffColumn("Dry run", [
        `${plan.dryRun.findingCount} finding(s)`,
        `${plan.dryRun.comments.inlineCommentCount} inline comment(s)`,
        `${plan.dryRun.comments.summaryFallbackCount} summary fallback(s)`,
      ])}
      ${renderDiffColumn("Replay jobs", [plan.job.replayJobKey])}
    </section>
    ${renderIssueList(plan.reconciliation.issues)}
    ${renderJsonBlock("Payload", plan.payload)}
  `;
}

/** Renders one diff column for replay planning. */
function renderDiffColumn(title: string, values: readonly string[]): string {
  return `
    <article class="diff-column">
      <h4>${escapeHtml(title)}</h4>
      ${
        values.length === 0
          ? `<p class="muted-text">None</p>`
          : `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
      }
    </article>
  `;
}

/** Renders replay execution output. */
function renderReplayResult(result: AdminReplayExecutionResult): string {
  return `
    <section class="panel result-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Replay Result</p>
          <h3>${escapeHtml(result.action)}</h3>
        </div>
        ${result.auditLogId ? `<span class="status ok">${escapeHtml(result.auditLogId)}</span>` : ""}
      </div>
      <section class="diff-grid">
        ${renderDiffColumn("Inserted job IDs", result.insertedJobIds)}
        ${renderDiffColumn("Existing job IDs", result.existingJobIds)}
        ${renderDiffColumn(
          "Final replay jobs",
          result.replayJobs.map((job) => `${job.status} / ${job.backgroundJobId}`),
        )}
      </section>
    </section>
  `;
}

/** Renders structured failures. */
function renderFailures(failures: readonly AdminFailureDetail[]): string {
  if (failures.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Failures</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Source</th><th>Code</th><th>Message</th><th>Retryable</th></tr>
          </thead>
          <tbody>
            ${failures
              .map(
                (failure) => `
                  <tr>
                    <td>${escapeHtml(failure.source)}</td>
                    <td><code>${escapeHtml(failure.code)}</code></td>
                    <td>${escapeHtml(failure.message)}</td>
                    <td>${failure.retryable === undefined ? "" : String(failure.retryable)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders durable background jobs. */
function renderJobs(jobs: readonly AdminBackgroundJobDebugSummary[]): string {
  if (jobs.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Durable jobs</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Queue</th><th>Type</th><th>Job ID</th><th>Key</th></tr>
          </thead>
          <tbody>
            ${jobs.map(renderJobRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders one durable job row. */
function renderJobRow(job: AdminBackgroundJobDebugSummary): string {
  return `
    <tr>
      <td><span class="status ${statusClass(job.status)}">${escapeHtml(job.status)}</span></td>
      <td>${escapeHtml(job.queueName)}</td>
      <td>${escapeHtml(job.jobType)}</td>
      <td><code>${escapeHtml(job.backgroundJobId)}</code></td>
      <td><code>${escapeHtml(job.jobKey)}</code></td>
    </tr>
  `;
}

/** Renders replay audit rows. */
function renderAudits(audits: readonly AdminReplayAuditSummary[]): string {
  if (audits.length === 0) {
    return "";
  }

  return `
    <section class="panel">
      <h3>Replay audit</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>Actor</th><th>Action</th><th>Inserted jobs</th></tr>
          </thead>
          <tbody>
            ${audits
              .map(
                (audit) => `
                  <tr>
                    <td>${formatTime(audit.occurredAt)}</td>
                    <td>${escapeHtml(audit.actorUserId ?? audit.actorType)}</td>
                    <td>${escapeHtml(audit.action)}</td>
                    <td>${escapeHtml(insertedJobSummary(audit.metadata))}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/** Renders reconciliation issue rows. */
function renderIssueList(
  issues: readonly AdminPublisherDebugDetails["reconciliation"]["issues"][number][],
): string {
  if (issues.length === 0) {
    return `<p class="muted-text">No reconciliation issues.</p>`;
  }

  return `
    <ul class="issue-list">
      ${issues
        .map(
          (issue) => `
            <li>
              <code>${escapeHtml(issue.code)}</code>
              <span>${escapeHtml(issue.message)}</span>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

/** Renders an inspectable JSON block. */
function renderJsonBlock(title: string, value: unknown): string {
  return `
    <section class="panel">
      <h3>${escapeHtml(title)}</h3>
      <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
    </section>
  `;
}

/** Renders a text input for forms. */
function renderTextInput(field: string, label: string, value: string, placeholder: string): string {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input
        data-field="${escapeAttribute(field)}"
        placeholder="${escapeAttribute(placeholder)}"
        value="${escapeAttribute(value)}"
      />
    </label>
  `;
}

/** Renders a checkbox control. */
function renderCheckbox(field: string, label: string, checked: boolean): string {
  return `
    <label class="check-field">
      <input data-field="${escapeAttribute(field)}" type="checkbox" ${checked ? "checked" : ""} />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

/** Renders a select control. */
function renderSelect(
  field: string,
  label: string,
  value: string,
  options: readonly string[],
): string {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-field="${escapeAttribute(field)}">
        ${options
          .map(
            (option) => `
              <option value="${escapeAttribute(option)}" ${option === value ? "selected" : ""}>
                ${escapeHtml(option)}
              </option>
            `,
          )
          .join("")}
      </select>
    </label>
  `;
}

/** Renders a textarea control. */
function renderTextarea(field: string, label: string, value: string): string {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <textarea data-field="${escapeAttribute(field)}" rows="7">${escapeHtml(value)}</textarea>
    </label>
  `;
}

/** Returns the active inspector state. */
function currentInspectorState(): InspectorViewState {
  return state.inspectors[state.activeKind];
}

/** Updates one overview filter field. */
function updateOverviewField(field: string, value: string): void {
  if (field in state.overview) {
    (
      state.overview as Record<
        string,
        | string
        | readonly AdminRepositorySummary[]
        | readonly AdminReviewRunSummary[]
        | readonly AdminAuditLogSummary[]
        | undefined
      >
    )[field] = value;
  }
}

/** Updates one settings form field from an input element. */
function updateSettingsFormField(
  field: string,
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  const form = state.settings.form;
  if (!form) {
    return;
  }

  if (field === "repositoryEnabled" && target instanceof HTMLInputElement) {
    form.repositoryEnabled = target.checked;
    return;
  }
  if (field === "skipGeneratedFiles" && target instanceof HTMLInputElement) {
    form.skipGeneratedFiles = target.checked;
    return;
  }
  if (field === "skipDraftPullRequests" && target instanceof HTMLInputElement) {
    form.skipDraftPullRequests = target.checked;
    return;
  }

  if (field in form) {
    (form as Record<string, string | boolean>)[field] = target.value;
  }
}

/** Updates one audit filter field. */
function updateAuditField(field: string, value: string): void {
  if (field in state.audit) {
    (state.audit as Record<string, string | readonly AdminAuditLogSummary[] | undefined>)[field] =
      value;
  }
}

/** Converts a loaded settings payload into editable form state. */
function settingsFormFromResponse(data: ControlPlaneSettingsResponse): SettingsFormState {
  return {
    repositoryEnabled: data.repository.enabled,
    reviewPolicy: data.settings.reviewPolicy,
    severityThreshold: data.settings.severityThreshold,
    maxCommentsPerReview: String(data.settings.maxCommentsPerReview),
    ignoredPaths: data.settings.ignoredPaths.join("\n"),
    ignoredAuthors: data.settings.ignoredAuthors.join("\n"),
    ignoredLabels: data.settings.ignoredLabels.join("\n"),
    requireLabel: data.settings.requireLabel ?? "",
    skipGeneratedFiles: data.settings.skipGeneratedFiles,
    skipDraftPullRequests: data.settings.skipDraftPullRequests,
    customInstructions: data.settings.customInstructions ?? "",
  };
}

/** Converts the settings form into an API patch payload. */
function settingsPatchFromForm(form: SettingsFormState): Record<string, unknown> {
  return {
    repositoryEnabled: form.repositoryEnabled,
    reviewPolicy: form.reviewPolicy,
    severityThreshold: form.severityThreshold,
    maxCommentsPerReview: boundedNumber(form.maxCommentsPerReview, 0, 50),
    ignoredPaths: linesFromText(form.ignoredPaths),
    ignoredAuthors: linesFromText(form.ignoredAuthors),
    ignoredLabels: linesFromText(form.ignoredLabels),
    requireLabel: form.requireLabel.trim(),
    skipGeneratedFiles: form.skipGeneratedFiles,
    skipDraftPullRequests: form.skipDraftPullRequests,
    customInstructions: form.customInstructions.trim(),
  };
}

/** Parses non-empty lines from textarea input. */
function linesFromText(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parses a bounded integer. */
function boundedNumber(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

/** Appends a non-empty query parameter. */
function appendQueryParam(params: URLSearchParams, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    params.set(key, trimmed);
  }
}

/** Reads a required data attribute from a delegated action element. */
function requiredDatasetValue(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (!value) {
    throw new Error(`Missing data-${key} for dashboard action.`);
  }

  return value;
}

/** Returns whether a request method is safe from CSRF. */
function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** Reads the audit request ID from metadata. */
function requestIdFromMetadata(metadata: unknown): string | undefined {
  const record = asRecord(metadata);
  const requestId = record?.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

/** Returns a CSS class for a durable status. */
function statusClass(status: string): string {
  if (["completed", "processed", "published"].includes(status)) {
    return "ok";
  }
  if (["failed", "dead_lettered"].includes(status)) {
    return "bad";
  }
  if (["pending", "running", "received"].includes(status)) {
    return "warn";
  }

  return "muted";
}

/** Returns a compact inserted-job summary from audit metadata. */
function insertedJobSummary(metadata: unknown): string {
  const result = asRecord(asRecord(metadata)?.result);
  const insertedJobIds = result?.insertedJobIds;
  if (!Array.isArray(insertedJobIds)) {
    return "";
  }

  return insertedJobIds.filter((value): value is string => typeof value === "string").join(", ");
}

/** Returns a compact finding location label from an unknown location payload. */
function locationLabel(location: unknown): string {
  const record = asRecord(location);
  const path = typeof record?.path === "string" ? record.path : "unknown path";
  const line = typeof record?.line === "number" ? record.line : undefined;
  return line ? `${path}:${line}` : path;
}

/** Returns validation reason text from an unknown validation payload. */
function validationReasons(validation: unknown): string {
  const reasons = asRecord(validation)?.reasons;
  if (!Array.isArray(reasons)) {
    return "";
  }

  return reasons.filter((reason): reason is string => typeof reason === "string").join(", ");
}

/** Formats a byte count for compact tables. */
function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats micro currency units for compact tables. */
function formatMicros(value: number): string {
  return `$${(value / 1_000_000).toFixed(4)}`;
}

/** Formats an ISO timestamp for dashboard display. */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Formats a commit SHA for compact tables. */
function formatSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

/** Returns the message for an unknown error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected admin console error.";
}

/** Escapes text content before injecting it into HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Escapes input attributes before injecting them into HTML. */
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

/** Returns object values with stable typing. */
function objectValues<T extends Record<string, unknown>>(value: T): T[keyof T][] {
  return Object.values(value) as T[keyof T][];
}

/** Narrows a string to an inspector kind. */
function isInspectorKind(value: string): value is InspectorKind {
  return value === "webhook" || value === "review" || value === "publisher";
}

/** Narrows a string to a primary view kind. */
function isViewKind(value: string): value is ViewKind {
  return (
    value === "overview" || value === "inspectors" || value === "settings" || value === "audit"
  );
}

/** Narrows unknown values to object records. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a string field from an unknown object record. */
function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Narrows inspector details to webhook details. */
function isWebhookDetails(details: InspectorDetails): details is AdminWebhookDebugDetails {
  return "webhookEvent" in details;
}

/** Narrows inspector details to review details. */
function isReviewDetails(details: InspectorDetails): details is AdminReviewDebugDetails {
  return "reviewRun" in details;
}

/** Narrows replay plans to webhook replay plans. */
function isWebhookReplayPlan(plan: InspectorReplayPlan): plan is WebhookReplayPlan {
  return plan.action === "webhook.requeue_jobs";
}

/** Narrows replay plans to review replay plans. */
function isReviewReplayPlan(plan: InspectorReplayPlan): plan is ReviewReplayPlan {
  return plan.action === "review.requeue";
}
