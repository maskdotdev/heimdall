/** Header names accepted by the admin API for trusted identity assertions. */
export const ADMIN_IDENTITY_HEADER_NAMES = {
  assertion: "x-heimdall-idp-assertion",
  signature: "x-heimdall-idp-signature",
  timestamp: "x-heimdall-idp-timestamp",
} as const;

/** Headers that carry one gateway-issued admin identity assertion. */
export type AdminIdentityRequestHeaders = {
  /** Base64url-encoded identity assertion emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.assertion]: string;
  /** Signature emitted by the trusted gateway. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.signature]: string;
  /** Gateway assertion timestamp. */
  readonly [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: string;
};

/** Gateway assertion lookup options shared by smoke scripts. */
export type AdminSmokeIdentityRequest = {
  /** Purpose string sent to the gateway for audit and policy decisions. */
  readonly purpose: string;
  /** Organization scope requested by the smoke actor. */
  readonly orgId?: string | undefined;
  /** Repository scope requested by the smoke actor. */
  readonly repoId?: string | undefined;
  /** Provider subject requested for the smoke actor. */
  readonly providerSubject?: string | undefined;
};

/** Gateway-issued assertion plus provenance for smoke logs. */
export type AdminSmokeIdentityAssertion = {
  /** API request headers for login. */
  readonly headers: AdminIdentityRequestHeaders;
  /** Human-readable assertion source. */
  readonly source: string;
};

/** Environment-backed options for requesting an admin identity assertion. */
type AdminSmokeIdentityEnvironment = {
  /** Gateway endpoint that returns a signed admin identity assertion. */
  readonly assertionUrl?: string | undefined;
  /** HTTP method used for the assertion gateway request. */
  readonly assertionMethod: "GET" | "POST";
  /** Optional bearer token for the assertion gateway. */
  readonly assertionBearerToken?: string | undefined;
  /** Optional authenticated gateway session cookie for GitHub-org gateway proof. */
  readonly assertionGatewayCookie?: string | undefined;
  /** Dashboard origin sent to the gateway for credentialed assertion requests. */
  readonly assertionOrigin?: string | undefined;
  /** Explicit opt-in for manually supplied gateway assertion headers. */
  readonly allowSuppliedAssertion: boolean;
  /** Manually supplied encoded assertion. */
  readonly suppliedAssertion?: string | undefined;
  /** Manually supplied assertion signature. */
  readonly suppliedSignature?: string | undefined;
  /** Manually supplied assertion timestamp. */
  readonly suppliedTimestamp?: string | undefined;
};

/** JSON shape accepted from the staging identity gateway. */
type GatewayAssertionResponse = {
  /** Top-level encoded assertion field. */
  readonly encodedAssertion?: unknown;
  /** Alternate top-level encoded assertion field. */
  readonly assertion?: unknown;
  /** Top-level signature field. */
  readonly signature?: unknown;
  /** Top-level timestamp field. */
  readonly timestamp?: unknown;
  /** Optional response header map. */
  readonly headers?: unknown;
};

/** Reads a gateway-issued admin identity assertion for smoke scripts. */
export async function readGatewayIdentityAssertion(
  request: AdminSmokeIdentityRequest,
): Promise<AdminSmokeIdentityAssertion> {
  const env = readIdentityEnvironment();
  if (env.assertionUrl) {
    return fetchGatewayIdentityAssertion(env, request);
  }

  if (env.allowSuppliedAssertion) {
    return readSuppliedGatewayAssertion(env);
  }

  throw new Error(
    [
      "HEIMDALL_ADMIN_SMOKE_ASSERTION_URL is required for live control-plane proof.",
      "The smoke scripts no longer mint assertions from HEIMDALL_ADMIN_IDENTITY_ASSERTION_SECRET.",
      "Set HEIMDALL_ADMIN_SMOKE_ALLOW_SUPPLIED_ASSERTION=true only for a manually retrieved gateway assertion.",
    ].join(" "),
  );
}

/** Converts one identity assertion to API login headers. */
export function identityHeaders(assertion: {
  /** Base64url-encoded identity assertion. */
  readonly encodedAssertion: string;
  /** Identity assertion signature. */
  readonly signature: string;
  /** Identity assertion timestamp. */
  readonly timestamp: string;
}): AdminIdentityRequestHeaders {
  return {
    [ADMIN_IDENTITY_HEADER_NAMES.assertion]: assertion.encodedAssertion,
    [ADMIN_IDENTITY_HEADER_NAMES.signature]: assertion.signature,
    [ADMIN_IDENTITY_HEADER_NAMES.timestamp]: assertion.timestamp,
  };
}

/** Fetches one signed assertion from the configured gateway endpoint. */
async function fetchGatewayIdentityAssertion(
  env: AdminSmokeIdentityEnvironment,
  request: AdminSmokeIdentityRequest,
): Promise<AdminSmokeIdentityAssertion> {
  const headers = new Headers({ accept: "application/json" });
  if (env.assertionBearerToken) {
    headers.set("authorization", `Bearer ${env.assertionBearerToken}`);
  }
  if (env.assertionGatewayCookie) {
    if (!env.assertionOrigin) {
      throw new Error(
        "HEIMDALL_ADMIN_SMOKE_ORIGIN or WEB_URL is required when using HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE.",
      );
    }

    headers.set("cookie", env.assertionGatewayCookie);
  }
  if (env.assertionOrigin) {
    headers.set("origin", env.assertionOrigin);
  }

  const init: RequestInit =
    env.assertionMethod === "POST"
      ? {
          method: "POST",
          headers,
          body: JSON.stringify({
            orgId: request.orgId,
            providerSubject: request.providerSubject,
            purpose: request.purpose,
            repoId: request.repoId,
          }),
        }
      : { method: "GET", headers };

  if (env.assertionMethod === "POST") {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(requiredUrl(env.assertionUrl), init);
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    throw new Error(
      `Admin identity gateway returned HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }

  return {
    headers: identityHeaders(assertionFromGatewayBody(body)),
    source: requiredUrl(env.assertionUrl).origin,
  };
}

/** Reads explicitly supplied gateway assertion headers. */
function readSuppliedGatewayAssertion(
  env: AdminSmokeIdentityEnvironment,
): AdminSmokeIdentityAssertion {
  if (!env.suppliedAssertion || !env.suppliedSignature || !env.suppliedTimestamp) {
    throw new Error(
      "Supplied assertion mode requires HEIMDALL_ADMIN_SMOKE_IDP_ASSERTION, HEIMDALL_ADMIN_SMOKE_IDP_SIGNATURE, and HEIMDALL_ADMIN_SMOKE_IDP_TIMESTAMP.",
    );
  }

  return {
    headers: identityHeaders({
      encodedAssertion: env.suppliedAssertion,
      signature: env.suppliedSignature,
      timestamp: env.suppliedTimestamp,
    }),
    source: "supplied-gateway-assertion",
  };
}

/** Parses a gateway JSON response into the API assertion tuple. */
function assertionFromGatewayBody(body: unknown): {
  /** Base64url-encoded identity assertion. */
  readonly encodedAssertion: string;
  /** Identity assertion signature. */
  readonly signature: string;
  /** Identity assertion timestamp. */
  readonly timestamp: string;
} {
  const record = asRecord(body) as GatewayAssertionResponse | undefined;
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
    throw new Error(
      `Admin identity gateway response must include encodedAssertion, signature, and timestamp: ${JSON.stringify(body)}`,
    );
  }

  return { encodedAssertion, signature, timestamp };
}

/** Reads identity gateway configuration from process.env. */
function readIdentityEnvironment(): AdminSmokeIdentityEnvironment {
  return {
    allowSuppliedAssertion: process.env.HEIMDALL_ADMIN_SMOKE_ALLOW_SUPPLIED_ASSERTION === "true",
    assertionBearerToken: emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_ASSERTION_BEARER_TOKEN),
    assertionGatewayCookie: emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_GATEWAY_COOKIE),
    assertionMethod: process.env.HEIMDALL_ADMIN_SMOKE_ASSERTION_METHOD === "GET" ? "GET" : "POST",
    assertionOrigin:
      emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_ORIGIN) ??
      originFromUrl(process.env.WEB_URL),
    assertionUrl: emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_ASSERTION_URL),
    suppliedAssertion: emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_IDP_ASSERTION),
    suppliedSignature: emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_IDP_SIGNATURE),
    suppliedTimestamp: emptyToUndefined(process.env.HEIMDALL_ADMIN_SMOKE_IDP_TIMESTAMP),
  };
}

/** Converts blank environment values to undefined. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/** Returns the origin for one configured URL value. */
function originFromUrl(value: string | undefined): string | undefined {
  const url = emptyToUndefined(value);
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Returns a URL object for a required URL string. */
function requiredUrl(value: string | undefined): URL {
  if (!value) {
    throw new Error("Admin identity gateway URL is required.");
  }

  return new URL(value);
}

/** Returns a plain object record when possible. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads one non-empty string field from an object record. */
function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
