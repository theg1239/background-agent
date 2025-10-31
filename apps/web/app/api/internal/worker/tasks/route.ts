import { NextRequest, NextResponse } from "next/server";
import { taskQueue } from "@/lib/server/task-queue";
import { taskStore } from "@/lib/server/task-store";
import { assertInternalRequest } from "@/lib/server/internal-auth";

export async function POST(request: NextRequest) {
  try {
    assertInternalRequest(request);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const workerId = typeof body.workerId === "string" ? body.workerId : undefined;

  if (!workerId) {
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  }

  await taskQueue.requeueLeases();
  const claim = await taskQueue.claim(workerId);
  if (!claim) {
    return new NextResponse(null, { status: 204 });
  }

  await taskStore.updateStatus(claim.task.id, "planning", { workerId });

  return NextResponse.json(claim);
}
