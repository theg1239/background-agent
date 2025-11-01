import type Redis from "ioredis";
import type { CreateTaskInput, Task } from "./types";
import { TaskStore } from "./task-store";

const QUEUE_KEY = "tasks:queue";
const PENDING_SET_KEY = "tasks:queue:pending";
const LEASE_HASH_KEY = "tasks:leases";
const LEASE_ZSET_KEY = "tasks:lease_expirations";
export const DEFAULT_LEASE_MS = 60_000;

export interface TaskClaim {
  task: Task;
  input: CreateTaskInput;
}

export class TaskQueue {
  constructor(private readonly redis: Redis, private readonly store: TaskStore) {}

  async enqueue(taskId: string) {
    const added = await this.redis.sadd(PENDING_SET_KEY, taskId);
    if (added === 0) {
      return;
    }
    await this.redis.rpush(QUEUE_KEY, taskId);
  }

  async claim(workerId: string, options?: { blockSeconds?: number }): Promise<TaskClaim | undefined> {
    const blockSeconds = Math.max(1, Math.floor(options?.blockSeconds ?? 5));

    while (true) {
      await this.requeueLeases();

      const result = await this.redis.blpop(QUEUE_KEY, blockSeconds);
      if (!result) {
        return undefined;
      }

      const taskId = Array.isArray(result) ? result[1] : result;
      if (!taskId) {
        continue;
      }

      const removed = await this.redis.srem(PENDING_SET_KEY, taskId);
      if (removed === 0) {
        continue;
      }

      const now = Date.now();
      const leaseData = JSON.stringify({ workerId, leasedAt: now });
      const acquired = await this.redis.hsetnx(LEASE_HASH_KEY, taskId, leaseData);
      if (acquired === 0) {
        continue;
      }

      await this.redis.zadd(LEASE_ZSET_KEY, now + DEFAULT_LEASE_MS, taskId);

      const record = await this.store.getTaskForWorker(taskId);
      if (!record) {
        await this.redis.hdel(LEASE_HASH_KEY, taskId);
        await this.redis.zrem(LEASE_ZSET_KEY, taskId);
        await this.enqueue(taskId);
        continue;
      }

      return record;
    }
  }

  async ack(taskId: string) {
    await this.redis.hdel(LEASE_HASH_KEY, taskId);
    await this.redis.zrem(LEASE_ZSET_KEY, taskId);
    await this.redis.srem(PENDING_SET_KEY, taskId);
  }

  async requeue(taskId: string) {
    await this.redis.hdel(LEASE_HASH_KEY, taskId);
    await this.redis.zrem(LEASE_ZSET_KEY, taskId);
    await this.enqueue(taskId);
  }

  async extendLease(
    taskId: string,
    workerId: string,
    options?: { ttlMs?: number }
  ): Promise<boolean> {
    const leaseDataRaw = await this.redis.hget(LEASE_HASH_KEY, taskId);
    if (!leaseDataRaw) {
      return false;
    }

    let leaseData: {
      workerId?: string;
      leasedAt?: number;
      renewals?: number;
      renewedAt?: number;
    };
    try {
      leaseData = JSON.parse(leaseDataRaw);
    } catch {
      leaseData = {};
    }

    if (leaseData.workerId && leaseData.workerId !== workerId) {
      return false;
    }

    const now = Date.now();
    const ttl = Math.max(
      15_000,
      Math.min(options?.ttlMs ?? DEFAULT_LEASE_MS, DEFAULT_LEASE_MS * 5)
    );

    leaseData.workerId = workerId;
    leaseData.renewals = (leaseData.renewals ?? 0) + 1;
    leaseData.renewedAt = now;

    await this.redis.hset(LEASE_HASH_KEY, taskId, JSON.stringify(leaseData));
    await this.redis.zadd(LEASE_ZSET_KEY, now + ttl, taskId);
    return true;
  }

  async requeueLeases() {
    const now = Date.now();
    const expiredTaskIds = await this.redis.zrangebyscore(LEASE_ZSET_KEY, "-inf", now);
    if (expiredTaskIds.length === 0) return;

    for (const taskId of expiredTaskIds) {
      await this.redis.hdel(LEASE_HASH_KEY, taskId);
      await this.redis.zrem(LEASE_ZSET_KEY, taskId);
      await this.enqueue(taskId);
    }
  }
}
