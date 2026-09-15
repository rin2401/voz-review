"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

export function ReadMore({ content, limit = 500 }: { content: string; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > limit;

  return (
    <div className="space-y-1">
      <div
        className={cn(
          "text-sm leading-relaxed whitespace-pre-wrap break-words",
          isLong && !expanded && "line-clamp-[10]",
        )}
      >
        {content}
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
