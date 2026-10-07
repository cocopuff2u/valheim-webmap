// Chunked world data shared by the 2D layers and the 3D view: player-built
// pieces and vegetation, 256 m squares fetched on demand and cached by the
// server's revision numbers.

import { getJSON, getBuffer, on, state } from './net.js';

export const VEG_KIND = ['none', 'deciduous', 'conifer', 'swamptree', 'misttree', 'deadtree', 'bush', 'rock', 'ore', 'stump', 'berry', 'ashtree'];

// Chunk data arrives 8x8 chunks to a request (a "region", see Regions.cs): opening the map is a
// handful of requests instead of hundreds. A region URL carries its content hash, so the browser
// keeps it for good. Resolves to the region's chunk list, or null when the server lists no regions.
export class RegionLoader {
  constructor(kind) { this.kind = kind; this.revs = new Map(); this.loads = new Map(); this.size = 8; }
  setIndex(idx) {
    this.size = idx.regionSize || 8;
    this.revs = new Map((idx.regions || []).map(([rx, rz, rev]) => [`${rx}_${rz}`, rev]));
    for (const k of this.loads.keys()) { const [rk, rev] = k.split(':'); if (this.revs.get(rk) !== +rev) this.loads.delete(k); }
  }
  load(cx, cz) {
    const rk = `${Math.floor(cx / this.size)}_${Math.floor(cz / this.size)}`, rev = this.revs.get(rk);
    if (!rev) return null;
    const key = `${rk}:${rev}`;
    if (!this.loads.has(key)) {
      const p = getJSON(`data/${this.kind}/r/${rk}.json?h=${rev}`, { cache: 'default' }).then((d) => d.chunks);
      p.catch(() => this.loads.delete(key));
      this.loads.set(key, p);
    }
    return this.loads.get(key);
  }
}

class ChunkStore {
  constructor() {
    this.index = new Map();      // "cx_cz" -> {rev, count}
    this.indexRev = -1;
    this.cache = new Map();      // "cx_cz" -> {rev, data}
    this.inflight = new Map();
    this.listeners = new Set();
    this.regions = new RegionLoader('structures');
    on('world', () => this.refreshIndex());
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async refreshIndex() {
    try {
      const idx = await getJSON('data/structures/index.json');
      if (idx.rev === this.indexRev) return;
      this.indexRev = idx.rev;
      const next = new Map();
      for (const [cx, cz, rev, count] of idx.chunks) next.set(`${cx}_${cz}`, { rev, count });
      // drop cached chunks that changed or vanished
      for (const [k, c] of this.cache) {
        const n = next.get(k);
        if (!n || n.rev !== c.rev) this.cache.delete(k);
      }
      this.index = next;
      this.regions.setIndex(idx);
      for (const fn of this.listeners) fn();
    } catch (e) { console.warn('structures index', e); }
  }

  has(cx, cz) { return this.index.has(`${cx}_${cz}`); }
  countIn(cx, cz) { const e = this.index.get(`${cx}_${cz}`); return e ? e.count : 0; }

  // Resolves to the chunk's piece list ([] when the chunk has none). Pieces are
  // arrays: [x, z, y, yaw, sx, sz, h, mat, prefabIdx]; `prefabs` names them.
  async get(cx, cz) {
    const k = `${cx}_${cz}`;
    const e = this.index.get(k);
    if (!e) return { pieces: [], prefabs: [], rev: 0 };
    const c = this.cache.get(k);
    if (c && c.rev === e.rev) return c.data;
    if (this.inflight.has(k)) return this.inflight.get(k);
    // ?h= is the chunk's content hash: the server lets the browser keep that URL for good
    const single = () => getJSON(`data/structures/${k}.json?h=${e.rev}`, { cache: 'default' }).then((data) => { this.cache.set(k, { rev: data.rev, data }); return data; });
    const region = this.regions.load(cx, cz);
    const p = (region ? region.then((list) => {
      for (const d of list) { const ie = this.index.get(`${d.cx}_${d.cz}`); if (ie && ie.rev === d.rev) this.cache.set(`${d.cx}_${d.cz}`, { rev: d.rev, data: d }); }
      const c2 = this.cache.get(k);
      return c2 && c2.rev === e.rev ? c2.data : single();
    }) : single()).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  // Vegetation points in a chunk: records {x, y, z, kind, size} (see VegStore).
  veg(cx, cz) { return vegetation.get(cx, cz); }
}

// one VEG1 chunk (see Vegetation.Chunk on the server) into point records
function parseVeg(dv, o, cx, cz) {
  const pts = [];
  if (dv.byteLength < o + 8 || String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)) !== 'VEG1') return pts;
  const n = dv.getUint32(o + 4, true);
  const minX = -10240 + cx * 256, minZ = -10240 + cz * 256;
  o += 8;
  for (let i = 0; i < n; i++, o += 8)
    pts.push({ x: minX + dv.getInt16(o, true) / 4, z: minZ + dv.getInt16(o + 2, true) / 4, y: dv.getInt16(o + 4, true) / 4, kind: dv.getUint8(o + 6), size: dv.getUint8(o + 7) / 32 });
  return pts;
}

// Trees and rocks, fetched 4x4 chunks to a request (data/veg/r/rx_rz.bin) and cached for good by
// the region's content hash; only regions where trees were felled or grew are fetched again.
class VegStore {
  constructor() {
    this.revs = new Map(); this.size = 4; this.indexRev = -1;
    this.cache = new Map();      // "cx_cz" -> {rev, pts}
    this.loads = new Map();      // "rx_rz:rev" -> Promise
    this.listeners = new Set();
    this.ready = this.refreshIndex();
    on('world', () => this.refreshIndex());
  }
  onChange(fn) { this.listeners.add(fn); }
  async refreshIndex() {
    try {
      const idx = await getJSON('data/veg/index.json');
      if (idx.rev === this.indexRev) return;
      this.indexRev = idx.rev; this.size = idx.regionSize || 4;
      this.revs = new Map(idx.regions.map(([rx, rz, rev]) => [`${rx}_${rz}`, rev]));
      if (this.listeners.size) for (const fn of this.listeners) fn();
    } catch (e) { this.revs = null; }   // an older server: per-chunk files
  }
  region(cx, cz) { return `${Math.floor(cx / this.size)}_${Math.floor(cz / this.size)}`; }
  rev(cx, cz) { return this.revs ? this.revs.get(this.region(cx, cz)) || 0 : 1; }
  has(cx, cz) { return this.rev(cx, cz) !== 0; }
  async get(cx, cz) {
    await this.ready;
    const k = `${cx}_${cz}`, rev = this.rev(cx, cz);
    const c = this.cache.get(k);
    if (c && c.rev === rev) return c.pts;
    if (!rev) return [];
    if (!this.revs) {   // no regions: the chunk on its own
      const pts = await getBuffer(`data/veg/${k}.bin`, { cache: 'default' }).then((b) => parseVeg(new DataView(b), 0, cx, cz)).catch(() => []);
      this.cache.set(k, { rev, pts });
      return pts;
    }
    const rk = this.region(cx, cz), key = `${rk}:${rev}`;
    if (!this.loads.has(key)) {
      const p = getBuffer(`data/veg/r/${rk}.bin?h=${rev}`, { cache: 'default' }).then((buf) => {
        const dv = new DataView(buf);
        const n = dv.getUint32(4, true);
        let o = 8;
        for (let i = 0; i < n; i++) {
          const ccx = dv.getUint8(o), ccz = dv.getUint8(o + 1), len = dv.getUint32(o + 2, true);
          this.cache.set(`${ccx}_${ccz}`, { rev, pts: parseVeg(dv, o + 6, ccx, ccz) });
          o += 6 + len;
        }
        this.loads.delete(key);
      });
      p.catch(() => this.loads.delete(key));
      this.loads.set(key, p);
    }
    await this.loads.get(key).catch(() => {});
    const got = this.cache.get(k);
    if (got && got.rev === rev) return got.pts;
    this.cache.set(k, { rev, pts: [] });   // listed region, nothing in this chunk
    return [];
  }
}
export const vegetation = new VegStore();

export const chunks = new ChunkStore();

// Prefab model library index: hash -> {n: name, c: category, m: has model, t: triangles, x: textured, b: bounds[6]}
export const prefabs = {
  map: new Map(), rev: -1, listeners: new Set(), stats: {},
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  get(hash) { return this.map.get(hash); },
  async refresh() {
    if (state.config && state.config.enable_3d === false) return;   // 3D-only data
    try {
      const d = await getJSON('data/prefabs.json');
      if (d.rev === this.rev) return;
      this.rev = d.rev;
      this.stats = { exported: d.exported, readable: d.readable, unreadable: d.unreadable, queued: d.queued };
      this.map = new Map(Object.entries(d.prefabs || {}).map(([k, v]) => [+k, v]));
      for (const fn of this.listeners) fn(this);
    } catch (e) { console.warn('prefabs', e); }
  },
};
on('world', () => prefabs.refresh());

// Which object categories the 3D view draws (the server decides which it publishes at all: object_categories).
export const OBJECT_CATS = [['piece', 'Buildings'], ['other', 'Ruins & objects'], ['rock', 'Rocks'], ['bush', 'Bushes'], ['tree', 'Trees']];
export const objectFilter = {
  on: new Set(['piece', 'other', 'rock', 'bush', 'tree']), listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  shows(cat) { return !cat || this.on.has(cat); },
  set(cat, v) {
    if (v) this.on.add(cat); else this.on.delete(cat);
    try { localStorage.setItem('webmap.objects2', [...this.on].join(',')); } catch { }
    for (const fn of this.listeners) fn();
  },
};
try { const v = localStorage.getItem('webmap.objects2'); if (v !== null) objectFilter.on = new Set(v.split(',').filter(Boolean)); } catch { }

// World objects per chunk (everything with a mesh: pieces, ruins, trees, rocks, boats ...)
class ObjectStore {
  constructor() {
    this.index = new Map();      // "cx_cz" -> {rev, count}
    this.indexRev = -1;
    this.cache = new Map();      // "cx_cz" -> {rev, objs}
    this.inflight = new Map();
    this.listeners = new Set();
    on('world', () => this.refreshIndex());
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async refreshIndex() {
    if (state.config && state.config.enable_3d === false) return;   // 3D-only data
    try {
      const idx = await getJSON('data/objects/index.json');
      if (idx.rev === this.indexRev) return;
      this.indexRev = idx.rev;
      const next = new Map();
      for (const [cx, cz, rev, count] of idx.chunks) next.set(`${cx}_${cz}`, { rev, count });
      for (const [k, c] of this.cache) { const n = next.get(k); if (!n || n.rev !== c.rev) this.cache.delete(k); }
      this.index = next;
      for (const fn of this.listeners) fn();
    } catch (e) { console.warn('objects index', e); }
  }
  has(cx, cz) { return this.index.has(`${cx}_${cz}`); }
  countIn(cx, cz) { const e = this.index.get(`${cx}_${cz}`); return e ? e.count : 0; }
  // Resolves to {rev, objs: [{prefab, x, y, z, qx, qy, qz, qw, sx, sy, sz, creator}]}
  async get(cx, cz) {
    const k = `${cx}_${cz}`;
    const e = this.index.get(k);
    if (!e) return { rev: 0, objs: [] };
    const c = this.cache.get(k);
    if (c && c.rev === e.rev) return c;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = getBuffer(`data/objects/${k}.bin`).then((buf) => {
      const dv = new DataView(buf);
      const objs = [];
      if (buf.byteLength >= 12 && String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) === 'OBJ1') {
        const n = dv.getUint32(4, true), np = dv.getUint32(8, true);
        const table = new Int32Array(np);
        let o = 12;
        for (let i = 0; i < np; i++) { table[i] = dv.getInt32(o, true); o += 4; }
        for (let i = 0; i < n; i++) {
          const pi = dv.getUint16(o, true), flags = dv.getUint8(o + 2); o += 4;
          const f = new Float32Array(buf.slice(o, o + 40)); o += 40;
          objs.push({ prefab: table[pi], creator: (flags & 1) !== 0, x: f[0], y: f[1], z: f[2], qx: f[3], qy: f[4], qz: f[5], qw: f[6], sx: f[7], sy: f[8], sz: f[9] });
        }
      }
      const res = { rev: e.rev, objs };
      this.cache.set(k, res);
      this.inflight.delete(k);
      return res;
    }).catch((err) => { this.inflight.delete(k); throw err; });
    this.inflight.set(k, p);
    return p;
  }
}
export const objects = new ObjectStore();

// Markers (locations, portals, tombstones, vehicles, custom sets)
export const markers = {
  sets: [], rev: -1, listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  async refresh() {
    try {
      const m = await getJSON('data/markers.json');
      if (m.rev === this.rev) return;
      this.rev = m.rev; this.sets = m.sets || [];
      for (const fn of this.listeners) fn(this.sets);
    } catch (e) { console.warn('markers', e); }
  },
};
on('world', () => markers.refresh());

// Stats (server + players)
export const stats = {
  data: null, listeners: new Set(),
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  set(d) { this.data = d; for (const fn of this.listeners) fn(d); },
  async refresh() { try { this.set(await getJSON('data/stats.json')); } catch (e) { console.warn('stats', e); } },
};
on('world', (f) => { if (f.stats) stats.set(f.stats); });
