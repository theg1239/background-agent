import { NextRequest, NextResponse } from "next/server";
import { TaskEventSchema } from "@background-agent/shared";
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

  const json = await request.json();
  const parsed = TaskEventSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await taskStore.appendEvent(params.taskId, parsed.data);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}
