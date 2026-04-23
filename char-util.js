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

// Force a collapsible section open. If currently collapsed, flips the
// stored flag to expanded. Returns true if a change was made, false
// if already expanded. Caller should typically follow up with whatever
// re-render or refresh their collapse system uses to repaint the UI
// (for the Overview tab: window.refreshOverviewCollapse). Useful for
// edit-mode handlers that want to guarantee their panel is visible
// before swapping view/edit displays — otherwise the user can click
// Edit on a collapsed section, the Edit button hides, but the edit
// form is buried inside the collapsed body with no visible way out.
export function ensureExpanded(key) {
  if (!getCollapsed(key)) return false;
  setCollapsed(key, false);
  return true;
}

// Wire up a generic collapsible section.
//
// Prepends a ▸/▾ caret to the header, adds a click handler that toggles
// the persisted collapse flag, and show/hides the body elements based
// on the current state. Idempotent — calling twice on the same header
// is safe; subsequent calls just refresh the visual state without re-
// binding handlers.
//
// Parameters:
//   header   — the element whose inside gets a caret prepended and
//              which receives the click/keyboard listener. Should be a
//              text-bearing element (e.g. a title div or span).
//   bodies   — array of elements that hide when collapsed. Nulls are
//              silently skipped. Uses inline style.display so the
//              initial display value is preserved when expanding.
//   key      — localStorage key used to persist the flag.
//   opts     — optional:
//                onToggle: function(newCollapsedState) called after
//                         each toggle. Use it to refresh computed UI
//                         (e.g. re-run skills render to re-wire).
//                caretColor: override '#555' default for the caret.
//
// Returns a refresh() function that re-reads the current state from
// storage and re-applies UI — useful when a re-render has replaced
// the body elements and you want to re-hide them without a toggle.
export function attachCollapsible(header, bodies, key, opts) {
  if (!header) return () => {};
  opts = opts || {};
  bodies = (bodies || []).filter(Boolean);

  // Store the current binding on the header element itself so re-attach
  // calls can refresh bodies/opts/key without losing handler state.
  // Handlers reference `_ccBinding` which we keep current — even a
  // re-attach with new bodies or a new key takes effect the next time
  // apply() runs. This solves the stale-closure problem we'd hit with
  // naïve one-shot binding.
  const binding = header._ccBinding || {};
  binding.bodies = bodies;
  binding.key = key;
  binding.opts = opts;
  header._ccBinding = binding;

  // Inject caret once. On subsequent calls, we just find and reuse it.
  let caret = header.querySelector(':scope > .ad-caret, :scope > .cc-caret');
  if (!caret) {
    caret = document.createElement('span');
    caret.className = 'cc-caret';
    caret.style.flexShrink = '0';
    caret.style.marginRight = '6px';
    caret.style.fontSize = '10px';
    caret.style.color = opts.caretColor || '#555';
    caret.style.transition = 'color .1s';
    header.insertBefore(caret, header.firstChild);
  }
  binding.caret = caret;

  // Mark header as clickable. One-time attribute setup. Handlers read
  // header._ccBinding every time they fire, so always see latest state.
  if (!header.dataset.collapseBound) {
    header.classList.add('cc-collapsible');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.addEventListener('click', () => _ccToggle(header));
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _ccToggle(header); }
    });
    header.dataset.collapseBound = '1';
  }

  function apply() {
    const b = header._ccBinding;
    if (!b) return;
    const collapsed = getCollapsed(b.key);
    b.caret.textContent = collapsed ? '▸ ' : '▾ ';
    header.title = collapsed ? 'Expand section' : 'Collapse section';
    b.bodies.forEach(el => {
      if (!el) return;
      if (collapsed) {
        // About to hide. Stash whatever inline display value was set
        // by OTHER code paths (edit-mode show/hide handlers, etc.) so
        // we can restore it when expanding. If no prior inline value
        // existed, stash an empty string — that's "use CSS default".
        //
        // Only stash the first time we collapse; subsequent collapses
        // without an intervening expand would overwrite the real
        // original with our own 'none'.
        if (el.dataset.ccDisplayStash === undefined) {
          el.dataset.ccDisplayStash = el.style.display || '';
        }
        el.style.display = 'none';
      } else {
        // Expanding. Restore the stashed value if we have one; if the
        // element was never collapsed by us, leave its display alone
        // entirely. This is crucial: without this guard, calling
        // apply() during a re-render would clobber display values set
        // by imperative handlers like doneObligations / editDisorders
        // that toggle view-mode vs edit-mode by hand, causing both
        // panels to show simultaneously or the wrong one to show.
        if (el.dataset.ccDisplayStash !== undefined) {
          el.style.display = el.dataset.ccDisplayStash;
          delete el.dataset.ccDisplayStash;
        }
      }
    });
  }
  binding.apply = apply;

  apply();
  return apply;   // refresh() — caller can re-invoke after a re-render
}

// Internal toggle — uses the live binding on the header so re-attach
// calls that replaced opts/key/bodies are respected.
function _ccToggle(header) {
  const b = header._ccBinding;
  if (!b) return;
  const now = toggleCollapsed(b.key);
  if (b.apply) b.apply();
  if (b.opts && typeof b.opts.onToggle === 'function') b.opts.onToggle(now);
}

// ── RENDER-AWARE COLLAPSIBLE SECTION ──
//
// For modules that rebuild HTML strings on every render (combat.js,
// inventory.js), it's easier to emit collapse-aware markup inline than
// to re-wire DOM after the fact. This helper returns a self-contained
// HTML string that respects the persisted collapse state AND dispatches
// clicks back to a global toggle handler.
//
// Parameters:
//   key       — localStorage key, e.g. 'prime.collapse.combat.movement'.
//               Also used as the data-collapse-key so the click handler
//               can find it.
//   headHtml  — HTML string for the header content (excluding caret).
//               Rendered INSIDE the clickable header; the caret is
//               prepended automatically.
//   bodyHtml  — HTML string for the body. Hidden when collapsed.
//   opts      — optional:
//                 rerenderHandler: name of a `window.X(key)` function to
//                                 call when the header is clicked. It
//                                 should toggle state + re-render the
//                                 parent tab. Defaults to 'collapsibleToggle'.
//                 wrapperClass:    extra class on the outer wrapper div,
//                                 e.g. 'combat-section'
//                 collapsibleClass: extra class on the collapsible head,
//                                  e.g. 'combat-section-title' so it
//                                  inherits existing styling.
//                 headTag:          tag for the head element (default 'div')
//
// Output shape (collapsed=false):
//   <div class="cc-wrap <wrapperClass>" data-ccwrap="<key>">
//     <div class="cc-collapsible cc-head <collapsibleClass>"
//          role="button" tabindex="0"
//          data-collapse-key="<key>"
//          onclick="<rerenderHandler>('<key>')"
//          onkeydown="...if Enter/Space, toggle..."><span class="cc-caret">▾ </span><headHtml></div>
//     <div class="cc-body"><bodyHtml></div>
//   </div>
//
// When collapsed=true, the body div gets class `cc-body cc-body-hidden`
// (display:none via CSS) and the caret glyph switches to ▸.
export function wrapCollapsibleSection(key, headHtml, bodyHtml, opts) {
  opts = opts || {};
  const collapsed = getCollapsed(key);
  const caret = collapsed ? '▸ ' : '▾ ';
  const handler = opts.rerenderHandler || 'collapsibleToggle';
  const wrapperCls = ['cc-wrap', opts.wrapperClass || ''].filter(Boolean).join(' ');
  const collapsibleCls = ['cc-collapsible', 'cc-head', opts.collapsibleClass || ''].filter(Boolean).join(' ');
  const bodyCls = collapsed ? 'cc-body cc-body-hidden' : 'cc-body';
  const title = collapsed ? 'Expand section' : 'Collapse section';
  const headTag = opts.headTag || 'div';
  // Quote the key for inline JS — keys are internally-authored and
  // contain no quotes, but escape anyway for safety.
  const keyJs = String(key).replace(/'/g, "\\'");
  return `<div class="${wrapperCls}" data-ccwrap="${escapeAttr(key)}">
    <${headTag} class="${collapsibleCls}" role="button" tabindex="0"
      data-collapse-key="${escapeAttr(key)}"
      onclick="${handler}('${keyJs}')"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${handler}('${keyJs}')}"
      title="${title}"><span class="cc-caret">${caret}</span>${headHtml}</${headTag}>
    <div class="${bodyCls}">${bodyHtml}</div>
  </div>`;
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── DESCRIPTION OVERRIDE SYSTEM ───
//
// PRIME lets both GMs (via ruleset) and players (via character-level
// overrides) customize the hover/display descriptions for game-content
// concepts — stats, derived stats, skills, advantages, weapon tags,
// conditions. This is the resolver + renderer layer used by every
// surface that shows one of those descriptions.
//
// Resolution order (first non-null wins):
//   1. character.descriptionOverrides[category][id]  — player override
//   2. ruleset-defined description                   — GM default
//   3. empty string                                  — fallback
//
// `category` is one of: 'stats', 'derivedStats', 'skills', 'advantages',
// 'tags', 'conditions'. `id` is the stable identifier for that category
// (stat code, skill name, advantage id, etc.).
//
// Callers pass the resolved text through escapeHtml/escapeAttr as needed
// — this helper does NOT escape. Keep it raw so the caller can choose
// how to render (tooltip attr vs. HTML body).
export function resolveDescription(category, id, ruleset, character) {
  if (!category || !id) return '';
  // Player override wins if present (including empty string — explicit
  // "hide this description" choice).
  const overrides = character && character.descriptionOverrides;
  if (overrides && typeof overrides === 'object') {
    const bucket = overrides[category];
    if (bucket && typeof bucket === 'object' && Object.prototype.hasOwnProperty.call(bucket, id)) {
      const v = bucket[id];
      if (typeof v === 'string') return v;
    }
  }
  // Fall back to ruleset default. Each category stores descriptions
  // differently (stats is an array, advantages is a tree, etc.), so
  // this helper delegates to per-category lookups.
  return lookupRulesetDescription(category, id, ruleset);
}

function lookupRulesetDescription(category, id, ruleset) {
  if (!ruleset || typeof ruleset !== 'object') return '';
  switch (category) {
    case 'stats': {
      const stats = Array.isArray(ruleset.stats) ? ruleset.stats : [];
      const hit = stats.find(s => s && s.code === id);
      return (hit && typeof hit.description === 'string') ? hit.description : '';
    }
    case 'derivedStats': {
      const list = Array.isArray(ruleset.derivedStats) ? ruleset.derivedStats : [];
      const hit = list.find(s => s && s.code === id);
      return (hit && typeof hit.description === 'string') ? hit.description : '';
    }
    // Phase-1 only covers stats + derivedStats. The other four
    // categories fall through to empty here; they'll be wired in
    // Phase 2 as we add their editor UIs to character-sheet surfaces.
    default:
      return '';
  }
}

// Check whether a specific description has a player override in place.
// Used by the UI to decide whether to show the reset button.
export function hasDescriptionOverride(category, id, character) {
  if (!category || !id || !character) return false;
  const overrides = character.descriptionOverrides;
  if (!overrides || typeof overrides !== 'object') return false;
  const bucket = overrides[category];
  if (!bucket || typeof bucket !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(bucket, id);
}

// Ensure the override bucket exists on the character object, returning
// it for in-place mutation. Handlers use this before setting a value
// so they don't have to branch on whether the structure exists yet.
export function ensureDescriptionOverrideBucket(character, category) {
  if (!character || !category) return null;
  if (!character.descriptionOverrides || typeof character.descriptionOverrides !== 'object') {
    character.descriptionOverrides = {};
  }
  if (!character.descriptionOverrides[category] || typeof character.descriptionOverrides[category] !== 'object') {
    character.descriptionOverrides[category] = {};
  }
  return character.descriptionOverrides[category];
}
