import { NextRequest, NextResponse } from "next/server";
import { CreateTaskInputSchema } from "@background-agent/shared";
import { taskStore } from "@/lib/server/task-store";
import { enqueueTaskExecution } from "@/lib/server/worker-dispatch";

export async function GET() {
  const tasks = taskStore.listTasks();
  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest) {
  const json = await request.json();
  const parseResult = CreateTaskInputSchema.safeParse(json);
  if (!parseResult.success) {
    return NextResponse.json({ error: parseResult.error.flatten() }, { status: 400 });
  }

  const task = taskStore.createTask(parseResult.data);
  await enqueueTaskExecution(task, parseResult.data);
  return NextResponse.json({ task }, { status: 201 });
}
