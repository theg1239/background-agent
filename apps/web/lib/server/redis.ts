import Redis from "ioredis";

const redisUrl =
  process.env.UPSTASH_REDIS_URL ??
  process.env.REDIS_URL ??
  process.env.UPSTASH_REDIS_REST_URL?.replace("https://", "rediss://") ??
  "";

if (!redisUrl) {
  throw new Error("Missing UPSTASH_REDIS_URL (e.g. rediss://default:password@host:6379)");
}

type RedisGlobal = typeof globalThis & {
  __backgroundAgentRedis?: Redis;
};

const globalWithRedis = globalThis as RedisGlobal;

export const redis =
  globalWithRedis.__backgroundAgentRedis ??
  (globalWithRedis.__backgroundAgentRedis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false
  }));
