import { NextRequest, NextResponse } from "next/server";
import { taskQueue } from "@/lib/server/task-queue";
import { taskStore } from "@/lib/server/task-store";
import { assertInternalRequest } from "@/lib/server/internal-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: { taskId: string } }
) {
  try {
    assertInternalRequest(request);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const requeue = Boolean(body?.requeue);

  if (requeue) {
    await taskQueue.requeue(params.taskId);
    await taskStore.updateStatus(params.taskId, "queued");
  } else {
    await taskQueue.ack(params.taskId);
  }

  return NextResponse.json({ ok: true });
}
