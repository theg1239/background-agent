import type { Task, TaskEvent, TaskBroadcaster } from "@background-agent/shared";
import type { Server } from "socket.io";

const taskRoom = (taskId: string) => `task:${taskId}`;

export class SocketTaskBroadcaster implements TaskBroadcaster {
  constructor(private readonly io: Server) {}

  async publishTaskUpdate(task: Task) {
    this.io.emit("task:update", task);
  }

  async publishTaskDeleted(taskId: string) {
    this.io.emit("task:deleted", { id: taskId });
  }

  async publishTaskEvent(taskId: string, event: TaskEvent) {
    const payload = { taskId, event } as const;
    this.io.to(taskRoom(taskId)).emit("task:event", payload);
  }
}

export function registerSocketHandlers(io: Server) {
  io.on("connection", (socket) => {
    socket.on("task:subscribe", (taskId: string) => {
      if (typeof taskId !== "string") return;
      const normalized = taskId.trim();
      if (!normalized) return;
      socket.join(taskRoom(normalized));
    });

    socket.on("task:unsubscribe", (taskId: string) => {
      if (typeof taskId !== "string") return;
      const normalized = taskId.trim();
      if (!normalized) return;
      socket.leave(taskRoom(normalized));
    });
  });
}
