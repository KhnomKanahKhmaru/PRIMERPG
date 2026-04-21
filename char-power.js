// char-power.js
//
// Power Pool resource UI — the XP-purchased stat and the spendable resource
// bar driven by it. Split out of char-combat.js because it's:
//   • visually self-contained (one section at the bottom of the Combat tab)
//   • behaviorally distinct (only power-specific handlers)
//   • the single biggest chunk of combat.js by size
//
// The module renders the combined Power section (resource bar + purchase
// controls) and owns all the related handlers. Firestore writes go through
// the injected saveCharacter; XP recalc goes through ctx.saveXpSpent.
//
// ctx shape:
//   getCharId()     → character doc id
//   getCharData()   → live charData
//   getCanEdit()    → boolean; true if current user owns the character
//   getRuleset()    → active ruleset
//   saveXpSpent()   → async; triggers the header XP bar recalc after a
//                     Power Pool purchase (cost change → total XP change)
//   rerender()      → callback to repaint the full Combat tab after a
//                     handler mutates state. Combat.js injects its own
//                     renderAll so this module doesn't need to know about it.
//   saveCharacter   → Firestore writer (same signature as char-firestore)
//   computeDerivedStats → from char-derived.js, used to get live power max
//   powerPoolXpCost → from char-derived.js, used for purchase cost preview
//   escapeHtml, fmt → shared helpers

import { wrapCollapsibleSection } from './char-util.js';

export function createPowerSection(ctx) {
  const {
    getCharId, getCharData, getCanEdit, getRuleset,
    saveXpSpent, rerender,
    saveCharacter, computeDerivedStats, powerPoolXpCost,
    escapeHtml, fmt
  } = ctx;

  // ─── SECTION RENDER ───
  //
  // Combined section. Two parts:
  //   1. POWER resource bar — spendable resource, segmented (cap 10), scales
  //      with max. Player picks main color; depletion is always black.
  //   2. Power Pool — the XP-purchased stat that scales POWER via the formula.

  function renderSection(result, ruleset, charData) {
    const pp = ruleset.powerPool;
    if (!pp || !pp.enabled) return '';

    const canEdit = getCanEdit();

    // Build head (title + optional description underneath the title
    // text) and body (resource bar + purchase controls). The description
    // lives INSIDE the collapsible head so it disappears when collapsed
    // along with everything else — a collapsed Power section should show
    // just the name, nothing else.
    let body_html = '';

    // POWER resource bar (if POWER derived stat is configured)
    if (result.power) {
      body_html += renderPowerBar(result.power, canEdit);
    }

    // Power Pool purchase controls
    body_html += renderPowerPoolPurchase(pp, charData, canEdit);

    const head_html = `<span class="combat-section-title-text">${escapeHtml(pp.name || 'Power Pool')}</span>`;

    // The description is treated as part of the body (first thing
    // inside) so players can still see it when the section is open
    // while collapse hides it along with everything else.
    const bodyWithDesc = (pp.description ? `<div class="pp-desc">${escapeHtml(pp.description)}</div>` : '') + body_html;

    return wrapCollapsibleSection(
      'prime.collapse.combat.power',
      head_html,
      bodyWithDesc,
      { wrapperClass: 'combat-section', collapsibleClass: 'combat-section-title', rerenderHandler: 'combatToggleCollapse' }
    );
  }

  // The segmented POWER resource bar. Always at most 10 segments; if max > 10
  // each segment represents multiple points. Depletion fills from the right.
  function renderPowerBar(power, canEdit) {
    const { max, current, color, name } = power;

    // Cap to 10 segments. Each segment represents max/segCount points.
    // For max=5 → 5 segs, max=30 → 10 segs of 3 each, max=100 → 10 segs of 10.
    const MAX_SEGS = 10;
    const segCount = Math.max(1, Math.min(MAX_SEGS, max));
    const perSegment = max / segCount;

    // Compute segment fills for smooth right-to-left depletion.
    //
    //   fullSegs      — segments on the LEFT that are 100% filled.
    //   partialFill   — fractional fill of the ONE segment just to the right
    //                   of the full ones (0 if perfectly at a boundary).
    //   everything else to the right of the partial one is empty.
    //
    // At max=100, perSegment=10:
    //   current=100 → fullSegs=10, partialFill=0, no partial segment
    //   current=97  → fullSegs=9,  partialFill=0.7 (seg 10 is 70% filled)
    //   current=90  → fullSegs=9,  partialFill=0  (seg 10 is empty)
    //   current=85  → fullSegs=8,  partialFill=0.5 (seg 9 is 50% filled, 10 empty)
    //   current=0   → fullSegs=0,  partialFill=0
    //
    // This gives a smoothly animating bar even on chunky 10-point segments.
    let fullSegs, partialFill;
    if (current >= max) {
      fullSegs = segCount;
      partialFill = 0;
    } else if (current <= 0) {
      fullSegs = 0;
      partialFill = 0;
    } else {
      fullSegs = Math.floor(current / perSegment);
      // Leftover within the "active" segment, as a 0..1 fraction.
      partialFill = (current - fullSegs * perSegment) / perSegment;
      // Clamp to [0, 1] defensively; floating-point math can push slightly
      // outside on edge values.
      if (partialFill < 0) partialFill = 0;
      if (partialFill > 1) { fullSegs += 1; partialFill = 0; }
    }

    const DEPLETED_BG = '#0f0a0a';  // matches hit location depletion tone

    // Render each segment. The "active" segment (first one past the full ones)
    // gets a linear-gradient: color on the left side, depleted on the right.
    // This visually reads as the segment draining from its right edge.
    let segHtml = '';
    for (let i = 1; i <= segCount; i++) {
      let style;
      if (i <= fullSegs) {
        style = `background:${escapeHtml(color)}`;
      } else if (i === fullSegs + 1 && partialFill > 0) {
        const pct = (partialFill * 100).toFixed(1);
        style = `background:linear-gradient(to right, ${escapeHtml(color)} ${pct}%, ${DEPLETED_BG} ${pct}%)`;
      } else {
        style = `background:${DEPLETED_BG}`;
      }
      segHtml += `<span class="power-seg" style="${style}"></span>`;
    }

    // Per-segment hint (shows only when max > 10, to explain the compression).
    const segHint = max > MAX_SEGS
      ? `<span class="power-seghint">(1 segment = ${fmt(perSegment)})</span>`
      : '';

    // Spend/refill controls. Similar pattern to hit-location damage buttons.
    const controls = canEdit
      ? `<div class="power-controls">
          <button class="power-btn" onclick="tickPower(-1)" ${current <= 0 ? 'disabled' : ''} title="Spend 1">−</button>
          <input type="number" class="power-input" value="${current}" min="0" max="${max}"
                 onchange="setPower(this.value)">
          <button class="power-btn" onclick="tickPower(1)" ${current >= max ? 'disabled' : ''} title="Refill 1">+</button>
        </div>`
      : '';

    // Color picker: native input, opens system picker. Tiny swatch inline.
    const colorPicker = canEdit
      ? `<label class="power-color-picker" title="Change bar color">
          <input type="color" value="${escapeHtml(color)}" onchange="setPowerColor(this.value)">
          <span class="power-color-swatch" style="background:${escapeHtml(color)}"></span>
        </label>`
      : '';

    // Name label — editable inline if the player can edit, otherwise static.
    // Uses a transparent input styled to look like a label. On focus a border
    // appears so the player knows it's editable. Blank submissions revert to
    // "POWER" (handled on the derivation side).
    // maxlength is a soft cap so the layout doesn't blow up if someone pastes
    // a novel; 24 characters fits most thematic names.
    const nameEl = canEdit
      ? `<input type="text" class="power-name-input" value="${escapeHtml(name)}"
                maxlength="24" placeholder="POWER"
                onchange="setPowerName(this.value)"
                title="Click to rename">`
      : `<span class="power-label">${escapeHtml(name)}</span>`;

    return `
      <div class="power-block">
        <div class="power-top-row">
          ${nameEl}
          <span class="power-value">${fmt(current)} / ${fmt(max)}</span>
          ${segHint}
          ${colorPicker}
        </div>
        <div class="power-bar-bg">${segHtml}</div>
        ${controls}
      </div>`;
  }

  // The Power Pool XP-purchase UI (its own stat; separate from POWER resource).
  function renderPowerPoolPurchase(pp, charData, canEdit) {
    const level = (typeof charData.powerPool === 'number') ? charData.powerPool : 0;
    const max = pp.maxPurchasable || 10;
    const ruleset = getRuleset();
    const currentCost = powerPoolXpCost(level, ruleset);
    const nextLevelCost = level < max ? powerPoolXpCost(level + 1, ruleset) : null;
    const incrementCost = nextLevelCost !== null ? (nextLevelCost - currentCost) : null;

    const modeText = pp.costMode === 'perPoint'
      ? `${pp.costPerPoint || 0} XP per point`
      : 'Custom per-level table';

    let html = '<div class="pp-row">';
    html += `<div class="pp-label">Power Pool</div>`;
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
    return html;
  }

  // ─── POWER POOL (STAT) HANDLERS ───
  // Power Pool is the XP-purchased STAT. Changes here re-scale POWER (the
  // resource) via the formula, which could increase or decrease max. Note:
  // we do NOT refill powerCurrent when Power Pool goes up — the player keeps
  // what they had. When max drops (rare), derived.js clamps current on read.

  async function tickPowerPool(delta) {
    if (!getCanEdit()) return;
    const charData = getCharData();
    const ruleset = getRuleset();
    const max = (ruleset.powerPool && ruleset.powerPool.maxPurchasable) || 10;
    const cur = (typeof charData.powerPool === 'number') ? charData.powerPool : 0;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    charData.powerPool = next;
    await saveCharacter(getCharId(), { powerPool: next });
    await saveXpSpent();
    rerender();
  }

  async function setPowerPool(val) {
    if (!getCanEdit()) return;
    const charData = getCharData();
    const ruleset = getRuleset();
    const max = (ruleset.powerPool && ruleset.powerPool.maxPurchasable) || 10;
    const parsed = Math.max(0, Math.min(max, parseInt(val) || 0));
    if (parsed === charData.powerPool) return;
    charData.powerPool = parsed;
    await saveCharacter(getCharId(), { powerPool: parsed });
    await saveXpSpent();
    rerender();
  }

  // ─── POWER RESOURCE HANDLERS ───
  // POWER current is stored as charData.powerCurrent. It's clamped to [0, max]
  // based on the derived max from the formula.

  async function tickPower(delta) {
    if (!getCanEdit()) return;
    const charData = getCharData();
    // Recompute to get current max. Not the cheapest — a future perf pass
    // could pass the already-computed result into handlers.
    const ruleset = getRuleset();
    const result = computeDerivedStats(charData, ruleset);
    if (!result.power) return;
    const max = result.power.max;
    const cur = result.power.current;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    charData.powerCurrent = next;
    await saveCharacter(getCharId(), { powerCurrent: next });
    rerender();
  }

  async function setPower(val) {
    if (!getCanEdit()) return;
    const charData = getCharData();
    const ruleset = getRuleset();
    const result = computeDerivedStats(charData, ruleset);
    if (!result.power) return;
    const max = result.power.max;
    const parsed = Math.max(0, Math.min(max, parseInt(val) || 0));
    charData.powerCurrent = parsed;
    await saveCharacter(getCharId(), { powerCurrent: parsed });
    rerender();
  }

  async function setPowerColor(color) {
    if (!getCanEdit()) return;
    const charData = getCharData();
    // Basic sanity: only accept hex-ish strings. Native color picker always
    // gives us #rrggbb, so this is mostly paranoia.
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(color.trim())) return;
    charData.powerColor = color.trim();
    await saveCharacter(getCharId(), { powerColor: charData.powerColor });
    rerender();
  }

  // Player-chosen bar name ("Vitae", "Mana", whatever). Blank / whitespace-only
  // input falls back to "POWER" on the derivation side. We store the raw trimmed
  // string; the label default is applied when rendering. Storing null/empty
  // over a prior name reliably clears it.
  async function setPowerName(name) {
    if (!getCanEdit()) return;
    const charData = getCharData();
    const cleaned = (typeof name === 'string') ? name.trim() : '';
    // Soft length cap to protect the layout from pasted essays.
    const capped = cleaned.slice(0, 24);
    charData.powerName = capped;
    await saveCharacter(getCharId(), { powerName: capped });
    rerender();
  }

  // Total XP spent on Power Pool — consumed by calcTotalXp in character.html
  // so the header XP bar reflects purchases.
  function powerPoolXpDelta() {
    const charData = getCharData();
    const ruleset = getRuleset();
    const level = (typeof charData.powerPool === 'number') ? charData.powerPool : 0;
    return powerPoolXpCost(level, ruleset);
  }

  return {
    renderSection,
    // Handlers (exposed so combat.js can re-export them for window wiring)
    tickPowerPool, setPowerPool,
    tickPower, setPower, setPowerColor, setPowerName,
    powerPoolXpDelta
  };
}
