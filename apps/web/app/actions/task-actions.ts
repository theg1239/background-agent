"use server";

import { CreateTaskInputSchema, type CreateTaskInput } from "@background-agent/shared";
import { taskStore } from "@/lib/server/task-store";
import { enqueueTaskExecution } from "@/lib/server/worker-dispatch";

function sanitizeCreateTaskInput(input: CreateTaskInput): CreateTaskInput {
  const title = input.title.trim();
  const description = input.description?.trim();
  const repoUrl = input.repoUrl ? normalizeRepoUrl(input.repoUrl) : undefined;

  return {
    ...input,
    title,
    description: description ? description : undefined,
    repoUrl
  };
}

function normalizeRepoUrl(original: string): string | undefined {
  const trimmed = original.trim();
  if (!trimmed) return undefined;

  const firstProtocol = trimmed.indexOf("://");
  if (firstProtocol !== -1) {
    const secondProtocol = trimmed.indexOf("://", firstProtocol + 3);
    if (secondProtocol !== -1) {
      return trimmed.slice(0, secondProtocol);
    }
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export async function createTaskAction(input: CreateTaskInput) {
  const parsed = CreateTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors[0]?.message ?? "Invalid input";
    return { ok: false, error: message } as const;
  }

  const sanitized = sanitizeCreateTaskInput(parsed.data);

  try {
    const task = await taskStore.createTask(sanitized);
    await enqueueTaskExecution(task);
    return { ok: true, task } as const;
  } catch (error) {
    return { ok: false, error: (error as Error).message } as const;
  }
}
