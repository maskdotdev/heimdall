import { createDatabaseClient } from "@repo/db";
import { BullMqQueueProducer, type QueueProducer } from "@repo/queue";
import {
  GitHubWebhookHandler,
  WebhookAuthenticationError,
  WebhookPayloadError,
} from "@repo/webhook-ingestion";
import { Elysia } from "elysia";

/** Dependencies used to create the API app. */
export type CreateApiAppOptions = {
  /** GitHub webhook handler for tests or custom composition. */
  readonly githubWebhookHandler?: GitHubWebhookHandler;
  /** Queue producer closed when the process exits. */
  readonly queueProducer?: QueueProducer;
};

/** Creates the Heimdall API app. */
export function createApiApp(options: CreateApiAppOptions = {}) {
  const databaseClient = options.githubWebhookHandler ? undefined : createDatabaseClient();
  const queueProducer =
    options.queueProducer ?? (options.githubWebhookHandler ? undefined : new BullMqQueueProducer());
  const db = databaseClient?.db;
  const githubWebhookHandler =
    options.githubWebhookHandler ??
    new GitHubWebhookHandler({
      db: db ?? createDatabaseClient().db,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
      queueProducer: queueProducer ?? new BullMqQueueProducer(),
    });

  return new Elysia()
    .get("/healthz", () => ({ ok: true, service: "api" }))
    .post("/webhooks/github", async ({ request, set }) => {
      const rawBody = new Uint8Array(await request.arrayBuffer());
      try {
        const result = await githubWebhookHandler.handle({
          headers: request.headers,
          rawBody,
        });

        set.status = 202;
        return result;
      } catch (error) {
        if (error instanceof WebhookAuthenticationError) {
          set.status = 401;
          return { error: { code: "webhook.invalid_signature", message: error.message } };
        }

        if (error instanceof WebhookPayloadError) {
          set.status = 400;
          return { error: { code: "webhook.invalid_payload", message: error.message } };
        }

        throw error;
      }
    });
}
