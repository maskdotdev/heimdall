import type { Finding, ReviewRun } from "@heimdall/contracts";
import { HeimdallApiClient } from "@heimdall/ts-api-client";
import type { FormEvent } from "react";
import { useMemo } from "react";
import { create } from "zustand";

type LoadState = "idle" | "submitting" | "complete" | "error";

type ReviewState = {
  error: string | null;
  findings: Finding[];
  reviewRun: ReviewRun | null;
  state: LoadState;
  url: string;
  resetForSubmit: () => void;
  setError: (error: string) => void;
  setReviewComplete: (reviewRun: ReviewRun, findings: Finding[]) => void;
  setUrl: (url: string) => void;
};

const useReviewStore = create<ReviewState>((set) => ({
  error: null,
  findings: [],
  reviewRun: null,
  state: "idle",
  url: "",
  resetForSubmit: () =>
    set({
      error: null,
      findings: [],
      state: "submitting",
    }),
  setError: (error) =>
    set({
      error,
      state: "error",
    }),
  setReviewComplete: (reviewRun, findings) =>
    set({
      findings,
      reviewRun,
      state: "complete",
    }),
  setUrl: (url) => set({ url }),
}));

export function App() {
  const {
    error,
    findings,
    resetForSubmit,
    reviewRun,
    setError,
    setReviewComplete,
    setUrl,
    state,
    url,
  } = useReviewStore();
  const client = useMemo(() => new HeimdallApiClient({ baseUrl: "" }), []);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetForSubmit();
    try {
      const created = await client.createReviewRunFromUrl({ url });
      const response = await client.getReviewRunFindings(created.id);
      setReviewComplete(created, response.findings);
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : "Review failed");
    }
  }

  return (
    <main className="shell">
      <section className="command-panel" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Public PR review</p>
          <h1 id="page-title">Heimdall review console</h1>
        </div>
        <form className="review-form" onSubmit={submitReview}>
          <label htmlFor="pr-url">GitHub pull request URL</label>
          <div className="input-row">
            <input
              id="pr-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
              required
            />
            <button type="submit" disabled={state === "submitting"}>
              {state === "submitting" ? "Reviewing" : "Start review"}
            </button>
          </div>
        </form>
      </section>

      <section className="status-grid" aria-label="Review status">
        <StatusMetric label="State" value={reviewRun?.state ?? "Not started"} />
        <StatusMetric label="Phase" value={reviewRun?.phase ?? "Waiting"} />
        <StatusMetric label="Findings" value={String(findings.length)} />
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="findings" aria-labelledby="findings-title">
        <h2 id="findings-title">Findings</h2>
        {findings.length === 0 ? (
          <p className="empty">Review findings will appear here after a run completes.</p>
        ) : (
          <ol>
            {findings.map((finding) => (
              <li key={finding.id} className="finding">
                <div className="finding-header">
                  <span>{finding.severity}</span>
                  <strong>{finding.title}</strong>
                </div>
                <p>{finding.body}</p>
                {finding.location ? (
                  <code>
                    {finding.location.path}:{finding.location.startLine ?? 1}
                  </code>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function StatusMetric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
