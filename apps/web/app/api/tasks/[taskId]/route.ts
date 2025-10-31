import { NextResponse } from "next/server";
import { taskStore } from "@/lib/server/task-store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await context.params;

  const task = await taskStore.getTask(taskId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const snapshot = await taskStore.getEventStreamSnapshot(taskId);
  return NextResponse.json(snapshot ?? { task, events: [] });
}
