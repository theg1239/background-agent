import { clsx } from "clsx";
import type { ReactNode } from "react";

type MarkdownNode =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; language?: string; text: string }
  | { type: "blockquote"; text: string };

const tokenRegex =
  /(\*\*(.+?)\*\*)|(_(.+?)_)|(`([^`]+?)`)|(\[([^\]]+)\]\(([^)]+)\))/g;

type MarkdownContentProps = {
  content?: string | null;
  className?: string;
};

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  if (!content) {
    return null;
  }

  const nodes = parseMarkdown(content);

  return (
    <div className={clsx("space-y-2 text-sm leading-relaxed", className)}>
      {nodes.map((node, index) => (
        <MarkdownBlock key={`${node.type}-${index}`} node={node} />
      ))}
    </div>
  );
}

function MarkdownBlock({ node }: { node: MarkdownNode }) {
  switch (node.type) {
    case "heading": {
      const Tag = node.level === 1 ? "h2" : node.level === 2 ? "h3" : "h4";
      return (
        <Tag className="font-semibold text-neutral-100">
          {renderInline(node.text, `heading-${node.level}`)}
        </Tag>
      );
    }
    case "list":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {node.items.map((item, index) => (
            <li key={`list-${index}`}>{renderInline(item, `list-${index}`)}</li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="scrollbar overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-950/90 p-3 text-xs text-neutral-200">
          <code>{node.text}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote className="border-l-2 border-emerald-500/40 pl-4 text-neutral-100">
          {renderInline(node.text, "blockquote")}
        </blockquote>
      );
    case "paragraph":
    default:
      return (
        <p>
          {renderInline(node.text, `paragraph-${hashString(node.text)}`)}
        </p>
      );
  }
}

function parseMarkdown(markdown: string): MarkdownNode[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const nodes: MarkdownNode[] = [];

  let paragraph: string[] = [];
  let list: string[] | null = null;
  let blockquote: string[] | null = null;
  let codeBlock: { language?: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      nodes.push({ type: "paragraph", text: paragraph.join("\n").trim() });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list && list.length) {
      nodes.push({ type: "list", items: [...list] });
    }
    list = null;
  };
  const flushBlockquote = () => {
    if (blockquote && blockquote.length) {
      nodes.push({ type: "blockquote", text: blockquote.join("\n").trim() });
    }
    blockquote = null;
  };
  const flushCodeBlock = () => {
    if (codeBlock) {
      nodes.push({
        type: "code",
        language: codeBlock.language,
        text: codeBlock.lines.join("\n")
      });
    }
    codeBlock = null;
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (codeBlock) {
      if (trimmed.startsWith("```")) {
        flushCodeBlock();
      } else {
        codeBlock.lines.push(line);
      }
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const language = trimmed.slice(3).trim() || undefined;
      codeBlock = { language, lines: [] };
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      flushList();
      flushBlockquote();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const [, hashes, text] = headingMatch;
      flushParagraph();
      flushList();
      flushBlockquote();
      nodes.push({ type: "heading", level: hashes.length, text: text.trim() });
      continue;
    }

    const blockquoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      flushParagraph();
      flushList();
      if (!blockquote) {
        blockquote = [];
      }
      blockquote.push(blockquoteMatch[1]);
      continue;
    }

    const listMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      flushBlockquote();
      if (!list) {
        list = [];
      }
      list.push(listMatch[1]);
      continue;
    }

    flushList();
    flushBlockquote();
    paragraph.push(trimmed);
  }

  flushCodeBlock();
  flushParagraph();
  flushList();
  flushBlockquote();

  return nodes;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  tokenRegex.lastIndex = 0;
  const elements: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      pushText(elements, text.slice(lastIndex, match.index), `${keyPrefix}-${tokenIndex}-text`);
    }

    const boldText = match[2];
    const italicText = match[4];
    const codeText = match[6];
    const linkText = match[8];
    const linkUrl = match[9];

    if (boldText !== undefined) {
      elements.push(
        <strong key={`${keyPrefix}-bold-${tokenIndex}`}>
          {renderInline(boldText, `${keyPrefix}-bold-${tokenIndex}`)}
        </strong>
      );
    } else if (italicText !== undefined) {
      elements.push(
        <em key={`${keyPrefix}-italic-${tokenIndex}`}>
          {renderInline(italicText, `${keyPrefix}-italic-${tokenIndex}`)}
        </em>
      );
    } else if (codeText !== undefined) {
      elements.push(
        <code
          key={`${keyPrefix}-code-${tokenIndex}`}
          className="rounded bg-neutral-900 px-1 py-0.5 text-xs text-emerald-200"
        >
          {codeText}
        </code>
      );
    } else if (linkText !== undefined && linkUrl !== undefined) {
      const href = linkUrl.trim();
      const label = linkText ?? href;
      elements.push(
        <a
          key={`${keyPrefix}-link-${tokenIndex}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-4 text-emerald-300 hover:text-emerald-200"
        >
          {label}
        </a>
      );
    }

    lastIndex = tokenRegex.lastIndex;
    tokenIndex += 1;
  }

  if (lastIndex < text.length) {
    pushText(elements, text.slice(lastIndex), `${keyPrefix}-${tokenIndex}-tail`);
  }

  return elements.length ? elements : [text];
}

function pushText(target: ReactNode[], value: string, keyPrefix: string) {
  if (!value) return;
  const parts = value.split(/\n/);
  parts.forEach((part, index) => {
    if (part) {
      target.push(part);
    }
    if (index < parts.length - 1) {
      target.push(<br key={`${keyPrefix}-br-${index}`} />);
    }
  });
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
