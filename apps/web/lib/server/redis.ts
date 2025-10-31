import { Redis } from "@upstash/redis";

type RedisGlobal = typeof globalThis & {
  __backgroundAgentRedis?: Redis;
};

export function getRedis(): Redis {
  const globalWithRedis = globalThis as RedisGlobal;
  if (!globalWithRedis.__backgroundAgentRedis) {
    globalWithRedis.__backgroundAgentRedis = Redis.fromEnv();
  }
  return globalWithRedis.__backgroundAgentRedis;
}
