import { JOB_TYPES } from "@repo/contracts";
import {
  createTelemetryMetricRecorder,
  createTelemetrySpanRecorder,
  DEFAULT_OBSERVABILITY_CONFIG,
  OBSERVABILITY_METRIC_NAMES,
  OBSERVABILITY_SPAN_NAMES,
  type TelemetryMetricPoint,
  type TelemetrySpanRecord,
} from "@repo/observability";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import {
  BullMqQueueProducer,
  bullMqJobIdForIdempotencyKey,
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
  traceContext: {
    requestId: "req_queue_test",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  },
  payload: {
    installationId: "inst_test",
    provider: "github",
    reason: "installed",
  },
} as const;

/** Creates a sync installation envelope with a unique durable identity. */
const syncInstallationEnvelopeForKey = (idempotencyKey: string) => ({
  ...syncInstallationEnvelope,
  jobId: `job_${idempotencyKey.replaceAll(":", "_")}`,
  idempotencyKey,
});

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

describe("durable job recovery", () => {
  it("repairs stale running jobs and leaves fresh jobs untouched", async () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const staleTimestamp = new Date("2026-01-01T00:00:00.000Z");
    const freshTimestamp = new Date("2026-01-01T00:45:00.000Z");
    const retryableEnvelope = syncInstallationEnvelopeForKey("sync:retryable");
    const exhaustedEnvelope = syncInstallationEnvelopeForKey("sync:exhausted");
    const freshEnvelope = syncInstallationEnvelopeForKey("sync:fresh");
    const heartbeatingEnvelope = syncInstallationEnvelopeForKey("sync:heartbeating");
    const unknownAgeEnvelope = syncInstallationEnvelopeForKey("sync:unknown_age");
    const store = new InMemoryDurableJobStore([
      durableJob({
        attempts: 1,
        backgroundJobId: "job_retryable",
        envelope: retryableEnvelope,
        startedAt: staleTimestamp,
        status: "running",
        updatedAt: staleTimestamp,
      }),
      durableJob({
        attempts: 3,
        backgroundJobId: "job_exhausted",
        envelope: exhaustedEnvelope,
        maxAttempts: 3,
        startedAt: staleTimestamp,
        status: "running",
        updatedAt: staleTimestamp,
      }),
      durableJob({
        attempts: 1,
        backgroundJobId: "job_fresh",
        envelope: freshEnvelope,
        startedAt: freshTimestamp,
        status: "running",
        updatedAt: freshTimestamp,
      }),
      durableJob({
        attempts: 1,
        backgroundJobId: "job_heartbeating",
        envelope: heartbeatingEnvelope,
        startedAt: staleTimestamp,
        status: "running",
        updatedAt: freshTimestamp,
      }),
      durableJob({
        attempts: 1,
        backgroundJobId: "job_unknown_age",
        envelope: unknownAgeEnvelope,
        status: "running",
      }),
    ]);

    await expect(
      store.recoverStaleRunningJobs({
        now,
        staleAfterMs: 30 * 60 * 1_000,
      }),
    ).resolves.toEqual({
      deadLettered: 1,
      inspected: 2,
      jobIds: ["job_retryable", "job_exhausted"],
      requeued: 1,
    });

    const jobs = new Map(store.list().map((job) => [job.backgroundJobId, job]));
    expect(jobs.get("job_retryable")).toMatchObject({
      error: expect.objectContaining({ name: "StaleDurableJobError" }),
      status: "queued",
      updatedAt: now,
    });
    expect(jobs.get("job_exhausted")).toMatchObject({
      completedAt: now,
      error: expect.objectContaining({ name: "StaleDurableJobError" }),
      status: "dead_lettered",
      updatedAt: now,
    });
    expect(jobs.get("job_fresh")?.status).toBe("running");
    expect(jobs.get("job_heartbeating")?.status).toBe("running");
    expect(jobs.get("job_unknown_age")?.status).toBe("running");
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

  it("records durable job spans with trace context", async () => {
    const store = new InMemoryDurableJobStore([durableJob({ status: "queued" })]);
    const spans: TelemetrySpanRecord[] = [];
    const processor = createDurableJobProcessor({
      store,
      handlers: {
        [JOB_TYPES.SyncInstallation]: async () => undefined,
      },
      traces: createTelemetrySpanRecorder(
        {
          ...DEFAULT_OBSERVABILITY_CONFIG,
          enabled: true,
          exporter: "console",
          serviceName: "code-review-worker",
        },
        { write: (span) => spans.push(span) },
      ),
    });

    await processor({ data: syncInstallationEnvelope, attemptsMade: 0 } as never);

    expect(spans).toEqual([
      expect.objectContaining({
        attributes: {
          "job.attempt": 0,
          "job.max_attempts": 3,
          "job.run_state": "completed",
          "job.type": JOB_TYPES.SyncInstallation,
          "queue.name": "unknown",
        },
        kind: "consumer",
        name: OBSERVABILITY_SPAN_NAMES.durableJobProcess,
        status: "ok",
        traceContext: syncInstallationEnvelope.traceContext,
      }),
    ]);
  });

  it("records durable job metrics with low-cardinality labels", async () => {
    const store = new InMemoryDurableJobStore([durableJob({ status: "queued" })]);
    const metricPoints: TelemetryMetricPoint[] = [];
    const processor = createDurableJobProcessor({
      store,
      handlers: {
        [JOB_TYPES.SyncInstallation]: async () => undefined,
      },
      metrics: createTelemetryMetricRecorder(
        {
          ...DEFAULT_OBSERVABILITY_CONFIG,
          enabled: true,
          exporter: "console",
          serviceName: "code-review-worker",
        },
        {
          write: (point) => {
            metricPoints.push(point);
          },
        },
      ),
    });

    await processor({
      attemptsMade: 0,
      data: syncInstallationEnvelope,
      queueName: QUEUE_NAMES.repoSync,
    } as never);

    const labels = {
      job_type: JOB_TYPES.SyncInstallation,
      queue_name: QUEUE_NAMES.repoSync,
      status: "completed",
    };
    expect(metricPoints).toEqual([
      expect.objectContaining({
        kind: "counter",
        labels: {
          job_type: JOB_TYPES.SyncInstallation,
          queue_name: QUEUE_NAMES.repoSync,
          status: "started",
        },
        name: OBSERVABILITY_METRIC_NAMES.queueJobsStartedTotal,
        value: 1,
      }),
      expect.objectContaining({
        kind: "counter",
        labels,
        name: OBSERVABILITY_METRIC_NAMES.queueJobsCompletedTotal,
        value: 1,
      }),
      expect.objectContaining({
        kind: "histogram",
        labels,
        name: OBSERVABILITY_METRIC_NAMES.queueJobDurationMs,
        unit: "ms",
      }),
    ]);
    expect(metricPoints[2]?.value).toBeGreaterThanOrEqual(0);
  });

  it("keeps retryable failures queued and marks final failures failed", async () => {
    const store = new InMemoryDurableJobStore([durableJob({ status: "queued" })]);
    const metricPoints: TelemetryMetricPoint[] = [];
    const processor = createDurableJobProcessor({
      store,
      handlers: {
        [JOB_TYPES.SyncInstallation]: async () => {
          throw new Error("transient");
        },
      },
      metrics: createTelemetryMetricRecorder(
        {
          ...DEFAULT_OBSERVABILITY_CONFIG,
          enabled: true,
          exporter: "console",
          serviceName: "code-review-worker",
        },
        {
          write: (point) => {
            metricPoints.push(point);
          },
        },
      ),
    });

    await expect(
      processor({
        attemptsMade: 0,
        data: syncInstallationEnvelope,
        queueName: QUEUE_NAMES.repoSync,
      } as never),
    ).rejects.toThrow("transient");
    expect(store.list()[0]).toMatchObject({ attempts: 1, status: "queued" });

    await expect(
      processor({
        attemptsMade: 2,
        data: syncInstallationEnvelope,
        queueName: QUEUE_NAMES.repoSync,
      } as never),
    ).rejects.toThrow("transient");
    expect(store.list()[0]).toMatchObject({ attempts: 2, status: "failed" });
    expect(metricPoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: expect.objectContaining({
            error_class: "unknown_error",
            job_type: JOB_TYPES.SyncInstallation,
            queue_name: QUEUE_NAMES.repoSync,
            status: "retrying",
          }),
          name: OBSERVABILITY_METRIC_NAMES.queueRetriesTotal,
        }),
        expect.objectContaining({
          labels: expect.objectContaining({
            error_class: "unknown_error",
            job_type: JOB_TYPES.SyncInstallation,
            queue_name: QUEUE_NAMES.repoSync,
            status: "failed",
          }),
          name: OBSERVABILITY_METRIC_NAMES.queueJobsFailedTotal,
        }),
      ]),
    );
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

  it("skips canceled durable jobs without running handlers", async () => {
    const store = new InMemoryDurableJobStore([durableJob({ status: "canceled" })]);
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
    ).resolves.toBeUndefined();

    expect(handled).toEqual([]);
    expect(store.list()[0]).toMatchObject({ attempts: 0, status: "canceled" });
  });

  it("does not complete a running durable job that is canceled before handler return", async () => {
    const store = new InMemoryDurableJobStore([durableJob({ status: "queued" })]);
    const processor = createDurableJobProcessor({
      heartbeatIntervalMs: 1,
      store,
      handlers: {
        [JOB_TYPES.SyncInstallation]: async () => {
          const runningJob = store.list()[0];
          if (!runningJob) {
            throw new Error("Expected a running durable job.");
          }

          store.add({
            ...runningJob,
            completedAt: new Date("2026-05-08T00:30:00.000Z"),
            status: "canceled",
            updatedAt: new Date("2026-05-08T00:30:00.000Z"),
          });
        },
      },
    });

    await expect(
      processor({ data: syncInstallationEnvelope, attemptsMade: 0 } as never),
    ).resolves.toBeUndefined();

    expect(store.list()[0]).toMatchObject({ attempts: 1, status: "canceled" });
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
      traceContext: {
        requestId: "req_queue_test",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
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

    const job = await queue.getJob(bullMqJobIdForIdempotencyKey(envelope.idempotencyKey));
    expect(job?.name).toBe(JOB_TYPES.SyncInstallation);
    expect(job?.data).toMatchObject({ idempotencyKey: envelope.idempotencyKey });
  });
});
