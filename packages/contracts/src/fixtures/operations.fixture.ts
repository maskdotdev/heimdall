import type { CodeIndexVersion } from "#contracts/index-artifact/artifact";
import type { LLMCall } from "#contracts/llm/llm-call";
import type { PromptVersion } from "#contracts/llm/prompt";
import type { UsageEvent } from "#contracts/usage/usage-event";
import type { WebhookEvent } from "#contracts/webhook/webhook-event";
import { hashA, hashB, ids, now } from "./common";

export const validCodeIndexVersionFixture = {
  indexVersionId: ids.indexVersionId,
  repoId: ids.repoId,
  commitSha: "2222222",
  status: "ready",
  artifactUri: "s3://heimdall-artifacts/indexes/2222222",
  artifactHash: hashA,
  indexerName: "heimdall-ts-indexer",
  indexerVersion: "0.1.0",
  chunkerVersion: "0.1.0",
  fileCount: 1,
  symbolCount: 1,
  edgeCount: 1,
  chunkCount: 1,
  embeddedChunkCount: 1,
  createdAt: now,
  completedAt: now,
} satisfies CodeIndexVersion;

export const validLLMCallFixture = {
  llmCallId: "llm_01HXAMPLE",
  orgId: ids.orgId,
  repoId: ids.repoId,
  reviewRunId: ids.reviewRunId,
  operation: "generate_findings",
  provider: "openai",
  model: "gpt-5.4",
  promptVersion: "review-findings.v1",
  inputHash: hashA,
  outputHash: hashB,
  inputTokens: 1200,
  outputTokens: 300,
  cachedInputTokens: 0,
  latencyMs: 1400,
  costMicros: 950,
  status: "succeeded",
  startedAt: now,
  completedAt: now,
} satisfies LLMCall;

export const validPromptVersionFixture = {
  promptVersion: "review-findings.v1",
  operation: "generate_findings",
  description: "Generate candidate PR findings from context bundle input.",
  createdAt: now,
} satisfies PromptVersion;

export const validUsageEventFixture = {
  usageEventId: "usage_01HXAMPLE",
  orgId: ids.orgId,
  repoId: ids.repoId,
  reviewRunId: ids.reviewRunId,
  eventType: "llm.token",
  quantity: 1500,
  unit: "token",
  costMicros: 950,
  occurredAt: now,
} satisfies UsageEvent;

export const validWebhookEventFixture = {
  webhookEventId: "webhook_01HXAMPLE",
  provider: "github",
  deliveryId: "delivery-123",
  eventName: "pull_request",
  action: "opened",
  installationId: ids.installationId,
  repoId: ids.repoId,
  payloadHash: hashA,
  payloadUri: "s3://heimdall-artifacts/webhooks/delivery-123.json",
  status: "processed",
  receivedAt: now,
  processedAt: now,
} satisfies WebhookEvent;
