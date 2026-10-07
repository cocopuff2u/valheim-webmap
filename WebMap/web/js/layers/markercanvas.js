// Map markers, their labels and the portal lines, painted on one canvas over the map, redrawn in
// the same event that moves the map (the way valheim.tools draws its pins). With a Leaflet DOM
// element per marker, a zoom or drag moved hundreds of elements each frame, and they could sit a
// frame or half a pixel off the map underneath. Hover and click find the nearest icon.

import { iconSvg, colors } from '../icons.js';

const LABEL_FONT = '600 11px';
const iconCache = new Map();   // "name|color|px" -> canvas with the icon and its drop shadow, or 'loading'

function iconImage(name, color, px, onReady) {
  const key = `${name}|${color}|${px}`;
  const c = iconCache.get(key);
  if (c && c !== 'loading') return c;
  if (!c) {
    iconCache.set(key, 'loading');
    const img = new Image();
    img.onload = () => {
      const pad = 4, dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.ceil((px + pad * 2) * dpr);
      const g = cv.getContext('2d');
      g.scale(dpr, dpr);
      g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 2; g.shadowOffsetY = 1;   // like the old CSS drop-shadow
      g.drawImage(img, pad, pad, px, px);
      cv.pad = pad;
      iconCache.set(key, cv);
      onReady();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(name, color).replace('<svg ', `<svg width="${px * 3}" height="${px * 3}" `));
  }
  return null;
}

// source() -> {items: [{x, z, icon, color, label, pin, open(latlng)}], lines: [[x1, z1, x2, z2]], labels: bool}
export class MarkerCanvas extends L.Layer {
  constructor(source) {
    super();
    this.source = source;
    this.hover = null;
  }

  onAdd(map) {
    this.canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated marker-canvas', map.getPane('markerPane'));
    this.canvas.style.pointerEvents = 'none';
    this.font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    map.on('move viewreset resize moveend', this.draw, this);
    map.on('zoomanim', this.onZoomAnim, this);
    map.on('mousemove', this.onMouseMove, this);
    map.on('mouseout', this.onMouseOut, this);
    map.on('click', this.onClick, this);
    this.draw();
  }

  onRemove(map) {
    map.off('move viewreset resize moveend', this.draw, this);
    map.off('zoomanim', this.onZoomAnim, this);
    map.off('mousemove', this.onMouseMove, this);
    map.off('mouseout', this.onMouseOut, this);
    map.off('click', this.onClick, this);
    this.canvas.remove();
  }

  // Leaflet's own animated zooms (keyboard): scale the last picture along, like its vector renderer
  onZoomAnim(e) {
    if (!this.topLeft) return;
    const map = this._map;
    L.DomUtil.setTransform(this.canvas, map._latLngToNewLayerPoint(this.topLeft, e.zoom, e.center), map.getZoomScale(e.zoom, this.drawZoom));
  }

  // the markers to draw, with where they are on screen (container pixels)
  placed() {
    const map = this._map, size = map.getSize(), out = [];
    for (const it of this.src.items) {
      const p = map.latLngToContainerPoint([it.z, it.x]);
      if (p.x < -40 || p.y < -40 || p.x > size.x + 40 || p.y > size.y + 40) continue;
      out.push({ it, p });
    }
    return out;
  }

  draw() {
    const map = this._map;
    if (!map) return;
    this.src = this.source();
    const size = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 3), cv = this.canvas;
    if (cv.width !== Math.round(size.x * dpr) || cv.height !== Math.round(size.y * dpr)) {
      cv.width = Math.round(size.x * dpr); cv.height = Math.round(size.y * dpr);
      cv.style.width = size.x + 'px'; cv.style.height = size.y + 'px';
    }
    // Keep the canvas on the container's corner while the map pane moves under it. The canvas
    // itself sits on whole pixels (a layer at a fractional offset gets snapped by the browser, a
    // little differently each frame, and the icons wobbled during a glide); the fraction is
    // drawn into the picture instead, so every icon lands exactly on its spot.
    const at = map.containerPointToLayerPoint([0, 0]), whole = at.round();
    L.DomUtil.setPosition(cv, whole);
    this.topLeft = map.containerPointToLatLng([0, 0]); this.drawZoom = map.getZoom();
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, (at.x - whole.x) * dpr, (at.y - whole.y) * dpr);
    g.clearRect(-2, -2, size.x + 4, size.y + 4);
    const redraw = () => this.draw();

    // portal lines under everything
    if (this.src.lines.length) {
      g.save();
      g.strokeStyle = colors.portal; g.globalAlpha = 0.6; g.lineWidth = 1.5; g.setLineDash([4, 6]);
      g.beginPath();
      for (const [x1, z1, x2, z2] of this.src.lines) {
        const a = map.latLngToContainerPoint([z1, x1]), b = map.latLngToContainerPoint([z2, x2]);
        g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
      }
      g.stroke();
      g.restore();
    }

    const placed = this.placed(), small = map.getZoom() < 3;
    for (const { it, p } of placed) {
      const px = it.pin ? 18 : small ? 18 : 26;
      const im = iconImage(it.icon, it.color, px, redraw);
      if (!im) continue;
      // markers sit centred on their spot, pins stand on it
      const x = p.x - px / 2 - im.pad, y = (it.pin ? p.y - px : p.y - px / 2) - im.pad;
      g.drawImage(im, x, y, px + im.pad * 2, px + im.pad * 2);
    }

    // labels: under the icon, white with a dark edge; one that would overlap a label already
    // shown is left out (hovering its icon shows it), and none below zoom 4 but the hovered one
    const showAll = this.src.labels && map.getZoom() >= 4, taken = [];
    g.font = `${LABEL_FONT} ${this.font}`;
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.lineJoin = 'round';
    const label = (it, p, force) => {
      if (!it.label) return;
      const w = g.measureText(it.label).width, top = it.pin ? p.y + 2 : p.y + 14;
      const r = { x0: p.x - w / 2 - 2, x1: p.x + w / 2 + 2, y0: top, y1: top + 14 };
      if (!force && taken.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) return;
      taken.push(r);
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(it.label, p.x, top);
      g.fillStyle = '#fff'; g.fillText(it.label, p.x, top);
    };
    const hovered = this.hover && placed.find((q) => q.it === this.hover);
    if (hovered) label(hovered.it, hovered.p, true);
    if (showAll) for (const { it, p } of placed) if (it !== this.hover) label(it, p, false);
  }

  // the marker under a container point, if any
  hit(cp) {
    let best = null, bd = 15;
    for (const { it, p } of this.placed()) {
      const cy = it.pin ? p.y - 9 : p.y;
      const d = Math.hypot(p.x - cp.x, cy - cp.y);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  onMouseMove(e) {
    if (!this.src) return;
    const h = this.hit(e.containerPoint);
    if (h !== this.hover) {
      this.hover = h;
      this._map.getContainer().classList.toggle('marker-hover', !!h);
      this.draw();
    }
  }

  onMouseOut() { if (this.hover) { this.hover = null; this._map.getContainer().classList.remove('marker-hover'); this.draw(); } }

  onClick(e) {
    if (!this.src) return;
    const it = this.hit(e.containerPoint);
    if (it && it.open) it.open(L.latLng(it.z, it.x));
  }
}
