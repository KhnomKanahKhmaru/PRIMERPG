// char-util.js
// Small, stateless helper functions for the character sheet.
// Nothing in here should read or write game state; these are pure
// functions that take inputs and return values.

import {
  SEVERITY_OPTIONS,
  STAT_LABELS,
  SIZE_OPTIONS,
  SKILL_LABELS,
  STAT_XP,
  PRIM_XP,
  SEC_XP,
  SPEC_XP,
  STAT_ICONS
} from './char-constants.js';

// ── SEVERITY HELPERS ──

// Given a raw severity value and an options array, return its display label.
// Falls back to 'Minor' if the value is missing or doesn't match any option.
export function severityLabel(value, opts) {
  if (!opts) return value || 'Minor';
  const match = opts.find(x => x.value === (value || 'Minor'));
  return match ? match.label : (value || 'Minor');
}

// Build a <select> element's HTML for picking a severity.
// `current` is the currently-selected value, `onchangeStr` is the inline
// onchange handler, `opts` is the severity options array (defaults to
// the generic SEVERITY_OPTIONS list).
export function severitySelectHtml(current, onchangeStr, opts) {
  const options = opts || SEVERITY_OPTIONS.map(s => ({ value: s, label: s }));
  const html = options.map(o => {
    const selected = (current || 'Minor') === o.value ? 'selected' : '';
    return `<option value="${o.value}" ${selected}>${o.label}</option>`;
  }).join('');
  return `<select class="severity-select" onchange="${onchangeStr}">${html}</select>`;
}

// ── STAT HELPERS ──

// Standard STATMOD curve: -1 at 0–1, then +1 every two levels.
// Returns the modifier for a given stat value.
export function getStatMod(v) {
  if (v <= 1)  return -1;
  if (v <= 3)  return 0;
  if (v <= 5)  return 1;
  if (v <= 7)  return 2;
  if (v <= 9)  return 3;
  if (v <= 11) return 4;
  if (v <= 13) return 5;
  if (v <= 15) return 6;
  if (v <= 17) return 7;
  if (v === 18) return 8;
  if (v === 19) return 9;
  return 10;
}

// Get the flavor label for a stat value (e.g. 5 → "Exceptional").
export function getStatLabel(v) {
  return STAT_LABELS[Math.min(Math.max(0, Math.floor(v)), 20)] || '';
}

// Get the SIZE tier label for a given size value.
// Walks the SIZE_OPTIONS array from highest to lowest and returns the
// first tier whose value is ≤ the given size. "Nano" as fallback.
export function getSizeLabel(v) {
  const o = SIZE_OPTIONS.slice().reverse().find(opt => v >= opt.value);
  return o ? o.label : 'Nano';
}

// Compose the "You are of X Y" flavor line for a stat.
// SIZE is special-cased because it uses tier labels instead of adjectives.
export function getStatLevelText(key, total) {
  if (key === 'size') return getSizeLabel(total);
  return `You are of ${getStatLabel(total)} ${key.toUpperCase()}`;
}

// Compose the "You have X in this Skill" flavor line.
export function getSkillLevelText(val) {
  const label = SKILL_LABELS[Math.min(10, Math.max(0, val))] || 'No Exposure';
  return `You have ${label} in this Skill`;
}

// Generate a <svg> tag for a given stat's icon.
export function statIcon(key) {
  return `<svg viewBox="0 0 512 512" width="36" height="36" xmlns="http://www.w3.org/2000/svg">`
       + `<rect width="512" height="512" fill="#000"/>`
       + `<path d="${STAT_ICONS[key]}" fill="#fff"/>`
       + `</svg>`;
}

// ── XP COST HELPERS ──

// XP cost for a given stat value (clamped to 1–6).
export function statXp(v) {
  return STAT_XP[Math.min(Math.max(1, v), 6)] || 0;
}

// XP cost label (e.g. "22xp") for a skill at the given level and tier.
// `type` is 'p' (primary), 's' (secondary), or anything else (specialty).
export function skillXpLabel(val, type) {
  const v = Math.min(10, Math.max(0, parseInt(val) || 0));
  if (type === 'p') return (PRIM_XP[v]  || 0) + 'xp';
  if (type === 's') return (SEC_XP[v]   || 0) + 'xp';
  return              (SPEC_XP[v] || 0) + 'xp';
}

// Skill label text for a given level, e.g. 3 → "Basic Training".
export function skillLevelText(val) {
  return SKILL_LABELS[Math.min(10, Math.max(0, parseInt(val) || 0))];
}

// ── COLLAPSE STATE ──
//
// Per-browser persistence of "is this section collapsed?" flags. Used
// by the Overview tiles, Advantages/Disadvantages sections, and any
// other collapsible UI the character sheet adds later. Keys share a
// `prime.collapse.` prefix so they're easy to find and clear in
// browser devtools.
//
// Values stored as '1' (collapsed) / '0' (expanded). Absent values
// default to expanded — low-friction first-visit behavior.
//
// Private-mode browsers can throw on localStorage access, so we fall
// back to an in-memory Map for the session. Matches the pattern from
// the Advantages module.

const _memoryCollapse = new Map();

// Read the stored collapse flag for a key. Returns true if collapsed,
// false if expanded or missing.
export function getCollapsed(key) {
  if (!key) return false;
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v === '1';
  } catch (_) { /* fall through */ }
  return _memoryCollapse.get(key) === true;
}

// Write the collapse flag for a key. Boolean-coerces the value.
export function setCollapsed(key, value) {
  if (!key) return;
  const v = value ? '1' : '0';
  try { window.localStorage.setItem(key, v); return; }
  catch (_) { /* fall through */ }
  _memoryCollapse.set(key, !!value);
}

// Flip the flag and return the new value. Convenient for toggle
// handlers that also want to know the result.
export function toggleCollapsed(key) {
  const next = !getCollapsed(key);
  setCollapsed(key, next);
  return next;
}
