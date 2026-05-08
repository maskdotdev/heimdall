/** API envelope returned by the API for successful JSON requests. */
type ApiEnvelope<T> = {
  /** Response data payload. */
  readonly data: T;
};

/** Fetch implementation used by the dashboard API client. */
export type DashboardFetch = typeof fetch;

/** Formats an API error response body into a user-visible message. */
export type DashboardErrorMessageFormatter = (body: unknown, status: number) => string;

/** Shared JSON request options for dashboard API calls. */
type DashboardJsonRequestInput = {
  /** Fully qualified or same-origin URL to request. */
  readonly url: string;
  /** Optional fetch initialization options. */
  readonly init?: RequestInit;
  /** Optional fetch implementation for tests. */
  readonly fetch?: DashboardFetch;
  /** Optional CSRF token to send on unsafe requests. */
  readonly csrfToken?: string | undefined;
  /** Whether to attach the CSRF token to unsafe methods. */
  readonly includeCsrf?: boolean | undefined;
  /** Callback invoked when the API returns HTTP 401. */
  readonly onUnauthorized?: (() => void) | undefined;
  /** Error message formatter used for non-2xx responses. */
  readonly errorMessage: DashboardErrorMessageFormatter;
};

/** Blob request options for dashboard API downloads. */
type DashboardBlobRequestInput = {
  /** Fully qualified or same-origin URL to request. */
  readonly url: string;
  /** Optional fetch implementation for tests. */
  readonly fetch?: DashboardFetch;
  /** Callback invoked when the API returns HTTP 401. */
  readonly onUnauthorized?: (() => void) | undefined;
  /** Error message formatter used for non-2xx responses. */
  readonly errorMessage: DashboardErrorMessageFormatter;
};

/** JSON request options for admin gateway calls. */
type DashboardGatewayJsonRequestInput = {
  /** Fully qualified or same-origin gateway URL to request. */
  readonly url: string;
  /** JSON-compatible request body. */
  readonly body: unknown;
  /** Optional fetch implementation for tests. */
  readonly fetch?: DashboardFetch;
  /** Error message formatter used for non-2xx responses. */
  readonly errorMessage: DashboardErrorMessageFormatter;
};

/** Requests a typed JSON data envelope from the product or admin API. */
export async function requestDashboardData<T>(input: DashboardJsonRequestInput): Promise<T> {
  const method = input.init?.method ?? "GET";
  const headers = new Headers(input.init?.headers);
  if (input.init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (input.includeCsrf && input.csrfToken && !isSafeHttpMethod(method)) {
    headers.set("x-csrf-token", input.csrfToken);
  }

  const response = await requestFetch(input.fetch)(input.url, {
    ...input.init,
    credentials: "include",
    headers,
    method,
  });
  const body = await responseJsonBody(response);
  if (!response.ok) {
    if (response.status === 401) {
      input.onUnauthorized?.();
    }
    throw new Error(input.errorMessage(body, response.status));
  }

  const envelope = body as ApiEnvelope<T> | undefined;
  if (!envelope || !("data" in envelope)) {
    throw new Error("API response did not include data.");
  }

  return envelope.data;
}

/** Requests an authenticated blob download from the product API. */
export async function requestDashboardBlob(input: DashboardBlobRequestInput): Promise<Blob> {
  const response = await requestFetch(input.fetch)(input.url, {
    credentials: "include",
    method: "GET",
  });
  if (!response.ok) {
    const body = await responseJsonBody(response);
    if (response.status === 401) {
      input.onUnauthorized?.();
    }
    throw new Error(input.errorMessage(body, response.status));
  }

  return response.blob();
}

/** Requests a JSON response from the trusted admin gateway. */
export async function requestGatewayJson<T>(input: DashboardGatewayJsonRequestInput): Promise<T> {
  const response = await requestFetch(input.fetch)(input.url, {
    body: JSON.stringify(input.body),
    credentials: "include",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await responseJsonBody(response);
  if (!response.ok) {
    throw new Error(input.errorMessage(body, response.status));
  }

  return body as T;
}

/** Returns whether an HTTP method is safe from CSRF. */
export function isSafeHttpMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** Returns the provided fetch implementation or the global browser fetch. */
function requestFetch(fetchImplementation: DashboardFetch | undefined): DashboardFetch {
  return fetchImplementation ?? fetch;
}

/** Parses a JSON response body, returning undefined for empty or invalid JSON bodies. */
async function responseJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}
