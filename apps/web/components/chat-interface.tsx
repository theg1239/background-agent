"use client";

import { useEffect, useMemo, useRef, useState, useCallback, useTransition } from "react";
import { clsx } from "clsx";
import type { Task, TaskEvent } from "@background-agent/shared";
import { useTaskEvents } from "../hooks/use-task-events";
import { CreateTaskForm } from "./create-task-form";
import { useTaskIndex } from "../hooks/use-task-index";
import { DiffArtifactCard } from "./diff-artifact-card";
import { LiveFileDiffViewer, type LiveFileUpdate } from "./live-file-diff-viewer";
import type { GitHubAuthState } from "../lib/server/github-auth";
import { recordFollowUpAction } from "../app/actions/task-actions";

interface ChatInterfaceProps {
  initialTasks: Task[];
  initialGitHubAuth: GitHubAuthState;
}

type PaneView = "chat" | "workspace";

export function ChatInterface({ initialTasks, initialGitHubAuth }: ChatInterfaceProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(initialTasks[0]?.id);
  const [creationMessage, setCreationMessage] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [showConversation, setShowConversation] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [isFollowUpPending, startFollowUp] = useTransition();
  const { tasks, upsertTask, replaceTask, removeTask } = useTaskIndex(initialTasks);
  const optimisticIds = useRef(new Set<string>());
  const [githubAuth, setGitHubAuth] = useState<GitHubAuthState>(initialGitHubAuth);
  const [mobilePane, setMobilePane] = useState<PaneView>("chat");

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

  const { task, events, isConnected } = useTaskEvents(activeTaskId);

  const liveFileUpdates = useMemo<LiveFileUpdate[]>(() => {
    if (!events.length) return [];
    const updates: LiveFileUpdate[] = [];
    for (const event of events) {
      if (event.type !== "task.file_updated") continue;
      const rawPath = typeof event.payload?.path === "string" ? event.payload.path : undefined;
      if (!rawPath) continue;
      const normalizedPath = rawPath.replace(/\\/g, "/");
      if (normalizedPath.startsWith(".git/")) continue;
      if (event.payload?.initial === true) continue;
      const contents = typeof event.payload?.contents === "string" ? event.payload.contents : "";
      const previousPayload = event.payload?.previous;
      const previous =
        typeof previousPayload === "string"
          ? previousPayload
          : previousPayload === null
          ? null
          : undefined;
      updates.push({
        id: event.id,
        path: normalizedPath,
        contents,
        previous,
        timestamp: event.timestamp
      });
    }
    return updates;
  }, [events]);

  const resolvedTask = task ?? activeTask;

  const handleTaskCreated = (newTask: Task, meta?: { optimisticId?: string; isOptimistic?: boolean }) => {
    if (meta?.optimisticId) {
      if (meta.isOptimistic) {
        optimisticIds.current.add(meta.optimisticId);
        upsertTask(newTask);
        setActiveTaskId(newTask.id);
        setCreationMessage(`Queued "${newTask.title}"`);
      } else {
        replaceTask(meta.optimisticId, newTask);
        if (optimisticIds.current.has(meta.optimisticId)) {
          optimisticIds.current.delete(meta.optimisticId);
        }
        setActiveTaskId((current) => (current === meta.optimisticId ? newTask.id : current));
        setCreationMessage(`Agent picked up "${newTask.title}"`);
        setIsCreateOpen(false);
      }
    } else {
      upsertTask(newTask);
      setActiveTaskId(newTask.id);
      setCreationMessage(`Queued "${newTask.title}"`);
    }
  };

  const handleTaskCreateFailed = (optimisticId: string, message: string) => {
    if (optimisticIds.current.has(optimisticId)) {
      optimisticIds.current.delete(optimisticId);
    }
    removeTask(optimisticId);
    setActiveTaskId((current) => (current === optimisticId ? undefined : current));
    setCreationMessage(`Failed to create task: ${message}`);
  };

  const displayedEvents = useMemo((): DisplayEvent[] => {
    if (!events.length && resolvedTask) {
      return [
        {
          id: "task-placeholder",
          label: "The agent is ready",
          body: "Live updates will stream in as soon as the background agent begins working.",
          tone: "system",
          timestamp: resolvedTask.createdAt
        }
      ];
    }

    return events.map((event) => formatEvent(event));
  }, [events, resolvedTask]);

  const workingSince = useMemo(() => {
    if (!resolvedTask) return undefined;
    const workingStatuses = new Set(["planning", "executing", "awaiting_approval"]);
    if (!workingStatuses.has(resolvedTask.status)) return undefined;

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "task.updated") {
        const status = event.payload?.status;
        if (typeof status === "string" && workingStatuses.has(status)) {
          return event.timestamp;
        }
      }
    }

    return resolvedTask.updatedAt ?? resolvedTask.createdAt;
  }, [events, resolvedTask]);

  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    if (!workingSince) return undefined;
    setNowTick(Date.now());
    const interval = setInterval(() => setNowTick(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [workingSince]);

  const workingDuration = workingSince ? Math.max(0, nowTick - workingSince) : undefined;
  const workingLabel = useMemo(() => (workingDuration ? formatDuration(workingDuration) : null), [workingDuration]);

  const statusSummary = useMemo(() => {
    if (!resolvedTask) return "Idle";
    const statusText = humanizeStatus(resolvedTask.status);
    if (workingLabel) {
      return `${statusText} • working for ${workingLabel}`;
    }
    return statusText;
  }, [resolvedTask, workingLabel]);

  useEffect(() => {
    if (!creationMessage) return undefined;
    const timeout = setTimeout(() => setCreationMessage(null), 5_000);
    return () => clearTimeout(timeout);
  }, [creationMessage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncPane = () => {
      if (window.innerWidth >= 1280) {
        setMobilePane("chat");
      }
    };
    syncPane();
    window.addEventListener("resize", syncPane);
    return () => window.removeEventListener("resize", syncPane);
  }, []);

  const creationMessageClass = creationMessage?.startsWith("Failed") ? "text-red-400" : "text-emerald-400";

  const isOptimisticActive = Boolean(activeTaskId && activeTaskId.startsWith("temp-"));
  const connectionLabel = isOptimisticActive ? "Starting" : isConnected ? "Live" : "Queued";
  const connectionClass = isOptimisticActive
    ? "bg-amber-500/10 text-amber-300 border-amber-400/40"
    : isConnected
    ? "bg-emerald-500/10 text-emerald-300 border-emerald-400/40"
    : "bg-amber-500/10 text-amber-300 border-amber-400/40";

  const openConversation = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1280) {
      setMobilePane("chat");
      return;
    }
    setShowConversation(true);
  }, []);

  const handleGitHubAuthChange = useCallback((state: GitHubAuthState) => {
    setGitHubAuth(state);
  }, []);

  const orderedTasks = useMemo(() => {
    const activeStatuses = new Set(["queued", "planning", "executing", "awaiting_approval"]);
    return tasks
      .filter((taskItem) => activeStatuses.has(taskItem.status))
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }, [tasks]);

  const ConversationPanel = () => (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-950/85">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.3em] text-neutral-500">Conversation</p>
          <p className="truncate text-lg font-semibold text-white">
            {resolvedTask ? resolvedTask.title : "Select or create a task"}
          </p>
          <p className="truncate text-xs text-neutral-500">{statusSummary}</p>
        </div>
      </div>

      <div className="scrollbar flex-1 overflow-y-auto px-5 py-5">
        <div className="flex flex-col gap-3">
          {displayedEvents.map((event) => {
            const isAgent = event.tone === "agent";
            const isSystem = event.tone === "system";
            return (
              <div
                key={`${event.id}-${event.timestamp}`}
                className={clsx(
                  "space-y-2 rounded-2xl border px-5 py-4 shadow-sm transition",
                  isAgent && "border-emerald-500/30 bg-emerald-500/5 text-neutral-100",
                  !isAgent && !isSystem && "border-red-500/40 bg-red-500/10 text-red-100",
                  isSystem && "border-neutral-800 bg-neutral-900/80 text-neutral-300"
                )}
              >
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.35em] text-neutral-500">
                  <span>{event.label}</span>
                  <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="text-sm leading-relaxed">{event.body}</p>
                {event.detail ? (
                  <pre className="scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-neutral-950/90 p-4 text-xs text-neutral-400">
                    {event.detail}
                  </pre>
                ) : null}
                {event.artifactType === "git_diff" && event.diff && resolvedTask ? (
                  <DiffArtifactCard
                    diff={event.diff}
                    taskId={resolvedTask.id}
                    eventId={event.eventId ?? event.id}
                    taskTitle={resolvedTask.title}
                    repoUrl={resolvedTask.repoUrl}
                    githubAuth={githubAuth}
                    onGitHubAuthChange={handleGitHubAuthChange}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden xl:flex-row xl:gap-6">
      <section className="flex w-full flex-shrink-0 flex-col gap-4 rounded-3xl border border-neutral-900 bg-neutral-950/90 p-4 xl:w-64 xl:border-none xl:bg-transparent xl:p-0">
        <div className="rounded-3xl border border-neutral-800 bg-neutral-950/90 px-4 py-3">
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-emerald-200">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {connectionLabel}
            </span>
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="inline-flex items-center justify-center rounded-full border border-neutral-700 bg-white px-3 py-1 text-xs font-semibold text-black transition hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
            >
              New task
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-neutral-500">
            <span>Status</span>
            <span>{statusSummary}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
            <span>GitHub</span>
            <span>
              {githubAuth.status === "connected" && githubAuth.user
                ? githubAuth.user.login
                : "Not linked"}
            </span>
          </div>
        </div>

        <div className="rounded-3xl border border-neutral-800 bg-neutral-950/90 px-4 py-4">
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.35em] text-neutral-500">
            <span>Active</span>
            <button
              type="button"
              onClick={openConversation}
              className="rounded-full border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 transition hover:border-neutral-600 hover:text-white"
            >
              Conversation
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {orderedTasks.length === 0 ? (
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="w-full rounded-2xl border border-dashed border-neutral-700 px-4 py-6 text-center text-xs text-neutral-500 transition hover:border-neutral-500 hover:text-white"
              >
                No active tasks · Create one
              </button>
            ) : (
              orderedTasks.map((taskItem) => {
                const isActive = taskItem.id === activeTaskId;
                return (
                  <button
                    key={taskItem.id}
                    type="button"
                    onClick={() => setActiveTaskId(taskItem.id)}
                    className={clsx(
                      "w-full rounded-2xl border px-4 py-3 text-left transition",
                      isActive
                        ? "border-emerald-400/50 bg-emerald-500/10 text-white"
                        : "border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-600 hover:text-white"
                    )}
                  >
                    <p className="truncate text-sm font-semibold">{taskItem.title}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.25em] text-neutral-500">
                      {humanizeStatus(taskItem.status)}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-neutral-800 bg-neutral-950/90 px-4 py-4 text-xs text-neutral-400">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.35em] text-neutral-500">
              Quick message
            </span>
            <button
              type="button"
              onClick={openConversation}
              className="rounded-full border border-neutral-800 px-2 py-1 text-[10px] text-neutral-300 transition hover:border-neutral-600 hover:text-white"
            >
              View log
            </button>
          </div>
          <form
            className="mt-3 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!activeTaskId) {
                setFollowUpError("Select a task first.");
                return;
              }
              const trimmed = followUpText.trim();
              if (!trimmed) {
                setFollowUpError("Type a quick note before sending.");
                return;
              }
              setFollowUpError(null);
              startFollowUp(async () => {
                const result = await recordFollowUpAction({
                  taskId: activeTaskId,
                  message: trimmed
                });
                if (result.ok) {
                  setFollowUpText("");
                  setCreationMessage("Follow-up sent to the agent.");
                } else if (result.error) {
                  setFollowUpError(result.error);
                } else {
                  setFollowUpError("Failed to send follow-up. Try again.");
                }
              });
            }}
          >
            <textarea
              rows={3}
              value={followUpText}
              onChange={(event) => setFollowUpText(event.target.value)}
              placeholder="Send a quick note or next step for the agent…"
              className="scrollbar w-full resize-none rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
            />
            {followUpError ? <p className="text-xs text-red-400">{followUpError}</p> : null}
            <div className="flex items-center justify-between">
              {creationMessage ? (
                <span className={clsx("text-xs", creationMessageClass)}>
                  {creationMessage}
                </span>
              ) : (
                <span />
              )}
              <button
                type="submit"
                disabled={isFollowUpPending}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-neutral-700 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isFollowUpPending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </div>
      </section>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="hidden min-h-0 flex-1 overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-950/85 xl:flex">
          <LiveFileDiffViewer updates={liveFileUpdates} className="flex-1" />
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden xl:hidden">
          {mobilePane === "workspace" ? (
            <LiveFileDiffViewer updates={liveFileUpdates} className="flex-1" />
          ) : (
            <ConversationPanel />
          )}
        </div>
      </div>

      {showConversation ? (
        <div className="fixed inset-0 z-50 hidden items-center justify-center px-6 py-10 xl:flex">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowConversation(false)} />
          <div className="relative flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-[0.35em] text-neutral-500">Conversation</p>
                <p className="text-sm text-neutral-300">
                  {resolvedTask ? resolvedTask.title : "No task selected"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowConversation(false)}
                className="rounded-full border border-neutral-800 px-3 py-1 text-xs text-neutral-400 transition hover:border-neutral-600 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <ConversationPanel />
            </div>
          </div>
        </div>
      ) : null}

      {isCreateOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-10">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setIsCreateOpen(false)}
          />
          <div className="relative w-full max-w-lg rounded-3xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">New task</h2>
                <p className="text-sm text-neutral-500">
                  Provide a brief title, repository, and goal to guide the agent.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="rounded-full border border-neutral-800 p-2 text-neutral-400 transition hover:border-neutral-600 hover:text-white"
                aria-label="Close"
              >
                Close
              </button>
            </div>
            <div className="mt-4">
              <CreateTaskForm
                onCreated={handleTaskCreated}
                onFailed={handleTaskCreateFailed}
                helperText="The agent runs in the background and streams updates here."
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type DisplayEvent = {
  id: string;
  label: string;
  body: string;
  detail?: string;
  artifactType?: string;
  diff?: string;
  eventId?: string;
  tone: "agent" | "system" | "alert";
  timestamp: number;
};

function humanizeStatus(status: string) {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [] as string[];
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes || hours) {
    parts.push(`${minutes.toString().padStart(hours ? 2 : 1, "0")}m`);
  }
  parts.push(`${seconds.toString().padStart(parts.length ? 2 : 1, "0")}s`);
  return parts.join(" ");
}

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
        body:
          typeof event.payload?.summary === "string"
            ? event.payload.summary
            : "The agent completed this task. Review the diff on the right and capture next steps.",
        detail: "Consider reviewing artifacts or leaving follow-up instructions.",
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
    case "task.artifact_generated": {
      const artifactType = event.payload?.artifactType;
      const diff = typeof event.payload?.diff === "string" ? event.payload.diff : undefined;
      return {
        ...base,
        label: artifactType === "git_diff" ? "Patch ready" : "Artifact generated",
        body:
          artifactType === "git_diff"
            ? "A new git diff is ready to review."
            : JSON.stringify(event.payload ?? {}, null, 2),
        tone: artifactType === "git_diff" ? "agent" : "system",
        artifactType,
        diff,
        eventId: event.id
      };
    }
    case "task.follow_up": {
      const message =
        typeof event.payload?.message === "string" ? event.payload.message : "Follow-up noted.";
      return {
        ...base,
        label: "Follow-up",
        body: message,
        tone: "system"
      };
    }
    case "task.file_updated": {
      const path = typeof event.payload?.path === "string" ? event.payload.path : "unknown file";
      const bytes =
        typeof event.payload?.bytes === "number" ? `${event.payload.bytes} bytes written` : undefined;
      return {
        ...base,
        label: "File updated",
        body: `Agent modified ${path}.`,
        detail: bytes,
        tone: "agent"
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
