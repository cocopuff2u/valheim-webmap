// Inline SVG marker icons. Each is a 24x24 glyph; colour comes from the category.

const glyphs = {
  spawn: '<circle cx="12" cy="12" r="9" fill="#111" stroke="COLOR" stroke-width="2.5"/><path d="M12 6l1.8 4.2 4.2.4-3.2 2.8 1 4.2L12 15.4 8.2 17.6l1-4.2L6 10.6l4.2-.4z" fill="COLOR"/>',
  boss: '<path d="M4 6l4 5 4-7 4 7 4-5-2 13H6z" fill="COLOR" stroke="#111" stroke-width="1.2"/>',
  trader: '<path d="M4 9h16l-2 11H6z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M8 9V6a4 4 0 0 1 8 0v3" fill="none" stroke="#111" stroke-width="2"/>',
  dungeon: '<path d="M12 3 4 9v11h16V9z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M10 20v-6h4v6" fill="#111"/>',
  cave: '<path d="M4 20V11a8 8 0 0 1 16 0v9z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M9 20v-5a3 3 0 0 1 6 0v5z" fill="#111"/>',
  camp: '<path d="M12 4l9 16H3z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M12 12l4 8H8z" fill="#111"/>',
  village: '<path d="M3 20V10l5-5 5 5v10z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M13 20V12l4-4 4 4v8z" fill="COLOR" stroke="#111" stroke-width="1.2"/>',
  ruin: '<path d="M5 20V9h3v3h2V6h4v6h2V9h3v11z" fill="COLOR" stroke="#111" stroke-width="1.2"/>',
  runestone: '<path d="M8 3h8l2 5-3 13H9L6 8z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M12 7v9M9.5 10h5" stroke="#111" stroke-width="1.6"/>',
  wreck: '<path d="M3 14h18l-3 5H6z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M12 4v10M12 5c4 1 6 4 6 6-3-1-5-1-6-1" fill="none" stroke="#111" stroke-width="1.8"/>',
  poi: '<circle cx="12" cy="12" r="6" fill="COLOR" stroke="#111" stroke-width="1.5"/>',
  portal: '<ellipse cx="12" cy="12" rx="7" ry="9" fill="#111" stroke="COLOR" stroke-width="2.5"/><ellipse cx="12" cy="12" rx="3" ry="5" fill="COLOR"/>',
  tombstone: '<path d="M6 21V9a6 6 0 0 1 12 0v12z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M12 8v8M9 11h6" stroke="#111" stroke-width="2"/>',
  boat: '<path d="M2 14h20l-4 6H6z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M12 3v11M12 4c5 1 7 5 7 8H12" fill="COLOR" stroke="#111" stroke-width="1.2"/>',
  cart: '<path d="M3 8h10l3 6H4z" fill="COLOR" stroke="#111" stroke-width="1.2"/><circle cx="7" cy="17" r="2.5" fill="#111" stroke="COLOR" stroke-width="1.5"/><circle cx="14" cy="17" r="2.5" fill="#111" stroke="COLOR" stroke-width="1.5"/><path d="M16 12l5-2" stroke="#111" stroke-width="2"/>',
  pin: '<path d="M12 2a6 6 0 0 0-6 6c0 4.5 6 12 6 12s6-7.5 6-12a6 6 0 0 0-6-6z" fill="COLOR" stroke="#111" stroke-width="1.2"/><circle cx="12" cy="8" r="2.2" fill="#111"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="COLOR" stroke="#111" stroke-width="1.5"/>',
  fire: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z" fill="COLOR" stroke="#111" stroke-width="1.2"/>',
  mine: '<path d="M4 16l6-6 4 4-6 6z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M13 7l4-4 4 4-4 4z" fill="COLOR" stroke="#111" stroke-width="1.2"/>',
  house: '<path d="M4 11l8-7 8 7v9H4z" fill="COLOR" stroke="#111" stroke-width="1.2"/><path d="M10 20v-6h4v6" fill="#111"/>',
  player: '<path d="M12 2l8 20-8-5-8 5z" fill="COLOR" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>',
};

export const colors = {
  spawn: '#7cff4f', boss: '#ff5c5c',   // spawn: a bright lime nothing else uses trader: '#f2c14e', dungeon: '#c9a5ff', cave: '#9fd8ff', camp: '#ff9d4d',
  village: '#e0c39a', ruin: '#bfc7d2', runestone: '#8fd3ff', wreck: '#bfc7d2', poi: '#9aa5b5', portal: '#5ce0e6',
  tombstone: '#d6d6d6', boat: '#8fc7ff', cart: '#d1b48c', pin: '#6fb7ff', dot: '#6fb7ff', fire: '#ff9d4d',
  mine: '#c7c7c7', house: '#9aa5b5', base: '#9aa5b5', custom: '#6fb7ff',   // homes in gray
};

export function iconSvg(name, color) {
  const g = glyphs[name] || glyphs.poi;
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${g.split('COLOR').join(color || colors[name] || '#9aa5b5')}</svg>`;
}

export const materialColors = [
  '#a07446', '#845c38', '#5c422e', '#9a9892', '#424252', '#767e8c', '#c6a258', '#e68232', '#5ac8d2', '#aad2e6', '#788088', '#aa643c', '#96826e', '#b4aa96', '#704a34',
];
export const materialNames = ['Wood', 'Core wood', 'Dark wood', 'Stone', 'Black marble', 'Iron', 'Thatch', 'Fire', 'Portal', 'Crystal', 'Grausten', 'Flametal', 'Misc', 'Cloth', 'Ashwood'];
