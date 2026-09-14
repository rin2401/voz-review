// Thread page parser ported from crawler/voz_scraper.py (VozCrawler.parse_thread_page).
// Uses node-html-parser instead of BeautifulSoup; text extraction replicates
// bs4's get_text("\n", strip=True) per-text-node semantics.

import { parse as parseHtml, TextNode } from "node-html-parser";
import { defaultCompanyExtractor } from "./extract.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const VOZ_USER_AGENT = USER_AGENT;

// bs4 get_text() excludes script/style contents entirely.
function isRawTextElement(node) {
  return node instanceof TextNode === false && (node.rawTagName === "script" || node.rawTagName === "style");
}

/** bs4 get_text() without separator: concatenate every text node. */
function concatText(node) {
  const out = [];
  const walk = (current) => {
    if (current instanceof TextNode) {
      out.push(current.text ?? "");
      return;
    }
    if (isRawTextElement(current)) return;
    for (const child of current.childNodes || []) walk(child);
  };
  walk(node);
  return out.join("");
}

/** bs4 get_text("\n", strip=True): join each stripped non-empty text node with "\n". */
function getTextNodeText(node) {
  const out = [];
  const walk = (current) => {
    if (current instanceof TextNode) {
      out.push(current.text ?? "");
      return;
    }
    if (isRawTextElement(current)) return;
    for (const child of current.childNodes || []) walk(child);
  };
  walk(node);
  return out.map((s) => s.trim()).filter(Boolean).join("\n");
}

/** Extract thread ID from URLs like /t/slug.677450/page-514 or /t.677450. */
export function extractThreadId(url) {
  const match = /\/t(?:\/[^/]*?)?\.(\d+)(?=[/#?]|$)/.exec(url);
  return match ? match[1] : "";
}

function parsePostDate(timeElem) {
  if (!timeElem) return null;
  const datetimeStr = timeElem.getAttribute("datetime") || "";
  if (!datetimeStr) return null;
  const parsed = new Date(datetimeStr.replace("Z", "+00:00"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractReplyPostId(post) {
  const quoteLink =
    post.querySelector("a.bbCodeBlock-sourceJump") || post.querySelector(".bbCodeBlock-sourceJump");
  if (!quoteLink) return null;
  const contentSelector = quoteLink.getAttribute("data-content-selector") || "";
  let match = /#post-(\d+)/.exec(contentSelector);
  if (!match) {
    const href = quoteLink.getAttribute("href") || "";
    match = /[?&]id=(\d+)/.exec(href);
  }
  if (!match) {
    const href = quoteLink.getAttribute("href") || "";
    match = /#post-(\d+)/.exec(href);
  }
  return match ? match[1] : null;
}

function extractPostContent(post) {
  const contentElem = post.querySelector(".message-content") || post.querySelector(".bbWrapper");
  if (!contentElem) return "";
  // Clone-free quote removal: drop quote blocks so reply text stays cleaner.
  for (const quoted of contentElem.querySelectorAll(".bbCodeBlock, blockquote")) {
    quoted.remove();
  }
  return getTextNodeText(contentElem);
}

function extractPostId(post) {
  const dataContent = (post.getAttribute("data-content") || "").replace("post-", "");
  if (dataContent) return dataContent;
  const postIdElem = post.querySelector("a[href*='/post-']");
  if (postIdElem) {
    const match = /post-(\d+)/.exec(postIdElem.getAttribute("href") || "");
    if (match) return match[1];
  }
  return null;
}

function extractLikes(post) {
  const likeElem = post.querySelector(".reactions-value");
  if (!likeElem) return 0;
  const parsed = parseInt(concatText(likeElem).trim().replace(/,/g, ""), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Parse review posts from a thread page, mirroring VozCrawler.parse_thread_page. */
export function parseThreadPage(html, forumUrl, options = {}) {
  const baseUrl = options.baseUrl || "https://voz.vn";
  const extractor = options.extractor || defaultCompanyExtractor;
  // Parse noscript/template contents as HTML to match BeautifulSoup's html.parser
  // (node-html-parser treats them as raw text by default, leaking tag markup).
  const root = parseHtml(html, {
    blockTextElements: { script: true, noscript: false, style: true, template: false },
  });
  const posts = [];

  for (const post of root.querySelectorAll("article.message--post")) {
    try {
      let author = post.getAttribute("data-author") || "";
      if (!author) {
        const authorElem = post.querySelector(".username");
        author = authorElem ? concatText(authorElem).trim() : "Anonymous";
      }

      let authorUrl = null;
      const authorUrlElem = post.querySelector(".username") || post.querySelector(".avatar");
      if (authorUrlElem) {
        const href = authorUrlElem.getAttribute("href") || "";
        if (href && !href.startsWith("http")) {
          try {
            authorUrl = new URL(href, baseUrl).href;
          } catch {
            authorUrl = null;
          }
        }
      }

      const postDate = parsePostDate(post.querySelector("time.u-dt"));
      const replyPostId = extractReplyPostId(post);
      const content = extractPostContent(post);
      const postId = extractPostId(post);

      // Skip if no content
      if (!content || content.length < 20) continue;

      const companies = extractor.extractCompanies(content);
      const primaryCompany = companies.length ? companies[0] : "Unknown";
      const monthlySalaryMillion = extractor.extractMonthlySalaryMillion(content);

      const vozUrl = postId
        ? `${forumUrl.replace(/\/+$/, "")}#post-${postId}`
        : forumUrl;

      posts.push({
        voz_thread_id: extractThreadId(forumUrl),
        voz_post_id: postId,
        reply_post_id: replyPostId,
        company: primaryCompany,
        companies,
        content: content.slice(0, 5000),
        author,
        author_url: authorUrl,
        post_date: postDate || new Date(),
        url: vozUrl,
        likes: extractLikes(post),
        awards: 0,
        monthly_salary_million: monthlySalaryMillion,
      });
    } catch (error) {
      console.error("Error parsing post:", error);
      continue;
    }
  }

  return posts;
}
