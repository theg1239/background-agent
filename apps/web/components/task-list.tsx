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
                  ? "border-white/30 bg-neutral-900 shadow"
                  : "border-neutral-800 bg-neutral-950 hover:border-neutral-700"
              )}
            >
              <div>
                <p className="text-sm font-semibold text-white">{task.title}</p>
                {task.description ? (
                  <p className="mt-1 text-xs text-neutral-400">{task.description}</p>
                ) : null}
              </div>
              <span className="ml-4 rounded-full bg-neutral-800 px-3 py-1 text-xs font-medium uppercase tracking-wide text-neutral-200">
                {task.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
