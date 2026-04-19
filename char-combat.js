// char-combat.js
// Renders the Combat tab on the character sheet:
//   - Derived stats (HP, SPD, AGL, Reflex, etc.) grouped by category
//   - Hit locations with damage trackers
//   - Power Pool purchase UI
//
// Values auto-recompute on every render via char-derived.js. Recomputing
// is cheap (<1ms) so no caching; simpler and always current.

import { saveCharacter } from './char-firestore.js';
import { computeDerivedStats, powerPoolXpCost } from './char-derived.js';

export function createCombatSection(ctx) {
  // ctx shape:
  //   getCharData()  -> live charData
  //   getCanEdit()   -> boolean (character owner)
  //   getCharId()    -> string
  //   getRuleset()   -> active ruleset
  //   saveXpSpent()  -> async; recomputes total XP after Power Pool change

  // ─── FORMATTING ───
  // Tidy number display. Integers show as-is. Decimals round to 2dp and
  // strip trailing zeros (0.141421 -> 0.14; 5.0 -> 5; 2.5 -> 2.5).
  function fmt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    if (!Number.isFinite(n)) return '—';
    if (Number.isInteger(n)) return String(n);
    return parseFloat(n.toFixed(2)).toString();
  }

  // ─── MAIN RENDER ───

  function renderAll() {
    const container = document.getElementById('combat-content');
    if (!container) return;
    const ruleset = ctx.getRuleset();
    const charData = ctx.getCharData();
    if (!ruleset) {
      container.innerHTML = '<div class="combat-empty">No ruleset loaded.</div>';
      return;
    }

    const result = computeDerivedStats(charData, ruleset);

    let html = '';
    html += renderDerivedStatsSection(result, ruleset);
    html += renderHitLocationsSection(result);
    html += renderPowerPoolSection(ruleset, charData);
    container.innerHTML = html || '<div class="combat-empty">No combat data configured in this ruleset.</div>';
  }

  // ─── DERIVED STATS ───

  function renderDerivedStatsSection(result, ruleset) {
    const groups = ruleset.derivedStatGroups || [];

    // Bucket stats by group code. Stats with an invalid group fall into an
    // "orphan" bucket shown at the end.
    const buckets = new Map();
    groups.forEach(g => buckets.set(g.code, []));
    const orphans = [];
    result.stats.forEach((entry) => {
      const g = entry.def.group;
      if (buckets.has(g)) buckets.get(g).push(entry);
      else orphans.push(entry);
    });

    const anyStats = Array.from(buckets.values()).some(arr => arr.length > 0) || orphans.length > 0;
    if (!anyStats) return '';

    let html = '';
    groups.forEach(g => {
      const stats = buckets.get(g.code) || [];
      if (stats.length === 0) return;
      html += `<div class="combat-section">`;
      html += `<div class="combat-section-title">${escapeHtml(g.label)}</div>`;
      html += `<div class="ds-grid">`;
      stats.forEach(entry => { html += renderDsCard(entry); });
      html += `</div></div>`;
    });
    if (orphans.length > 0) {
      html += `<div class="combat-section">`;
      html += `<div class="combat-section-title">Other</div>`;
      html += `<div class="ds-grid">`;
      orphans.forEach(entry => { html += renderDsCard(entry); });
      html += `</div></div>`;
    }
    return html;
  }

  function renderDsCard(entry) {
    const { def, value, error } = entry;
    const display = error ? 'ERR' : fmt(value);
    const unit = def.unit ? ` <span class="ds-card-unit">${escapeHtml(def.unit)}</span>` : '';
    const errTitle = error ? ` title="${escapeHtml(error)}"` : '';
    const codeBadge = def.code && def.code !== def.name
      ? ` <span class="ds-card-code">${escapeHtml(def.code)}</span>`
      : '';
    return `
      <div class="ds-card"${errTitle}>
        <div class="ds-card-name">${escapeHtml(def.name)}${codeBadge}</div>
        <div class="ds-card-value${error ? ' ds-card-error' : ''}">${display}${unit}</div>
        ${def.description ? `<div class="ds-card-desc">${escapeHtml(def.description)}</div>` : ''}
      </div>`;
  }

  // ─── HIT LOCATIONS ───

  function renderHitLocationsSection(result) {
    if (!result.locations || result.locations.length === 0) return '';

    let html = '<div class="combat-section">';
    html += '<div class="combat-section-title">Hit Locations</div>';
    html += '<div class="hl-list">';
    result.locations.forEach(loc => { html += renderHlRow(loc); });
    html += '</div>';

    // Body total = sum of remaining HP across all locations.
    const totalMax = result.locations.reduce((s, l) => s + (l.maxHP || 0), 0);
    const totalDmg = result.locations.reduce((s, l) => s + (l.currentDamage || 0), 0);
    const remaining = totalMax - totalDmg;
    const dead = remaining <= 0;
    html += `<div class="body-total${dead ? ' body-total-dead' : ''}">`;
    html += `<span class="body-label">Body</span>`;
    html += `<span class="body-value">${remaining} / ${totalMax}</span>`;
    html += `<span class="body-status">${dead ? 'DEAD' : 'Alive'}</span>`;
    html += `</div>`;
    html += '</div>';
    return html;
  }

  function renderHlRow(loc) {
    const { def, trackKey, maxHP, currentDamage, status, error, index } = loc;
    const canEdit = ctx.getCanEdit();

    const displayName = (def.count && def.count > 1)
      ? `${def.name} (${index})`
      : def.name;

    if (error || maxHP === null) {
      return `<div class="hl-row hl-row-error" title="${escapeHtml(error || 'Formula error')}">
        <div class="hl-name">${escapeHtml(displayName)}</div>
        <div class="hl-error">Formula error</div>
      </div>`;
    }

    const remaining = maxHP - currentDamage;
    const damageCap = Math.max(maxHP * 3, 10);

    const statusLabels = {
      healthy: '',
      disabled: 'Disabled',
      destroyed: 'Destroyed',
      definitelyDestroyed: 'Def. Destroyed'
    };
    const statusLabel = statusLabels[status] || '';

    // Progressive HP bar — computed as two colored halves.
    //
    // Phase 1 (remaining between maxHP and 0, i.e. Healthy):
    //   Left half = healthy remaining (green), Right half = damage taken (red).
    //   As damage grows, left shrinks and right grows. At 0 HP, the whole bar
    //   is red, which visually equals orange (Phase 2 starting color).
    //
    // Phase 2 (remaining between 0 and -maxHP, i.e. Disabled → Destroyed):
    //   Base color is orange across the whole bar. As damage continues past 0,
    //   deep-red fills in from the LEFT, growing until at -maxHP the bar is
    //   fully deep-red.
    //
    // Phase 3 (remaining between -maxHP and -2*maxHP, i.e. Destroyed → Def. Destroyed):
    //   Base color is deep-red. Black fills in from the LEFT, growing until
    //   at -2*maxHP the bar is fully black.
    const barSegments = computeBarSegments(remaining, maxHP);

    const controls = canEdit
      ? `<div class="hl-controls">
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',-1)" title="Heal 1 HP">−</button>
          <input type="number" class="hl-dmg-input" value="${currentDamage}" min="0" max="${damageCap}"
                 onchange="setHitLocationDmg('${trackKey}',this.value)">
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',1)" title="Take 1 HP damage">+</button>
        </div>`
      : '';

    return `
      <div class="hl-row hl-status-${status}">
        <div class="hl-name">${escapeHtml(displayName)}</div>
        <div class="hl-bar-wrap">
          <div class="hl-bar-bg">
            <div class="hl-bar-seg" style="width:${barSegments.left.pct}%; background:${barSegments.left.color}"></div>
            <div class="hl-bar-seg" style="width:${barSegments.right.pct}%; background:${barSegments.right.color}"></div>
          </div>
          <div class="hl-bar-label">${remaining} / ${maxHP}</div>
        </div>
        <div class="hl-status-label">${escapeHtml(statusLabel)}</div>
        ${controls}
      </div>`;
  }

  // Compute the two bar segments for progressive HP display.
  // Returns { left: { pct, color }, right: { pct, color } } — percentages
  // total 100%. Each phase has its own base/overlay color pair.
  function computeBarSegments(remaining, maxHP) {
    if (maxHP <= 0) {
      return { left: { pct: 0, color: '#4a7a4a' }, right: { pct: 100, color: '#6a2a2a' } };
    }

    // Palette — tuned to progress naturally through the phases:
    //   healthy green → damage red (Phase 1)
    //   orange (= 0 HP state) → deep red (Phase 2)
    //   deep red → near-black (Phase 3)
    const GREEN    = '#4a7a4a';
    const RED      = '#9a3a3a';   // Phase 1 damage AND Phase 2 overlay color
    const ORANGE   = '#b87030';   // Phase 2 base (= appearance at exactly 0 HP)
    const DEEP_RED = '#5a1818';   // Phase 3 base
    const BLACK    = '#0a0a0a';   // Phase 3 overlay

    if (remaining >= 0) {
      // PHASE 1: remaining goes from maxHP down to 0.
      // Left (green) shrinks; right (red) grows.
      const leftPct  = Math.max(0, Math.min(100, (remaining / maxHP) * 100));
      const rightPct = 100 - leftPct;
      return {
        left:  { pct: leftPct,  color: GREEN },
        right: { pct: rightPct, color: RED }
      };
    }

    // How deep into "overkill" territory — how far past 0 are we?
    // At remaining=-maxHP we're exactly at Phase 2 end.
    // At remaining=-2*maxHP we're at Phase 3 end.
    const overkill = -remaining;  // positive number; how far past 0

    if (overkill <= maxHP) {
      // PHASE 2: overkill between 0 and maxHP.
      // Base color = orange (bar starts this phase fully orange when remaining=0)
      // Overlay (deep red) fills from LEFT as overkill grows.
      const overlayPct = Math.max(0, Math.min(100, (overkill / maxHP) * 100));
      const basePct    = 100 - overlayPct;
      return {
        left:  { pct: overlayPct, color: RED },      // deep damage red filling in
        right: { pct: basePct,    color: ORANGE }    // remaining orange base
      };
    }

    // PHASE 3: overkill between maxHP and 2*maxHP (clamped beyond that to full black).
    // Base color = deep red (bar starts this phase fully deep-red when overkill=maxHP)
    // Overlay (black) fills from LEFT as overkill grows past maxHP.
    const phase3Progress = overkill - maxHP;  // 0..maxHP in phase 3
    const overlayPct = Math.max(0, Math.min(100, (phase3Progress / maxHP) * 100));
    const basePct    = 100 - overlayPct;
    return {
      left:  { pct: overlayPct, color: BLACK },
      right: { pct: basePct,    color: DEEP_RED }
    };
  }

  // ─── POWER POOL ───

  function renderPowerPoolSection(ruleset, charData) {
    const pp = ruleset.powerPool;
    if (!pp || !pp.enabled) return '';

    const canEdit = ctx.getCanEdit();
    const level = (typeof charData.powerPool === 'number') ? charData.powerPool : 0;
    const max = pp.maxPurchasable || 10;
    const currentCost = powerPoolXpCost(level, ruleset);
    const nextLevelCost = level < max ? powerPoolXpCost(level + 1, ruleset) : null;
    const incrementCost = nextLevelCost !== null ? (nextLevelCost - currentCost) : null;

    const modeText = pp.costMode === 'perPoint'
      ? `${pp.costPerPoint || 0} XP per point`
      : 'Custom per-level table';

    let html = '<div class="combat-section">';
    html += `<div class="combat-section-title">${escapeHtml(pp.name || 'Power Pool')}</div>`;
    if (pp.description) {
      html += `<div class="pp-desc">${escapeHtml(pp.description)}</div>`;
    }

    html += `<div class="pp-row">`;
    html += `<div class="pp-label">Level</div>`;
    if (canEdit) {
      html += `<div class="pp-controls">
        <button class="pp-btn" onclick="tickPowerPool(-1)" ${level <= 0 ? 'disabled' : ''}>−</button>
        <input type="number" class="pp-input" value="${level}" min="0" max="${max}"
               onchange="setPowerPool(this.value)">
        <button class="pp-btn" onclick="tickPowerPool(1)" ${level >= max ? 'disabled' : ''}>+</button>
      </div>`;
    } else {
      html += `<div class="pp-value">${level}</div>`;
    }
    html += `<div class="pp-cost">`;
    html += `<div class="pp-cost-total">${currentCost} XP total</div>`;
    if (incrementCost !== null && canEdit) {
      html += `<div class="pp-cost-next">Next point: +${incrementCost} XP</div>`;
    }
    html += `</div>`;
    html += `</div>`;

    html += `<div class="pp-rate-note">${escapeHtml(modeText)} · Max ${max}</div>`;
    html += '</div>';
    return html;
  }

  // ─── HANDLERS ───

  async function tickHitLocationDmg(trackKey, delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.hitLocationDamage) charData.hitLocationDamage = {};
    const cur = charData.hitLocationDamage[trackKey] || 0;
    charData.hitLocationDamage[trackKey] = Math.max(0, cur + delta);
    await saveCharacter(ctx.getCharId(), { hitLocationDamage: charData.hitLocationDamage });
    renderAll();
  }

  async function setHitLocationDmg(trackKey, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.hitLocationDamage) charData.hitLocationDamage = {};
    const parsed = Math.max(0, parseInt(val) || 0);
    charData.hitLocationDamage[trackKey] = parsed;
    await saveCharacter(ctx.getCharId(), { hitLocationDamage: charData.hitLocationDamage });
    renderAll();
  }

  async function tickPowerPool(delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    const max = (ruleset.powerPool && ruleset.powerPool.maxPurchasable) || 10;
    const cur = (typeof charData.powerPool === 'number') ? charData.powerPool : 0;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    charData.powerPool = next;
    await saveCharacter(ctx.getCharId(), { powerPool: next });
    await ctx.saveXpSpent();
    renderAll();
  }

  async function setPowerPool(val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    const max = (ruleset.powerPool && ruleset.powerPool.maxPurchasable) || 10;
    const parsed = Math.max(0, Math.min(max, parseInt(val) || 0));
    if (parsed === charData.powerPool) return;
    charData.powerPool = parsed;
    await saveCharacter(ctx.getCharId(), { powerPool: parsed });
    await ctx.saveXpSpent();
    renderAll();
  }

  // Total XP spent on Power Pool — consumed by calcTotalXp in character.html
  // so the header XP bar reflects purchases.
  function powerPoolXpDelta() {
    const charData = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    const level = (typeof charData.powerPool === 'number') ? charData.powerPool : 0;
    return powerPoolXpCost(level, ruleset);
  }

  // ─── UTIL ───

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    renderAll,
    tickHitLocationDmg, setHitLocationDmg,
    tickPowerPool, setPowerPool,
    powerPoolXpDelta
  };
}
