import { NextRequest } from "next/server";

const INTERNAL_TOKEN = process.env.TASK_API_TOKEN;

export function assertInternalRequest(request: NextRequest) {
  if (!INTERNAL_TOKEN) {
    // allow requests when token is not set (local development)
    return;
  }

  const header = request.headers.get("authorization");
  if (!header) {
    throw new Error("Missing Authorization header");
  }

  const expected = `Bearer ${INTERNAL_TOKEN}`;
  if (header !== expected) {
    throw new Error("Unauthorized");
  }
}
