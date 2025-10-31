# Background Coding Agent

An end-to-end prototype of a background coding agent platform. The Next.js frontend (deployed on Vercel) lets users create and monitor coding tasks. A long-running worker (deployed on EC2) polls the API, executes tasks autonomously with AI SDK 6 + Gemini, and streams progress back via resumable events.

## Monorepo Layout

- `apps/web` – Next.js App Router frontend (SSR + API routes).
- `apps/worker` – TypeScript worker service that runs on EC2.
- `packages/shared` – Shared Zod schemas and types used across services.

## Prerequisites

- Node.js 20+
- PNPM 9+
- Google AI Studio API key with access to Gemini 2.5 Pro (`GOOGLE_GENERATIVE_AI_API_KEY`).
- Internal API token shared between the web app and worker (`TASK_API_TOKEN`).

## Environment Variables

### Frontend (`apps/web`)

Create `.env.local` (never commit secrets):

```bash
TASK_API_TOKEN="local-dev-token"        # Optional; set to enforce auth for internal routes
UPSTASH_REDIS_URL="rediss://default:<token>@host:6379"  # Upstash Redis TLS URL
```

When deploying to Vercel, set `TASK_API_TOKEN` in the project settings so internal API endpoints require bearer auth from workers.

### Worker (`apps/worker`)

Create `.env` with:

```bash
TASK_API_BASE_URL="https://your-vercel-deployment.vercel.app"
TASK_API_TOKEN="local-dev-token"
GOOGLE_GENERATIVE_AI_API_KEY="..."
UPSTASH_REDIS_URL="rediss://default:<token>@host:6379"
QUEUE_POLL_INTERVAL_MS=2500            # optional
WORKER_MAX_CONCURRENCY=2               # optional
WORKER_ID="dev-worker-1"              # optional
WORKSPACES_DIR="/tmp/background-agent" # optional, defaults to .agent-workspaces
PERSIST_WORKSPACES=false               # set true to keep workspaces for debugging
```

## Install & Run Locally

```bash
pnpm install

# Start the Next.js app
yarn --cwd apps/web dev      # or `pnpm --filter web dev`

# In another terminal, run the worker
pnpm --filter @background-agent/worker dev
```

The worker polls `/api/internal/worker/tasks` to claim tasks, executes an agent loop, and reports progress events back to `/api/internal/tasks/:id/events`.

## How It Works

1. **Task creation** – Users submit title/description/repo URL from the dashboard.
2. **Redis-backed queue** – Web API enqueues tasks and exposes claim/ack endpoints backed by Redis leases so work survives restarts.
3. **Agent execution** – Worker uses AI SDK 6 `ToolLoopAgent` with Gemini 2.5 Pro to plan, log, and update status while manipulating a local Git workspace (clone, read/write files, run commands).
4. **Event streaming** – Frontend subscribes via Server-Sent Events (`/api/tasks/:id/events`) to replay historical and live updates. UI displays plan, status, log timeline, and generated artifacts like git diffs.
5. **Completion** – Agent emits `task.completed` (or `task.failed`) and the worker ACKs the queue item.

## Deployment Notes

- **Frontend**: Deploy `apps/web` on Vercel. Expose the internal API routes (`/api/internal/...`) and secure them via `TASK_API_TOKEN`.
- **Worker**: Build a Node.js 20+ runtime on EC2 (or any container runner). Use `pnpm --filter @background-agent/worker build` and run `node dist/index.js`. PM2 or systemd is recommended for restarts.
- **Redis**: Provision Upstash Redis and supply the REST credentials to both the Vercel project and the worker via environment variables.
- **Scaling**: Swap the in-memory queue for durable infrastructure (Redis Streams, Postgres advisory locks, etc.) before production. Update `task-queue.ts` + worker dispatcher accordingly.
- **Observability**: Pipe worker logs to CloudWatch/Loki, and add metrics (queue depth, task duration) for alerting.

## Next Steps

- Persist tasks/events in Postgres instead of Redis JSON blobs if you need relational queries.
- Add approval gates and artifact uploads from the worker.
- Implement resumable UI streams with storage-backed cursoring for long histories.
- Harden error handling (retry policies, exponential backoff, dead-letter queue).
- Add integration tests for API routes and worker flows.
