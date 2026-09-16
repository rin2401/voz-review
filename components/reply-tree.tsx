"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Dict } from "@/lib/db/queries";
import { createEntityLinker, type EntityMap } from "@/lib/entity-links";
import { asciiSlug, formatDtVn } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Whether the subtree under parentId contains the target post (incl. self). */
function subtreeHasPost(
  childrenByPostId: Record<string, Dict[]>,
  parentId: string,
  targetId?: string,
): boolean {
  if (!targetId) return false;
  const stack = [parentId];
  const visited = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === targetId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const child of childrenByPostId[id] || []) {
      if (child.voz_post_id) stack.push(String(child.voz_post_id));
    }
  }
  return false;
}

// Cap branch indentation so deep threads stay readable on narrow screens;
// beyond this many nested branch indents, subtrees render flat.
const MAX_BRANCH_INDENT = 3;

function ReplyNode({
  node,
  childrenByPostId,
  defaultVisible,
  depth,
  indentLevel = 0,
  entityMap,
  convBasePath,
  highlightPostId,
}: {
  node: Dict;
  childrenByPostId: Record<string, Dict[]>;
  defaultVisible: number;
  depth: number;
  indentLevel?: number;
  entityMap?: EntityMap;
  convBasePath?: string;
  highlightPostId?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const children = childrenByPostId[String(node.voz_post_id)] || [];
  const visibleChildren =
    depth > 1 && children.length > defaultVisible && !showAll ? children.slice(0, defaultVisible) : children;
  const hiddenCount = children.length - defaultVisible;
  const segments = useMemo(
    () => (entityMap ? createEntityLinker(entityMap).split(String(node.content || "")) : null),
    [entityMap, node.content],
  );
  const highlighted = highlightPostId && String(node.voz_post_id) === highlightPostId;
  // Linear chains (single child) stack flat instead of stair-casing on deep
  // threads; only real branches indent under a thread line.
  const branches = children.length > 1;
  const indents = branches && indentLevel < MAX_BRANCH_INDENT;
  const containsHighlight = useMemo(
    () => subtreeHasPost(childrenByPostId, String(node.voz_post_id ?? ""), highlightPostId),
    [childrenByPostId, node.voz_post_id, highlightPostId],
  );
  // Show ~3 reply levels by default; deeper subtrees stay collapsed behind the
  // triangle toggle unless they contain the highlighted post.
  const [expanded, setExpanded] = useState(depth < 3 || containsHighlight);

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "rounded-lg p-2 -mx-2",
          highlighted ? "bg-primary/5 ring-1 ring-primary/40" : "hover:bg-muted/40",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="text-sm font-medium text-orange-500">{node.author}</span>
          {node.post_date ? (
            <span className="text-muted-foreground">{formatDtVn(node.post_date)}</span>
          ) : null}
          <span className="text-muted-foreground">❤️ {node.likes ?? 0}</span>
          {node.url ? (
            <a
              href={node.url}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:underline"
            >
              Voz
            </a>
          ) : null}
          {convBasePath && node.voz_post_id ? (
            <Link
              href={`${convBasePath}/conv/${node.voz_post_id}`}
              title="Xem full conversation"
              className="font-medium text-primary hover:underline"
            >
              🧵
            </Link>
          ) : null}
        </div>
        <div className="mt-1 text-sm leading-relaxed whitespace-pre-wrap break-words">
          {segments
            ? segments.map((segment, index) =>
                segment.href ? (
                  <Link
                    key={index}
                    href={segment.href}
                    title={segment.title}
                    className="font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400"
                  >
                    {segment.text}
                  </Link>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )
            : node.content}
        </div>
      </div>
      {children.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="ml-1 flex items-center gap-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          <span className={cn("inline-block transition-transform", expanded && "rotate-90")}>▶</span>
          {expanded ? `Ẩn ${children.length} reply` : `${children.length} reply`}
        </button>
      )}
      {children.length > 0 && expanded && (
        <div className={cn("space-y-1.5", indents && "ml-2 border-l pl-2 sm:ml-3 sm:pl-3")}>
          {visibleChildren.map((child) => (
            <ReplyNode
              key={String(child.voz_post_id ?? child._id ?? Math.random())}
              node={child}
              childrenByPostId={childrenByPostId}
              defaultVisible={defaultVisible}
              depth={depth + 1}
              indentLevel={indents ? indentLevel + 1 : indentLevel}
              entityMap={entityMap}
              convBasePath={convBasePath}
              highlightPostId={highlightPostId}
            />
          ))}
          {depth > 1 && children.length > defaultVisible && !showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-sm font-medium text-primary hover:underline"
            >
              Xem thêm {hiddenCount} reply
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ReplyTree({
  postId,
  children,
  childrenByPostId,
  defaultVisible = 3,
  defaultOpen = false,
  entityMap,
  convBasePath,
  highlightPostId,
}: {
  postId: string;
  children: Dict[];
  childrenByPostId: Record<string, Dict[]>;
  defaultVisible?: number;
  defaultOpen?: boolean;
  entityMap?: EntityMap;
  convBasePath?: string;
  highlightPostId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <CollapsibleTrigger
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "h-7 gap-1 px-2 text-primary",
          )}
        >
          <span className={cn("transition-transform", open && "rotate-90")}>▶</span>
          {open ? `Ẩn reply (${children.length})` : `Xem reply (${children.length})`}
        </CollapsibleTrigger>
        {convBasePath && postId ? (
          <Link
            href={`${convBasePath}/conv/${postId}`}
            title="Xem full conversation"
            className="text-xs font-medium text-primary hover:underline"
          >
            🧵 Full conversation
          </Link>
        ) : null}
      </div>
      <CollapsibleContent className="mt-2">
        <div className="ml-2 space-y-1.5 border-l pl-2 sm:ml-3 sm:pl-3">
          {children.map((child) => (
            <ReplyNode
              key={String(child.voz_post_id ?? Math.random())}
              node={child}
              childrenByPostId={childrenByPostId}
              defaultVisible={defaultVisible}
              depth={1}
              indentLevel={1}
              entityMap={entityMap}
              convBasePath={convBasePath}
              highlightPostId={highlightPostId}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CompanyChips({ companies }: { companies: string[] }) {
  if (!companies.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {companies.map((name) => (
        <Link
          key={name}
          href={`/company/${asciiSlug(name)}`}
          className="rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-orange-500 hover:bg-accent"
        >
          {name}
        </Link>
      ))}
    </div>
  );
}
