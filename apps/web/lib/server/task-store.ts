import { TaskStore } from "@background-agent/shared";
import { redis } from "./redis";

type TaskStoreGlobal = typeof globalThis & {
  __backgroundAgentTaskStore?: TaskStore;
};

const globalWithStore = globalThis as TaskStoreGlobal;

export const taskStore =
  globalWithStore.__backgroundAgentTaskStore ??
  (globalWithStore.__backgroundAgentTaskStore = new TaskStore(redis));
