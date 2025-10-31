import { randomUUID } from "node:crypto";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { CreateTaskInput, Task, TaskEvent, TaskPlanStep } from "@background-agent/shared";
import { TaskStatusSchema, TaskStore } from "@background-agent/shared";
import { config } from "./config";
import {
  acquireGeminiModel,
  GeminiKeysUnavailableError,
  reportGeminiFailure,
  reportGeminiSuccess
} from "./gemini";
import { Workspace } from "./workspace";

interface RunTaskOptions {
  workerId: string;
  task: Task;
  input: CreateTaskInput;
  store: TaskStore;
  notifyTaskUpdate?: (taskId: string) => Promise<void>;
  notifyTaskEvent?: (taskId: string, event: TaskEvent) => Promise<void>;
}

const MODEL_NAME = "gemini-2.5-flash";
const MAX_GEMINI_ATTEMPTS = Math.max(config.geminiApiKeys.length * 5, 5);
const MAX_GEMINI_WAIT_MS = 5 * 60_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runTaskWithAgent({
  workerId,
  task,
  input,
  store,
  notifyTaskUpdate,
  notifyTaskEvent
}: RunTaskOptions) {
  const workspace = await Workspace.prepare(task.id);

  const emitLog = async (level: "info" | "warning" | "error", message: string) => {
    const event = {
      id: randomUUID(),
      taskId: task.id,
      type: "log.entry",
      timestamp: Date.now(),
      payload: { level, message, workerId }
    } satisfies TaskEvent;
    await store.appendEvent(task.id, event);
    await notifyTaskEvent?.(task.id, event);
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
    await notifyTaskUpdate?.(task.id);
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

    const buildAgent = (languageModel: LanguageModel) =>
      new ToolLoopAgent({
        model: languageModel,
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
        const event = {
          id: randomUUID(),
          taskId: task.id,
          type: "plan.updated",
          timestamp: Date.now(),
          payload: {
            plan: normalized,
            note
          }
        } satisfies TaskEvent;
        await store.appendEvent(task.id, event);
        await notifyTaskEvent?.(task.id, event);
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
    const basePrompt = `You are working on task "${task.title}" as an autonomous senior software engineer embedded in a background worker.

Context
- Task description: ${task.description ?? "(none provided)"}.
- Repository URL: ${input.repoUrl ?? "(not supplied)"}.
- Constraints: ${(input.constraints ?? []).join("; ") || "None"}.
- Working branch: ${input.branch ?? "(not specified)"} (base: ${input.baseBranch ?? "main"}).

Operating Principles
1. Ship tangible value on every run—prefer concise, high-utility diffs or substantive written deliverables.
2. Maintain an explicit, evolving execution plan; never let the plan fall out of sync with reality.
3. Validate assumptions through repository inspection and commands rather than speculation.
4. Surface blockers early via log entries or status updates; do not silently stall.
5. Keep changes auditable: capture diffs, explain intent, and note residual risks.

Process Expectations
- Immediately call the updatePlan tool with a plan that spans research, implementation, testing, and review.
- Update the plan after each meaningful action so step statuses remain accurate.
- Log progress for notable milestones, insights, or decisions (minimum once per major phase).
- Use setStatus when transitioning between planning, executing, and completion states.
- Exercise repository tools (readFile/writeFile/listFiles/runCommand/gitDiff) to gather evidence and modify files.

Quality Bar & Validation
- Run relevant tests or checks when practical; if impractical, explain why and describe alternate validation.
- Before finishing, review the gitDiff output to ensure the artifacts align with the task intent.
- If work produces no code changes, create documentation updates or a concrete security/quality report instead of exiting silently.

Deliverables
- A final summary that highlights implemented changes, validation performed, and recommended next steps.
- Any supporting documentation or reports needed to justify the closure of the task.

Begin by emitting the initial execution plan described above.`;

    const generateWithGemini = async (prompt: string) => {
      let attempts = 0;
      let totalWaitMs = 0;
      let lastError: unknown;

      while (attempts < MAX_GEMINI_ATTEMPTS) {
        let handle;
        try {
          handle = acquireGeminiModel(MODEL_NAME);
        } catch (error) {
          if (error instanceof GeminiKeysUnavailableError) {
            if (totalWaitMs >= MAX_GEMINI_WAIT_MS) {
              throw new Error(
                `Gemini API keys remained rate limited for ${Math.ceil(totalWaitMs / 1000)}s.`
              );
            }

            const remainingBudget = Math.max(MAX_GEMINI_WAIT_MS - totalWaitMs, 0);
            const waitMs = Math.min(error.retryAfterMs, Math.max(remainingBudget, 1_000));
            totalWaitMs += waitMs;

            await emitLog(
              "warning",
              `All Gemini API keys are rate limited; waiting ${Math.ceil(
                waitMs / 1000
              )}s before retrying.`
            );
            await delay(waitMs);
            continue;
          }
          throw error;
        }

        attempts += 1;
        const agent = buildAgent(handle.model as unknown as LanguageModel);
        try {
          const result = await agent.generate({ prompt });
          reportGeminiSuccess(handle);
          return result;
        } catch (error) {
          lastError = error;
          const outcome = reportGeminiFailure(handle, error);

          if (outcome.retryable) {
            const retrySeconds = Math.ceil((outcome.retryAfterMs ?? 30_000) / 1000);
            await emitLog(
              "warning",
              `Gemini ${handle.label} (${handle.mask}) hit a rate limit. Backing off this key for ${retrySeconds}s and rotating to the next key.`
            );
            continue;
          }

          throw error;
        }
      }

      const message =
        lastError instanceof Error
          ? `Failed to call Gemini after ${attempts} rotated attempts. Last error: ${lastError.message}`
          : `Failed to call Gemini after ${attempts} rotated attempts.`;

      await emitLog("error", message);
      throw lastError instanceof Error ? lastError : new Error(message);
    };

    let latestSummary = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) {
        await updateStatus("executing", "Follow-up execution after empty diff");
      }

      const prompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}

The first pass finished without producing tangible artifacts. Treat this follow-up as a high-priority escalation:
- Identify a concrete deliverable you can complete within this attempt (code change, new file, or detailed written assessment).
- Narrow scope; act decisively—do not rehash the previous plan without executing.
- If code changes truly are unnecessary, produce a written artifact (e.g. SECURITY.md update or incident note) that captures why.`;

      const { text, finishReason } = await generateWithGemini(prompt);
      latestSummary = text ?? "Agent finished without summary";

      const diff = await workspace.getDiff();
      if (diff.trim()) {
        const artifactEvent = {
          id: randomUUID(),
          taskId: task.id,
          type: "task.artifact_generated",
          timestamp: Date.now(),
          payload: {
            artifactType: "git_diff",
            diff,
            workerId
          }
        } satisfies TaskEvent;
        await store.appendEvent(task.id, artifactEvent);
        await notifyTaskEvent?.(task.id, artifactEvent);

        const completedEvent = {
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
        } satisfies TaskEvent;
        await store.appendEvent(task.id, completedEvent);
        await notifyTaskEvent?.(task.id, completedEvent);
        await notifyTaskUpdate?.(task.id);

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
