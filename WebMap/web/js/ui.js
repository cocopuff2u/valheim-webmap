// The sidebar: layers, players, markers, stats, events.

import { escape } from './layers/markers.js';
import { iconSvg, colors, materialColors, materialNames } from './icons.js';
import { stats as statsStore, prefabs, objectFilter, OBJECT_CATS, markers as markerStore } from './data.js';
import { layerState } from './layerstate.js';
import { VEG } from './vegpack.js';
import { on } from './net.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
export function fmtDist(m) { return m >= 10000 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }
export function fmtAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function fmtTime(iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
// an event's time: just the time today, the date above it on earlier days; "~" when it was
// worked out from the server logs afterwards (to within a few minutes)
function eventTime(e) {
  const d = new Date(e.ts);
  if (isNaN(d)) return '';
  const t = (e.approx ? '~' : '') + fmtTime(e.ts);
  if (d.toDateString() === new Date().toDateString()) return t;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}<br>${t}`;
}

export class Sidebar {
  constructor(app) {
    this.app = app;
    this.root = $('#sidebar');
    this.tabs = this.root.querySelectorAll('.tabs button[data-tab]');
    for (const b of this.tabs) b.addEventListener('click', () => this.show(b.dataset.tab));
    $('#btn-close-sidebar').addEventListener('click', () => app.toggleSidebar(false));
    this.eventFilters = new Set(EVENT_KINDS.map((k) => k[0]));
    this.unread = 0;
    this.active = 'layers';
    this.buildLayers();
    this.buildEvents();
    on('events', (f) => this.addEvents(f.data, f.initial));
    statsStore.onChange((d) => { this.renderStats(d); if (this.lastPlayers) this.renderPlayers(this.lastPlayers); });   // players: the recently online list
    markerStore.onChange(() => { if (statsStore.data) this.renderStats(statsStore.data); });   // the totals count bases, portals and boats
  }

  show(tab) {
    this.active = tab;
    for (const b of this.tabs) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of this.root.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === tab);
    if (tab === 'events') { this.unread = 0; this.badge(); if (this.logOn) this.pollLog(true); }
    if (tab === 'stats') statsStore.refresh();
    this.app.toggleSidebar(true);
  }

  badge() {
    const b = $('#events-badge');
    b.hidden = this.unread === 0;
    b.textContent = this.unread > 99 ? '99+' : this.unread;
  }

  // ---------------------------------------------------------------- layers
  // Cards by what they are about: the world itself, the people and places on it, guides drawn
  // over it, and the 3D view. Each row: an icon, a name with a line on what it shows, a switch.
  buildLayers() {
    const p = $('#panel-layers');
    const L = this.app.layers, S = layerState;
    const card = (title, sub) => {
      const c = el(`<section class="lcard"><header><h4>${title}</h4>${sub ? `<span>${sub}</span>` : ''}</header></section>`);
      p.append(c);
      return c;
    };
    const row = (icon, label, desc, checked, onToggle) => {
      const r = el(`<label class="lrow"><span class="lico">${icon}</span><span class="ltext"><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</span><span class="switch"><input type="checkbox" ${checked ? 'checked' : ''}><i></i></span></label>`);
      r.querySelector('input').addEventListener('change', (e) => onToggle(e.target.checked));
      return r;
    };
    const ico = (name, color) => iconSvg(name, color || colors[name]);

    // ---- the world
    const world = card('The world');
    world.append(row(ico('house', '#c9a26b'), 'Buildings', 'Player builds, coloured by material', S.buildings, (v) => { if (v) L.structures.addTo(this.app.map); else L.structures.remove(); S.set('buildings', v); }));
    world.append(row(ico('ruin'), 'World structures', 'Ruins, towers and camps', S.ruins, (v) => { if (v) L.ruins.addTo(this.app.map); else L.ruins.remove(); S.set('ruins', v); }));
    if (this.app.gl) {
      // three groups, each its own switch (the WebGL map draws them from data; the plain map's
      // tree tiles come baked in one)
      const vegOn = () => { const any = S.vegTrees || S.vegBushes || S.vegRocks; if (any !== S.veg) { if (any) L.veg.addTo(this.app.map); else L.veg.remove(); S.set('veg', any); } };
      world.append(row(TREE_SVG, 'Trees', 'Forests, single trees and stumps', S.vegTrees, (v) => { S.set('vegTrees', v); vegOn(); }));
      world.append(row(BUSH_SVG, 'Bushes & berries', 'Raspberries, blueberries, cloudberries', S.vegBushes, (v) => { S.set('vegBushes', v); vegOn(); }));
      world.append(row(ROCK_SVG, 'Rocks & ore', 'Boulders, copper, tin, silver, obsidian', S.vegRocks, (v) => { S.set('vegRocks', v); vegOn(); }));
    } else {
      world.append(row(TREE_SVG, 'Trees & rocks', 'Every tree, bush and boulder', S.veg, (v) => { if (v) L.veg.addTo(this.app.map); else L.veg.remove(); S.set('veg', v); }));
    }

    // ---- people and places
    const people = card('People & places');
    people.append(row(ico('player', '#6fb7ff'), 'Players', 'Where everyone online is right now', S.players, (v) => { L.players.setVisible(v); S.set('players', v); }));
    people.append(row(ico('pin'), 'Pins', 'Pins placed on the map', S.pins, (v) => { L.markers.setVisible('pins', v); S.set('pins', v); }));
    people.append(row(LABEL_SVG, 'Names', 'Labels under the markers', S.labels, (v) => { document.body.classList.toggle('no-labels', !v); S.set('labels', v); }));
    this.markerSetRows = el('<div class="lsets"></div>');
    people.append(el('<div class="lsub">Markers</div>'), this.markerSetRows);

    // ---- guides drawn over the map
    const guides = card('Map guides');
    guides.append(row(GRID_SVG, 'Grid', '256 m zones with coordinates', S.grid, (v) => { this.app.setGrid(v); S.set('grid', v); }));
    guides.append(row(RINGS_SVG, 'Distance rings', 'Every 500 m out from the spawn', S.rings, (v) => { this.app.setRings(v); S.set('rings', v); }));

    // ---- the 3D view (left out when the server has enable_3d = false)
    if (this.app.config?.enable_3d !== false) {
      const d3 = card('3D view', 'used when you switch to 3D');
      d3.append(el('<div class="lsub">Show</div>'));
      const objs = el('<div class="filters lchips"></div>');
      for (const [cat, label] of OBJECT_CATS) {
        const on = objectFilter.shows(cat);
        const lab = el(`<label class="${on ? '' : 'off'}"><input type="checkbox" ${on ? 'checked' : ''}> ${label}</label>`);
        lab.querySelector('input').addEventListener('change', (e) => { lab.classList.toggle('off', !e.target.checked); objectFilter.set(cat, e.target.checked); });
        objs.append(lab);
      }
      d3.append(objs);
      const light = el(`<div class="lrow"><span class="lico">${SUN_SVG}</span><span class="ltext"><b>Time of day</b><small>The light in 3D</small></span><select class="sel">
        <option value="live">Live</option><option value="morning">Morning</option><option value="noon">Noon</option><option value="evening">Evening</option><option value="night">Night</option></select></div>`);
      const sel = light.querySelector('select'); sel.value = S.time3d;
      sel.addEventListener('change', () => S.set('time3d', sel.value));
      d3.append(light);
      d3.append(row(SHADOW_SVG, 'Shadows', 'Softer on slower devices when off', S.shadows, (v) => S.set('shadows', v)));
    }

    // ---- what the colours mean, folded away: buildings by material, trees and rocks by kind
    const legend = el('<details class="lcard llegend"><summary>Map key</summary><div class="lsub">Buildings</div><div class="legend lb"></div><div class="lsub">Trees &amp; rocks</div><div class="legend lv"></div></details>');
    materialNames.forEach((n, i) => legend.querySelector('.lb').append(el(`<span><i style="background:${materialColors[i]}"></i>${n}</span>`)));
    for (const [kind, name] of VEG_KEY) if (VEG[kind]) legend.querySelector('.lv').append(el(`<span><i class="${VEG[kind][2] ? 'rock' : 'round'}" style="background:${VEG[kind][1]}"></i>${name}</span>`));
    p.append(legend);

    const setIcon = { spawn: 'spawn', bosses: 'boss', traders: 'trader', portals: 'portal', tombstones: 'tombstone', bases: 'house', vehicles: 'boat', locations: 'poi' };
    L.markers.onChange((sets) => {
      this.markerSetRows.replaceChildren();
      for (const s of sets) {
        const n = (s.markers || []).length;
        const r = row(ico(setIcon[s.id] || 'poi'), `${escape(s.label)} <span class="lcount">${n}</span>`, '', L.markers.visible.get(s.id) !== false, (v) => { L.markers.setVisible(s.id, v); S.setSet(s.id, v); });
        r.classList.add('compact');
        this.markerSetRows.append(r);
      }
      this.renderMarkers(sets);
    });
  }

  // ---------------------------------------------------------------- players
  // Who is on now (cards: where, health, follow), then who was on recently (from the stats).
  renderPlayers(players) {
    this.lastPlayers = players;
    const p = $('#panel-players');
    const PL = this.app.layers.players;
    p.replaceChildren(el(`<h3>Online now <span class="count">${players.length}</span></h3>`));
    if (players.length === 0) p.append(el('<div class="empty-card">Nobody is online right now.</div>'));
    for (const pl of players) {
      const hp = pl.maxHealth ? Math.round(100 * pl.health / pl.maxHealth) : 100;
      const color = PL.color(pl.name), following = PL.following === pl.id;
      const tags = [pl.dead && '<span class="tag dead">Dead</span>', pl.inBed && '<span class="tag sleep">Sleeping</span>', pl.pvp && '<span class="tag pvp">PvP</span>'].filter(Boolean).join('');
      const where = pl.x !== undefined ? `${escape(pl.biome || '')}${pl.biome ? ' · ' : ''}${this.whereText(pl.x, pl.z)}` : 'Position hidden';
      const r = el(`<div class="pcard${following ? ' on' : ''}">
        <div class="pc-top"><span class="avatar" style="background:${color}">${escape((pl.name || '?').slice(0, 1).toUpperCase())}</span>
          <div class="grow"><div class="pc-name">${escape(pl.name)}${tags}</div><div class="pc-where" title="${pl.x !== undefined ? `${pl.x}, ${pl.z}` : ''}">${where}</div></div>
          <button class="btn small${following ? ' on' : ''}" ${pl.x === undefined ? 'disabled' : ''}>${following ? 'Following' : 'Follow'}</button></div>
        <div class="pc-hp"><div class="hp"><i class="${hp < 30 ? 'low' : ''}" style="width:${hp}%"></i></div><span>${Math.round(pl.health ?? 0)} / ${Math.round(pl.maxHealth ?? 0)}</span></div></div>`);
      r.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); PL.follow(following ? null : pl.id); });
      r.addEventListener('click', () => { const rect = r.getBoundingClientRect(); this.app.playerCard.show(pl, rect.right, rect.top + rect.height / 2); });
      p.append(r);
    }
    // recently online, from the stats (last seen, and where when the server shares it)
    const online = new Set(players.map((x) => x.name));
    const recent = ((statsStore.data && statsStore.data.players) || []).filter((x) => !online.has(x.name) && x.lastSeen)
      .sort((x, y) => y.lastSeen.localeCompare(x.lastSeen)).slice(0, 12);
    if (recent.length) {
      p.append(el(`<h3>Recently online <span class="count">${recent.length}</span></h3>`));
      const list = el('<div class="mk-list"></div>');
      for (const x of recent) {
        const r = el(`<div class="mrow${x.lastX !== undefined ? ' clickable' : ''}"><span class="avatar small" style="background:${PL.color(x.name)}">${escape((x.name || '?').slice(0, 1).toUpperCase())}</span>
          <div class="grow"><div class="name">${escape(x.name)}</div><div class="meta">${x.lastBiome ? escape(x.lastBiome) + ' · ' : ''}${fmtDuration(x.playtime)} played</div></div><span class="mside" title="${escape(new Date(x.lastSeen).toLocaleString())}">${fmtAgo(x.lastSeen)}</span></div>`);
        if (x.lastX !== undefined) r.addEventListener('click', () => this.app.goTo(x.lastX, x.lastZ, Math.max(this.app.map.getZoom(), 6)));
        list.append(r);
      }
      p.append(list);
    }
    $('#online-pill').textContent = `${players.length} online`;
    $('#online-pill').classList.toggle('on', players.length > 0);
  }

  // "at the spawn", "650 m NE of spawn", "2.1 km W of spawn"
  whereText(x, z) {
    const s = this.app.spawn || { x: 0, z: 0 }, dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz);
    if (d < 60) return 'at the spawn';
    const dirs = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
    const dir = dirs[(Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8];
    return `${d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1) + ' km'} ${dir} of spawn`;
  }

  // ---------------------------------------------------------------- markers
  // A search box, then a card per set (folded when long); portals as linked pairs.
  renderMarkers(sets) {
    this.mkSets = sets;
    if (!this.mkOpen) this.mkOpen = new Map();
    const p = $('#panel-markers');
    if (!this.mkSearch) {
      this.mkSearch = el('<div class="mk-search"><input type="search" placeholder="Find a marker"></div>');
      this.mkSearch.querySelector('input').addEventListener('input', () => this.renderMarkers(this.mkSets));
      this.mkBody = el('<div></div>');
    }
    if (!p.contains(this.mkSearch)) p.replaceChildren(this.mkSearch, this.mkBody);
    const q = this.mkSearch.querySelector('input').value.trim().toLowerCase();
    const ICON = { spawn: 'spawn', bosses: 'boss', traders: 'trader', portals: 'portal', tombstones: 'tombstone', bases: 'house', vehicles: 'boat' };
    const go = (x, z) => this.app.goTo(x, z, Math.max(this.app.map.getZoom(), 6));
    this.mkBody.replaceChildren();
    let any = false;
    for (const s of sets) {
      let ms = (s.markers || []).slice().sort((a, b) => (a.label || '').localeCompare(b.label || ''));
      if (q) ms = ms.filter((m) => (m.label || '').toLowerCase().includes(q) || (m.tag || '').toLowerCase().includes(q));
      if (q && !ms.length) continue;
      any = true;
      const iconName = ICON[s.id] || 'poi';
      const open = q ? true : (this.mkOpen.has(s.id) ? this.mkOpen.get(s.id) : (s.markers || []).length <= 8);
      const card = el(`<details class="mk-card"${open ? ' open' : ''}><summary><span class="ico">${iconSvg(iconName, colors[iconName])}</span><b>${escape(s.label)}</b><span class="lcount">${ms.length}</span><span class="chev"></span></summary><div class="mk-list"></div></details>`);
      card.addEventListener('toggle', () => { if (!q) this.mkOpen.set(s.id, card.open); });
      const list = card.querySelector('.mk-list');
      if (!ms.length) list.append(el('<div class="empty">Nothing found yet.</div>'));
      const row = (m, name, meta, side = '') => {
        const icon = m.icon || m.cat || iconName;
        const r = el(`<div class="mrow clickable" title="${m.x}, ${m.z}"><span class="ico">${iconSvg(icon, colors[icon] || colors[iconName])}</span><div class="grow"><div class="name">${name}</div><div class="meta">${meta}</div></div>${side}</div>`);
        r.addEventListener('click', () => go(m.x, m.z));
        return r;
      };
      if (s.id === 'portals') {
        // one row per tag: its ends, how far apart, and a button for each end
        const byTag = new Map();
        for (const m of ms) { const k = m.tag || m.label || ''; if (!byTag.has(k)) byTag.set(k, []); byTag.get(k).push(m); }
        for (const [tag, ends] of byTag) {
          const far = ends.length === 2 ? Math.hypot(ends[0].x - ends[1].x, ends[0].z - ends[1].z) : 0;
          const meta = ends.length === 2 ? `linked · ${far < 1000 ? Math.round(far) + ' m' : (far / 1000).toFixed(1) + ' km'} apart` : ends.length === 1 ? 'no other end yet' : `${ends.length} ends: only two link`;
          const btns = `<span class="ends">${ends.map((e, i) => `<button class="end" title="${escape(this.whereText(e.x, e.z))}">${i + 1}</button>`).join('')}</span>`;
          const r = row(ends[0], escape(tag || '(untagged)'), meta, btns);
          r.querySelectorAll('.end').forEach((b, i) => b.addEventListener('click', (ev) => { ev.stopPropagation(); go(ends[i].x, ends[i].z); }));
          list.append(r);
        }
      } else {
        for (const m of ms.slice(0, 300)) {
          const where = this.whereText(m.x, m.z);
          let meta = where, side = '';
          if (s.id === 'tombstones' && m.when) side = `<span class="mside">${new Date(m.when / 10000 - 62135596800000).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`;
          if (s.id === 'bases' && m.pieces) side = `<span class="mside">${m.pieces.toLocaleString()} pieces</span>`;
          if (s.id === 'spawn') meta = `${m.x}, ${m.z}`;
          list.append(row(m, escape(m.label), meta, side));
        }
        if (ms.length > 300) list.append(el(`<div class="empty">...and ${ms.length - 300} more: use the search above</div>`));
      }
      this.mkBody.append(card);
    }
    if (!any) this.mkBody.append(el(`<div class="empty-card">${q ? 'No marker matches that.' : 'No markers yet.'}</div>`));
  }

  // ---------------------------------------------------------------- stats
  // Top to bottom: what is happening now, the world's progress, the people, the totals, what has
  // been found, and the server's own details folded away at the end.
  renderStats(d) {
    const p = $('#panel-stats');
    if (!d || !d.server) { p.replaceChildren(el('<div class="empty">No stats yet.</div>')); return; }
    const s = d.server, tiles = s.tiles || {}, t = d.totals || {}, ps = d.players || [];
    const count = (id, f) => { const set = markerStore.sets.find((x) => x.id === id); return set ? (f ? set.markers.filter(f).length : set.markers.length) : 0; };
    const tile = (v, label, title = '') => `<div class="stat-tile"${title ? ` title="${escape(title)}"` : ''}><b>${v}</b><span>${label}</span></div>`;
    p.replaceChildren();

    // ---- now
    p.append(el('<h3>Now</h3>'));
    p.append(el(`<div class="stat-tiles">
      ${tile(s.day ?? '–', 'day' + (s.night ? ' · night' : ''))}
      ${tile(s.online ?? 0, (s.online === 1 ? 'player' : 'players') + ' online')}
      ${tile((s.exploredPercent ?? 0).toFixed(1) + '%', 'explored')}
    </div>`));
    p.append(el('<div class="sub">Players online, last 24 h</div>'));
    p.append(sparkline(d.onlineHistory || []));

    // ---- bosses: the world's own record of which have fallen
    if (d.bosses && d.bosses.length) {
      const down = d.bosses.filter((b) => b.defeated).length;
      p.append(el(`<h3>Bosses <span class="count">${down} of ${d.bosses.length}</span></h3>`));
      p.append(el(`<div class="boss-track">${d.bosses.map((b) => `<div class="boss${b.defeated ? ' down' : ''}" title="${escape(b.name)}${b.defeated ? ': defeated' : ': not yet'}"><span>${b.defeated ? '&#10003;' : '?'}</span>${escape(b.name)}</div>`).join('')}</div>`));
    }

    // ---- players, then who leads what
    p.append(el(`<h3>Players <span class="count">${ps.length}</span></h3>`));
    if (!ps.length) p.append(el('<div class="empty">Nobody has played since the map was installed.</div>'));
    else {
      const rows = ps.map((pl) => `<tr class="${pl.online ? 'on' : ''}" data-x="${pl.lastX ?? ''}" data-z="${pl.lastZ ?? ''}">
        <td>${escape(pl.name)}</td><td class="num">${fmtDuration(pl.playtime)}</td><td class="num">${pl.deaths}</td>
        <td class="num">${fmtDist(pl.distance)}</td><td class="num">${(pl.built || 0).toLocaleString()}</td><td class="num" title="${escape(pl.lastSeen)}">${pl.online ? 'now' : fmtAgo(pl.lastSeen).replace(' ago', '').replace('just now', 'now')}</td></tr>`).join('');
      const table = el(`<div style="overflow:auto"><table class="stats"><thead><tr><th>Name</th><th class="num" title="Play time">Played</th><th class="num" title="Deaths">Died</th><th class="num" title="Distance walked">Walked</th><th class="num" title="Building pieces of theirs standing in the world">Built</th><th class="num" title="Last seen">Seen</th></tr></thead><tbody>${rows}</tbody></table></div>`);
      for (const tr of table.querySelectorAll('tbody tr'))
        if (tr.dataset.x) { tr.style.cursor = 'pointer'; tr.addEventListener('click', () => this.app.goTo(+tr.dataset.x, +tr.dataset.z, 6)); }
      p.append(table);
    }
    const boards = [
      ['playtime', 'Never logs off', 'most time played', (v) => fmtDuration(v)],
      ['distance', 'Wanderer', 'farthest walked', (v) => fmtDist(v)],
      ['built', 'Master builder', 'most pieces standing', (v) => v.toLocaleString() + ' pieces'],
      ['revealed', 'Pathfinder', 'most map revealed', (v) => v.toLocaleString() + ' cells'],
      ['bossKills', 'Slayer', 'most boss kills', (v) => v + (v === 1 ? ' boss' : ' bosses')],
      ['raids', 'Raid veteran', 'most raids weathered', (v) => v + (v === 1 ? ' raid' : ' raids')],
      ['finds', 'Discoverer', 'most altars and traders found', (v) => v + (v === 1 ? ' find' : ' finds')],
      ['deaths', "Odin's regular", 'most deaths', (v) => v + (v === 1 ? ' death' : ' deaths')],
    ];
    const cards = boards.map(([k, title, what, fmt]) => {
      const top = ps.filter((x) => (x[k] || 0) > 0).sort((a, b) => b[k] - a[k])[0];
      return top ? `<div class="lead" title="${escape(what)}"><span class="lead-title">${escape(title)}</span><b>${escape(top.name)}</b><span class="lead-val">${fmt(top[k])}</span></div>` : '';
    }).join('');
    if (cards) { p.append(el('<h3>Leaderboard</h3>')); p.append(el(`<div class="leads">${cards}</div>`)); }

    // ---- totals: the adventure so far, and what stands in the world
    p.append(el('<h3>Totals</h3>'));
    p.append(el('<div class="sub">Adventure</div>'));
    p.append(el(`<div class="stat-tiles">
      ${tile(t.bossKills ?? 0, 'boss kills')}${tile(t.raids ?? 0, 'raids')}${tile(t.nightsSlept ?? 0, 'nights slept')}
      ${tile(t.deaths ?? 0, 'deaths')}${tile(t.players ?? 0, 'players ever')}${tile(t.peakOnline ?? 0, 'most online at once', t.peakOnlineUtc ? new Date(t.peakOnlineUtc).toLocaleString() : '')}
    </div>`));
    p.append(el('<div class="sub">The built world</div>'));
    p.append(el(`<div class="stat-tiles">
      ${tile((s.structures ?? 0).toLocaleString(), 'pieces built')}${tile(count('bases'), 'bases')}${tile(count('portals'), 'portals')}
      ${tile(`${count('vehicles', (m) => m.cat !== 'cart')} / ${count('vehicles', (m) => m.cat === 'cart')}`, 'ships / carts')}${tile((s.terraformedZones ?? 0).toLocaleString(), 'terraformed zones')}${tile((s.trees ?? 0).toLocaleString(), 'trees standing')}
    </div>`));
    p.append(el('<div class="note">Boss kills, raids and nights slept count from when the map started tracking them.</div>'));

    // ---- discoveries: boss altars and traders found, newest first
    const disc = d.discoveries || [];
    p.append(el(`<h3>Discoveries <span class="count">${disc.length}</span></h3>`));
    if (!disc.length) p.append(el('<div class="empty">Nothing found yet.</div>'));
    else {
      const list = el('<div></div>');
      for (const f of disc.slice().sort((a, b) => (b.when || '').localeCompare(a.when || ''))) {
        const icon = f.kind === 'boss' ? 'boss' : 'trader';
        const when = f.when ? `found ${new Date(f.when).toLocaleDateString([], { month: 'short', day: 'numeric' })}${f.who ? ' by ' + escape(f.who) : ''}` : 'found before tracking began';
        const r = el(`<div class="row clickable"><span class="ico">${iconSvg(icon, colors[icon])}</span><div class="grow"><div class="name">${escape(f.label)}${f.kind === 'boss' ? "'s altar" : ''}</div><div class="meta">${when}</div></div></div>`);
        r.addEventListener('click', () => this.app.goTo(f.x, f.z, Math.max(this.app.map.getZoom(), 6)));
        list.append(r);
      }
      p.append(list);
    }

    // ---- the server's own details, folded away (remembered open or shut)
    const det = el(`<details class="server-details"${this.serverOpen ? ' open' : ''}><summary>Server details</summary><dl class="kv">
      <dt>Up since</dt><dd>${s.startedUtc ? new Date(s.startedUtc).toLocaleString() : '–'}</dd>
      <dt>Last world sweep</dt><dd>${s.lastSweepUtc ? fmtAgo(s.lastSweepUtc) + ` (${(s.lastSweepSeconds || 0).toFixed(1)} s)` : 'pending'}</dd>
      <dt>World objects</dt><dd>${(s.objects ?? 0).toLocaleString()}</dd>
      <dt>Map tiles rendered</dt><dd>${tiles.onDisk ?? 0}${tiles.queued ? ` (+${tiles.queued} queued)` : ''}</dd>
      <dt>Render time / tile</dt><dd>${tiles.avgMs ? tiles.avgMs.toFixed(0) + ' ms' : '–'}${tiles.mainThreadSampling ? ' · main-thread' : ''}</dd>
      <dt>Max detail</dt><dd>${Math.pow(2, 7 - (tiles.maxRenderZoom ?? 7))} m / px</dd>
      <dt>3D models</dt><dd>${prefabs.stats.exported ?? 0} prefabs${prefabs.stats.unreadable ? ` (${prefabs.stats.unreadable} unreadable)` : ''}${prefabs.stats.queued ? ` +${prefabs.stats.queued} queued` : ''}</dd>
      <dt>WebMap</dt><dd>${escape(this.app.config?.version || '')}</dd>
    </dl></details>`);
    det.addEventListener('toggle', () => { this.serverOpen = det.open; });
    p.append(det);
  }

  // ---------------------------------------------------------------- events
  buildEvents() {
    const p = $('#panel-events');
    // Events, or the server's own console lines (admins: Live/ServerLog on the server)
    const mode = el('<div class="seg"><button class="on" data-m="events">Events</button><button data-m="log">Server log</button></div>');
    for (const b of mode.querySelectorAll('button')) b.addEventListener('click', () => {
      for (const x of mode.querySelectorAll('button')) x.classList.toggle('on', x === b);
      this.eventsBox.hidden = b.dataset.m !== 'events';
      this.logBox.hidden = b.dataset.m !== 'log';
      this.logOn = b.dataset.m === 'log';
      if (this.logOn) this.pollLog(true);
    });
    p.append(mode);
    this.eventsBox = el('<div></div>');
    this.logBox = this.buildLog();
    this.logBox.hidden = true;
    p.append(this.eventsBox, this.logBox);
    // which kinds of event the list shows: a chip each, with All / None
    const head = el('<div class="filters-head"><span>Show these events</span><button class="link" data-all="1">All</button><button class="link" data-all="0">None</button></div>');
    const filters = el('<div class="ev-filters"></div>');
    const chips = [], groups = new Map();
    for (const [t, label, tip, group] of EVENT_KINDS) {
      if (!groups.has(group)) {
        const g = el(`<div class="ev-group"><div class="ev-group-name">${escape(group)}</div><div class="filters"></div></div>`);
        filters.append(g);
        groups.set(group, g.querySelector('.filters'));
      }
      const lab = el(`<label title="${escape(tip)}"><input type="checkbox" checked>${escape(label)}</label>`);
      const box = lab.querySelector('input');
      const set = (on) => {
        box.checked = on;
        lab.classList.toggle('off', !on);
        if (on) this.eventFilters.add(t); else this.eventFilters.delete(t);
      };
      box.addEventListener('change', () => { set(box.checked); this.applyEventFilter(); });
      chips.push(set);
      groups.get(group).append(lab);
    }
    for (const b of head.querySelectorAll('button')) b.addEventListener('click', () => { for (const set of chips) set(b.dataset.all === '1'); this.applyEventFilter(); });
    this.eventsBox.append(head, filters);
    this.eventList = el('<div id="event-list"></div>');
    this.eventsNone = el('<div class="empty" hidden>No events of the kinds picked above yet. "Show older" looks further back.</div>');
    this.eventsBox.append(this.eventList, this.eventsNone);
    // older history from the server's log, a page at a time
    this.olderBtn = el('<button class="btn older">Show older</button>');
    this.olderBtn.addEventListener('click', () => this.loadOlder());
    this.eventsBox.append(this.olderBtn);
  }

  // ---- the server log: every line the game wrote, in order, with the time it was written. Needs
  // the server's admin key (announce.token beside the plugin), kept in this browser once entered.
  buildLog() {
    const box = el(`<div class="serverlog">
      <div class="log-key" hidden><p>The server log is for admins. Enter the admin key (the text in <code>announce.token</code> beside the plugin on the server):</p>
        <div class="row-in"><input type="text" placeholder="Admin key" autocomplete="off" spellcheck="false"><button class="btn">Open</button></div><div class="err" hidden>That key was not accepted.</div></div>
      <div class="log-tools" hidden><input type="search" placeholder="Search the log"><div class="log-opts"><label><input type="checkbox" checked> Hide routine lines</label><button class="btn" title="Forget the admin key in this browser">Lock</button></div></div>
      <div class="log-lines"></div></div>`);
    this.logLines = box.querySelector('.log-lines');
    this.logKeyBox = box.querySelector('.log-key');
    this.logTools = box.querySelector('.log-tools');
    const keyIn = this.logKeyBox.querySelector('input');
    const go = () => { this.setLogKey(keyIn.value.replace(/\s+/g, '')); keyIn.value = ''; this.pollLog(true); };   // spaces never belong in a key
    this.logKeyBox.querySelector('button').addEventListener('click', go);
    keyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const [search, quiet, lock] = [this.logTools.querySelector('input[type=search]'), this.logTools.querySelector('input[type=checkbox]'), this.logTools.querySelector('button')];
    this.logFilter = { q: '', quiet: true };
    search.addEventListener('input', () => { this.logFilter.q = search.value.toLowerCase(); this.filterLog(); });
    quiet.addEventListener('change', () => { this.logFilter.quiet = quiet.checked; this.filterLog(); });
    lock.addEventListener('click', () => { this.setLogKey(''); this.logLines.replaceChildren(); this.logNext = -1; this.pollLog(true); });
    this.logNext = -1;
    return box;
  }

  setLogKey(k) { try { if (k) localStorage.setItem('webmap-admin-key', k); else localStorage.removeItem('webmap-admin-key'); } catch (e) { /* this visit only */ } this.logKey = k; }
  getLogKey() { if (this.logKey === undefined) { try { this.logKey = localStorage.getItem('webmap-admin-key') || ''; } catch (e) { this.logKey = ''; } } return this.logKey; }

  // fetch new lines every few seconds while the view is open
  async pollLog(now) {
    clearTimeout(this.logTimer);
    if (!this.logOn || this.active !== 'events') return;
    const key = this.getLogKey();
    this.logKeyBox.hidden = !!key; this.logTools.hidden = !key;
    if (!key) return;
    try {
      const r = await fetch(`api/serverlog?after=${this.logNext}&limit=${this.logNext < 0 ? 1500 : 1000}`, { cache: 'no-store', headers: { 'X-WebMap-Token': key } });
      if (r.status === 403) { this.setLogKey(''); this.logKeyBox.hidden = false; this.logTools.hidden = true; this.logKeyBox.querySelector('.err').hidden = false; return; }
      this.logKeyBox.querySelector('.err').hidden = true;
      const d = await r.json();
      const stick = this.logLines.scrollHeight - this.logLines.scrollTop - this.logLines.clientHeight < 40;   // following the end
      for (const l of d.lines || []) this.logLines.append(this.logRow(l));
      while (this.logLines.children.length > 3000) this.logLines.firstElementChild.remove();
      if ((d.lines || []).length) this.logNext = d.next;
      if (stick || now) this.logLines.scrollTop = this.logLines.scrollHeight;
    } catch (e) { /* offline: try again */ }
    this.logTimer = setTimeout(() => this.pollLog(), 3000);
  }

  logRow(l) {
    const d = new Date(l.ts);
    const t = isNaN(d) ? '' : (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ')
      + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = l.text.replace(/^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d: /, '');   // the game's own date in front: the time column has it
    const row = el(`<div class="logline ${l.level}"><time>${t}</time><span>${escape(text)}</span></div>`);
    row.dataset.text = l.text.toLowerCase();
    row.dataset.routine = ROUTINE.test(l.text) ? '1' : '';
    row.hidden = !this.logVisible(row);
    return row;
  }
  logVisible(row) { return !(this.logFilter.quiet && row.dataset.routine) && (!this.logFilter.q || row.dataset.text.includes(this.logFilter.q)); }
  filterLog() { for (const r of this.logLines.children) r.hidden = !this.logVisible(r); }

  applyEventFilter() {
    let shown = 0;
    for (const e of this.eventList.children) { e.hidden = !this.eventFilters.has(e.dataset.type); if (!e.hidden) shown++; }
    if (this.eventsNone) this.eventsNone.hidden = shown > 0;
  }

  eventRow(e) {
    const said = e.type === 'chat' || e.type === 'shout' || e.type === 'whisper';
    // chat reads "Name: message", the name in a colour of its own so a conversation is easy to follow
    const who = said ? `<b style="color:${nameColor(e.name)}">${escape(e.name)}:</b>` : `<b>${escape(e.name)}</b>`;
    const row = el(`<div class="event${said ? ' said' : ''}${e.x !== undefined ? ' clickable' : ''}" data-type="${escape(e.type)}"><time${e.approx ? ' title="Worked out from the server log: to within a few minutes"' : ''}>${eventTime(e)}</time><div class="t">${who} <span class="msg">${escape(e.text)}</span></div></div>`);
    if (e.x !== undefined) row.addEventListener('click', () => this.app.goTo(e.x, e.z, 6));
    row.hidden = !this.eventFilters.has(e.type);
    row.dataset.ts = e.ts;
    return row;
  }

  async loadOlder() {
    const rows = this.eventList.children, last = rows[rows.length - 1];
    const before = last ? last.dataset.ts : new Date().toISOString();
    this.olderBtn.disabled = true; this.olderBtn.textContent = 'Loading...';
    try {
      const r = await fetch(`data/events/older.json?before=${encodeURIComponent(before)}&limit=100`, { cache: 'no-store' });
      const list = (await r.json()).filter((e) => !hiddenEvent(e));
      this.olderLoaded = true;
      for (let i = list.length - 1; i >= 0; i--) this.eventList.append(this.eventRow(list[i]));   // newest of them first, under what is shown
      this.applyEventFilter();
      this.olderBtn.textContent = list.length ? 'Show older' : 'No older events';
      this.olderBtn.disabled = !list.length;
    } catch (err) { this.olderBtn.textContent = 'Show older'; this.olderBtn.disabled = false; }
  }

  addEvents(list, initial) {
    if (!list) return;
    list = list.filter((e) => !hiddenEvent(e));
    for (const e of list) {
      this.eventList.prepend(this.eventRow(e));
      if (!initial && this.active !== 'events') this.unread++;
    }
    if (!this.olderLoaded) while (this.eventList.children.length > 300) this.eventList.lastElementChild.remove();   // trimmed unless older history was asked for
    this.applyEventFilter();
    this.badge();
    if (!initial) for (const e of list) if (e.type === 'death' || e.type === 'join' || e.type === 'leave' || e.type === 'server' || e.type === 'boss' || e.type === 'raid' || e.type === 'found' || e.type === 'biome') this.app.toast(`${e.name} ${e.text}`);
  }
}

// the trees and rocks in the map key, by kind (vegpack.js VEG), trees first, then bushes, then the ground
const VEG_KEY = [[1, 'Beech'], [12, 'Oak'], [13, 'Birch'], [18, 'Autumn birch'], [2, 'Fir'], [14, 'Pine'], [3, 'Swamp tree'], [4, 'Mistlands tree'],
  [11, 'Ash tree'], [5, 'Dead tree'], [6, 'Bush'], [15, 'Raspberry'], [16, 'Blueberry'], [17, 'Cloudberry'], [9, 'Stump'], [7, 'Rock'], [8, 'Ore']];

// small line icons for the layer rows that have no map glyph
const SVG = (d) => `<svg viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TREE_SVG = SVG('<path d="M12 3 6 12h3l-4 6h14l-4-6h3z" fill="#4f8a3a" stroke="#2c5234"/><path d="M12 18v3" stroke="#7a5a3a"/>');
const BUSH_SVG = SVG('<circle cx="12" cy="13" r="7" fill="#466e32" stroke="#2f4d22"/><circle cx="9.5" cy="11" r="1.6" fill="#4e64cc" stroke="none"/><circle cx="14" cy="14.5" r="1.6" fill="#c43a4a" stroke="none"/><circle cx="13.5" cy="10" r="1.4" fill="#e4a840" stroke="none"/>');
const ROCK_SVG = SVG('<path d="M4 18l3-8 5-3 5 3 3 8z" fill="#767670" stroke="#4e4e4a"/><path d="M10 12l2 2 3-1" stroke="#86684a" stroke-width="1.6"/>');
const LABEL_SVG = SVG('<rect x="3" y="7" width="18" height="10" rx="3"/><path d="M7 12h10"/>');
const GRID_SVG = SVG('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16M12 4v16" stroke-width="1.4"/>');
const RINGS_SVG = SVG('<circle cx="12" cy="12" r="2" fill="#7cff4f" stroke="none"/><circle cx="12" cy="12" r="5.5" stroke="#7cff4f"/><circle cx="12" cy="12" r="9" stroke="#7cff4f" stroke-dasharray="2 2.5"/>');
const SUN_SVG = SVG('<circle cx="12" cy="12" r="4" fill="#ffd866" stroke="#ffd866"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke="#ffd866"/>');
const SHADOW_SVG = SVG('<circle cx="10" cy="10" r="5"/><path d="M8 19c3 1.5 9 1.5 12-2" opacity=".6"/>');

// the kinds of event, their names on the filter chips and what each covers
const EVENT_KINDS = [
  ['join', 'Joins', 'A player joined the server', 'Players'],
  ['leave', 'Leaves', 'A player left the server', 'Players'],
  ['death', 'Deaths', 'A player died (click to see where)', 'Players'],
  ['biome', 'Biomes', 'A player entered a biome for the first time', 'Players'],
  ['boss', 'Boss kills', 'A boss was defeated, and by whom', 'World'],
  ['raid', 'Raids', 'A raid started or ended (click to see where)', 'World'],
  ['found', 'Found', 'A boss altar or trader was found for the first time', 'World'],
  ['sleep', 'Slept', 'Everyone slept through the night', 'World'],
  ['chat', 'Chat', 'Chat messages', 'Chat'],
  ['shout', 'Shouts', 'Shouted messages, heard across the map', 'Chat'],
  ['ping', 'Pings', 'Someone pinged the map', 'Other'],
  ['pin', 'Pins', 'Someone placed a pin', 'Other'],
  ['server', 'Server', 'Messages from the server itself (startup, announcements)', 'Other'],
];

// the server's chatter that says nothing new: connection counts, object clean-up, save steps,
// socket housekeeping (shown again with "Hide routine lines" off)
const ROUTINE = /^\s*Connections \d|ZDOS:|^Destroying abandoned|^World save \([1-4]\/5\)|^ZPlayFabSocket|^Disposing socket|^Considering autobackup|^SaveSystem\.|^No autobackup|^PrepareSave|^GetSaveClone|^Available space|^Update PlayFab|^Sending message to save|^Checking for any blocked|^ZRpc timeout|^Muted PlayFab|^Placed location|^Found location of type|^Dungeon loaded|^DungeonDB|^Loaded \d+ locations/;

// left out of the feed: the in-game announcement of a leave, already listed as the leave itself
// (older logs have both), and the game's "I have arrived!" shout on every spawn (the join says it)
function hiddenEvent(e) {
  return (e.type === 'server' && /^player _.+_ (left|joined)$/.test(e.text || '')) || (e.type === 'shout' && e.text === 'I have arrived!');
}

// a steady, readable colour per player name
const NAME_COLORS = ['#7cc7ff', '#ffb86b', '#9be37a', '#f590d0', '#ffd866', '#8fd8d0', '#c9a7ff', '#ff8f8f'];
function nameColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return NAME_COLORS[Math.abs(h) % NAME_COLORS.length];
}

function sparkline(hist) {
  const w = 300, h = 44, pad = 2;
  if (!hist.length) return el('<div class="empty">No history yet.</div>');
  const max = Math.max(1, ...hist.map((p) => p[1]));
  const t0 = hist[0][0], t1 = hist[hist.length - 1][0] || t0 + 1;
  const pts = hist.map(([t, n]) => [pad + (w - 2 * pad) * (t - t0) / Math.max(1, t1 - t0), h - pad - (h - 2 * pad) * n / max]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L${pts[0][0].toFixed(1)} ${h - pad} Z`;
  return el(`<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line class="axis" x1="0" y1="${h - pad}" x2="${w}" y2="${h - pad}"/><path class="area" d="${area}"/><path d="${line}"/><title>peak ${max}</title></svg>`);
}
