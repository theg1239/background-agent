import { NextRequest, NextResponse } from "next/server";
import { taskStore, serializeSSE } from "@/lib/server/task-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const tasks = await taskStore.listTasks();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(serializeSSE({ event: "snapshot", data: { tasks } }));

      let cursor = "$";
      let active = true;

      const abort = () => {
        active = false;
        controller.close();
      };

      request.signal.addEventListener("abort", abort);

      while (active) {
        try {
          const result = await taskStore.readTaskIndexStream(cursor, {
            blockMs: 5_000,
            count: 100
          });
          if (!result) {
            continue;
          }

          for (const task of result.tasks) {
            controller.enqueue(serializeSSE({ event: "task", data: task }));
          }

          cursor = result.cursor;
        } catch (error) {
          console.error("Task index stream error", error);
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
