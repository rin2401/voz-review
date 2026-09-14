import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { extractThreadId, parseThreadPage } from "../parser.js";

const fixturePath = new URL("./fixtures/voz_thread_page.html", import.meta.url);
const fixtureHtml = readFileSync(fixturePath, "utf8");

const FORUM_URL =
  "https://voz.vn/t/nhan-xet-ve-moi-cong-ty-noi-tieng-trong-nganh-it-cntt.677450/";

describe("extractThreadId", () => {
  it("extracts thread id from slug urls", () => {
    expect(extractThreadId("https://voz.vn/t/some-thread.677450/")).toBe("677450");
  });

  it("extracts thread id from page urls", () => {
    expect(extractThreadId("https://voz.vn/t/some-thread.677450/page-514/")).toBe("677450");
  });

  it("extracts thread id from short urls", () => {
    expect(extractThreadId("https://voz.vn/t.677450/")).toBe("677450");
  });

  it("extracts thread id from post anchors", () => {
    expect(extractThreadId("https://voz.vn/t/some-thread.677450#post-123456")).toBe("677450");
  });

  it("returns empty for non-thread urls", () => {
    expect(extractThreadId("https://voz.vn/f/xyz.123/")).toBe("");
  });
});

describe("parseThreadPage", () => {
  const posts = parseThreadPage(fixtureHtml, FORUM_URL);

  it("parses posts from the real fixture", () => {
    expect(posts.length).toBeGreaterThan(0);
  });

  it("fills required fields for every post", () => {
    for (const post of posts) {
      expect(post.voz_thread_id).toBe("677450");
      expect(post.content.length).toBeGreaterThanOrEqual(20);
      expect(post.content.length).toBeLessThanOrEqual(5000);
      expect(post.author).toBeTruthy();
      expect(post.url).toContain("voz.vn");
      expect(post.post_date).toBeInstanceOf(Date);
      expect(post.likes).toBeGreaterThanOrEqual(0);
      expect(post.awards).toBe(0);
      expect(Array.isArray(post.companies)).toBe(true);
    }
  });

  it("extracts post ids and links", () => {
    const withPostId = posts.filter((post) => post.voz_post_id);
    expect(withPostId.length).toBeGreaterThan(0);
    for (const post of withPostId) {
      expect(post.url).toBe(`${FORUM_URL.replace(/\/+$/, "")}#post-${post.voz_post_id}`);
    }
  });

  it("strips quote blocks from content", () => {
    for (const post of posts) {
      expect(post.content).not.toContain("said:");
    }
  });
});
