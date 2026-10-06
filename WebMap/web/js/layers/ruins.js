// World-generated structures on the 2D map -- abandoned houses, goblin villages,
// shipwrecks, mountain/castle kit pieces -- drawn as weathered outlines from the 3D object data
// the server already publishes (object_categories must include piece,other; export_models gives
// the footprints). Player builds stay on the Buildings layer; spawners, loot and boss altars are
// never drawn, and the fog layer above still hides anything nobody has explored.

import { TILE, WORLD_HALF, chunkOf, metersPerPixel } from '../crs.js';
import { objects, prefabs } from '../data.js';

const ALLOW_OTHER = /^(MountainKit|CastleKit|goblin|dvergr|dverger|Ashland|charred|blackmarble|StartPlatform|BossStone_|cloth_hanging|fenrirhide|shipwreck|ruin)/i;
// Only from this zoom in: further out a tile spans dozens of chunks, and on a big world the
// opening view would pull ~1,200 object chunks (60+ MB) just to draw dots.
const MIN_ZOOM = 6;
const COLOR_PIECE = '#4a3f33';   // dark weathered wood/stone: reads on snow, sand and grass
const COLOR_OTHER = '#3d4654';   // kit pieces, platforms

function wanted(p) {
  if (!p || !p.b) return null;
  if (p.c === 'piece') return COLOR_PIECE;
  if (p.c === 'other' && ALLOW_OTHER.test(p.n)) return COLOR_OTHER;
  return null;
}

export class RuinsLayer extends L.GridLayer {
  constructor(options) {
    super(Object.assign({ tileSize: TILE, minZoom: MIN_ZOOM, maxZoom: 10, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 2, className: 'ruins-tile', zIndex: 240 }, options));
    // Repaint the existing tiles in place when the data changes, instead of redraw(), which removes
    // every tile first and makes the whole layer blink.
    const redraw = () => { if (!this._map) return; for (const t of Object.values(this._tiles)) this.draw(t.el, t.coords).catch(() => {}); };
    objects.onChange(redraw);
    prefabs.onChange(redraw);
    if (prefabs.map.size === 0) prefabs.refresh();
    if (objects.index.size === 0) objects.refreshIndex();
    this.cache = new Map();   // "cx_cz" -> {rev, prefabRev, items}: the chunk's structures, filtered and pre-computed once
  }

  // Only the world-generated structures of a chunk, with footprint and rotation worked out once,
  // so drawing a tile never re-walks the thousands of stones and branches in the same chunk.
  async structuresIn(cx, cz) {
    const k = `${cx}_${cz}`;
    const { rev, objs } = await objects.get(cx, cz);
    const hit = this.cache.get(k);
    if (hit && hit.rev === rev && hit.prefabRev === prefabs.rev) return hit.items;
    const items = [];
    for (const o of objs) {
      if (o.creator) continue;                       // player builds are the Buildings layer's job
      const p = prefabs.get(o.prefab);
      const col = wanted(p);
      if (!col) continue;
      const b = p.b;
      const yaw = Math.atan2(2 * (o.qw * o.qy + o.qx * o.qz), 1 - 2 * (o.qy * o.qy + o.qx * o.qx));
      items.push({ x: o.x, z: o.z, col, c: Math.cos(yaw), s: Math.sin(yaw),
        x0: b[0] * o.sx, w: (b[3] - b[0]) * o.sx, y0: -b[5] * o.sz, d: (b[5] - b[2]) * o.sz });
    }
    this.cache.set(k, { rev, prefabRev: prefabs.rev, items });
    return items;
  }

  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE;   // 1x: outlines are simple shapes
    this.draw(canvas, coords).then(() => done(null, canvas)).catch((e) => { console.warn(e); done(null, canvas); });
    return canvas;
  }

  async draw(canvas, coords) {
    const z = coords.z;
    if (z < MIN_ZOOM) return;   // Leaflet still asks for tiles below minZoom
    const mpp = metersPerPixel(z), ppm = 1 / mpp, span = TILE * mpp;
    const minX = -WORLD_HALF + coords.x * span, maxZ = WORLD_HALF - coords.y * span;
    const maxX = minX + span, minZ = maxZ - span;
    const M = 16;
    const lists = [];
    for (let cz = chunkOf(minZ - M); cz <= chunkOf(maxZ + M); cz++)
      for (let cx = chunkOf(minX - M); cx <= chunkOf(maxX + M); cx++)
        if (cx >= 0 && cz >= 0 && cx < 80 && cz < 80 && objects.has(cx, cz)) lists.push(this.structuresIn(cx, cz));
    if (lists.length === 0) return;
    const chunksData = await Promise.all(lists);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);   // in-place repaints start from a clean tile
    for (const items of chunksData) {
      for (const o of items) {
        if (o.x < minX - M || o.x > maxX + M || o.z < minZ - M || o.z > maxZ + M) continue;
        const px = (o.x - minX) * ppm, py = (maxZ - o.z) * ppm;
        ctx.fillStyle = o.col;
        const x0 = o.x0 * ppm, w = Math.max(o.w * ppm, 1.2);
        const y0 = o.y0 * ppm, d = Math.max(o.d * ppm, 1.2);
        const c = o.c, s = o.s;
        ctx.setTransform(c, s, -s, c, px, py);           // rotate about the object's pivot, z flipped to canvas y
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x0, y0, w, d);
        if (w > 3 || d > 3) {
          ctx.globalAlpha = 0.75; ctx.strokeStyle = '#e8dcc4'; ctx.lineWidth = 0.75;   // light edge so dark shapes pop on dark forest too
          ctx.strokeRect(x0 + .4, y0 + .4, w - .8, d - .8);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }
}
