import { NextRequest, NextResponse } from "next/server";
import { taskStore } from "../../../../../lib/server/task-store";
import { getSessionId } from "../../../../../lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskId?: string | string[] }> }
) {
  await getSessionId();

  const resolvedParams = await context.params;

  const rawTaskId = resolvedParams?.taskId;
  const candidate = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
  const taskIdFromParams = typeof candidate === "string" ? candidate.trim() : undefined;

  let taskId = taskIdFromParams;

  if (!taskId) {
    const segments = request.nextUrl.pathname.split("/").filter(Boolean);
    const tasksIndex = segments.indexOf("tasks");
    if (tasksIndex >= 0 && segments.length > tasksIndex + 1) {
      taskId = segments[tasksIndex + 1]?.trim() ?? undefined;
    }
  }

  if (!taskId) {
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
