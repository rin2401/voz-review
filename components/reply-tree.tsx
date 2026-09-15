"use client";

import { useState } from "react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Dict } from "@/lib/db/queries";
import { asciiSlug, formatDtVn } from "@/lib/format";
import { cn } from "@/lib/utils";

function ReplyNode({
  node,
  childrenByPostId,
  defaultVisible,
  depth,
}: {
  node: Dict;
  childrenByPostId: Record<string, Dict[]>;
  defaultVisible: number;
  depth: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const children = childrenByPostId[String(node.voz_post_id)] || [];
  const visibleChildren =
    depth > 1 && children.length > defaultVisible && !showAll ? children.slice(0, defaultVisible) : children;
  const hiddenCount = children.length - defaultVisible;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border bg-muted/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-medium text-orange-500">{node.author}</span>
          <span className="text-muted-foreground">
            {node.post_date ? formatDtVn(node.post_date) : ""} | ❤️ {node.likes ?? 0} |{" "}
            {node.url ? (
              <a href={node.url} target="_blank" rel="noreferrer" className="hover:underline">
                View on Voz
              </a>
            ) : null}
          </span>
        </div>
        <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap break-words">{node.content}</div>
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
}: {
  postId: string;
  children: Dict[];
  childrenByPostId: Record<string, Dict[]>;
  defaultVisible?: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
      <CollapsibleTrigger
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "h-7 gap-1 px-2 text-primary",
        )}
      >
        <span className={cn("transition-transform", open && "rotate-90")}>▶</span>
        {open ? `Ẩn reply (${children.length})` : `Xem reply (${children.length})`}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div className="space-y-2">
          {children.map((child) => (
            <ReplyNode
              key={String(child.voz_post_id ?? Math.random())}
              node={child}
              childrenByPostId={childrenByPostId}
              defaultVisible={defaultVisible}
              depth={1}
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
