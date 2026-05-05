import { loadRuntimeConfig } from "@repo/config";
import type { JobEnvelope, JobPayload } from "@repo/contracts";
import { Queue } from "bullmq";
import IORedis from "ioredis";

/** Queue names used by Heimdall workers. */
export const QUEUE_NAMES = {
  repoSync: "repo-sync",
  indexing: "indexing",
  review: "review",
  memory: "memory",
  publishing: "publishing",
} as const;

/** Known queue name. */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Durable job intent passed from Postgres to Redis. */
export type QueueJobIntent<TPayload extends JobPayload = JobPayload> = {
  /** Queue name that receives the job. */
  readonly queueName: QueueName;
  /** Job envelope stored in the durable outbox. */
  readonly envelope: JobEnvelope<TPayload>;
};

/** Minimal queue producer interface used by ingestion code. */
export type QueueProducer = {
  /** Enqueues a job intent. */
  readonly enqueue: (intent: QueueJobIntent) => Promise<void>;
  /** Closes queue resources. */
  readonly close: () => Promise<void>;
};

/** Queue producer that records jobs in memory for tests. */
export class InMemoryQueueProducer implements QueueProducer {
  /** Jobs enqueued through this producer. */
  public readonly jobs: QueueJobIntent[] = [];

  /** Records a job intent. */
  public async enqueue(intent: QueueJobIntent): Promise<void> {
    this.jobs.push(intent);
  }

  /** No-op close method for interface compatibility. */
  public async close(): Promise<void> {}
}

/** BullMQ-backed queue producer. */
export class BullMqQueueProducer implements QueueProducer {
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  /** Creates a BullMQ queue producer. */
  public constructor(redisUrl = loadRuntimeConfig().redisUrl) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  }

  /** Enqueues a job intent with the job idempotency key as BullMQ job ID. */
  public async enqueue(intent: QueueJobIntent): Promise<void> {
    const queue = this.getQueue(intent.queueName);

    await queue.add(intent.envelope.jobType, intent.envelope, {
      jobId: intent.envelope.idempotencyKey,
      attempts: intent.envelope.maxAttempts,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }

  /** Closes BullMQ queues and Redis connection. */
  public async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection.quit();
  }

  private getQueue(queueName: QueueName): Queue {
    const existing = this.queues.get(queueName);
    if (existing) {
      return existing;
    }

    const queue = new Queue(queueName, { connection: this.connection });
    this.queues.set(queueName, queue);
    return queue;
  }
}
