import "dotenv/config";

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveRedisUrl() {
  const candidates = [
    process.env.UPSTASH_REDIS_URL,
    process.env.REDIS_URL,
    process.env.UPSTASH_REDIS_REST_URL?.replace("https://", "rediss://")
  ];
  for (const value of candidates) {
    if (value) return value;
  }
  throw new Error("Missing UPSTASH_REDIS_URL (expected format rediss://default:password@host:6379)");
}

export const config = {
  redisUrl: resolveRedisUrl(),
  pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS ?? "2500"),
  maxConcurrentTasks: Number(process.env.WORKER_MAX_CONCURRENCY ?? "2"),
  geminiApiKey: required(
    "GOOGLE_GENERATIVE_AI_API_KEY",
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  )
};
