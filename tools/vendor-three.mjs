// Copies the three.js browser build; and the glTF loader; into templates/
// so `hey` can pick them up.
//
// hey only copies files that sit directly in templates/ and have an
// image/js/css extension (see compiler.js), so there is nowhere to put a
// nested vendor folder and no bundler to resolve a bare "three" import.
// Copying the build files in at their published names keeps the relative
// import inside three.module.min.js ("./three.core.min.js") resolving against
// the site root, where both files land.
//
// The addons ship as ES modules written against a bundler: they import the
// bare specifier "three", and GLTFLoader imports two siblings by relative
// path. Since every file lands flat at the web root, those specifiers are
// rewritten on the way through; see REWRITES.
//
// The copies are gitignored; `npm ci` restores node_modules and prestart /
// prebuild re-run this, so the vendored bytes never need to be committed.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THREE = join(ROOT, "node_modules", "three");
const TO = join(ROOT, "templates");

// three.module.min.js is the entry point; it imports three.core.min.js by
// relative path, so both have to travel together.
const BUILD = ["three.module.min.js", "three.core.min.js"];

/* GLTFLoader plus the only two addons it depends on. Both of those import
   nothing but "three" themselves, so the graph stops here; verified by the
   bare-specifier check below, which fails the build if that ever changes. */
const ADDONS = [
  ["examples/jsm/loaders/GLTFLoader.js", "three-gltfloader.js"],
  ["examples/jsm/utils/BufferGeometryUtils.js", "three-buffergeometryutils.js"],
  ["examples/jsm/utils/SkeletonUtils.js", "three-skeletonutils.js"],
];

const REWRITES = [
  [/from\s*(['"])three\1/g, 'from "/three.module.min.js"'],
  [
    /from\s*(['"])\.\.\/utils\/BufferGeometryUtils\.js\1/g,
    'from "/three-buffergeometryutils.js"',
  ],
  [
    /from\s*(['"])\.\.\/utils\/SkeletonUtils\.js\1/g,
    'from "/three-skeletonutils.js"',
  ],
];

/* An import the rewrites did not catch would fail silently in the browser;
   the module just never loads and the model never appears. Better to break the
   build.

   Anchored to a line that actually begins an import/export statement. A looser
   search for `from "..."` picks up three's own prose: JSDoc lines quoting URLs,
   and a console.warn about converting colours from "srgb-linear". */
function unresolvedImports(source) {
  const statements =
    source.match(/^\s*(?:import|export)\b[\s\S]*?from\s*['"][^'"]+['"]/gm) || [];

  return statements
    .map((s) => s.match(/from\s*['"]([^'"]+)['"]$/)[1])
    .filter((path) => !path.startsWith("/"));
}

await mkdir(TO, { recursive: true });

for (const file of BUILD) {
  try {
    await copyFile(join(THREE, "build", file), join(TO, file));
  } catch (err) {
    console.error(
      `\nCould not vendor ${file} from node_modules/three/build.\n` +
        `Run \`npm install\` first; the index page's 3D background needs it.\n`
    );
    throw err;
  }
}

for (const [from, to] of ADDONS) {
  let source;
  try {
    source = await readFile(join(THREE, from), "utf8");
  } catch (err) {
    console.error(
      `\nCould not vendor ${from} from node_modules/three.\n` +
        `Run \`npm install\` first; posts with a \`model:\` header need it.\n`
    );
    throw err;
  }

  for (const [pattern, replacement] of REWRITES) {
    source = source.replace(pattern, replacement);
  }

  const unresolved = unresolvedImports(source);
  if (unresolved.length) {
    throw new Error(
      `${from} still has imports this script cannot resolve, and nothing here ` +
        `bundles:\n  ${unresolved.join("\n  ")}\n` +
        `Add a rule to REWRITES in tools/vendor-three.mjs.`
    );
  }

  await writeFile(join(TO, to), source);
}

console.log(
  `Vendored ${BUILD.length} three.js build files and ${ADDONS.length} addons into templates/`
);
