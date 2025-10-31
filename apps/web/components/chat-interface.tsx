"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { clsx } from "clsx";
import type { Task, TaskEventStreamSnapshot } from "@background-agent/shared";
import { jsonFetcher } from "@/lib/utils/fetcher";
import { useTaskEvents } from "@/hooks/use-task-events";
import { CreateTaskForm } from "./create-task-form";

interface TasksResponse {
  tasks: Task[];
}

interface ChatInterfaceProps {
  initialTasks: Task[];
}

export function ChatInterface({ initialTasks }: ChatInterfaceProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(initialTasks[0]?.id);
  const [showHistory, setShowHistory] = useState(false);

  const { data: tasksData, mutate: mutateTasks } = useSWR<TasksResponse>(
    "/api/tasks",
    jsonFetcher,
    {
      fallbackData: { tasks: initialTasks }
    }
  );

  const tasks = tasksData?.tasks ?? initialTasks;

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId), [tasks, activeTaskId]);

  const { data: snapshot } = useSWR<TaskEventStreamSnapshot>(
    activeTaskId ? `/api/tasks/${activeTaskId}` : null,
    jsonFetcher
  );

  const { task, events, isConnected } = useTaskEvents(activeTaskId, {
    initialSnapshot: snapshot
  });

  const resolvedTask = task ?? activeTask;

  const handleTaskCreated = async (newTask: Task) => {
    await mutateTasks();
    setActiveTaskId(newTask.id);
    setShowHistory(false);
  };

  const displayedEvents = useMemo(() => {
    if (!events.length && resolvedTask) {
      return [
        {
          id: "task-placeholder",
          label: "The agent is ready",
          body: "Updates will appear here as the background agent works.",
          tone: "system",
          timestamp: resolvedTask.createdAt
        }
      ];
    }

    return events.map((event) => formatEvent(event));
  }, [events, resolvedTask]);

  return (
    <div className="relative mx-auto flex h-full w-full max-w-5xl flex-1 flex-col gap-6">
      <header className="flex items-center justify-between rounded-2xl border border-neutral-800 bg-neutral-900/60 px-6 py-4 shadow">
        <div className="space-y-1">
          <span className="text-xs uppercase tracking-[0.32em] text-neutral-500">Background Agent</span>
          <h1 className="text-2xl font-semibold text-white">Autonomous coding, human oversight</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowHistory((value) => !value)}
          className="rounded-full border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-medium text-neutral-200 transition hover:border-neutral-500 hover:text-white"
          aria-label="Toggle task history"
        >
          History
        </button>
      </header>

      <div className="relative flex flex-1 gap-4 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/70 p-6 shadow">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
            <div className="min-w-0">
              <p className="truncate text-sm uppercase tracking-wide text-neutral-500">Current task</p>
              <p className="truncate text-lg font-medium text-white">
                {resolvedTask ? resolvedTask.title : "No task selected"}
              </p>
            </div>
            <span
              className={clsx(
                "text-xs font-medium",
                isConnected ? "text-emerald-400" : "text-yellow-400"
              )}
            >
              {isConnected ? "Live" : "Reconnecting"}
            </span>
          </div>

          <div className="chat-font mt-4 flex-1 space-y-3 overflow-y-auto pr-2 text-sm text-neutral-200">
            {displayedEvents.map((event) => (
              <div
                key={`${event.id}-${event.timestamp}`}
                className={clsx(
                  "max-w-xl rounded-2xl border px-4 py-3",
                  event.tone === "agent" && "border-neutral-700 bg-neutral-950 text-neutral-100",
                  event.tone === "system" && "border-neutral-800 bg-neutral-950/60 text-neutral-300",
                  event.tone === "alert" && "border-red-500/60 bg-red-500/10 text-red-200"
                )}
              >
                <div className="flex items-center justify-between text-xs text-neutral-500">
                  <span>{event.label}</span>
                  <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-100">{event.body}</p>
                {event.detail ? (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-neutral-950/80 p-3 text-xs text-neutral-400">
                    {event.detail}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-4 border-t border-neutral-800 pt-4">
            <CreateTaskForm onCreated={handleTaskCreated} />
          </div>
        </div>

        {showHistory ? (
          <aside className="absolute right-0 top-0 flex h-full w-72 flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-950/95 p-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Task history</h2>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="rounded-full border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto text-sm">
              {tasks.length === 0 ? (
                <p className="text-neutral-500">No tasks yet.</p>
              ) : (
                tasks.map((taskItem) => (
                  <button
                    key={taskItem.id}
                    type="button"
                    onClick={() => {
                      setActiveTaskId(taskItem.id);
                      setShowHistory(false);
                    }}
                    className={clsx(
                      "w-full rounded-xl border px-3 py-2 text-left transition",
                      taskItem.id === activeTaskId
                        ? "border-white/40 bg-neutral-900 text-white"
                        : "border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600 hover:text-white"
                    )}
                  >
                    <p className="truncate text-sm font-medium">{taskItem.title}</p>
                    <p className="truncate text-xs text-neutral-500">{taskItem.status}</p>
                  </button>
                ))
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

type DisplayEvent = {
  id: string;
  label: string;
  body: string;
  detail?: string;
  tone: "agent" | "system" | "alert";
  timestamp: number;
};

function formatEvent(event: TaskEvent): DisplayEvent {
  const base = {
    id: event.id,
    timestamp: event.timestamp
  };

  switch (event.type) {
    case "log.entry": {
      const message = typeof event.payload?.message === "string" ? event.payload.message : "Log entry";
      return {
        ...base,
        label: event.payload?.workerId ? `Agent ${event.payload.workerId.slice(0, 6)}` : "Agent",
        body: message,
        tone: "agent"
      };
    }
    case "task.updated": {
      const status = event.payload?.status ?? "updated";
      return {
        ...base,
        label: "Status update",
        body: `Task is now ${status}.`,
        tone: "system"
      };
    }
    case "plan.updated": {
      return {
        ...base,
        label: "Plan updated",
        body: "Execution plan refreshed.",
        detail: JSON.stringify(event.payload?.plan, null, 2),
        tone: "system"
      };
    }
    case "task.completed": {
      return {
        ...base,
        label: "Task completed",
        body: typeof event.payload?.summary === "string" ? event.payload.summary : "The agent completed this task.",
        tone: "agent"
      };
    }
    case "task.failed": {
      return {
        ...base,
        label: "Task failed",
        body: event.payload?.error ?? "The agent reported a failure.",
        tone: "alert"
      };
    }
    default: {
      return {
        ...base,
        label: event.type,
        body: JSON.stringify(event.payload ?? {}, null, 2),
        tone: "system"
      };
    }
  }
}
