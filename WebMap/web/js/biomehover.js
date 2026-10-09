// The biome under the cursor, shown beside the coordinates like the game's map does. Read from the
// server's biome picture (data/biomes.png, explored ground only), turned once into a small grid of
// biome numbers; fetched the first time the mouse moves, again when exploration may have grown.
import { worldTile } from './crs.js';

const N = 1024;   // grid cells a side (~21 m each): plenty for a name, a quarter of the picture's memory

export class BiomeHover {
  constructor() { this.grid = null; this.names = []; this.loading = false; this.loadedAt = 0; }

  // the biome name at world x, z: '' while loading, in the fog, or past the world's edge
  at(x, z) {
    if (!this.loading && Date.now() - this.loadedAt > 120000) this.load();
    if (!this.grid) return '';
    const col = Math.floor((x / this.size + 0.5) * N), row = Math.floor((0.5 - z / this.size) * N);   // row 0 is the north edge
    if (col < 0 || row < 0 || col >= N || row >= N) return '';
    return this.names[this.grid[row * N + col]] || '';
  }

  async load() {
    this.loading = true;
    try {
      const d = await (await fetch('data/biomes.json', { cache: 'no-store' })).json();
      if (!d.ready) return;
      const r = await fetch(worldTile('data/biomes.png'), { cache: 'no-cache' });
      if (!r.ok) return;
      const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : Object.assign(document.createElement('canvas'), { width: N, height: N });
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = false;
      g.drawImage(bmp, 0, 0, N, N);
      bmp.close?.();
      const px = g.getImageData(0, 0, N, N).data;
      // colour -> name, from the server's own list (index 0: nothing)
      const pal = [], names = [''];
      for (const [name, hex] of Object.entries(d.colours || {})) { const v = parseInt(hex.slice(1), 16); pal.push([v >> 16, (v >> 8) & 255, v & 255, names.length]); names.push(name); }
      // the nearest of the known colours (a browser may shift them a shade), remembered per colour
      const byColour = new Map();
      const nearest = (r, g, b) => { let best = 0, bd = 1e9; for (const [pr, pg, pb, k] of pal) { const dd = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2; if (dd < bd) { bd = dd; best = k; } } return bd < 900 ? best : 0; };
      const grid = new Uint8Array(N * N);
      for (let i = 0; i < grid.length; i++) {
        const o = i * 4;
        if (px[o + 3] < 128) continue;
        const key = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
        let k = byColour.get(key);
        if (k === undefined) { k = nearest(px[o], px[o + 1], px[o + 2]); byColour.set(key, k); }
        grid[i] = k;
      }
      this.grid = grid; this.names = names; this.size = d.world || 21504;
    } catch (e) { /* no biome picture on this server: the slot stays empty */ }
    finally { this.loading = false; this.loadedAt = Date.now(); }
  }
}
