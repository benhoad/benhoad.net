// Generates /public/feed.xml from the post sources. hey has no feed step;
// its compiler hardcodes what it emits; so this runs after `hey build`
// (wired into `npm run build`); `npm start` (hey run) serves without one.
//
// Feeds are read by feed readers and by the aggregator pipelines that AI
// search systems poll, so this is discovery plumbing, not nostalgia. Items
// carry title/link/date/summary only; bodies reference images by bare
// filename, so shipping full content would mean rewriting every relative
// URL; not worth the fragility.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "hey.json"), "utf8"));

const POSTS_PATH = path.join(ROOT, config.posts);
const PUBLIC_PATH = path.join(ROOT, config.public);
const SITE_URL = config.url;

const MAX_ITEMS = 20;

// Posts author special characters as HTML entities (&#174;, &frac34;). This
// mirrors templates/decode-entities.ejs; a tools script can't render an EJS
// include, so keep the two in sync. &amp; last, so "&amp;#174;" cannot turn
// into a character.
const NAMED_ENTITIES = {
  nbsp: " ", frac14: "¼", frac12: "½", frac34: "¾", deg: "°", trade: "™",
  copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘",
  rsquo: "’", ldquo: "“", rdquo: "”", quot: '"', lt: "<", gt: ">"
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+[0-9]*);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
    .replace(/&amp;/g, "&");
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// The same header-list format hey's compiler parses: `# Title`, then
// ` - key: value` lines, then the body.
function parsePost(slug) {
  const file = path.join(POSTS_PATH, slug, slug + ".text");
  if (!fs.existsSync(file)) {
    // hey skips these silently too (and exits 0), so this warning is the
    // only signal a misnamed .text file gets; a filename/folder mismatch
    // once dropped a finished post from the entire build unnoticed.
    console.warn(`make-feed: posts/${slug}/ has no ${slug}.text; skipped (misnamed file?).`);
    return null;
  }

  // The LEGO train post is CRLF; a stray \r defeats both `$` anchors and
  // `.` (a line terminator in JS regexes), so normalize endings up front.
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  const titleLine = lines.find(line => line.startsWith("# "));
  if (!titleLine) return null;

  const headers = {};
  for (const line of lines) {
    const match = line.match(/^\s+-\s+([a-z]+):\s+(.*)$/);
    if (match) headers[match[1]] = match[2].trim();
  }

  const bodyStart = lines.findIndex(
    (line, i) =>
      i > lines.indexOf(titleLine) &&
      line.trim() !== "" &&
      !line.match(/^\s+-\s+[a-z]+:\s/)
  );

  return {
    slug,
    title: decodeEntities(titleLine.slice(2).trim()),
    headers,
    body: bodyStart === -1 ? "" : lines.slice(bodyStart).join("\n")
  };
}

// Same precedence as templates/blurb.ejs: what the author typed wins, then
// the first paragraph of real prose; skipping images, their italic
// captions, section wrappers and rules. Works on markdown source where
// blurb.ejs works on rendered HTML, so the mechanics differ.
function summarise(post) {
  const authored = post.headers.blurb || post.headers.description;
  if (authored) return decodeEntities(authored);

  const blocks = post.body.split(/\n\s*\n/);
  for (const block of blocks) {
    const flattened = block.trim().replace(/\s+/g, " ");
    if (!flattened) continue;
    if (flattened.startsWith("<") || flattened.startsWith("![")) continue;
    if (flattened.startsWith("_") || flattened.startsWith("----")) continue;
    if (flattened.startsWith("#")) continue;

    const text = decodeEntities(
      flattened
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/[`*]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    );

    if (text.length < 60) continue;
    if (text.length > 300) return text.slice(0, 300).replace(/\s+\S*$/, "") + "…";
    return text;
  }

  return "";
}

function pubDate(headers) {
  const raw = (headers.published || "").trim();
  if (!raw) return null;
  // Date-only headers are forced to UTC so the calendar date survives no
  // matter the machine's timezone (one header has a trailing space, which
  // V8 would otherwise parse as local time).
  const date = raw.match(/^\d{4}-\d{2}-\d{2}$/)
    ? new Date(raw + "T00:00:00Z")
    : new Date(raw);
  return isNaN(date) ? null : date;
}

const posts = fs
  .readdirSync(POSTS_PATH)
  .filter(slug => !slug.startsWith("draft"))
  .filter(slug => fs.statSync(path.join(POSTS_PATH, slug)).isDirectory())
  .map(parsePost)
  .filter(post => post && !post.headers.unlisted)
  .map(post => ({ ...post, date: pubDate(post.headers) }))
  .filter(post => post.date)
  .sort((a, b) => b.date - a.date)
  .slice(0, MAX_ITEMS);

const items = posts
  .map(post => {
    const url = `${SITE_URL}/${post.slug}/`;
    const summary = summarise(post);
    const categories = (post.headers.tags || "")
      .split(/,\s*/)
      .filter(Boolean)
      .map(tag => `      <category>${escapeXml(tag)}</category>`)
      .join("\n");

    return [
      "    <item>",
      `      <title>${escapeXml(post.title)}</title>`,
      `      <link>${escapeXml(url)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
      `      <pubDate>${post.date.toUTCString()}</pubDate>`,
      summary ? `      <description>${escapeXml(summary)}</description>` : null,
      categories || null,
      "    </item>"
    ]
      .filter(Boolean)
      .join("\n");
  })
  .join("\n");

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ben Hoad</title>
    <link>${escapeXml(SITE_URL + "/")}</link>
    <description>I'm Ben Hoad, a remote software engineer based in Australia. I build random things; sometimes they're useful, other times they're just for fun.</description>
    <language>en-au</language>
    <lastBuildDate>${posts.length ? posts[0].date.toUTCString() : new Date(0).toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(SITE_URL + "/feed.xml")}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

if (!fs.existsSync(PUBLIC_PATH)) {
  console.error("make-feed: no public/ directory; run `hey build` first.");
  process.exit(1);
}

fs.writeFileSync(path.join(PUBLIC_PATH, "feed.xml"), feed);
console.log(`make-feed: wrote feed.xml with ${posts.length} item(s).`);

// hey writes robots.txt empty (allow-all, which is the right posture for
// search and AI crawlers alike). Rewrite it with the sitemap pointer;
// the standard discovery mechanism alongside Search Console submission.
fs.writeFileSync(
  path.join(PUBLIC_PATH, "robots.txt"),
  `Sitemap: ${SITE_URL}/sitemap.xml\n`
);
console.log("make-feed: wrote robots.txt with sitemap pointer.");
