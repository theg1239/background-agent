"use client";

import { Task, TaskEvent } from "@background-agent/shared";

interface Props {
  task?: Task;
  events: TaskEvent[];
  isConnected: boolean;
}

export function TaskDetail({ task, events, isConnected }: Props) {
  if (!task) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-500">
        Select a task to inspect progress.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <header className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 shadow">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-100">{task.title}</h2>
          <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium uppercase tracking-wide text-blue-200">
            {task.status}
          </span>
        </div>
        {task.description ? (
          <p className="mt-2 text-sm text-zinc-400">{task.description}</p>
        ) : null}
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
          <span>Task ID: {task.id}</span>
          <span>•</span>
          <span>Connection: {isConnected ? "live" : "reconnecting"}</span>
        </div>
      </header>

      {task.plan.length ? (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Execution plan</h3>
          <ol className="mt-3 space-y-2">
            {task.plan.map((step) => (
              <li
                key={step.id}
                className="flex items-start justify-between rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-200">{step.title}</p>
                  {step.summary ? <p className="text-xs text-zinc-400">{step.summary}</p> : null}
                </div>
                <span className="ml-3 rounded-full bg-zinc-800 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-300">
                  {step.status}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="flex-1 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Event log</h3>
        <ol className="mt-3 space-y-3">
          {events.map((event) => (
            <li key={event.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span>{event.type}</span>
                <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
              </div>
              {event.payload ? (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-300">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
