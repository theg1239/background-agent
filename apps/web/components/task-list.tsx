"use client";

import { clsx } from "clsx";
import { Task } from "@background-agent/shared";

interface Props {
  tasks: Task[];
  activeTaskId?: string;
  onSelectTask: (taskId: string) => void;
}

export function TaskList({ tasks, activeTaskId, onSelectTask }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-700/80 p-6 text-center text-sm text-zinc-400">
        No tasks yet. Create one to kick off the agent.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {tasks.map((task) => {
        const isActive = task.id === activeTaskId;
        return (
          <li key={task.id}>
            <button
              type="button"
              onClick={() => onSelectTask(task.id)}
              className={clsx(
                "flex w-full items-start justify-between rounded-xl border px-4 py-3 text-left transition",
                isActive
                  ? "border-blue-500/80 bg-blue-500/10 shadow"
                  : "border-zinc-800/80 bg-zinc-950/60 hover:border-zinc-700"
              )}
            >
              <div>
                <p className="text-sm font-semibold text-zinc-100">{task.title}</p>
                {task.description ? (
                  <p className="mt-1 text-xs text-zinc-400">{task.description}</p>
                ) : null}
              </div>
              <span className="ml-4 rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium uppercase tracking-wide text-zinc-200">
                {task.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
