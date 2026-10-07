// Map markers, their labels and the portal lines, painted on one canvas over the map, redrawn in
// the same event that moves the map (the way valheim.tools draws its pins). With a Leaflet DOM
// element per marker, a zoom or drag moved hundreds of elements each frame, and they could sit a
// frame or half a pixel off the map underneath. Hover and click find the nearest icon.

import { iconSvg, colors } from '../icons.js';
import { ShapesCanvas } from './shapes.js';

const LABEL_FONT = '600 11px';
const iconCache = new Map();   // "name|color" -> canvas with the icon and its drop shadow, or 'loading'
const ICON_RES = 72;           // each icon is rendered once this big and drawn scaled to any size:
                               // whole-pixel sizes stepped visibly as icons grew during a zoom

function iconImage(name, color, onReady) {
  const key = `${name}|${color}`;
  const c = iconCache.get(key);
  if (c && c !== 'loading') return c;
  if (!c) {
    iconCache.set(key, 'loading');
    const img = new Image();
    img.onload = () => {
      const k = ICON_RES / 26, pad = 4 * k;   // shadow and padding in proportion to a 26 px icon
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.ceil(ICON_RES + pad * 2);
      const g = cv.getContext('2d');
      g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 2 * k; g.shadowOffsetY = 1 * k;   // like the old CSS drop-shadow
      g.drawImage(img, pad, pad, ICON_RES, ICON_RES);
      cv.padShare = pad / ICON_RES;
      iconCache.set(key, cv);
      onReady();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(name, color).replace('<svg ', `<svg width="${ICON_RES}" height="${ICON_RES}" `));
  }
  return null;
}

// Labels are rendered once into small images and drawn like the icons: canvas text is snapped to
// whole pixels by the browser, so while the map glided the labels stepped beside their icons.
const labelCache = new Map();   // text -> canvas
function labelImage(text, font) {
  let c = labelCache.get(text);
  if (c) return c;
  const k = 3;   // rendered at 3x, drawn at 1x: sharp on any screen
  const m = document.createElement('canvas').getContext('2d');
  m.font = `${LABEL_FONT} ${font}`;
  const w = Math.ceil(m.measureText(text).width) + 6, h = 16;
  c = document.createElement('canvas');
  c.width = w * k; c.height = h * k;
  const g = c.getContext('2d');
  g.scale(k, k);
  g.font = `${LABEL_FONT} ${font}`; g.textAlign = 'center'; g.textBaseline = 'top'; g.lineJoin = 'round';
  g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(text, w / 2, 1);
  g.fillStyle = '#fff'; g.fillText(text, w / 2, 1);
  c.w = w; c.h = h;
  if (labelCache.size > 2000) labelCache.clear();
  labelCache.set(text, c);
  return c;
}

// source() -> {items: [{x, z, icon, color, label, pin, open(latlng)}], lines: [[x1, z1, x2, z2]], labels: bool}
export class MarkerCanvas extends L.Layer {
  constructor(source, opts = {}) {
    super();
    this.source = source;
    this.hover = null;
    this.useGL = !!opts.gl;
  }

  onAdd(map) {
    if (this.useGL) this.gl = new MarkerGL(this).addTo(map);
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
    if (this.gl) { this.gl.changed(); return; }   // drawn in the WebGL canvas (MarkerGL)
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

    // icons grow in smoothly with zoom (like valheim.tools' badges), at any in-between size
    const placed = this.placed(), grow = Math.max(16, Math.min(26, 16 + (map.getZoom() - 2) * 4));
    g.imageSmoothingQuality = 'high';
    for (const { it, p } of placed) {
      const px = it.pin ? 18 : grow;
      const im = iconImage(it.icon, it.color, redraw);
      if (!im) continue;
      // markers sit centred on their spot, pins stand on it
      const pad = px * im.padShare, x = p.x - px / 2 - pad, y = (it.pin ? p.y - px : p.y - px / 2) - pad;
      g.drawImage(im, x, y, px + pad * 2, px + pad * 2);
    }

    // labels: under the icon, white with a dark edge; one that would overlap a label already
    // shown is left out (hovering its icon shows it), and none below zoom 4 but the hovered one
    const showAll = this.src.labels && map.getZoom() >= 4, taken = [];
    const label = (it, p, force) => {
      if (!it.label) return;
      const im = labelImage(it.label, this.font), top = it.pin ? p.y + 1 : p.y + grow / 2;
      const r = { x0: p.x - im.w / 2, x1: p.x + im.w / 2, y0: top, y1: top + 14 };
      if (!force && taken.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) return;
      taken.push(r);
      g.drawImage(im, p.x - im.w / 2, top, im.w, im.h);
      return true;
    };
    const hovered = this.hover && placed.find((q) => q.it === this.hover);
    if (hovered) label(hovered.it, hovered.p, true);
    // Which labels show is decided when the map is still and kept for a whole glide: decided
    // every frame, labels popped on and off as their neighbours shifted, which read as shaking.
    if (map._gliding && this.shown) {
      for (const { it, p } of placed) if (it !== this.hover && this.shown.has(it)) label(it, p, true);
    } else {
      this.shown = new Set();
      if (showAll) for (const { it, p } of placed) if (it !== this.hover && label(it, p, false)) this.shown.add(it);
    }
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

// The same markers drawn in the WebGL canvas with the map (layers/shapes.js), so they are in the
// very picture the map is: on a 2D canvas of their own the browser could show their new
// positions a frame after the map's, and during a zoom the icons trailed and then settled.
class MarkerGL extends L.Layer {
  constructor(owner) { super(); this.owner = owner; this.order = 11; this.tex = new WeakMap(); }
  onAdd(map) { this.sc = ShapesCanvas.for(map); this.sc.add(this); }
  onRemove() { this.sc.remove(this); }
  need() {}
  changed() { if (this.sc) this.sc.redraw(); }

  texture(gl, cv) {
    let t = this.tex.get(cv);
    if (t) return t;
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.set(cv, t);
    return t;
  }

  // an image whose top-left sits at canvas pixel (px, py), w x h pixels
  image(gl, p, v, cv, px, py, w, h) {
    gl.bindTexture(gl.TEXTURE_2D, this.texture(gl, cv));
    gl.uniform4f(p.u.u_rect, v.x + px / v.ppm, v.z - py / v.ppm, w / v.ppm, h / v.ppm);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  draw(gl, v, sc) {
    const o = this.owner, map = o._map, src = o.src || (o.src = o.source());
    if (!map || !src) return;
    const toPx = (x, z) => [(x - v.x) * v.ppm, (v.z - z) * v.ppm];
    const W = (v.x1 - v.x) * v.ppm, H = (v.z - v.z0) * v.ppm, redraw = () => sc.redraw();

    // portal lines, dashed, under the icons
    if (src.lines.length) {
      const p = sc.line;
      sc.setView(p);
      gl.bindVertexArray(sc.quadVao);
      const c = parseInt(colors.portal.slice(1), 16);
      gl.uniform3f(p.u.u_color, (c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
      gl.uniform1f(p.u.u_width, 1.5); gl.uniform1f(p.u.u_on, 4); gl.uniform1f(p.u.u_off, 6); gl.uniform1f(p.u.u_alpha, 0.6);
      for (const [x1, z1, x2, z2] of src.lines) { gl.uniform2f(p.u.u_a, x1, z1); gl.uniform2f(p.u.u_b, x2, z2); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
    }

    const p = sc.tex;
    sc.setView(p);
    gl.bindVertexArray(sc.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.u_tex, 0);
    gl.uniform4f(p.u.u_uv, 0, 0, 1, 1);
    gl.uniform1f(p.u.u_alpha, 1);
    const grow = Math.max(16, Math.min(26, 16 + (v.zoom - 2) * 4));
    const placed = [];
    for (const it of src.items) {
      const [x, y] = toPx(it.x, it.z);
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      placed.push({ it, x, y });
      const px = it.pin ? 18 : grow, im = iconImage(it.icon, it.color, redraw);
      if (!im) continue;
      const pad = px * im.padShare;
      this.image(gl, p, v, im, x - px / 2 - pad, (it.pin ? y - px : y - px / 2) - pad, px + pad * 2, px + pad * 2);
    }

    // labels, with the same rules as the 2D canvas: hovered first, overlaps left out, none below
    // zoom 4, and the shown set kept for a whole glide
    const taken = [], font = o.font;
    const label = (it, x, y, force) => {
      if (!it.label) return false;
      const im = labelImage(it.label, font), top = it.pin ? y + 1 : y + grow / 2;
      const r = { x0: x - im.w / 2, x1: x + im.w / 2, y0: top, y1: top + 14 };
      if (!force && taken.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) return false;
      taken.push(r);
      this.image(gl, p, v, im, x - im.w / 2, top, im.w, im.h);
      return true;
    };
    const hovered = o.hover && placed.find((q) => q.it === o.hover);
    if (hovered) label(hovered.it, hovered.x, hovered.y, true);
    if (map._gliding && this.shown) {
      for (const q of placed) if (q.it !== o.hover && this.shown.has(q.it)) label(q.it, q.x, q.y, true);
    } else {
      this.shown = new Set();
      if (src.labels && v.zoom >= 4) for (const q of placed) if (q.it !== o.hover && label(q.it, q.x, q.y, false)) this.shown.add(q.it);
    }
    gl.bindVertexArray(null);
  }
}
