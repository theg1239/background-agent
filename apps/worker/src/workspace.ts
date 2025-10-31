import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { exec as execCallback, execFile as execFileCallback } from "node:child_process";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

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
