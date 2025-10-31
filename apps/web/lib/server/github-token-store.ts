import { redis } from "./redis";

const KEY_PREFIX = "github:token:";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface StoredGitHubToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  user?: {
    login: string;
    avatarUrl?: string;
  };
}

function makeKey(sessionId: string) {
  return `${KEY_PREFIX}${sessionId}`;
}

export async function saveGitHubToken(sessionId: string, record: StoredGitHubToken) {
  await redis.set(makeKey(sessionId), JSON.stringify(record), "EX", TOKEN_TTL_SECONDS);
}

export async function getGitHubToken(sessionId: string): Promise<StoredGitHubToken | undefined> {
  const value = await redis.get(makeKey(sessionId));
  if (!value) return undefined;
  try {
    return JSON.parse(value) as StoredGitHubToken;
  } catch (error) {
    console.error("Failed to parse stored GitHub token", error);
    return undefined;
  }
}

export async function deleteGitHubToken(sessionId: string) {
  await redis.del(makeKey(sessionId));
}
