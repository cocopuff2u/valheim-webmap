import { WORLD_HALF } from './grid.js';
// Tree and rock records packed for the GPU (layers/shapes.js TreesGL), shared by the page and the
// vegetation worker (vegworker.js).

// kind -> [crownRadius, colour, isRock]  (mirrors Palette.cs and layers/veg.js)
export const VEG = {
  1: [4.5, '#568a3a'], 2: [3.0, '#2c5234'], 3: [3.0, '#383e28'], 4: [4.0, '#4a6870'], 5: [2.5, '#46382e'],
  6: [1.3, '#466e32'], 7: [2.5, '#767670', true], 8: [2.5, '#86684a', true], 9: [0.7, '#60462c'], 10: [1.0, '#5a783c'], 11: [3.0, '#3c2822'],
  12: [4.5, '#46702a'], 13: [4.5, '#8aa046'], 14: [3.0, '#486430'], 15: [1.0, '#c43a4a'], 16: [1.0, '#4e64cc'], 17: [1.0, '#e4a840'], 18: [4.5, '#cc963a'],
  19: [0.6, '#d6423a'], 20: [0.6, '#e8c446'], 21: [0.6, '#b06ad6'], 22: [0.6, '#bae0f2'], 23: [0.6, '#968c8c'], 24: [0.6, '#706ed6'],
  25: [0.6, '#f2de5a'], 26: [0.6, '#7cba4e'], 27: [0.6, '#d6be74'], 28: [0.6, '#c4d6a4'], 29: [1.0, '#b0223e'], 30: [1.1, '#8e3a7a'], 31: [1.1, '#703c2c'],
};
export const TREE_STRIDE = 20;   // x, z, radius, seed (float32) + rgb, flags (uint8: rock 1, in shallow water 2, group << 2)

// the groups the Layers panel shows and hides on their own: 0 trees (and stumps), 1 bushes and
// berry bushes, 2 rocks and ore, 3 mushrooms and other plants you can pick
const BUSHES = new Set([6, 10, 15, 16, 17, 29, 30, 31]);
export const vegGroup = (kind) => (VEG[kind] && VEG[kind][2] ? 2 : kind >= 19 && !BUSHES.has(kind) ? 3 : BUSHES.has(kind) ? 1 : 0);

const RGB = {};
for (const k in VEG) { const n = parseInt(VEG[k][1].slice(1), 16); RGB[k] = [n >> 16, (n >> 8) & 255, n & 255]; }

// pts: {x, z, kind, size, wet}; north to south, so southern crowns overlap northern ones
const seedOf = (p) => (p.x * 7 + p.z * 3) % 6.28;   // a per-tree number for the crown's lobes

export function packTrees(pts) {
  const list = pts.filter((p) => VEG[p.kind]).sort((a, b) => b.z - a.z);
  const n = list.length;
  const bytes = new ArrayBuffer(n * TREE_STRIDE), f = new Float32Array(bytes), u = new Uint8Array(bytes);
  for (let i = 0; i < n; i++) {
    const p = list[i], o = i * 5, [r, g, b] = RGB[p.kind];
    f[o] = p.x; f[o + 1] = p.z; f[o + 2] = VEG[p.kind][0] * p.size; f[o + 3] = seedOf(p);
    u[o * 4 + 16] = r; u[o * 4 + 17] = g; u[o * 4 + 18] = b; u[o * 4 + 19] = (VEG[p.kind][2] ? 1 : 0) | (p.wet ? 2 : 0) | (vegGroup(p.kind) << 2);
  }
  return { bytes, count: n };
}

// a VGR3 region (see Vegetation.RegionBin): -> [{cx, cz, bytes, count}]
export function unpackRegion(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'VGR3') return [];
  const n = dv.getUint32(4, true), out = [];
  let o = 8;
  for (let i = 0; i < n; i++) {
    const cx = dv.getUint8(o), cz = dv.getUint8(o + 1), count = dv.getUint32(o + 2, true);
    o += 6;
    const minX = -WORLD_HALF + cx * 256, minZ = -WORLD_HALF + cz * 256, pts = new Array(count);
    for (let j = 0; j < count; j++, o += 6)
      { const k = dv.getUint8(o + 4); pts[j] = { x: minX + dv.getInt16(o, true) / 4, z: minZ + dv.getInt16(o + 2, true) / 4, kind: k & 0x7f, wet: k >= 0x80, size: dv.getUint8(o + 5) / 32 }; }
    out.push(Object.assign({ cx, cz }, packTrees(pts)));
  }
  return out;
}
