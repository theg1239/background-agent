# syntax=docker/dockerfile:1

# Build stage
FROM node:20-alpine AS builder

# Install pnpm via corepack (built-in to Node.js)
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy package manager configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Copy shared package (workspace dependency)
COPY packages/shared ./packages/shared

# Copy worker application
COPY apps/worker ./apps/worker

# Install all dependencies (including dev dependencies for building)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Build shared package first (dependency)
RUN pnpm --filter @background-agent/shared build

# Build worker application
RUN pnpm --filter @background-agent/worker build

# Production stage
FROM node:20-alpine AS production

# Install pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy package manager configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Copy shared package files
COPY packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Copy worker package.json
COPY apps/worker/package.json ./apps/worker/

# Install production dependencies only
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# Copy built worker application
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

# Expose socket server port (default: 4000)
EXPOSE 4000

# Set working directory to worker
WORKDIR /app/apps/worker

# Run the worker application
CMD ["node", "dist/index.js"]
