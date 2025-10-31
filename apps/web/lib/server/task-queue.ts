import { taskStore } from "./task-store";

type QueueItem = {
  taskId: string;
  enqueuedAt: number;
};

type Lease = {
  workerId: string;
  leasedAt: number;
};

class TaskQueue {
  private queue: QueueItem[] = [];
  private leases = new Map<string, Lease>();

  enqueue(taskId: string) {
    // avoid duplicates in queue if already enqueued or leased
    if (this.queue.some((item) => item.taskId === taskId) || this.leases.has(taskId)) {
      return;
    }

    this.queue.push({
      taskId,
      enqueuedAt: Date.now()
    });
  }

  claim(workerId: string) {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      const task = taskStore.getTaskWithEvents(next.taskId);
      if (!task) {
        continue;
      }
      if (this.leases.has(next.taskId)) {
        continue;
      }
      this.leases.set(next.taskId, {
        workerId,
        leasedAt: Date.now()
      });
      return task;
    }
    return undefined;
  }

  release(taskId: string) {
    this.leases.delete(taskId);
  }

  ack(taskId: string) {
    this.leases.delete(taskId);
  }

  requeueLeases(maxLeaseMs: number) {
    const now = Date.now();
    for (const [taskId, lease] of this.leases.entries()) {
      if (now - lease.leasedAt > maxLeaseMs) {
        this.leases.delete(taskId);
        this.enqueue(taskId);
      }
    }
  }
}

const globalForQueue = globalThis as unknown as {
  __taskQueue?: TaskQueue;
};

export const taskQueue =
  globalForQueue.__taskQueue ?? (globalForQueue.__taskQueue = new TaskQueue());
