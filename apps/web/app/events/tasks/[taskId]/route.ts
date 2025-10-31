import { NextRequest, NextResponse } from "next/server";
import { taskStore, serializeSSE } from "@/lib/server/task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await context.params;
  const snapshot = await taskStore.getEventStreamSnapshot(taskId);
  if (!snapshot) {
    return new NextResponse(null, { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(serializeSSE({ event: "snapshot", data: snapshot }));

      let cursor = snapshot.cursor ?? (await taskStore.getLatestStreamCursor(taskId)) ?? "0-0";
      let active = true;

      const abort = () => {
        active = false;
        controller.close();
      };

      request.signal.addEventListener("abort", abort);

      while (active) {
        try {
          const result = await taskStore.readEventsFromStream(taskId, cursor, {
            blockMs: 5_000,
            count: 50
          });

          if (!result) {
            continue;
          }

          for (const event of result.events) {
            controller.enqueue(serializeSSE({ event: event.type, data: event }));
          }

          cursor = result.cursor;
        } catch (error) {
          console.error("Event stream error", error);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
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
