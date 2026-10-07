// Smooth, continuous zooming, like valheim.tools' map: every wheel movement nudges a target zoom
// and the map glides toward it a little each frame, keeping the point under the cursor in place.
// Leaflet's own wheel zoom jumps in steps and plays a 250 ms CSS stretch of the old picture,
// which is the stutter; here each frame is a real view at that zoom (the WebGL canvas redraws
// sharp every frame, see layers/shapes.js). The + / - buttons and double-click glide the same way.

const EASE = 0.22;   // share of the remaining distance covered per frame (~0.4 s to settle)

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
  constructor(map, pxPerLevel = 160) {
    this.map = map;
    this.pxPerLevel = pxPerLevel;   // wheel pixels per zoom level (a mouse notch is ~100-120)
    this.running = false;
    map.scrollWheelZoom.disable();
    map.doubleClickZoom.disable();
    map.getContainer().addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    map.on('dblclick', (e) => this.zoomTo(this.target() + (e.originalEvent.shiftKey ? -1 : 1), e.containerPoint));
    map.on('zoomstart', () => { if (!this.ownMove && this.running) this.running = false; });   // someone else zooms: give way
    this.frame = this.frame.bind(this);
  }

  target() { return this.running ? this.goal : this.map.getZoom(); }

  onWheel(e) {
    e.preventDefault();
    const d = L.DomEvent.getWheelDelta(e);   // pixels, positive = zoom in
    if (!d) return;
    this.zoomTo(this.target() + d / this.pxPerLevel, L.DomEvent.getMousePosition(e, this.map.getContainer()));
  }

  // glide to zoom z, keeping container point `at` (default: the centre) on the same spot of the world
  zoomTo(z, at) {
    const map = this.map;
    this.goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z));
    this.anchor = at || map.getSize().divideBy(2);
    this.anchorLatLng = map.containerPointToLatLng(this.anchor);
    if (this.running) return;
    this.running = true;
    map._stop();                 // end a pan glide that is still going
    this.ownMove = true; map._moveStart(true, false); this.ownMove = false;
    requestAnimationFrame(this.frame);
  }

  frame() {
    if (!this.running) return;
    const map = this.map, cur = map.getZoom();
    let z = cur + (this.goal - cur) * EASE;
    if (Math.abs(this.goal - z) < 0.002) z = this.goal;
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
