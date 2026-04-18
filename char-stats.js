// char-stats.js
// Handles the Stats section. Every aspect is ruleset-driven now:
//
//   - The list of stats (STR, DEX, etc.) comes from ruleset.stats —
//     homebrew rulesets can add, remove, or rename them.
//   - XP cost per level comes from ruleset.statXp
//   - STATMOD per level comes from ruleset.statMods
//   - Flavor labels per level come from ruleset.statLabels
//   - SIZE is rendered separately using ruleset.size.tiers
//   - Stat cap is ruleset.statMax
//
// SIZE is always rendered as the last stat row, whether or not it's in
// ruleset.stats (it isn't — size lives in its own block in the schema).
//
// Stats are keyed in charData.stats by their lowercase code, e.g.
// charData.stats.str = 4. The ruleset uses uppercase codes like "STR".
//
// Icon fallback: STAT_ICONS covers the base six stats plus size. For
// homebrew stats without a bundled icon we fall back to the POW icon —
// good enough placeholder until per-ruleset icon support lands.

import { STAT_ICONS } from './char-constants.js';
import { saveCharacter } from './char-firestore.js';

export function createStatsSection(ctx) {
  // ctx shape:
  //   getCharData()        -> live charData
  //   getCanEdit()         -> boolean
  //   getCharId()          -> string
  //   getStatsEditMode()   -> boolean
  //   setStatsEditMode(v)  -> setter
  //   saveXpSpent()        -> async
  //   getRuleset()         -> active ruleset

  // ─── RULESET LOOKUPS ───

  // The definitive list of stat rows to render. Combines ruleset.stats
  // (regular stats like STR) with a synthetic SIZE row at the end.
  function getStatList() {
    const rs = ctx.getRuleset();
    const stats = (rs && Array.isArray(rs.stats)) ? rs.stats : [];
    const list = stats.map(s => ({
      key: (s.code || '').toLowerCase(),
      code: s.code || '',
      name: s.name || s.code || '',
      description: s.description || '',
      isSize: false,
    }));
    list.push({
      key: 'size',
      code: 'SIZE',
      name: 'Size',
      description: 'Your size.',
      isSize: true,
    });
    return list;
  }

  function getStatMax() {
    const rs = ctx.getRuleset();
    return (rs && rs.statMax) || 20;
  }

  function getStatXpAt(v) {
    const rs = ctx.getRuleset();
    const table = (rs && rs.statXp) || [];
    return table[v] || 0;
  }

  function getStatModAt(v) {
    const rs = ctx.getRuleset();
    const mods = (rs && rs.statMods) || [];
    // If v is out of range, fall back to the last defined value or 0.
    if (mods[v] !== undefined) return mods[v];
    if (mods.length > 0) return mods[mods.length - 1];
    return 0;
  }

  function getStatLabelAt(v) {
    const rs = ctx.getRuleset();
    const labels = (rs && rs.statLabels) || [];
    return labels[v] || '';
  }

  function getSizeTiers() {
    const rs = ctx.getRuleset();
    return (rs && rs.size && Array.isArray(rs.size.tiers)) ? rs.size.tiers : [];
  }

  function getSizeDefault() {
    const rs = ctx.getRuleset();
    return (rs && rs.size && rs.size.default) || 6;
  }

  // Convert a size level (number like 6) to a display label like "6 — Medium".
  function getSizeLabel(level) {
    const tiers = getSizeTiers();
    const tier = tiers.find(t => t.level === level);
    if (tier) return `${tier.level} — ${tier.label}`;
    return `${level}`;
  }

  // Default stat base value — most rulesets put free XP at level 2, so
  // that's our default starting point. Used when charData.stats doesn't
  // have an entry for a given stat yet.
  function getStatDefault(s) {
    return s.isSize ? getSizeDefault() : 2;
  }

  // SVG icon for a stat. Falls back to POW's icon for homebrew codes
  // that don't have a bundled icon — good-enough placeholder.
  function renderStatIcon(key) {
    const pathData = STAT_ICONS[key] || STAT_ICONS['pow'] || '';
    return `<svg viewBox="0 0 512 512" width="36" height="36" xmlns="http://www.w3.org/2000/svg">` +
             `<rect width="512" height="512" fill="#000"/>` +
             `<path d="${pathData}" fill="#fff"/>` +
           `</svg>`;
  }

  // ─── STAT-VALUE HELPERS ───

  function getStatTotal(k) {
    const charData = ctx.getCharData();
    const list = getStatList();
    const s = list.find(x => x.key === k);
    const d = s ? getStatDefault(s) : 0;
    const b = (charData.stats && charData.stats[k] !== undefined) ? charData.stats[k] : d;
    const m = (charData.statModifiers && charData.statModifiers[k]) ? charData.statModifiers[k] : [];
    return b + m.reduce((acc, x) => acc + (parseInt(x.value) || 0), 0);
  }

  // The "level text" under each stat name, e.g. "You are of Exceptional STR".
  // SIZE uses its tier label instead.
  function getStatLevelText(s, total) {
    if (s.isSize) return getSizeLabel(total);
    const label = getStatLabelAt(total);
    return label ? `You are of ${label} ${s.code}` : s.code;
  }

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

  function updateStatViewDisplay(key) {
    const list = getStatList();
    const s = list.find(x => x.key === key);
    if (!s) return;
    const total = getStatTotal(key);
    const mod = s.isSize ? null : getStatModAt(total);
    const modStr = mod !== null ? (mod >= 0 ? '+' + mod : '' + mod) : '';

    const t = document.getElementById('stat-total-' + key);
    if (t) t.textContent = s.isSize ? getSizeLabel(total) : total;

    const exp = document.getElementById('statmod-' + key);
    if (exp) exp.textContent = modStr;

    const l = document.getElementById('stat-level-' + key);
    if (l) l.textContent = getStatLevelText(s, total);

    const eb = document.getElementById('statmod-edit-' + key);
    if (eb) eb.textContent = modStr;
    const el = document.getElementById('stat-level-edit-' + key);
    if (el) el.textContent = getStatLevelText(s, total);
  }

  // ─── BUILDING THE SECTION ───

  function buildStatsSection() {
    const container = document.getElementById('stats-list');
    container.innerHTML = '';
    const list = getStatList();
    const statMax = getStatMax();

    list.forEach(s => {
      const charData = ctx.getCharData();
      const total = getStatTotal(s.key);
      const base = (charData.stats && charData.stats[s.key] !== undefined)
        ? charData.stats[s.key] : getStatDefault(s);
      const mod = s.isSize ? null : getStatModAt(total);
      const modStr = mod !== null ? (mod >= 0 ? '+' + mod : '' + mod) : '';

      // Abbreviation + rest-of-name: display "STR" + "ength" as
      // <span class="abbr">STR</span>ength. Most stat names begin with the
      // stat's code; if not, we just render the full name without split.
      const codeUpper = s.code.toUpperCase();
      const nameMatchesCode = s.name.toUpperCase().startsWith(codeUpper);
      const rest = nameMatchesCode ? s.name.slice(codeUpper.length) : '';
      const labelHtml = nameMatchesCode
        ? `<span class="abbr">${codeUpper}</span>${rest}`
        : s.name;

      const wrapper = document.createElement('div');

      // ── VIEW ROW ──
      const viewRow = document.createElement('div');
      viewRow.className = 'stat-row';
      viewRow.id = 'stat-view-' + s.key;
      viewRow.innerHTML =
        `<div class="stat-icon-wrap">` +
          `<div class="stat-icon">${renderStatIcon(s.key)}</div>` +
          `<div class="stat-tooltip">${s.description}</div>` +
        `</div>` +
        `<div class="stat-info">` +
          `<div class="stat-label">${labelHtml}</div>` +
          `<div class="stat-level-label" id="stat-level-${s.key}">${getStatLevelText(s, total)}</div>` +
        `</div>` +
        `<div class="stat-value-area">` +
          `<div class="stat-value-wrap">` +
            `<span class="stat-total-display" id="stat-total-${s.key}">${s.isSize ? getSizeLabel(total) : total}</span>` +
            (mod !== null ? `<span class="stat-mod-exponent" id="statmod-${s.key}">${modStr}</span>` : '') +
          `</div>` +
        `</div>`;

      // ── EDIT ROW ──
      const editRow = document.createElement('div');
      editRow.className = 'stat-row';
      editRow.id = 'stat-edit-' + s.key;
      editRow.style.display = 'none';

      if (s.isSize) {
        // SIZE uses a dropdown of tiers from the ruleset.
        const tiers = getSizeTiers();
        const sizeOpts = tiers.map(t =>
          `<option value="${t.level}" ${base === t.level ? 'selected' : ''}>${t.level} — ${t.label}</option>`
        ).join('');
        editRow.innerHTML =
          `<div class="stat-icon-wrap">` +
            `<div class="stat-icon">${renderStatIcon(s.key)}</div>` +
            `<div class="stat-tooltip">${s.description}</div>` +
          `</div>` +
          `<div class="stat-info">` +
            `<div class="stat-label">${labelHtml}</div>` +
          `</div>` +
          `<div class="stat-value-area">` +
            `<select class="stat-size-select" id="stat-input-${s.key}" onchange="saveStatBase('${s.key}',this.value)">${sizeOpts}</select>` +
          `</div>`;
      } else {
        // Regular stats: number input with ± and ModPanel.
        const xpCost = getStatXpAt(base);
        const xpStr = xpCost > 0 ? '+' + xpCost + 'xp' : xpCost + 'xp';
        editRow.innerHTML =
          `<div class="stat-icon-wrap">` +
            `<div class="stat-icon">${renderStatIcon(s.key)}</div>` +
            `<div class="stat-tooltip">${s.description}</div>` +
          `</div>` +
          `<div class="stat-info">` +
            `<div class="stat-label">${labelHtml}</div>` +
            `<div class="stat-level-label" id="stat-level-edit-${s.key}">${getStatLevelText(s, total)}</div>` +
          `</div>` +
          `<div class="stat-value-area">` +
            `<div class="stat-input-row">` +
              `<button class="stat-adj-btn" onclick="adjustStat('${s.key}',-1)">−</button>` +
              `<input type="number" class="stat-base-input" id="stat-input-${s.key}" min="1" max="${statMax}" value="${base}" ` +
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

      // ── MOD PANEL ──
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
    const list = getStatList();
    list.forEach(s => {
      document.getElementById('stat-view-' + s.key).style.display = nextMode ? 'none' : 'flex';
      document.getElementById('stat-edit-' + s.key).style.display = nextMode ? 'flex' : 'none';
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

  function onStatInput(key, val) {
    const charData = ctx.getCharData();
    const statMax = getStatMax();
    const v = Math.max(1, Math.min(statMax, parseInt(val) || 1));
    if (!charData.stats) charData.stats = {};
    charData.stats[key] = v;

    const total = getStatTotal(key);
    const mod = getStatModAt(total);
    const modStr = mod >= 0 ? '+' + mod : '' + mod;

    const badge = document.getElementById('statmod-edit-' + key);
    if (badge) badge.textContent = modStr;

    const list = getStatList();
    const s = list.find(x => x.key === key);
    const levelEl = document.getElementById('stat-level-edit-' + key);
    if (levelEl && s) levelEl.textContent = getStatLevelText(s, total);

    const xpEl = document.getElementById('stat-xp-' + key);
    if (xpEl) {
      const c = getStatXpAt(v);
      xpEl.textContent = (c > 0 ? '+' + c : c) + 'xp';
    }
  }

  async function adjustStat(key, delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const list = getStatList();
    const s = list.find(x => x.key === key);
    const statMax = getStatMax();
    if (!charData.stats) charData.stats = {};
    const cur = charData.stats[key] !== undefined ? charData.stats[key] : (s ? getStatDefault(s) : 1);
    const nv = Math.max(1, Math.min(statMax, cur + delta));
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
    const statMax = getStatMax();
    // SIZE is an integer tier level; everything else is clamped 1..statMax.
    const v = key === 'size' ? parseInt(val) : Math.max(1, Math.min(statMax, parseInt(val) || 1));
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
    buildStatsSection,
    getStatTotal,
    // Expose the stat list so main can iterate it (e.g. for XP totaling).
    getStatList,
    toggleStatsEdit, toggleModPanel,
    onStatInput, adjustStat, saveStatBase,
    addModifier, deleteModifier,
  };
}
