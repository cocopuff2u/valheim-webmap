// Entry point: builds the map, wires the layers to the server, and owns the
// bits of UI that are not the sidebar (search, permalink, 2D/3D switch).

import { ValheimCRS, worldBounds, toLatLng, fromLatLng, MAX_ZOOM, OVER_ZOOM, TILE, WORLD_HALF, WORLD_RADIUS, metersPerPixel } from './crs.js';
import { connect, on, state, getJSON } from './net.js';
import { FallbackTileLayer, BaseWorldImage } from './layers/tiles.js';
import { VegLayer, VEG_SHAPES_ZOOM } from './layers/veg.js';
import { PlayerCard } from './playercard.js';
import { FogLayer } from './layers/fog.js';
import { StructuresLayer } from './layers/structures.js';
import { RuinsLayer } from './layers/ruins.js';
import { webgl2Available, TreesGL, RuinsGL, BuildingsGL } from './layers/shapes.js';
import { GroundGL, FogGL, WorldEdgeGL } from './layers/ground.js';
import { MarkerLayers, escape } from './layers/markers.js';
import { PlayersLayer } from './layers/players.js';
import { chunks, objects, prefabs, markers, stats } from './data.js';
import { Sidebar } from './ui.js';

const $ = (s) => document.querySelector(s);

class App {
  constructor() {
    this.config = null;
    this.mode = '2d';
    this.view3d = null;
    this.root = $('#app');
    this.map = L.map('map', {
      crs: ValheimCRS, minZoom: 0, maxZoom: OVER_ZOOM, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
      maxBounds: worldBounds.pad(0.25), maxBoundsViscosity: 0.6, zoomControl: true, attributionControl: false,
      preferCanvas: true, worldCopyJump: false, inertia: true,
    });
    this.layers = {};
    // zoom out no further than the whole world circle on the screen (again after a resize)
    const fitWorld = () => {
      const z = this.map.getBoundsZoom(L.latLngBounds([-WORLD_RADIUS, -WORLD_RADIUS], [WORLD_RADIUS, WORLD_RADIUS]), false, L.point(24, 110));   // room for the top bar
      this.map.setMinZoom(Math.floor(z * 4) / 4);
    };
    fitWorld();
    this.map.on('resize', fitWorld);
    this.gl = webgl2Available();
    // Blurry whole world under the map, for the edges of a fast zoom-out. Under the WebGL map it is
    // fogged in the page first (the fog there only covers the canvas), see start().
    // updateWhenZooming false: during a zoom the tiles on screen just scale, in step with the shapes on
    // the GPU canvas; a level Leaflet creates mid-animation started its transition a frame late, and
    // the ground slid under the trees by up to ~30 px. The new zoom's tiles come right after (mostly
    // from the browser cache), with the blurry world image under any edge for that moment.
    // the map tiles: in the WebGL canvas with everything else when the browser can (layers/ground.js)
    this.layers.tiles = (this.gl ? new GroundGL('tiles/map/{z}/{x}/{y}.png')
      : new FallbackTileLayer('tiles/map/{z}/{x}/{y}.png', { zIndex: 100, edgeBufferTiles: 1, prefetchZoomOut: 1, updateWhenZooming: false })).addTo(this.map);
    // Tree crowns and rocks over the ground (the 3D view uses the clean ground tiles). Trees, buildings and world structures on the GPU when the browser can (see shapes.js): there
    // the trees at every zoom come from the vegetation data and no tree tiles are loaded at all.
    if (this.gl) this.layers.veg = L.layerGroup([new TreesGL()]).addTo(this.map);
    else {
      this.vegTiles = new FallbackTileLayer('tiles/veg/{z}/{x}/{y}.png', { zIndex: 101, minNative: 5, className: 'maptiles vegtiles', prefetchZoomOut: 2 });
      const vegShapes = new VegLayer();
      this.layers.veg = L.layerGroup([this.vegTiles, vegShapes]).addTo(this.map);
      this.vegHandOff(vegShapes);
    }
    this.gridLayer = null;
    this.hoverTip = L.tooltip({ direction: 'top', offset: [0, -8], opacity: 0.95 });
    this.map.on('zoomend', () => this.onZoom());
    this.map.on('moveend', () => this.updateHash());
    this.map.on('mousemove', (e) => this.onMouseMove(e));
    this.map.on('click', () => this.hideSearch());
    this.pendingMove = null;
  }

  // the fallback's gray past the world's edge: a huge square with the world circle cut out
  addWorldEdgeMask() {
    const R = WORLD_RADIUS, far = R * 4, ring = [];
    for (let i = 0; i < 180; i++) { const a = (i / 180) * Math.PI * 2; ring.push(toLatLng(Math.cos(a) * R, Math.sin(a) * R)); }
    this.map.createPane('edgePane').style.zIndex = 450;   // over the fog overlay, under markers
    L.polygon([[[-far, -far], [-far, far], [far, far], [far, -far]], ring],
      { pane: 'edgePane', stroke: false, fillColor: '#40454d', fillOpacity: 1, interactive: false, renderer: L.svg({ padding: 1, pane: 'edgePane' }) }).addTo(this.map);
  }

  // the canvas fallback's tree hand-off: baked tiles up to 7.5, shapes past it
  vegHandOff(vegShapes) {
    const showVegTiles = (on) => { const el = this.vegTiles.getContainer(); if (el) el.style.opacity = on ? '' : 0; };
    const shapesReady = () => this.map.getZoom() >= VEG_SHAPES_ZOOM && vegShapes._map && vegShapes.isReady();
    this.map.on('zoomanim', (e) => { if (e.zoom < VEG_SHAPES_ZOOM) showVegTiles(true); });
    this.map.on('zoomend', () => showVegTiles(!shapesReady()));
    vegShapes.on('load', () => showVegTiles(!shapesReady()));
    this.vegTiles.on('add', () => showVegTiles(!shapesReady()));
  }

  // ?fps=1: a small readout of frames per second and the slowest frame over the last 2 s,
  // to check smoothness on a real machine (the test browser here has no GPU)
  showFps() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;background:#000a;color:#fff;font:12px monospace;padding:4px 6px;border-radius:4px;pointer-events:none';
    document.body.append(el);
    let last = performance.now(), frames = 0, worst = 0, t0 = last;
    const tick = (now) => {
      frames++; worst = Math.max(worst, now - last); last = now;
      if (now - t0 >= 2000) { el.textContent = `${Math.round(frames * 1000 / (now - t0))} fps · slowest ${Math.round(worst)} ms`; frames = 0; worst = 0; t0 = now; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async start() {
    if (/[?&]fps=1\b/.test(location.search)) this.showFps();
    this.config = await getJSON('config').catch(() => ({}));
    this.applyConfig(this.config);
    this.layers.fog = new FogLayer(this.map, this.config, { gl: this.gl });
    // gray past the world's edge, over the fog (which stays black inside the circle)
    if (this.gl) { new FogGL(this.layers.fog).addTo(this.map); new WorldEdgeGL(WORLD_RADIUS).addTo(this.map); }
    else this.addWorldEdgeMask();
    this.baseImage = new BaseWorldImage(this.map, 'tiles/map/{z}/{x}/{y}.png', this.gl ? { fog: this.layers.fog, radius: WORLD_RADIUS } : {});
    this.layers.ruins = (this.gl ? new RuinsGL() : new RuinsLayer()).addTo(this.map);   // world-generated structures, under player builds
    this.layers.structures = (this.gl ? new BuildingsGL() : new StructuresLayer()).addTo(this.map);
    this.layers.markers = new MarkerLayers(this.map);
    // right click (long press on a phone) places a pin, unless the server turned web pins off
    this.map.on('contextmenu', (e) => { if (this.config?.web_pins !== false) this.layers.markers.openPinEditor(e.latlng); });
    this.layers.players = new PlayersLayer(this.map);
    this.layers.players.onFollow = (id) => { if (this.view3d) this.view3d.follow(id); };
    this.sidebar = new Sidebar(this);
    this.layers.players.onChange((ps) => { this.sidebar.renderPlayers(ps); if (this.view3d) this.view3d.setPlayers(ps); });
    this.bindUi();
    if (!this.applyHash()) this.goToSpawn(false);
    this.onZoom();
    this.layers.fog.start();   // reveals live from player positions, refetches the mask every few minutes
    chunks.refreshIndex();
    if (this.config.enable_3d !== false) { objects.refreshIndex(); prefabs.refresh(); }   // 3D-only data
    markers.refresh();
    stats.refresh();
    connect();
    on('hello', (f) => { if (f.config) { this.config = f.config; this.applyConfig(f.config); } });
    on('connection', (ok) => { $('#conn').hidden = ok; });
    on('tiles', (f) => { $('#render-status').textContent = f.status ? `tiles ${f.status}` : ''; });
    setInterval(() => { if (this.sidebar.active === 'stats') stats.refresh(); }, 30000);
    if (matchMedia('(max-width: 720px)').matches) this.toggleSidebar(false);
  }

  applyConfig(c) {
    if (!c) return;
    $('#title').textContent = c.title || 'Valheim';
    document.title = `${c.title || 'Valheim'} · WebMap`;
    if (c.world_name) $('#subtitle').textContent = c.world_name;
    $('#btn-mode').disabled = c.enable_3d === false;
    // with 3D off, hide what only works with it (inline style: CSS display would override `hidden`)
    $('#btn-mode').style.display = c.enable_3d === false ? 'none' : '';
    $('#btn-export').style.display = c.enable_3d === false ? 'none' : '';
    if (c.world_start_pos && typeof c.world_start_pos === 'string') {
      const [x, y, z] = c.world_start_pos.split(',').map(Number);
      this.spawn = { x, z };
    }
  }

  bindUi() {
    $('#btn-menu').addEventListener('click', () => this.toggleSidebar());
    $('#btn-home').addEventListener('click', () => this.goToSpawn(true));
    $('#btn-mode').addEventListener('click', () => this.setMode(this.mode === '2d' ? '3d' : '2d'));
    this.playerCard = new PlayerCard(this);
    this.layers.players.onClick = (p, x, y) => this.playerCard.show(p, x, y);
    this.layers.players.onChange((list) => this.playerCard.update(list));
    $('#btn-export').addEventListener('click', () => this.openExport());
    $('#export-close').addEventListener('click', () => { $('#export-dialog').hidden = true; });
    $('#export-dialog').addEventListener('click', (e) => { if (e.target.id === 'export-dialog') e.target.hidden = true; });
    $('#export-form').addEventListener('submit', (e) => { e.preventDefault(); this.runExport(); });
    $('#btn-fullscreen').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); });
    $('#btn-link').addEventListener('click', async () => {
      this.updateHash();
      try { await navigator.clipboard.writeText(location.href); this.toast('Link copied'); } catch { this.toast(location.href); }
    });
    const search = $('#search');
    if (matchMedia('(max-width: 560px)').matches) search.placeholder = 'Search…';
    search.addEventListener('input', () => this.onSearch(search.value));
    search.addEventListener('focus', () => this.onSearch(search.value));
    search.addEventListener('keydown', (e) => {
      const res = $('#search-results');
      const items = [...res.querySelectorAll('button')];
      let i = items.findIndex((b) => b.classList.contains('active'));
      if (e.key === 'ArrowDown') { i = Math.min(items.length - 1, i + 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { i = Math.max(0, i - 1); e.preventDefault(); }
      else if (e.key === 'Enter') { (items[Math.max(0, i)] || {}).click?.(); return; }
      else if (e.key === 'Escape') { this.hideSearch(); search.blur(); return; }
      else return;
      items.forEach((b, k) => b.classList.toggle('active', k === i));
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === '/') { e.preventDefault(); search.focus(); return; }
      if (k === 'Escape') { this.layers.players.follow(null); this.playerCard?.hide(); return; }
      if (k === 'Home') { e.preventDefault(); this.goToSpawn(true); return; }
      if (k === 'm') { this.setMode(this.mode === '3d' ? '2d' : '3d'); return; }
      if (k === 'l') { this.toggleSidebar(); return; }
      if (k === 'p') { if (this.layers.players.following) this.layers.players.follow(null); else this.cyclePlayer(); return; }
      if (this.mode === '3d') return;   // the 3D view polls its own keys
      // 2D: WASD pans (arrows and +/- are Leaflet's own), Shift is fast
      const step = e.shiftKey ? 300 : 100;
      const pan = { w: [0, -step], s: [0, step], a: [-step, 0], d: [step, 0] }[k];
      if (pan) { e.preventDefault(); this.layers.players.follow(null); this.map.panBy(pan, { animate: true, duration: 0.15 }); }
    });
    window.addEventListener('hashchange', () => this.applyHash());
  }

  // P: follow the next player on the list (2D and 3D)
  cyclePlayer() {
    const PL = this.layers.players, list = PL.players.filter((p) => p.x !== undefined);
    if (list.length === 0) return;
    const i = list.findIndex((p) => p.id === this.lastCycled);
    const p = list[(i + 1) % list.length];
    this.lastCycled = p.id;
    PL.follow(p.id);
  }

  toggleSidebar(show) {
    const hidden = this.root.classList.contains('sidebar-hidden');
    const next = show === undefined ? hidden : show;
    this.root.classList.toggle('sidebar-hidden', !next);
    setTimeout(() => this.map.invalidateSize(), 220);
  }

  onZoom() {
    const z = this.map.getZoom();
    const c = this.map.getContainer();
    c.classList.toggle('zoom-lt-4', z < 4);
    c.classList.toggle('zoom-lt-3', z < 3);
    this.updateHash();
  }

  // ---------------------------------------------------------------- navigation
  goTo(x, z, zoom) {
    if (this.mode === '3d' && this.view3d) { this.view3d.lookAt(x, z); return; }
    this.layers.players.follow(null);
    this.map.setView(toLatLng(x, z), zoom ?? this.map.getZoom(), { animate: true });
  }

  goToSpawn(animate) {
    const s = this.spawn || { x: 0, z: 0 };
    if (this.mode === '3d' && this.view3d) { this.view3d.lookAt(s.x, s.z); return; }
    this.map.setView(toLatLng(s.x, s.z), 4, { animate });
  }

  // #x,z,zoom for 2D; #x,z,zoom,3d,dist,heading,tilt for 3D (zoom is the 2D zoom the same
  // camera distance would give, so the link still lands about right in 2D)
  updateHash() {
    if (this.hashLock) return;
    let h;
    if (this.mode === '3d' && this.view3d) {
      const p = this.view3d.pose();
      const zoom = Math.min(7, Math.max(0, 3 + Math.log2(3200 / p.dist)));
      h = `#${p.x.toFixed(0)},${p.z.toFixed(0)},${zoom.toFixed(2)},3d,${p.dist.toFixed(0)},${p.yaw.toFixed(0)},${p.pitch.toFixed(0)}`;
    } else {
      const c = fromLatLng(this.map.getCenter());
      h = `#${c.x.toFixed(0)},${c.z.toFixed(0)},${this.map.getZoom().toFixed(2)}`;
    }
    if (location.hash !== h) { try { history.replaceState(null, '', h); } catch { /* browser rate limit */ } }
  }

  applyHash() {
    const m = /^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(3d)(?:,(\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?))?)?/.exec(location.hash);
    if (!m) return false;
    this.hashLock = true;
    this.map.setView(toLatLng(+m[1], +m[2]), +m[3], { animate: false });
    const pose = m[4] ? { x: +m[1], z: +m[2], zoom: +m[3], ...(m[5] !== undefined ? { dist: +m[5], yaw: +m[6], pitch: +m[7] } : {}) } : null;
    if (pose && this.mode === '3d' && this.view3d) this.view3d.setPose(pose.dist !== undefined ? pose : { x: pose.x, z: pose.z, dist: 3200 / Math.pow(2, pose.zoom - 3), yaw: 30, pitch: 47 });
    this.hashLock = false;
    if (pose && this.mode !== '3d') { this.pendingPose = pose; this.setMode('3d'); }
    else if (!pose && this.mode === '3d') this.setMode('2d');
    return true;
  }

  // ---------------------------------------------------------------- hover
  onMouseMove(e) {
    const p = fromLatLng(e.latlng);
    $('#coords').textContent = `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`;
    if (this.map.getZoom() < 6 || !this.map.hasLayer(this.layers.structures)) { this.hideHover(); return; }
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(async () => {
      const hits = await this.layers.structures.pick(p.x, p.z, metersPerPixel(this.map.getZoom()) * 3);
      if (!hits.length) { this.hideHover(); return; }
      const h = hits[0];
      const more = hits.length > 1 ? `<br><small>+${hits.length - 1} more piece${hits.length > 2 ? 's' : ''} here</small>` : '';
      this.hoverTip.setLatLng(e.latlng).setContent(`<b>${escape(h.prefab)}</b><br><small>${escape(h.material)} · y ${h.y.toFixed(0)}</small>${more}`);
      if (!this.hoverTip._map) this.hoverTip.addTo(this.map);
    }, 60);
  }
  hideHover() { clearTimeout(this.hoverTimer); if (this.hoverTip._map) this.hoverTip.remove(); }

  // ---------------------------------------------------------------- search
  onSearch(q) {
    const res = $('#search-results');
    q = (q || '').trim();
    if (!q) { res.hidden = true; return; }
    const out = [];
    const coord = /^(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)$/.exec(q);
    if (coord) out.push({ kind: 'Coordinates', label: `${coord[1]}, ${coord[2]}`, x: +coord[1], z: +coord[2] });
    const ql = q.toLowerCase();
    for (const p of this.layers.players.players) if (p.name.toLowerCase().includes(ql) && p.x !== undefined) out.push({ kind: 'Player', label: p.name, x: p.x, z: p.z, player: p.id });
    for (const m of this.layers.markers.all()) if ((m.label || '').toLowerCase().includes(ql) || (m.kind || '').toLowerCase() === ql) out.push(m);
    res.replaceChildren();
    for (const r of out.slice(0, 30)) {
      const b = document.createElement('button');
      b.innerHTML = `<span>${escape(r.label)}</span><span class="kind">${escape(r.kind)} · ${Math.round(r.x)}, ${Math.round(r.z)}</span>`;
      b.addEventListener('click', () => { this.goTo(r.x, r.z, Math.max(this.map.getZoom(), 6)); if (r.player) this.layers.players.follow(r.player); this.hideSearch(); });
      res.append(b);
    }
    if (!out.length) res.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No matches' }));
    res.hidden = false;
  }
  hideSearch() { $('#search-results').hidden = true; }

  // ---------------------------------------------------------------- grid
  setGrid(v) {
    if (v && !this.gridLayer) {
      this.gridLayer = new (L.GridLayer.extend({
        createTile(coords) {
          const c = document.createElement('canvas'); c.width = TILE; c.height = TILE;
          const ctx = c.getContext('2d');
          const span = TILE * metersPerPixel(coords.z);
          if (span <= 256) {
            // chunk lines fall on tile borders at zoom >= 7; draw the border
            ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
          } else {
            const n = span / 256, step = TILE / n;
            ctx.strokeStyle = 'rgba(255,255,255,.18)';
            for (let i = 0; i <= n; i++) { ctx.beginPath(); ctx.moveTo(i * step + .5, 0); ctx.lineTo(i * step + .5, TILE); ctx.moveTo(0, i * step + .5); ctx.lineTo(TILE, i * step + .5); ctx.stroke(); }
          }
          const minX = -WORLD_HALF + coords.x * span, maxZ = WORLD_HALF - coords.y * span;
          ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '10px monospace';
          ctx.fillText(`${minX.toFixed(0)}, ${maxZ.toFixed(0)}`, 4, 12);
          return c;
        },
      }))({ tileSize: TILE, minZoom: 3, maxZoom: OVER_ZOOM, zIndex: 400, opacity: 1 });
    }
    if (this.gridLayer) { if (v) this.gridLayer.addTo(this.map); else this.gridLayer.remove(); }
  }

  // ---------------------------------------------------------------- 3D
  async ensureView3D() {
    if (this.view3d) return this.view3d;
    const { View3D } = await import('./view3d.js');
    this.view3d = new View3D($('#gl'), this.config);
    this.view3d.onUnfollow = () => this.layers.players.follow(null);
    this.view3d.onHome = () => this.goToSpawn(true);
    this.view3d.onView = () => this.updateHash();
    this.view3d.setPlayers(this.layers.players.players);
    this.view3d.setPins(this.layers.markers.pinList());
    this.layers.markers.onPins((pins) => this.view3d.setPins(pins));
    this.view3d.onPlayerClick = (id, x, y) => { const p = this.layers.players.players.find((q) => q.id === id); if (p) this.playerCard.show(p, x, y); };
    return this.view3d;
  }

  async setMode(mode) {
    if (mode === this.mode) return;
    const btn = $('#btn-mode');
    if (mode === '3d') {
      btn.disabled = true;
      try {
        await this.ensureView3D();
        const c = fromLatLng(this.map.getCenter());
        $('#view3d').hidden = false;
        $('#map').style.visibility = 'hidden';
        this.view3d.show(this.pendingPose || { x: c.x, z: c.z, zoom: this.map.getZoom() });
        this.pendingPose = null;
        this.mode = '3d';
        if (this.layers.players.following) this.view3d.follow(this.layers.players.following);
        this.root.dataset.mode = '3d';
        btn.innerHTML = '<svg><use href="#i-2d"/></svg><span>2D</span>';
        btn.title = 'Back to 2D';
      } catch (e) {
        console.error(e);
        this.toast('3D view could not start: ' + e.message);
      }
      btn.disabled = false;
    } else {
      const c = this.view3d ? this.view3d.center() : null;
      this.view3d?.hide();
      $('#view3d').hidden = true;
      $('#map').style.visibility = '';
      this.mode = '2d';
      this.root.dataset.mode = '2d';
      btn.innerHTML = '<svg><use href="#i-3d"/></svg><span>3D</span>';
      btn.title = 'Switch to 3D';
      if (c) this.map.setView(toLatLng(c.x, c.z), this.map.getZoom(), { animate: false });
      this.map.invalidateSize();
    }
    this.updateHash();
  }

  // ---------------------------------------------------------------- export
  openExport() {
    const d = $('#export-dialog');
    const area = d.querySelector('select[name=area]');
    area.querySelector('option[value=view]').disabled = this.mode !== '2d';
    if (this.mode !== '2d' && area.value === 'view') area.value = '512';
    $('#export-status').textContent = '';
    d.hidden = false;
  }

  async runExport() {
    const form = $('#export-form'), status = $('#export-status'), go = $('#export-go');
    const f = new FormData(form);
    let x0, z0, x1, z1;
    const c = this.mode === '3d' && this.view3d ? this.view3d.center() : fromLatLng(this.map.getCenter());
    if (f.get('area') === 'view') {
      const b = this.map.getBounds();
      const sw = fromLatLng(b.getSouthWest()), ne = fromLatLng(b.getNorthEast());
      x0 = sw.x; z0 = sw.z; x1 = ne.x; z1 = ne.z;
    } else {
      const half = +f.get('area') / 2;
      x0 = c.x - half; z0 = c.z - half; x1 = c.x + half; z1 = c.z + half;
    }
    const opts = { x0, z0, x1, z1, step: +f.get('step'), cats: new Set(f.getAll('cat')), water: f.get('water') === 'on', markers: f.get('markers') === 'on', trees: true, mode: f.get('mode') };
    go.disabled = true;
    try { await this.ensureView3D(); } catch (e) { status.textContent = '3D could not start: ' + e.message; go.disabled = false; return; }
    const { Exporter } = await import('./export.js');   // loaded on use: it pulls in three.js
    const ex = new Exporter(this);
    ex.report = (msg) => { status.textContent = msg; };
    try {
      const out = await ex.run(opts);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(out.blob); a.download = out.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      status.textContent = `${out.name} · ${(out.blob.size / 1048576).toFixed(1)} MB · ${out.meta.objects} objects`;
      this.toast('Export ready: ' + out.name);
    } catch (e) {
      status.textContent = e.message || String(e);
      console.warn('export', e);
    } finally { go.disabled = false; }
  }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }
}

window.app = new App();
window.app.start();
