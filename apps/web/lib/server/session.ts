"use server"

import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

const SESSION_COOKIE_NAME = "bg-agent-session";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

type SessionOptions = {
  createIfMissing?: boolean;
};

export async function getSessionId(options?: SessionOptions): Promise<string | undefined> {
  const store = await cookies();
  const existing = store.get(SESSION_COOKIE_NAME)?.value;
  if (existing) {
    return existing;
  }
  if (options?.createIfMissing === false) {
    return undefined;
  }
  const nextId = randomUUID();
  store.set(SESSION_COOKIE_NAME, nextId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS
  });
  return nextId;
}

export async function requireSessionId(): Promise<string> {
  const id = await getSessionId({ createIfMissing: true });
  if (!id) {
    throw new Error("Unable to establish session");
  }
  return id;
}
