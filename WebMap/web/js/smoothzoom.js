// Smooth, continuous zooming, like valheim.tools' map: every wheel movement nudges a target zoom
// and the map glides toward it a little each frame, keeping the point under the cursor in place.
// Leaflet's own wheel zoom jumps in steps and plays a 250 ms CSS stretch of the old picture,
// which is the stutter; here each frame is a real view at that zoom (the WebGL canvas redraws
// sharp every frame, see layers/shapes.js). The + / - buttons and double-click glide the same way.

// The zoom follows the wheel's target like a critically damped spring (Unity's SmoothDamp): its
// speed changes smoothly. It used to close a share of the remaining distance each frame, so every
// wheel notch made the speed jump at once and then die away: with a notched wheel the zoom
// surged and slowed, notch by notch, a fine judder even when every frame was on time.
const SMOOTH_S = 0.11;   // seconds: about how long the zoom lags behind the wheel (~0.4 s to settle)

// Leaflet rounds marker positions to whole pixels; while the map glides smoothly underneath, that
// made icons and labels wobble by up to half a pixel. During a glide they move by fractions of a
// pixel too, and snap back to whole pixels (crisp text) when it stops.
L.Marker.include({
  update() {
    if (this._icon && this._map) {
      const pos = this._map.latLngToLayerPoint(this._latlng);
      this._setPos(this._map._gliding ? pos : pos.round());
    }
    return this;
  },
});

export class SmoothZoom {
  constructor(map, pxPerLevel = 160, exact = false) {
    this.map = map;
    this.exact = exact;
    map._smooth = this;
    // Leaflet keeps the map's pixel origin on whole pixels, so on a glide around the cursor the
    // whole map stepped by up to half a pixel from frame to frame: a fine shake. Nothing needs
    // whole pixels once the map is drawn in WebGL (exact: the WebGL map is in use), so keep it exact.
    if (exact) map._getNewPixelOrigin = function (center, zoom) {
      return this.project(center, zoom)._subtract(this.getSize()._divideBy(2))._add(this._getMapPanePos());
    };
    this.pxPerLevel = pxPerLevel;   // wheel pixels per zoom level (a mouse notch is ~100-120)
    this.running = false;
    map.scrollWheelZoom.disable();
    map.doubleClickZoom.disable();
    map.getContainer().addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    map.on('dblclick', (e) => this.zoomTo(this.target() + (e.originalEvent.shiftKey ? -1 : 1), e.containerPoint));
    map.on('zoomstart', () => { if (!this.ownMove && this.running) this.running = false; });   // someone else zooms: give way
    map.on('dragstart', () => this.endGlide());   // grabbing the map stops a fly-to
    this.frame = this.frame.bind(this);
  }

  target() { return this.running ? this.goal : this.map.getZoom(); }

  onWheel(e) {
    e.preventDefault();
    const d = L.DomEvent.getWheelDelta(e);   // pixels, positive = zoom in
    if (!d) return;
    this.zoomTo(this.target() + d / this.pxPerLevel, L.DomEvent.getMousePosition(e, this.map.getContainer()));
  }

  // Fly to a spot and zoom (a marker clicked in a list, search, home), redrawn sharp each frame
  // like a wheel zoom. Leaflet's animated setView stretched the old picture, icons and all, so
  // markers swelled up and then snapped back to their size.
  glideTo(latlng, zoom, ms = 550) {
    const map = this.map;
    zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoom ?? map.getZoom()));
    if (!this.exact) { map.setView(latlng, zoom, { animate: true }); return; }   // the plain map: Leaflet's own is fine there
    this.endGlide();
    this.running = false;
    map._stop();
    const from = map.getCenter(), z0 = map.getZoom(), to = L.latLng(latlng);
    if (from.equals(to) && Math.abs(z0 - zoom) < 0.001) return;
    const start = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    this.ownMove = true; map._moveStart(Math.abs(z0 - zoom) > 0.001, false); this.ownMove = false;
    this.flying = true;
    const step = (now) => {
      if (!this.flying) return;
      const t = Math.min(1, (now - start) / ms), e = ease(t);
      const c = L.latLng(from.lat + (to.lat - from.lat) * e, from.lng + (to.lng - from.lng) * e);
      this.ownMove = true;
      map._gliding = true;
      map._move(c, z0 + (zoom - z0) * e);
      if (map._shapesCanvas) map._shapesCanvas.reset();
      this.ownMove = false;
      if (t >= 1) this.endGlide(); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  endGlide() {
    if (!this.flying) return;
    this.flying = false;
    const map = this.map;
    map._gliding = false;
    if (map._shapesCanvas) map._shapesCanvas.redraw();
    map.eachLayer((l) => { if (l instanceof L.Marker) l.update(); });
    map._moveEnd(true);
  }

  // glide to zoom z, keeping container point `at` (default: the centre) on the same spot of the world
  zoomTo(z, at) {
    const map = this.map;
    this.endGlide();   // a wheel turn takes over from a fly-to
    this.goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z));
    this.anchor = at || map.getSize().divideBy(2);
    this.anchorLatLng = map.containerPointToLatLng(this.anchor);
    if (this.running) return;
    this.running = true;
    this.vel = 0;                // zoom levels per second
    map._stop();                 // end a pan glide that is still going
    this.ownMove = true; map._moveStart(true, false); this.ownMove = false;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  frame(now) {
    if (!this.running) return;
    const map = this.map, cur = map.getZoom();
    const dt = Math.min(64, Math.max(0, now - this.last)) / 1000; this.last = now;
    const w = 2 / SMOOTH_S, x = w * dt, k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const off = cur - this.goal, t = (this.vel + w * off) * dt;
    this.vel = (this.vel - w * t) * k;
    let z = this.goal + (off + t) * k;
    if (Math.abs(this.goal - z) < 0.002 && Math.abs(this.vel) < 0.05) z = this.goal;
    z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z));   // reversing mid-glide can carry a spring a hair past a limit
    const size = map.getSize();
    const centre = map.unproject(map.project(this.anchorLatLng, z).subtract(this.anchor.subtract(size.divideBy(2))), z);
    this.ownMove = true;
    map._gliding = true;
    map._move(centre, z);
    if (map._shapesCanvas) map._shapesCanvas.reset();   // sharp at this exact zoom, in this frame
    this.ownMove = false;
    if (z === this.goal) {
      this.running = false;
      map._gliding = false;
      if (map._shapesCanvas) map._shapesCanvas.redraw();   // all of the canvas again, padding included
      map.eachLayer((l) => { if (l instanceof L.Marker) l.update(); });   // back on whole pixels
      map._moveEnd(true);
      return;
    }
    requestAnimationFrame(this.frame);
  }
}

// + / - buttons that glide one level
export const SmoothZoomControl = L.Control.Zoom.extend({
  _zoomIn(e) { if (!this._disabled) this.options.smooth.zoomTo(this.options.smooth.target() + 1); L.DomEvent.stop(e); },
  _zoomOut(e) { if (!this._disabled) this.options.smooth.zoomTo(this.options.smooth.target() - 1); L.DomEvent.stop(e); },
});
