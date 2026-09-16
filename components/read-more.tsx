"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { createEntityLinker } from "@/lib/entity-links";
import { cn } from "@/lib/utils";

export function ReadMore({
  content,
  limit = 500,
  entityMap,
}: {
  content: string;
  limit?: number;
  entityMap?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > limit;
  const segments = useMemo(
    () => (entityMap ? createEntityLinker(entityMap).split(content) : null),
    [entityMap, content],
  );

  return (
    <div className="space-y-1">
      <div
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
                  className="font-medium text-primary hover:underline"
                >
                  {segment.text}
                </Link>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )
          : content}
      </div>
      {isLong && (
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
