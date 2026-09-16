"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Dict } from "@/lib/db/queries";
import { createEntityLinker, type EntityMap } from "@/lib/entity-links";
import { asciiSlug, formatDtVn } from "@/lib/format";
import { cn } from "@/lib/utils";

function ReplyNode({
  node,
  childrenByPostId,
  defaultVisible,
  depth,
  entityMap,
  convBasePath,
  highlightPostId,
}: {
  node: Dict;
  childrenByPostId: Record<string, Dict[]>;
  defaultVisible: number;
  depth: number;
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

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "rounded-lg border bg-muted/40 p-3",
          highlighted && "ring-2 ring-primary/60 border-primary/40",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-medium text-orange-500">{node.author}</span>
          <span className="text-muted-foreground">
            {node.post_date ? formatDtVn(node.post_date) : ""} | ❤️ {node.likes ?? 0} |{" "}
            {node.url ? (
              <a href={node.url} target="_blank" rel="noreferrer" className="hover:underline">
                View on Voz
              </a>
            ) : null}
            {convBasePath && node.voz_post_id ? (
              <>
                {" | "}
                <Link
                  href={`${convBasePath}/conv/${node.voz_post_id}`}
                  title="Xem full conversation"
                  className="font-medium text-primary hover:underline"
                >
                  🧵 Conv
                </Link>
              </>
            ) : null}
          </span>
        </div>
        <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
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
        <div className="ml-4 space-y-2 border-l pl-3">
          {visibleChildren.map((child) => (
            <ReplyNode
              key={String(child.voz_post_id ?? child._id ?? Math.random())}
              node={child}
              childrenByPostId={childrenByPostId}
              defaultVisible={defaultVisible}
              depth={depth + 1}
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
        <div className="space-y-2">
          {children.map((child) => (
            <ReplyNode
              key={String(child.voz_post_id ?? Math.random())}
              node={child}
              childrenByPostId={childrenByPostId}
              defaultVisible={defaultVisible}
              depth={1}
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
