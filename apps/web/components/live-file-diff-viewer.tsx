"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { clsx } from "clsx";
import { diffLines } from "diff";

type MonacoDiffEditorComponent = ComponentType<{
  original?: string;
  modified?: string;
  language?: string;
  options?: Record<string, unknown>;
  className?: string;
  height?: string | number;
  theme?: string;
}>;

const MonacoDiffEditor = dynamic(async () => {
  const mod = await import("@monaco-editor/react");
  return mod.DiffEditor as MonacoDiffEditorComponent;
}, {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
      Preparing live diff viewer…
    </div>
  )
}) as MonacoDiffEditorComponent;

export type LiveFileUpdate = {
  id: string;
  path: string;
  contents: string;
  previous: string | null | undefined;
  timestamp: number;
};

type Props = {
  updates: LiveFileUpdate[];
  className?: string;
};

type TreeNode =
  | {
      type: "file";
      name: string;
      path: string;
      additions: number;
      deletions: number;
    }
  | {
      type: "dir";
      name: string;
      path: string;
      children: TreeNode[];
      additions: number;
      deletions: number;
    };

export function LiveFileDiffViewer({ updates, className }: Props) {
  const updatesByPath = useMemo(() => {
    const map = new Map<string, LiveFileUpdate[]>();
    for (const update of updates) {
      const list = map.get(update.path);
      if (list) {
        list.push(update);
      } else {
        map.set(update.path, [update]);
      }
    }
    for (const [, list] of map) {
      list.sort((a, b) => a.timestamp - b.timestamp);
    }
    return map;
  }, [updates]);

  const latestUpdates = useMemo(() => {
    const map = new Map<string, LiveFileUpdate>();
    for (const [path, list] of updatesByPath.entries()) {
      if (list.length > 0) {
        map.set(path, list[list.length - 1]);
      }
    }
    return map;
  }, [updatesByPath]);

  const orderedFiles = useMemo(() => {
    return [...latestUpdates.values()]
      .map((update) => ({
        path: update.path,
        latestTimestamp: update.timestamp
      }))
      .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }, [latestUpdates]);

  const tree = useMemo<TreeNode[]>(() => {
    const root: TreeNode = {
      type: "dir",
      name: "",
      path: "",
      children: [],
      additions: 0,
      deletions: 0
    };

    const getOrCreateDir = (parent: Extract<TreeNode, { type: "dir" }>, name: string, path: string) => {
      let child = parent.children.find((node) => node.type === "dir" && node.name === name) as
        | Extract<TreeNode, { type: "dir" }>
        | undefined;
      if (!child) {
        child = {
          type: "dir",
          name,
          path,
          children: [],
          additions: 0,
          deletions: 0
        };
        parent.children.push(child);
        parent.children.sort(nodeComparator);
      }
      return child;
    };

    const upsertFile = (
      parent: Extract<TreeNode, { type: "dir" }>,
      name: string,
      path: string,
      additions: number,
      deletions: number
    ) => {
      const existingIndex = parent.children.findIndex(
        (node) => node.type === "file" && node.name === name
      );
      const fileNode: TreeNode = {
        type: "file",
        name,
        path,
        additions,
        deletions
      };
      if (existingIndex !== -1) {
        parent.children.splice(existingIndex, 1, fileNode);
      } else {
        parent.children.push(fileNode);
      }
      parent.children.sort(nodeComparator);
    };

    for (const update of latestUpdates.values()) {
      const stats = computeDiffStats(update.previous ?? "", update.contents);
      const segments = update.path.split("/").filter(Boolean);

      let current = root;
      current.additions += stats.additions;
      current.deletions += stats.deletions;

      let accumulatedPath = "";
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const nextPath = accumulatedPath ? `${accumulatedPath}/${segment}` : segment;
        const isFile = index === segments.length - 1;

        if (isFile) {
          upsertFile(current, segment, update.path, stats.additions, stats.deletions);
        } else {
          current = getOrCreateDir(current, segment, nextPath);
          current.additions += stats.additions;
          current.deletions += stats.deletions;
        }

        accumulatedPath = nextPath;
      }
    }

    return root.children;
  }, [latestUpdates]);

  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const [followLatest, setFollowLatest] = useState(true);
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [showMobileTree, setShowMobileTree] = useState(false);

  useEffect(() => {
    if (!updates.length) {
      setActivePath(undefined);
      return;
    }
    if (!followLatest && activePath && updatesByPath.has(activePath)) {
      return;
    }
    const latest = orderedFiles[0];
    if (latest) {
      setActivePath(latest.path);
    }
  }, [updates, updatesByPath, orderedFiles, followLatest, activePath]);

  useEffect(() => {
    if (!activePath) return;
    const segments = activePath.split("/").filter(Boolean);
    const directories = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
    setOpenDirs((prev) => {
      const next = new Set(prev);
      for (const dir of directories) {
        next.add(dir);
      }
      return next;
    });
  }, [activePath]);

  const activeUpdate = useMemo(() => {
    if (!activePath) return undefined;
    const list = updatesByPath.get(activePath);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }, [activePath, updatesByPath]);

  const formattedTimestamp = activeUpdate
    ? new Date(activeUpdate.timestamp).toLocaleTimeString()
    : undefined;

  return (
    <div
      className={clsx(
        "flex flex-1 min-h-[18rem] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950/95",
        className
      )}
    >
      <div className="flex flex-col gap-3 border-b border-neutral-800 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-neutral-500">Live workspace</p>
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <span className="truncate">
              {activePath ?? (tree.length ? "Choose a file" : "Waiting for edits…")}
            </span>
            {activeUpdate?.previous === null ? (
              <span className="whitespace-nowrap rounded-full border border-emerald-600/60 bg-emerald-500/10 px-2 py-[1px] text-[10px] uppercase tracking-widest text-emerald-200">
                New file
              </span>
            ) : null}
          </div>
          {formattedTimestamp ? (
            <p className="text-xs text-neutral-500">
              Last update {formattedTimestamp}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          <button
            type="button"
            onClick={() => setShowMobileTree(true)}
            className="rounded-full border border-neutral-700 px-3 py-1 text-neutral-300 transition hover:border-neutral-500 hover:text-white lg:hidden"
          >
            Files
          </button>
          <button
            type="button"
            onClick={() => setFollowLatest(true)}
            className={clsx(
              "rounded-full border px-3 py-1 transition",
              followLatest
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                : "border-neutral-700 bg-neutral-900/80 hover:border-neutral-500 hover:text-white"
            )}
          >
            Follow latest
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <aside className="hidden w-60 overflow-hidden border-r border-neutral-800 bg-neutral-950/90 p-3 text-sm text-neutral-200 lg:block">
          <div className="scrollbar h-full overflow-y-auto pr-2">
            <FileTree
              nodes={tree}
              activePath={activePath}
              openDirs={openDirs}
              onToggleDir={(path) =>
              setOpenDirs((prev) => {
                const next = new Set(prev);
                if (next.has(path)) {
                  next.delete(path);
                } else {
                  next.add(path);
                }
                return next;
              })
            }
            onSelectFile={(path) => {
              setActivePath(path);
              setFollowLatest(false);
            }}
          />
          </div>
        </aside>
        <div className="flex-1 min-h-0">
          {activeUpdate ? (
            <MonacoDiffEditor
              theme="vs-dark"
              language={inferMonacoLanguage(activeUpdate.path)}
              original={activeUpdate.previous ?? ""}
              modified={activeUpdate.contents}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderIndicators: true,
                diffWordWrap: "on",
                wordWrap: "on",
                originalEditable: false,
                fontSize: 13
              }}
              height="100%"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">
              Waiting for live code updates…
            </div>
          )}
        </div>
      </div>
      {showMobileTree ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center px-4 py-10 lg:hidden">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowMobileTree(false)}
          />
          <div className="relative h-[70vh] w-full max-w-sm overflow-hidden rounded-3xl border border-neutral-800 bg-neutral-950/95">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3 text-sm text-neutral-200">
              <span>Modified files</span>
              <button
                type="button"
                onClick={() => setShowMobileTree(false)}
                className="rounded-full border border-neutral-800 px-2 py-1 text-xs text-neutral-400 transition hover:border-neutral-600 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="scrollbar h-full overflow-y-auto p-3 text-sm text-neutral-200">
              <FileTree
                nodes={tree}
                activePath={activePath}
                openDirs={openDirs}
                onToggleDir={(path) =>
                  setOpenDirs((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) {
                      next.delete(path);
                    } else {
                      next.add(path);
                    }
                    return next;
                  })
                }
                onSelectFile={(path) => {
                  setActivePath(path);
                  setFollowLatest(false);
                  setShowMobileTree(false);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function nodeComparator(a: TreeNode, b: TreeNode) {
  if (a.type === "dir" && b.type === "file") return -1;
  if (a.type === "file" && b.type === "dir") return 1;
  return a.name.localeCompare(b.name);
}

function computeDiffStats(previous: string, next: string) {
  let additions = 0;
  let deletions = 0;
  const diff = diffLines(previous, next);
  for (const part of diff) {
    if (part.added) {
      additions += part.count ?? 0;
    } else if (part.removed) {
      deletions += part.count ?? 0;
    }
  }
  return { additions, deletions };
}

interface FileTreeProps {
  nodes: TreeNode[];
  activePath?: string;
  openDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function FileTree({ nodes, activePath, openDirs, onToggleDir, onSelectFile }: FileTreeProps) {
  if (!nodes.length) {
    return <p className="px-2 text-xs text-neutral-500">No modified files yet.</p>;
  }

  return (
    <ul className="space-y-1">
      {nodes.map((node) =>
        node.type === "dir" ? (
          <DirectoryItem
            key={node.path}
            node={node}
            activePath={activePath}
            openDirs={openDirs}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        ) : (
          <FileItem
            key={node.path}
            node={node}
            activePath={activePath}
            onSelectFile={onSelectFile}
          />
        )
      )}
    </ul>
  );
}

function DirectoryItem({
  node,
  activePath,
  openDirs,
  onToggleDir,
  onSelectFile
}: {
  node: Extract<TreeNode, { type: "dir" }>;
  activePath?: string;
  openDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isOpen =
    openDirs.has(node.path) ||
    node.children.some((child) => child.type === "file" ? child.path === activePath : activePath?.startsWith(child.path));

  return (
    <li>
      <button
        type="button"
        onClick={() => onToggleDir(node.path)}
        className={clsx(
          "flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs uppercase tracking-[0.2em]",
          "text-neutral-400 hover:text-white"
        )}
      >
        <span className="flex items-center gap-2">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded border border-neutral-700">
            {isOpen ? "▾" : "▸"}
          </span>
          {node.name || "root"}
        </span>
        <DiffBadge additions={node.additions} deletions={node.deletions} />
      </button>
      {isOpen ? (
        <div className="ml-4 border-l border-neutral-800 pl-2">
          <FileTree
            nodes={node.children}
            activePath={activePath}
            openDirs={openDirs}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        </div>
      ) : null}
    </li>
  );
}

function FileItem({
  node,
  activePath,
  onSelectFile
}: {
  node: Extract<TreeNode, { type: "file" }>;
  activePath?: string;
  onSelectFile: (path: string) => void;
}) {
  const isActive = node.path === activePath;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        className={clsx(
          "flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs transition",
          isActive
            ? "bg-emerald-500/10 text-emerald-200"
            : "text-neutral-300 hover:bg-neutral-900 hover:text-white"
        )}
      >
        <span className="truncate">{node.name}</span>
        <DiffBadge additions={node.additions} deletions={node.deletions} />
      </button>
    </li>
  );
}

function DiffBadge({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex items-center gap-2 text-[10px]">
      <span className="text-emerald-300">+{additions}</span>
      <span className="text-rose-400">-{deletions}</span>
    </span>
  );
}

function inferMonacoLanguage(path: string | undefined) {
  if (!path) return "plaintext";
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "plaintext";
  const ext = path.slice(lastDot + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "css":
      return "css";
    case "scss":
    case "sass":
      return "scss";
    case "html":
      return "html";
    case "sh":
      return "shell";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "c":
    case "h":
    case "cpp":
    case "hpp":
      return "cpp";
    case "xml":
      return "xml";
    default:
      return "plaintext";
  }
}

function shortenPath(path: string) {
  if (path.length <= 28) {
    return path;
  }
  const segments = path.split("/");
  if (segments.length <= 2) {
    return path.slice(-28);
  }
  const file = segments.pop();
  const folder = segments.pop();
  return `…/${folder}/${file}`;
}
