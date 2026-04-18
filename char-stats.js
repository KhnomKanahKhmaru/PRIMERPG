// char-stats.js
// Handles the Stats section: STR/DEX/PER/CHA/INT/POW/SIZE.
//
// UI structure per stat:
//   - stat-view-{key}   : read-only row (icon + total + mod exponent)
//   - stat-edit-{key}   : edit row (±buttons + number input + mod badge)
//   - modpanel-{key}    : collapsible list of named modifiers, add/remove
//
// SIZE is special-cased — no STATMOD, uses a SIZE_OPTIONS dropdown
// instead of a number input, and its total uses getSizeLabel().
//
// The stat's final value = base + sum of modifier values. Modifiers are
// stored under charData.statModifiers[key] as { name, value } entries.
//
// Factory pattern. createStatsSection(ctx) returns bound handlers.

import {
  STAT_DEFS,
  STAT_DESCRIPTIONS,
  STAT_XP,
  SIZE_OPTIONS
} from './char-constants.js';
import {
  getStatMod,
  getStatLabel,
  getSizeLabel,
  getStatLevelText,
  statIcon
} from './char-util.js';
import { saveCharacter } from './char-firestore.js';

export function createStatsSection(ctx) {
  // ctx shape:
  //   getCharData()        -> live charData
  //   getCanEdit()         -> boolean
  //   getCharId()          -> string
  //   getStatsEditMode()   -> boolean
  //   setStatsEditMode(v)  -> setter
  //   saveXpSpent()        -> async: recompute and persist total XP

  // ─── INTERNAL HELPERS ───

  // Total stat value = base + sum of modifiers.
  function getStatTotal(k) {
    const charData = ctx.getCharData();
    const d = STAT_DEFS.find(s => s.key === k);
    const b = (charData.stats && charData.stats[k] !== undefined)
      ? charData.stats[k] : d.default;
    const m = (charData.statModifiers && charData.statModifiers[k])
      ? charData.statModifiers[k] : [];
    return b + m.reduce((s, x) => s + (parseInt(x.value) || 0), 0);
  }

  // Render the list of named modifiers inside a stat's ModPanel.
  function renderModList(key) {
    const charData = ctx.getCharData();
    const mods = (charData.statModifiers && charData.statModifiers[key])
      ? charData.statModifiers[key] : [];
    const el = document.getElementById('modlist-' + key);
    if (!el) return;
    el.innerHTML = mods.length === 0
      ? '<div style="color:#333;font-size:11px;margin-bottom:4px">No modifiers.</div>'
      : mods.map((m, i) =>
          `<div class="mod-item">` +
            `<span class="mod-item-name">${m.name}</span>` +
            `<span class="mod-item-val">${m.value >= 0 ? '+' : ''}${m.value}</span>` +
            `<span class="mod-delete" onclick="deleteModifier('${key}',${i})">×</span>` +
          `</div>`
        ).join('');
    updateStatViewDisplay(key);
  }

  // Refresh the on-screen total, STATMOD badge, and level label for a stat
  // without rebuilding the whole section. Called after any change.
  function updateStatViewDisplay(key) {
    const total = getStatTotal(key);
    const mod = key !== 'size' ? getStatMod(total) : null;
    const modStr = mod !== null ? (mod >= 0 ? '+' + mod : '' + mod) : '';

    const t = document.getElementById('stat-total-' + key);
    if (t) t.textContent = key === 'size' ? getSizeLabel(total) : total;

    const exp = document.getElementById('statmod-' + key);
    if (exp) exp.textContent = modStr;

    const l = document.getElementById('stat-level-' + key);
    if (l) l.textContent = getStatLevelText(key, total);

    // Edit-row mirrors of the same elements.
    const eb = document.getElementById('statmod-edit-' + key);
    if (eb) eb.textContent = modStr;
    const el = document.getElementById('stat-level-edit-' + key);
    if (el) el.textContent = getStatLevelText(key, total);
  }

  // ─── BUILDING THE SECTION ───

  function buildStatsSection() {
    const container = document.getElementById('stats-list');
    container.innerHTML = '';

    STAT_DEFS.forEach(s => {
      const total = getStatTotal(s.key);
      const charData = ctx.getCharData();
      const base = (charData.stats && charData.stats[s.key] !== undefined)
        ? charData.stats[s.key] : s.default;
      const mod = s.key !== 'size' ? getStatMod(total) : null;
      const modStr = mod !== null ? (mod >= 0 ? '+' + mod : '' + mod) : '';

      const wrapper = document.createElement('div');

      // ── VIEW ROW (read-only) ──
      const viewRow = document.createElement('div');
      viewRow.className = 'stat-row';
      viewRow.id = 'stat-view-' + s.key;
      viewRow.innerHTML =
        `<div class="stat-icon-wrap">` +
          `<div class="stat-icon">${statIcon(s.key)}</div>` +
          `<div class="stat-tooltip">${STAT_DESCRIPTIONS[s.key]}</div>` +
        `</div>` +
        `<div class="stat-info">` +
          `<div class="stat-label"><span class="abbr">${s.abbr}</span>${s.rest}</div>` +
          `<div class="stat-level-label" id="stat-level-${s.key}">${getStatLevelText(s.key, total)}</div>` +
        `</div>` +
        `<div class="stat-value-area">` +
          `<div class="stat-value-wrap">` +
            `<span class="stat-total-display" id="stat-total-${s.key}">${s.key === 'size' ? getSizeLabel(total) : total}</span>` +
            (mod !== null ? `<span class="stat-mod-exponent" id="statmod-${s.key}">${modStr}</span>` : '') +
          `</div>` +
        `</div>`;

      // ── EDIT ROW (hidden by default; revealed by toggleStatsEdit) ──
      const editRow = document.createElement('div');
      editRow.className = 'stat-row';
      editRow.id = 'stat-edit-' + s.key;
      editRow.style.display = 'none';

      if (s.key === 'size') {
        // SIZE uses a dropdown of discrete tiers.
        const sizeOpts = SIZE_OPTIONS.map(o =>
          `<option value="${o.value}" ${base === o.value ? 'selected' : ''}>${o.label}</option>`
        ).join('');
        editRow.innerHTML =
          `<div class="stat-icon-wrap">` +
            `<div class="stat-icon">${statIcon(s.key)}</div>` +
            `<div class="stat-tooltip">${STAT_DESCRIPTIONS[s.key]}</div>` +
          `</div>` +
          `<div class="stat-info">` +
            `<div class="stat-label"><span class="abbr">${s.abbr}</span>${s.rest}</div>` +
          `</div>` +
          `<div class="stat-value-area">` +
            `<select class="stat-size-select" id="stat-input-${s.key}" onchange="saveStatBase('${s.key}',this.value)">${sizeOpts}</select>` +
          `</div>`;
      } else {
        // Everything else uses a number input with ± buttons and a ModPanel toggle.
        const xpCost = STAT_XP[Math.min(Math.max(1, base), 6)] || 0;
        const xpStr = xpCost > 0 ? '+' + xpCost + 'xp' : xpCost + 'xp';
        editRow.innerHTML =
          `<div class="stat-icon-wrap">` +
            `<div class="stat-icon">${statIcon(s.key)}</div>` +
            `<div class="stat-tooltip">${STAT_DESCRIPTIONS[s.key]}</div>` +
          `</div>` +
          `<div class="stat-info">` +
            `<div class="stat-label"><span class="abbr">${s.abbr}</span>${s.rest}</div>` +
            `<div class="stat-level-label" id="stat-level-edit-${s.key}">${getStatLevelText(s.key, total)}</div>` +
          `</div>` +
          `<div class="stat-value-area">` +
            `<div class="stat-input-row">` +
              `<button class="stat-adj-btn" onclick="adjustStat('${s.key}',-1)">−</button>` +
              `<input type="number" class="stat-base-input" id="stat-input-${s.key}" min="1" max="20" value="${base}" ` +
                `oninput="onStatInput('${s.key}',this.value)" ` +
                `onchange="saveStatBase('${s.key}',this.value)">` +
              `<button class="stat-adj-btn" onclick="adjustStat('${s.key}',1)">+</button>` +
            `</div>` +
            `<div class="stat-mod-row">` +
              `<div class="stat-mod-badge" id="statmod-edit-${s.key}">${modStr}</div>` +
              `<span style="font-size:9px;color:#555" id="stat-xp-${s.key}">${xpStr}</span>` +
              `<button class="stat-pm-btn" onclick="toggleModPanel('${s.key}')">+/−</button>` +
            `</div>` +
          `</div>`;
      }

      // ── MOD PANEL (collapsible named-modifier list) ──
      const modPanel = document.createElement('div');
      modPanel.className = 'stat-mod-panel';
      modPanel.id = 'modpanel-' + s.key;
      modPanel.style.display = 'none';
      modPanel.innerHTML =
        `<div id="modlist-${s.key}"></div>` +
        `<div class="mod-add-row">` +
          `<input type="text" id="modname-${s.key}" placeholder="Modifier name">` +
          `<input type="number" id="modval-${s.key}" value="1">` +
          `<button class="mod-add-btn" onclick="addModifier('${s.key}')">Add</button>` +
        `</div>`;

      wrapper.appendChild(viewRow);
      wrapper.appendChild(editRow);
      wrapper.appendChild(modPanel);
      container.appendChild(wrapper);
      renderModList(s.key);
    });
  }

  // ─── EDIT MODE TOGGLES ───

  function toggleStatsEdit() {
    const nextMode = !ctx.getStatsEditMode();
    ctx.setStatsEditMode(nextMode);
    document.getElementById('stats-edit-btn').textContent = nextMode ? 'Done' : 'Edit';
    STAT_DEFS.forEach(s => {
      document.getElementById('stat-view-' + s.key).style.display = nextMode ? 'none' : 'flex';
      document.getElementById('stat-edit-' + s.key).style.display = nextMode ? 'flex' : 'none';
      // When leaving edit mode, also collapse any open ModPanels.
      if (!nextMode) {
        const p = document.getElementById('modpanel-' + s.key);
        if (p) p.style.display = 'none';
      }
    });
  }

  function toggleModPanel(key) {
    const p = document.getElementById('modpanel-' + key);
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
  }

  // ─── VALUE HANDLERS ───

  // Called from the input's oninput — updates on-screen feedback as the
  // user types but doesn't save yet. Save happens on change (blur/enter)
  // via saveStatBase.
  function onStatInput(key, val) {
    const charData = ctx.getCharData();
    const v = Math.max(1, Math.min(20, parseInt(val) || 1));
    if (!charData.stats) charData.stats = {};
    charData.stats[key] = v;

    const total = getStatTotal(key);
    const mod = getStatMod(total);
    const modStr = mod >= 0 ? '+' + mod : '' + mod;

    const badge = document.getElementById('statmod-edit-' + key);
    if (badge) badge.textContent = modStr;
    const levelEl = document.getElementById('stat-level-edit-' + key);
    if (levelEl) levelEl.textContent = getStatLevelText(key, total);
    const xpEl = document.getElementById('stat-xp-' + key);
    if (xpEl) {
      const c = STAT_XP[Math.min(Math.max(1, v), 6)] || 0;
      xpEl.textContent = (c > 0 ? '+' + c : c) + 'xp';
    }
  }

  async function adjustStat(key, delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.stats) charData.stats = {};
    const cur = charData.stats[key] !== undefined
      ? charData.stats[key]
      : STAT_DEFS.find(s => s.key === key).default;
    const nv = Math.max(1, Math.min(20, cur + delta));
    charData.stats[key] = nv;
    const inp = document.getElementById('stat-input-' + key);
    if (inp) inp.value = nv;
    await saveCharacter(ctx.getCharId(), { [`stats.${key}`]: nv });
    onStatInput(key, nv);
    updateStatViewDisplay(key);
    if (key !== 'size') await ctx.saveXpSpent();
  }

  async function saveStatBase(key, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    // SIZE is an integer from a discrete set; others are clamped 1–20.
    const v = key === 'size' ? parseInt(val) : Math.max(1, Math.min(20, parseInt(val) || 1));
    if (!charData.stats) charData.stats = {};
    charData.stats[key] = v;
    await saveCharacter(ctx.getCharId(), { [`stats.${key}`]: v });
    updateStatViewDisplay(key);
    if (key !== 'size') await ctx.saveXpSpent();
  }

  // ─── MODIFIER HANDLERS ───

  async function addModifier(key) {
    const charData = ctx.getCharData();
    const name = document.getElementById('modname-' + key).value.trim();
    const val = parseInt(document.getElementById('modval-' + key).value) || 0;
    if (!name) return;
    if (!charData.statModifiers) charData.statModifiers = {};
    if (!charData.statModifiers[key]) charData.statModifiers[key] = [];
    charData.statModifiers[key].push({ name, value: val });
    await saveCharacter(ctx.getCharId(), { statModifiers: charData.statModifiers });
    document.getElementById('modname-' + key).value = '';
    document.getElementById('modval-' + key).value = '1';
    renderModList(key);
  }

  async function deleteModifier(key, i) {
    const charData = ctx.getCharData();
    charData.statModifiers[key].splice(i, 1);
    await saveCharacter(ctx.getCharId(), { statModifiers: charData.statModifiers });
    renderModList(key);
  }

  return {
    // Orchestration
    buildStatsSection,

    // Exposed helper — other modules (e.g. a future combat section) may
    // want to query stat totals. Keeping it public for now.
    getStatTotal,

    // Edit-mode toggles
    toggleStatsEdit, toggleModPanel,

    // Value handlers
    onStatInput, adjustStat, saveStatBase,

    // Modifier handlers
    addModifier, deleteModifier,
  };
}
