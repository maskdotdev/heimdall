import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketingPage } from "./marketing-page";

/** Renders the marketing page to static HTML for content contract checks. */
function renderMarketingPage(): string {
  return renderToStaticMarkup(<MarketingPage />);
}

describe("MarketingPage", () => {
  it("renders the primary product positioning and calls to action", () => {
    const html = renderMarketingPage();

    expect(html).toContain("Deep-context code intelligence");
    expect(html).toContain("AI-powered review");
    expect(html).toContain("Request demo");
    expect(html).toContain("Explore product");
    expect(html).toContain("mailto:founders@heimdall.dev");
  });

  it("renders review signals, workflow steps, and platform proof points", () => {
    const html = renderMarketingPage();

    for (const text of [
      "Cross-file context",
      "PR review",
      "Policy packs",
      "Enterprise-ready",
      "Track every review event",
      "Build a working map of the repo",
      "Publish focused findings",
      "Node runtime baseline",
      "Boundary schemas",
      "Behavioral test loop",
    ]) {
      expect(html).toContain(text);
    }
  });
});
