// Serves the built /public over plain HTTP, and rebuilds it when a source
// file changes. This is the dev server for anything `npm start` gets wrong.
//
// `npm start` (hey run) mounts helmet, whose defaults make it unusable from
// anything but localhost — and, for one of them, unusable even there:
//
//   * `upgrade-insecure-requests` rewrites every subresource to https://. On
//     localhost nothing happens; it counts as a potentially-trustworthy
//     origin and is exempt; but from a phone hitting http://<lan-ip>:3000 the
//     upgrade is real, and the dev server speaks no TLS, so scene.js and
//     cheet.js die with a TLS error and the 3D background never loads.
//   * `script-src 'self'` with no 'unsafe-inline' blocks the footer's inline
//     script (the copyright year and analytics).
//   * `default-src 'self'` — the fallback, since no `connect-src` is set —
//     blocks the blob: URL GLTFLoader mints to decode a .glb's embedded
//     texture. This one bites on localhost too, and it fails *quietly*:
//     GLTFLoader logs "Couldn't load texture blob:..." but still resolves, so
//     the model arrives with material.map unset and scene.js falls back to
//     the procedural placeholder. The object looks right and wears the wrong
//     skin. Every Blender .glb embeds its texture, so every model hits this.
//
// GitHub Pages sends no CSP at all, so none of those is a real-site problem.
// This server exists purely so what you see locally matches what ships. It
// sets no security headers, and mirrors the two things Pages does that
// matter: charset=utf-8 on HTML, and byte-range support; iOS Safari will not
// play a <video> from a server that ignores Range, which the LEGO train post
// needs.

import { spawn } from "node:child_process";
import { createReadStream, readFileSync, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { delimiter, dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(REPO, "public");
const PORT = Number(process.env.PORT) || 4173;

// `npm run preview` has already built once via prepreview, so the watcher only
// has to handle edits from here on. --no-watch gives the old static snapshot.
const WATCHING = !process.argv.includes("--no-watch");
const WATCHED = ["posts", "templates"];

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
  const asIndex = join(ROOT, rel, "index.html");
  const candidates = rel.endsWith("/")
    ? [asIndex]
    : [join(ROOT, rel), asIndex];

  for (const file of candidates) {
    if (!file.startsWith(ROOT)) continue;
    try {
      const info = await stat(file);
      // isIndex: the URL named a directory and we fell through to its
      // index.html, so the browser's idea of "here" is one level off.
      if (info.isFile()) {
        return { file, size: info.size, isIndex: file === asIndex && !rel.endsWith("/") };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  let found = await resolve(req.url || "/");
  let status = 200;

  /* Redirect /slug to /slug/, exactly as express.static (hey run) and GitHub
     Pages both do. Without this, serving the directory's index.html straight
     from the bare URL leaves the browser believing it is at /slug, so every
     relative URL in the page resolves one level too high — and posts
     reference their images by bare filename, so every hero image 404s. A
     preview server that does not redirect is lying about production. */
  if (found && found.isIndex) {
    const [path, query] = (req.url || "/").split(/(?=\?)/);
    res.writeHead(301, { location: `${path}/${query || ""}` });
    return res.end();
  }

  if (!found) {
    found = await resolve("/404/");
    status = 404;
    if (!found) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found; is /public built? Try `npm run build`.\n");
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

/* The build command is read out of package.json so it cannot drift from the
   one-shot path — but it is run directly rather than through `npm run build`,
   and that part is load-bearing. `npm run build` fires the `prebuild` hook,
   which re-vendors three.js *into /templates*, which is a directory this
   watcher is watching; the write would look like a source edit and trigger
   another build, forever. prepreview has already vendored once by the time
   the server is up, so skipping the hook is both correct and much faster. */
const BUILD = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts.build;

/* Routine build chatter. Everything not matched here is printed, so a real
   failure — including hey's, which exits 0 on a template render error and so
   cannot be spotted by exit code alone — still gets through. */
const NOISE = [
  /^\s*>/, // npm script echo
  /deprecation warning/i, // dart-sass, once per @import and per legacy API call
  /^\s*more info/i,
  /^\s*[╷│╵]/, // sass code frame
  /^\s*\d+\s*│/,
  /^\s*\^+\s*$/,
  /root stylesheet\s*$/,
  /^\s*make-feed: /,
  /^\s*Vendored \d+ three\.js/,
];

function quieten(output) {
  return output
    .split("\n")
    .filter((line) => line.trim() && !NOISE.some((re) => re.test(line)))
    .join("\n");
}

let building = false;
let queued = null;

function rebuild(reason) {
  if (building) {
    queued = reason; // coalesce; one more pass picks up whatever landed
    return;
  }

  building = true;
  const startedAt = Date.now();
  process.stdout.write(`  ${reason} — rebuilding… `);

  const child = spawn(BUILD, {
    cwd: REPO,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    // node_modules/.bin so `hey` resolves even when this is run as a bare
    // `node tools/preview.mjs` rather than through an npm script.
    env: {
      ...process.env,
      PATH: join(REPO, "node_modules", ".bin") + delimiter + process.env.PATH,
    },
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  child.on("close", (code) => {
    building = false;
    const ms = Date.now() - startedAt;

    /* Filtered on failure too. The patterns above only match dart-sass's
       deprecation blocks and routine success chatter, none of which can be
       the cause of a failure, and leaving them in buries the actual error
       under a couple of hundred lines. If filtering somehow eats everything,
       fall back to the raw output rather than reporting a silent failure. */
    const rest = quieten(output) || (code === 0 ? "" : output.trim());

    console.log(code === 0 ? `done in ${ms}ms` : `FAILED (exit ${code}) in ${ms}ms`);
    if (rest) console.log(rest.replace(/^/gm, "    "));

    if (queued) {
      const next = queued;
      queued = null;
      rebuild(next);
    }
  });
}

/* tools/vendor-three.mjs writes three.module.min.js, three.core.min.js and the
   three-*.js addons into /templates — they are gitignored for the same reason.
   Running BUILD directly already avoids re-vendoring, but ignoring them here
   too means nothing else writing those files can start a rebuild cycle. */
const GENERATED = /^three[.-]/;

function startWatching() {
  for (const dir of WATCHED) {
    try {
      let timer = null;
      watch(join(REPO, dir), { recursive: true }, (_event, filename) => {
        if (!filename) return;

        const parts = filename.split(sep);
        // Editors and Finder churn: .DS_Store, swap files, atomic-rename temps.
        if (parts.some((part) => part.startsWith("."))) return;
        if (dir === "templates" && GENERATED.test(parts[parts.length - 1])) return;

        clearTimeout(timer);
        timer = setTimeout(() => rebuild(`${dir}/${filename}`), 200);
      });
    } catch (err) {
      console.log(`  (could not watch ${dir}: ${err.message})`);
    }
  }
}

server.listen(PORT, "0.0.0.0", () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);

  console.log(`\n  Serving /public with no CSP; open on your phone:\n`);
  console.log(`    http://localhost:${PORT}`);
  for (const address of addresses) console.log(`    http://${address}:${PORT}`);

  if (WATCHING) {
    console.log(`\n  Watching ${WATCHED.join(" and ")}; reload after a rebuild.`);
    console.log(`  Unlike npm start this permits blob:, so .glb textures load.\n`);
    startWatching();
  } else {
    console.log(`\n  Static snapshot: re-run after changing posts or templates.\n`);
  }
});
