import { NextRequest, NextResponse } from "next/server";
import { taskStore, serializeSSE } from "@/lib/server/task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const { taskId } = params;
  const snapshot = await taskStore.getEventStreamSnapshot(taskId);
  if (!snapshot) {
    return new NextResponse(null, { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(serializeSSE({ event: "snapshot", data: snapshot }));

      const unsubscribe = taskStore.subscribe(taskId, (event) => {
        controller.enqueue(serializeSSE({ event: event.type, data: event }));
      });

      const abort = () => {
        unsubscribe();
        controller.close();
      };

      request.signal.addEventListener("abort", abort);
    }
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
