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
    const body = result.body || { max: 0, current: 0, dead: false, statusLabel: 'Alive' };

    let html = '<div class="combat-section">';
    html += '<div class="combat-section-title">Hit Locations</div>';
    html += '<div class="hl-list">';
    result.locations.forEach(loc => { html += renderHlRow(loc, body); });
    html += '</div>';

    // Body total — segmented green→black bar, status label, current/max.
    html += renderBodyBlock(body);
    html += '</div>';
    return html;
  }

  function renderHlRow(loc, body) {
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
    // Damage cap: Def.Destroyed threshold is reached at damage=3*maxHP. Allow
    // damage up to 4*maxHP as the "entire bar black from Body depletion" state,
    // but realistically Body will hit 0 long before that in most fights.
    const damageCap = Math.max(maxHP * 4, 10);

    const segmentsHtml = renderHpSegments(maxHP, currentDamage, status, body);

    const controls = canEdit
      ? `<div class="hl-controls">
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',-1)" title="Heal 1 HP">−</button>
          <input type="number" class="hl-dmg-input" value="${currentDamage}" min="0" max="${damageCap}"
                 onchange="setHitLocationDmg('${trackKey}',this.value)">
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',1)" title="Take 1 HP damage">+</button>
        </div>`
      : '';

    // Per-location status label removed per spec — Body section tells the whole
    // story. Grid collapses to 3 columns now (name + bar + controls).
    return `
      <div class="hl-row hl-status-${status}">
        <div class="hl-name">${escapeHtml(displayName)}</div>
        <div class="hl-bar-wrap">
          <div class="hl-bar-bg">${segmentsHtml}</div>
          <div class="hl-bar-label">${remaining} / ${maxHP}</div>
        </div>
        ${controls}
      </div>`;
  }

  // Build the segmented HP bar. One <span> per HP point. Segments deteriorate
  // right-to-left.
  //
  // Phases 1–3 work purely off location damage:
  //   1. Healthy → Disabled (damage 0..maxHP): green → yellow from the right
  //   2. Disabled → Destroyed (damage maxHP..2*maxHP): yellow → red from right
  //   3. Destroyed → Def. Destroyed (damage 2*maxHP..3*maxHP): red → deep red
  //
  // Phase 4 (past Def. Destroyed, location is deep-red+) instead displays the
  // shared Body pool's state. Each segment in Phase 4 represents
  // `bodyMax / maxHP` points of Body damage. When Body hits 0, every
  // Def.Destroyed location shows a fully black bar. This means all Def.Destroyed
  // limbs visually track the Body pool in sync — that's intentional, since Body
  // is global.
  function renderHpSegments(maxHP, damage, status, body) {
    if (maxHP <= 0) return '';

    const COLORS = {
      green:    '#4a7a4a',
      yellow:   '#bdb247',
      red:      '#a63a3a',
      deepRed:  '#5a1818',
      black:    '#0f0a0a'
    };

    // Phase 4 (location is Def.Destroyed): use Body pool to determine how much
    // of the bar is black vs deep red. Body damage is proportionally mapped
    // onto maxHP segments.
    if (status === 'definitelyDestroyed' && body && body.max > 0) {
      // Number of "fully black" segments, rounded to the nearest segment boundary.
      // Damage progresses right-to-left like the other phases.
      const bodyDamagePct = body.damage / body.max;  // 0..1
      const blackSegCount = Math.round(Math.max(0, Math.min(maxHP, bodyDamagePct * maxHP)));
      let html = '';
      for (let i = 1; i <= maxHP; i++) {
        // Segment i (from left). The rightmost `blackSegCount` segments are black.
        const rightIdx = maxHP - i + 1;  // 1 = rightmost
        const color = rightIdx <= blackSegCount ? COLORS.black : COLORS.deepRed;
        html += `<span class="hl-seg" style="background:${color}"></span>`;
      }
      return html;
    }

    // Phases 1–3: determined purely by location damage.
    //
    // For each segment i (1..maxHP), compute how far from the RIGHT it is
    // (rightDistance). A segment "sees" the first rightDistance HP of damage.
    // If total damage >= a threshold tied to rightDistance, the segment has
    // transitioned to the corresponding phase color.
    let html = '';
    for (let i = 1; i <= maxHP; i++) {
      const rightDistance = maxHP - i + 1;
      let color;
      if      (damage >= 2 * maxHP + rightDistance) color = COLORS.deepRed;
      else if (damage >= 1 * maxHP + rightDistance) color = COLORS.red;
      else if (damage >=              rightDistance) color = COLORS.yellow;
      else                                           color = COLORS.green;
      html += `<span class="hl-seg" style="background:${color}"></span>`;
    }
    return html;
  }

  // Body section — segmented green→black bar + status label.
  // Segments represent Body pool in 1-HP increments (one seg per max Body point).
  // On enormous Body totals this gets many segments; that's fine — they scale
  // down via flex and stay visually coherent.
  function renderBodyBlock(body) {
    if (!body || body.max <= 0) return '';

    // Cap segment count for visual sanity on very high Body totals.
    // Characters with Body > 80 get scaled to 80 segments (each = Body/80 points).
    // Below 80, use 1 seg per point.
    const SEG_CAP = 80;
    const segCount = Math.min(body.max, SEG_CAP);
    // How many segments should be black? Proportional to damage taken.
    const dmgPct = body.damage / body.max;
    const blackSegs = Math.round(Math.max(0, Math.min(segCount, dmgPct * segCount)));

    let segHtml = '';
    for (let i = 1; i <= segCount; i++) {
      // Damage fills right-to-left (rightmost segments go black first).
      const rightIdx = segCount - i + 1;
      const color = rightIdx <= blackSegs ? '#0f0a0a' : '#4a7a4a';
      segHtml += `<span class="hl-seg" style="background:${color}"></span>`;
    }

    // Status label classes. "dead" dominates styling; unconscious/paralyzed share
    // a muted amber look.
    let statusClass = 'body-status';
    if (body.dead) statusClass += ' body-status-dead';
    else if (body.unconscious || body.paralyzed) statusClass += ' body-status-impaired';
    else statusClass += ' body-status-alive';

    const rowClass = 'body-total' + (body.dead ? ' body-total-dead' : '');

    return `
      <div class="${rowClass}">
        <div class="body-top-row">
          <span class="body-label">Body</span>
          <span class="body-value">${body.current} / ${body.max}</span>
          <span class="${statusClass}">${escapeHtml(body.statusLabel)}</span>
        </div>
        <div class="body-bar-bg">${segHtml}</div>
      </div>`;
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
