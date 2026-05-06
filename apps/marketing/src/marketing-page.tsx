import heimdallLogoUrl from "./assets/heimdall-logo.svg";

const reviewSignals = [
  "Cross-file context",
  "PR review",
  "Policy packs",
  "Enterprise-ready",
] as const;

const reviewFindings = [
  {
    level: "High",
    title: "Unhandled error type",
    body: "Generic Error reduces reliability. Use a domain error for consistent handling.",
    line: "Line 131",
  },
  {
    level: "Medium",
    title: "Missing audit event",
    body: "Emit an audit event for session expiration to improve traceability.",
    line: "Line 132",
  },
  {
    level: "Info",
    title: "Logging level",
    body: "Use info level in expected flows to reduce noise.",
    line: "Line 132",
  },
] as const;

const workflowSteps = [
  {
    label: "Ingest",
    title: "Track every review event",
    body: "Heimdall receives GitHub webhook events, normalizes pull request context, and plans review work without blocking developers.",
  },
  {
    label: "Understand",
    title: "Build a working map of the repo",
    body: "Indexing captures routes, symbols, dependencies, and source artifacts so reviews can reason from real code structure.",
  },
  {
    label: "Review",
    title: "Publish focused findings",
    body: "The review engine turns repository context into actionable comments that teams can evaluate, tune, and trust.",
  },
] as const;

const proofPoints = [
  { value: "22+", label: "Node runtime baseline" },
  { value: "TypeBox", label: "Boundary schemas" },
  { value: "Vitest", label: "Behavioral test loop" },
] as const;

/**
 * Renders the public Heimdall marketing homepage.
 */
export function MarketingPage() {
  return (
    <main>
      <header className="site-header">
        <a className="brand-mark" href="/">
          <img src={heimdallLogoUrl} alt="Heimdall" />
        </a>
        <nav className="header-links" aria-label="Marketing navigation">
          <a href="#workflow">Product</a>
          <a href="#platform">Docs</a>
          <a href="#workflow">Pricing</a>
          <a href="#platform">Security</a>
        </nav>
        <a className="header-action" href="mailto:founders@heimdall.dev">
          Request demo
          <span aria-hidden="true">-&gt;</span>
        </a>
      </header>

      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">AI-powered code intelligence</p>
          <h1>
            Deep-context code intelligence for <span>AI-powered review</span>
          </h1>
          <p className="hero-lede">
            Heimdall helps engineering teams review pull requests with repository-wide context,
            precise findings, and policy-aware analysis.
          </p>
          <div className="hero-actions">
            <a className="primary-action" href="mailto:founders@heimdall.dev">
              Request demo
              <span aria-hidden="true">-&gt;</span>
            </a>
            <a className="secondary-action" href="#workflow">
              Explore product
              <span aria-hidden="true">-&gt;</span>
            </a>
          </div>
          <ul className="signal-grid" aria-label="Heimdall capabilities">
            {reviewSignals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </div>

        <aside className="review-console" aria-label="Heimdall AI review interface preview">
          <div className="console-header">
            <img src={heimdallLogoUrl} alt="" aria-hidden="true" />
            <span>acme/cloud-service</span>
            <strong>PR #482</strong>
            <em>Open</em>
            <nav aria-label="Review preview tabs">
              <a href="#workflow">AI Review</a>
              <a href="#workflow">Files</a>
              <a href="#workflow">Checks</a>
            </nav>
          </div>
          <div className="console-body">
            <section className="diff-panel" aria-label="Code diff preview">
              <div className="file-bar">
                <span>src/auth/session.ts</span>
                <div>
                  <button type="button">Split</button>
                  <button type="button">Unified</button>
                </div>
              </div>
              <pre>{`128    const payload = decode(token);
129    if (!payload.exp || Date.now() < 0) {
130
131  -   throw new Error("Token expired");
132  +   logger.warn("Token expired", { sub: payload.sub });
133  +   throw new AuthError("TOKEN_EXPIRED");
134    }
135
136    return createSession(payload);`}</pre>
              <div className="findings-list">
                <span className="findings-title">AI Review Findings</span>
                {reviewFindings.map((finding) => (
                  <article key={finding.title}>
                    <div>
                      <strong>{finding.level}</strong>
                      <h2>{finding.title}</h2>
                      <p>{finding.body}</p>
                    </div>
                    <span>{finding.line}</span>
                  </article>
                ))}
              </div>
            </section>
            <section className="bot-panel" aria-label="Heimdall bot summary">
              <article className="bot-card">
                <div className="bot-title">
                  <img src={heimdallLogoUrl} alt="" aria-hidden="true" />
                  <div>
                    <strong>Heimdall Bot</strong>
                    <span>Deep-context analysis across the entire codebase.</span>
                  </div>
                </div>
                <ul>
                  <li>Analyzed 24 files</li>
                  <li>2,341 symbols indexed</li>
                  <li>Cross-file context used</li>
                  <li>Policy pack: Security + Best Practices</li>
                </ul>
              </article>
              <article className="summary-card">
                <strong>Summary</strong>
                <div>
                  <span>
                    1<small>Critical</small>
                  </span>
                  <span>
                    3<small>High</small>
                  </span>
                  <span>
                    4<small>Medium</small>
                  </span>
                  <span>
                    0<small>Low</small>
                  </span>
                </div>
              </article>
              <article className="commands-card">
                <strong>Commands</strong>
                <span>/ explain this change</span>
                <span>/ find similar logic</span>
                <span>/ run security rules</span>
                <span>/ summarize PR</span>
              </article>
            </section>
          </div>
        </aside>
      </section>

      <section className="proof-strip" aria-label="Platform highlights">
        {proofPoints.map((point) => (
          <div key={point.label}>
            <strong>{point.value}</strong>
            <span>{point.label}</span>
          </div>
        ))}
      </section>

      <section className="workflow-section" id="workflow">
        <div className="section-heading">
          <p className="eyebrow">Review pipeline</p>
          <h2>Designed for teams that want review automation with memory.</h2>
        </div>
        <div className="workflow-grid">
          {workflowSteps.map((step) => (
            <article className="workflow-card" key={step.label}>
              <span>{step.label}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="platform-section" id="platform">
        <div>
          <p className="eyebrow">Platform posture</p>
          <h2>Built as infrastructure, not a chat widget.</h2>
        </div>
        <p>
          Heimdall separates ingestion, indexing, retrieval, review orchestration, publishing, and
          evaluation into focused services. That shape keeps the marketing surface separate from the
          product app while the platform grows behind it.
        </p>
      </section>

      <footer className="site-footer" id="contact">
        <span>
          <img src={heimdallLogoUrl} alt="Heimdall" />
        </span>
        <a href="mailto:founders@heimdall.dev">founders@heimdall.dev</a>
      </footer>
    </main>
  );
}
