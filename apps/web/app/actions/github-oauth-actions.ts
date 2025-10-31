"use server";

import { requireSessionId, getSessionId } from "../../lib/server/session";
import {
  deleteGitHubToken,
  getGitHubToken,
  saveGitHubToken,
  type StoredGitHubToken
} from "../../lib/server/github-token-store";
import type { GitHubAuthState } from "../../lib/server/github-auth";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export interface StartDeviceFlowResult {
  ok: true;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface OAuthErrorResult {
  ok: false;
  error: string;
}

export async function startGitHubDeviceFlowAction(): Promise<StartDeviceFlowResult | OAuthErrorResult> {
  const clientId = requireEnv("GITHUB_OAUTH_CLIENT_ID", process.env.GITHUB_OAUTH_CLIENT_ID);
  await requireSessionId();

  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: "repo"
    })
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || payload.error) {
    const message = typeof payload.error_description === "string"
      ? payload.error_description
      : "Failed to start GitHub authorization.";
    return { ok: false, error: message };
  }

  return {
    ok: true,
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code),
    verificationUri: String(payload.verification_uri ?? "https://github.com/login/device"),
    expiresIn: Number(payload.expires_in ?? 900),
    interval: Number(payload.interval ?? 5)
  };
}

interface PollSuccess {
  ok: true;
  auth: GitHubAuthState;
}

interface PollPending {
  ok: false;
  status: "pending" | "slow_down";
  interval: number;
}

interface PollFailure {
  ok: false;
  status: "error";
  error: string;
}

export async function pollGitHubDeviceFlowAction(deviceCode: string): Promise<PollSuccess | PollPending | PollFailure> {
  if (!deviceCode) {
    return { ok: false, status: "error", error: "Missing device code." };
  }

  const clientId = requireEnv("GITHUB_OAUTH_CLIENT_ID", process.env.GITHUB_OAUTH_CLIENT_ID);
  const clientSecret = requireEnv("GITHUB_OAUTH_CLIENT_SECRET", process.env.GITHUB_OAUTH_CLIENT_SECRET);
  const sessionId = await requireSessionId();

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    })
  });

  const payload = (await response.json()) as Record<string, unknown>;
  const error = typeof payload.error === "string" ? payload.error : undefined;

  if (error === "authorization_pending") {
    const interval = Number(payload.interval ?? 5);
    return { ok: false, status: "pending", interval };
  }

  if (error === "slow_down") {
    const interval = Number(payload.interval ?? 5) + 5;
    return { ok: false, status: "slow_down", interval };
  }

  if (error) {
    const message = typeof payload.error_description === "string"
      ? payload.error_description
      : `GitHub authorization failed (${error}).`;
    return { ok: false, status: "error", error: message };
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined;
  const tokenType = typeof payload.token_type === "string" ? payload.token_type : "bearer";
  const scope = typeof payload.scope === "string" ? payload.scope : "";

  if (!accessToken) {
    return { ok: false, status: "error", error: "GitHub did not return an access token." };
  }

  let user: StoredGitHubToken["user"] | undefined;
  try {
    const userResponse = await fetch(USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "background-agent"
      }
    });
    if (userResponse.ok) {
      const userPayload = (await userResponse.json()) as Record<string, unknown>;
      if (typeof userPayload.login === "string") {
        user = {
          login: userPayload.login,
          avatarUrl: typeof userPayload.avatar_url === "string" ? userPayload.avatar_url : undefined
        };
      }
    }
  } catch (userError) {
    console.error("Failed to fetch GitHub user", userError);
  }

  const record: StoredGitHubToken = {
    accessToken,
    tokenType,
    scope,
    user
  };

  await saveGitHubToken(sessionId, record);

  return {
    ok: true,
    auth: {
      status: "connected",
      user
    }
  };
}

export async function disconnectGitHubAction(): Promise<{ ok: true } | OAuthErrorResult> {
  const sessionId = await getSessionId({ createIfMissing: false });
  if (!sessionId) {
    return { ok: true };
  }
  await deleteGitHubToken(sessionId);
  return { ok: true };
}

export async function getGitHubAuthStateAction(): Promise<GitHubAuthState> {
  const existingSessionId = await getSessionId({ createIfMissing: false });
  if (!existingSessionId) {
    return { status: "disconnected" };
  }
  const token = await getGitHubToken(existingSessionId);
  if (!token) {
    return { status: "disconnected" };
  }
  return {
    status: "connected",
    user: token.user
  };
}
