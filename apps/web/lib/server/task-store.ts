import { EventEmitter } from "node:events";
import {
  CreateTaskInput,
  Task,
  TaskEvent,
  TaskEventType,
  TaskStatus,
  TaskStatusSchema
} from "@background-agent/shared";

const encoder = new TextEncoder();

type TaskRecord = Task & {
  events: TaskEvent[];
  input: CreateTaskInput;
};

class TaskStore {
  private tasks = new Map<string, TaskRecord>();
  private eventEmitter = new EventEmitter();

  listTasks(): Task[] {
    return Array.from(this.tasks.values()).map(({ events: _events, input: _input, ...task }) => task);
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const { events: _events, input: _input, ...rest } = task;
    return rest;
  }

  getTaskWithEvents(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  createTask(input: CreateTaskInput): Task {
    const id = crypto.randomUUID();
    const now = Date.now();
    const task: TaskRecord = {
      id,
      title: input.title,
      description: input.description,
      repoUrl: input.repoUrl,
      status: "queued",
      plan: [],
      createdAt: now,
      updatedAt: now,
      events: [],
      riskScore: 0.2,
      input
    };

    this.tasks.set(id, task);

    this.appendEvent(id, {
      id: crypto.randomUUID(),
      taskId: id,
      type: "task.created",
      timestamp: now,
      payload: {
        title: task.title,
        description: task.description
      }
    });

    return this.getTask(id)!;
  }

  updateStatus(taskId: string, status: TaskStatus, payload?: Record<string, unknown>) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.status = status;
    task.updatedAt = Date.now();
    this.appendEvent(taskId, {
      id: crypto.randomUUID(),
      taskId,
      type: "task.updated",
      timestamp: Date.now(),
      payload: {
        status,
        ...payload
      }
    });
  }

  appendEvent(taskId: string, event: TaskEvent) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.events.push(event);
    task.latestEventId = event.id;

    if (event.payload) {
      const payload = event.payload as Record<string, unknown>;
      if ("plan" in payload && Array.isArray(payload.plan)) {
        task.plan = payload.plan as Task["plan"];
      }
      if ("status" in payload && typeof payload.status === "string") {
        const parsed = TaskStatusSchema.safeParse(payload.status);
        if (parsed.success) {
          task.status = parsed.data;
        }
      }
    }

    task.updatedAt = Date.now();
    this.eventEmitter.emit(this.eventKey(taskId), event);
  }

  subscribe(taskId: string, onEvent: (event: TaskEvent) => void) {
    const key = this.eventKey(taskId);
    this.eventEmitter.on(key, onEvent);
    return () => this.eventEmitter.off(key, onEvent);
  }

  getEventStreamSnapshot(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return {
      task: this.getTask(taskId)!,
      events: [...task.events]
    };
  }

  private eventKey(taskId: string) {
    return `task:${taskId}`;
  }
}

const globalForTaskStore = globalThis as unknown as {
  __taskStore?: TaskStore;
};

export const taskStore =
  globalForTaskStore.__taskStore ?? (globalForTaskStore.__taskStore = new TaskStore());

export function serializeSSE(data: { event: TaskEventType | "snapshot"; data: unknown }) {
  const payload = JSON.stringify(data.data);
  return encoder.encode(`event: ${data.event}\ndata: ${payload}\n\n`);
}
