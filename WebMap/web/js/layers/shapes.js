// Trees, Buildings and World structures drawn on the GPU (WebGL2), all in one canvas.
//
// The canvas-per-tile layers drew every crown and wall piece again for each tile at each zoom,
// on the main thread, right when the zoom animation needed it: that was most of the stutter.
// Here every shape is uploaded once per chunk as a few numbers (instanced quads) and a redraw is
// one cheap draw call per chunk, so the view can be redrawn on every frame of a drag. The canvas
// covers the screen plus half a screen on each side, so a zoom-out by one step is already drawn,
// and Leaflet CSS-scales it during zoom animations like its own vector renderer.
//
// Same looks as the canvas layers they replace (veg.js, structures.js, ruins.js), which stay as
// the fallback for browsers without WebGL2.

import { WORLD_HALF, chunkOf, metersPerPixel } from '../crs.js';
import { chunks, vegetation } from '../data.js';
import { materialColors, materialNames } from '../icons.js';
import { ruins } from './ruins.js';
import { TREE_STRIDE } from '../vegpack.js';
import { layerState } from '../layerstate.js';

export function webgl2Available() {
  if (/[?&]gl=0\b/.test(location.search)) return false;   // ?gl=0 forces the old canvas layers (testing)
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

const FADE_MS = 250;             // new chunks and layers crossing their zoom limit fade in over this
const PAD = 0.75;                // canvas reaches 3/4 of a screen past each edge: covers a one-notch wheel zoom-out (~1.25 levels)
export const TREES_MIN = 4.5;   // trees are drawn from tile zoom 5 up, like the baked tree tiles were
const BUILDINGS_MIN_ZOOM = 2, DETAIL_ZOOM = 5;

// ---------------------------------------------------------------- GL helpers

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

// shared vertex code: world metres (x, z) to clip space for the current canvas
const VIEW_GLSL = `
uniform vec4 u_view;   // originX, originZ (top-left of the canvas, metres), pixels per metre, unused
uniform vec2 u_css;    // canvas size in CSS pixels
vec2 toPx(vec2 w) { return vec2((w.x - u_view.x) * u_view.z, (u_view.y - w.y) * u_view.z); }
vec4 toClip(vec2 px) { return vec4(px.x / u_css.x * 2.0 - 1.0, 1.0 - px.y / u_css.y * 2.0, 0.0, 1.0); }
`;

// ---------------------------------------------------------------- rectangles (buildings, ruins)

const RECT_VS = `#version 300 es
in vec2 a_corner;                 // -0.5 .. 0.5
in vec2 a_center; in vec2 a_size; in float a_yaw; in float a_h; in vec4 a_color;
uniform float u_dotPx;            // > 0: zoomed out, a fixed square of this half-size, no rotation
uniform float u_minPx;
out vec2 v_local; out vec2 v_half; out vec4 v_color; out float v_h;
${VIEW_GLSL}
void main() {
  vec2 c = toPx(a_center);
  vec2 sz = u_dotPx > 0.0 ? vec2(u_dotPx * 2.0) : max(a_size * u_view.z, vec2(u_minPx));
  vec2 l = a_corner * (sz + 2.0);                       // one spare pixel all round for the soft edge
  float r = u_dotPx > 0.0 ? 0.0 : radians(a_yaw), cs = cos(r), sn = sin(r);   // canvas convention: +yaw turns clockwise on screen
  vec2 p = c + vec2(l.x * cs - l.y * sn, l.x * sn + l.y * cs);
  v_local = l; v_half = sz * 0.5; v_color = a_color; v_h = a_h;
  gl_Position = toClip(p);
}`;

const RECT_FS = `#version 300 es
precision mediump float;
in vec2 v_local; in vec2 v_half; in vec4 v_color; in float v_h;
uniform float u_alpha;
uniform float u_fade;             // fading in (new chunk, layer appearing)
uniform int u_edge;               // 0 none, 1 Buildings close up (dark outline, lighter roofs), 2 ruins (light edge)
uniform float u_edgeK;            // how far in that look is (it eases in over a zoom range, no jump)
out vec4 o;
void main() {
  vec3 col = v_color.rgb;
  float edge = min(v_half.x - abs(v_local.x), v_half.y - abs(v_local.y));   // pixels inside the border
  float cover = clamp(edge + 0.5, 0.0, 1.0);                                  // antialiased edge, no MSAA needed
  if (cover <= 0.0) discard;
  // outlines ease in as a piece grows on screen, instead of switching on at a size: a hard
  // threshold flipped thousands of pieces at once at some zooms and the colour jumped
  float big = max(v_half.x, v_half.y);
  if (u_edge == 1) {
    float k = u_edgeK * smoothstep(1.5, 3.0, big);
    if (v_h >= 1.5 && v_local.y < 0.0) col = mix(col, vec3(1.0), 0.12 * k);
    if (edge < 1.0) col = mix(col, vec3(0.0), 0.45 * k);
  } else if (u_edge == 2) {
    float k = u_edgeK * smoothstep(1.0, 2.5, big);
    if (edge < 1.15) col = mix(col, vec3(0.91, 0.863, 0.769), 0.75 * k);
  }
  float a = u_alpha * cover * u_fade;
  o = vec4(col * a, a);
}`;

// ---------------------------------------------------------------- tree crowns and boulders

const TREE_VS = `#version 300 es
in vec2 a_corner;
in vec2 a_center; in float a_r; in float a_seed; in vec4 a_color;   // a_color.a: flags (vegpack.js): rock 1, wet 2, group << 2
uniform int u_show;                                                  // groups shown, a bit each (trees 1, bushes 2, rocks 4)
out vec2 v_l; out float v_r; out float v_sh; out vec3 v_color; out float v_rock; out float v_seed; out float v_wet;
${VIEW_GLSL}
out float v_cover;
void main() {
  float r0 = a_r * u_view.z;
  float r = max(r0, 0.8);                              // zoomed out a crown is under a pixel: draw a dot...
  v_cover = min(1.0, (r0 * r0) / (r * r));             // ...as faint as the crown's real area
  float sh = min(r0 * 0.35, 3.0 * u_view.z);         // shadow offset to the south-east
  float half_ = r + sh * 0.5 + 1.0;
  vec2 l = vec2(sh * 0.5) + a_corner * 2.0 * half_;   // relative to the crown centre
  int fl = int(a_color.a * 255.0 + 0.5);
  if (((u_show >> (fl >> 2)) & 1) == 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // a hidden group: off screen, nothing drawn
  v_rock = float(fl & 1); v_wet = float((fl >> 1) & 1);
  // each tree a shade lighter or darker than its neighbours, so a forest isn't one flat green
  float jit = v_rock > 0.5 ? 0.0 : (fract(sin(a_seed * 12.9898 + a_center.x * 0.37) * 43758.5453) - 0.5) * 0.18;
  v_l = l; v_r = r; v_sh = sh; v_color = a_color.rgb * (1.0 + jit); v_seed = a_seed;
  gl_Position = toClip(toPx(a_center) + l);
}`;

const TREE_FS = `#version 300 es
precision mediump float;
in vec2 v_l; in float v_r; in float v_sh; in vec3 v_color; in float v_rock; in float v_seed; in float v_cover; in float v_wet;
uniform float u_fade;
out vec4 o;
void main() {
  float r = v_r;
  float aS = 0.24 * (1.0 - smoothstep(0.95 * r - 0.5, 0.95 * r + 0.5, length(v_l - vec2(v_sh))));
  bool rock = v_rock > 0.5;
  float aC = (rock ? 0.95 : 0.92) * (1.0 - smoothstep(r - 0.5, r + 0.5, length(v_l)));
  if (aS + aC <= 0.0) discard;
  // lit from the north-west, darker toward the south-east rim (the canvas radial gradient)
  float t = clamp((length(v_l + vec2(0.4 * r)) - 0.1 * r) / (1.25 * r), 0.0, 1.0);
  float hi = rock ? 0.35 : 0.55;
  float k = t < 0.6 ? mix(1.0 + hi * 0.8, 1.0, t / 0.6) : mix(1.0, 0.7 - hi * 0.2, (t - 0.6) / 0.4);
  vec3 col = min(v_color * k, vec3(1.0));
  if (!rock && r > 6.0) {   // a few darker lobes so a big crown reads as foliage, not a coin
    for (int i = 0; i < 3; i++) {
      float a = v_seed + float(i) * 2.1;
      if (length(v_l - vec2(cos(a), sin(a)) * 0.45 * r) < 0.38 * r) col = mix(col, v_color * 0.6, 0.18);
    }
  }
  // in shallow water: faded into the sea, and no shadow
  if (v_wet > 0.5) { col = mix(col, vec3(0.2, 0.35, 0.45), 0.35); aC *= 0.5; aS = 0.0; }
  float f = v_cover * u_fade;
  o = vec4(col * aC * f, (aC + aS * (1.0 - aC)) * f);   // crown over its own shadow, premultiplied
}`;

// ---------------------------------------------------------------- the shared canvas

// a textured rectangle in world metres: map tiles and the fog (layers/ground.js)
const TEX_VS = `#version 300 es
in vec2 a_corner;
uniform vec4 u_rect;   // minX, maxZ, width, height (metres)
uniform vec4 u_uv;     // u0, v0, u1, v1
out vec2 v_uv;
${VIEW_GLSL}
void main() {
  vec2 t = a_corner + 0.5;
  v_uv = mix(u_uv.xy, u_uv.zw, t);
  gl_Position = toClip(toPx(vec2(u_rect.x + t.x * u_rect.z, u_rect.y - t.y * u_rect.w)));
}`;
const TEX_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * u_alpha; }`;

// Soft dark clouds in world space past the world's edge, like the seed maps' surround (generated
// here, nothing to download); darker toward the rim. Inside the circle the fog stays plain black.
const CLOUDS_GLSL = `
float hash2(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return s;
}
vec3 clouds(vec2 w) {
  float big = fbm(w / 2600.0), fine = fbm(w / 650.0 + 3.1);
  float v = smoothstep(0.32, 0.78, big * 0.7 + fine * 0.3);
  vec3 c = mix(vec3(0.045, 0.055, 0.070), vec3(0.330, 0.360, 0.410), v);
  return c * mix(1.0, 0.8, smoothstep(0.55, 1.05, length(w) / 10000.0));   // vignette toward the rim
}`;

// past the world's edge (layers/ground.js WorldEdgeGL)
const EDGE_VS = `#version 300 es
in vec2 a_corner;
uniform vec4 u_rect;
out vec2 v_w;
${VIEW_GLSL}
void main() {
  vec2 t = a_corner + 0.5;
  v_w = vec2(u_rect.x + t.x * u_rect.z, u_rect.y - t.y * u_rect.w);
  gl_Position = toClip(toPx(v_w));
}`;
// The clouds don't move, so they are worked out once into a texture (CLOUD_BAKE_FS, ShapesCanvas
// .cloudTexture) covering CLOUD_EXTENT metres each way, and the edge just samples it: computing
// the noise per pixel each frame was the map's heaviest work once zoomed out past ~4.3 (the padded
// canvas reaching past the rim), most of all on high-DPI screens.
export const CLOUD_EXTENT = 36000, CLOUD_RES = 2048;
const CLOUD_BAKE_VS = `#version 300 es
in vec2 a_corner;
out vec2 v_w;
uniform float u_extent;
void main() { v_w = a_corner * 2.0 * u_extent; gl_Position = vec4(a_corner * 2.0, 0.0, 1.0); }`;
const CLOUD_BAKE_FS = `#version 300 es
precision highp float;
in vec2 v_w;
out vec4 o;
${CLOUDS_GLSL}
void main() { o = vec4(clouds(v_w), 1.0); }`;
const EDGE_MAIN = `
void main() {
  float d = length(v_w);
  float a = smoothstep(u_radius - u_mpp, u_radius + u_mpp, d);
  if (a <= 0.0) discard;
  // a thin soft ring just outside the edge, so the round world reads as the world's rim
  float ring = (1.0 - smoothstep(0.6 * u_mpp, 1.8 * u_mpp, abs(d - u_radius - 1.5 * u_mpp))) * 0.7;
  vec3 c = mix(clouds(v_w), u_ring, ring);
  o = vec4(c * a, a);
}`;
const EDGE_HEAD = `#version 300 es
precision highp float;
in vec2 v_w;
uniform float u_radius, u_mpp;   // world radius, metres per pixel (for a 1 px soft edge)
uniform vec3 u_ring;
out vec4 o;
`;
// sampling the baked clouds, or (if the browser couldn't bake them) working them out per pixel
const EDGE_FS = EDGE_HEAD + `uniform sampler2D u_clouds;
uniform float u_extent;
vec3 clouds(vec2 w) { return texture(u_clouds, w / (2.0 * u_extent) + 0.5).rgb; }` + EDGE_MAIN;
const EDGE_LIVE_FS = EDGE_HEAD + CLOUDS_GLSL + EDGE_MAIN;

// The 256 m chunk grid and the distance rings around the spawn, worked out per pixel over the
// whole canvas (layers/ground.js GuideGL): no geometry to rebuild as the zoom changes, so they cost
// the same at any zoom. Lines are a set width in pixels, anti-aliased.
const GUIDE_FS = `#version 300 es
precision highp float;
in vec2 v_w;
uniform float u_mpp, u_radius;
uniform float u_grid, u_rings;   // 0 or 1
uniform vec2 u_spawn;
uniform vec3 u_ringColor;
out vec4 o;
float line(float dPx, float w) { return 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, dPx); }
void main() {
  if (length(v_w) > u_radius) discard;
  float a = 0.0; vec3 c = vec3(1.0);
  if (u_grid > 0.5) {
    float px = 256.0 / u_mpp;                         // a chunk in pixels: the grid fades out as it gets dense
    float show = smoothstep(6.0, 16.0, px);
    vec2 d = abs(fract(v_w / 256.0 + 0.5) - 0.5) * 256.0 / u_mpp;
    a = max(a, line(min(d.x, d.y), 1.0) * 0.22 * show);
  }
  if (u_rings > 0.5) {
    vec2 rel = v_w - u_spawn;
    float r = length(rel);
    if (r > 250.0 && r < 6250.0) {
      float k = floor((r + 250.0) / 500.0);            // nearest ring, every 500 m
      float d = abs(r - k * 500.0) / u_mpp;
      bool km = mod(k, 2.0) < 0.5;
      float on = 1.0;
      if (!km) {                                       // half-km rings dashed: 4 px on, 6 off along the ring
        float s = (atan(rel.y, rel.x) + 3.14159265) * k * 500.0 / u_mpp;
        on = step(mod(s, 10.0), 4.0);
      }
      float ra = line(d, km ? 1.4 : 0.9) * (km ? 0.75 : 0.45) * on;
      if (ra > 0.0) { c = mix(c, u_ringColor, ra / max(ra, a + 1e-4)); a = max(a, ra); }
    }
  }
  if (a <= 0.003) discard;
  o = vec4(c * a, a);
}`;

// a dashed line between two world points, a set width in pixels (portal lines, layers/markercanvas.js)
const LINE_VS = `#version 300 es
in vec2 a_corner;
uniform vec2 u_a, u_b;
uniform float u_width;
out float v_d; out float v_n;
${VIEW_GLSL}
void main() {
  vec2 pa = toPx(u_a), pb = toPx(u_b), d = pb - pa;
  float len = max(length(d), 0.001);
  vec2 dir = d / len, n = vec2(-dir.y, dir.x);
  float t = a_corner.x + 0.5, side = a_corner.y * 2.0 * (u_width * 0.5 + 1.0);
  v_d = t * len; v_n = side;
  gl_Position = toClip(pa + d * t + n * side);
}`;
// The dashes are laid out in metres along the line, not screen pixels, so they stay on the same
// spots of the map while it zooms (a pixel pattern slid along the line). Each zoom level has its
// own dash length, and the next level's fades in as the dashes grow, so on screen they stay
// about u_on / u_off pixels long.
const LINE_FS = `#version 300 es
precision highp float;   // u_width is shared with the vertex shader: precisions must match
in float v_d; in float v_n;
uniform float u_width, u_on, u_off, u_alpha, u_zoom, u_ppm;
uniform vec3 u_color;
out vec4 o;
float dashAt(float metres, float level) {
  float mpp = exp2(7.0 - level);                      // metres per pixel at that zoom
  float period = (u_on + u_off) * mpp;
  return mod(metres, period) < u_on * mpp ? 1.0 : 0.0;
}
void main() {
  float a = u_alpha * clamp(u_width * 0.5 + 0.5 - abs(v_n), 0.0, 1.0);
  if (u_off > 0.0) {
    float m = v_d / u_ppm, lv = floor(u_zoom), f = fract(u_zoom);
    a *= mix(dashAt(m, lv), dashAt(m, lv + 1.0), smoothstep(0.35, 0.95, f));
  }
  if (a <= 0.0) discard;
  o = vec4(u_color * a, a);
}`;

// the part of a padded view that is the screen itself
export function screenArea(v) {
  const px = (v.x1 - v.x) * PAD / (1 + 2 * PAD), pz = (v.z - v.z0) * PAD / (1 + 2 * PAD);
  return { x: v.x + px, x1: v.x1 - px, z: v.z - pz, z0: v.z0 + pz, zoom: v.zoom };
}

export class ShapesCanvas {
  static for(map) { return map._shapesCanvas || (map._shapesCanvas = new ShapesCanvas(map)); }

  constructor(map) {
    this.map = map;
    this.sets = [];
    const pane = map.getPane('shapesPane') || map.createPane('shapesPane');
    pane.style.zIndex = 245;            // over the tiles, under the fog (overlayPane)
    pane.style.pointerEvents = 'none';
    this.canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated', pane);
    this.canvas.style.position = 'absolute';
    // edges are smoothed in the shaders, so no multisampling: a quarter of the GPU work per frame
    const gl = this.gl = this.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    this.rect = compile(gl, RECT_VS, RECT_FS);
    this.tree = compile(gl, TREE_VS, TREE_FS);
    this.tex = compile(gl, TEX_VS, TEX_FS);
    this.edge = compile(gl, EDGE_VS, EDGE_FS);
    this.edgeLive = compile(gl, EDGE_VS, EDGE_LIVE_FS);
    try { this.cloudBake = compile(gl, CLOUD_BAKE_VS, CLOUD_BAKE_FS); } catch (e) { this.cloudBake = null; }
    this.guide = compile(gl, EDGE_VS, GUIDE_FS);
    this.line = compile(gl, LINE_VS, LINE_FS);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const lc = gl.getAttribLocation(this.tex.p, 'a_corner');
    gl.enableVertexAttribArray(lc);
    gl.vertexAttribPointer(lc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.frame = 0;
    map.on('zoomanim', this.onZoomAnim, this);
    map.on('zoom', this.onZoom, this);
    map.on('move', this.onMove, this);
    map.on('moveend zoomend viewreset resize', this.reset, this);
  }

  add(set) { if (!this.sets.includes(set)) { this.sets.push(set); this.sets.sort((a, b) => a.order - b.order); } this.reset(); }
  remove(set) { this.sets = this.sets.filter((s) => s !== set); this.redraw(); }

  // the layout Leaflet's own L.Renderer uses: a canvas centred on the view, padded
  reset() {
    const map = this.map;
    if (map._animatingZoom) return;
    this.zoomDirty = false;
    const size = map.getSize(), pad = size.multiplyBy(PAD).round();
    const min = map.containerPointToLayerPoint(pad.multiplyBy(-1)).round();
    const w = size.x + pad.x * 2, h = size.y + pad.y * 2;
    this.center = map.getCenter(); this.zoom = map.getZoom();
    this.min = min;
    L.DomUtil.setPosition(this.canvas, min);
    // screen resolution (at least 1x so it stays sharp), at most 2x, and at most ~16 million pixels
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16e6 / (w * h))));
    if (this.cssW !== w || this.cssH !== h || this.dpr !== dpr) {
      this.cssW = w; this.cssH = h; this.dpr = dpr;
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    }
    const tl = map.layerPointToLatLng(min);
    const ppm = 1 / metersPerPixel(this.zoom);
    this.view = { x: tl.lng, z: tl.lat, ppm, zoom: this.zoom, x1: tl.lng + w / ppm, z0: tl.lat - h / ppm };
    for (const s of this.sets) s.need(this.view, this);
    this.draw();
  }

  // A drag moves the canvas with the map pane, so nothing needs drawing until the screen gets
  // within a quarter of the padding of the canvas edge; then re-centre (once per frame at most).
  onMove() {
    if (this.map._animatingZoom || this.moveQueued || !this.min) return;
    const tl = this.map.containerPointToLayerPoint([0, 0]).subtract(this.min);
    const size = this.map.getSize(), slack = size.multiplyBy(PAD * 0.25);
    if (tl.x > slack.x && tl.y > slack.y && tl.x + size.x < this.cssW - slack.x && tl.y + size.y < this.cssH - slack.y) return;
    this.moveQueued = true;
    requestAnimationFrame(() => { this.moveQueued = false; this.reset(); });
  }

  onZoomAnim(e) {
    // If the canvas was just moved (a reset at the end of a drag) in this same frame, the browser
    // would start the zoom's CSS transition from where it was before that move, and the shapes
    // would glide in from the wrong place. Reading the style makes it take the move first.
    void getComputedStyle(this.canvas).transform;
    this.updateTransform(e.center, e.zoom);
  }
  // A zoom without Leaflet's animation (the smooth zoom, a pinch): keep the old picture lined up
  // right away, and redraw it sharp at the new zoom next frame (the smooth zoom already redraws in
  // its own frame, which clears this).
  onZoom() {
    if (this.map._animatingZoom) return;
    this.updateTransform(this.map.getCenter(), this.map.getZoom());
    this.zoomDirty = true;
    if (!this.zoomQueued) {
      this.zoomQueued = true;
      requestAnimationFrame(() => { this.zoomQueued = false; if (this.zoomDirty) this.reset(); });
    }
  }
  updateTransform(center, zoom) {
    if (!this.center) return;
    const map = this.map;
    const scale = map.getZoomScale(zoom, this.zoom);
    const half = map.getSize().multiplyBy(0.5 + PAD);
    const off = half.multiplyBy(-scale).add(map.project(this.center, zoom)).subtract(map._getNewPixelOrigin(center, zoom));
    L.DomUtil.setTransform(this.canvas, off, scale);
  }

  redraw() { if (!this.drawQueued) { this.drawQueued = true; requestAnimationFrame(() => { this.drawQueued = false; this.draw(); }); } }

  // During a smooth zoom every frame is redrawn anyway, so only the part of the canvas on screen
  // is painted (a scissor) and the sets skip what is off screen (this.onScreen): the padding is
  // 5/6 of the canvas and only matters for a drag, which doesn't redraw. The whole canvas is drawn
  // again as soon as the zoom ends (smoothzoom.js).
  draw() {
    const gl = this.gl, v = this.view;
    if (!v) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.onScreen = !!this.map._gliding;
    if (this.onScreen) {
      const size = this.map.getSize(), d = this.dpr;
      const px = (this.cssW - size.x) / 2, py = (this.cssH - size.y) / 2;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.floor(px * d), Math.floor(this.canvas.height - (py + size.y) * d), Math.ceil(size.x * d) + 1, Math.ceil(size.y * d) + 1);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const s of this.sets) s.draw(gl, v, this);
    if (this.onScreen) gl.disable(gl.SCISSOR_TEST);
  }

  // instanced attributes: [name, size, type, normalized] laid out in this order in one buffer
  makeVao(prog, buffer, layout, stride) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const lc = gl.getAttribLocation(prog.p, 'a_corner');
    gl.enableVertexAttribArray(lc);
    gl.vertexAttribPointer(lc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    let off = 0;
    for (const [name, size, type, norm] of layout) {
      const loc = gl.getAttribLocation(prog.p, name);
      const bytes = type === gl.FLOAT ? 4 : 1;
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, type, norm, stride, off);
        gl.vertexAttribDivisor(loc, 1);
      }
      off += size * bytes;
    }
    gl.bindVertexArray(null);
    return vao;
  }

  // the clouds past the world's edge, made once (see CLOUD_BAKE_FS); null if this browser can't
  // render into the texture (WorldEdgeGL then works them out per pixel, as before)
  cloudTexture() {
    if (this.clouds !== undefined) return this.clouds;
    if (!this.cloudBake) return (this.clouds = null);
    const gl = this.gl, t = gl.createTexture();
    for (let u = 0; u < 4; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, CLOUD_RES, CLOUD_RES);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.bindTexture(gl.TEXTURE_2D, null);   // not bound while drawn into
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(t);
      return (this.clouds = null);
    }
    gl.viewport(0, 0, CLOUD_RES, CLOUD_RES);
    gl.disable(gl.BLEND);
    gl.useProgram(this.cloudBake.p);
    gl.uniform1f(this.cloudBake.u.u_extent, CLOUD_EXTENT);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(t); return (this.clouds = null); }
    return (this.clouds = t);
  }

  setView(prog) {
    const gl = this.gl, v = this.view;
    gl.useProgram(prog.p);
    gl.uniform4f(prog.u.u_view, v.x, v.z, v.ppm, 0);
    gl.uniform2f(prog.u.u_css, this.cssW, this.cssH);
  }
}

// ---------------------------------------------------------------- a set of per-chunk shapes

// One GPU buffer per 256 m chunk, filled when the chunk's data arrives. Subclasses say which
// chunks they need, how to fetch one, and how to pack it.
class ChunkShapes extends L.Layer {
  constructor() {
    super();
    this.gpu = new Map();       // "cx_cz" -> {vao, buf, count, rev} or {pending: true}
    this.loading = 0;
  }
  onAdd(map) { this.sc = ShapesCanvas.for(map); this.sc.add(this); }
  onRemove() { if (this.sc) this.sc.remove(this); }

  needArea(v) { return v; }

  // chunks overlapping the canvas, with a margin for shapes that reach over a chunk edge
  chunksIn(v, margin) {
    const out = [];
    const x0 = Math.max(0, chunkOf(v.x - margin)), x1 = Math.min(79, chunkOf(v.x1 + margin));
    const z0 = Math.max(0, chunkOf(v.z0 - margin)), z1 = Math.min(79, chunkOf(v.z + margin));
    for (let cz = z1; cz >= z0; cz--) for (let cx = x0; cx <= x1; cx++) out.push([cx, cz]);   // north first
    return out;
  }

  // fetch what the canvas covers (screen + padding: the next zoom-out is already loaded)
  need(v) {
    if (!this.fetchesAt(v.zoom)) return;
    for (const [cx, cz] of this.chunksIn(this.needArea(v), 16)) {
      if (!this.has(cx, cz)) continue;
      const k = `${cx}_${cz}`, g = this.gpu.get(k), rev = this.rev(cx, cz);
      if (g && (g.pending || g.rev === rev)) continue;
      this.gpu.set(k, Object.assign(g || {}, { pending: true }));
      this.loading++;
      Promise.resolve(this.fetch(cx, cz)).then((data) => this.upload(k, data, rev)).catch(() => this.gpu.delete(k))
        .finally(() => { this.loading--; if (this.sc) this.sc.redraw(); if (this.loading === 0) this.fire('load'); });
    }
    if (this.loading === 0) this.fire('load');   // nothing to wait for: tell the tree hand-off (app.js)
  }

  upload(k, data, rev) {
    const sc = this.sc;
    if (!sc) { this.gpu.delete(k); return; }
    const gl = sc.gl;
    const packed = this.pack(data);
    const old = this.gpu.get(k);
    if (old && old.buf) { gl.deleteBuffer(old.buf); gl.deleteVertexArray(old.vao); }
    if (!packed || packed.count === 0) { this.gpu.set(k, { rev, count: 0 }); return; }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, packed.bytes, gl.STATIC_DRAW);
    // a chunk seen for the first time fades in; one replaced by newer data just swaps
    const born = old && old.count ? 0 : performance.now();
    const g = { rev, count: packed.count, buf, born, vao: sc.makeVao(this.program(sc), buf, this.layout(gl), this.stride) };
    this.gpu.set(k, g);
  }

  // Chunk data changed on the server: the next reset fetches what changed, and the old shapes stay
  // drawn until the new ones arrive (no blink). Only chunks gone from the index are dropped.
  refresh() {
    for (const [k, g] of this.gpu) {
      const [cx, cz] = k.split('_').map(Number);
      if (!g.pending && !this.has(cx, cz)) {
        if (g.buf && this.sc) { this.sc.gl.deleteBuffer(g.buf); this.sc.gl.deleteVertexArray(g.vao); }
        this.gpu.delete(k);
      }
    }
    if (this.sc) this.sc.reset();
  }

  // How visible the whole layer is: eases toward 1 when it should show at this zoom and toward 0
  // when not, over FADE_MS, so crossing a layer's zoom limit fades instead of switching.
  layerFade(v) {
    const now = performance.now(), target = this.visibleAt(v.zoom);
    const dt = this.fadeAt ? Math.min(now - this.fadeAt, 50) : FADE_MS;   // after a quiet spell, start the fade now rather than jump
    this.fadeAt = now;
    const cur = this.shown === undefined ? target : this.shown;
    const step = dt / FADE_MS;
    this.shown = cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
    if (this.shown !== target && this.sc) this.sc.redraw();
    return this.shown;
  }

  drawChunks(gl, v, margin, prog, fade = 1) {
    if (this.sc && this.sc.onScreen && v === this.sc.view) v = screenArea(v);   // mid-zoom: only what is on screen
    const now = performance.now();
    let fading = false;
    for (const [cx, cz] of this.chunksIn(v, margin)) {
      const g = this.gpu.get(`${cx}_${cz}`);
      if (!g || !g.count) continue;
      const f = g.born ? Math.min(1, (now - g.born) / FADE_MS) : 1;
      if (f < 1) fading = true;
      gl.uniform1f(prog.u.u_fade, f * fade);
      gl.bindVertexArray(g.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.count);
    }
    gl.bindVertexArray(null);
    if (fading && this.sc) this.sc.redraw();
  }
}

// ---------------------------------------------------------------- the three layers

const RECT_LAYOUT = (gl) => [['a_center', 2, gl.FLOAT, false], ['a_size', 2, gl.FLOAT, false], ['a_yaw', 1, gl.FLOAT, false], ['a_h', 1, gl.FLOAT, false], ['a_color', 4, gl.UNSIGNED_BYTE, true]];
const RECT_STRIDE = 28;

function packRects(pieces, colorOf) {
  const n = pieces.length;
  const bytes = new ArrayBuffer(n * RECT_STRIDE), f = new Float32Array(bytes), u = new Uint8Array(bytes);
  for (let i = 0; i < n; i++) {
    const [x, z, , yaw, sx, sz, h, mat] = pieces[i];
    const o = i * 7;
    f[o] = x; f[o + 1] = z; f[o + 2] = sx; f[o + 3] = sz; f[o + 4] = yaw; f[o + 5] = h;
    const [r, g, b] = colorOf(mat);
    u[o * 4 + 24] = r; u[o * 4 + 25] = g; u[o * 4 + 26] = b; u[o * 4 + 27] = 255;
  }
  return { bytes, count: n };
}

const matRgb = new Map();
const materialRgb = (mat) => {
  if (!matRgb.has(mat)) matRgb.set(mat, hexRgb(materialColors[mat] || '#a07446'));
  return matRgb.get(mat);
};

export class BuildingsGL extends ChunkShapes {
  constructor() {
    super();
    this.order = 3; this.opacity = 0.95; this.stride = RECT_STRIDE;
    chunks.onChange(() => this.refresh());
  }
  fetchesAt(zoom) { return zoom >= BUILDINGS_MIN_ZOOM - 1; }   // a step early, so zooming in finds it ready
  has(cx, cz) { return chunks.has(cx, cz); }
  rev(cx, cz) { const e = chunks.index.get(`${cx}_${cz}`); return e ? e.rev : 0; }
  fetch(cx, cz) { return chunks.get(cx, cz); }
  pack(data) { return packRects(data.pieces, materialRgb); }
  program(sc) { return sc.rect; }
  layout(gl) { return RECT_LAYOUT(gl); }
  visibleAt(zoom) { return zoom >= BUILDINGS_MIN_ZOOM - 0.5 ? 1 : 0; }
  draw(gl, v, sc) {
    const fade = this.layerFade(v);
    if (fade <= 0) return;
    const p = sc.rect, tz = Math.round(v.zoom);   // switch looks at the same zooms the tiles did
    sc.setView(p);
    gl.uniform1f(p.u.u_dotPx, tz >= DETAIL_ZOOM ? 0 : tz >= 4 ? 1.2 : 0.9);
    gl.uniform1f(p.u.u_minPx, 1.2);
    gl.uniform1f(p.u.u_alpha, this.opacity);
    gl.uniform1i(p.u.u_edge, 1);
    gl.uniform1f(p.u.u_edgeK, Math.min(1, Math.max(0, (v.zoom - 6.25) / 0.75)));   // outlines and roofs ease in from 6.25 to 7
    this.drawChunks(gl, v, 16, p, fade);
  }
  setOpacity(o) { this.opacity = o; if (this.sc) this.sc.redraw(); }

  // Pieces near a world position (for hover), nearest first.
  async pick(x, z, radius) {
    const cx = chunkOf(x), cz = chunkOf(z);
    const out = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const ax = cx + dx, az = cz + dz;
        if (ax < 0 || az < 0 || ax >= 80 || az >= 80 || !chunks.has(ax, az)) continue;
        const data = await chunks.get(ax, az);
        for (const p of data.pieces) {
          const d = Math.hypot(p[0] - x, p[1] - z);
          const reach = Math.max(p[4], p[5]) / 2 + radius;
          if (d <= reach) out.push({ d, prefab: data.prefabs[p[8]], material: materialNames[p[7]] || 'Misc', y: p[2], h: p[6] });
        }
      }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
}

const RUIN_WOOD = hexRgb('#4a3f33'), RUIN_STONE = hexRgb('#3d4654');
const STONE_MATS = new Set([3, 4, 10]);   // Stone, Black marble, Grausten (icons.js materialNames)

export class RuinsGL extends ChunkShapes {
  constructor() {
    super();
    this.order = 2; this.stride = RECT_STRIDE;
    ruins.onChange(() => this.refresh());
    if (ruins.indexRev < 0) ruins.refreshIndex();
  }
  fetchesAt(zoom) { return zoom >= BUILDINGS_MIN_ZOOM - 1; }
  has(cx, cz) { return ruins.has(cx, cz); }
  rev(cx, cz) { const e = ruins.index.get(`${cx}_${cz}`); return e ? e.rev : 0; }
  fetch(cx, cz) { return ruins.get(cx, cz); }
  pack(pieces) { return packRects(pieces, (mat) => (STONE_MATS.has(mat) ? RUIN_STONE : RUIN_WOOD)); }
  program(sc) { return sc.rect; }
  layout(gl) { return RECT_LAYOUT(gl); }
  visibleAt(zoom) { return zoom >= BUILDINGS_MIN_ZOOM - 0.5 ? 1 : 0; }
  draw(gl, v, sc) {
    const fade = this.layerFade(v);
    if (fade <= 0) return;
    const p = sc.rect, tz = Math.round(v.zoom);
    sc.setView(p);
    gl.uniform1f(p.u.u_dotPx, tz >= DETAIL_ZOOM ? 0 : tz >= 4 ? 0.9 : 0.7);
    gl.uniform1f(p.u.u_minPx, 1.2);
    gl.uniform1f(p.u.u_alpha, 0.9);
    gl.uniform1i(p.u.u_edge, 2);
    gl.uniform1f(p.u.u_edgeK, tz >= DETAIL_ZOOM ? 1 : 0);
    this.drawChunks(gl, v, 16, p, fade);
  }
}

// Every tree and rock from zoom 5 up (the same range the baked tree tiles covered), so there is no
// hand-off between two kinds of trees and no tree tiles to download: the whole explored world's
// vegetation is ~2 MB, fetched by region and kept for good.
export class TreesGL extends ChunkShapes {
  constructor() {
    super(); this.order = 1; this.stride = TREE_STRIDE;
    vegetation.onChange(() => this.refresh());
    layerState.onChange((k) => { if (this.sc && /^veg(Trees|Bushes|Rocks)$/.test(k)) this.sc.redraw(); });   // a group switched on or off
  }
  // from 4 only what is on screen (a zoom-in will show it), padding too from TREES_MIN
  fetchesAt(zoom) { return zoom >= TREES_MIN - 0.5; }
  needArea(v) { return v.zoom >= TREES_MIN ? v : screenArea(v); }
  has(cx, cz) { return vegetation.has(cx, cz); }
  rev(cx, cz) { return vegetation.rev(cx, cz); }
  fetch(cx, cz) { return vegetation.get(cx, cz); }
  pack(packed) { return packed; }   // done by the worker (vegpack.js)
  program(sc) { return sc.tree; }
  layout(gl) { return [['a_center', 2, gl.FLOAT, false], ['a_r', 1, gl.FLOAT, false], ['a_seed', 1, gl.FLOAT, false], ['a_color', 4, gl.UNSIGNED_BYTE, true]]; }
  // eases in between 4.5 and 5.25 (and over FADE_MS when a zoom crosses that)
  visibleAt(zoom) { return Math.min(1, Math.max(0, (zoom - TREES_MIN) / 0.75)); }
  draw(gl, v, sc) {
    const fade = this.layerFade(v);
    if (fade <= 0) return;
    sc.setView(sc.tree);
    gl.uniform1i(sc.tree.u.u_show, (layerState.vegTrees !== false ? 1 : 0) | (layerState.vegBushes !== false ? 2 : 0) | (layerState.vegRocks !== false ? 4 : 0));
    // Every tree and rock at every zoom (drawing only some when zoomed out made them pop in as
    // you zoomed). Below 6.5 only around the screen, though: at those zooms the whole explored
    // world is in the padding, and a zoom-out from there fades the trees anyway.
    let area = v;
    if (v.zoom < 6.5) {
      const s = screenArea(v), mx = (s.x1 - s.x) * 0.3, mz = (s.z - s.z0) * 0.3;
      area = { x: s.x - mx, x1: s.x1 + mx, z: s.z + mz, z0: s.z0 - mz };
    }
    this.drawChunks(gl, area, 12, sc.tree, fade);
  }
}
