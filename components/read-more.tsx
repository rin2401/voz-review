"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { createEntityLinker, type EntityMap } from "@/lib/entity-links";
import { cn } from "@/lib/utils";

export function ReadMore({
  content,
  limit = 500,
  entityMap,
}: {
  content: string;
  limit?: number;
  entityMap?: EntityMap;
}) {
  const [expanded, setExpanded] = useState(false);
  // Only show the toggle when the line-clamp actually hides content:
  // content can exceed `limit` chars yet fit inside the clamped lines,
  // which made "Xem thêm" expand to no visible change.
  const [clampedHidden, setClampedHidden] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const isLong = content.length > limit;
  const segments = useMemo(
    () => (entityMap ? createEntityLinker(entityMap).split(content) : null),
    [entityMap, content],
  );

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setClampedHidden(el.scrollHeight > el.clientHeight + 1);
  }, [content, limit]);

  const showToggle = expanded || (isLong && clampedHidden);

  return (
    <div className="space-y-1">
      <div
        ref={contentRef}
        className={cn(
          "text-sm leading-relaxed whitespace-pre-wrap break-words",
          isLong && !expanded && "line-clamp-[10]",
        )}
      >
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
          : content}
      </div>
      {showToggle && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-sm font-medium text-primary hover:underline"
        >
          {expanded ? "▲ Thu gọn" : "▼ Xem thêm"}
        </button>
      )}
    </div>
  );
}
