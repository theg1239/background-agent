import "dotenv/config";

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];

  return raw
    .split(/[, \n\r\t]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function requireNonEmpty(name: string, values: string[]) {
  if (values.length === 0) {
    throw new Error(`Environment variable ${name} must include at least one API key.`);
  }
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
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
  aiProvider: (() => {
    const raw = (process.env.AI_PROVIDER ?? "gemini").trim().toLowerCase();
    if (raw === "gemini" || raw === "openrouter") {
      return raw;
    }
    throw new Error(
      `Unsupported AI_PROVIDER "${process.env.AI_PROVIDER}". Expected "gemini" or "openrouter".`
    );
  })(),
  geminiApiKeys: parseList(
    process.env.GOOGLE_GENERATIVE_AI_API_KEYS ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
  ),
  geminiModelName: (process.env.GEMINI_MODEL_NAME ?? "gemini-2.5-pro").trim(),
  openrouterApiKeys: parseList(
    process.env.OPENROUTER_API_KEYS ?? process.env.OPENROUTER_API_KEY
  ),
  openrouterModelName: (process.env.OPENROUTER_MODEL_ID ?? "anthropic/claude-4.5-sonnet").trim(),
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").trim(),
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
  })(),
  agentMaxPasses: positiveInteger("AGENT_MAX_PASSES", 3),
  agentStepLimit: positiveInteger("AGENT_STEP_LIMIT", 60)
};

if (config.aiProvider === "gemini") {
  requireNonEmpty(
    "GOOGLE_GENERATIVE_AI_API_KEYS or GOOGLE_GENERATIVE_AI_API_KEY",
    config.geminiApiKeys
  );
} else if (config.aiProvider === "openrouter") {
  requireNonEmpty("OPENROUTER_API_KEYS or OPENROUTER_API_KEY", config.openrouterApiKeys);
}
