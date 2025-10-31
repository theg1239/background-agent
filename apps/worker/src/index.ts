import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config";
import { TaskApiClient } from "./task-api";
import { runTaskWithAgent } from "./task-runner";

const workerId = process.env.WORKER_ID ?? randomUUID();
const api = new TaskApiClient(config.taskApiBaseUrl, config.taskApiToken);

async function processLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const claim = await api.claimTask(workerId);
      if (!claim) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      try {
        const result = await runTaskWithAgent({
          api,
          workerId,
          task: claim.task,
          input: claim.input
        });
        if (!result.success) {
          throw new Error("Agent did not report success");
        }
        await api.ackTask(claim.task.id, { requeue: false });
      } catch (error) {
        await api.postEvent(claim.task.id, {
          id: randomUUID(),
          taskId: claim.task.id,
          type: "task.failed",
          timestamp: Date.now(),
          payload: {
            status: "failed",
            error: (error as Error).message,
            workerId
          }
        });
        await api.ackTask(claim.task.id, { requeue: false });
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
