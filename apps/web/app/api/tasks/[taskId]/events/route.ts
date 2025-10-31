import { NextResponse } from "next/server";
import { taskStore } from "../../../../../lib/server/task-store";
import { getSessionId } from "../../../../../lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: { taskId?: string | string[] } }
) {
  await getSessionId();

  const rawTaskId = context.params?.taskId;
  const taskId = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;

  if (!taskId || typeof taskId !== "string" || !taskId.trim()) {
    return NextResponse.json(
      { error: "Invalid task identifier." },
      { status: 400 }
    );
  }

  try {
    const snapshot = await taskStore.getEventStreamSnapshot(taskId);
    if (!snapshot) {
      return NextResponse.json(
        { error: "Task not found." },
        { status: 404 }
      );
    }

    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("Failed to load task snapshot", { error });
    return NextResponse.json(
      { error: "Failed to load task events." },
      { status: 500 }
    );
  }
}
