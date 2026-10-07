// The map's coordinate system: the same numbers as the server's TileMath.
//
// Leaflet's "lat/lng" is used as (z, x) in Valheim world metres: north (+z)
// is up. Zoom MAX_ZOOM is one pixel per metre, matching the tile pyramid;
// zooms above it are just the max-zoom tiles scaled up by the browser.

export const WORLD_SIZE = 20480;
export const WORLD_HALF = WORLD_SIZE / 2;
export const MAX_ZOOM = 7;       // native tile zoom (1 m/px)
export const OVER_ZOOM = 10;     // how far the browser may zoom past native
export const TILE = 256;
export const WORLD_RADIUS = 10000;

export const ValheimCRS = L.extend({}, L.CRS.Simple, {
  // LonLat with its own bounds: Leaflet's stock LonLat projection is bounded to
  // +-180/90, which would clip the tile grid to a few tiles around the origin.
  projection: L.extend({}, L.Projection.LonLat, { bounds: L.bounds([-WORLD_HALF, -WORLD_HALF], [WORLD_HALF, WORLD_HALF]) }),
  transformation: new L.Transformation(1, WORLD_HALF, -1, WORLD_HALF),
  scale(zoom) { return Math.pow(2, zoom - MAX_ZOOM); },
  zoom(scale) { return Math.log(scale) / Math.LN2 + MAX_ZOOM; },
  infinite: false,
});

export const worldBounds = L.latLngBounds([-WORLD_HALF, -WORLD_HALF], [WORLD_HALF, WORLD_HALF]);

export function toLatLng(x, z) { return L.latLng(z, x); }
export function fromLatLng(ll) { return { x: ll.lng, z: ll.lat }; }
export function metersPerPixel(zoom) { return Math.pow(2, MAX_ZOOM - zoom); }
export function fmt(n) { return (Math.round(n * 10) / 10).toFixed(1); }
export function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

export function chunkOf(w) { return Math.floor((w + WORLD_HALF) / 256); }
export function chunkMin(c) { return -WORLD_HALF + c * 256; }

// The chunks under the view one zoom step out (twice the width and height): what zooming out
// will need. Layers fetch them while the map sits still, so the new edge isn't bare.
export function chunksOneZoomOut(map) {
  const b = map.getBounds().pad(0.5), out = [];
  const x0 = Math.max(0, chunkOf(b.getWest())), x1 = Math.min(79, chunkOf(b.getEast()));
  const z0 = Math.max(0, chunkOf(b.getSouth())), z1 = Math.min(79, chunkOf(b.getNorth()));
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) out.push([cx, cz]);
  return out;
}
