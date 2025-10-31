import { randomUUID } from "node:crypto";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { google } from "@ai-sdk/google";
import {
  CreateTaskInput,
  Task,
  TaskPlanStep,
  TaskStatusSchema
} from "@background-agent/shared";
import { config } from "./config";
import { TaskApiClient } from "./task-api";

interface RunTaskOptions {
  workerId: string;
  task: Task;
  input: CreateTaskInput;
  api: TaskApiClient;
}

const gemini = google({ apiKey: config.geminiApiKey });

export async function runTaskWithAgent({ workerId, task, input, api }: RunTaskOptions) {
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

    await api.postEvent(task.id, {
      id: randomUUID(),
      taskId: task.id,
      type: "task.updated",
      timestamp: Date.now(),
      payload: {
        status: parsed.data,
        reason,
        workerId
      }
    });
  };

  const agent = new ToolLoopAgent({
    model: gemini("gemini-2.5-pro"),
    instructions: `You are an autonomous senior software engineer inside a background task runner.
- Always maintain an explicit execution plan.
- Use the provided tools to update the plan, log progress, and change task status.
- Decompose work into small, verifiable steps.
- Never fabricate repository results; if you need external context, request human input via logs.
- Finish once the task is ready for human review and summarize key artifacts.`,
    stopWhen: stepCountIs(12),
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
          await api.postEvent(task.id, {
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
          await api.postEvent(task.id, {
            id: randomUUID(),
            taskId: task.id,
            type: "log.entry",
            timestamp: Date.now(),
            payload: { level, message, workerId }
          });
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
      })
    }
  });

  await updateStatus("executing", "Plan execution started");

  const prompt = `You are working on task "${task.title}".
Task description: ${task.description ?? "(none provided)"}.
Repository URL: ${input.repoUrl ?? "(not supplied)"}.
Constraints: ${(input.constraints ?? []).join("; ") || "None"}.
Branch: ${input.branch ?? "(not specified)"} (base: ${input.baseBranch ?? "main"}).

Deliver:
- Updated execution plan via the updatePlan tool.
- Log entries when meaningful work happens.
- Status transitions via setStatus.
- Final textual summary of progress and next steps.

Start by emitting an initial plan covering research, implementation, testing, and review.`;

  const { text, finishReason } = await agent.generate({ prompt });

  await api.postEvent(task.id, {
    id: randomUUID(),
    taskId: task.id,
    type: "task.completed",
    timestamp: Date.now(),
    payload: {
      status: "completed",
      summary: text ?? "Agent finished without summary",
      finishReason,
      workerId
    }
  });

  return { success: true, summary: text } as const;
}
