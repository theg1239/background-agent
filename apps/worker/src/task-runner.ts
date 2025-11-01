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

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "analysis";

export async function runTaskWithAgent({
  workerId,
  task,
  input,
  store,
  notifyTaskUpdate,
  notifyTaskEvent
}: RunTaskOptions) {
  const workspace = await Workspace.prepare(task.id);

  const broadcastFileUpdate = async (
    path: string,
    contents: string,
    previous: string | null,
    options?: { initial?: boolean; byteLength?: number }
  ) => {
    const bytes = options?.byteLength ?? Buffer.byteLength(contents, "utf8");
    const fileEvent = {
      id: randomUUID(),
      taskId: task.id,
      type: "task.file_updated",
      timestamp: Date.now(),
      payload: {
        path,
        contents,
        previous,
        bytes,
        initial: options?.initial ?? false,
        workerId
      }
    } satisfies TaskEvent;
    await store.appendEvent(task.id, fileEvent);
    await notifyTaskEvent?.(task.id, fileEvent);
  };

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

  const planStepInputSchema = z.object({
    id: z.string().optional(),
    title: z.string(),
    summary: z.string().optional(),
    status: z.enum(["pending", "in_progress", "completed", "failed"]).optional()
  });
  type PlanStepInput = z.infer<typeof planStepInputSchema>;

  const normalizeSteps = (steps: PlanStepInput[]): TaskPlanStep[] => {
    return steps.map((step, index) => {
      const id = step.id ?? `${task.id}-step-${index + 1}-${randomUUID().slice(0, 8)}`;
      const status: TaskPlanStep["status"] = step.status ?? "pending";
      return {
        id,
        title: step.title,
        summary: step.summary,
        status
      };
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

      const emitInitialWorkspaceSnapshot = async () => {
        const MAX_SNAPSHOT_FILES = 30;
        const MAX_SNAPSHOT_BYTES = 64_000;
        const skipPatterns = [
          /^node_modules\//,
          /^\.git\//,
          /^\.pnpm\//,
          /^\.turbo\//,
          /^dist\//,
          /^build\//
        ];
        const skipExtensions = [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".bmp",
          ".ico",
          ".webp",
          ".svg",
          ".pdf",
          ".zip",
          ".tar",
          ".tgz",
          ".gz"
        ];

        try {
          const candidates = await workspace.listFiles(".", 600);
          const files = candidates
            .map((entry) => ({
              raw: entry,
              normalized: entry.replace(/\\/g, "/")
            }))
            .filter(({ raw }) => !raw.endsWith("/"))
            .filter(({ normalized }) => !skipPatterns.some((pattern) => pattern.test(normalized)))
            .filter(({ normalized }) =>
              !skipExtensions.some((ext) => normalized.toLowerCase().endsWith(ext))
            );

          const selected = files.slice(0, MAX_SNAPSHOT_FILES);
          let emitted = 0;

          for (const { raw: rawPath, normalized: normalizedPath } of selected) {
            try {
              const contents = await workspace.readFile(rawPath);
              const byteLength = Buffer.byteLength(contents, "utf8");
              if (byteLength > MAX_SNAPSHOT_BYTES) {
                await emitLog(
                  "info",
                  `Skipping initial snapshot for ${normalizedPath} (${byteLength} bytes exceeds limit)`
                );
                continue;
              }
              if (contents.includes("\u0000")) {
                continue;
              }
              await broadcastFileUpdate(normalizedPath, contents, null, {
                initial: true,
                byteLength
              });
              emitted += 1;
            } catch (error) {
              await emitLog(
                "warning",
                `Unable to capture initial snapshot for ${normalizedPath}: ${(error as Error).message}`
              );
            }
          }

          if (emitted > 0) {
            await emitLog("info", `Captured ${emitted} initial file snapshots.`);
          }
        } catch (error) {
          await emitLog("warning", `Failed to enumerate repository files: ${(error as Error).message}`);
        }
      };

      await emitInitialWorkspaceSnapshot();
    } else {
      await emitLog("info", "No repository URL provided; starting with empty workspace");
      try {
        await workspace.git(["init"]);
        await workspace.git(["checkout", "-B", input.baseBranch ?? "main"]);
        await emitLog("info", "Initialized empty git repository for workspace");
      } catch (error) {
        await emitLog(
          "warning",
          `Failed to initialize git repository in workspace: ${(error as Error).message}`
        );
      }
    }

    let planWasUpdated = false;

    // --- Tool definitions (unchanged behavior) ---
    const toolsAll = {
      updatePlan: tool({
        description: "Update the execution plan with the latest steps and statuses.",
        inputSchema: z.object({
          steps: z.array(planStepInputSchema).min(1, "Provide at least one plan step."),
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

          planWasUpdated = true;
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
          let previousContents: string | undefined;
          try {
            previousContents = await workspace.readFile(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              await emitLog("warning", `Failed to read existing contents of ${path}: ${(error as Error).message}`);
            }
          }

          const result = await workspace.writeFile(path, contents);
          await emitLog("info", `Updated file ${path} (${result.bytes} bytes)`);

          await broadcastFileUpdate(path, contents, previousContents ?? null, {
            byteLength: result.bytes
          });

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
      riggrep: tool({
        description: "Search for text in the workspace using ripgrep (fast code search).",
        inputSchema: z.object({
          pattern: z.string(),
          path: z.string().default("."),
          regex: z.boolean().default(false),
          caseSensitive: z.boolean().optional(),
          glob: z.array(z.string()).optional(),
          context: z.number().min(0).max(10).default(2),
          maxMatches: z.number().min(1).max(200).default(100)
        }),
        execute: async ({ pattern, path, regex, caseSensitive, glob, context, maxMatches }) => {
          const result = await workspace.searchRipgrep(pattern, {
            path,
            regex,
            caseSensitive,
            glob,
            context,
            maxMatches
          });
          await emitLog(
            "info",
            `riggrep located ${result.matches.length} of ${result.totalMatches} matches for "${pattern}".`
          );
          return result;
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
      }),
      gitStatus: tool({
        description: "Show the current git status (branch, staged, unstaged, untracked files).",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const status = await workspace.getStatus();
            return { status };
          } catch (error) {
            const message =
              (error as Error).message ?? "Failed to read git status for the workspace.";
            await emitLog("warning", `gitStatus tool failed: ${message}`);
            return { status: "", error: message };
          }
        }
      })
    } as const;

    // Subset exposed for plan-first step:
    const toolsPlanOnly = {
      updatePlan: toolsAll.updatePlan,
      logProgress: toolsAll.logProgress,
      setStatus: toolsAll.setStatus
    } as const;

    const buildAgent = (languageModel: LanguageModel) =>
      new ToolLoopAgent({
        model: languageModel,
        instructions: `You are an autonomous senior software engineer inside a background task runner.
- Always maintain an explicit execution plan.
- Decompose work into small, verifiable steps and validate each change.
- Start by publishing an execution plan via the "updatePlan" tool, then proceed with implementation in this same run.
- Use repo tools (readFile/writeFile/listFiles/riggrep/gitStatus/gitDiff/runCommand) to gather evidence and modify files.
- Do not mark completion unless you produced concrete artifacts (code diffs, files) to justify closure.`,
        tools: toolsAll,
        // Hard ceiling; loop stops if this limit is hit.
        stopWhen: stepCountIs(config.agentStepLimit),
        // Force a plan on step 0; then allow normal execution.
        prepareStep: async ({ stepNumber }) => {
          if (stepNumber === 0 && !planWasUpdated) {
            // Narrow available tools and force the model to call updatePlan first.
            return {
              tools: toolsPlanOnly,
              toolChoice: { type: "tool", toolName: "updatePlan" }
            };
          }
          if (!planWasUpdated) {
            // Until the plan exists, require tool usage (prevents "just text" replies).
            return { toolChoice: "required" as const };
          }
          // After plan exists, allow normal behavior.
          return {};
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
1. Ship tangible value on every run—prefer concise, high-utility diffs or substantive written deliverables tied to the repo.
2. Maintain an explicit, evolving execution plan; never let the plan fall out of sync with reality.
3. Validate assumptions through repository inspection and commands rather than speculation.
4. Surface blockers early via log entries or status updates; do not silently stall.
5. Keep changes auditable: capture diffs, explain intent, and note residual risks.

Process Expectations
- Immediately call the updatePlan tool with a plan that spans research, implementation, testing, and review.
- Update the plan after each meaningful action so step statuses remain accurate.
- Log progress for notable milestones, insights, or decisions (minimum once per major phase).
- Use setStatus when transitioning between planning, executing, and completion states.
- Exercise repository tools (readFile/writeFile/listFiles/runCommand/riggrep/gitDiff/gitStatus) to gather evidence and modify files efficiently.

Quality Bar & Validation
- Run relevant checks when practical; if impractical, explain why and describe alternate validation.
- Before finishing, review the gitDiff output to ensure the artifacts align with the task intent.
- If work produces no code changes, produce a concrete artifact in the repo (e.g., README or report) instead of exiting silently.

Deliverables
- A final summary message that highlights implemented changes, validation performed, and recommended next steps.

Begin by emitting the initial execution plan described above.`;

    const coerceText = async (result: any): Promise<string> => {
      try {
        if (!result) return "";
        if (typeof result.text === "string") return result.text;
        const response = (result as any).response;
        const maybeTextFn = response?.text ?? (result as any).text;
        if (typeof maybeTextFn === "function") {
          const out = await maybeTextFn.call(response ?? result);
          if (typeof out === "string") return out;
        }
        const messages = response?.messages ?? (result as any).messages;
        if (Array.isArray(messages) && messages.length > 0) {
          let last: any | undefined;
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i];
            if (m && (m as any).role === "assistant") {
              last = m;
              break;
            }
          }
          if (!last) last = messages[messages.length - 1];
          const content = (last as any)?.content;
          if (typeof content === "string") return content;
        }
      } catch {}
      return "";
    };

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
          const normalizedText = await coerceText(result);
          reportGeminiSuccess(handle);
          return { ...result, text: normalizedText };
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

    // One-time prompt refinement step to clarify objectives and constraints
    let refinedBrief = "";
    try {
      await emitLog("info", "Refining task prompt and constraints...");
      const refinePrompt = `You are a prompt refinement assistant for a background coding agent. Rewrite and clarify the task below into a concise "Refined Brief" with:

- Objectives (3-5 bullet points)
- Assumptions (explicit, reasonable)
- Constraints and non-goals
- Deliverables (what counts as "done")
- Validation plan (how to verify)

Keep it under 200 words, in markdown. Do not include code. Avoid speculation about the repo beyond what is given.

Task title: ${task.title}
Task description: ${task.description ?? "(none provided)"}
Repository URL: ${input.repoUrl ?? "(not supplied)"}
Constraints: ${(input.constraints ?? []).join("; ") || "None"}
Working branch: ${input.branch ?? "(not specified)"} (base: ${input.baseBranch ?? "main"})`;

      const refinement = await generateWithGemini(refinePrompt);
      refinedBrief = (refinement.text ?? "").trim();
      if (refinedBrief) {
        await emitLog("info", `Refined Brief:\n\n${refinedBrief}`);
      } else {
        await emitLog("warning", "Prompt refinement returned empty text; proceeding with base prompt.");
      }
    } catch (error) {
      await emitLog(
        "warning",
        `Prompt refinement failed: ${(error as Error).message}. Proceeding without refinement.`
      );
    }

    const effectiveBasePrompt = refinedBrief
      ? `${basePrompt}\n\nRefined Brief\n${refinedBrief}`
      : basePrompt;

    let latestSummary = "";
    const maxAgentPasses = Math.max(1, config.agentMaxPasses);
    for (let attempt = 1; attempt <= maxAgentPasses; attempt += 1) {
      if (attempt > 1) {
        await emitLog(
          "info",
          `Re-running agent pass ${attempt} of ${maxAgentPasses} after previous pass produced no diff.`
        );
        await updateStatus(
          "executing",
          `Follow-up execution (pass ${attempt} of ${maxAgentPasses})`
        );
      }

      const prompt =
        attempt === 1
          ? effectiveBasePrompt
          : `${effectiveBasePrompt}

Previous passes (${attempt - 1}) finished without producing shippable artifacts. You are on pass ${attempt} of ${maxAgentPasses}. Treat this run as a critical escalation:
- Ship a concrete deliverable before exiting (code change, new file, or detailed written assessment committed to the repo).
- Narrow scope, execute decisively, and validate results via repository evidence.`;

      const { text, finishReason } = await generateWithGemini(prompt);
      latestSummary = (text ?? "").trim();

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

      if (attempt < maxAgentPasses) {
        await emitLog(
          "warning",
          `Agent pass ${attempt} completed without tangible output; preparing pass ${attempt + 1} of ${maxAgentPasses}.`
        );
        await updateStatus(
          "planning",
          `Revisiting approach after empty diff (pass ${attempt})`
        );
      }
    }

    // If we reach here, there is still no artifact
    if (!planWasUpdated) {
      await emitLog("error", "Agent loop ended without publishing an execution plan.");
      await updateStatus("failed", "No plan published");
      throw new Error("Agent did not publish an execution plan for review.");
    }

    await emitLog("error", "Agent loop ended without producing artifacts (no git diff).");
    await updateStatus("failed", "No tangible artifacts produced");
    throw new Error("No tangible output after agent passes.");
  } finally {
    await workspace.cleanup();
  }
}