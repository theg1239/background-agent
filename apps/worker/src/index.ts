import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Redis from "ioredis";
import { TaskQueue, TaskStore, DEFAULT_LEASE_MS } from "@background-agent/shared";
import type { TaskEvent } from "@background-agent/shared";
import { Server as SocketIOServer } from "socket.io";
import { config } from "./config";
import { runTaskWithAgent } from "./task-runner";
import { SocketTaskBroadcaster, registerSocketHandlers } from "./socket-broadcaster";

const workerId = process.env.WORKER_ID ?? randomUUID();

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false
});

const httpServer = createServer();
const io = new SocketIOServer({
  cors: {
    origin: config.socketCorsOrigin,
    methods: ["GET", "POST"]
  }
});

io.attach(httpServer);

registerSocketHandlers(io);

const broadcaster = new SocketTaskBroadcaster(io);
const store = new TaskStore(redis);
const queue = new TaskQueue(redis, store);

const LEASE_RENEW_INTERVAL_MS = Math.max(15_000, Math.floor(DEFAULT_LEASE_MS / 2));

const startLeaseKeepAlive = (taskId: string) => {
  let stopped = false;

  const renew = async () => {
    if (stopped) return;
    try {
      const extended = await queue.extendLease(taskId, workerId, {
        ttlMs: DEFAULT_LEASE_MS
      });
      if (!extended && !stopped) {
        console.warn(
          `Worker ${workerId} failed to extend lease for task ${taskId}; task may be requeued.`
        );
      }
    } catch (error) {
      if (!stopped) {
        console.error(
          `Worker ${workerId} encountered an error extending lease for task ${taskId}.`,
          error
        );
      }
    }
  };

  const timer = setInterval(() => {
    void renew();
  }, LEASE_RENEW_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  void renew();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

httpServer.listen(config.socketPort, config.socketHost, () => {
  console.log(
    `Socket server listening on ${config.socketHost}:${config.socketPort} (worker ${workerId})`
  );
});

async function emitTaskUpdate(taskId: string) {
  const updated = await store.getTask(taskId);
  if (updated) {
    await broadcaster.publishTaskUpdate(updated);
  }
}

async function emitTaskEvent(taskId: string, event: TaskEvent) {
  await broadcaster.publishTaskEvent(taskId, event);
  await emitTaskUpdate(taskId);
}

async function processLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const blockSeconds = Math.max(1, Math.floor(config.pollIntervalMs / 1000));
      const claim = await queue.claim(workerId, { blockSeconds });
      if (!claim) {
        continue;
      }

      const { task, input } = claim;
      const stopLeaseKeepAlive = startLeaseKeepAlive(task.id);

      await store.updateStatus(task.id, "planning", { workerId });
      await emitTaskUpdate(task.id);

      try {
        const result = await runTaskWithAgent({
          store,
          workerId,
          task,
          input,
          notifyTaskUpdate: emitTaskUpdate,
          notifyTaskEvent: emitTaskEvent
        });

        if (!result.success) {
          throw new Error("Agent did not report success");
        }

        await queue.ack(task.id);
      } catch (error) {
        const failureEvent = {
          id: randomUUID(),
          taskId: task.id,
          type: "task.failed",
          timestamp: Date.now(),
          payload: {
            status: "failed",
            error: (error as Error).message,
            workerId
          }
        } satisfies TaskEvent;
        await store.appendEvent(task.id, failureEvent);
        await emitTaskEvent(task.id, failureEvent);
        await queue.ack(task.id);
      } finally {
        stopLeaseKeepAlive();
      }
    } catch (outerError) {
      console.error("Worker loop error", outerError);
      await sleep(config.pollIntervalMs);
    }
  }
}

processLoop().catch((error) => {
  console.error("Unrecoverable worker error", error);
  process.exit(1);
});
