// Draws the site icon from a 16x16 pixel grid and writes the PNGs.
//
// Run with `npm run favicon` after editing GLYPH. The output is committed;
// this is a design source, not a build step, so nothing in the normal build
// depends on it.
//
// Everything is emitted at an integer multiple of the 16x16 grid, so a browser
// scaling the file down to 16 or 32 lands exactly on pixel boundaries and the
// art stays crisp. Shipping a bare 16x16 would instead be smoothly upscaled on
// a high-DPI tab, which is the one thing pixel art must not be.
//
// PNG is written by hand: it is a signature, three chunks and a zlib stream,
// which is far less trouble than taking on an image dependency for one icon.

import { deflateSync, crc32 } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* The lowercase b of the wordmark, on the 16x16 grid browsers actually render
   a favicon at. Two pixels of margin all round so it does not crowd the tab,
   a 3px stem, and a bowl whose corners are stepped in by one to round it. */
const GLYPH = [
  "................",
  "..###...........",
  "..###...........",
  "..###...........",
  "..###...........",
  "..###...........",
  "..##########....",
  "..###########...",
  "..###.....###...",
  "..###.....###...",
  "..###.....###...",
  "..###.....###...",
  "..###.....###...",
  "..###########...",
  "..##########....",
  "................",
];

const BACKGROUND = [0x0b, 0x0b, 0x10]; // --bg, the site's near-black
const INK = [0xe8, 0xe8, 0xf0]; // --ink
const SHADOW = [0x35, 0xe0, 0xc8]; // --accent-b, as under the wordmark

const SIZE = 16;

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/* @param {number[][]} pixels - SIZE*SIZE entries of [r,g,b]
   @param {number} scale - whole-number pixel size */
function encodePng(pixels, scale) {
  const width = SIZE * scale;
  const raw = Buffer.alloc((width * 3 + 1) * width);
  let at = 0;

  for (let y = 0; y < width; y++) {
    raw[at++] = 0; // filter: none. The art is flat colour; filtering buys
    // nothing and keeps this readable.
    for (let x = 0; x < width; x++) {
      const [r, g, b] =
        pixels[Math.floor(y / scale) * SIZE + Math.floor(x / scale)];
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 2; // truecolour RGB; the icon is fully opaque
  // 10-12 are compression, filter and interlace methods, all 0.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* Offsetting the ink by one pixel and laying the accent underneath echoes the
   wordmark's drop shadow. At this size it also thickens the silhouette, which
   helps the glyph hold together in a tab. */
function render({ shadow }) {
  const pixels = Array.from({ length: SIZE * SIZE }, () => BACKGROUND);
  const lit = (x, y) =>
    x >= 0 && y >= 0 && x < SIZE && y < SIZE && GLYPH[y][x] === "#";

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // The shadow sits down-right, so a pixel shows it when the glyph covers
      // the cell up-left of it but not this one.
      if (shadow && !lit(x, y) && lit(x - 1, y - 1)) {
        pixels[y * SIZE + x] = SHADOW;
      }
      if (lit(x, y)) pixels[y * SIZE + x] = INK;
    }
  }

  return pixels;
}

/* Flat by default: at 16px the offset copy thickens every stroke and closes
   most of the counter, and legibility in a tab beats the brand nod. `--shadow`
   renders the wordmark's teal drop shadow instead, which looks right at
   apple-touch-icon size if that is ever wanted. */
const pixels = render({ shadow: process.argv.includes("--shadow") });

/* `--preview <path>` writes one big copy instead, for looking at the grid
   while editing it. Nothing reads it; it is a scratch file. */
const previewAt = process.argv.indexOf("--preview");

/* favicon at 4x the grid: exact 4:1 and 2:1 reductions to the 16 and 32 a tab
   asks for. apple-touch-icon at 12x, comfortably over the 180 iOS wants. */
const outputs =
  previewAt !== -1
    ? [[process.argv[previewAt + 1], 20]]
    : [
        ["templates/favicon.png", 4],
        ["templates/apple-touch-icon.png", 12],
      ];

for (const [path, scale] of outputs) {
  // resolve, not join: --preview is given an absolute path.
  await writeFile(resolve(ROOT, path), encodePng(pixels, scale));
  console.log(`wrote ${path} at ${SIZE * scale}x${SIZE * scale}`);
}
