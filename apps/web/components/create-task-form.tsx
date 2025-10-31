"use client";

import { FormEvent, useMemo, useState, useTransition } from "react";
import { CreateTaskInput, Task } from "@background-agent/shared";
import { clsx } from "clsx";
import { createTaskAction } from "../app/actions/task-actions";

interface CreateTaskFormProps {
  onCreated?: (task: Task, meta?: { optimisticId?: string; isOptimistic?: boolean }) => void;
  onFailed?: (optimisticId: string, error: string) => void;
  compact?: boolean;
  helperText?: string | null;
}

export function CreateTaskForm({ onCreated, onFailed, compact = false, helperText }: CreateTaskFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [buttonLabel, setButtonLabel] = useState("Run task");

  const formClassName = useMemo(
    () =>
      clsx(
        "w-full rounded-2xl border border-neutral-800 bg-neutral-950/60 shadow backdrop-blur",
        compact ? "p-4" : "p-5"
      ),
    [compact]
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (isSubmitting) return;

    const sanitizedInput: CreateTaskInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      repoUrl: repoUrl.trim() || undefined
    };

    const optimisticId = `temp-${Date.now()}`;
    const now = Date.now();
    const optimisticTask: Task = {
      id: optimisticId,
      title: sanitizedInput.title,
      description: sanitizedInput.description,
      repoUrl: sanitizedInput.repoUrl,
      status: "queued",
      plan: [],
      createdAt: now,
      updatedAt: now,
      latestEventId: undefined,
      assignee: undefined,
      riskScore: 0.2
    };

    onCreated?.(optimisticTask, { optimisticId, isOptimistic: true });
    setIsSubmitting(true);
    setButtonLabel("Queued…");

    startTransition(() => {
      (async () => {
        const result = await createTaskAction(sanitizedInput);
        if (!result.ok || !result.task) {
          const message = result.error ?? "Failed to create task";
          setError(message);
          onFailed?.(optimisticId, message);
          setIsSubmitting(false);
          setButtonLabel("Run task");
          return;
        }

        setTitle("");
        setDescription("");
        setRepoUrl("");
        onCreated?.(result.task, { optimisticId, isOptimistic: false });
        setIsSubmitting(false);
        setButtonLabel("Run task");
      })().catch((actionError: unknown) => {
        const message = (actionError as Error).message ?? "Failed to create task";
        setError(message);
        onFailed?.(optimisticId, message);
        setIsSubmitting(false);
        setButtonLabel("Run task");
      });
    });
  };

  const inputClass =
    "mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none";
  const helper = helperText ?? "Runs async; monitor messages for progress and review the diff once complete.";

  return (
    <form onSubmit={handleSubmit} className={formClassName}>
      <div className={clsx("flex flex-col gap-4 md:flex-row md:items-end", compact && "md:items-start")}>
        <div className={clsx("flex-1 min-w-0", compact && "md:w-1/3")}>
          <label className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500" htmlFor="title">
            Task title
          </label>
          <input
            id="title"
            type="text"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={inputClass}
            placeholder="Create onboarding checklist"
          />
        </div>
        <div className="flex-1 min-w-0">
          <label className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500" htmlFor="repoUrl">
            Repository
          </label>
          <input
            id="repoUrl"
            type="url"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            className={inputClass}
            placeholder="https://github.com/acme/project"
          />
        </div>
      </div>
      <div className="mt-3">
        <label className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500" htmlFor="description">
          Details
        </label>
        <textarea
          id="description"
          rows={compact ? 3 : 4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={clsx(
            "mt-2 w-full resize-none rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none",
            compact ? "" : "min-h-[120px]"
          )}
          placeholder="Share goals, tools, acceptance criteria..."
        />
      </div>
      {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {helper ? <p className="text-xs text-neutral-500">{helper}</p> : <span />}
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-400"
        >
          {buttonLabel}
        </button>
      </div>
    </form>
  );
}
