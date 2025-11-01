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

type LogLevel = "debug" | "info" | "warn" | "error";

const toErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const formatPreview = (value: string | undefined, maxLength = 240) => {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
};

const log = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  let contextSuffix = "";
  if (context && Object.keys(context).length > 0) {
    try {
      contextSuffix = ` ${JSON.stringify(context)}`;
    } catch {
      contextSuffix = " [context serialization failed]";
    }
  }
  const line = `[${timestamp}] [worker:${workerId}] ${message}${contextSuffix}`;
  const method =
    level === "error"
      ? console.error
      : level === "warn"
      ? console.warn
      : level === "debug"
      ? console.debug
      : console.log;
  method(line);
};

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

  log("debug", "Starting lease keep-alive", {
    taskId,
    intervalMs: LEASE_RENEW_INTERVAL_MS
  });

  const renew = async () => {
    if (stopped) return;
    try {
      const extended = await queue.extendLease(taskId, workerId, {
        ttlMs: DEFAULT_LEASE_MS
      });
      if (!extended && !stopped) {
        log("warn", "Failed to extend task lease; task may be requeued.", { taskId });
      }
    } catch (error) {
      if (!stopped) {
        log("error", "Error extending task lease", {
          taskId,
          error: toErrorMessage(error)
        });
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
    log("debug", "Stopped lease keep-alive", { taskId });
  };
};

httpServer.listen(config.socketPort, config.socketHost, () => {
  log("info", "Socket server listening", {
    host: config.socketHost,
    port: config.socketPort
  });
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
  log("info", "Worker process loop started", {
    pollIntervalMs: config.pollIntervalMs,
    provider: config.aiProvider,
    model:
      config.aiProvider === "gemini"
        ? config.geminiModelName
        : config.openrouterModelName
  });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const blockSeconds = Math.max(1, Math.floor(config.pollIntervalMs / 1000));
      const claim = await queue.claim(workerId, { blockSeconds });
      if (!claim) {
        continue;
      }

      const { task, input } = claim;
      log("info", "Claimed task", {
        taskId: task.id,
        title: task.title,
        repoUrl: input.repoUrl,
        baseBranch: input.baseBranch,
        branch: input.branch
      });
      const stopLeaseKeepAlive = startLeaseKeepAlive(task.id);

      await store.updateStatus(task.id, "planning", { workerId });
      await emitTaskUpdate(task.id);
      log("info", "Task status updated to planning", { taskId: task.id });

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

        log("info", "Task completed successfully", {
          taskId: task.id,
          summary: formatPreview(result.summary, 240) || "(empty)"
        });
        await queue.ack(task.id);
        log("info", "Acknowledged task", { taskId: task.id });
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        log("error", "Task execution failed", {
          taskId: task.id,
          error: errorMessage
        });
        const failureEvent = {
          id: randomUUID(),
          taskId: task.id,
          type: "task.failed",
          timestamp: Date.now(),
          payload: {
            status: "failed",
            error: errorMessage,
            workerId
          }
        } satisfies TaskEvent;
        await store.appendEvent(task.id, failureEvent);
        await emitTaskEvent(task.id, failureEvent);
        await queue.ack(task.id);
        log("warn", "Acknowledged failed task", { taskId: task.id });
      } finally {
        stopLeaseKeepAlive();
        log("debug", "Lease keep-alive callback executed", { taskId: task.id });
      }
    } catch (outerError) {
      log("error", "Worker loop error", { error: toErrorMessage(outerError) });
      await sleep(config.pollIntervalMs);
      log("info", "Retrying after delay", { delayMs: config.pollIntervalMs });
    }
  }
}

processLoop().catch((error) => {
  log("error", "Unrecoverable worker error", { error: toErrorMessage(error) });
  process.exit(1);
});
