import { CreateTaskInput, Task } from "@background-agent/shared";
import { redis } from "./redis";
import { taskStore } from "./task-store";

const QUEUE_KEY = "tasks:queue";
const PENDING_SET_KEY = "tasks:queue:pending";
const LEASE_HASH_KEY = "tasks:leases";
const LEASE_ZSET_KEY = "tasks:lease_expirations";
const LEASE_MS = 60_000;

interface TaskClaim {
  task: Task;
  input: CreateTaskInput;
}

class TaskQueue {
  private redis = redis;

  async enqueue(taskId: string) {
    const added = await this.redis.sadd(PENDING_SET_KEY, taskId);
    if (added === 0) {
      return;
    }
    await this.redis.rpush(QUEUE_KEY, taskId);
  }

  async claim(workerId: string): Promise<TaskClaim | undefined> {
    await this.requeueLeases();

    while (true) {
      const taskId = await this.redis.lpop<string>(QUEUE_KEY);
      if (!taskId) {
        return undefined;
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

      await this.redis.zadd(LEASE_ZSET_KEY, now + LEASE_MS, taskId);

      const record = await taskStore.getTaskForWorker(taskId);
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

const globalForQueue = globalThis as unknown as {
  __taskQueue?: TaskQueue;
};

export const taskQueue =
  globalForQueue.__taskQueue ?? (globalForQueue.__taskQueue = new TaskQueue());
