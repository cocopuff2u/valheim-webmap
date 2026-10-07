// Tree and rock records packed for the GPU (layers/shapes.js TreesGL), shared by the page and the
// vegetation worker (vegworker.js).

// kind -> [crownRadius, colour, isRock]  (mirrors Palette.cs and layers/veg.js)
export const VEG = {
  1: [4.5, '#568a3a'], 2: [3.0, '#2c5234'], 3: [3.0, '#383e28'], 4: [4.0, '#4a6870'], 5: [2.5, '#46382e'],
  6: [1.3, '#466e32'], 7: [2.5, '#767670', true], 8: [2.5, '#86684a', true], 9: [0.7, '#60462c'], 10: [1.0, '#5a783c'], 11: [3.0, '#3c2822'],
};
export const TREE_STRIDE = 20;   // x, z, radius, seed (float32) + rgb, rock (uint8)

const RGB = {};
for (const k in VEG) { const n = parseInt(VEG[k][1].slice(1), 16); RGB[k] = [n >> 16, (n >> 8) & 255, n & 255]; }

// pts: {x, z, kind, size}; north to south, so southern crowns overlap northern ones
const seedOf = (p) => (p.x * 7 + p.z * 3) % 6.28;   // a per-tree number for the crown's lobes

export function packTrees(pts) {
  const list = pts.filter((p) => VEG[p.kind]).sort((a, b) => b.z - a.z);
  const n = list.length;
  const bytes = new ArrayBuffer(n * TREE_STRIDE), f = new Float32Array(bytes), u = new Uint8Array(bytes);
  for (let i = 0; i < n; i++) {
    const p = list[i], o = i * 5, [r, g, b] = RGB[p.kind];
    f[o] = p.x; f[o + 1] = p.z; f[o + 2] = VEG[p.kind][0] * p.size; f[o + 3] = seedOf(p);
    u[o * 4 + 16] = r; u[o * 4 + 17] = g; u[o * 4 + 18] = b; u[o * 4 + 19] = VEG[p.kind][2] ? 255 : 0;
  }
  return { bytes, count: n };
}

// a VGR2 region (see Vegetation.RegionBin): -> [{cx, cz, bytes, count}]
export function unpackRegion(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'VGR2') return [];
  const n = dv.getUint32(4, true), out = [];
  let o = 8;
  for (let i = 0; i < n; i++) {
    const cx = dv.getUint8(o), cz = dv.getUint8(o + 1), count = dv.getUint32(o + 2, true);
    o += 6;
    const minX = -10240 + cx * 256, minZ = -10240 + cz * 256, pts = new Array(count);
    for (let j = 0; j < count; j++, o += 6)
      pts[j] = { x: minX + dv.getInt16(o, true) / 4, z: minZ + dv.getInt16(o + 2, true) / 4, kind: dv.getUint8(o + 4), size: dv.getUint8(o + 5) / 32 };
    out.push(Object.assign({ cx, cz }, packTrees(pts)));
  }
  return out;
}
