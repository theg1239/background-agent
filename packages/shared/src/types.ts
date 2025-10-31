import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "queued",
  "planning",
  "executing",
  "awaiting_approval",
  "paused",
  "completed",
  "failed"
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  summary: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional()
});
export type TaskPlanStep = z.infer<typeof TaskPlanStepSchema>;

export const TaskEventTypeSchema = z.enum([
  "task.created",
  "task.updated",
  "task.completed",
  "task.failed",
  "task.awaiting_approval",
  "task.approval_resolved",
  "task.artifact_generated",
  "task.file_updated",
  "plan.updated",
  "plan.step_started",
  "plan.step_completed",
  "log.entry"
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;
export const TASK_EVENT_TYPES = TaskEventTypeSchema.options;

export const TaskEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: TaskEventTypeSchema,
  timestamp: z.number(),
  payload: z.record(z.any()).optional()
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  repoUrl: z.string().url().optional(),
  status: TaskStatusSchema,
  plan: z.array(TaskPlanStepSchema).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  assignee: z.string().optional(),
  latestEventId: z.string().optional(),
  riskScore: z.number().min(0).max(1).optional()
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskInputSchema = z.object({
  title: z.string().min(3),
  description: z.string().optional(),
  repoUrl: z.string().url().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  constraints: z.array(z.string()).optional()
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const WorkerCommandSchema = z.object({
  task: TaskSchema,
  input: CreateTaskInputSchema
});
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;

export const TaskEventStreamSnapshotSchema = z.object({
  task: TaskSchema,
  events: z.array(TaskEventSchema),
  cursor: z.string().optional()
});
export type TaskEventStreamSnapshot = z.infer<
  typeof TaskEventStreamSnapshotSchema
>;

export const TaskApprovalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.number(),
  resolvedAt: z.number().optional()
});
export type TaskApproval = z.infer<typeof TaskApprovalSchema>;

export interface TaskBroadcaster {
  publishTaskUpdate(task: Task): Promise<void>;
  publishTaskDeleted(taskId: string): Promise<void>;
  publishTaskEvent(taskId: string, event: TaskEvent): Promise<void>;
}
