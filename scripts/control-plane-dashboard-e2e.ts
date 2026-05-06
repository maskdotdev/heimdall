import { Buffer } from "node:buffer";
import {
  type AdminIdentityRequestHeaders,
  readGatewayIdentityAssertion,
} from "./admin-smoke-identity";

/** Dashboard gate environment. */
type DashboardGateEnvironment = {
  /** Deployed dashboard URL. */
  readonly webUrl: string;
  /** Deployed API URL. */
  readonly apiUrl: string;
  /** Browser-level Chrome DevTools Protocol WebSocket endpoint. */
  readonly browserWsEndpoint: string;
  /** Organization scope used by settings and audit checks. */
  readonly orgId: string;
  /** Repository ID used by the settings drill. */
  readonly repoId: string;
  /** Replay inspector kind used by the replay drill. */
  readonly replayKind: ReplayKind;
  /** Replay resource ID used by the replay drill. */
  readonly replayId: string;
  /** Provider subject requested from the identity gateway. */
  readonly providerSubject: string;
  /** Whether the script may write repository settings. */
  readonly allowSettingsWrite: boolean;
  /** Whether the script may dispatch a replay. */
  readonly allowReplayWrite: boolean;
};

/** Replay inspectors supported by the dashboard drill. */
type ReplayKind = "webhook" | "review" | "publisher";

/** Minimal API envelope returned by admin routes. */
type ApiEnvelope<T> = {
  /** Response payload. */
  readonly data: T;
};

/** Session payload returned by the admin API. */
type DashboardSession = {
  /** Session-bound CSRF token. */
  readonly csrfToken: string;
  /** Authenticated actor summary. */
  readonly actor: {
    /** Identity provider family. */
    readonly provider?: string | undefined;
    /** Provider-backed actor ID. */
    readonly userId: string;
  };
  /** Granted actor scopes. */
  readonly scopes?: {
    /** Organization scope IDs. */
    readonly orgIds?: readonly string[] | undefined;
    /** Repository scope IDs. */
    readonly repoIds?: readonly string[] | undefined;
  };
  /** Dashboard capability flags. */
  readonly capabilities: {
    /** Whether the actor can inspect admin state. */
    readonly canInspect: boolean;
    /** Whether the actor can plan replay. */
    readonly canPlanReplay: boolean;
    /** Whether the actor can execute replay. */
    readonly canExecuteReplay: boolean;
    /** Whether the actor can manage repository settings. */
    readonly canManageSettings: boolean;
    /** Whether the actor can search audit history. */
    readonly canViewAuditHistory: boolean;
  };
};

/** Login response used to seed the browser with a secure session cookie. */
type LoginResult = {
  /** Cookie header value returned by the API. */
  readonly cookie: string;
  /** Authenticated session payload. */
  readonly session: DashboardSession;
};

/** Browser page attached through Chrome DevTools Protocol. */
type BrowserPage = {
  /** Chrome target ID for the page. */
  readonly targetId: string;
  /** Flattened CDP session ID for the page. */
  readonly sessionId: string;
};

/** Pending Chrome DevTools Protocol command. */
type PendingCdpCall = {
  /** Resolves the command with its result. */
  readonly resolve: (value: unknown) => void;
  /** Rejects the command with an error. */
  readonly reject: (reason: Error) => void;
};

/** Chrome DevTools Protocol response envelope. */
type CdpMessage = {
  /** Command ID for response messages. */
  readonly id?: unknown;
  /** Successful command result. */
  readonly result?: unknown;
  /** Failed command result. */
  readonly error?: {
    /** CDP error code. */
    readonly code?: unknown;
    /** CDP error message. */
    readonly message?: unknown;
  };
};

/** Result returned by Target.createTarget. */
type TargetCreateTargetResult = {
  /** Created target ID. */
  readonly targetId?: unknown;
};

/** Result returned by Target.attachToTarget. */
type TargetAttachToTargetResult = {
  /** Attached session ID. */
  readonly sessionId?: unknown;
};

/** Runtime.evaluate result payload. */
type RuntimeEvaluateResult = {
  /** JavaScript evaluation result. */
  readonly result?: {
    /** JSON-serializable value returned by the expression. */
    readonly value?: unknown;
    /** Fallback description for non-serializable values. */
    readonly description?: unknown;
  };
  /** Exception details when the expression throws. */
  readonly exceptionDetails?: {
    /** Exception summary text. */
    readonly text?: unknown;
    /** Exception object details. */
    readonly exception?: {
      /** Exception description. */
      readonly description?: unknown;
    };
  };
};

/** Result returned by Network.setCookie. */
type NetworkSetCookieResult = {
  /** Whether Chrome accepted the cookie. */
  readonly success?: unknown;
};

/** Parsed cookie pair from a Set-Cookie header. */
type ParsedCookie = {
  /** Cookie name. */
  readonly name: string;
  /** Cookie value. */
  readonly value: string;
};

/** Minimal audit row returned by admin audit search. */
type DashboardAuditLog = {
  /** Audit log ID recorded by the API. */
  readonly auditLogId: string;
  /** Audit action. */
  readonly action: string;
};

/** Minimal CDP client backed by a browser WebSocket. */
class CdpClient {
  /** Underlying browser WebSocket. */
  private readonly socket: WebSocket;
  /** Incrementing CDP command ID. */
  private nextId = 1;
  /** Pending command resolvers keyed by command ID. */
  private readonly pending = new Map<number, PendingCdpCall>();

  /** Creates a CDP client for an already constructed WebSocket. */
  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => this.rejectPending("CDP browser socket closed."));
    this.socket.addEventListener("error", () => this.rejectPending("CDP browser socket errored."));
  }

  /** Opens a browser-level CDP connection. */
  public static async connect(endpoint: string): Promise<CdpClient> {
    const socket = new WebSocket(endpoint);
    const client = new CdpClient(socket);
    await waitForSocketOpen(socket, endpoint);
    return client;
  }

  /** Sends a CDP command and returns its result. */
  public call<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.send(JSON.stringify(payload));
    });
  }

  /** Closes the browser WebSocket. */
  public close(): void {
    this.rejectPending("CDP browser socket closed by dashboard E2E.");
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  /** Handles one CDP message. */
  private handleMessage(data: unknown): void {
    const message = JSON.parse(messageDataToString(data)) as CdpMessage;
    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(cdpErrorMessage(message.error)));
      return;
    }

    pending.resolve(message.result);
  }

  /** Rejects all pending commands. */
  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

/** Runs the deployed dashboard E2E drill. */
async function main(): Promise<void> {
  const env = readEnvironment();
  requireWriteAcknowledgements(env);
  const identity = await readGatewayIdentityAssertion({
    orgId: env.orgId,
    providerSubject: env.providerSubject,
    purpose: "control-plane-dashboard-e2e",
    repoId: env.repoId,
  });
  const login = await loginAdmin(env, identity.headers);
  assertSessionCapabilities(login.session);
  const loginAudit = await latestAuditLog(env, login.cookie, {
    action: "admin.session.created",
    actorUserId: login.session.actor.userId,
  });

  const browser = await CdpClient.connect(env.browserWsEndpoint);
  try {
    const page = await createBrowserPage(browser);
    await seedDashboardSession(browser, page, env, login.cookie);
    await runDashboardDrill(browser, page, env);
    const replayAudit = await latestAuditLog(env, login.cookie, {
      action: replayAuditAction(env.replayKind),
      actorUserId: login.session.actor.userId,
      resourceId: env.replayId,
    });
    const settingsAudit = await latestAuditLog(env, login.cookie, {
      action: "repo.settings.updated",
      actorUserId: login.session.actor.userId,
      resourceId: env.repoId,
    });
    await logoutDashboard(browser, page);
    const logoutAudit = await latestAuditLog(env, login.cookie, {
      action: "admin.session.revoked",
      actorUserId: login.session.actor.userId,
    });

    console.log(
      JSON.stringify(
        {
          actor: login.session.actor.userId,
          auditLogIds: {
            login: loginAudit.auditLogId,
            logout: logoutAudit.auditLogId,
            replay: replayAudit.auditLogId,
            settings: settingsAudit.auditLogId,
          },
          gatewayUrl: identity.source,
          orgIds: login.session.scopes?.orgIds ?? [env.orgId],
          provider: login.session.actor.provider,
          repoIds: login.session.scopes?.repoIds ?? [env.repoId],
          replay: {
            id: env.replayId,
            kind: env.replayKind,
          },
          status: "control-plane dashboard E2E passed",
        },
        null,
        2,
      ),
    );
  } finally {
    browser.close();
  }
}

/** Logs into the staging API with a gateway-issued identity assertion. */
async function loginAdmin(
  env: DashboardGateEnvironment,
  identityHeaders: AdminIdentityRequestHeaders,
): Promise<LoginResult> {
  const response = await fetch(new URL("/admin/auth/login", env.apiUrl), {
    method: "POST",
    headers: {
      ...identityHeaders,
      origin: new URL(env.webUrl).origin,
    },
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !cookie) {
    throw new Error(
      `Admin dashboard login failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }

  return { cookie, session: (body as ApiEnvelope<DashboardSession>).data };
}

/** Creates a new browser page and attaches a flattened CDP session. */
async function createBrowserPage(browser: CdpClient): Promise<BrowserPage> {
  const created = await browser.call<TargetCreateTargetResult>("Target.createTarget", {
    url: "about:blank",
  });
  const targetId = requiredString(created.targetId, "Target.createTarget targetId");
  const attached = await browser.call<TargetAttachToTargetResult>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const sessionId = requiredString(attached.sessionId, "Target.attachToTarget sessionId");

  await browser.call("Runtime.enable", {}, sessionId);
  await browser.call("Page.enable", {}, sessionId);
  await browser.call("Network.enable", {}, sessionId);
  return { targetId, sessionId };
}

/** Seeds the dashboard browser page with the API URL and authenticated API cookie. */
async function seedDashboardSession(
  browser: CdpClient,
  page: BrowserPage,
  env: DashboardGateEnvironment,
  cookieHeader: string,
): Promise<void> {
  const cookie = parseCookie(cookieHeader);
  const setCookieResult = await browser.call<NetworkSetCookieResult>(
    "Network.setCookie",
    {
      httpOnly: true,
      name: cookie.name,
      path: "/admin",
      sameSite: "None",
      secure: new URL(env.apiUrl).protocol === "https:",
      url: env.apiUrl,
      value: cookie.value,
    },
    page.sessionId,
  );
  if (setCookieResult.success !== true) {
    throw new Error("Chrome rejected the admin session cookie.");
  }

  await browser.call(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `sessionStorage.setItem("heimdall:admin-api-base-url", ${JSON.stringify(env.apiUrl)});`,
    },
    page.sessionId,
  );
  await browser.call("Page.navigate", { url: env.webUrl }, page.sessionId);
  await waitForSelector(browser, page, "#app .shell", 20_000);
}

/** Runs the dashboard UI workflows that prove session, CSRF, CORS, settings, replay, and audit. */
async function runDashboardDrill(
  browser: CdpClient,
  page: BrowserPage,
  env: DashboardGateEnvironment,
): Promise<void> {
  await clickSelector(browser, page, "[data-action='connect']");
  await waitForText(browser, page, "Active", 20_000);
  await assertNoDashboardErrors(browser, page);

  await runReplayDrill(browser, page, env);
  await runSettingsDrill(browser, page, env);
  await runAuditDrill(browser, page, env);
}

/** Logs out through the dashboard UI and verifies that the session state clears. */
async function logoutDashboard(browser: CdpClient, page: BrowserPage): Promise<void> {
  await clickSelector(browser, page, "[data-action='clear-auth']");
  await waitForText(browser, page, "No session cookie", 20_000);
}

/** Runs the replay inspector plan-and-dispatch workflow. */
async function runReplayDrill(
  browser: CdpClient,
  page: BrowserPage,
  env: DashboardGateEnvironment,
): Promise<void> {
  await clickSelector(browser, page, `[data-view='inspectors']`);
  await clickSelector(browser, page, `[data-tab='${env.replayKind}']`);
  await setInputValue(browser, page, "[data-field='resource-id']", env.replayId);
  await clickSelector(browser, page, "[data-action='load-details']");
  await waitForInspectorData(browser, page, 30_000);
  await assertNoDashboardErrors(browser, page);

  await clickSelector(browser, page, "[data-action='create-plan']");
  await waitForText(browser, page, "Confirmation required", 30_000);
  await assertNoDashboardErrors(browser, page);

  const confirmationToken = await readTextContent(browser, page, ".confirmation code");
  await setInputValue(browser, page, "[data-field='confirmation-token']", confirmationToken);
  await clickSelector(browser, page, "[data-action='execute-replay']");
  await waitForText(browser, page, "Replay Result", 30_000);
  await assertNoDashboardErrors(browser, page);
}

/** Runs the repository settings load-and-save workflow. */
async function runSettingsDrill(
  browser: CdpClient,
  page: BrowserPage,
  env: DashboardGateEnvironment,
): Promise<void> {
  await clickSelector(browser, page, "[data-view='settings']");
  await setInputValue(browser, page, "[data-field='settings-repo-id']", env.repoId);
  await clickSelector(browser, page, "[data-action='load-settings']");
  await waitForText(browser, page, "Automation", 30_000);
  await assertNoDashboardErrors(browser, page);

  await clickSelector(browser, page, "[data-action='save-settings']");
  await waitForText(browser, page, "Settings saved.", 30_000);
  await assertNoDashboardErrors(browser, page);
}

/** Runs the audit search workflow and verifies the settings mutation audit row. */
async function runAuditDrill(
  browser: CdpClient,
  page: BrowserPage,
  env: DashboardGateEnvironment,
): Promise<void> {
  await clickSelector(browser, page, "[data-view='audit']");
  await setInputValue(browser, page, "[data-field='audit.orgId']", env.orgId);
  await setInputValue(browser, page, "[data-field='audit.resourceId']", env.repoId);
  await setInputValue(browser, page, "[data-field='audit.action']", "repo.settings.updated");
  await clickSelector(browser, page, "[data-action='load-audit']");
  await waitForText(browser, page, "repo.settings.updated", 30_000);
  await assertNoDashboardErrors(browser, page);
}

/** Clicks one element in the browser page. */
async function clickSelector(
  browser: CdpClient,
  page: BrowserPage,
  selector: string,
): Promise<void> {
  await evaluate(
    browser,
    page,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) {
        throw new Error("Element not found or not clickable: ${escapeForJsMessage(selector)}");
      }
      element.click();
    })()`,
  );
}

/** Sets an input-like element value and dispatches an input event. */
async function setInputValue(
  browser: CdpClient,
  page: BrowserPage,
  selector: string,
  value: string,
): Promise<void> {
  await evaluate(
    browser,
    page,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (
        !(element instanceof HTMLInputElement) &&
        !(element instanceof HTMLTextAreaElement) &&
        !(element instanceof HTMLSelectElement)
      ) {
        throw new Error("Input element not found: ${escapeForJsMessage(selector)}");
      }
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event("input", { bubbles: true }));
    })()`,
  );
}

/** Waits until one selector exists. */
async function waitForSelector(
  browser: CdpClient,
  page: BrowserPage,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    browser,
    page,
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    `selector ${selector}`,
    timeoutMs,
  );
}

/** Waits until the document body includes text. */
async function waitForText(
  browser: CdpClient,
  page: BrowserPage,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const normalizedText = text.toLocaleLowerCase();
  await waitForCondition(
    browser,
    page,
    `document.body?.innerText.toLocaleLowerCase().includes(${JSON.stringify(normalizedText)}) === true`,
    `text ${text}`,
    timeoutMs,
  );
}

/** Waits until inspector details load or an error line appears. */
async function waitForInspectorData(
  browser: CdpClient,
  page: BrowserPage,
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    browser,
    page,
    `document.querySelector(".error-line") !== null || (
      document.body?.innerText.includes("Loading inspector") !== true &&
      document.body?.innerText.includes("No inspector data loaded.") !== true
    )`,
    "inspector data",
    timeoutMs,
  );
}

/** Waits for a browser-side JavaScript condition to become true. */
async function waitForCondition(
  browser: CdpClient,
  page: BrowserPage,
  condition: string,
  label: string,
  timeoutMs: number,
): Promise<void> {
  await evaluate(
    browser,
    page,
    `new Promise((resolve, reject) => {
      const deadline = Date.now() + ${timeoutMs};
      const check = () => {
        if (${condition}) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("Timed out waiting for ${escapeForJsMessage(label)}."));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    })`,
  );
}

/** Reads text content from one browser element. */
async function readTextContent(
  browser: CdpClient,
  page: BrowserPage,
  selector: string,
): Promise<string> {
  const value = await evaluate<string>(
    browser,
    page,
    `(() => {
      const text = document.querySelector(${JSON.stringify(selector)})?.textContent?.trim();
      if (!text) {
        throw new Error("Element text was missing: ${escapeForJsMessage(selector)}");
      }
      return text;
    })()`,
  );
  return value;
}

/** Fails if the dashboard rendered any error lines. */
async function assertNoDashboardErrors(browser: CdpClient, page: BrowserPage): Promise<void> {
  const errors = await evaluate<readonly string[]>(
    browser,
    page,
    `Array.from(document.querySelectorAll(".error-line"))
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => text.length > 0)`,
  );
  if (errors.length > 0) {
    throw new Error(`Dashboard rendered errors: ${errors.join("; ")}`);
  }
}

/** Returns the newest audit log for the actor/action in the smoke organization scope. */
async function latestAuditLog(
  env: DashboardGateEnvironment,
  cookie: string,
  filter: {
    /** Audit action filter. */
    readonly action: string;
    /** Actor user ID filter. */
    readonly actorUserId: string;
    /** Resource ID filter. */
    readonly resourceId?: string | undefined;
  },
): Promise<DashboardAuditLog> {
  const url = new URL("/admin/audit-logs", env.apiUrl);
  url.searchParams.set("action", filter.action);
  url.searchParams.set("actorUserId", filter.actorUserId);
  url.searchParams.set("limit", "1");
  url.searchParams.set("orgId", env.orgId);
  if (filter.resourceId) {
    url.searchParams.set("resourceId", filter.resourceId);
  }

  const response = await fetch(url, { headers: { cookie } });
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    throw new Error(`${url.pathname} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  const [auditLog] = (body as ApiEnvelope<{ readonly auditLogs: readonly DashboardAuditLog[] }>)
    .data.auditLogs;
  if (!auditLog) {
    throw new Error(`Audit log ${filter.action} was not found for ${filter.actorUserId}.`);
  }

  return auditLog;
}

/** Evaluates one JavaScript expression in the browser page. */
async function evaluate<T = unknown>(
  browser: CdpClient,
  page: BrowserPage,
  expression: string,
): Promise<T> {
  const result = await browser.call<RuntimeEvaluateResult>(
    "Runtime.evaluate",
    {
      awaitPromise: true,
      expression,
      returnByValue: true,
    },
    page.sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }

  return result.result?.value as T;
}

/** Validates that the logged-in actor can run every dashboard drill. */
function assertSessionCapabilities(session: DashboardSession): void {
  const missing = [
    ["admin.inspect", session.capabilities.canInspect],
    ["admin.replay.plan", session.capabilities.canPlanReplay],
    ["admin.replay.execute", session.capabilities.canExecuteReplay],
    ["admin.settings.manage", session.capabilities.canManageSettings],
    ["admin.audit.view", session.capabilities.canViewAuditHistory],
  ]
    .filter(([, enabled]) => enabled !== true)
    .map(([permission]) => permission);

  if (missing.length > 0) {
    throw new Error(`Dashboard E2E actor is missing permissions: ${missing.join(", ")}`);
  }
}

/** Requires explicit acknowledgement before mutating staging state. */
function requireWriteAcknowledgements(env: DashboardGateEnvironment): void {
  if (!env.allowSettingsWrite) {
    throw new Error("HEIMDALL_DASHBOARD_E2E_ALLOW_SETTINGS_WRITE=true is required.");
  }
  if (!env.allowReplayWrite) {
    throw new Error("HEIMDALL_DASHBOARD_E2E_ALLOW_REPLAY_WRITE=true is required.");
  }
}

/** Reads dashboard gate environment variables. */
function readEnvironment(): DashboardGateEnvironment {
  const env = requiredEnvironment([
    "API_URL",
    "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL",
    "HEIMDALL_ADMIN_SMOKE_ORG_ID",
    "HEIMDALL_ADMIN_SMOKE_REPO_ID",
    "HEIMDALL_DASHBOARD_E2E_BROWSER_WS",
    "HEIMDALL_DASHBOARD_E2E_REPLAY_ID",
    "HEIMDALL_DASHBOARD_E2E_REPLAY_KIND",
    "WEB_URL",
  ] as const);
  const allowLocalTarget = process.env.HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET === "true";
  assertNonLocalProofTarget("API_URL", env.API_URL, allowLocalTarget);
  assertNonLocalProofTarget(
    "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL",
    env.HEIMDALL_ADMIN_SMOKE_ASSERTION_URL,
    allowLocalTarget,
  );
  assertNonLocalProofTarget("WEB_URL", env.WEB_URL, allowLocalTarget);

  return {
    allowReplayWrite: process.env.HEIMDALL_DASHBOARD_E2E_ALLOW_REPLAY_WRITE === "true",
    allowSettingsWrite: process.env.HEIMDALL_DASHBOARD_E2E_ALLOW_SETTINGS_WRITE === "true",
    apiUrl: env.API_URL,
    browserWsEndpoint: env.HEIMDALL_DASHBOARD_E2E_BROWSER_WS,
    orgId: env.HEIMDALL_ADMIN_SMOKE_ORG_ID,
    providerSubject: process.env.HEIMDALL_ADMIN_SMOKE_PROVIDER_SUBJECT ?? "dashboard-e2e",
    repoId: env.HEIMDALL_ADMIN_SMOKE_REPO_ID,
    replayId: env.HEIMDALL_DASHBOARD_E2E_REPLAY_ID,
    replayKind: replayKindFromEnv(env.HEIMDALL_DASHBOARD_E2E_REPLAY_KIND),
    webUrl: env.WEB_URL,
  };
}

/** Parses a replay kind from an environment value. */
function replayKindFromEnv(value: string): ReplayKind {
  if (value === "webhook" || value === "review" || value === "publisher") {
    return value;
  }

  throw new Error("HEIMDALL_DASHBOARD_E2E_REPLAY_KIND must be webhook, review, or publisher.");
}

/** Returns the audit action produced by one replay inspector kind. */
function replayAuditAction(kind: ReplayKind): string {
  if (kind === "webhook") {
    return "webhook.requeue_jobs";
  }
  if (kind === "review") {
    return "review.requeue";
  }

  return "publish.review";
}

/** Reads required environment variables and reports all missing names at once. */
function requiredEnvironment<const Names extends readonly string[]>(
  names: Names,
): { readonly [Key in Names[number]]: string } {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}.`);
  }

  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""])) as {
    readonly [Key in Names[number]]: string;
  };
}

/** Ensures a staging proof target does not point at local development services. */
function assertNonLocalProofTarget(name: string, value: string, allowLocalTarget: boolean): void {
  if (allowLocalTarget) {
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (isLocalHostname(url.hostname)) {
    throw new Error(
      `${name} must point at a deployed staging target. Set HEIMDALL_ADMIN_SMOKE_ALLOW_LOCAL_TARGET=true only for local development smoke.`,
    );
  }
}

/** Returns whether a hostname targets local development infrastructure. */
function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "host.docker.internal" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127\./.test(normalized)
  );
}

/** Parses the first cookie pair from a Set-Cookie header. */
function parseCookie(header: string): ParsedCookie {
  const [pair] = header.split(";");
  const separatorIndex = pair?.indexOf("=") ?? -1;
  if (!pair || separatorIndex <= 0) {
    throw new Error(`Invalid Set-Cookie header: ${header}`);
  }

  return {
    name: pair.slice(0, separatorIndex),
    value: pair.slice(separatorIndex + 1),
  };
}

/** Waits for a browser WebSocket to open. */
function waitForSocketOpen(socket: WebSocket, endpoint: string): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out connecting to browser CDP endpoint ${endpoint}.`));
    }, 10_000);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to connect to browser CDP endpoint ${endpoint}.`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

/** Converts WebSocket message data to text. */
function messageDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  throw new Error(`Unsupported CDP message data: ${typeof data}`);
}

/** Returns a required string result from an unknown value. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was missing.`);
  }

  return value;
}

/** Converts a CDP error envelope to a message. */
function cdpErrorMessage(error: NonNullable<CdpMessage["error"]>): string {
  const code = typeof error.code === "number" ? ` ${error.code}` : "";
  const message = typeof error.message === "string" ? error.message : "Unknown CDP error";
  return `CDP error${code}: ${message}`;
}

/** Converts Runtime.evaluate exception details to a message. */
function runtimeExceptionMessage(
  details: NonNullable<RuntimeEvaluateResult["exceptionDetails"]>,
): string {
  const exception = details.exception?.description;
  if (typeof exception === "string" && exception.length > 0) {
    return exception;
  }
  return typeof details.text === "string" ? details.text : "Browser evaluation failed.";
}

/** Escapes a string for use inside an already quoted JavaScript error message. */
function escapeForJsMessage(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

await main();
