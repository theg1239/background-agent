import { TaskStore } from "@background-agent/shared";
import type { TaskEventType } from "@background-agent/shared";
import { redis } from "./redis";

const encoder = new TextEncoder();

type TaskStoreGlobal = typeof globalThis & {
  __backgroundAgentTaskStore?: TaskStore;
};

const globalWithStore = globalThis as TaskStoreGlobal;

export const taskStore =
  globalWithStore.__backgroundAgentTaskStore ??
  (globalWithStore.__backgroundAgentTaskStore = new TaskStore(redis));

export function serializeSSE(data: { event: string | TaskEventType; data: unknown }) {
  const payload = JSON.stringify(data.data);
  return encoder.encode(`event: ${data.event}\ndata: ${payload}\n\n`);
}
