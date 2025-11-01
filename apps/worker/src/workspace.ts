import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { exec as execCallback, execFile as execFileCallback } from "node:child_process";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

const toPosixPath = (value: string) => value.replace(/\\/g, "/");

function resolveWorkspaceRoot(taskId: string) {
  const root = process.env.WORKSPACES_DIR ?? path.join(process.cwd(), ".agent-workspaces");
  return path.resolve(root, taskId);
}

function ensureInsideWorkspace(workspaceRoot: string, target: string) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const normalized = path.resolve(target);
  if (!normalized.startsWith(resolvedRoot)) {
    throw new Error("Path escapes workspace boundaries");
  }
  return normalized;
}

export class Workspace {
  constructor(readonly root: string) {}

  static async prepare(taskId: string): Promise<Workspace> {
    const root = resolveWorkspaceRoot(taskId);
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    return new Workspace(root);
  }

  async cloneRepository(repoUrl: string, options?: { baseBranch?: string; branch?: string }) {
    await execFile("git", ["clone", repoUrl, this.root], { maxBuffer: 10 * 1024 * 1024 });
    if (options?.baseBranch) {
      await this.git(["checkout", options.baseBranch]);
    }
    if (options?.branch) {
      const args = ["checkout", "-B", options.branch];
      if (options.baseBranch) {
        args.push(options.baseBranch);
      }
      await this.git(args);
    }
  }

  async git(args: string[]) {
    return execFile("git", args, { cwd: this.root, maxBuffer: 10 * 1024 * 1024 });
  }

  async readFile(relative: string) {
    const full = ensureInsideWorkspace(this.root, path.join(this.root, relative));
    return fs.readFile(full, "utf8");
  }

  async writeFile(relative: string, contents: string) {
    const full = ensureInsideWorkspace(this.root, path.join(this.root, relative));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents, "utf8");
    return { path: relative, bytes: Buffer.byteLength(contents, "utf8") };
  }

  async stageFile(relative: string, options?: { force?: boolean }) {
    ensureInsideWorkspace(this.root, path.join(this.root, relative));
    const args = ["add"];
    if (options?.force) {
      args.push("--force");
    }
    args.push("--", relative);
    try {
      await this.git(args);
      return { staged: true as const };
    } catch (error) {
      return { staged: false as const, error: error as Error };
    }
  }

  async listFiles(relative = ".", limit = 200) {
    const start = ensureInsideWorkspace(this.root, path.join(this.root, relative));
    const results: string[] = [];

    const walk = async (dir: string) => {
      if (results.length >= limit) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        return;
      }
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        const displayPath = path.relative(this.root, entryPath);
        results.push(displayPath + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory()) {
          await walk(entryPath);
        }
        if (results.length >= limit) break;
      }
    };

    await walk(start);
    return results.slice(0, limit);
  }

  async searchRipgrep(
    pattern: string,
    options?: {
      path?: string;
      glob?: string[];
      regex?: boolean;
      caseSensitive?: boolean;
      context?: number;
      maxMatches?: number;
    }
  ) {
    const resolved = options?.path
      ? ensureInsideWorkspace(this.root, path.join(this.root, options.path))
      : this.root;
    const relativeTarget = path.relative(this.root, resolved) || ".";
    const args = ["--json", "--line-number", "--no-heading", "--color=never"];

    const maxMatches = Math.min(Math.max(options?.maxMatches ?? 100, 1), 500);
    // Limit per-file results to help keep responses small.
    args.push("--max-count", String(Math.max(10, Math.ceil(maxMatches / 2))));

    if (options?.regex !== true) {
      args.push("--fixed-strings");
    }
    if (options?.caseSensitive === true) {
      args.push("--case-sensitive");
    } else if (options?.caseSensitive === false) {
      args.push("--ignore-case");
    } else {
      args.push("--smart-case");
    }

    const contextLines = Math.min(Math.max(options?.context ?? 2, 0), 10);
    if (contextLines > 0) {
      args.push(`-C${contextLines}`);
    }

    const defaultGlobs = [
      "!.git/*",
      "!node_modules/*",
      "!.pnpm/*",
      "!dist/*",
      "!build/*",
      "!tmp/*",
      "!.turbo/*"
    ];
    for (const glob of [...defaultGlobs, ...(options?.glob ?? [])]) {
      args.push("--glob", glob);
    }

    args.push("--", pattern, relativeTarget);

    let stdout = "";
    try {
      const result = await execFile("rg", args, {
        cwd: this.root,
        maxBuffer: 10 * 1024 * 1024
      });
      stdout = result.stdout;
    } catch (error) {
      const err = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
        cause?: unknown;
      };
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "ripgrep (rg) is not installed on the worker machine. Install rg to use the riggrep tool."
        );
      }
      if (typeof err.code === "number" && err.code === 1) {
        stdout = err.stdout ?? "";
      } else {
        throw error;
      }
    }

    type RipgrepMatchEvent = {
      type: "match";
      data: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        absolute_offset?: number;
        submatches?: Array<{
          match?: { text?: string };
          start?: number;
          end?: number;
        }>;
      };
    };
    type RipgrepSummaryEvent = {
      type: "summary";
      data?: {
        elapsed_total?: { millis?: number };
        stats?: { matches?: number; searches?: number; matcheds?: number };
      };
    };
    type RipgrepUnknownEvent = {
      type: string;
      data?: unknown;
    };
    type RipgrepEvent = RipgrepMatchEvent | RipgrepSummaryEvent | RipgrepUnknownEvent;

    const isMatchEvent = (event: RipgrepEvent): event is RipgrepMatchEvent =>
      event.type === "match" && typeof event.data === "object" && event.data !== null;
    const isSummaryEvent = (event: RipgrepEvent): event is RipgrepSummaryEvent =>
      event.type === "summary";

    const matches: Array<{
      path: string;
      line: number;
      text: string;
      submatches: Array<{ text: string; start: number; end: number }>;
    }> = [];

    let totalMatches = 0;
    let summary: { elapsedMs?: number; searches?: number; matches?: number } = {};

    for (const line of stdout.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      let event: RipgrepEvent;
      try {
        event = JSON.parse(line) as RipgrepEvent;
      } catch {
        continue;
      }

      if (isMatchEvent(event)) {
        totalMatches += 1;
        if (matches.length >= maxMatches) {
          continue;
        }

        const filePath = event.data.path?.text ? toPosixPath(event.data.path.text) : relativeTarget;
        const lineNumber = event.data.line_number ?? 0;
        const text = (event.data.lines?.text ?? "").replace(/\r?\n$/, "");
        const submatches =
          event.data.submatches?.map((sub) => ({
            text: sub.match?.text ?? "",
            start: sub.start ?? 0,
            end: sub.end ?? 0
          })) ?? [];

        matches.push({ path: filePath, line: lineNumber, text, submatches });
      } else if (isSummaryEvent(event)) {
        const data = event.data ?? {};
        summary = {
          elapsedMs: data.elapsed_total?.millis,
          searches: data.stats?.searches,
          matches: data.stats?.matches ?? totalMatches
        };
      }
    }

    return {
      pattern,
      root: toPosixPath(relativeTarget) || ".",
      matches,
      totalMatches,
      truncated: matches.length < totalMatches,
      stats: summary
    };
  }

  async getStatus() {
    const { stdout } = await execFile("git", ["status", "--short", "--branch"], {
      cwd: this.root,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  }

  async runCommand(command: string, options?: { timeoutMs?: number }) {
    try {
      const { stdout, stderr } = await exec(command, {
        cwd: this.root,
        timeout: options?.timeoutMs ?? 60_000,
        maxBuffer: 10 * 1024 * 1024
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        code?: number;
        signal?: NodeJS.Signals;
      };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: typeof err.code === "number" ? err.code : 1,
        signal: err.signal
      };
    }
  }

  async getDiff() {
    try {
      const status = await execFile("git", ["status", "--porcelain=v1", "-z"], {
        cwd: this.root,
        maxBuffer: 10 * 1024 * 1024
      });

      const statusEntries = status.stdout
        .split("\0")
        .map((entry) => entry.replace(/\r$/, ""))
        .filter((entry) => entry.length > 0);

      if (statusEntries.length === 0) {
        return "";
      }

      const untrackedFiles: string[] = [];
      for (let index = 0; index < statusEntries.length; index += 1) {
        const entry = statusEntries[index];
        if (entry.length < 3) {
          continue;
        }
        const code = entry.slice(0, 2);
        let filePath = entry.slice(3);
        if ((code.startsWith("R") || code.startsWith("C")) && index + 1 < statusEntries.length) {
          filePath = statusEntries[index + 1];
          index += 1;
        }
        if (code === "??") {
          if (filePath) {
            untrackedFiles.push(filePath);
          }
        }
      }

      const diffs: string[] = [];

      const staged = await execFile("git", ["diff", "--cached"], {
        cwd: this.root,
        maxBuffer: 10 * 1024 * 1024
      });
      if (staged.stdout.trim()) {
        diffs.push(staged.stdout);
      }

      const unstaged = await execFile("git", ["diff"], {
        cwd: this.root,
        maxBuffer: 10 * 1024 * 1024
      });
      if (unstaged.stdout.trim()) {
        diffs.push(unstaged.stdout);
      }

      for (const relativePath of untrackedFiles) {
        try {
          const { stdout } = await execFile(
            "git",
            ["diff", "--no-index", "--", "/dev/null", relativePath],
            {
              cwd: this.root,
              maxBuffer: 10 * 1024 * 1024
            }
          );
          if (stdout.trim()) {
            diffs.push(stdout);
          }
        } catch (error) {
          const err = error as Error & { stdout?: string };
          if (err.stdout?.trim()) {
            diffs.push(err.stdout);
          }
        }
      }

      return diffs.join("\n");
    } catch (error) {
      return "";
    }
  }

  async cleanup() {
    if (process.env.PERSIST_WORKSPACES === "true") {
      return;
    }
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
