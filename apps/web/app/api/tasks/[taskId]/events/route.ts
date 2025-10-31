import { NextRequest, NextResponse } from "next/server";
import { taskStore } from "../../../../../lib/server/task-store";
import { getSessionId } from "../../../../../lib/server/session";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { taskId?: string | string[] } }
) {
  await getSessionId();

  const rawTaskId = params?.taskId;
  const candidate = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
  const taskIdFromParams = typeof candidate === "string" ? candidate.trim() : undefined;

  const taskId = taskIdFromParams ?? request.nextUrl.pathname.split("/")[3]?.trim();

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
