import {
  CreateTaskInput,
  Task,
  TaskEvent,
  TaskEventType,
  TaskEventTypeSchema,
  TaskStatus,
  TaskStatusSchema,
  TaskEventStreamSnapshot
} from "@background-agent/shared";
import { getRedis } from "./redis";

const encoder = new TextEncoder();
const TASK_INDEX_KEY = "tasks:index";
const TASK_KEY_PREFIX = "tasks:item:";
const TASK_EVENTS_KEY_PREFIX = "tasks:events:";
const TASK_EVENTS_STREAM_PREFIX = "tasks:events_stream:";

interface TaskRecord extends Task {
  input: CreateTaskInput;
  latestStreamId?: string;
}

class TaskRepository {
  private redis = getRedis();

  private taskKey(taskId: string) {
    return `${TASK_KEY_PREFIX}${taskId}`;
  }

  private eventsKey(taskId: string) {
    return `${TASK_EVENTS_KEY_PREFIX}${taskId}`;
  }

  private eventsStreamKey(taskId: string) {
    return `${TASK_EVENTS_STREAM_PREFIX}${taskId}`;
  }

  private sanitize(record: TaskRecord): Task {
    const { input: _input, latestStreamId: _latestStreamId, ...task } = record;
    return task;
  }

  private async getTaskRecord(taskId: string): Promise<TaskRecord | undefined> {
    const raw = await this.redis.get(this.taskKey(taskId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as TaskRecord;
    } catch (error) {
      console.error("Failed to parse task record", { taskId, error });
      return undefined;
    }
  }

  async listTasks(): Promise<Task[]> {
    const ids = await this.redis.smembers(TASK_INDEX_KEY);
    if (ids.length === 0) return [];

    const tasks: Task[] = [];
    const records = await Promise.all(ids.map((id) => this.redis.get(this.taskKey(id))));
    records.forEach((value) => {
      if (!value) return;
      try {
        const record = JSON.parse(value) as TaskRecord;
        tasks.push(this.sanitize(record));
      } catch (error) {
        console.error("Failed to parse task during list", error);
      }
    });

    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const record = await this.getTaskRecord(taskId);
    return record ? this.sanitize(record) : undefined;
  }

  async getTaskForWorker(taskId: string): Promise<{ task: Task; input: CreateTaskInput } | undefined> {
    const record = await this.getTaskRecord(taskId);
    if (!record) return undefined;
    return {
      task: this.sanitize(record),
      input: record.input
    };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
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
      latestEventId: undefined,
      assignee: undefined,
      riskScore: 0.2,
      input,
      latestStreamId: undefined
    };

    const creationEvent: TaskEvent = {
      id: crypto.randomUUID(),
      taskId: id,
      type: "task.created",
      timestamp: now,
      payload: {
        title: task.title,
        description: task.description
      }
    };

    const pipeline = this.redis.pipeline();
    pipeline.sadd(TASK_INDEX_KEY, id);
    pipeline.set(this.taskKey(id), JSON.stringify(task));
    await pipeline.exec();

    await this.appendEvent(id, creationEvent);

    return this.sanitize({ ...task, latestEventId: creationEvent.id });
  }

  async updateStatus(taskId: string, status: TaskStatus, payload?: Record<string, unknown>) {
    const record = await this.getTaskRecord(taskId);
    if (!record) throw new Error(`Task ${taskId} not found`);

    record.status = status;
    record.updatedAt = Date.now();

    const event: TaskEvent = {
      id: crypto.randomUUID(),
      taskId,
      type: "task.updated",
      timestamp: record.updatedAt,
      payload: {
        status,
        ...payload
      }
    };

    await this.persistEvent(record, event);
  }

  async appendEvent(taskId: string, event: TaskEvent) {
    if (!TaskEventTypeSchema.safeParse(event.type).success) {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    const record = await this.getTaskRecord(taskId);
    if (!record) throw new Error(`Task ${taskId} not found`);

    record.updatedAt = Date.now();
    record.latestEventId = event.id;

    if (event.payload) {
      const payload = event.payload as Record<string, unknown>;
      if ("plan" in payload && Array.isArray(payload.plan)) {
        record.plan = payload.plan as Task["plan"];
      }
      if ("status" in payload && typeof payload.status === "string") {
        const parsed = TaskStatusSchema.safeParse(payload.status);
        if (parsed.success) {
          record.status = parsed.data;
        }
      }
    }

    await this.persistEvent(record, event);
  }

  private async persistEvent(record: TaskRecord, event: TaskEvent) {
    const streamId = await this.redis.xadd(
      this.eventsStreamKey(record.id),
      "*",
      { event: JSON.stringify(event) },
      { trim: { strategy: "maxlen", threshold: 2000 } }
    );

    record.latestStreamId = streamId;

    const pipeline = this.redis.pipeline();
    pipeline.set(this.taskKey(record.id), JSON.stringify(record));
    pipeline.rpush(this.eventsKey(record.id), JSON.stringify(event));
    await pipeline.exec();
  }

  async getEventStreamSnapshot(taskId: string): Promise<TaskEventStreamSnapshot | undefined> {
    const record = await this.getTaskRecord(taskId);
    if (!record) return undefined;

    const eventsRaw = await this.redis.lrange(this.eventsKey(taskId), 0, -1);
    const events: TaskEvent[] = eventsRaw
      .map((value) => {
        try {
          return JSON.parse(value) as TaskEvent;
        } catch (error) {
          console.error("Failed to parse event", { taskId, error });
          return undefined;
        }
      })
      .filter((event): event is TaskEvent => Boolean(event));

    return {
      task: this.sanitize(record),
      events,
      cursor: record.latestStreamId
    };
  }

  async getLatestStreamCursor(taskId: string): Promise<string | undefined> {
    const record = await this.getTaskRecord(taskId);
    return record?.latestStreamId;
  }

  async readEventsFromStream(
    taskId: string,
    lastSeenId: string,
    { blockMs = 5_000, count = 20 }: { blockMs?: number; count?: number }
  ): Promise<{ events: TaskEvent[]; cursor: string } | undefined> {
    const responses = await this.redis.xread<TaskEvent>(
      [{ key: this.eventsStreamKey(taskId), id: lastSeenId }],
      { block: blockMs, count }
    );

    if (!responses || responses.length === 0) {
      return undefined;
    }

    const [, entries] = responses[0];
    let cursor = lastSeenId;
    const events: TaskEvent[] = [];

    for (const [id, fields] of entries) {
      const payload = fields.event ?? fields.data;
      if (typeof payload !== "string") continue;
      try {
        const event = JSON.parse(payload) as TaskEvent;
        events.push(event);
        cursor = id;
      } catch (error) {
        console.error("Failed to parse streamed event", { taskId, error });
      }
    }

    if (events.length === 0) {
      return undefined;
    }

    return { events, cursor };
  }
}

const globalForTaskRepo = globalThis as unknown as {
  __taskRepository?: TaskRepository;
};

export const taskStore =
  globalForTaskRepo.__taskRepository ?? (globalForTaskRepo.__taskRepository = new TaskRepository());

export function serializeSSE(data: { event: TaskEventType | "snapshot"; data: unknown }) {
  const payload = JSON.stringify(data.data);
  return encoder.encode(`event: ${data.event}\ndata: ${payload}\n\n`);
}
