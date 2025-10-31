"use client";

import { FormEvent, useState } from "react";
import useSWRMutation from "swr/mutation";
import { CreateTaskInput, Task } from "@background-agent/shared";

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

export function CreateTaskForm({ onCreated }: { onCreated?: (task: Task) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const { trigger, isMutating, error } = useSWRMutation("/api/tasks", createTaskRequest);

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

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-4 shadow-lg">
      <div>
        <label className="block text-sm font-medium text-zinc-300" htmlFor="title">
          Task title
        </label>
        <input
          id="title"
          type="text"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
          placeholder="Implement background coding agent MVP"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-zinc-300" htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
          placeholder="List acceptance criteria, repositories, and constraints"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-zinc-300" htmlFor="repoUrl">
          Repository URL
        </label>
        <input
          id="repoUrl"
          type="url"
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
          placeholder="https://github.com/acme/awesome-repo"
        />
      </div>
      {error ? <p className="text-sm text-red-400">{error.message}</p> : null}
      <button
        type="submit"
        disabled={isMutating}
        className="w-full rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-900"
      >
        {isMutating ? "Creating..." : "Create task"}
      </button>
    </form>
  );
}
