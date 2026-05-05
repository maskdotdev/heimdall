import { describe, expect, it } from "vitest";
import { createApiApp } from "./app";

describe("api app", () => {
  it("wires the GitHub webhook route to the handler", async () => {
    const app = createApiApp({
      githubWebhookHandler: {
        handle: async () => ({
          status: "accepted",
          deliveryId: "delivery-1",
          webhookEventId: "webhook_test",
          jobs: [],
        }),
      } as never,
    });

    const response = await app.handle(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "accepted",
      deliveryId: "delivery-1",
    });
  });
});
