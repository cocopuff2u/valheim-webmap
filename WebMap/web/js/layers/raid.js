// The raid going on now, drawn the way the game's map draws it (Minimap.UpdateEventPin): its
// see-through red area sprite across 90% of the raid's range, and the red "!" at double pin size,
// pulsing, with the raid's message under it. The game's own sprites when the server could get them
// (World/MapIcons), look-alikes otherwise. The server sends the raid in the hello frame (a page
// opened mid-raid) and as "raid" frames when one starts or ends (data null).
import { on } from '../net.js';
import { toLatLng } from '../crs.js';
import { escape } from './markers.js';

export class RaidLayer {
  constructor(map, markers) {
    this.map = map;
    this.markers = markers;   // has the game's icon names (gameIcons)
    this.parts = [];
    on('hello', (f) => this.set(f.raid));
    on('raid', (f) => this.set(f.data));
  }

  sprite(key) {
    const s = this.markers && this.markers.gameIcons && this.markers.gameIcons[key];
    return s ? `icons/game/${s}.png` : null;
  }

  set(r) {
    for (const p of this.parts) p.remove();
    this.parts = [];
    this.last = r;
    if (!r || r.x === undefined) return;
    // the game's icon list may still be loading: draw again with its sprites once it is here
    if (!this.sprite('pin:RandomEvent') && !this.retried) { this.retried = true; setTimeout(() => this.set(this.last), 2000); }
    const half = r.r * 0.9;   // the game: world size = range * 2 * 0.9
    const area = this.sprite('pin:EventArea');
    const bounds = L.latLngBounds(toLatLng(r.x - half, r.z - half), toLatLng(r.x + half, r.z + half));
    this.parts.push(area
      ? L.imageOverlay(area, bounds, { interactive: false, className: 'raid-area' }).addTo(this.map)
      : L.polygon(Array.from({ length: 72 }, (_, i) => toLatLng(r.x + Math.cos(i * Math.PI / 36) * half, r.z + Math.sin(i * Math.PI / 36) * half)),
        { stroke: false, fillColor: '#ff0f00', fillOpacity: 0.44, interactive: false }).addTo(this.map));
    const bang = this.sprite('pin:RandomEvent');
    const html = `<div class="raid-pin">${bang ? `<img src="${bang}" alt="">` : '<b>!</b>'}</div><div class="raid-name">${escape(r.name || 'Raid')}</div>`;
    this.parts.push(L.marker(toLatLng(r.x, r.z), {
      icon: L.divIcon({ className: 'raid-icon', html, iconSize: [64, 64], iconAnchor: [32, 32] }),
      interactive: false, keyboard: false, zIndexOffset: 1500,
    }).addTo(this.map));
  }
}
