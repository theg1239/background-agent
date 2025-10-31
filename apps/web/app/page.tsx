import { ChatInterface } from "../components/chat-interface";
import { taskStore } from "../lib/server/task-store";
import { getOrCreateGitHubAuthState } from "../lib/server/github-auth";

export const revalidate = 0;

export default async function Home() {
  const [tasks, githubAuth] = await Promise.all([
    taskStore.listTasks(),
    getOrCreateGitHubAuthState()
  ]);

  return (
    <main className="flex min-h-[100dvh] max-h-[100dvh] w-full overflow-hidden bg-linear-to-br from-[#0a0a0a] via-[#050505] to-[#0a0a0a] text-neutral-100">
      <div className="mx-auto flex w-full max-w-7xl flex-1 min-h-0 flex-col px-6 py-8">
        <ChatInterface initialTasks={tasks} initialGitHubAuth={githubAuth} />
      </div>
    </main>
  );
}
