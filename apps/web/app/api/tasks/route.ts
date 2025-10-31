import { NextRequest, NextResponse } from "next/server";
import type { CreateTaskInput } from "@background-agent/shared";
import { CreateTaskInputSchema } from "@background-agent/shared";
import { taskStore } from "@/lib/server/task-store";
import { enqueueTaskExecution } from "@/lib/server/worker-dispatch";

export async function GET() {
  const tasks = await taskStore.listTasks();
  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest) {
  const json = await request.json();
  const parseResult = CreateTaskInputSchema.safeParse(json);
  if (!parseResult.success) {
    return NextResponse.json({ error: parseResult.error.flatten() }, { status: 400 });
  }

  const sanitizedInput = sanitizeCreateTaskInput(parseResult.data);

  const task = await taskStore.createTask(sanitizedInput);
  await enqueueTaskExecution(task, sanitizedInput);
  return NextResponse.json({ task }, { status: 201 });
}

function sanitizeCreateTaskInput(input: CreateTaskInput): CreateTaskInput {
  const repoUrl = input.repoUrl ? normalizeRepoUrl(input.repoUrl) : undefined;
  const description = input.description?.trim();

  return {
    ...input,
    title: input.title.trim(),
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
