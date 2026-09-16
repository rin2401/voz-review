import Link from "next/link";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ReadMore } from "@/components/read-more";
import { CompanyChips, ReplyTree } from "@/components/reply-tree";
import type { Dict } from "@/lib/db/queries";
import type { EntityMap } from "@/lib/entity-links";
import { formatDtVn } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ReviewCard({
  review,
  replyChildrenByPostId,
  defaultVisibleReplies = 3,
  defaultOpenReplies = false,
  entityMap,
  convBasePath,
  highlightPostId,
}: {
  review: Dict;
  replyChildrenByPostId: Record<string, Dict[]>;
  defaultVisibleReplies?: number;
  defaultOpenReplies?: boolean;
  entityMap?: EntityMap;
  convBasePath?: string;
  highlightPostId?: string;
}) {
  const companies: string[] = review.companies || [];
  const parentReview = review.parent_review;
  const childReplies = replyChildrenByPostId[String(review.voz_post_id)] || [];
  const highlighted = highlightPostId && String(review.voz_post_id) === highlightPostId;

  return (
    <Card className={cn(highlighted && "ring-2 ring-primary/60 border-primary/40")}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-orange-500">{review.author}</span>
          {review.author_url && (
            <a href={review.author_url} target="_blank" rel="noreferrer" className="text-sm">
              🔗
            </a>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          {review.post_date ? formatDtVn(review.post_date) : ""} | ❤️ {review.likes ?? 0} |{" "}
          {review.url ? (
            <a href={review.url} target="_blank" rel="noreferrer" className="hover:underline">
              View on Voz
            </a>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {companies.length > 1 && <CompanyChips companies={companies} />}
        {parentReview ? (
          <div className="rounded-md border border-dashed bg-muted/40 p-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                ↳ Reply to {parentReview.author}
              </div>
              {convBasePath && parentReview.voz_post_id ? (
                <Link
                  href={`${convBasePath}/conv/${parentReview.voz_post_id}`}
                  title="Xem full conversation"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  🧵 Xem full conversation
                </Link>
              ) : null}
            </div>
            <div className="mt-1 text-muted-foreground">
              <ReadMore content={String(parentReview.content || "")} entityMap={entityMap} />
            </div>
          </div>
        ) : review.reply_post_id ? (
          <div className="rounded-md border border-dashed bg-muted/40 p-2 text-xs text-muted-foreground">
            ↳ Reply to post #{review.reply_post_id}
          </div>
        ) : null}
        <ReadMore content={String(review.content || "")} entityMap={entityMap} />
        {childReplies.length > 0 && (
          <ReplyTree
            postId={String(review.voz_post_id)}
            children={childReplies}
            childrenByPostId={replyChildrenByPostId}
            defaultVisible={defaultVisibleReplies}
            defaultOpen={defaultOpenReplies}
            entityMap={entityMap}
            convBasePath={convBasePath}
            highlightPostId={highlightPostId}
          />
        )}
      </CardContent>
    </Card>
  );
}
