import type { ReviewRun } from "@heimdall/contracts";
import { HeimdallApiClient } from "@heimdall/ts-api-client";

export function createApiClient(baseUrl: string): HeimdallApiClient {
  return new HeimdallApiClient({ baseUrl });
}

export function reviewRunLabel(reviewRun: ReviewRun): string {
  return `${reviewRun.id}:${reviewRun.state}`;
}
