import { describe, expect, it } from "vitest";

import { buildFullConversation } from "../lib/replies";

type Post = {
  voz_post_id: string;
  reply_post_id?: string;
  post_date?: string;
};

const posts: Post[] = [
  { voz_post_id: "1", post_date: "2026-01-01" },
  { voz_post_id: "2", reply_post_id: "1", post_date: "2026-01-02" },
  { voz_post_id: "3", reply_post_id: "2", post_date: "2026-01-03" },
  { voz_post_id: "4", reply_post_id: "1", post_date: "2026-01-04" },
  { voz_post_id: "5", reply_post_id: "2", post_date: "2026-01-05" },
];

const fetchers = {
  getPostsByIds: async (ids: string[]) =>
    posts.filter((p) => ids.includes(p.voz_post_id)) as any[],
  getRepliesForPosts: async (ids: string[]) =>
    posts.filter((p) => p.reply_post_id && ids.includes(p.reply_post_id)) as any[],
};

describe("buildFullConversation", () => {
  it("walks up to the root ancestor and collects the full reply tree", async () => {
    const { root, childrenByPostId } = await buildFullConversation("3", fetchers);
    expect(root?.voz_post_id).toBe("1");
    expect(childrenByPostId["1"].map((c) => c.voz_post_id)).toEqual(["2", "4"]);
    expect(childrenByPostId["2"].map((c) => c.voz_post_id)).toEqual(["3", "5"]);
  });

  it("keeps the root when the post has no parent", async () => {
    const { root, childrenByPostId } = await buildFullConversation("1", fetchers);
    expect(root?.voz_post_id).toBe("1");
    expect(childrenByPostId["1"].map((c) => c.voz_post_id)).toEqual(["2", "4"]);
  });

  it("returns a null root for an unknown post", async () => {
    const { root, childrenByPostId } = await buildFullConversation("404", fetchers);
    expect(root).toBeNull();
    expect(childrenByPostId).toEqual({});
  });

  it("stops when the parent chain is missing from the store", async () => {
    const orphanFetchers = {
      ...fetchers,
      getPostsByIds: async (ids: string[]) =>
        posts
          .filter((p) => ids.includes(p.voz_post_id) && p.voz_post_id !== "1")
          .map((p) => ({ ...p })) as any[],
    };
    const { root } = await buildFullConversation("3", orphanFetchers);
    // Parent 1 is missing, so 2 becomes the highest reachable ancestor.
    expect(root?.voz_post_id).toBe("2");
  });
});
