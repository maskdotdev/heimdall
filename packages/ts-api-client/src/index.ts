import type { Finding, ReviewRun } from "@heimdall/contracts";

export type { Finding, ReviewRun } from "@heimdall/contracts";

export interface HeimdallApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export interface CreateReviewRunFromUrlRequest {
  readonly url: string;
}

export interface ReviewRunFindingsResponse {
  readonly findings: Finding[];
}

export class HeimdallApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HeimdallApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createReviewRunFromUrl(request: CreateReviewRunFromUrlRequest): Promise<ReviewRun> {
    return this.request<ReviewRun>("/api/review-runs/from-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
  }

  async getReviewRun(reviewRunId: string): Promise<ReviewRun> {
    return this.request<ReviewRun>(`/api/review-runs/${encodeURIComponent(reviewRunId)}`);
  }

  async getReviewRunFindings(reviewRunId: string): Promise<ReviewRunFindingsResponse> {
    return this.request<ReviewRunFindingsResponse>(`/api/review-runs/${encodeURIComponent(reviewRunId)}/findings`);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Heimdall API request failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
