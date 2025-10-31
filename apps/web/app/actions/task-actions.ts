"use server";

import { applyPatch, parsePatch } from "diff";
import { z } from "zod";
import {
  CreateTaskInputSchema,
  type CreateTaskInput,
  type TaskEvent
} from "@background-agent/shared";
import { taskStore } from "../../lib/server/task-store";
import { enqueueTaskExecution } from "../../lib/server/worker-dispatch";
import { requireSessionId } from "../../lib/server/session";
import { getGitHubToken } from "../../lib/server/github-token-store";

function sanitizeCreateTaskInput(input: CreateTaskInput): CreateTaskInput {
  const title = input.title.trim();
  const description = input.description?.trim();
  const repoUrl = input.repoUrl ? normalizeRepoUrl(input.repoUrl) : undefined;

  return {
    ...input,
    title,
    description: description ? description : undefined,
    repoUrl
  };
}

function normalizeRepoUrl(original: string): string | undefined {
  const trimmed = original.trim();
  if (!trimmed) return undefined;

  const firstProtocol = trimmed.indexOf("://");
  if (firstProtocol !== -1) {
    const secondProtocol = trimmed.indexOf("://", firstProtocol + 3);
    if (secondProtocol !== -1) {
      return trimmed.slice(0, secondProtocol);
    }
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export async function createTaskAction(input: CreateTaskInput) {
  const parsed = CreateTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors[0]?.message ?? "Invalid input";
    return { ok: false, error: message } as const;
  }

  const sanitized = sanitizeCreateTaskInput(parsed.data);

  try {
    const task = await taskStore.createTask(sanitized);
    await enqueueTaskExecution(task);
    return { ok: true, task } as const;
  } catch (error) {
    return { ok: false, error: (error as Error).message } as const;
  }
}

const CreatePullRequestSchema = z.object({
  taskId: z.string().min(1),
  eventId: z.string().min(1),
  baseBranch: z.string().min(1),
  branchName: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional()
});

export async function createPullRequestAction(input: z.infer<typeof CreatePullRequestSchema>) {
  const parsed = CreatePullRequestSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.errors[0]?.message ?? "Invalid request";
    return { ok: false, error: message } as const;
  }

  const { taskId, eventId, baseBranch, branchName, title, body } = parsed.data;

  const sessionId = await requireSessionId();
  const tokenRecord = await getGitHubToken(sessionId);
  if (!tokenRecord) {
    return {
      ok: false,
      error: "GitHub authorization is required. Connect your GitHub account before creating a pull request."
    } as const;
  }

  const task = await taskStore.getTask(taskId);
  if (!task) {
    return { ok: false, error: "Task not found." } as const;
  }

  if (!task.repoUrl) {
    return {
      ok: false,
      error: "Task does not specify a repository URL."
    } as const;
  }

  const snapshot = await taskStore.getEventStreamSnapshot(taskId);
  const event = snapshot?.events.find((candidate: TaskEvent) => candidate.id === eventId);

  if (!event || event.type !== "task.artifact_generated") {
    return {
      ok: false,
      error: "The selected artifact is not available."
    } as const;
  }

  const diff = typeof event.payload?.diff === "string" ? event.payload.diff : undefined;
  if (!diff || !diff.trim()) {
    return {
      ok: false,
      error: "The artifact does not include a diff payload."
    } as const;
  }

  const repoInfo = extractRepoInfo(task.repoUrl);
  if (!repoInfo) {
    return {
      ok: false,
      error: "Unable to determine repository owner and name from the URL."
    } as const;
  }

  const normalizedBase = sanitizeRef(baseBranch);
  const normalizedBranch = sanitizeRef(branchName);
  if (!normalizedBase) {
    return {
      ok: false,
      error: "Base branch name is invalid."
    } as const;
  }
  if (!normalizedBranch) {
    return {
      ok: false,
      error: "Proposed branch name is invalid."
    } as const;
  }

  const hasRepoScope = tokenRecord.scope
    .split(/[\s,]+/)
    .some((entry) => entry.trim() === "repo" || entry.trim() === "public_repo");
  if (!hasRepoScope) {
    return {
      ok: false,
      error: "The connected GitHub token is missing the required repo scope."
    } as const;
  }

  const github = createGitHubClient(tokenRecord.accessToken);

  try {
    const baseRef = await github.getJson(
      `/repos/${repoInfo.owner}/${repoInfo.repo}/git/ref/heads/${encodeRef(normalizedBase)}`
    );

    const baseCommitSha = baseRef.object?.sha as string | undefined;
    if (!baseCommitSha) {
      throw new Error(`Base branch ${normalizedBase} is missing a commit reference.`);
    }

    const baseCommit = await github.getJson(
      `/repos/${repoInfo.owner}/${repoInfo.repo}/git/commits/${baseCommitSha}`
    );
    const baseTreeSha = baseCommit.tree?.sha as string | undefined;
    if (!baseTreeSha) {
      throw new Error("Unable to resolve the base tree for the selected branch.");
    }

    const treeResponse = await github.getJson(
      `/repos/${repoInfo.owner}/${repoInfo.repo}/git/trees/${baseTreeSha}?recursive=1`
    );

    const baseTreeEntries = new Map<string, GitTreeEntry>();
    for (const entry of treeResponse.tree as GitTreeEntry[]) {
      if (entry.type === "blob" && entry.path) {
        baseTreeEntries.set(entry.path, entry);
      }
    }

    const patches = parsePatch(diff);
    if (!patches.length) {
      throw new Error("The diff payload is empty.");
    }

    const treeUpdates: GitTreeUpdate[] = [];

    for (const patch of patches) {
      const oldPath = normalizeDiffPath(patch.oldFileName);
      const newPath = normalizeDiffPath(patch.newFileName);
      const isAddition = !oldPath && Boolean(newPath);
      const isDeletion = !newPath && Boolean(oldPath);
      const isRename = Boolean(oldPath && newPath && oldPath !== newPath);
      const targetPath = newPath ?? oldPath;

      if (!targetPath) {
        continue;
      }

      const baseEntry = oldPath ? baseTreeEntries.get(oldPath) : undefined;

      let baseContent = "";
      if (!isAddition) {
        if (!baseEntry) {
          throw new Error(`Base file not found for patch: ${oldPath}`);
        }
        const blob = await github.getJson(
          `/repos/${repoInfo.owner}/${repoInfo.repo}/git/blobs/${baseEntry.sha}`
        );
        baseContent = decodeBlob(blob);
      }

      if (isDeletion) {
        treeUpdates.push({
          path: targetPath,
          sha: null,
          mode: baseEntry?.mode ?? "100644",
          type: "blob"
        });
        continue;
      }

      const applied = applyPatch(baseContent, patch);
      if (applied === false) {
        throw new Error(`Failed to apply patch for ${targetPath}`);
      }

      const blob = await github.getJson(
        `/repos/${repoInfo.owner}/${repoInfo.repo}/git/blobs`,
        {
          method: "POST",
          body: JSON.stringify({ content: applied, encoding: "utf-8" })
        }
      );

      const mode = baseEntry?.mode ?? "100644";

      if (isRename && oldPath) {
        treeUpdates.push({
          path: oldPath,
          sha: null,
          mode: baseEntry?.mode ?? "100644",
          type: "blob"
        });
      }

      treeUpdates.push({
        path: targetPath,
        sha: blob.sha,
        mode,
        type: "blob"
      });
    }

    if (!treeUpdates.length) {
      throw new Error("No file updates were generated from the diff.");
    }

    const newTree = await github.getJson(`/repos/${repoInfo.owner}/${repoInfo.repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeUpdates
      })
    });

    const commitMessage = title.trim();
    const commit = await github.getJson(
      `/repos/${repoInfo.owner}/${repoInfo.repo}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: commitMessage,
          tree: newTree.sha,
          parents: [baseCommitSha]
        })
      }
    );

    const branchRef = `refs/heads/${normalizedBranch}`;
    const createRefResponse = await github.fetch(
      `/repos/${repoInfo.owner}/${repoInfo.repo}/git/refs`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: branchRef,
          sha: commit.sha
        })
      }
    );

    if (createRefResponse.status === 422) {
      await github.getJson(
        `/repos/${repoInfo.owner}/${repoInfo.repo}/git/refs/heads/${encodeRef(normalizedBranch)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha, force: true })
        }
      );
    } else if (!createRefResponse.ok) {
      const message = await createRefResponse.text();
      throw new Error(`Failed to create branch: ${message}`);
    }

    const pr = await github.getJson(`/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: commitMessage,
        head: normalizedBranch,
        base: normalizedBase,
        body: body?.trim() ? body.trim() : undefined
      })
    });

    return {
      ok: true,
      pullRequestUrl: pr.html_url as string
    } as const;
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message
    } as const;
  }
}

type GitTreeEntry = {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
};

type GitTreeUpdate = {
  path: string;
  mode: string;
  type: "blob";
  sha: string | null;
};

function extractRepoInfo(repoUrl: string): { owner: string; repo: string } | undefined {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.hostname !== "github.com") return undefined;
    const segments = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (segments.length < 2) return undefined;
    return { owner: segments[0]!, repo: segments[1]! };
  } catch {
    return undefined;
  }
}

function sanitizeRef(ref: string): string {
  return ref
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._\/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeDiffPath(value?: string | null): string | undefined {
  if (!value || value === "/dev/null") return undefined;
  return value.replace(/^a\//, "").replace(/^b\//, "");
}

function encodeRef(ref: string): string {
  return ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeBlob(blob: { content?: string; encoding?: string }): string {
  if (!blob.content) return "";
  if (blob.encoding === "base64") {
    return Buffer.from(blob.content, "base64").toString("utf8");
  }
  return blob.content;
}

function createGitHubClient(token: string) {
  const defaultHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "background-agent"
  } as const;

  return {
    async fetch(path: string, init?: RequestInit) {
      const headers = new Headers(init?.headers ?? {});
      for (const [key, value] of Object.entries(defaultHeaders)) {
        headers.set(key, value);
      }
      if (init?.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      return fetch(`https://api.github.com${path}`, {
        ...init,
        headers
      });
    },
    async getJson(path: string, init?: RequestInit) {
      const response = await this.fetch(path, init);
      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `GitHub request failed (${response.status} ${response.statusText}): ${message}`
        );
      }
      return response.json();
    }
  };
}
