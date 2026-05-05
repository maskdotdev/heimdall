import { JOB_TYPES } from "@repo/contracts";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { BullMqQueueProducer, InMemoryQueueProducer, QUEUE_NAMES } from "../src";

describe("queue producer contract", () => {
  it("records idempotent job intents for tests", async () => {
    const producer = new InMemoryQueueProducer();

    await producer.enqueue({
      queueName: QUEUE_NAMES.repoSync,
      envelope: {
        jobId: "job_test",
        jobType: JOB_TYPES.SyncInstallation,
        schemaVersion: "job_envelope.v1",
        idempotencyKey: "sync:inst_test",
        createdAt: "2026-01-01T00:00:00.000Z",
        attempt: 0,
        maxAttempts: 3,
        payload: {
          installationId: "inst_test",
          provider: "github",
          reason: "installed",
        },
      },
    });

    expect(producer.jobs).toHaveLength(1);
    expect(producer.jobs[0]?.queueName).toBe(QUEUE_NAMES.repoSync);
  });
});

const redisUrl = process.env.HEIMDALL_REDIS_TEST_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("BullMQ producer integration", () => {
  const queueName = QUEUE_NAMES.repoSync;
  let connection: IORedis | undefined;
  let queue: Queue | undefined;

  afterAll(async () => {
    await queue?.drain(true);
    await queue?.close();
    await connection?.quit();
  });

  it("enqueues jobs into Redis with idempotent job IDs", async () => {
    connection = new IORedis(redisUrl ?? "", { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection });
    const producer = new BullMqQueueProducer(redisUrl);
    const envelope = {
      jobId: "job_test",
      jobType: JOB_TYPES.SyncInstallation,
      schemaVersion: "job_envelope.v1",
      idempotencyKey: "sync:inst_test",
      createdAt: "2026-01-01T00:00:00.000Z",
      attempt: 0,
      maxAttempts: 3,
      payload: {
        installationId: "inst_test",
        provider: "github",
        reason: "installed",
      },
    } as const;

    await producer.enqueue({
      queueName,
      envelope,
    });
    await producer.close();

    const job = await queue.getJob(envelope.idempotencyKey);
    expect(job?.name).toBe(JOB_TYPES.SyncInstallation);
    expect(job?.data).toMatchObject({ idempotencyKey: envelope.idempotencyKey });
  });
});
