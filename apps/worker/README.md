# Worker Application

This is the worker application for the background-agent project. It processes background tasks using AI agents.

## Docker Usage

### Building the Docker Image

From the repository root directory, build the Docker image:

```bash
docker build -t background-agent-worker -f apps/worker/Dockerfile .
```

### Running the Container

Run the container with required environment variables:

```bash
docker run -d \
  --name worker \
  -p 4000:4000 \
  -e UPSTASH_REDIS_URL="rediss://default:password@host:6379" \
  -e GOOGLE_GENERATIVE_AI_API_KEY="your-api-key" \
  -e WORKER_SOCKET_CORS_ORIGIN="*" \
  background-agent-worker
```

### Environment Variables

#### Required

- `UPSTASH_REDIS_URL` or `REDIS_URL` - Redis connection URL (format: `rediss://default:password@host:6379`)
- `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEYS` - Google Generative AI API key(s). Multiple keys can be comma-separated.

#### Optional

- `WORKER_SOCKET_PORT` - Socket server port (default: `4000`)
- `WORKER_SOCKET_HOST` - Socket server host (default: `0.0.0.0`)
- `WORKER_SOCKET_CORS_ORIGIN` - CORS origin for socket connections (default: `*`)
- `QUEUE_POLL_INTERVAL_MS` - Polling interval for task queue in milliseconds (default: `1000`)
- `WORKER_MAX_CONCURRENCY` - Maximum concurrent tasks (default: `2`)
- `WORKER_ID` - Unique worker identifier (default: auto-generated UUID)
- `AGENT_MAX_PASSES` - Maximum number of agent passes (default: `3`)
- `AGENT_STEP_LIMIT` - Maximum steps per agent pass (default: `60`)

### Using Docker Compose

Example `docker-compose.yml`:

```yaml
version: '3.8'

services:
  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
    ports:
      - "4000:4000"
    environment:
      - UPSTASH_REDIS_URL=${UPSTASH_REDIS_URL}
      - GOOGLE_GENERATIVE_AI_API_KEY=${GOOGLE_GENERATIVE_AI_API_KEY}
      - WORKER_SOCKET_CORS_ORIGIN=*
    restart: unless-stopped
```

## Local Development

### Install Dependencies

```bash
pnpm install
```

### Development Mode

```bash
pnpm dev:worker
```

### Build

```bash
pnpm build:worker
```

### Production Mode

```bash
pnpm --filter worker start
```
