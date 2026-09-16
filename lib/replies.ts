// Reply-tree context building, ported from main.py company_detail/search_page.
// Reviews are flat documents; the UI renders them as a tree via voz_post_id
// (parent) and reply_post_id (child pointer), fetching 4 levels deep.

import type { Dict } from "./db/queries";
import { getPostsByIds, getRepliesForPosts } from "./db/queries";

function replySortKey(item: Dict): number {
  const value = item.post_date || item.created_at;
  const date = value instanceof Date ? value : new Date(String(value));
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

export async function buildReplyContext(
  reviews: Dict[],
  fetchers: {
    getPostsByIds?: typeof getPostsByIds;
    getRepliesForPosts?: typeof getRepliesForPosts;
  } = {},
): Promise<{
  reviewByPostId: Record<string, Dict>;
  replyChildrenByPostId: Record<string, Dict[]>;
  topLevelReviews: Dict[];
}> {
  const fetchPostsByIds = fetchers.getPostsByIds ?? getPostsByIds;
  const fetchRepliesForPosts = fetchers.getRepliesForPosts ?? getRepliesForPosts;

  // A reply whose parent is also in the input list renders nested under the
  // parent's reply tree; exclude it from the flat list to avoid duplicates.
  const inputPostIds = new Set(
    reviews.filter((review) => review.voz_post_id).map((review) => String(review.voz_post_id)),
  );
  const topLevelReviews = reviews.filter(
    (review) => !(review.reply_post_id && inputPostIds.has(String(review.reply_post_id))),
  );

  const reviewByPostId: Record<string, Dict> = {};
  for (const review of reviews) {
    if (review.voz_post_id) reviewByPostId[String(review.voz_post_id)] = review;
  }

  const missingParentIds = [
    ...new Set(
      reviews
        .filter((review) => review.reply_post_id && !reviewByPostId[String(review.reply_post_id)])
        .map((review) => String(review.reply_post_id)),
    ),
  ].sort();
  for (const parentReview of await fetchPostsByIds(missingParentIds)) {
    if (parentReview.voz_post_id) {
      reviewByPostId[String(parentReview.voz_post_id)] = parentReview;
    }
  }

  for (const review of reviews) {
    if (review.reply_post_id) {
      review.parent_review = reviewByPostId[String(review.reply_post_id)];
    }
  }

  const replyChildrenByPostId: Record<string, Dict[]> = {};
  const allReplyIdsToFetch = new Set(
    reviews.filter((review) => review.voz_post_id).map((review) => String(review.voz_post_id)),
  );
  const fetchedPostIds = new Set<string>();

  for (let level = 0; level < 4; level++) {
    const pendingParentIds = [...allReplyIdsToFetch].filter((id) => !fetchedPostIds.has(id));
    if (!pendingParentIds.length) break;

    const replyChildren = await fetchRepliesForPosts(pendingParentIds);
    for (const id of pendingParentIds) fetchedPostIds.add(id);

    for (const child of replyChildren) {
      const parentId = child.reply_post_id;
      if (!parentId) continue;
      const parentKey = String(parentId);
      if (!replyChildrenByPostId[parentKey]) replyChildrenByPostId[parentKey] = [];
      replyChildrenByPostId[parentKey].push(child);
      if (child.voz_post_id) allReplyIdsToFetch.add(String(child.voz_post_id));
    }
  }

  for (const children of Object.values(replyChildrenByPostId)) {
    children.sort((a, b) => replySortKey(a) - replySortKey(b));
  }

  return { reviewByPostId, replyChildrenByPostId, topLevelReviews };
}

const MAX_ANCESTOR_HOPS = 10;
const MAX_CONVERSATION_DEPTH = 10;

/**
 * Full conversation for a post: walk up the reply chain to the root ancestor,
 * then collect the entire reply tree below it (vs buildReplyContext, which
 * only fetches context around the current page's reviews).
 */
export async function buildFullConversation(
  postId: string,
  fetchers: {
    getPostsByIds?: typeof getPostsByIds;
    getRepliesForPosts?: typeof getRepliesForPosts;
  } = {},
): Promise<{
  root: Dict | null;
  childrenByPostId: Record<string, Dict[]>;
}> {
  const fetchPostsByIds = fetchers.getPostsByIds ?? getPostsByIds;
  const fetchRepliesForPosts = fetchers.getRepliesForPosts ?? getRepliesForPosts;

  let root = (await fetchPostsByIds([postId]))[0] ?? null;
  if (!root) return { root: null, childrenByPostId: {} };

  const visited = new Set([String(root.voz_post_id ?? postId)]);
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && root.reply_post_id; hop++) {
    const parentId = String(root.reply_post_id);
    if (visited.has(parentId)) break;
    visited.add(parentId);
    const parent = (await fetchPostsByIds([parentId]))[0];
    if (!parent) break;
    root = parent;
  }

  const childrenByPostId: Record<string, Dict[]> = {};
  let frontier = [String(root.voz_post_id ?? postId)];
  for (let level = 0; level < MAX_CONVERSATION_DEPTH && frontier.length; level++) {
    const replies = await fetchRepliesForPosts(frontier);
    const next: string[] = [];
    for (const child of replies) {
      const parentId = child.reply_post_id ? String(child.reply_post_id) : "";
      if (!parentId) continue;
      if (!childrenByPostId[parentId]) childrenByPostId[parentId] = [];
      if (childrenByPostId[parentId].some((c) => String(c.voz_post_id) === String(child.voz_post_id))) {
        continue;
      }
      childrenByPostId[parentId].push(child);
      if (child.voz_post_id) next.push(String(child.voz_post_id));
    }
    frontier = next;
  }

  for (const children of Object.values(childrenByPostId)) {
    children.sort((a, b) => replySortKey(a) - replySortKey(b));
  }
  return { root, childrenByPostId };
}
