/* ===========================================================================
   scene.js; the low-poly background for the index page.

   One object per post, floating to the right of the post list. As you scroll,
   the object belonging to whichever post owns the viewport's focus line slides
   in from the side while the previous one slides out the other way.

   The look is deliberately PSX/N64: everything renders into a ~320px-wide
   framebuffer that CSS upscales with image-rendering:pixelated, vertices snap
   to that framebuffer's pixel grid, and texture coordinates interpolate
   affinely so surfaces warp the way an untextured-correction console did.
   See psxVertex()/psxFragment() below for how each of those is done.

   This file is copied verbatim by `hey` (it only rewrites .ejs), so modern
   syntax is safe here; unlike inline <script> blocks in the templates, which
   pass through html-minifier's JS pass.
   =========================================================================== */

import * as THREE from "/three.module.min.js";

/* This is a deliberately non-linear pipeline: the fragment shader does its own
   flat shading and 15-bit dither directly on sRGB byte values, the way the
   hardware it imitates did. Left on, three's colour management would convert
   every Color to its linear working space on the way in, while a raw
   ShaderMaterial gets no matching conversion on the way out; so every palette
   entry would render far darker than authored. Opting out keeps what is
   written in TAG_COLOURS equal to what lands on screen. */
THREE.ColorManagement.enabled = false;

/* Virtual framebuffer height. Width follows the viewport aspect, so the
   chunkiness stays constant instead of growing with the window. 256 is a touch
   taller than a PSX's 240; enough that a cube's silhouette still reads at
   phone widths. */
const FB_HEIGHT = 256;
const FB_MAX_WIDTH = 640;

/* Viewport width at which the layout puts the list beside the object rather
   than behind it. Must match the breakpoint in index.scss. */
const WIDE_AT = 900;

/* Largest dimension a loaded model is scaled to, in world units; roughly the
   size of the primitives it replaces, so a Blender export can be authored at
   any scale without having to agree with anything in here. */
const MODEL_SIZE = 2.6;

/* Seconds for a swap. Long enough to register as motion at a scroll-flick,
   short enough that it has settled by the time you have read the title. */
const SWAP_TIME = 0.55;

/* Where down the viewport a post has to reach to become the active one.
   Matches the CSS that dims the non-active rows. */
const FOCUS = 0.45;

/* ---------------------------------------------------------------- palette */

/* Tag -> the two colours a post's object is built from. First matching tag in
   the post's list wins, so the ordering here is the priority order. Anything
   unmatched falls through to a hash of the slug, which keeps new posts looking
   intentional without needing an entry. */
const TAG_COLOURS = {
  code: ["#35E0C8", "#0E4F5C"],
  tech: ["#4FA8FF", "#122A63"],
  technology: ["#4FA8FF", "#122A63"],
  gaming: ["#FF4FD8", "#4A0E52"],
  "3d": ["#FFB347", "#5C2A0E"],
  "3d printing": ["#FFB347", "#5C2A0E"],
  cad: ["#C77DFF", "#33105C"],
  fabrication: ["#FF6B4F", "#5C1A0E"],
  design: ["#FF4FD8", "#4A0E52"],
  learning: ["#9BE04F", "#2A4A0E"],
  travel: ["#4FE0A8", "#0E4A38"],
  life: ["#FFD84F", "#5C4A0E"],
  stuff: ["#8A9BB8", "#1E2740"],
};

/* Shading for a model that brought its own texture. Deliberately neutral: the
   fragment computes `mix(uShadow, uLight, band) * tex`, so a grey pair turns
   that first term into a plain light/shade multiplier and the texture's own
   hue survives untouched. With a tag colour there instead, every model is
   tinted — a neutral texture takes the palette's hue wholesale (a silver
   laptop under #FFD84F reads gold), and a saturated one is destroyed outright
   (a red train under teal #35E0C8 loses every channel to near-black).

   The tag palette still drives the placeholder primitives. They carry only a
   procedural greyscale texture, so without it they would be featureless white
   blocks — and a mesh inside a model that has no texture of its own falls back
   to that same placeholder texture, and to the palette with it, for exactly
   the same reason. */
const MODEL_SHADING = ["#FFFFFF", "#404040"];

/* glTF stores baseColorFactor in *linear* space, and GLTFLoader hands it over
   untouched because ColorManagement is off up top — while this shader works in
   sRGB bytes throughout. Encoding it here is what makes a factor-only model
   match what any other glTF viewer shows.

   Not a guess: crt-set.glb's five factors decode through this to #8A9BB8 and
   #35E0C8, which are exactly the TAG_COLOURS entries for `stuff` and `code`
   that it was authored from. Read as sRGB directly they would be #41547A and
   #09BE93, which are nothing in particular. */
function linearToSRGB(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/* How far a factor has to sit from white before it counts as the mesh's
   colour rather than glTF's default. Below this a texture-less mesh keeps the
   procedural placeholder and the tag palette, which is what an untextured,
   uncoloured model should still get. */
const BASE_COLOUR_EPSILON = 0.02;

/* Which primitive a post gets. Still deliberately simple; a cube is the
   default and the others are just enough variation that consecutive posts do
   not look identical. Swapped for real per-post models later. */
const TAG_SHAPES = {
  code: "cube",
  gaming: "cube",
  "3d": "pyramid",
  "3d printing": "pyramid",
  cad: "pyramid",
  fabrication: "prism",
  travel: "prism",
  life: "prism",
};

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* Fallback colours for a post whose tags are all unmapped: a hue off the slug
   hash, paired with a much darker version of itself for the shaded faces. */
function fallbackColours(slug) {
  const hue = hashString(slug) % 360;
  return [`hsl(${hue}, 72%, 62%)`, `hsl(${hue}, 68%, 20%)`];
}

function lookFor(slug, tags) {
  let colours = null;
  let shape = "cube";
  let shapeFound = false;

  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!colours && TAG_COLOURS[tag]) colours = TAG_COLOURS[tag];
    if (!shapeFound && TAG_SHAPES[tag]) {
      shape = TAG_SHAPES[tag];
      shapeFound = true;
    }
  }

  return { colours: colours || fallbackColours(slug), shape };
}

/* ----------------------------------------------------------------- shader */

/* Vertex snapping + the setup for affine UVs.

   Snapping: the console had no sub-pixel precision in its vertex pipeline, so
   vertices landed on whole framebuffer pixels and geometry visibly jittered as
   it moved. Reproduced by taking the NDC position, scaling it to the virtual
   framebuffer's half-resolution, rounding, and scaling back; then multiplying
   through by w again because gl_Position is still pre-divide.

   Affine UVs: WebGL always interpolates varyings perspective-correctly. To get
   the screen-linear interpolation the console used, hand the rasteriser uv*w
   and w separately; dividing one by the other in the fragment shader cancels
   the correction back out and leaves the classic wobble. */
const psxVertex = /* glsl */ `
  uniform vec2 uFrameBuffer;

  varying vec2 vUv;
  varying float vW;
  varying vec3 vNormal;

  void main() {
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    vec4 clip = projectionMatrix * viewPos;

    vec4 snapped = clip;
    // Guard the divide: vertices at or behind the eye plane have w <= 0 and
    // snapping them throws the triangle across the screen.
    if (clip.w > 0.0001) {
      // Not "half"; that is a reserved word in GLSL ES and fails to compile.
      vec2 halfRes = uFrameBuffer * 0.5;
      vec2 ndc = clip.xy / clip.w;
      snapped.xy = (floor(ndc * halfRes + 0.5) / halfRes) * clip.w;
    }

    vUv = uv * clip.w;
    vW = clip.w;
    vNormal = normalize(normalMatrix * normal);

    gl_Position = snapped;
  }
`;

/* Flat-ish two-tone shading, the texture applied with the affine UVs, and a
   final quantise to 5 bits per channel with an ordered dither; the console
   stored 15-bit colour and leaned on dithering to hide the banding. */
const psxFragment = /* glsl */ `
  precision mediump float;

  uniform sampler2D uMap;
  uniform vec3 uLight;
  uniform vec3 uShadow;
  uniform float uFade;
  uniform float uAlphaCutoff;
  uniform vec3 uBaseColour;
  uniform float uEmissive;

  varying vec2 vUv;
  varying float vW;
  varying vec3 vNormal;

  // 4x4 Bayer matrix, expressed as a lookup over the pixel coordinate.
  float bayer(vec2 p) {
    vec2 c = mod(floor(p), 4.0);
    int idx = int(c.y * 4.0 + c.x);
    float table[16];
    table[0]=0.0;   table[1]=8.0;   table[2]=2.0;   table[3]=10.0;
    table[4]=12.0;  table[5]=4.0;   table[6]=14.0;  table[7]=6.0;
    table[8]=3.0;   table[9]=11.0;  table[10]=1.0;  table[11]=9.0;
    table[12]=15.0; table[13]=7.0;  table[14]=13.0; table[15]=5.0;
    for (int i = 0; i < 16; i++) {
      if (i == idx) return table[i] / 16.0 - 0.5;
    }
    return 0.0;
  }

  void main() {
    vec2 uv = vUv / vW;
    vec4 texel = texture2D(uMap, uv);

    /* glTF alphaMode:MASK, carried over as the source material's alphaTest.
       Blockbench atlases are mostly empty — 50-90% of the sheet — so a face
       mapped onto a transparent region would otherwise draw the colour behind
       the hole, which is black. Zero means the model did not ask for cutout,
       and the comparison then never fires. */
    if (uAlphaCutoff > 0.0 && texel.a < uAlphaCutoff) discard;

    vec3 tex = texel.rgb;

    /* Back faces of a doubleSided material carry the front face's normal, so
       lighting them unflipped drops every one of them into the shadow band. */
    vec3 normal = normalize(vNormal);
    if (!gl_FrontFacing) normal = -normal;

    // Single fixed key light, no falloff; the shading should read as flat
    // bands per face rather than a smooth gradient.
    float lambert = max(dot(normal, normalize(vec3(0.45, 0.8, 0.6))), 0.0);
    float band = step(0.55, lambert) * 0.55 + step(0.18, lambert) * 0.45;

    /* An emissive surface makes its own light, so it should not sit in a
       shadow band because of where it happens to face. Forcing the top band
       makes a screen read as lit from within rather than as a plastic panel
       catching the key light. */
    band = mix(band, 1.0, uEmissive);

    /* uBaseColour is glTF's baseColorFactor. The spec multiplies it into the
       base colour texture, which is what happens here; for a CAD export with
       no texture at all it is the only colour the mesh has, and uMap is a
       1x1 white pixel so this term carries the lot. */
    vec3 colour = mix(uShadow, uLight, band) * tex * uBaseColour;

    // 15-bit quantise with the dither applied before rounding.
    float steps = 31.0;
    colour += bayer(gl_FragCoord.xy) / steps;
    colour = floor(colour * steps + 0.5) / steps;

    gl_FragColor = vec4(colour, uFade);
  }
`;

/* ---------------------------------------------------------------- texture */

/* A small procedural texture per post. It exists mostly so the affine UV
   warp has something to bite on; a flat colour would hide the effect
   entirely. Drawn at 64x64 and sampled with NearestFilter, no mips. */
function makeTexture(seed, shape) {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  // Panel lines, so the cube reads as a built object rather than a swatch.
  ctx.strokeStyle = "rgba(0,0,0,0.32)";
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, size - 8, size - 8);

  ctx.fillStyle = "rgba(0,0,0,0.22)";
  let h = seed;
  const next = () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };

  // A scattering of 4px cells; enough texture detail to see the warp, few
  // enough that it still reads as clean at 320px wide.
  const cells = shape === "cube" ? 22 : 14;
  for (let i = 0; i < cells; i++) {
    const x = Math.floor(next() * 14) * 4 + 4;
    const y = Math.floor(next() * 14) * 4 + 4;
    ctx.fillRect(x, y, 4, 4);
  }

  // A brighter stripe near the top edge, an easy read for orientation as the
  // object turns.
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(8, 10, size - 16, 3);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  /* Left as sRGB, three uploads this as an SRGB8_ALPHA8 texture and the GPU
     decodes it to linear on every sample; which this shader, working entirely
     in sRGB byte space, would never convert back. Declaring no colour space
     keeps the sampled value identical to the bytes drawn into the canvas
     above. Same reasoning as ColorManagement.enabled = false at the top. */
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/* --------------------------------------------------------------- geometry */

function makeGeometry(shape) {
  switch (shape) {
    case "pyramid":
      // radialSegments 4 = a square pyramid. Low enough poly to be honest.
      return new THREE.ConeGeometry(1.5, 2.4, 4, 1);
    case "prism":
      return new THREE.CylinderGeometry(1.4, 1.4, 2.2, 6, 1);
    case "cube":
    default:
      return new THREE.BoxGeometry(2, 2, 2);
  }
}

/* ------------------------------------------------------------------- main */

function start() {
  const canvas = document.getElementById("bg");
  const rows = Array.from(document.querySelectorAll(".post-row[data-index]"));
  if (!canvas || !rows.length) return;

  const reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: "low-power",
    });
  } catch (err) {
    // No WebGL. Bailing here leaves the canvas at its default opacity:0 and
    // the list without .is-live, which is exactly the no-3D presentation:
    // a plain, fully legible list on the page background.
    return;
  }

  if (!renderer.getContext()) return;

  // Reveals the canvas; it is hidden until a context is known to work.
  document.body.classList.add("has-webgl");

  // Pixel ratio is pinned to 1: the whole point is a small framebuffer that
  // CSS blows up, so rendering at device DPR would undo the effect and cost
  // a lot more fill rate on a phone.
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
  camera.position.set(0, 0, 8);

  /* Where the camera sits before any tilt. resize() owns this; the frame loop
     adds the tilt offset to it rather than writing position directly, so the
     two cannot fight over the same property. */
  const cameraBase = new THREE.Vector3(0, 0, 8);

  // World units the camera moves at full tilt. Derived from the frustum in
  // resize(), alongside cameraBase, so the two always agree.
  const tiltAmount = new THREE.Vector2(0, 0);

  const frameBuffer = new THREE.Vector2(FB_HEIGHT, FB_HEIGHT);

  /* Every PSX material in the scene, so a resize can push the new snapping
     grid into all of them. Materials arrive late when a post loads a model, so
     this cannot be derived from the object list at resize time. */
  const materials = [];

  /* ShaderMaterial clones the uniforms object it is constructed with, so every
     material owns its own uFrameBuffer Vector2 and each has to be written to
     directly; assigning the shared one would reach none of them. */
  function syncFrameBuffer() {
    for (const material of materials) {
      material.uniforms.uFrameBuffer.value.copy(frameBuffer);
    }
  }

  /* Set by the reduced-motion branch, which has no animation loop to repaint
     for it. renderer.setSize() reassigns canvas.width, and that discards the
     WebGL drawing buffer; so without a redraw a window resize or a phone
     rotating (or the URL bar collapsing) blanks the object until the reader
     happens to scroll into a different post. A model finishing loading needs
     the same nudge. In the animated path the loop covers both. */
  let requestRedraw = () => {};

  /* baseColorFactor, sRGB-encoded, or white when the material has none. */
  function baseColourOf(material) {
    if (!material || !material.color) return new THREE.Color(1, 1, 1);
    const { r, g, b } = material.color;
    return new THREE.Color(linearToSRGB(r), linearToSRGB(g), linearToSRGB(b));
  }

  /* emissiveFactor, same linear-to-sRGB treatment — GLTFLoader builds it with
     the same setRGB(..., LinearSRGBColorSpace) call as the base colour.

     Two deliberate departures from the glTF maths. glTF's default
     emissiveFactor is black, and a material carrying an emissive *texture* but
     no factor would multiply that texture away to nothing, so black is read as
     "unset" and promoted to white. And emissiveIntensity — the
     KHR_materials_emissive_strength value, 4.0 on the CocoVision screen — is
     ignored outright: there is no HDR buffer or bloom here for it to mean
     anything, so applying it would only clip the image to white. */
  function emissiveColourOf(material) {
    if (!material || !material.emissive) return new THREE.Color(1, 1, 1);
    const { r, g, b } = material.emissive;
    if (r + g + b < 0.001) return new THREE.Color(1, 1, 1);
    return new THREE.Color(linearToSRGB(r), linearToSRGB(g), linearToSRGB(b));
  }

  function isTinted(colour) {
    return (
      Math.abs(1 - colour.r) > BASE_COLOUR_EPSILON ||
      Math.abs(1 - colour.g) > BASE_COLOUR_EPSILON ||
      Math.abs(1 - colour.b) > BASE_COLOUR_EPSILON
    );
  }

  /* One white pixel, for meshes whose colour is entirely in baseColorFactor.
     A CAD export like cocotest.glb has no image *and no UVs at all*, so there
     is nothing to sample; a flat white texel lets the existing `* tex` term
     pass the factor through untouched. Built once and shared — it never
     varies, and every material samples it identically. */
  let flatTexture = null;
  function whitePixel() {
    if (!flatTexture) {
      flatTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      flatTexture.colorSpace = THREE.NoColorSpace;
      flatTexture.needsUpdate = true;
    }
    return flatTexture;
  }

  /* `from` is the glTF material about to be discarded, when there is one. Two
     of its properties survive the swap because they are geometry decisions
     rather than shading ones, and the PSX look has no opinion on either:
     GLTFLoader turns alphaMode:MASK into alphaTest, and doubleSided into
     side = DoubleSide. Everything else — PBR factors, normal maps, emissive —
     is what the shader deliberately replaces. */
  function makeMaterial(colours, map, from, emissive) {
    const factor = emissive ? emissiveColourOf(from) : baseColourOf(from);
    const material = new THREE.ShaderMaterial({
      vertexShader: psxVertex,
      fragmentShader: psxFragment,
      transparent: true,
      side: from ? from.side : THREE.FrontSide,
      uniforms: {
        uMap: { value: map },
        uLight: { value: new THREE.Color(colours[0]) },
        uShadow: { value: new THREE.Color(colours[1]) },
        uFade: { value: 0 },
        uAlphaCutoff: { value: from ? from.alphaTest || 0 : 0 },
        uBaseColour: { value: factor },
        uEmissive: { value: emissive ? 1 : 0 },
        // Copied, not shared: ShaderMaterial clones the uniforms object it is
        // given, so a shared Vector2 would not survive anyway.
        uFrameBuffer: { value: frameBuffer.clone() },
      },
    });

    materials.push(material);
    return material;
  }

  /* One group per post. The group is what the animation loop moves and what
     the swap logic indexes, so its identity has to be stable; a model that
     finishes loading later swaps out the contents, never the group itself. */
  const objects = rows.map((row, i) => {
    const slug = row.dataset.slug || String(i);
    const tags = (row.dataset.tags || "").split(",").filter(Boolean);
    const { colours, shape } = lookFor(slug, tags);

    const group = new THREE.Group();
    group.visible = false;
    // Each object gets its own resting tilt and spin rate so the sequence
    // does not look like one object being recoloured.
    group.userData.spin = 0.16 + (hashString(slug) % 100) / 700;
    group.userData.tilt = ((hashString(slug + "t") % 100) / 100 - 0.5) * 0.5;
    group.userData.materials = [];
    group.rotation.x = group.userData.tilt;

    const texture = makeTexture(hashString(slug), shape);
    const material = makeMaterial(colours, texture);
    group.add(new THREE.Mesh(makeGeometry(shape), material));
    group.userData.materials.push(material);

    scene.add(group);

    /* A `model:` header replaces the primitive once the file arrives. The
       placeholder shows in the meantime, so a slow network costs nothing
       visible, and a failed load simply keeps it. */
    if (row.dataset.model) {
      loadModel(group, row.dataset.model, colours, texture);
    }

    return group;
  });

  /* Replaces a group's placeholder primitive with a Blender-authored model.

     The loader is imported dynamically so its ~165KB (GLTFLoader plus the two
     addons it needs) is only fetched once a post actually opts in; a site
     with no models pays nothing.

     glTF materials are discarded. The whole look lives in the PSX shader, and
     a MeshStandardMaterial dropped into this scene would render as a modern
     PBR object with none of the vertex snapping, affine warping or dithering
     everything else has. What is kept from the file is its base colour
     texture, which becomes uMap; so in Blender the material is really just
     "which texture". */
  async function loadModel(group, url, colours, placeholderTexture) {
    let model;
    try {
      const { GLTFLoader } = await import("/three-gltfloader.js");
      model = (await new GLTFLoader().loadAsync(url)).scene;
    } catch (err) {
      console.warn(`scene.js: could not load ${url}, keeping the placeholder`, err);
      return;
    }

    const swapped = [];
    model.traverse((child) => {
      if (!child.isMesh) return;

      /* Four ways a mesh can get its colour, in order of preference:
           1. its own base colour texture;
           2. an emissive texture, when there is no base colour one. Plugging a
              screen image into Emission is the natural thing to do in a PBR
              modeller — it is how the CocoVision's display is authored — and
              that slot would otherwise be invisible here. Such a material
              usually pairs the glow with a *black* base colour, since all its
              light is meant to come from emission, so reading it as the base
              texture is the only way it shows at all;
           3. a baseColorFactor with no texture (CAD exports, which often have
              no UVs either);
           4. none of the above: the procedural placeholder and the tag palette. */
      const own = child.material && child.material.map;
      const glow = !own && child.material ? child.material.emissiveMap : null;
      const flat = !own && !glow && isTinted(baseColourOf(child.material));
      const source = own || glow;
      const map = source || (flat ? whitePixel() : placeholderTexture);

      if (source) {
        // Match the procedural textures: point-sampled, no mips, and no colour
        // space so the GPU does not decode to linear behind the shader's back.
        source.magFilter = THREE.NearestFilter;
        source.minFilter = THREE.NearestFilter;
        source.generateMipmaps = false;
        source.colorSpace = THREE.NoColorSpace;
      }

      // Read before the dispose below: alphaTest and side are carried over.
      const from = child.material;
      // Per mesh, not per model: a textured mesh keeps its own colours, while
      // one that fell back to the procedural texture still needs the palette.
      const replacement = makeMaterial(
        source || flat ? MODEL_SHADING : colours,
        map,
        from,
        !!glow
      );
      if (from) from.dispose();
      child.material = replacement;
      swapped.push(child.material);
    });

    if (!swapped.length) {
      console.warn(`scene.js: ${url} has no meshes, keeping the placeholder`);
      return;
    }

    // Centre on the model's own bounds and scale to match the primitives.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z);

    if (largest > 0) {
      const scale = MODEL_SIZE / largest;
      model.scale.setScalar(scale);
      model.position.copy(centre).multiplyScalar(-scale);
    }

    // Only now the replacement is ready does the placeholder go.
    for (const child of group.children.slice()) {
      group.remove(child);
      if (!child.isMesh) continue;
      child.geometry.dispose();
      const at = materials.indexOf(child.material);
      if (at !== -1) materials.splice(at, 1);
      child.material.dispose();
    }

    group.add(model);
    group.userData.materials = swapped;

    // These materials were built after the last resize, so they have not been
    // told the framebuffer size yet.
    syncFrameBuffer();
    requestRedraw();
  }

  /* ---- sizing ---- */

  let viewW = 0;
  let viewH = 0;
  // Recomputed in resize() from what the camera can see; this is only the
  // value used if a frame somehow runs before the first successful measure.
  let slide = 7;

  /* The canvas is fixed to the whole viewport, so its own box is the most
     direct measurement; and unlike window.innerWidth it stays right when the
     page is embedded in a frame. Both fall back to the documentElement, and a
     zero result is treated as "not laid out yet" rather than trusted: an
     aspect of 0 silently produces a degenerate projection and a focus line at
     0, which leaves every row un-selected and nothing on screen. */
  function measure() {
    const rect = canvas.getBoundingClientRect();
    const docEl = document.documentElement;

    viewW =
      Math.round(rect.width) || docEl.clientWidth || window.innerWidth || 0;
    viewH =
      Math.round(rect.height) || docEl.clientHeight || window.innerHeight || 0;

    return viewW > 0 && viewH > 0;
  }

  function resize() {
    if (!measure()) return false;

    const aspect = viewW / viewH;

    /* The framebuffer's aspect has to match the canvas's CSS box exactly, or
       the upscale stretches the image. So when a very wide viewport pushes the
       width past the cap, height comes down to suit rather than staying at
       FB_HEIGHT; the picture gets chunkier, which is the intended look, but
       never distorted. */
    let fbHeight = FB_HEIGHT;
    let fbWidth = Math.round(fbHeight * aspect);

    if (fbWidth > FB_MAX_WIDTH) {
      fbWidth = FB_MAX_WIDTH;
      fbHeight = Math.max(Math.round(fbWidth / aspect), 1);
    }

    renderer.setSize(fbWidth, fbHeight, false);

    frameBuffer.set(fbWidth, fbHeight);
    syncFrameBuffer();

    camera.aspect = aspect;
    camera.updateProjectionMatrix();

    if (viewW >= WIDE_AT) {
      // The list is capped at 620px on the left, so pushing the camera left
      // puts the object in the empty right-hand half.
      cameraBase.set(-3.1, 0, 8);
    } else {
      // Too narrow to sit beside the copy; the object is behind it instead.
      // Raising the camera drops the object into the lower part of the row and
      // pulling back shrinks it, so it reads as a backdrop rather than
      // something the text has to compete with.
      cameraBase.set(0, 1.9, 11);
    }
    // The frame loop re-derives position from this every frame, adding the
    // tilt offset; this keeps a still page correctly framed before any frame
    // has run, and is the whole story when tilt is off.
    camera.position.copy(cameraBase);
    camera.updateMatrixWorld();

    /* How far off-centre an inactive object parks. Derived from what the
       camera can actually see rather than fixed, so on a narrow screen the
       object does not spend most of its transition outside the viewport (and
       then appear to pop in at the end). The margin clears the largest
       geometry radius so nothing is caught hanging off the edge at rest. */
    // cameraBase, not camera.position: the live position carries the tilt
    // offset, and the parking distance must not wobble with the phone.
    const halfHeight =
      Math.tan((camera.fov * Math.PI) / 360) * cameraBase.z;
    slide = halfHeight * aspect + 2.5;

    tiltAmount.set(
      halfHeight * aspect * TILT_FRACTION_X,
      halfHeight * TILT_FRACTION_Y
    );

    requestRedraw();

    return true;
  }

  /* ---- parallax input ----

     A nudge of the camera, so the object sits in the page rather than on it.
     Deliberately small and heavily smoothed: this is peripheral, and anything
     bigger reads as drift rather than depth.

     Two sources feed the same normalised target, and neither knows about the
     other: device tilt on a phone, pointer position on a desktop. Last writer
     wins, which is the right answer on the one device that has both — a
     touchscreen laptop follows whichever the reader is actually using.

     Cost is close to zero. The listener does nothing but store two numbers;
     all the work is one lerp per frame inside a loop that was already
     rendering every frame, so it adds no draw calls and no extra frames.

     Two things gate it, both verified against the spec rather than assumed:
       * It needs a secure context. On plain http (the LAN preview) the event
         simply never fires — nothing to handle, it just stays still.
       * iOS 13+ requires DeviceOrientationEvent.requestPermission(), and that
         needs transient activation, so it has to hang off a real tap. Hence
         the button in index.ejs, which is revealed only where it is needed.

     Skipped entirely under prefers-reduced-motion: tilt-linked movement is
     exactly what that setting is for, and that branch has no loop to drive it
     anyway. */

  const TILT_RANGE = 22; // degrees of tilt that reach full deflection

  /* Full deflection as a fraction of what the camera can see, not as fixed
     world units. The narrow layout pulls the camera back to z=11 but the
     viewport is far narrower, so its frustum is about a third the width of the
     desktop one — a fixed offset that reads as a nudge on a laptop swings the
     object a quarter of the way across a phone. */
  const TILT_FRACTION_X = 0.1;
  const TILT_FRACTION_Y = 0.07;

  // Both -1..1; scaled to world units per frame against the current frustum.
  const tilt = new THREE.Vector2(0, 0);
  const tiltTarget = new THREE.Vector2(0, 0);
  let tiltOrigin = null; // first reading becomes "level", whatever it was

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  function onOrientation(event) {
    const { beta, gamma } = event;
    if (beta === null || gamma === null) return;

    // Calibrate to however the device happened to be held, rather than
    // assuming it is flat on a table or upright in a hand.
    if (!tiltOrigin) tiltOrigin = { beta, gamma };

    let dx = clamp(gamma - tiltOrigin.gamma, -TILT_RANGE, TILT_RANGE) / TILT_RANGE;
    let dy = clamp(beta - tiltOrigin.beta, -TILT_RANGE, TILT_RANGE) / TILT_RANGE;

    /* beta/gamma are reported against the device, not the page. In landscape
       the two axes have effectively swapped, so the delta is rotated back by
       whatever the screen is rotated by. */
    const angle = (screen.orientation && screen.orientation.angle) || 0;
    if (angle) {
      const radians = (-angle * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      [dx, dy] = [dx * cos - dy * sin, dx * sin + dy * cos];
    }

    // Moving the camera right shifts the object left, which is the direction
    // that reads as looking around it.
    tiltTarget.set(dx, -dy);
  }

  function startTilt() {
    window.addEventListener("deviceorientation", onOrientation, true);
  }

  function setUpTilt() {
    if (reduceMotion || typeof window.DeviceOrientationEvent === "undefined") {
      return;
    }

    const needsPermission =
      typeof window.DeviceOrientationEvent.requestPermission === "function";

    if (!needsPermission) {
      // Android and desktop: the event fires unprompted (still only over
      // https). Nothing to ask for.
      startTilt();
      return;
    }

    const button = document.getElementById("tilt");
    if (!button) return;

    // button.hidden = false;
    button.addEventListener(
      "click",
      async () => {
        button.hidden = true;
        try {
          const granted = await window.DeviceOrientationEvent.requestPermission();
          if (granted === "granted") startTilt();
        } catch (err) {
          // Denied, or called without transient activation. Either way the
          // page is fine without it, so there is nothing to report.
        }
      },
      { once: true }
    );
  }

  /* The desktop half of the same idea: the cursor stands in for where the
     reader's head is, so moving right lets you see a little more of the
     object's right side. Same normalised target, so the smoothing, the
     frustum-relative scaling and the reduced-motion guard are all shared.

     `pointer: fine` keeps this off touch devices, where a pointermove only
     arrives mid-drag and would jerk the scene while the reader is scrolling.
     The handler is arithmetic and two assignments, so it does not need
     throttling — nothing here touches the DOM or forces layout. */
  function setUpPointer() {
    if (reduceMotion) return;
    if (!window.matchMedia || !window.matchMedia("(pointer: fine)").matches) {
      return;
    }

    window.addEventListener(
      "pointermove",
      (event) => {
        if (viewW === 0 || viewH === 0) return;
        tiltTarget.set(
          clamp((event.clientX / viewW) * 2 - 1, -1, 1),
          // Cursor high on the page reads as looking from above, so the
          // camera rises — which needs the sign flipped out of client space.
          -clamp((event.clientY / viewH) * 2 - 1, -1, 1)
        );
      },
      { passive: true }
    );

    // Drift back to centre when the cursor leaves, rather than holding the
    // last position until it happens to come back.
    document.addEventListener("pointerleave", () => tiltTarget.set(0, 0));
  }

  /* ---- which post owns the focus line ---- */

  let active = -1;
  let previous = -1;
  let swapAt = 0;
  let direction = 1;

  function pickActive() {
    const focus = viewH * FOCUS;
    let best = -1;
    let bestScore = Infinity;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= viewH) continue;

      let score = Math.abs((r.top + r.bottom) / 2 - focus);
      // A row straddling the focus line always wins outright.
      if (r.top <= focus && r.bottom >= focus) score -= 1e5;
      // The incumbent keeps a handicap, so a boundary parked exactly on the
      // line cannot flip back and forth every frame mid-transition.
      if (i === active) score -= 60;

      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  const list = rows[0].parentElement;

  function setActive(next, now) {
    if (next === active || next < 0) return;
    direction = next > active ? 1 : -1;
    previous = active;
    active = next;
    swapAt = now;

    /* The dimming of non-active rows is opt-in, switched on here rather than
       being the CSS default. If this function never runs; no JS, module
       blocked, WebGL unavailable, an exception on the way in; the list keeps
       full contrast instead of sitting permanently faded with nothing able to
       light it back up. Set on the first activation, so there is never a frame
       where everything is dim and no row is active. */
    list.classList.add("is-live");

    rows.forEach((row, i) => row.classList.toggle("is-active", i === active));
  }

  /* ---- frame ---- */

  /* Hand-rolled rather than THREE.Clock, which is deprecated in favour of
     THREE.Timer. Both are more than this needs, and doing it here makes the
     delta clamp below explicit. */
  let lastTime = performance.now() / 1000;
  let elapsed = 0;
  let running = true;
  let visible = true;

  function ease(t) {
    // easeOutCubic; quick departure, soft landing.
    return 1 - Math.pow(1 - t, 3);
  }

  function frame() {
    if (!running) return;
    window.requestAnimationFrame(frame);
    if (!visible) return;

    // Nothing has a usable size yet; fonts still blocking first layout, or
    // the tab was restored into a zero-size viewport. Keep asking rather than
    // rendering into a degenerate projection.
    if ((viewW === 0 || viewH === 0) && !resize()) return;

    const time = performance.now() / 1000;
    // Clamped so a stalled frame; a long paint, a background tab that was
    // not caught by visibilitychange; cannot jump the swap to its end state.
    const delta = Math.min(time - lastTime, 0.1);
    lastTime = time;
    elapsed += delta;
    const now = elapsed;

    setActive(pickActive(), now);

    /* Ease toward the latest reading. Framerate-independent: the same time
       constant whether the device is managing 60fps or 30. */
    const settle = 1 - Math.exp(-delta * 5);
    tilt.x += (tiltTarget.x - tilt.x) * settle;
    tilt.y += (tiltTarget.y - tilt.y) * settle;

    camera.position.set(
      cameraBase.x + tilt.x * tiltAmount.x,
      cameraBase.y + tilt.y * tiltAmount.y,
      cameraBase.z
    );
    camera.updateMatrixWorld();

    const t = SWAP_TIME > 0 ? Math.min((now - swapAt) / SWAP_TIME, 1) : 1;
    const eased = ease(t);

    for (let i = 0; i < objects.length; i++) {
      const group = objects[i];
      let x = null;
      let fade = 0;

      if (i === active) {
        // Arrives from the side the scroll came from.
        x = (1 - eased) * slide * direction;
        fade = eased;
      } else if (i === previous && t < 1) {
        // Leaves the opposite way, so the pair reads as one continuous move.
        x = -eased * slide * direction;
        fade = 1 - eased;
      }

      if (x === null) {
        group.visible = false;
        continue;
      }

      group.visible = true;
      group.position.x = x;
      // A slight arc, so the swap is not a flat slide.
      group.position.y = Math.sin((1 - fade) * Math.PI) * -0.7 + Math.sin(now * 0.7 + i) * 0.12;
      // A loaded model can be many meshes, so the fade is per-material.
      for (const material of group.userData.materials) {
        material.uniforms.uFade.value = fade;
      }

      if (!reduceMotion) {
        group.rotation.y += delta * group.userData.spin;
        group.rotation.x = group.userData.tilt + Math.sin(now * 0.4 + i) * 0.06;
      }
    }

    renderer.render(scene, camera);
  }

  /* ---- lifecycle ---- */

  function onVisibility() {
    visible = document.visibilityState !== "hidden";
    // Rebase the clock on the way back in, so the first frame after a tab
    // switch does not bill the whole time away to a single delta.
    if (visible) lastTime = performance.now() / 1000;
  }

  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", onVisibility, false);

  // A window resize event does not fire for every way this canvas can change
  // size; a scrollbar appearing, or the page being embedded and its container
  // resized. Observing the element itself covers those.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => resize()).observe(document.documentElement);
  }

  resize();
  setUpTilt();
  setUpPointer();

  if (reduceMotion) {
    /* One settled frame per state change instead of a loop. Sizing can still
       be unavailable on the first pass, so this retries on rAF until the
       viewport measures, then draws once. */
    /* Guards the one re-entrant path: when sizing is not ready this calls
       resize(), which on success calls straight back in through requestRedraw.
       The inner call returns immediately and the outer one does the drawing. */
    let drawing = false;

    const drawStatic = () => {
      if (drawing) return;
      drawing = true;
      try {
        drawStaticInner();
      } finally {
        drawing = false;
      }
    };

    const drawStaticInner = () => {
      if ((viewW === 0 || viewH === 0) && !resize()) {
        window.requestAnimationFrame(drawStatic);
        return;
      }

      const next = Math.max(pickActive(), 0);
      active = next;
      swapAt = -SWAP_TIME;
      list.classList.add("is-live");
      rows.forEach((row, i) => row.classList.toggle("is-active", i === next));
      objects.forEach((group, i) => {
        group.visible = i === next;
        group.position.set(0, 0, 0);
        for (const material of group.userData.materials) {
          material.uniforms.uFade.value = i === next ? 1 : 0;
        }
      });
      renderer.render(scene, camera);
    };

    // Every resize discards the drawing buffer and there is no loop to refill
    // it, and a model can arrive long after the one draw; both need a nudge.
    requestRedraw = drawStatic;

    drawStatic();

    // Still tracks the list on scroll, just without animating between states.
    let queued = false;
    window.addEventListener(
      "scroll",
      () => {
        if (queued) return;
        queued = true;
        window.requestAnimationFrame(() => {
          queued = false;
          const next = pickActive();
          if (next >= 0 && next !== active) drawStatic();
        });
      },
      { passive: true }
    );
    return;
  }

  frame();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
