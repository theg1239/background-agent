import "dotenv/config";

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  taskApiBaseUrl: required("TASK_API_BASE_URL", process.env.TASK_API_BASE_URL),
  taskApiToken: required("TASK_API_TOKEN", process.env.TASK_API_TOKEN),
  pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS ?? "2500"),
  maxConcurrentTasks: Number(process.env.WORKER_MAX_CONCURRENCY ?? "2"),
  geminiApiKey: required(
    "GOOGLE_GENERATIVE_AI_API_KEY",
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  )
};
