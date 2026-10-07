// The map tiles and the fog, drawn in the same WebGL canvas as the trees and buildings
// (layers/shapes.js), the way MapLibre and OpenLayers' WebGL layers draw tiles.
//
// With the tiles as <img> elements Leaflet shuffled hundreds of DOM nodes and animated them with
// CSS, and a tile level made mid-zoom slid against everything else. Here a tile is a GPU texture,
// the whole map is one canvas, and each square is drawn from the best picture there is: the tile
// itself, else its sharper children still loaded from before a zoom-out, else a stretched ancestor
// (the zoom-2 tiles are always loaded, so there is always one). New tiles fade in over that, so
// nothing is ever blank and nothing pops.

import { ShapesCanvas, screenArea } from './shapes.js';
import { on } from '../net.js';
import { OUTSIDE_RIM } from '../crs.js';

const MAX_ZOOM = 7, WORLD_HALF = 10240, TILE = 256;
const BASE_ZOOM = 2;          // always loaded: the last fallback for any square
const KEEP = 256;             // textures kept (256 KB each), oldest unseen ones go first
const PARALLEL = 6;           // a browser opens about this many connections per server anyway
const FADE_MS = 200;
const span = (z) => TILE * Math.pow(2, MAX_ZOOM - z);
const perSide = (z) => Math.ceil((2 * WORLD_HALF) / span(z));

export class GroundGL extends L.Layer {
  constructor(template) {
    super();
    this.template = template;
    this.order = 0;
    this.tex = new Map();       // "z/x/y" -> {tex, born, seen}
    this.missing = new Set();   // tiles the server doesn't have (yet): not asked for again until it renders them
    this.queue = new Map();     // "z/x/y" -> priority (lower first)
    this.inflight = new Set();
    this.rerendered = new Map(); // "z/x/y" -> ?r= value for tiles re-rendered while the page is open
    on('tiles', (f) => this.onRendered(f.keys));
  }

  onAdd(map) {
    this.sc = ShapesCanvas.for(map);
    this.sc.add(this);
    map.on('move', this.onMove, this);
    for (let x = 0; x < perSide(BASE_ZOOM); x++)
      for (let y = 0; y < perSide(BASE_ZOOM); y++) this.want(`${BASE_ZOOM}/${x}/${y}`, -1);
    this.pump();
  }
  onRemove(map) { map.off('move', this.onMove, this); this.sc.remove(this); }

  url(key) {
    const b = this.rerendered.get(key);
    const [z, x, y] = key.split('/');
    return this.template.replace('{z}', z).replace('{x}', x).replace('{y}', y) + (b ? `?r=${b}` : '');
  }

  // tile range covering an area at zoom z
  range(a, z) {
    const s = span(z), n = perSide(z);
    return {
      x0: Math.max(0, Math.floor((a.x + WORLD_HALF) / s)), x1: Math.min(n - 1, Math.floor((a.x1 + WORLD_HALF) / s)),
      y0: Math.max(0, Math.floor((WORLD_HALF - a.z) / s)), y1: Math.min(n - 1, Math.floor((WORLD_HALF - a.z0) / s)),
    };
  }

  // What to load: the screen and a tile around it at the drawn zoom, nearest the centre first, then
  // the whole padded canvas one zoom out (cheap, a quarter of the tiles), which is what a zoom-out
  // or a long drag shows first.
  need(v) {
    this.queue.clear();
    const tz = Math.max(0, Math.min(MAX_ZOOM, Math.round(v.zoom)));
    const s = v.screen ? v : screenArea(v), cx = (s.x + s.x1) / 2, cz = (s.z + s.z0) / 2, sp = span(tz);
    const r = this.range({ x: s.x - sp, x1: s.x1 + sp, z: s.z + sp, z0: s.z0 - sp }, tz);
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        const mx = -WORLD_HALF + (x + 0.5) * sp, mz = WORLD_HALF - (y + 0.5) * sp;
        this.want(`${tz}/${x}/${y}`, Math.hypot(mx - cx, mz - cz) / sp);
      }
    if (tz > BASE_ZOOM) {
      const r2 = this.range(v, tz - 1);
      for (let y = r2.y0; y <= r2.y1; y++) for (let x = r2.x0; x <= r2.x1; x++) this.want(`${tz - 1}/${x}/${y}`, 1000);
    }
    this.pump();
  }

  // during a drag the canvas only redraws near its edge; keep loading what comes on screen meanwhile
  onMove() {
    if (this.moveQueued || this._map._animatingZoom) return;
    this.moveQueued = true;
    requestAnimationFrame(() => {
      this.moveQueued = false;
      if (!this._map || !this.sc.view) return;
      const map = this._map, b = map.getBounds();   // the screen itself (need() takes it as is)
      this.need(Object.assign({}, this.sc.view, { x: b.getWest(), x1: b.getEast(), z: b.getNorth(), z0: b.getSouth(), zoom: map.getZoom(), screen: true }));
    });
  }

  want(key, pri) {
    if (this.tex.has(key) || this.missing.has(key) || this.inflight.has(key)) return;
    const old = this.queue.get(key);
    if (old === undefined || pri < old) this.queue.set(key, pri);
  }

  pump() {
    while (this.inflight.size < PARALLEL && this.queue.size) {
      let best = null, bp = Infinity;
      for (const [k, p] of this.queue) if (p < bp) { bp = p; best = k; }
      this.queue.delete(best);
      this.load(best);
    }
  }

  async load(key, replace) {
    this.inflight.add(key);
    try {
      // ask for WebP like an <img> does (fetch says */* and would get the PNG)
      const r = await fetch(this.url(key), { headers: { Accept: 'image/webp,image/png' }, priority: replace ? 'low' : 'auto' });
      if (r.status === 404) { this.missing.add(key); return; }
      if (!r.ok) throw new Error(r.status);
      const bmp = await createImageBitmap(await r.blob());   // decoded off the main thread
      if (!this.sc) return;
      const gl = this.sc.gl, old = this.tex.get(key);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      bmp.close();
      gl.generateMipmap(gl.TEXTURE_2D);   // smooth when shown smaller than 1:1 between zoom levels
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (old) gl.deleteTexture(old.tex);
      // a re-render swaps in place; a new tile fades in over whatever stood in for it
      this.tex.set(key, { tex, born: old ? 0 : performance.now(), seen: performance.now(), pinned: key.startsWith(`${BASE_ZOOM}/`) });
      this.evict();
      this.sc.redraw();
    } catch (e) {
      // network trouble: forget it, the next view change asks again
    } finally {
      this.inflight.delete(key);
      this.pump();
    }
  }

  evict() {
    if (this.tex.size <= KEEP) return;
    const gl = this.sc.gl;
    const old = [...this.tex.entries()].filter(([, t]) => !t.pinned).sort((a, b) => a[1].seen - b[1].seen);
    for (let i = 0; i < old.length && this.tex.size > KEEP; i++) { gl.deleteTexture(old[i][1].tex); this.tex.delete(old[i][0]); }
  }

  // the server re-rendered these: fetch them again (fresh ?r=), keeping the old picture until then
  onRendered(keys) {
    const bust = Date.now();
    for (const k of keys || []) {
      this.rerendered.set(k, bust);
      const wasMissing = this.missing.delete(k);
      if (this.tex.has(k)) this.load(k, true);
      else if (wasMissing && this.sc && this.sc.view) this.need(this.sc.view);
    }
  }

  quad(gl, p, t, z, x, y, uv, alpha) {
    const s = span(z);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform4f(p.u.u_rect, -WORLD_HALF + x * s, WORLD_HALF - y * s, s, s);
    gl.uniform4f(p.u.u_uv, uv[0], uv[1], uv[2], uv[3]);
    gl.uniform1f(p.u.u_alpha, alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  draw(gl, v, sc) {
    const p = sc.tex, now = performance.now();
    sc.setView(p);
    gl.bindVertexArray(sc.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.u_tex, 0);
    const tz = Math.max(0, Math.min(MAX_ZOOM, Math.round(v.zoom)));
    const r = this.range(v, tz);
    let fading = false;
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        const key = `${tz}/${x}/${y}`, t = this.tex.get(key);
        const f = t ? (t.born ? Math.min(1, (now - t.born) / FADE_MS) : 1) : 0;
        if (f < 1) {
          // stand-in: the nearest loaded ancestor, stretched, then any sharper children on top
          for (let l = 1; l <= tz; l++) {
            const a = this.tex.get(`${tz - l}/${x >> l}/${y >> l}`);
            if (!a) continue;
            const k = 1 << l, u0 = (x - ((x >> l) << l)) / k, v0 = (y - ((y >> l) << l)) / k;
            a.seen = now;
            this.quad(gl, p, a, tz, x, y, [u0, v0, u0 + 1 / k, v0 + 1 / k], 1);
            break;
          }
          if (tz < MAX_ZOOM)
            for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
              const c = this.tex.get(`${tz + 1}/${2 * x + dx}/${2 * y + dy}`);
              if (c) { c.seen = now; this.quad(gl, p, c, tz + 1, 2 * x + dx, 2 * y + dy, [0, 0, 1, 1], 1); }
            }
        }
        if (t) {
          t.seen = now;
          if (f < 1) fading = true;
          this.quad(gl, p, t, tz, x, y, [0, 0, 1, 1], f);
        }
      }
    gl.bindVertexArray(null);
    if (fading) sc.redraw();
  }
}

// The fog veil (FogLayer's canvas, layers/fog.js) as a texture over everything in the canvas.
// A reveal re-uploads only the square it touched.
export class FogGL extends L.Layer {
  constructor(fog) {
    super();
    this.fog = fog;
    this.order = 9;
    fog.onPaint = (rect) => this.paint(rect);
  }
  onAdd(map) { this.sc = ShapesCanvas.for(map); this.sc.add(this); this.paint(null); this.fog.onStyle = () => this.sc.redraw(); }
  onRemove() { this.sc.remove(this); }
  need() {}

  paint(rect) {
    if (!this.sc) return;
    const gl = this.sc.gl, c = this.fog.canvas;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (!this.tex || !rect) {
      if (!this.tex) {
        this.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    } else {
      const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
      const w = Math.min(c.width - x, Math.ceil(rect.w) + 1), h = Math.min(c.height - y, Math.ceil(rect.h) + 1);
      if (w <= 0 || h <= 0) return;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, c.getContext('2d').getImageData(x, y, w, h));
    }
    this.sc.redraw();
  }

  draw(gl, v, sc) {
    const f = this.fog;
    if (!this.tex || !f.visible || f.opacity <= 0) return;
    const p = sc.tex, b = f.bounds;   // plain black veil (the clouds are only past the world's edge)
    sc.setView(p);
    gl.bindVertexArray(sc.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(p.u.u_tex, 0);
    gl.uniform4f(p.u.u_rect, b.getWest(), b.getNorth(), b.getEast() - b.getWest(), b.getNorth() - b.getSouth());
    gl.uniform4f(p.u.u_uv, 0, 0, 1, 1);
    gl.uniform1f(p.u.u_alpha, f.opacity);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}

// Everything past the world's edge (radius 10 km) in a dark ocean colour with a soft rim, over the
// fog, so the round world reads as a world and not as fog that goes on forever.
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
export class WorldEdgeGL extends L.Layer {
  constructor(radius) { super(); this.radius = radius; this.order = 10; }
  onAdd(map) { this.sc = ShapesCanvas.for(map); this.sc.add(this); }
  onRemove() { this.sc.remove(this); }
  need() {}
  draw(gl, v, sc) {
    const p = sc.edge;
    sc.setView(p);
    gl.bindVertexArray(sc.quadVao);
    gl.uniform4f(p.u.u_rect, v.x, v.z, v.x1 - v.x, v.z - v.z0);   // the whole canvas
    gl.uniform1f(p.u.u_radius, this.radius);
    gl.uniform1f(p.u.u_mpp, 1 / v.ppm);
    gl.uniform3f(p.u.u_ring, ...rgb(OUTSIDE_RIM));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}

// The chunk grid (with each chunk's corner coordinates) and the rings every 500 m around the spawn
// (labelled each kilometre), drawn in the WebGL canvas over the fog. They used to be a Leaflet grid
// layer under the canvas (hidden) and twelve SVG circles redrawn every frame of a zoom (slow).
const textCache = new Map();
function textImage(s, color) {
  const k = `${s}|${color}`;
  let c = textCache.get(k);
  if (c) return c;
  const R = 3;   // drawn 3x and scaled down: sharp at any zoom step
  c = document.createElement('canvas');
  const g = c.getContext('2d'), font = `600 ${10 * R}px ui-monospace, monospace`;
  g.font = font;
  const w = Math.ceil(g.measureText(s).width) + 4 * R;
  c.width = w; c.height = 14 * R;
  g.font = font; g.textBaseline = 'middle';
  g.lineWidth = 3 * R; g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineJoin = 'round';
  g.strokeText(s, 2 * R, 7 * R);
  g.fillStyle = color; g.fillText(s, 2 * R, 7 * R);
  c.w = w / R; c.h = 14;
  if (textCache.size > 600) textCache.clear();
  textCache.set(k, c);
  return c;
}

export class GuideGL extends L.Layer {
  constructor(radius, color) { super(); this.radius = radius; this.color = color; this.order = 9.5; this.grid = false; this.rings = null; this.tex = new Map(); }
  onAdd(map) { this.sc = ShapesCanvas.for(map); this.sc.add(this); }
  onRemove() { this.sc.remove(this); }
  need() {}
  set(grid, spawn) {   // spawn: {x, z} for the rings, or null
    this.grid = grid; this.rings = spawn;
    if (this.sc) this.sc.redraw();
  }
  texture(gl, cv) {
    let t = this.tex.get(cv);
    if (t) return t;
    if (this.tex.size > 600) { for (const x of this.tex.values()) gl.deleteTexture(x); this.tex.clear(); }
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.set(cv, t);
    return t;
  }
  draw(gl, v, sc) {
    if (!this.grid && !this.rings) return;
    const p = sc.guide;
    sc.setView(p);
    gl.bindVertexArray(sc.quadVao);
    gl.uniform4f(p.u.u_rect, v.x, v.z, v.x1 - v.x, v.z - v.z0);
    gl.uniform1f(p.u.u_mpp, 1 / v.ppm);
    gl.uniform1f(p.u.u_radius, this.radius);
    gl.uniform1f(p.u.u_grid, this.grid ? 1 : 0);
    gl.uniform1f(p.u.u_rings, this.rings ? 1 : 0);
    gl.uniform2f(p.u.u_spawn, this.rings ? this.rings.x : 0, this.rings ? this.rings.z : 0);
    const n = parseInt(this.color.slice(1), 16);
    gl.uniform3f(p.u.u_ringColor, (n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // labels
    const t = sc.tex;
    sc.setView(t);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(t.u.u_tex, 0);
    gl.uniform4f(t.u.u_uv, 0, 0, 1, 1);
    const label = (cv, x, z, dx, dy, alpha) => {   // top-left of the text dx, dy px from world (x, z)
      gl.uniform1f(t.u.u_alpha, alpha);
      gl.bindTexture(gl.TEXTURE_2D, this.texture(gl, cv));
      gl.uniform4f(t.u.u_rect, x + dx / v.ppm, z - dy / v.ppm, cv.w / v.ppm, cv.h / v.ppm);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    if (this.grid) {
      // each chunk's north-west corner, as the old grid tiles had it; every 2nd, 4th... chunk when
      // they would crowd (at least ~150 px apart)
      const px = 256 * v.ppm;
      if (px >= 20) {
        let step = 256;
        while (step * v.ppm < 150) step *= 2;
        const a = Math.min(1, (px - 20) / 30) * 0.8;
        for (let x = Math.floor(v.x / step) * step; x <= v.x1; x += step)
          for (let z = Math.ceil(v.z / step) * step; z >= v.z0; z -= step) {
            if (Math.hypot(x, z) > this.radius) continue;
            label(textImage(`${x}, ${z}`, 'rgba(255,255,255,.75)'), x, z, 3, 2, a);
          }
      }
    }
    if (this.rings) {
      for (let km = 1; km <= 6; km++) {
        const cv = textImage(`${km} km`, this.color);
        label(cv, this.rings.x, this.rings.z + km * 1000, -cv.w / 2, -cv.h / 2, 1);
      }
    }
    gl.uniform1f(t.u.u_alpha, 1);
    gl.bindVertexArray(null);
  }
}
