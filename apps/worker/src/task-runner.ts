import { randomUUID } from "node:crypto";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { CreateTaskInput, Task, TaskPlanStep } from "@background-agent/shared";
import { TaskStatusSchema, TaskStore } from "@background-agent/shared";
import { config } from "./config";
import { Workspace } from "./workspace";

interface RunTaskOptions {
  workerId: string;
  task: Task;
  input: CreateTaskInput;
  store: TaskStore;
}

const google = createGoogleGenerativeAI({ apiKey: config.geminiApiKey });

export async function runTaskWithAgent({ workerId, task, input, store }: RunTaskOptions) {
  const workspace = await Workspace.prepare(task.id);

  const emitLog = async (level: "info" | "warning" | "error", message: string) => {
    await store.appendEvent(task.id, {
      id: randomUUID(),
      taskId: task.id,
      type: "log.entry",
      timestamp: Date.now(),
      payload: { level, message, workerId }
    });
  };

  const normalizeSteps = (
    steps: Array<{
      id?: string;
      title: string;
      summary?: string;
      status?: TaskPlanStep["status"];
    }>
  ): TaskPlanStep[] => {
    return steps.map((step, index) => {
      const id = step.id ?? `${task.id}-step-${index + 1}-${randomUUID().slice(0, 8)}`;
      return {
        id,
        title: step.title,
        summary: step.summary,
        status: step.status ?? "pending"
      } satisfies TaskPlanStep;
    });
  };

  const updateStatus = async (status: Task["status"], reason?: string) => {
    const parsed = TaskStatusSchema.safeParse(status);
    if (!parsed.success) {
      return;
    }

    await store.updateStatus(task.id, parsed.data, { reason, workerId });
  };

  try {
    await emitLog("info", `Initializing workspace at ${workspace.root}`);
    if (input.repoUrl) {
      await emitLog("info", `Cloning repository ${input.repoUrl}`);
      await workspace.cloneRepository(input.repoUrl, {
        baseBranch: input.baseBranch,
        branch: input.branch
      });
      await emitLog("info", "Repository clone complete");
    } else {
      await emitLog("info", "No repository URL provided; starting with empty workspace");
    }

    const model = google("gemini-2.5-flash");

    const createAgent = () =>
      new ToolLoopAgent({
        model: model as unknown as LanguageModel,
        instructions: `You are an autonomous senior software engineer inside a background task runner.
- Always maintain an explicit execution plan.
- Use the provided tools to update the plan, log progress, change task status, and work with the repository.
- Decompose work into small, verifiable steps and validate each change.
- Never fabricate repository results; if you need external context, request human input via logs.
- Do not mark the task complete until you have produced concrete artifacts (code changes, documentation updates, or a detailed security report) that justify completion.`,
        stopWhen: stepCountIs(30),
        tools: {
          updatePlan: tool({
            description: "Update the execution plan with the latest steps and statuses.",
            inputSchema: z.object({
              steps: z.array(
                z.object({
                id: z.string().optional(),
                title: z.string(),
                summary: z.string().optional(),
                status: z.enum(["pending", "in_progress", "completed", "failed"]).optional()
              })
            ),
            note: z.string().optional()
          }),
          execute: async ({ steps, note }) => {
            const normalized = normalizeSteps(
              steps.map((step) => ({
                id: step.id,
                title: step.title,
                summary: step.summary,
                status: step.status ?? "pending"
              }))
            );
            await store.appendEvent(task.id, {
              id: randomUUID(),
              taskId: task.id,
              type: "plan.updated",
              timestamp: Date.now(),
              payload: {
                plan: normalized,
                note
              }
            });
            return { acknowledged: true };
          }
        }),
        logProgress: tool({
          description: "Log progress messages for the human operator.",
          inputSchema: z.object({
            level: z.enum(["info", "warning", "error"]).default("info"),
            message: z.string()
          }),
          execute: async ({ level, message }) => {
            await emitLog(level, message);
            return { acknowledged: true };
          }
        }),
        setStatus: tool({
          description: "Set the overall task status when you transition between phases.",
          inputSchema: z.object({
            status: TaskStatusSchema,
            reason: z.string().optional()
          }),
          execute: async ({ status, reason }) => {
            await updateStatus(status, reason);
            return { acknowledged: true };
          }
        }),
        readFile: tool({
          description: "Read a UTF-8 file from the workspace",
          inputSchema: z.object({
            path: z.string()
          }),
          execute: async ({ path }) => {
            const contents = await workspace.readFile(path);
            return { path, contents };
          }
        }),
        writeFile: tool({
          description: "Write a UTF-8 file inside the workspace",
          inputSchema: z.object({
            path: z.string(),
            contents: z.string()
          }),
          execute: async ({ path, contents }) => {
            const result = await workspace.writeFile(path, contents);
            await emitLog("info", `Updated file ${path} (${result.bytes} bytes)`);
            return result;
          }
        }),
        listFiles: tool({
          description: "List files relative to the workspace root",
          inputSchema: z.object({
            path: z.string().default("."),
            limit: z.number().min(1).max(500).default(200)
          }),
          execute: async ({ path, limit }) => {
            const files = await workspace.listFiles(path, limit);
            return { files };
          }
        }),
        runCommand: tool({
          description: "Run a shell command inside the workspace",
          inputSchema: z.object({
            command: z.string(),
            timeoutMs: z.number().min(1_000).max(300_000).optional()
          }),
          execute: async ({ command, timeoutMs }) => {
            const result = await workspace.runCommand(command, { timeoutMs });
            await emitLog("info", `Ran command: ${command}`);
            return result;
          }
        }),
        gitDiff: tool({
          description: "Return the current git diff for the workspace",
          inputSchema: z.object({}),
          execute: async () => {
            const diff = await workspace.getDiff();
            return { diff };
          }
        })
      }
    });

    await updateStatus("executing", "Plan execution started");
    const basePrompt = `You are working on task "${task.title}".
Task description: ${task.description ?? "(none provided)"}.
Repository URL: ${input.repoUrl ?? "(not supplied)"}.
Constraints: ${(input.constraints ?? []).join("; ") || "None"}.
Branch: ${input.branch ?? "(not specified)"} (base: ${input.baseBranch ?? "main"}).

Deliver:
- Updated execution plan via the updatePlan tool.
- Log entries when meaningful work happens.
- Status transitions via setStatus.
- Use readFile/writeFile/listFiles/runCommand/gitDiff tools to inspect and modify the repository.
 - Final textual summary of progress, key diffs, and next steps. If you determine no code changes are needed, produce a detailed security assessment and documentation updates explaining why.

Start by emitting an initial plan covering research, implementation, testing, and review.`;

    let latestSummary = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const agent = createAgent();
      if (attempt > 1) {
        await updateStatus("executing", "Follow-up execution after empty diff");
      }

      const prompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}

The first pass finished without producing tangible artifacts. Perform a focused follow-up that delivers concrete documentation updates, security findings, or code changes. Avoid re-stating the original plan without additional action.`;

      const { text, finishReason } = await agent.generate({ prompt });
      latestSummary = text ?? "Agent finished without summary";

      const diff = await workspace.getDiff();
      if (diff.trim()) {
        await store.appendEvent(task.id, {
          id: randomUUID(),
          taskId: task.id,
          type: "task.artifact_generated",
          timestamp: Date.now(),
          payload: {
            artifactType: "git_diff",
            diff,
            workerId
          }
        });

        await store.appendEvent(task.id, {
          id: randomUUID(),
          taskId: task.id,
          type: "task.completed",
          timestamp: Date.now(),
          payload: {
            status: "completed",
            summary: latestSummary,
            finishReason,
            workerId
          }
        });

        return { success: true, summary: latestSummary } as const;
      }

      if (attempt === 1) {
        await emitLog(
          "warning",
          "First pass produced no workspace changes; running a focused follow-up with stricter requirements."
        );
        await updateStatus("planning", "Revisiting approach after empty diff");
      }
    }

    throw new Error("Agent finished without producing workspace changes.");
  } finally {
    await workspace.cleanup();
  }
}
