import { CreateTaskInput, Task } from "@background-agent/shared";
import { getRedis } from "./redis";
import { taskStore } from "./task-store";

const QUEUE_KEY = "tasks:queue";
const LEASE_HASH_KEY = "tasks:leases";
const LEASE_ZSET_KEY = "tasks:lease_expirations";
const LEASE_MS = 60_000;

interface TaskClaim {
  task: Task;
  input: CreateTaskInput;
}

class TaskQueue {
  private redis = getRedis();

  async enqueue(taskId: string) {
    const alreadyQueued = await this.redis.lpos(QUEUE_KEY, taskId).catch(() => null);
    const leaseExists = (await this.redis.hexists(LEASE_HASH_KEY, taskId)) === 1;
    if (alreadyQueued !== null || leaseExists) {
      return;
    }
    await this.redis.rpush(QUEUE_KEY, taskId);
  }

  async claim(workerId: string): Promise<TaskClaim | undefined> {
    await this.requeueLeases();

    while (true) {
      const taskId = await this.redis.lpop(QUEUE_KEY);
      if (!taskId) {
        return undefined;
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
        continue;
      }

      return record;
    }
  }

  async release(taskId: string) {
    await this.redis.multi().hdel(LEASE_HASH_KEY, taskId).zrem(LEASE_ZSET_KEY, taskId).exec();
  }

  async ack(taskId: string) {
    await this.redis
      .multi()
      .hdel(LEASE_HASH_KEY, taskId)
      .zrem(LEASE_ZSET_KEY, taskId)
      .exec();
  }

  async requeue(taskId: string) {
    await this.redis
      .multi()
      .hdel(LEASE_HASH_KEY, taskId)
      .zrem(LEASE_ZSET_KEY, taskId)
      .exec();
    await this.enqueue(taskId);
  }

  async requeueLeases() {
    const now = Date.now();
    const expiredTaskIds = await this.redis.zrangebyscore(LEASE_ZSET_KEY, 0, now);
    if (expiredTaskIds.length === 0) return;

    for (const taskId of expiredTaskIds) {
      await this.redis
        .multi()
        .hdel(LEASE_HASH_KEY, taskId)
        .zrem(LEASE_ZSET_KEY, taskId)
        .exec();
      await this.enqueue(taskId);
    }
  }
}

const globalForQueue = globalThis as unknown as {
  __taskQueue?: TaskQueue;
};

export const taskQueue =
  globalForQueue.__taskQueue ?? (globalForQueue.__taskQueue = new TaskQueue());
