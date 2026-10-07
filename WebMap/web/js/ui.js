// The sidebar: layers, players, markers, stats, events.

import { escape } from './layers/markers.js';
import { iconSvg, colors, materialColors, materialNames } from './icons.js';
import { stats as statsStore, prefabs, objectFilter, OBJECT_CATS, markers as markerStore } from './data.js';
import { layerState } from './layerstate.js';
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
    statsStore.onChange((d) => this.renderStats(d));
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
  buildLayers() {
    const p = $('#panel-layers');
    const L = this.app.layers;
    const row = (label, checked, onToggle, extra = '') => {
      const r = el(`<label class="row"><input type="checkbox" ${checked ? 'checked' : ''}><span class="grow name">${label}</span>${extra}</label>`);
      r.querySelector('input[type=checkbox]').addEventListener('change', (e) => onToggle(e.target.checked));
      return r;
    };
    const slider = (value, onInput) => {
      const s = el(`<input type="range" min="0" max="100" value="${Math.round(value * 100)}" title="Opacity">`);
      s.addEventListener('input', () => onInput(s.value / 100));
      s.addEventListener('click', (e) => e.preventDefault());
      return s;
    };
    p.append(el('<h3>Map</h3>'));
    // every toggle drives the 2D layer directly and records itself in layerState, which the 3D view follows
    const S = layerState;
    const stRow = row('Buildings', S.buildings, (v) => { if (v) L.structures.addTo(this.app.map); else L.structures.remove(); S.set('buildings', v); });
    stRow.append(slider(L.structures.opacity, (v) => { L.structures.setOpacity(v); S.set('buildingsOpacity', v); }));
    p.append(stRow);
    p.append(row('Players', S.players, (v) => { L.players.setVisible(v); S.set('players', v); }));
    p.append(row('Pins', S.pins, (v) => { L.markers.setVisible('pins', v); S.set('pins', v); }));
    p.append(row('Marker labels', S.labels, (v) => { document.body.classList.toggle('no-labels', !v); S.set('labels', v); }));
    p.append(row('World structures (2D)', S.ruins, (v) => { if (v) L.ruins.addTo(this.app.map); else L.ruins.remove(); S.set('ruins', v); }));
    p.append(row('Grid (256 m, 2D)', S.grid, (v) => { this.app.setGrid(v); S.set('grid', v); }));
    p.append(row('Distance rings around spawn', S.rings, (v) => { this.app.setRings(v); S.set('rings', v); }));
    p.append(row('Trees & rocks (2D)', S.veg, (v) => { if (v) L.veg.addTo(this.app.map); else L.veg.remove(); S.set('veg', v); }));

    // the 3D-only sections are left out when the server has enable_3d = false
    if (this.app.config?.enable_3d !== false) {
      p.append(el('<h3>3D objects</h3>'));
      const objs = el('<div class="filters"></div>');
      for (const [cat, label] of OBJECT_CATS) {
        const on = objectFilter.shows(cat);
        const lab = el(`<label class="${on ? '' : 'off'}"><input type="checkbox" ${on ? 'checked' : ''}> ${label}</label>`);
        lab.querySelector('input').addEventListener('change', (e) => { lab.classList.toggle('off', !e.target.checked); objectFilter.set(cat, e.target.checked); });
        objs.append(lab);
      }
      p.append(objs);

      p.append(el('<h3>Lighting (3D)</h3>'));
      const light = el(`<div class="row"><span class="grow name">Time of day</span><select class="sel" id="time3d">
        <option value="live">Live, like in game</option><option value="morning">Morning</option><option value="noon">Noon</option><option value="evening">Evening</option><option value="night">Night</option></select></div>`);
      const sel = light.querySelector('select'); sel.value = S.time3d;
      sel.addEventListener('change', () => S.set('time3d', sel.value));
      p.append(light);
      p.append(row('Shadows', S.shadows, (v) => S.set('shadows', v)));
    }

    p.append(el('<h3>Markers</h3>'));
    this.markerSetRows = el('<div></div>');
    p.append(this.markerSetRows);
    p.append(el('<h3>Building materials</h3>'));
    const legend = el('<div class="legend"></div>');
    materialNames.forEach((n, i) => legend.append(el(`<span><i style="background:${materialColors[i]}"></i>${n}</span>`)));
    p.append(legend);

    L.markers.onChange((sets) => {
      this.markerSetRows.replaceChildren();
      for (const s of sets) {
        const n = (s.markers || []).length;
        this.markerSetRows.append(row(`${escape(s.label)} <span class="meta">${n}</span>`, L.markers.visible.get(s.id) !== false, (v) => { L.markers.setVisible(s.id, v); S.setSet(s.id, v); }));
      }
      this.renderMarkers(sets);
    });
  }

  // ---------------------------------------------------------------- players
  renderPlayers(players) {
    const p = $('#panel-players');
    p.replaceChildren(el(`<h3>Online <span class="count">${players.length}</span></h3>`));
    if (players.length === 0) { p.append(el('<div class="empty">Nobody is online right now.</div>')); }
    const PL = this.app.layers.players;
    for (const pl of players) {
      const hp = pl.maxHealth ? Math.round(100 * pl.health / pl.maxHealth) : 100;
      const r = el(`<div class="row clickable ${PL.following === pl.id ? 'on' : ''}">
        <span class="ico" style="color:${PL.color(pl.name)}">${iconSvg('player', PL.color(pl.name))}</span>
        <div class="grow"><div class="name">${escape(pl.name)} ${pl.dead ? '💀' : ''}${pl.inBed ? ' 💤' : ''}${pl.pvp ? ' ⚔️' : ''}</div>
          <div class="meta">${pl.x !== undefined ? `${escape(pl.biome || '')} · ${pl.x}, ${pl.z}` : 'position hidden'}</div>
          <div class="hp"><i class="${hp < 30 ? 'low' : ''}" style="width:${hp}%"></i></div></div>
        <button class="btn small ${PL.following === pl.id ? 'on' : ''}" ${pl.x === undefined ? 'disabled' : ''}>${PL.following === pl.id ? 'Unfollow' : 'Follow'}</button></div>`);
      r.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); PL.follow(PL.following === pl.id ? null : pl.id); });
      r.addEventListener('click', (e) => { const rect = r.getBoundingClientRect(); this.app.playerCard.show(pl, rect.right, rect.top + rect.height / 2); });
      p.append(r);
    }
    $('#online-pill').textContent = `${players.length} online`;
    $('#online-pill').classList.toggle('on', players.length > 0);
  }

  // ---------------------------------------------------------------- markers
  renderMarkers(sets) {
    const p = $('#panel-markers');
    p.replaceChildren();
    for (const s of sets) {
      const ms = (s.markers || []).slice().sort((a, b) => (a.label || '').localeCompare(b.label || ''));
      const h = el(`<h3>${escape(s.label)} <span class="count">${ms.length}</span></h3>`);
      p.append(h);
      if (ms.length === 0) { p.append(el('<div class="empty">Nothing found yet.</div>')); continue; }
      const list = el('<div></div>');
      const max = 200;
      ms.slice(0, max).forEach((m) => {
        const r = el(`<div class="row clickable"><span class="ico">${iconSvg(m.icon || m.cat, colors[m.icon] || colors[m.cat])}</span>
          <div class="grow"><div class="name">${escape(m.label)}</div><div class="meta">${m.x}, ${m.z}${m.cat && m.cat !== m.label ? ' · ' + escape(m.cat) : ''}</div></div></div>`);
        r.addEventListener('click', () => this.app.goTo(m.x, m.z, Math.max(this.app.map.getZoom(), 6)));
        list.append(r);
      });
      if (ms.length > max) list.append(el(`<div class="empty">…and ${ms.length - max} more (use search)</div>`));
      p.append(list);
    }
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
