import { getGitHubToken } from "./github-token-store";
import { getSessionId } from "./session";

export interface GitHubAuthState {
  status: "connected" | "disconnected";
  user?: {
    login: string;
    avatarUrl?: string;
  };
}

export async function getOrCreateGitHubAuthState(): Promise<GitHubAuthState> {
  const sessionId = await getSessionId({ createIfMissing: false });
  if (!sessionId) {
    return { status: "disconnected" };
  }
  const token = await getGitHubToken(sessionId);
  if (!token) {
    return { status: "disconnected" };
  }
  return {
    status: "connected",
    user: token.user
  };
}

export async function peekGitHubAuthState(): Promise<GitHubAuthState> {
  const sessionId = await getSessionId({ createIfMissing: false });
  if (!sessionId) {
    return { status: "disconnected" };
  }
  const token = await getGitHubToken(sessionId);
  if (!token) {
    return { status: "disconnected" };
  }
  return {
    status: "connected",
    user: token.user
  };
}
