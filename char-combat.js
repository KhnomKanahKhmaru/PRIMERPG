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
    const damageCap = Math.max(maxHP * 4, 10);

    const statusLabels = {
      healthy: '',
      disabled: 'Disabled',
      destroyed: 'Destroyed',
      definitelyDestroyed: 'Def. Destroyed'
    };
    const statusLabel = statusLabels[status] || '';

    const segmentsHtml = renderHpSegments(maxHP, currentDamage);

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
          <div class="hl-bar-bg">${segmentsHtml}</div>
          <div class="hl-bar-label">${remaining} / ${maxHP}</div>
        </div>
        <div class="hl-status-label">${escapeHtml(statusLabel)}</div>
        ${controls}
      </div>`;
  }

  // Build the segmented HP bar. One <span> per HP point. Segments deteriorate
  // right-to-left: undamaged segments on the LEFT stay green, damage accumulates
  // on the RIGHT in phase colors.
  //
  // Phases (each phase = one maxHP worth of damage):
  //   1. Healthy → Disabled (damage 0..maxHP): green → yellow from the right
  //   2. Disabled → Destroyed (damage maxHP..2*maxHP): yellow → red from the right
  //   3. Destroyed → Def. Destroyed (damage 2*maxHP..3*maxHP): red → deep red
  //   4. Beyond Def. Destroyed (damage 3*maxHP..4*maxHP): deep red → black
  //
  // Colors applied per-segment by mapping the segment's index (from the left)
  // to its current state given the total damage taken.
  function renderHpSegments(maxHP, damage) {
    if (maxHP <= 0) return '';

    // Segment colors by phase. Each segment in the bar gets colored based on
    // which phase of damage has reached it, counting from the right.
    const COLORS = {
      green:    '#4a7a4a',
      yellow:   '#bdb247',
      red:      '#a63a3a',
      deepRed:  '#5a1818',
      black:    '#0f0a0a'
    };

    // For each segment (indexed 1..maxHP from the LEFT), determine its color.
    //
    // Distance from the RIGHT edge of the bar is: maxHP - i + 1 (1-indexed from right).
    // A segment "sees" the first `distanceFromRight` HP of damage. If total
    // damage >= the segment's "damage threshold", it transitions to the next
    // phase color. Each maxHP worth of damage shifts the right-side segments
    // one phase deeper.
    //
    // Logic for each segment i (1..maxHP):
    //   - Let rightDistance = maxHP - i + 1 (how far from the right; 1 = rightmost)
    //   - If damage >= 3*maxHP + rightDistance → black (phase 4 reached this seg)
    //   - Else if damage >= 2*maxHP + rightDistance → deep red (phase 3)
    //   - Else if damage >= 1*maxHP + rightDistance → red (phase 2)
    //   - Else if damage >= rightDistance          → yellow (phase 1)
    //   - Else                                     → green (still healthy)
    //
    // Why this works:
    //   At damage=0, no segment is touched → all green. ✓
    //   At damage=1, rightmost segment (rightDistance=1) yellows. ✓
    //   At damage=maxHP, all segments yellow (every rightDistance <= maxHP). ✓
    //   At damage=maxHP+1, rightmost hits phase 2 (red), rest still yellow. ✓
    //   At damage=2*maxHP, all red. ✓ And so on.

    let html = '';
    for (let i = 1; i <= maxHP; i++) {
      const rightDistance = maxHP - i + 1;
      let color;
      if      (damage >= 3 * maxHP + rightDistance) color = COLORS.black;
      else if (damage >= 2 * maxHP + rightDistance) color = COLORS.deepRed;
      else if (damage >= 1 * maxHP + rightDistance) color = COLORS.red;
      else if (damage >=              rightDistance) color = COLORS.yellow;
      else                                           color = COLORS.green;
      html += `<span class="hl-seg" style="background:${color}"></span>`;
    }
    return html;
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
