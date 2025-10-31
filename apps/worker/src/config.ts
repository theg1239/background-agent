import "dotenv/config";

function requiredList(name: string, raw: string | undefined): string[] {
  if (!raw) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  const values = raw
    .split(/[, \n\r\t]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) {
    throw new Error(`Environment variable ${name} must include at least one API key.`);
  }

  return values;
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
  pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS ?? "1000"),
  maxConcurrentTasks: Number(process.env.WORKER_MAX_CONCURRENCY ?? "2"),
  geminiApiKeys: requiredList(
    "GOOGLE_GENERATIVE_AI_API_KEYS or GOOGLE_GENERATIVE_AI_API_KEY",
    process.env.GOOGLE_GENERATIVE_AI_API_KEYS ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
  ),
  socketPort: Number(process.env.WORKER_SOCKET_PORT ?? "4000"),
  socketHost: process.env.WORKER_SOCKET_HOST ?? "0.0.0.0",
  socketCorsOrigin: (() => {
    const raw = process.env.WORKER_SOCKET_CORS_ORIGIN;
    if (!raw || raw === "*") {
      return "*";
    }
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  })()
};
