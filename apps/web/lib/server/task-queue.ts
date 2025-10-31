import { TaskQueue } from "@background-agent/shared/task-queue";
import { redis } from "./redis";
import { taskStore } from "./task-store";

type QueueGlobal = typeof globalThis & {
  __backgroundAgentTaskQueue?: TaskQueue;
};

const globalWithQueue = globalThis as QueueGlobal;

export const taskQueue =
  globalWithQueue.__backgroundAgentTaskQueue ??
  (globalWithQueue.__backgroundAgentTaskQueue = new TaskQueue(redis, taskStore));
