import { CreateTaskInput, Task } from "@background-agent/shared";
import { taskStore } from "./task-store";
import { taskQueue } from "./task-queue";

const globalDispatch = globalThis as unknown as {
  __workerDispatcher?: WorkerDispatcher;
};

class WorkerDispatcher {
  async enqueue(task: Task, input: CreateTaskInput) {
    await taskStore.updateStatus(task.id, "queued");
    await taskQueue.enqueue(task.id);
  }
}

const dispatcher =
  globalDispatch.__workerDispatcher ??
  (globalDispatch.__workerDispatcher = new WorkerDispatcher());

export async function enqueueTaskExecution(task: Task, input: CreateTaskInput) {
  await dispatcher.enqueue(task, input);
}
