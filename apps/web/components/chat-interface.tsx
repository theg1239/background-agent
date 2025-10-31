"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useTransition,
  useLayoutEffect
} from "react";
import { clsx } from "clsx";
import type { Task, TaskEvent } from "@background-agent/shared";
import { useTaskEvents } from "../hooks/use-task-events";
import { CreateTaskForm } from "./create-task-form";
import { useTaskIndex } from "../hooks/use-task-index";
import { DiffArtifactCard } from "./diff-artifact-card";
import { LiveFileDiffViewer, type LiveFileUpdate } from "./live-file-diff-viewer";
import type { GitHubAuthState } from "../lib/server/github-auth";
import { createTaskAction, recordFollowUpAction } from "../app/actions/task-actions";

interface ChatInterfaceProps {
  initialTasks: Task[];
  initialGitHubAuth: GitHubAuthState;
}

type PaneView = "chat" | "workspace";

const ACTIVE_TASK_STATUSES: Task["status"][] = ["queued", "planning", "executing", "awaiting_approval"];
const ACTIVE_TASK_STATUS_SET = new Set<Task["status"]>(ACTIVE_TASK_STATUSES);

function compareTaskRecency(left: Task, right: Task) {
  return (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt);
}

function stripGitSuffix(value: string) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function normalizeGitHubRepoInput(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^[<>"'`(]+/, "").replace(/[<>"'`),.;]+$/, "");
  if (!cleaned) return undefined;

  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:\/.*)?$/i);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${stripGitSuffix(httpsMatch[2])}`;
  }

  const sshMatch = cleaned.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${stripGitSuffix(sshMatch[2])}`;
  }

  const ownerRepoMatch = cleaned.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (ownerRepoMatch) {
    return `https://github.com/${ownerRepoMatch[1]}/${stripGitSuffix(ownerRepoMatch[2])}`;
  }

  return undefined;
}

function extractGitHubRepoFromText(text: string): string | undefined {
  const httpsMatch = text.match(/https?:\/\/github\.com\/[^\s]+/i);
  if (httpsMatch) {
    const normalized = normalizeGitHubRepoInput(httpsMatch[0]);
    if (normalized) return normalized;
  }

  const sshMatch = text.match(/git@github\.com:[^\s]+/i);
  if (sshMatch) {
    const normalized = normalizeGitHubRepoInput(sshMatch[0]);
    if (normalized) return normalized;
  }

  return undefined;
}

export function ChatInterface({ initialTasks, initialGitHubAuth }: ChatInterfaceProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined);
  const [creationMessage, setCreationMessage] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [showConversation, setShowConversation] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpStatus, setFollowUpStatus] = useState<string | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | undefined>(undefined);
  const [hasActivatedFullUI, setHasActivatedFullUI] = useState(() =>
    initialTasks.some((task) => ACTIVE_TASK_STATUS_SET.has(task.status))
  );
  const [quickTaskText, setQuickTaskText] = useState("");
  const [quickTaskError, setQuickTaskError] = useState<string | null>(null);
  const [quickRepo, setQuickRepo] = useState("");
  const [showQuickRepoField, setShowQuickRepoField] = useState(false);
  const [isFollowUpPending, startFollowUp] = useTransition();
  const [isQuickTaskPending, startQuickTask] = useTransition();
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const { tasks, upsertTask, replaceTask, removeTask } = useTaskIndex(initialTasks);
  const optimisticIds = useRef(new Set<string>());
  const [githubAuth, setGitHubAuth] = useState<GitHubAuthState>(initialGitHubAuth);
  const [mobilePane, setMobilePane] = useState<PaneView>("chat");

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId), [tasks, activeTaskId]);

  useEffect(() => {
    if (!activeTaskId) {
      return;
    }
    if (!tasks.some((taskItem) => taskItem.id === activeTaskId)) {
      setActiveTaskId(undefined);
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

  const activeTasks = useMemo(() => {
    return tasks
      .filter((taskItem) => ACTIVE_TASK_STATUS_SET.has(taskItem.status))
      .sort(compareTaskRecency);
  }, [tasks]);

  const historicalTasks = useMemo(() => {
    return tasks
      .filter((taskItem) => !ACTIVE_TASK_STATUS_SET.has(taskItem.status))
      .sort(compareTaskRecency);
  }, [tasks]);

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

  const hasActiveTasks = activeTasks.length > 0;

  useEffect(() => {
    if (hasActiveTasks) {
      setHasActivatedFullUI(true);
    }
  }, [hasActiveTasks]);

  

  const creationMessageClass = creationMessage?.startsWith("Failed") ? "text-red-400" : "text-emerald-400";

  const isOptimisticActive = Boolean(activeTaskId && activeTaskId.startsWith("temp-"));
  const connectionLabel = isOptimisticActive ? "Starting" : isConnected ? "Live" : "Queued";
  const connectionClass = isOptimisticActive
    ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
    : isConnected
    ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
    : "border-amber-400/40 bg-amber-500/10 text-amber-300";
  const connectionDotClass = isOptimisticActive
    ? "bg-amber-300"
    : isConnected
    ? "bg-emerald-400"
    : "bg-amber-300 animate-pulse";
  const showFullLayout = hasActivatedFullUI || hasActiveTasks;

  
  const handleQuickTaskSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isQuickTaskPending) {
      return;
    }
    const rawText = quickTaskText.trim();
    if (rawText.length < 3) {
      setQuickTaskError("Describe what you want the agent to do (minimum 3 characters).");
      return;
    }

    const hadActiveTasks = hasActiveTasks;
    const now = Date.now();
    const TITLE_LIMIT = 120;
    let title = rawText;
    if (title.length > TITLE_LIMIT) {
      title = `${title.slice(0, TITLE_LIMIT - 3).trimEnd()}...`;
    }

    const trimmedRepoInput = quickRepo.trim();
    const userProvidedRepo = normalizeGitHubRepoInput(trimmedRepoInput);
    if (trimmedRepoInput && !userProvidedRepo) {
      setQuickTaskError("Enter a valid GitHub repository URL (for example, https://github.com/acme/project).");
      setShowQuickRepoField(true);
      return;
    }

    const inferredRepo = userProvidedRepo ?? extractGitHubRepoFromText(rawText);
    if (!inferredRepo) {
      setQuickTaskError("Add a GitHub repository URL so the agent knows where to work.");
      setShowQuickRepoField(true);
      return;
    }

    if (trimmedRepoInput) {
      setQuickRepo(inferredRepo);
    }
    setShowQuickRepoField(Boolean(trimmedRepoInput));
    setQuickTaskError(null);

    const optimisticId = `temp-${now}`;
    const optimisticTask: Task = {
      id: optimisticId,
      title,
      description: rawText,
      repoUrl: inferredRepo,
      status: "queued",
      plan: [],
      createdAt: now,
      updatedAt: now,
      assignee: undefined,
      latestEventId: undefined,
      riskScore: 0.2
    };

    handleTaskCreated(optimisticTask, { optimisticId, isOptimistic: true });
    setHasActivatedFullUI(true);

    startQuickTask(async () => {
      try {
        const result = await createTaskAction({
          title,
          description: rawText,
          repoUrl: inferredRepo
        });
        if (!result.ok || !result.task) {
          const message = result.error ?? "Failed to create task";
          setQuickTaskError(message);
          handleTaskCreateFailed(optimisticId, message);
          setHasActivatedFullUI(hadActiveTasks);
          return;
        }
        handleTaskCreated(result.task, { optimisticId, isOptimistic: false });
        setQuickTaskText("");
        setQuickRepo("");
        setShowQuickRepoField(false);
      } catch (error) {
        const message = (error as Error).message ?? "Failed to create task";
        setQuickTaskError(message);
        handleTaskCreateFailed(optimisticId, message);
        setHasActivatedFullUI(hadActiveTasks);
      }
    });
  };

  const openConversation = useCallback(
    (eventId?: string) => {
      setFocusedEventId(eventId);
      if (typeof window !== "undefined" && window.innerWidth < 1280) {
        setMobilePane("chat");
      } else {
        setShowConversation(true);
      }
    },
    []
  );

  const handleRestoreTask = useCallback(
    (taskId: string) => {
      setFocusedEventId(undefined);
      setActiveTaskId(taskId);
      setHasActivatedFullUI(true);
      setIsHistoryOpen(false);
      if (typeof window !== "undefined" && window.innerWidth < 1280) {
        setMobilePane("chat");
        setShowConversation(false);
      } else {
        setShowConversation(true);
      }
    },
    []
  );

  const handleGitHubAuthChange = useCallback((state: GitHubAuthState) => {
    setGitHubAuth(state);
  }, []);

  const latestDiffEvent = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "task.artifact_generated") {
        const diff = typeof event.payload?.diff === "string" ? event.payload.diff : undefined;
        if (diff && diff.trim()) {
          return { event, diff } as const;
        }
      }
    }
    return undefined;
  }, [events]);

  useEffect(() => {
    if (!focusedEventId) return;
    const timeout = setTimeout(() => setFocusedEventId(undefined), 2_000);
    return () => clearTimeout(timeout);
  }, [focusedEventId]);

  useEffect(() => {
    if (!followUpStatus) return;
    const timeout = setTimeout(() => setFollowUpStatus(null), 3_000);
    return () => clearTimeout(timeout);
  }, [followUpStatus]);

  const ConversationPanel = ({ highlightEventId }: { highlightEventId?: string }) => {
    const highlightRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const scrollStateRef = useRef({
      scrollTop: 0,
      scrollHeight: 0,
      eventCount: events.length
    });

    useLayoutEffect(() => {
      const container = listRef.current;
      if (!container) return;
      const previous = scrollStateRef.current;
      if (previous.eventCount !== events.length) {
        container.scrollTop = previous.scrollTop;
      }
      scrollStateRef.current = {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        eventCount: events.length
      };
    }, [events.length]);

    const recordScrollPosition = useCallback(() => {
      const container = listRef.current;
      if (!container) return;
      scrollStateRef.current = {
        ...scrollStateRef.current,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight
      };
    }, []);

    useEffect(() => {
      if (!highlightEventId) {
        highlightRef.current = null;
        return;
      }
      if (highlightRef.current) {
        highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        const container = listRef.current;
        if (container) {
          scrollStateRef.current = {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            eventCount: events.length
          };
        }
      }
    }, [highlightEventId, events.length]);

    const assignHighlightRef = useCallback((node: HTMLDivElement | null) => {
      if (node) {
        highlightRef.current = node;
      }
    }, []);

    return (
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

      <div
        ref={listRef}
        onScroll={recordScrollPosition}
        className="scrollbar flex-1 overflow-y-auto px-5 py-5"
      >
        <div className="flex flex-col gap-3">
          {displayedEvents.map((event) => {
            const isAgent = event.tone === "agent";
            const isSystem = event.tone === "system";
            const isHighlighted = highlightEventId === event.id;
            return (
              <div
                key={`${event.id}-${event.timestamp}`}
                ref={isHighlighted ? assignHighlightRef : undefined}
                className={clsx(
                  "space-y-2 rounded-2xl border px-5 py-4 shadow-sm transition",
                  isAgent && "border-emerald-500/30 bg-emerald-500/5 text-neutral-100",
                  !isAgent && !isSystem && "border-red-500/40 bg-red-500/10 text-red-100",
                  isSystem && "border-neutral-800 bg-neutral-900/80 text-neutral-300",
                  isHighlighted && "border-emerald-400/70 shadow-[0_0_0_1px_rgba(16,185,129,0.45)]"
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
}

  const containerClass = clsx(
    "flex min-h-0 flex-1",
    showFullLayout
      ? "flex-col gap-4 overflow-hidden xl:flex-row xl:gap-6"
      : "flex-col items-center justify-center px-6 py-10"
  );

  return (
    <div className={containerClass}>
      {showFullLayout ? (
        <>
          <section className="flex w-full flex-shrink-0 flex-col gap-4 rounded-3xl border border-neutral-900 bg-neutral-950/90 p-4 xl:w-64 xl:border-none xl:bg-transparent xl:p-0">
            <div className="rounded-3xl border border-neutral-800 bg-neutral-950/90 px-4 py-3">
              <div className="flex items-center justify-between text-xs text-neutral-400">
                <span
                  className={clsx(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition",
                    connectionClass
                  )}
                >
                  <span className={clsx("h-2 w-2 rounded-full", connectionDotClass)} />
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
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-[0.35em] text-neutral-500">
                <span>Active</span>
                <button
                  type="button"
                  onClick={() => openConversation()}
                  className="w-full rounded-2xl border border-dashed border-neutral-700 px-4 py-2 text-center text-[10px] text-neutral-500 transition hover:border-neutral-500 hover:text-white sm:w-auto"
                >
                  Conversation
                </button>
              </div>
              <div className="mt-3 space-y-2">
                {hasActiveTasks ? (
                  <>
                    {activeTasks.map((taskItem) => {
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
                    })}
                    {historicalTasks.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setIsHistoryOpen(true)}
                        className="w-full rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-2 text-center text-[10px] uppercase tracking-[0.2em] text-neutral-400 transition hover:border-neutral-600 hover:text-white"
                      >
                        Browse recent task runs
                      </button>
                    ) : null}
                  </>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[11px] uppercase tracking-[0.25em] text-neutral-600">
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsCreateOpen(true)}
                      className="w-full rounded-2xl border border-dashed border-neutral-700 px-4 py-6 text-center text-xs text-neutral-500 transition hover:border-neutral-500 hover:text-white"
                    >
                      Create a task
                    </button>
                    {historicalTasks.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setIsHistoryOpen(true)}
                        className="w-full rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-center text-xs text-neutral-300 transition hover:border-neutral-600 hover:text-white"
                      >
                        Browse recent task runs
                      </button>
                    ) : null}
                  </div>
                )}
                {creationMessage ? (
                  <p className={clsx("text-xs", creationMessageClass)}>{creationMessage}</p>
                ) : null}
              </div>
            </div>

            {latestDiffEvent ? (
              <div className="rounded-3xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-4 text-sm text-neutral-200">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.35em] text-emerald-200">
                  <span>Latest diff</span>
                  <span className="text-[10px] text-neutral-400">
                    {new Date(latestDiffEvent.event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="mt-2 text-xs text-neutral-200">
                  Review the generated patch and create a pull request when you’re ready.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => openConversation(latestDiffEvent.event.id)}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-100 transition hover:border-emerald-400 hover:text-white"
                  >
                    Review & Create PR
                  </button>
                  <button
                    type="button"
                    onClick={() => setMobilePane("workspace")}
                    className="inline-flex items-center justify-center rounded-full border border-neutral-700 px-3 py-2 text-xs text-neutral-200 transition hover:border-neutral-500 hover:text-white"
                  >
                    View diff
                  </button>
                </div>
              </div>
            ) : null}

            <div className="rounded-3xl border border-neutral-800 bg-neutral-950/90 px-4 py-4 text-xs text-neutral-400">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-[0.35em] text-neutral-500">
                  Quick message
                </span>
                <button
                  type="button"
                  onClick={() => openConversation()}
                  className="w-full rounded-2xl border border-dashed border-neutral-700 px-4 py-2 text-center text-[10px] text-neutral-500 transition hover:border-neutral-500 hover:text-white sm:w-auto"
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
                      setFollowUpStatus("Follow-up sent to the agent.");
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
                  {followUpStatus ? (
                    <span className="text-xs text-emerald-300">{followUpStatus}</span>
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
              <LiveFileDiffViewer
                updates={liveFileUpdates}
                className="flex-1"
                onReviewDiff={latestDiffEvent ? () => openConversation(latestDiffEvent.event.id) : undefined}
              />
            </div>
            <div className="flex min-h-0 flex-1 overflow-hidden xl:hidden">
              {mobilePane === "workspace" ? (
                <LiveFileDiffViewer
                  updates={liveFileUpdates}
                  className="flex-1"
                  onReviewDiff={latestDiffEvent ? () => openConversation(latestDiffEvent.event.id) : undefined}
                />
              ) : (
                <ConversationPanel highlightEventId={focusedEventId} />
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="w-full max-w-2xl space-y-4">
          <form
            onSubmit={handleQuickTaskSubmit}
            className="rounded-3xl border border-neutral-800 bg-neutral-950/70 p-6 shadow-xl backdrop-blur"
          >
            <textarea
              rows={4}
              value={quickTaskText}
              onChange={(event) => setQuickTaskText(event.target.value)}
              placeholder="Code anything in the background..."
              className="scrollbar w-full resize-none rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-base text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
            {showQuickRepoField ? (
              <div className="mt-3 space-y-1">
                <label className="text-xs uppercase tracking-[0.25em] text-neutral-500">
                  GitHub repository
                </label>
                <input
                  type="text"
                  value={quickRepo}
                  onChange={(event) => setQuickRepo(event.target.value)}
                  placeholder="https://github.com/acme/project"
                  className="w-full rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                />
              </div>
            ) : (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowQuickRepoField(true)}
                  className="text-xs text-neutral-500 underline decoration-dotted underline-offset-4 transition hover:text-white"
                >
                  Add GitHub repository manually
                </button>
              </div>
            )}
            {quickTaskError ? (
              <p className="mt-2 text-sm text-red-400">{quickTaskError}</p>
            ) : (
              <p className="mt-2 text-sm text-neutral-500">
                Tell the agent what to build; it will work asynchronously and stream updates here.
              </p>
            )}
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="text-xs text-neutral-500 underline decoration-dotted underline-offset-4 transition hover:text-white"
              >
                Use advanced task form
              </button>
              <button
                type="submit"
                disabled={isQuickTaskPending}
                className="inline-flex items-center justify-center rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-400"
              >
                {isQuickTaskPending ? "Starting…" : "Run in background"}
              </button>
            </div>
          </form>
          {historicalTasks.length > 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-3xl border border-neutral-800 bg-neutral-950/50 p-6 text-center shadow-xl backdrop-blur">
              <p className="text-sm text-neutral-400">
                Need to revisit something you already shipped?
              </p>
              <button
                type="button"
                onClick={() => setIsHistoryOpen(true)}
                className="inline-flex items-center justify-center rounded-full border border-neutral-700 px-5 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-500 hover:text-white"
              >
                Browse recent task runs
              </button>
            </div>
          ) : null}
        </div>
      )}

      {isHistoryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-10">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setIsHistoryOpen(false)}
          />
          <div className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-neutral-500">Recent task runs</p>
                <p className="mt-1 text-sm text-neutral-300">Reopen a task to view its conversation and artifacts.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsHistoryOpen(false)}
                className="rounded-full border border-neutral-800 px-3 py-1 text-xs text-neutral-400 transition hover:border-neutral-600 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="scrollbar max-h-[60vh] overflow-y-auto px-5 py-5">
              {historicalTasks.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-neutral-700 px-6 py-10 text-center text-sm text-neutral-500">
                  No completed tasks yet. Create one to get started.
                </div>
              ) : (
                <div className="space-y-2">
                  {historicalTasks.map((taskItem) => (
                    <button
                      key={taskItem.id}
                      type="button"
                      onClick={() => handleRestoreTask(taskItem.id)}
                      className="w-full rounded-2xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-left text-neutral-300 transition hover:border-neutral-600 hover:text-white"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <p className="truncate text-sm font-semibold text-white">{taskItem.title}</p>
                        <span className="rounded-full border border-neutral-700 px-3 py-1 text-[10px] uppercase tracking-[0.3em] text-neutral-400">
                          {humanizeStatus(taskItem.status)}
                        </span>
                      </div>
                      {taskItem.description ? (
                        <p className="mt-2 line-clamp-2 text-xs text-neutral-500">{taskItem.description}</p>
                      ) : null}
                      <p className="mt-2 text-[10px] uppercase tracking-[0.25em] text-neutral-500">
                        Updated {new Date(taskItem.updatedAt ?? taskItem.createdAt).toLocaleString()}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

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
              <ConversationPanel highlightEventId={focusedEventId} />
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
