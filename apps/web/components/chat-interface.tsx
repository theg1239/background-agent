"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { clsx } from "clsx";
import type { Task, TaskEvent, TaskEventStreamSnapshot } from "@background-agent/shared";
import { jsonFetcher } from "../lib/utils/fetcher";
import { useTaskEvents } from "../hooks/use-task-events";
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

  useEffect(() => {
    if (tasks.length === 0) {
      setActiveTaskId(undefined);
      return;
    }

    if (activeTaskId && !tasks.some((taskItem) => taskItem.id === activeTaskId)) {
      setActiveTaskId(tasks[0]?.id);
    }
  }, [tasks, activeTaskId]);

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

  const displayedEvents = useMemo((): DisplayEvent[] => {
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
    <div className="relative mx-auto flex h-full w-full max-w-3xl flex-1 flex-col gap-5 px-4 pb-10">
      <header className="flex items-center justify-between pt-6">
        <div className="space-y-1">
          <span className="text-[11px] uppercase tracking-[0.4em] text-neutral-500">Background Agent</span>
          <h1 className="text-2xl font-semibold text-white">Get progress updates without waiting around</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowHistory((value) => !value)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-800 bg-neutral-950 text-neutral-300 transition hover:border-neutral-600 hover:text-white"
          aria-label="Open task history"
        >
          <HistoryIcon className="h-4 w-4" />
        </button>
      </header>

      <div className="relative flex flex-1 flex-col overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-950/70 shadow-lg">
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-xs uppercase tracking-[0.2em] text-neutral-500">Current briefing</p>
            <p className="truncate text-lg font-medium text-white">
              {resolvedTask ? resolvedTask.title : "Waiting for instructions"}
            </p>
          </div>
          <span
            className={clsx(
              "text-xs font-medium",
              isConnected ? "text-emerald-400" : "text-amber-400"
            )}
          >
            {isConnected ? "Live" : "Reconnecting"}
          </span>
        </div>

        <div className="chat-font flex-1 space-y-3 overflow-y-auto px-5 pb-6 pt-4 text-sm text-neutral-100">
          {displayedEvents.map((event) => (
            <div
              key={`${event.id}-${event.timestamp}`}
              className={clsx(
                "max-w-xl rounded-2xl border px-4 py-3",
                event.tone === "agent" && "border-neutral-800 bg-neutral-900/80",
                event.tone === "system" && "border-neutral-800 bg-neutral-950/60 text-neutral-300",
                event.tone === "alert" && "border-red-500/60 bg-red-500/10 text-red-200"
              )}
            >
              <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-neutral-500">
                <span>{event.label}</span>
                <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{event.body}</p>
              {event.detail ? (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl bg-neutral-950/80 p-3 text-xs text-neutral-400">
                  {event.detail}
                </pre>
              ) : null}
            </div>
          ))}
        </div>

        <div className="border-t border-neutral-800 px-5 py-5">
          <CreateTaskForm onCreated={handleTaskCreated} compact />
        </div>
      </div>

      {showHistory ? (
        <aside className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-md translate-y-0 rounded-t-3xl border border-neutral-800 bg-neutral-950/95 p-5 shadow-2xl sm:bottom-10 sm:right-10 sm:top-auto sm:h-auto sm:w-80 sm:rounded-3xl">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Recent tasks</h2>
            <button
              type="button"
              onClick={() => setShowHistory(false)}
              className="rounded-full border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-600 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="mt-4 max-h-80 space-y-2 overflow-y-auto text-sm">
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

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 5v6l4 2"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 5.5A9 9 0 1 1 4 12.5"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 3v4.2a.3.3 0 0 1-.3.3H1"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
