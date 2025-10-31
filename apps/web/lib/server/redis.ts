import Redis from "ioredis";

type RedisGlobal = typeof globalThis & {
  __backgroundAgentRedis?: Redis;
};

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

function createRedisClient() {
  const client = new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true
  });

  client.on("error", (error) => {
    console.error("Redis connection error", error);
  });

  return client;
}

export function getRedis(): Redis {
  const globalWithRedis = globalThis as RedisGlobal;
  if (!globalWithRedis.__backgroundAgentRedis) {
    globalWithRedis.__backgroundAgentRedis = createRedisClient();
  }
  return globalWithRedis.__backgroundAgentRedis;
}
