"use client";

import { FormEvent, useMemo, useState } from "react";
import useSWRMutation from "swr/mutation";
import { CreateTaskInput, Task } from "@background-agent/shared";
import { clsx } from "clsx";

async function createTaskRequest(
  url: string,
  { arg }: { arg: CreateTaskInput }
): Promise<{ task: Task }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(arg)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? "Failed to create task");
  }
  return res.json();
}

interface CreateTaskFormProps {
  onCreated?: (task: Task) => void;
  compact?: boolean;
}

export function CreateTaskForm({ onCreated, compact = false }: CreateTaskFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const { trigger, isMutating, error } = useSWRMutation("/api/tasks", createTaskRequest);

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
    await trigger(
      {
        title,
        description: description || undefined,
        repoUrl: repoUrl || undefined
      },
      {
        onSuccess: (data) => {
          setTitle("");
          setDescription("");
          setRepoUrl("");
          onCreated?.(data.task);
        }
      }
    );
  };

  const inputClass = "mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none";

  return (
    <form onSubmit={handleSubmit} className={formClassName}>
      <div className={clsx("flex flex-col gap-4", compact && "sm:flex-row sm:items-end")}
      >
        <div className={clsx("flex-1", compact && "sm:max-w-xs")}
        >
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
        <div className="flex-1">
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
      {error ? <p className="mt-2 text-sm text-red-400">{error.message}</p> : null}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="hidden text-xs text-neutral-500 sm:block">The agent queues instantly and streams progress as it works.</p>
        <button
          type="submit"
          disabled={isMutating}
          className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-400"
        >
          {isMutating ? "Sending..." : "Send to agent"}
        </button>
      </div>
    </form>
  );
}
