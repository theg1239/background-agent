# Background Coding Agent

An end-to-end prototype of a background coding agent platform. The Next.js frontend (deployed on Vercel) lets users create and monitor coding tasks. A long-running worker (deployed on EC2) cooperates over Redis, executes tasks autonomously with AI SDK 6 + Gemini, and pushes live updates over a Socket.IO channel.

## Monorepo Layout

- `apps/web` – Next.js App Router frontend (Server Components + Server Actions + Socket.IO client).
- `apps/worker` – TypeScript worker service that runs on EC2 and also hosts the Socket.IO server.
- `packages/shared` – Shared Zod schemas, task store, and queue helpers used across services.

## Prerequisites

- Node.js 20+
- PNPM 9+
- Google AI Studio API key with access to Gemini 2.5 Pro (`GOOGLE_GENERATIVE_AI_API_KEY`).

## Environment Variables

### Frontend (`apps/web`)

Create `.env.local` (never commit secrets):

```bash
UPSTASH_REDIS_URL="rediss://default:<token>@host:6379"  # Upstash Redis TLS URL
NEXT_PUBLIC_SOCKET_URL="http://localhost:4000"          # URL of the worker's Socket.IO server
GITHUB_TOKEN="<personal-access-token>"                  # Needed for PR creation (will move to OAuth)
```

### Worker (`apps/worker`)

Create `.env` with:

```bash
GOOGLE_GENERATIVE_AI_API_KEY="..."
UPSTASH_REDIS_URL="rediss://default:<token>@host:6379"
QUEUE_POLL_INTERVAL_MS=2500              # optional
WORKER_MAX_CONCURRENCY=2                 # optional
WORKER_ID="dev-worker-1"                # optional
WORKER_SOCKET_PORT=4000                  # optional
WORKER_SOCKET_HOST="0.0.0.0"             # optional
WORKER_SOCKET_CORS_ORIGIN="http://localhost:3000"  # comma-separated list allowed
WORKSPACES_DIR="/tmp/background-agent"   # optional, defaults to .agent-workspaces
PERSIST_WORKSPACES=false                 # set true to keep workspaces for debugging
```

## Install & Run Locally

```bash
pnpm install

# Start the Next.js app
pnpm --filter web dev

# In another terminal, run the worker
pnpm --filter @background-agent/worker dev
```

## How It Works

1. **Task creation** – Users submit title/description/repo URL from the dashboard.
2. **Redis-backed queue** – Server actions enqueue work via Redis lists + lease tracking. The worker claims tasks directly through the shared queue helpers (no HTTP round-trips).
3. **Agent execution** – Worker uses AI SDK 6 `ToolLoopAgent` with Gemini 2.5 Pro to plan, log, and update status while manipulating a local Git workspace (clone, read/write files, run commands).
4. **Event streaming** – The worker hosts a Socket.IO server. Whenever the task store mutates, the worker emits `task:update` and `task:event` messages; the browser subscribes to the socket and updates the UI in real time without relying on long-lived Vercel routes.
5. **Completion** – Agent emits `task.completed` (or `task.failed`) and the worker ACKs the queue item.

## Deployment Notes

- **Frontend**: Deploy `apps/web` on Vercel. Provide the Upstash Redis URL and the public Socket.IO URL as environment variables.
- **Worker**: Build a Node.js 20+ runtime on EC2 (or any container runner). Use `pnpm --filter @background-agent/worker build` and run `node dist/index.js`. PM2 or systemd is recommended for restarts. Ensure the socket port is exposed (and TLS terminated if running over the public internet).
- **Redis**: Provision Upstash Redis and supply the credentials to both the Vercel project and the worker via environment variables.
- **Scaling**: Swap the in-memory queue for durable infrastructure (Redis Streams, Postgres advisory locks, etc.) before production. Update `task-queue.ts` + worker dispatcher accordingly.
- **Observability**: Pipe worker logs to CloudWatch/Loki, and add metrics (queue depth, task duration) for alerting.

## Next Steps

- Persist tasks/events in Postgres instead of Redis JSON blobs if you need relational queries.
- Add approval gates and artifact uploads from the worker.
- Implement resumable UI streams with storage-backed cursoring for long histories.
- Harden error handling (retry policies, exponential backoff, dead-letter queue).
- Add integration tests for API routes and worker flows.
