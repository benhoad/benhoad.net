// Serves the built /public over plain HTTP for testing on a real device.
//
// `npm start` (hey run) mounts helmet, whose defaults make it unusable from
// anything but localhost:
//
//   * `upgrade-insecure-requests` rewrites every subresource to https://. On
//     localhost nothing happens — it counts as a potentially-trustworthy
//     origin and is exempt — but from a phone hitting http://<lan-ip>:3000 the
//     upgrade is real, and the dev server speaks no TLS, so scene.js and
//     cheet.js die with a TLS error and the 3D background never loads.
//   * `script-src 'self'` with no 'unsafe-inline' blocks the footer's inline
//     script (the copyright year and analytics).
//
// GitHub Pages sends no CSP at all, so neither of those is a real-site
// problem. This server exists purely so what you see on the phone matches
// what ships. It sets no security headers, and mirrors the two things Pages
// does that matter: charset=utf-8 on HTML, and byte-range support — iOS
// Safari will not play a <video> from a server that ignores Range, which the
// LEGO train post needs.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".woff2": "font/woff2",
};

async function resolve(urlPath) {
  // normalize collapses any ../ before it can escape /public.
  const rel = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(
    /^(\.\.[/\\])+/,
    ""
  );
  const candidates = rel.endsWith("/")
    ? [join(ROOT, rel, "index.html")]
    : [join(ROOT, rel), join(ROOT, rel, "index.html")];

  for (const file of candidates) {
    if (!file.startsWith(ROOT)) continue;
    try {
      const info = await stat(file);
      if (info.isFile()) return { file, size: info.size };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  let found = await resolve(req.url || "/");
  let status = 200;

  if (!found) {
    found = await resolve("/404/");
    status = 404;
    if (!found) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found — is /public built? Try `npm run build`.\n");
      return;
    }
  }

  const type = TYPES[extname(found.file).toLowerCase()] || "application/octet-stream";
  // Never cache: the whole point is reloading on a device after a rebuild.
  const headers = { "content-type": type, "cache-control": "no-store" };

  /* Range support. iOS Safari issues `Range: bytes=0-1` before it will play a
     video at all, and treats a 200-with-everything as unplayable. */
  const range = req.headers.range;
  if (range && status === 200) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      let start;
      let end;

      if (match[1] === "") {
        // Suffix form, `bytes=-500`: the LAST 500 bytes, not the first 500.
        start = Math.max(found.size - Number(match[2] || 0), 0);
        end = found.size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), found.size - 1) : found.size - 1;
      }

      if (start > end || start >= found.size) {
        res.writeHead(416, { "content-range": `bytes */${found.size}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        ...headers,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${found.size}`,
        "content-length": end - start + 1,
      });
      createReadStream(found.file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(status, {
    ...headers,
    "accept-ranges": "bytes",
    "content-length": found.size,
  });

  if (req.method === "HEAD") return res.end();
  createReadStream(found.file).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);

  console.log(`\n  Serving /public with no CSP — open on your phone:\n`);
  console.log(`    http://localhost:${PORT}`);
  for (const address of addresses) console.log(`    http://${address}:${PORT}`);
  console.log(`\n  Static snapshot: re-run after changing posts or templates.\n`);
});
