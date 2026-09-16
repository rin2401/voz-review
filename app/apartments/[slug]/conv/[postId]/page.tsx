import Link from "next/link";
import { notFound } from "next/navigation";

import { ReviewCard } from "@/components/review-card";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  getApartmentPostsByIds,
  getApartmentRepliesForPosts,
  resolveApartmentName,
} from "@/lib/db/apartment-queries";
import { getEntityMap } from "@/lib/db/entity-map";
import { buildFullConversation } from "@/lib/replies";
import { asciiSlug, decodeSlug } from "@/lib/format";
import { cn } from "@/lib/utils";

export const revalidate = 300;

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ slug: string; postId: string }>;
}) {
  const { slug: rawSlug, postId } = await params;
  const slug = decodeSlug(rawSlug);

  const apartmentName = await resolveApartmentName(slug);
  const apartmentSlug = asciiSlug(apartmentName);

  const { root, childrenByPostId } = await buildFullConversation(postId, {
    getPostsByIds: getApartmentPostsByIds,
    getRepliesForPosts: getApartmentRepliesForPosts,
  });
  if (!root || !root.voz_post_id) notFound();

  const entityMap = await getEntityMap();
  const replyCount = Object.values(childrenByPostId).reduce(
    (total, children) => total + children.length,
    0,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">🧵 Conversation</h1>
          <span className="text-sm text-muted-foreground">{replyCount} replies</span>
        </div>
        <Link
          href={`/apartments/${apartmentSlug}`}
          className={cn(buttonVariants({ variant: "secondary" }))}
        >
          ← {apartmentName}
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Toàn bộ chuỗi reply từ bài gốc — highlight là bài bạn đang đọc context.
      </p>
      <ReviewCard
        review={root}
        replyChildrenByPostId={childrenByPostId}
        defaultVisibleReplies={1000}
        defaultOpenReplies
        highlightPostId={postId}
        entityMap={entityMap}
      />
      {replyCount === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">
            Bài này chưa có reply nào.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
