import { CreateTaskInput, Task, TaskEvent } from "@background-agent/shared";

export interface ClaimedTask {
  task: Task;
  input: CreateTaskInput;
}

export class TaskApiClient {
  constructor(private baseUrl: string, private token: string) {}

  private buildHeaders(additional?: Record<string, string>) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      ...additional
    } satisfies Record<string, string>;
  }

  async claimTask(workerId: string): Promise<ClaimedTask | null> {
    const res = await fetch(`${this.baseUrl}/api/internal/worker/tasks`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ workerId })
    });

    if (res.status === 204) {
      return null;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to claim task: ${res.status} ${body}`);
    }

    return (await res.json()) as ClaimedTask;
  }

  async ackTask(taskId: string, options?: { requeue?: boolean }) {
    const res = await fetch(`${this.baseUrl}/api/internal/worker/tasks/${taskId}/ack`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ requeue: options?.requeue ?? false })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to ack task: ${res.status} ${body}`);
    }
  }

  async postEvent(taskId: string, event: TaskEvent): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/internal/tasks/${taskId}/events`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(event)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to post event: ${res.status} ${body}`);
    }
  }
}
