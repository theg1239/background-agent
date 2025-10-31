import { NextResponse } from "next/server";
import { taskStore } from "@/lib/server/task-store";

export async function GET(
  _request: Request,
  { params }: { params: { taskId: string } }
) {
  const task = taskStore.getTask(params.taskId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const snapshot = taskStore.getEventStreamSnapshot(params.taskId);
  return NextResponse.json(snapshot ?? { task, events: [] });
}
