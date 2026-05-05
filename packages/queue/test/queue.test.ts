import { JOB_TYPES } from "@repo/contracts";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import {
  BullMqQueueProducer,
  createDurableJobProcessor,
  type DurableJob,
  dispatchPendingJobs,
  InMemoryDurableJobStore,
  InMemoryQueueProducer,
  QUEUE_NAMES,
} from "../src";

const syncInstallationEnvelope = {
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

const durableJob = (overrides: Partial<DurableJob> = {}): DurableJob => ({
  backgroundJobId: "job_row_test",
  queueName: QUEUE_NAMES.repoSync,
  envelope: syncInstallationEnvelope,
  status: "pending",
  attempts: 0,
  maxAttempts: 3,
  ...overrides,
});

describe("queue producer contract", () => {
  it("records idempotent job intents for tests", async () => {
    const producer = new InMemoryQueueProducer();

    await producer.enqueue({
      queueName: QUEUE_NAMES.repoSync,
      envelope: syncInstallationEnvelope,
    });

    expect(producer.jobs).toHaveLength(1);
    expect(producer.jobs[0]?.queueName).toBe(QUEUE_NAMES.repoSync);
  });
});

describe("durable outbox dispatcher", () => {
  it("moves pending durable jobs to queued after enqueue", async () => {
    const store = new InMemoryDurableJobStore([durableJob()]);
    const producer = new InMemoryQueueProducer();

    await expect(dispatchPendingJobs({ store, queueProducer: producer })).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
    });

    expect(producer.jobs).toHaveLength(1);
    expect(store.list()[0]?.status).toBe("queued");
  });

  it("does not enqueue a queued durable job twice", async () => {
    const store = new InMemoryDurableJobStore([durableJob()]);
    const producer = new InMemoryQueueProducer();

    await dispatchPendingJobs({ store, queueProducer: producer });
    await dispatchPendingJobs({ store, queueProducer: producer });

    expect(producer.jobs).toHaveLength(1);
  });
});

describe("durable worker processor", () => {
  it("moves queued jobs through running to completed", async () => {
    const store = new InMemoryDurableJobStore([durableJob({ status: "queued" })]);
    const handled: string[] = [];
    const processor = createDurableJobProcessor({
      store,
      handlers: {
        [JOB_TYPES.SyncInstallation]: async (envelope) => {
          expect(store.list()[0]?.status).toBe("running");
          handled.push(envelope.idempotencyKey);
        },
      },
    });

    await processor({ data: syncInstallationEnvelope, attemptsMade: 0 } as never);

    expect(handled).toEqual(["sync:inst_test"]);
    expect(store.list()[0]).toMatchObject({ attempts: 1, status: "completed" });
  });

  it("keeps retryable failures queued and marks final failures failed", async () => {
    const store = new InMemoryDurableJobStore([durableJob({ status: "queued" })]);
    const processor = createDurableJobProcessor({
      store,
      handlers: {
        [JOB_TYPES.SyncInstallation]: async () => {
          throw new Error("transient");
        },
      },
    });

    await expect(
      processor({ data: syncInstallationEnvelope, attemptsMade: 0 } as never),
    ).rejects.toThrow("transient");
    expect(store.list()[0]).toMatchObject({ attempts: 1, status: "queued" });

    await expect(
      processor({ data: syncInstallationEnvelope, attemptsMade: 2 } as never),
    ).rejects.toThrow("transient");
    expect(store.list()[0]).toMatchObject({ attempts: 2, status: "failed" });
  });

  it("does not run handlers when the durable row is missing", async () => {
    const store = new InMemoryDurableJobStore();
    const handled: string[] = [];
    const processor = createDurableJobProcessor({
      store,
      handlers: {
        [JOB_TYPES.SyncInstallation]: async (envelope) => {
          handled.push(envelope.idempotencyKey);
        },
      },
    });

    await expect(
      processor({ data: syncInstallationEnvelope, attemptsMade: 0 } as never),
    ).rejects.toThrow("was not found or is not runnable");
    expect(handled).toEqual([]);
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
