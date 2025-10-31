import { ChatInterface } from "../components/chat-interface";
import { taskStore } from "../lib/server/task-store";

export const revalidate = 0;

export default async function Home() {
  const tasks = await taskStore.listTasks();

  return (
    <main className="min-h-screen bg-linear-to-br from-[#0a0a0a] via-[#050505] to-[#0a0a0a] px-6 py-12 text-neutral-100">
      <div className="mx-auto max-w-6xl space-y-8">
        {/* <header className="space-y-2">
          <p className="text-sm uppercase tracking-[0.3em] text-neutral-500">Background Agent</p>
          <h1 className="text-3xl font-semibold text-white">Autonomous coding tasks that keep running</h1>
          <p className="max-w-2xl text-sm text-neutral-400">
            Create a task and the agent continues to plan, execute, and checkpoint progress—even while you step
            away. When you return, reconnect to a live stream of events and approvals.
          </p>
        </header> */}
        <ChatInterface initialTasks={tasks} />
      </div>
    </main>
  );
}
