import { describe, expect, it } from "vitest";
import {
  isSafeHttpMethod,
  requestDashboardBlob,
  requestDashboardData,
  requestGatewayJson,
} from "./api-client";

/** Input type accepted by the Fetch API. */
type FetchInput = Parameters<typeof fetch>[0];

/** Initialization type accepted by the Fetch API. */
type FetchInit = Parameters<typeof fetch>[1];

/** Fetch call captured by a test double. */
type CapturedFetchCall = {
  /** Requested URL or request object. */
  readonly input: FetchInput;
  /** Fetch initialization options. */
  readonly init: FetchInit;
};

/** Fetch test double and the calls it captured. */
type MockFetch = {
  /** Fetch implementation used by the code under test. */
  readonly fetch: typeof fetch;
  /** Calls captured by the mock fetch implementation. */
  readonly calls: readonly CapturedFetchCall[];
};

/** Creates a fetch double that always returns the provided response. */
function createFetch(response: Response): MockFetch {
  const calls: CapturedFetchCall[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init });
      return response;
    },
  };
}

/** Creates a fetch double that returns a JSON response. */
function createJsonFetch(body: unknown, status = 200): MockFetch {
  return createFetch(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
}

/** Returns the only captured fetch call. */
function onlyCall(calls: readonly CapturedFetchCall[]): CapturedFetchCall {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) {
    throw new Error("Expected one captured fetch call.");
  }
  return call;
}

/** Formats API test errors from a standard error envelope. */
function testErrorMessage(body: unknown, status: number): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const error =
    record?.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  const code = typeof error?.code === "string" ? error.code : "unknown";
  const message = typeof error?.message === "string" ? error.message : `HTTP ${status}`;
  return `${code}: ${message}`;
}

describe("dashboard API client", () => {
  it("requests typed JSON envelopes with credentials, content type, and CSRF", async () => {
    const mock = createJsonFetch({ data: { saved: true } });

    const result = await requestDashboardData<{ readonly saved: boolean }>({
      csrfToken: "csrf_token",
      errorMessage: testErrorMessage,
      fetch: mock.fetch,
      includeCsrf: true,
      init: {
        body: JSON.stringify({ enabled: true }),
        method: "PATCH",
      },
      url: "http://api.test/admin/settings",
    });

    const call = onlyCall(mock.calls);
    const headers = new Headers(call.init?.headers);

    expect(result).toEqual({ saved: true });
    expect(call.input).toBe("http://api.test/admin/settings");
    expect(call.init?.credentials).toBe("include");
    expect(call.init?.method).toBe("PATCH");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-csrf-token")).toBe("csrf_token");
  });

  it("does not attach CSRF headers to safe methods", async () => {
    const mock = createJsonFetch({ data: { ok: true } });

    await requestDashboardData<{ readonly ok: boolean }>({
      csrfToken: "csrf_token",
      errorMessage: testErrorMessage,
      fetch: mock.fetch,
      includeCsrf: true,
      url: "http://api.test/admin/overview",
    });

    const headers = new Headers(onlyCall(mock.calls).init?.headers);

    expect(headers.has("x-csrf-token")).toBe(false);
  });

  it("runs the unauthorized hook before throwing formatted API errors", async () => {
    const mock = createJsonFetch(
      { error: { code: "auth.required", message: "Sign in again." } },
      401,
    );
    let unauthorized = false;

    await expect(
      requestDashboardData<unknown>({
        errorMessage: testErrorMessage,
        fetch: mock.fetch,
        onUnauthorized: () => {
          unauthorized = true;
        },
        url: "http://api.test/api/v1/me",
      }),
    ).rejects.toThrow("auth.required: Sign in again.");

    expect(unauthorized).toBe(true);
  });

  it("requests authenticated blob downloads", async () => {
    const mock = createFetch(
      new Response("artifact", {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );

    const blob = await requestDashboardBlob({
      errorMessage: testErrorMessage,
      fetch: mock.fetch,
      url: "http://api.test/api/v1/review-runs/rrn/artifacts/art/download",
    });

    const call = onlyCall(mock.calls);

    expect(call.init?.credentials).toBe("include");
    expect(call.init?.method).toBe("GET");
    expect(await blob.text()).toBe("artifact");
  });

  it("posts JSON requests to the admin gateway", async () => {
    const mock = createJsonFetch({
      encodedAssertion: "assertion",
      signature: "signature",
      timestamp: "2026-05-08T00:00:00.000Z",
    });

    const result = await requestGatewayJson<{
      readonly encodedAssertion: string;
      readonly signature: string;
      readonly timestamp: string;
    }>({
      body: { purpose: "dashboard-login" },
      errorMessage: testErrorMessage,
      fetch: mock.fetch,
      url: "http://gateway.test/heimdall/assertion",
    });

    const call = onlyCall(mock.calls);
    const headers = new Headers(call.init?.headers);

    expect(result.encodedAssertion).toBe("assertion");
    expect(call.init?.credentials).toBe("include");
    expect(call.init?.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(call.init?.body).toBe(JSON.stringify({ purpose: "dashboard-login" }));
  });
});

describe("safe HTTP methods", () => {
  it("matches the methods that do not require CSRF headers", () => {
    expect(isSafeHttpMethod("GET")).toBe(true);
    expect(isSafeHttpMethod("HEAD")).toBe(true);
    expect(isSafeHttpMethod("OPTIONS")).toBe(true);
    expect(isSafeHttpMethod("POST")).toBe(false);
  });
});
