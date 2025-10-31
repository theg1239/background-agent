"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { clsx } from "clsx";

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
};

export function LiveFileDiffViewer({ updates }: Props) {
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

  const orderedFiles = useMemo(() => {
    return [...updatesByPath.entries()]
      .map(([path, list]) => ({
        path,
        latestTimestamp: list[list.length - 1]?.timestamp ?? 0,
        updateCount: list.length
      }))
      .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }, [updatesByPath]);

  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const [followLatest, setFollowLatest] = useState(true);

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
    <div className="mb-4 overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950/80">
      <div className="flex flex-col gap-3 border-b border-neutral-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.2em] text-neutral-500">Live workspace</p>
          <p className="flex items-center gap-2 truncate text-sm font-medium text-white">
            <span className="truncate">{activePath ?? "Waiting for file edits…"}</span>
            {activeUpdate?.previous === null ? (
              <span className="whitespace-nowrap rounded-full border border-emerald-600/60 bg-emerald-500/10 px-2 py-[1px] text-[10px] uppercase tracking-widest text-emerald-200">
                New file
              </span>
            ) : null}
          </p>
          {formattedTimestamp ? (
            <p className="text-xs text-neutral-500">
              Last update {formattedTimestamp}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {orderedFiles.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => {
                setActivePath(file.path);
                setFollowLatest(false);
              }}
              className={clsx(
                "rounded-full border px-3 py-1 text-xs transition",
                activePath === file.path
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                  : "border-neutral-700 bg-neutral-900/80 text-neutral-300 hover:border-neutral-500 hover:text-white"
              )}
            >
              <span className="truncate">{shortenPath(file.path)}</span>
              <span className="ml-2 rounded-full bg-neutral-800 px-2 py-[1px] text-[10px] text-neutral-400">
                {file.updateCount}
              </span>
            </button>
          ))}
          {orderedFiles.length > 0 ? (
            <button
              type="button"
              onClick={() => setFollowLatest(true)}
              className={clsx(
                "rounded-full border px-3 py-1 text-xs transition",
                followLatest
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-neutral-700 bg-neutral-900/80 text-neutral-300 hover:border-neutral-500 hover:text-white"
              )}
            >
              Follow latest
            </button>
          ) : null}
        </div>
      </div>

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
            originalEditable: false
          }}
          height="360px"
        />
      ) : (
        <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
          Waiting for live code updates…
        </div>
      )}
    </div>
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
