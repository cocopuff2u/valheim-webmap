// Marker sets (locations, portals, tombstones, vehicles, custom) and chat
// pins, each as a toggleable Leaflet layer group. Portals sharing a tag are
// joined by a dashed line.

import { toLatLng, fromLatLng } from '../crs.js';
import { markers as store } from '../data.js';
import { iconSvg, colors } from '../icons.js';
import { getJSON, on } from '../net.js';
import { MarkerCanvas } from './markercanvas.js';
import { layerState } from '../layerstate.js';

export const LOCATION_CATS = ['spawn', 'boss', 'trader', 'dungeon', 'camp', 'village', 'ruin', 'runestone', 'poi'];

export function makeIcon(name, color, label, cls = 'mk') {
  return L.divIcon({
    className: '',
    html: `<div class="${cls}">${iconSvg(name, color)}${label ? `<div class="lbl">${escape(label)}</div>` : ''}</div>`,
    iconSize: cls === 'mk-pin' ? [18, 18] : [26, 26],
    iconAnchor: cls === 'mk-pin' ? [9, 18] : [13, 13],
    tooltipAnchor: [0, -12],
  });
}

// this browser's id: made up once, kept; the server keys web pins by it so only this browser can remove them
export function clientId() {
  let id = null;
  try { id = localStorage.getItem('webmap-client'); } catch (e) { /* storage blocked */ }
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
    try { localStorage.setItem('webmap-client', id); } catch (e) { /* fine, this visit only */ }
  }
  return id;
}

export const PIN_TYPES = ['dot', 'fire', 'mine', 'house', 'cave'];

export function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export class MarkerLayers {
  constructor(map) {
    this.map = map;
    this.visible = new Map();     // set id -> bool
    this.catVisible = new Map(LOCATION_CATS.map((c) => [c, c !== 'poi']));
    this.sets = [];
    this.pins = new Map();        // pin id -> pin
    this.listeners = new Set();
    // everything is painted on one canvas (markercanvas.js), not a DOM element per marker
    this.canvas = new MarkerCanvas(() => this.drawList()).addTo(map);
    layerState.onChange((k) => { if (k === 'labels') this.canvas.draw(); });
    store.onChange((sets) => this.render(sets));
    on('pin', (f) => this.addPin(f));
    on('rmpin', (f) => this.removePin(f.id));
    this.loadPins();
  }

  onChange(fn) { this.listeners.add(fn); }
  onPins(fn) { (this.pinListeners ??= new Set()).add(fn); }
  pinList() { return [...this.pins.values()]; }
  emitPins() { for (const fn of this.pinListeners || []) fn(this.pinList()); }

  render(sets) {
    // the spawn point (the server's world_start_pos) heads the list as its own set, like the seed maps do
    const sp = window.app && window.app.spawn;
    if (sp && !sets.some((s) => s.id === 'spawn'))
      sets = [{ id: 'spawn', label: 'Spawn', markers: [{ x: Math.round(sp.x), z: Math.round(sp.z), label: 'Spawn', cat: 'spawn', icon: 'spawn' }] }, ...sets];
    this.sets = sets;
    this.list = null;
    for (const fn of this.listeners) fn(sets);
    this.canvas.draw();
  }

  // what the canvas draws, rebuilt only when sets, pins or toggles change
  drawList() {
    if (this.list) return this.list;
    const items = [], lines = [];
    if (this.visible.get('pins') !== false)
      for (const p of this.pins.values()) {
        const icon = PIN_TYPES.includes(p.type) ? p.type : 'pin';
        items.push({ x: p.x, z: p.z, icon, color: colors[icon], label: p.text, pin: true, open: (ll) => this.openPin(p, ll) });
      }
    const byTag = new Map();
    for (const set of this.sets) {
      if (this.visible.get(set.id) === false) continue;
      for (const m of set.markers || []) {
        const cat = m.cat || 'custom';
        if (set.id === 'locations' && this.catVisible.get(cat) === false) continue;
        const editable = m.cat === 'base' && window.app?.config?.web_edit_bases !== false;
        items.push({ x: m.x, z: m.z, icon: m.icon || cat, color: colors[m.icon] || colors[cat] || '#9aa5b5', label: m.label,
          open: (ll) => L.popup({ offset: [0, -8] }).setLatLng(ll).setContent(editable ? this.basePopup(m, set) : popupHtml(m, set)).openOn(this.map) });
        if (cat === 'portal' && m.tag) { if (!byTag.has(m.tag)) byTag.set(m.tag, []); byTag.get(m.tag).push(m); }
      }
    }
    for (const list of byTag.values()) for (let i = 1; i < list.length; i++) lines.push([list[0].x, list[0].z, list[i].x, list[i].z]);
    this.list = { items, lines, get labels() { return !document.body.classList.contains('no-labels'); } };
    return this.list;
  }

  setVisible(id, v) {
    this.visible.set(id, v);
    this.list = null;
    this.canvas.draw();
  }

  setCategory(cat, v) { this.catVisible.set(cat, v); this.render(this.sets); }

  // Every marker with a position, for search.
  all() {
    const out = [];
    for (const set of this.sets) for (const m of set.markers || []) out.push({ kind: set.label, label: m.label, x: m.x, z: m.z, icon: m.icon || m.cat });
    for (const p of this.pins.values()) out.push({ kind: 'Pin', label: p.text || p.name, x: p.x, z: p.z, icon: p.type });
    return out;
  }

  async loadPins() {
    try {
      const pins = await getJSON('data/pins.json');
      for (const p of pins) this.addPin(p);
    } catch (e) { console.warn('pins', e); }
  }

  addPin(p) {
    this.pins.set(p.id, p);
    this.list = null;
    this.canvas.draw();
    this.emitPins();
  }

  removePin(id) {
    if (this.pins.delete(id)) { this.list = null; this.canvas.draw(); this.emitPins(); }
  }

  openPin(p, ll) {
    const mine = p.owner === 'web:' + clientId();
    const el = document.createElement('div');
    el.innerHTML = `<b>${escape(p.text || 'Pin')}</b><small>by ${escape(p.name)} · ${p.x}, ${p.z}</small>` +
      (mine ? `<div class="pin-actions"><button class="btn small" type="button">Remove pin</button></div>` : '');
    el.querySelector('button')?.addEventListener('click', async () => {
      try { await fetch('api/unpin?id=' + encodeURIComponent(p.id), { method: 'POST', headers: { 'X-WebMap-Client': clientId() } }); } catch (e) { console.warn('unpin', e); }
      this.map.closePopup();
    });
    L.popup({ offset: [0, -16] }).setLatLng(ll).setContent(el).openOn(this.map);
  }

  // popup for an auto-detected base: rename it, hide it, or put the name back
  basePopup(m, set) {
    const el = document.createElement('div');
    el.className = 'base-popup';
    el.innerHTML = popupHtml(m, set) + `<form class="pin-form base-edit"><div class="row">
      <input name="label" maxlength="24" placeholder="Name this base" value="${escape(m.renamed ? m.label : '')}" autocomplete="off">
      <button class="btn small" type="submit">Rename</button></div>
      <div class="row"><button class="btn small" type="button" data-act="hide">Hide this base</button>
      ${m.renamed ? '<button class="btn small" type="button" data-act="reset">Auto name</button>' : ''}</div>
      <small class="err" hidden></small></form>`;
    const form = el.querySelector('form'), err = el.querySelector('.err');
    const send = async (body) => {
      try {
        const r = await fetch('api/base', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebMap-Client': clientId() }, body: JSON.stringify(Object.assign({ x: m.x, z: m.z }, body)) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.status); }
        this.map.closePopup();
      } catch (e) { err.textContent = 'Could not change base: ' + e.message; err.hidden = false; }
    };
    form.addEventListener('submit', (ev) => { ev.preventDefault(); const v = String(new FormData(form).get('label') || '').trim(); if (v) send({ label: v }); });
    el.querySelector('[data-act=hide]').addEventListener('click', () => send({ hidden: true }));
    el.querySelector('[data-act=reset]')?.addEventListener('click', () => send({}));
    return el;
  }

  // right click / long press on the map: a small form, then POST /api/pin
  openPinEditor(latlng) {
    const { x, z } = fromLatLng(latlng);
    let name = '';
    try { name = localStorage.getItem('webmap-pin-name') || ''; } catch (e) { /* no storage */ }
    const el = document.createElement('form');
    el.className = 'pin-form';
    el.innerHTML = `<b>New pin</b><small>${Math.round(x)}, ${Math.round(z)}</small>
      <div class="row"><select name="type">${PIN_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      <input name="text" maxlength="20" placeholder="Label (letters, numbers)" autocomplete="off"></div>
      <div class="row"><input name="name" maxlength="16" placeholder="Your name" value="${escape(name)}" autocomplete="off"><button class="btn small" type="submit">Add pin</button></div>
      <small class="err" hidden></small>`;
    const popup = L.popup({ closeButton: true, autoPan: true, className: 'pin-form-popup' }).setLatLng(latlng).setContent(el).openOn(this.map);
    setTimeout(() => el.querySelector('[name=text]').focus(), 50);
    el.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(el);
      const who = String(fd.get('name') || '').trim();
      try { localStorage.setItem('webmap-pin-name', who); } catch (e) { /* no storage */ }
      const err = el.querySelector('.err');
      try {
        const r = await fetch('api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebMap-Client': clientId() },
          body: JSON.stringify({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, type: fd.get('type'), text: fd.get('text'), name: who, client: clientId() }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.status); }
        this.map.closePopup(popup);
      } catch (e) { err.textContent = 'Could not add pin: ' + e.message; err.hidden = false; }
    });
  }
}

function popupHtml(m, set) {
  let extra = '';
  if (m.cat === 'portal') extra = `<small>Portal tag: ${escape(m.tag || '(none)')}</small>`;
  else if (m.cat === 'base') extra = `<small>${m.pieces} pieces</small>`;
  else if (m.cat === 'tombstone') extra = `<small>${m.when ? new Date(m.when / 10000 - 62135596800000).toLocaleString() : ''}</small>`;
  else if (m.prefab) extra = `<small>${escape(m.prefab)}${m.placed === false ? ' · not yet generated' : ''}</small>`;
  else if (m.description) extra = `<small>${escape(m.description)}</small>`;
  return `<b>${escape(m.label)}</b><small>${escape(set.label)} · ${m.x}, ${m.z}</small>${extra ? '<br>' + extra : ''}`;
}
