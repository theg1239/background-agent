# Background Agent Worker

This worker package spawns the autonomous coding agent that executes queued tasks. It prepares a disposable workspace, clones the target repository (if provided), and coordinates the AI-powered agent (Gemini or OpenRouter, selectable at runtime) across multiple passes until a tangible artifact exists.

## Execution Flow

- Provision an isolated workspace for the pending task.
- Clone the requested repository or initialise an empty Git repository when no URL is supplied.
- Stream plan updates, log entries, file writes, and git diffs back to the task store.
- Retry the agent up to the configured number of passes when no deliverable is produced.
- Fall back to a written analysis report when the agent exits without modifying the repository.

## Agentic Loop Expectations

The worker wraps the configured language model in an [`ai` `ToolLoopAgent`](https://ai-sdk.dev/docs/agents/tool-loop-agent).  
Key behaviours enforced by `task-runner.ts`:

- The agent receives explicit instructions that require it to maintain a plan, log progress, and justify completion.
- `toolChoice` is set to `required`, so every step must call one of the workspace tools (`updatePlan`, `logProgress`, `setStatus`, `readFile`, `writeFile`, etc.). This prevents the model from short-circuiting with a plain-text answer.
- Each tool invocation maps to task-store events, allowing the web dashboard to render plan updates, logs, diff previews, and status changes in real time.
- When all passes finish without repository changes, the worker writes a fallback analysis report to `.background-agent/` and force-stages it so the Git diff always contains an auditable artifact.

## Fallback Analysis Reports

If every agent pass completes without generating a diff, the worker now writes a Markdown report under `.background-agent/`. The report captures the final agent summary or, when none is available, a default message that directs operators to the task logs.

These reports ensure that every task attempt leaves audit trails in git history, helping operators understand why a run failed and what the agent observed.

## Development Notes

- Key settings live in `apps/worker/src/config.ts`.
- Manual runs can use `pnpm --filter worker start` from the repository root.
- Model provider defaults can be tuned through environment variables in `apps/worker/src/config.ts`.
- Set `AI_PROVIDER` to choose the backend: `gemini` (default) requires `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEYS`, while `openrouter` requires `OPENROUTER_API_KEY` or `OPENROUTER_API_KEYS` (with an optional `OPENROUTER_BASE_URL`).
- Optional overrides include `GEMINI_MODEL_NAME` (default `gemini-2.5-pro`), `OPENROUTER_MODEL_ID` (default `anthropic/claude-3.5-sonnet`), and `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`).
