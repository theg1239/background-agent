import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "./config";

const MIN_BACKOFF_MS = 5_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;

type OpenRouterClientFactory = ReturnType<typeof createOpenRouter>;

interface KeyState {
  key: string;
  label: string;
  mask: string;
  nextAvailableAt: number;
  consecutiveFailures: number;
}

export class OpenRouterKeysUnavailableError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(
      retryAfterMs > 0
        ? `All OpenRouter API keys are temporarily rate limited. Next retry in ${Math.ceil(
            retryAfterMs / 1000
          )}s.`
        : "All OpenRouter API keys are unavailable."
    );
    this.name = "OpenRouterKeysUnavailableError";
  }
}

function maskKey(key: string) {
  const suffix = key.slice(-4);
  return suffix ? `***${suffix}` : "***";
}

class OpenRouterKeyManager {
  private readonly keys: KeyState[];
  private cursor = 0;

  constructor(keys: string[]) {
    if (keys.length === 0) {
      throw new Error("At least one OpenRouter API key is required.");
    }
    this.keys = keys.map((key, index) => ({
      key,
      label: `openrouter-${index + 1}`,
      mask: maskKey(key),
      nextAvailableAt: 0,
      consecutiveFailures: 0
    }));
  }

  acquire(): { state: KeyState; index: number } {
    const now = Date.now();
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const index = (this.cursor + offset) % this.keys.length;
      const state = this.keys[index];
      if (state.nextAvailableAt <= now) {
        this.cursor = (index + 1) % this.keys.length;
        return { state, index };
      }
    }

    const soonest = Math.min(...this.keys.map((state) => state.nextAvailableAt));
    const waitMs = Math.max(soonest - now, MIN_BACKOFF_MS);
    throw new OpenRouterKeysUnavailableError(waitMs);
  }

  markSuccess(index: number) {
    const state = this.keys[index];
    state.consecutiveFailures = 0;
    state.nextAvailableAt = Date.now();
  }

  markRateLimited(index: number, retryAfterMs?: number) {
    const state = this.keys[index];
    state.consecutiveFailures += 1;
    const backoff = Math.max(
      retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS,
      MIN_BACKOFF_MS * state.consecutiveFailures
    );
    state.nextAvailableAt = Date.now() + backoff;
  }

  markFailure(index: number) {
    const state = this.keys[index];
    state.consecutiveFailures += 1;
    const backoff = Math.min(MIN_BACKOFF_MS * state.consecutiveFailures, 60_000);
    state.nextAvailableAt = Date.now() + backoff;
  }
}

let keyManager: OpenRouterKeyManager | null = null;

function getKeyManager(): OpenRouterKeyManager {
  if (!keyManager) {
    if (config.openrouterApiKeys.length === 0) {
      throw new Error("OpenRouter provider requested but no API keys are configured.");
    }
    keyManager = new OpenRouterKeyManager(config.openrouterApiKeys);
  }
  return keyManager;
}

export interface OpenRouterModelHandle {
  model: unknown;
  index: number;
  label: string;
  mask: string;
}

function parseRetryAfterMs(error: unknown): { retryAfterMs?: number; message: string } | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const message = error.message ?? "";
  const normalized = message.toLowerCase();

  const status = (error as { status?: number }).status;
  const causeStatus = (error as { cause?: { status?: number } })?.cause?.status;
  const isRateLimited =
    status === 429 ||
    causeStatus === 429 ||
    normalized.includes("quota") ||
    normalized.includes("rate limit");

  if (!isRateLimited) {
    return null;
  }

  const retryMatch = message.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  const retryAfterMs = retryMatch ? Number.parseFloat(retryMatch[1]) * 1000 : undefined;

  const retryAfterHeader =
    (error as { cause?: { headers?: Record<string, string> } })?.cause?.headers?.[
      "retry-after"
    ];
  const retryAfterHeaderMs =
    retryAfterHeader !== undefined ? Number.parseFloat(retryAfterHeader) * 1000 : undefined;

  return {
    message,
    retryAfterMs: retryAfterMs ?? retryAfterHeaderMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS
  };
}

export function acquireOpenRouterModel(modelName: string): OpenRouterModelHandle {
  const manager = getKeyManager();
  const { state, index } = manager.acquire();
  const client: OpenRouterClientFactory = createOpenRouter({
    apiKey: state.key,
    baseURL: config.openrouterBaseUrl
  });
  const model = client(modelName);
  return {
    model,
    index,
    label: state.label,
    mask: state.mask
  };
}

export function reportOpenRouterSuccess(handle: OpenRouterModelHandle) {
  getKeyManager().markSuccess(handle.index);
}

export function reportOpenRouterFailure(handle: OpenRouterModelHandle, error: unknown) {
  const parsed = parseRetryAfterMs(error);
  if (parsed) {
    getKeyManager().markRateLimited(handle.index, parsed.retryAfterMs);
    return {
      retryable: true as const,
      reason: "rate_limit" as const,
      retryAfterMs: parsed.retryAfterMs,
      message: parsed.message
    };
  }

  getKeyManager().markFailure(handle.index);
  return {
    retryable: false as const,
    reason: "fatal" as const,
    message: error instanceof Error ? error.message : "Unknown error"
  };
}
