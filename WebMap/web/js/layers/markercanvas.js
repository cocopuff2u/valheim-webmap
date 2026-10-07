// Map markers, their labels and the portal lines, painted on one canvas over the map, redrawn in
// the same event that moves the map (the way valheim.tools draws its pins). With a Leaflet DOM
// element per marker, a zoom or drag moved hundreds of elements each frame, and they could sit a
// frame or half a pixel off the map underneath. Hover and click find the nearest icon.

import { iconSvg, colors } from '../icons.js';
import { ShapesCanvas } from './shapes.js';

const LABEL_FONT = '600 11px';
const iconCache = new Map();   // "name|color" -> canvas with the icon and its drop shadow, or 'loading'
const LABEL_FADE_MS = 180;
const SETTLE_MS = 400;         // labels come in only after the map has been still this long
const ICON_RES = 72;           // each icon is rendered once this big and drawn scaled to any size:
                               // whole-pixel sizes stepped visibly as icons grew during a zoom

// name: one of our SVG icons, or img: the URL of one of the game's own map icons (World/MapIcons),
// which get a dark round badge with a ring in the marker's colour behind them
function iconImage(name, color, onReady, img) {
  const key = img ? `${img}|${color}` : `${name}|${color}`;
  const c = iconCache.get(key);
  if (c && c !== 'loading') return c;
  if (!c) {
    iconCache.set(key, 'loading');
    const im = new Image();
    im.onload = () => {
      const k = ICON_RES / 26, pad = 4 * k;   // shadow and padding in proportion to a 26 px icon
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.ceil(ICON_RES + pad * 2);
      const g = cv.getContext('2d');
      g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 2 * k; g.shadowOffsetY = 1 * k;   // like the old CSS drop-shadow
      let box = ICON_RES;
      if (img) {
        const c = pad + ICON_RES / 2, r = ICON_RES / 2 - 2 * k;
        g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2);
        g.fillStyle = 'rgba(14,18,24,.82)'; g.fill();
        g.shadowColor = 'transparent';
        g.lineWidth = 2 * k; g.strokeStyle = color || '#c8cdd6'; g.stroke();
        g.shadowColor = 'rgba(0,0,0,.8)';
        box = ICON_RES * 0.62;   // the icon inside the ring
      }
      // fit inside the box, keeping the shape (the game's icons aren't all square)
      const s = box / Math.max(im.naturalWidth || box, im.naturalHeight || box);
      const w = (im.naturalWidth || box) * s, h = (im.naturalHeight || box) * s;
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, pad + (ICON_RES - w) / 2, pad + (ICON_RES - h) / 2, w, h);
      cv.padShare = pad / ICON_RES;
      iconCache.set(key, cv);
      onReady();
    };
    im.onerror = () => iconCache.delete(key);
    im.src = img || 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(name, color).replace('<svg ', `<svg width="${ICON_RES}" height="${ICON_RES}" `));
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
    for (let i = placed.length - 1; i >= 0; i--) {   // last-first: the list's first end up on top (as in MarkerGL)
      const { it, p } = placed[i];
      const px = it.pin ? 18 : grow;
      const im = iconImage(it.icon, it.color, redraw, it.img);
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
    if (this._map.dragging && this._map.dragging.moving()) return;   // passing over icons mid-drag isn't hovering
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
  onAdd(map) {
    this.sc = ShapesCanvas.for(map); this.sc.add(this);
    // any zoom (wheel glide, pinch, keyboard): labels hold until it ends, then get re-decided
    map.on('zoomstart', () => { this.zooming = true; }, this);
    map.on('zoomend', () => { this.zooming = false; this.zoomEndAt = performance.now(); this.changed(); }, this);
  }
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
      gl.uniform1f(p.u.u_zoom, v.zoom); gl.uniform1f(p.u.u_ppm, v.ppm);
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
    }
    // drawn last-first, so the first in the list (pins, spawn, bosses...) end up on top, the same
    // order that wins the labels; a base built on an altar no longer hides the altar
    for (let i = placed.length - 1; i >= 0; i--) {
      const { it, x, y } = placed[i];
      const px = it.pin ? 18 : grow, im = iconImage(it.icon, it.color, redraw, it.img);
      if (!im) continue;
      const pad = px * im.padShare;
      this.image(gl, p, v, im, x - px / 2 - pad, (it.pin ? y - px : y - px / 2) - pad, px + pad * 2, px + pad * 2);
    }

    // Labels fade in and out (MapLibre does this with its symbols): which ones may show is worked
    // out every frame, labels already showing keep their place first so a neighbour shifting a
    // little doesn't knock them out, and each eases toward shown or hidden over LABEL_FADE_MS.
    // Hovered first; none below zoom 4 (they fade out there too).
    const now = performance.now(), dt = this.lastLabel ? Math.min(100, now - this.lastLabel) : 1000;
    this.lastLabel = now;
    if (!this.alpha) this.alpha = new Map();
    // Labels are tracked by name and spot, not by object: the marker list is rebuilt after every
    // sweep, and new objects looked like new labels that faded in again (random flashes).
    const key = (it) => `${it.label}|${Math.round(it.x)}|${Math.round(it.z)}`;
    const want = new Set(), taken = [], font = o.font;
    // pad: room a label needs around it. A label showing stays until it really overlaps (-2 px);
    // a hidden one comes in only with clear space (+6 px). One on the edge can't bounce.
    const fits = (q, pad = 0) => {
      if (!q.it.label) return false;
      const im = labelImage(q.it.label, font), top = q.it.pin ? q.y + 1 : q.y + grow / 2;
      const r = { x0: q.x - im.w / 2, x1: q.x + im.w / 2, y0: top, y1: top + 14 };
      if (taken.some((t) => r.x0 - pad < t.x1 && r.x1 + pad > t.x0 && r.y0 - pad < t.y1 && r.y1 + pad > t.y0)) return false;
      taken.push(r);
      return true;
    };
    const KEEP = -2, ENTER = 6;
    // While the map is still, labels are chosen in priority order (the ones already showing
    // first). During a zoom, labels may only drop out, never come in: one that comes to overlap a
    // label above it fades out at once (two labels on top of each other looked undecided), and
    // new ones are chosen when the zoom settles. Nothing flips back and forth.
    const hovered = o.hover && placed.find((q) => q.it === o.hover);
    // labels come in only once the map has been still a moment: a slow wheel is many tiny zooms,
    // and settling after each one made labels on the edge flash
    const settled = !(map._gliding || this.zooming) && now - (this.zoomEndAt || 0) > SETTLE_MS;
    // spawn and boss names always show and claim their space first
    for (const q of placed) if (q.it.always && q.it.label && src.labels) { fits(q); want.add(key(q.it)); }
    if (!settled && this.want) {
      for (const q of placed) if (!q.it.always && this.want.has(key(q.it)) && fits(q, KEEP)) want.add(key(q.it));
      this.want = want;
      if (!(map._gliding || this.zooming) && !this.settleTimer)
        this.settleTimer = setTimeout(() => { this.settleTimer = null; this.changed(); }, SETTLE_MS);
    } else {
      if (src.labels && v.zoom >= 4) {
        const shown = (q) => (this.alpha.get(key(q.it)) || 0) > 0.5;
        for (const q of placed) if (!q.it.always && shown(q) && fits(q, KEEP)) want.add(key(q.it));
        for (const q of placed) if (!q.it.always && !shown(q) && fits(q, ENTER)) want.add(key(q.it));
      }
      this.want = want;
    }
    let animating = false;
    const step = dt / LABEL_FADE_MS;
    for (const q of placed) {
      const k = key(q.it), cur = this.alpha.get(k) || 0, target = want.has(k) ? 1 : 0;
      const a = target > cur ? Math.min(1, cur + step) : Math.max(0, cur - step);
      if (a !== target) animating = true;
      if (a > 0) this.alpha.set(k, a); else this.alpha.delete(k);
      if (a <= 0 || !q.it.label) continue;
      const im = labelImage(q.it.label, font), top = q.it.pin ? q.y + 1 : q.y + grow / 2;
      gl.uniform1f(p.u.u_alpha, a);
      this.image(gl, p, v, im, q.x - im.w / 2, top, im.w, im.h);
    }
    // the hovered marker's label, on top, without moving anyone else's
    if (hovered && hovered.it.label && !want.has(key(hovered.it))) {
      const im = labelImage(hovered.it.label, font), top = hovered.it.pin ? hovered.y + 1 : hovered.y + grow / 2;
      gl.uniform1f(p.u.u_alpha, 1);
      this.image(gl, p, v, im, hovered.x - im.w / 2, top, im.w, im.h);
    }
    gl.uniform1f(p.u.u_alpha, 1);
    if (animating) sc.redraw();
    gl.bindVertexArray(null);
  }
}
