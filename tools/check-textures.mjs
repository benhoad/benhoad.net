// Reports — and optionally repairs — the base colour textures inside post .glb
// files.
//
//   node tools/check-textures.mjs               every texture, with a verdict
//   node tools/check-textures.mjs --quiet       only the ones needing attention
//   node tools/check-textures.mjs --fix         relevel the failing ones in place
//   node tools/check-textures.mjs --fix --only=hogwarts   ...just that model
//
// --fix without --only repairs every failing texture on the site at once,
// which is rarely what you want; --only takes any substring of the path.
//
// `npm run build` runs the --quiet form, so a too-dark model is reported once
// per build and is silent when everything passes.
//
// WHY THIS EXISTS
//
// scene.js re-shades every model with the PSX shader, whose fragment is
// `mix(uShadow, uLight, band) * tex`. The texture is therefore a *modulation
// map*, not an albedo: a texel of 0 means "multiply the palette by zero", so
// black in the texture is not a dark object, it is no object. A model painted
// the colour of the real thing — a black PC case, say — renders as a
// silhouette no matter where the light points, because the light only chooses
// which of three tones a face gets and the texture then scales it to nothing.
//
// The fix is a raised black point, not a brightness or gamma change: scaling
// cannot lift 0 off 0. That is what --fix applies, and what "Adjust curves"
// does in Blockbench when you drag the curve's left endpoint upward.
//
// IMPORTANT: --fix edits the .glb, which is *build output* from Blockbench or
// Blender. Your next export overwrites it. Treat --fix as a stopgap for
// seeing the result; make it stick by lifting the curve in the modeller.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS = join(REPO, "posts");
const BACKUPS = join(REPO, "artifacts", "texture-backups");

/* Opaque mean luminance the shader wants. Below FAIL a model reads as a
   silhouette; between FAIL and WARN it reads but sits darker than its
   neighbours. Pure black is called out separately because no amount of
   brightness fixes it — it needs the floor. */
const FAIL_MEAN = 0.2;
const WARN_MEAN = 0.3;
const FAIL_BLACK = 0.4;
const WARN_BLACK = 0.15;

// Defaults for --fix; override with --floor=0.5 --gamma=1.4
const DEFAULT_FLOOR = 0.45;
const DEFAULT_GAMMA = 1.6;

/* ------------------------------------------------------------------- png */

function pngChunks(buf) {
  const out = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString("ascii");
    out.push({ type, body: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    // A bufferView may pad past IEND; walking on would read the padding as a
    // chunk header and throw.
    if (type === "IEND") break;
  }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function decodePng(buf) {
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  for (const { type, body } of pngChunks(buf)) {
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace) throw new Error("interlaced PNG");
  const ch = CHANNELS[colour];
  if (!ch) throw new Error(`unsupported colour type ${colour} (palette?)`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const data = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = raw.subarray(at, at + stride);
    at += stride;
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      const v = line[x];
      cur[x] =
        filter === 0 ? v :
        filter === 1 ? (v + a) & 255 :
        filter === 2 ? (v + b) & 255 :
        filter === 3 ? (v + ((a + b) >> 1)) & 255 :
        (v + paeth(a, b, c)) & 255;
    }
  }
  return { width, height, ch, colour, data };
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}

function encodePng({ width, height, ch, colour, data }) {
  const stride = width * ch;
  const raw = Buffer.alloc((stride + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: none — these are small flat-colour sheets
    data.copy(raw, at, y * stride, (y + 1) * stride);
    at += stride;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colour;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- glb */

function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
  const chunks = [];
  let at = 12;
  while (at < buf.length) {
    const len = buf.readUInt32LE(at);
    chunks.push(buf.subarray(at + 8, at + 8 + len));
    at += 8 + len;
  }
  return { json: JSON.parse(chunks[0].toString("utf8")), bin: chunks[1] || Buffer.alloc(0) };
}

/* Rebuilds the binary chunk from scratch, rewriting every bufferView offset,
   so a replacement image of a different length is safe wherever its view sits
   in the list. */
function writeGlb(file, json, bin, replacements) {
  const slices = json.bufferViews.map((v, i) =>
    replacements.has(i) ? replacements.get(i) : bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)
  );
  const parts = [];
  let offset = 0;
  json.bufferViews.forEach((v, i) => {
    v.byteOffset = offset;
    v.byteLength = slices[i].length;
    parts.push(slices[i]);
    const pad = ((slices[i].length + 3) & ~3) - slices[i].length;
    if (pad) parts.push(Buffer.alloc(pad));
    offset += slices[i].length + pad;
  });
  const nbin = Buffer.concat(parts);
  json.buffers[0].byteLength = nbin.length;

  const align = (n) => (n + 3) & ~3;
  const wrap = (type, body, pad) => {
    const extra = align(body.length) - body.length;
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length + extra, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body, Buffer.alloc(extra, pad)]);
  };
  const jsonChunk = wrap(0x4e4f534a, Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const binChunk = wrap(0x004e4942, nbin, 0x00);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8);
  writeFileSync(file, Buffer.concat([header, jsonChunk, binChunk]));
}

/* ---------------------------------------------------------------- measure */

/* Fully transparent texels are excluded from the mean. Blockbench leaves most
   of an atlas empty — 52-90% on the LEGO train's sheets — and averaging that
   in would report every model as far darker than it draws. */
function measure(img) {
  let sum = 0, opaque = 0, black = 0, clear = 0;
  for (let i = 0; i < img.data.length; i += img.ch) {
    if (img.ch === 4 && img.data[i + 3] < 8) { clear++; continue; }
    if (img.ch === 2 && img.data[i + 1] < 8) { clear++; continue; }
    const [r, g, b] = img.ch <= 2
      ? [img.data[i], img.data[i], img.data[i]]
      : [img.data[i], img.data[i + 1], img.data[i + 2]];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    opaque++;
    if (r === 0 && g === 0 && b === 0) black++;
  }
  const mean = opaque ? sum / opaque / 255 : 0;
  return {
    mean,
    black: opaque ? black / opaque : 0,
    clear: clear / (clear + opaque || 1),
    opaque,
  };
}

function verdict(m) {
  if (!m.opaque) return "EMPTY";
  if (m.mean < FAIL_MEAN || m.black > FAIL_BLACK) return "FAIL";
  if (m.mean < WARN_MEAN || m.black > WARN_BLACK) return "WARN";
  return "ok";
}

/* out = floor + (1 - floor) * in^(1/gamma). The floor is the whole point: it
   lifts pure black off zero, which no multiply can do. */
function relevel(img, floor, gamma) {
  const data = Buffer.from(img.data);
  const colourChannels = img.ch <= 2 ? 1 : 3;
  for (let i = 0; i < data.length; i += img.ch) {
    for (let k = 0; k < colourChannels; k++) {
      const x = img.data[i + k] / 255;
      data[i + k] = Math.round(Math.min(1, floor + (1 - floor) * Math.pow(x, 1 / gamma)) * 255);
    }
  }
  return { ...img, data };
}

/* ------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};

const QUIET = flag("quiet");
const FIX = flag("fix");
const FLOOR = value("floor", DEFAULT_FLOOR);
const GAMMA = value("gamma", DEFAULT_GAMMA);
const ONLY = (argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || null;

function findModels() {
  const out = [];
  for (const entry of readdirSync(POSTS)) {
    const dir = join(POSTS, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (file.toLowerCase().endsWith(".glb")) out.push(join(dir, file));
    }
  }
  return out.sort();
}

let failing = 0;
let fixed = 0;
const lines = [];

for (const file of findModels()) {
  const rel = `${basename(dirname(file))}/${basename(file)}`;
  // --only scopes *writes*, not the report: it is still useful to see the
  // whole site's state while repairing one model.
  const writable = FIX && (!ONLY || rel.includes(ONLY));
  let glb;
  try {
    glb = readGlb(file);
  } catch (err) {
    lines.push(`  ${rel}\n      unreadable: ${err.message}`);
    failing++;
    continue;
  }

  const images = glb.json.images || [];
  if (!images.length) {
    if (!QUIET) lines.push(`  ${rel}\n      no texture — renders with the procedural placeholder`);
    continue;
  }

  const rows = [];
  const replacements = new Map();

  images.forEach((image, i) => {
    if (image.bufferView === undefined) {
      rows.push({ i, note: `external uri (${image.uri || "?"}) — not checked` });
      return;
    }
    const view = glb.json.bufferViews[image.bufferView];
    const png = glb.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    if (image.mimeType && image.mimeType !== "image/png") {
      rows.push({ i, note: `${image.mimeType} — only PNG is measured` });
      return;
    }
    let img;
    try {
      img = decodePng(png);
    } catch (err) {
      rows.push({ i, note: `cannot decode: ${err.message}` });
      return;
    }
    const m = measure(img);
    const v = verdict(m);
    rows.push({ i, img, m, v });
    if (v === "FAIL") {
      failing++;
      if (writable) {
        replacements.set(image.bufferView, encodePng(relevel(img, FLOOR, GAMMA)));
      }
    }
  });

  const worst = rows.some((r) => r.v === "FAIL") ? "FAIL"
    : rows.some((r) => r.v === "WARN") ? "WARN" : "ok";
  if (QUIET && worst !== "FAIL") continue;

  /* npm run preview reruns the build on every save, so --quiet lists only the
     sheets that actually fail. The full picture is `npm run textures`. */
  const shown = QUIET ? rows.filter((r) => r.v === "FAIL" || r.note) : rows;

  const body = shown.map((r) => {
    if (r.note) return `      [${r.i}] ${r.note}`;
    const size = `${r.img.width}x${r.img.height}`.padEnd(9);
    return `      [${r.i}] ${size} ${r.v.padEnd(5)} mean ${(r.m.mean * 100).toFixed(0).padStart(3)}%` +
      `   black ${(r.m.black * 100).toFixed(0).padStart(3)}%` +
      `   transparent ${(r.m.clear * 100).toFixed(0).padStart(3)}%`;
  });
  lines.push(`  ${rel}  [${worst}]\n${body.join("\n")}`);

  if (writable && replacements.size) {
    mkdirSync(BACKUPS, { recursive: true });
    const backup = join(BACKUPS, `${basename(dirname(file))}-${basename(file)}`);
    writeFileSync(backup, readFileSync(file));
    writeGlb(file, glb.json, glb.bin, replacements);
    fixed += replacements.size;
    lines.push(`      -> relevelled ${replacements.size} texture(s) (floor ${FLOOR}, gamma ${GAMMA})`);
    lines.push(`      -> backup: artifacts/texture-backups/${basename(backup)}`);
  }
}

if (lines.length) {
  console.log(`check-textures:${QUIET ? "" : " base colour textures in posts/*/*.glb"}`);
  console.log(lines.join("\n"));
}

if (failing && !FIX && QUIET) {
  console.log(`check-textures: ${failing} texture(s) too dark — run \`npm run textures\` for detail.`);
} else if (failing && !FIX) {
  console.log(
    `check-textures: ${failing} texture(s) too dark to render.\n` +
    `  The shader multiplies the texture into the palette, so black means "no colour".\n` +
    `  Fix at source: in Blockbench, Image > Adjust curves, drag the curve's LEFT\n` +
    `  endpoint up to about 45% height. Brightness & Contrast cannot lift pure black.\n` +
    `  Or run: npm run textures:fix   (edits the .glb; your next export overwrites it)`
  );
} else if (fixed) {
  console.log(
    `check-textures: relevelled ${fixed} texture(s).\n` +
    `  These .glb files are export output — redo this in the modeller to make it stick.`
  );
} else if (FIX && failing) {
  console.log(
    `check-textures: ${failing} texture(s) need fixing but --only=${ONLY} matched no model.`
  );
} else if (!QUIET && !lines.length) {
  console.log("check-textures: no models found.");
} else if (!QUIET && !failing) {
  console.log("check-textures: all textures in range.");
}

// Never fail the build: a dark texture is a content problem, not a broken build.
process.exit(0);
