import { TaskDashboard } from "@/components/task-dashboard";
import { taskStore } from "@/lib/server/task-store";

export const revalidate = 0;

export default async function Home() {
  const tasks = await taskStore.listTasks();

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="space-y-2">
          <p className="text-sm uppercase tracking-[0.3em] text-blue-300/80">Background Agent</p>
          <h1 className="text-3xl font-semibold">Autonomous coding tasks that keep running</h1>
          <p className="max-w-2xl text-sm text-zinc-400">
            Create a task and the agent continues to plan, execute, and checkpoint progress—even while you step
            away. When you return, reconnect to a live stream of events and approvals.
          </p>
        </header>
        <TaskDashboard initialTasks={tasks} />
      </div>
    </main>
  );
}
