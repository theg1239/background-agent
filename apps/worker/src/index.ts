import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Redis from "ioredis";
import { TaskQueue, TaskStore } from "@background-agent/shared";
import { config } from "./config";
import { runTaskWithAgent } from "./task-runner";

const workerId = process.env.WORKER_ID ?? randomUUID();

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false
});

const store = new TaskStore(redis);
const queue = new TaskQueue(redis, store);

async function processLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const claim = await queue.claim(workerId);
      if (!claim) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      const { task, input } = claim;

      await store.updateStatus(task.id, "planning", { workerId });

      try {
        const result = await runTaskWithAgent({
          store,
          workerId,
          task,
          input
        });

        if (!result.success) {
          throw new Error("Agent did not report success");
        }

        await queue.ack(task.id);
      } catch (error) {
        await store.appendEvent(task.id, {
          id: randomUUID(),
          taskId: task.id,
          type: "task.failed",
          timestamp: Date.now(),
          payload: {
            status: "failed",
            error: (error as Error).message,
            workerId
          }
        });
        await queue.ack(task.id);
      }
    } catch (outerError) {
      console.error("Worker loop error", outerError);
      await sleep(config.pollIntervalMs * 2);
    }
  }
}

processLoop().catch((error) => {
  console.error("Unrecoverable worker error", error);
  process.exit(1);
});
