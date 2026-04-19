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

  // UI-only state: whether we're in "edit modifiers" mode for the Hit Locations
  // section. Not persisted; resets on page reload.
  let editModifiersMode = false;

  function renderHitLocationsSection(result) {
    if (!result.locations || result.locations.length === 0) return '';
    const body = result.body || { max: 0, current: 0, dead: false, statusLabel: 'Alive', modifiers: [] };
    const canEdit = ctx.getCanEdit();

    let html = '<div class="combat-section">';
    html += '<div class="combat-section-head">';
    html += '<div class="combat-section-title">Hit Locations</div>';
    if (canEdit) {
      html += `<button class="hl-edit-btn${editModifiersMode ? ' active' : ''}" onclick="toggleHlModifierEdit()">` +
              `${editModifiersMode ? 'Done' : 'Edit Modifiers'}</button>`;
    }
    html += '</div>';

    html += '<div class="hl-list">';
    result.locations.forEach(loc => { html += renderHlRow(loc, body); });
    html += '</div>';

    // Body total goes at the bottom, summarizing the overall state after
    // you've read through the individual locations above.
    html += renderBodyBlock(body);

    html += '</div>';
    return html;
  }

  function renderHlRow(loc, body) {
    const { def, trackKey, maxHP, baseMaxHP, currentDamage, status, error, index, modifiers } = loc;
    const canEdit = ctx.getCanEdit();

    // Display name. Paired limbs (count=2, like Arms/Legs) get Right/Left
    // labels: instance 1 = Right, 2 = Left. Anything with higher count
    // falls back to a numeric "(N)" suffix.
    const displayName = getLocationDisplayName(def, index);

    if (error || maxHP === null) {
      return `<div class="hl-row hl-row-error" title="${escapeHtml(error || 'Formula error')}">
        <div class="hl-status-label"></div>
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

    // Left-side status label. "Healthy" as a blank cell (kept for grid alignment).
    const statusLabels = {
      healthy: '',
      disabled: 'Disabled',
      destroyed: 'Destroyed',
      definitelyDestroyed: 'Definitively Destroyed'
    };
    const statusText = statusLabels[status] || '';

    const controls = canEdit
      ? `<div class="hl-controls">
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',-1)" title="Heal 1 HP">−</button>
          <input type="number" class="hl-dmg-input" value="${currentDamage}" min="0" max="${damageCap}"
                 onchange="setHitLocationDmg('${trackKey}',this.value)">
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',1)" title="Take 1 HP damage">+</button>
        </div>`
      : '';

    // Main row always rendered.
    let html = `
      <div class="hl-row hl-status-${status}">
        <div class="hl-status-label">${escapeHtml(statusText)}</div>
        <div class="hl-name">${escapeHtml(displayName)}</div>
        <div class="hl-bar-wrap">
          <div class="hl-bar-bg">${segmentsHtml}</div>
          <div class="hl-bar-label">${remaining} / ${maxHP}</div>
        </div>
        ${controls}
      </div>`;

    // Inline modifier editor, only when in edit mode.
    if (editModifiersMode && canEdit) {
      html += renderModifierEditor(trackKey, modifiers || [], baseMaxHP);
    }
    return html;
  }

  // Display name for a location instance. Single-count locations (Head, Torso)
  // use just the def name. Paired locations (count=2) like Arms and Legs get
  // "Right" and "Left" labels — convention: instance 1 is Right, instance 2
  // is Left (matches how most character sheets read). Anything with count>2
  // falls back to a numeric suffix since there's no natural naming.
  function getLocationDisplayName(def, index) {
    const count = def.count || 1;
    if (count === 1) return def.name;
    if (count === 2) {
      const side = index === 1 ? 'Right' : 'Left';
      return `${side} ${def.name}`;
    }
    return `${def.name} (${index})`;
  }

  // Modifier editor rendered directly below a hit location row (or Body block).
  // Shows the base value, a list of current modifiers (name + value + delete),
  // and an add row.
  //
  // target: trackKey for hit locations (e.g. "head", "arm-1"), or "body" for Body.
  // mods: array of { name, value }
  // baseMaxHP: the formula-computed value BEFORE modifiers. For Body, this is
  //   the sum of location base maxHPs; but we pass it from the caller.
  function renderModifierEditor(target, mods, baseValue) {
    const isBody = target === 'body';
    const listRows = mods.length === 0
      ? '<div class="mod-empty">No modifiers.</div>'
      : mods.map((m, i) => {
          const safeName = escapeHtml(m.name || '');
          return `<div class="mod-item">
            <input type="text" class="mod-name-input" value="${safeName}"
                   placeholder="Modifier name"
                   onchange="updateHlMod('${target}',${i},'name',this.value)">
            <input type="number" class="mod-val-input" value="${parseInt(m.value) || 0}"
                   onchange="updateHlMod('${target}',${i},'value',this.value)">
            <span class="mod-delete" onclick="deleteHlMod('${target}',${i})">×</span>
          </div>`;
        }).join('');

    return `
      <div class="hl-mod-panel">
        <div class="mod-panel-head">
          <span class="mod-base">Base ${baseValue != null ? baseValue : '—'}</span>
          <span class="mod-panel-hint">modifiers stack onto max</span>
        </div>
        <div class="mod-list">${listRows}</div>
        <div class="mod-add-row">
          <input type="text" class="mod-name-input" id="mod-add-name-${target}" placeholder="Modifier name">
          <input type="number" class="mod-val-input" id="mod-add-val-${target}" placeholder="±" value="0">
          <button class="mod-add-btn" onclick="addHlMod('${target}')">Add</button>
        </div>
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
    //
    // Rounding guard: never fully black out until Body is *actually* at 0.
    // Proportional rounding would round a 28/30 body up to all segments,
    // misreading "almost dead" as "fully dead". Only go fully black when the
    // Body pool is literally empty.
    if (status === 'definitelyDestroyed' && body && body.max > 0) {
      const bodyAtZero = body.current <= 0;
      let blackSegCount;
      if (bodyAtZero) {
        blackSegCount = maxHP;
      } else {
        // Use floor so partial fills don't promote. Clamp so there's always
        // at least 1 non-black segment while any Body remains.
        const raw = Math.floor((body.damage / body.max) * maxHP);
        blackSegCount = Math.min(raw, maxHP - 1);
        // And at least 1 black if ANY damage is present (so the visual isn't
        // static until a big tick happens).
        if (body.damage > 0 && blackSegCount === 0) blackSegCount = 1;
      }
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
    const canEdit = ctx.getCanEdit();

    // Cap segment count for visual sanity on very high Body totals.
    // Characters with Body > 80 get scaled to 80 segments (each = Body/80 points).
    // Below 80, use 1 seg per point.
    const SEG_CAP = 80;
    const segCount = Math.min(body.max, SEG_CAP);
    // How many segments should be black? Proportional to damage taken — but
    // guard against rounding flipping the whole bar black when body is close
    // to but not actually at 0. Rule: only go fully black when body.current == 0.
    const bodyAtZero = body.current <= 0;
    let blackSegs;
    if (bodyAtZero) {
      blackSegs = segCount;
    } else {
      const raw = Math.floor((body.damage / body.max) * segCount);
      blackSegs = Math.min(raw, segCount - 1);
      if (body.damage > 0 && blackSegs === 0) blackSegs = 1;
    }

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

    // Body base for modifier editor = total max MINUS any body-specific mods
    // (those are added on top). So base = max - sum(body modifiers).
    const bodyModTotal = (body.modifiers || []).reduce((acc, m) => acc + (parseInt(m.value) || 0), 0);
    const bodyBase = body.max - bodyModTotal;

    let html = `
      <div class="${rowClass}">
        <div class="body-top-row">
          <span class="body-label">Body</span>
          <span class="body-value">${body.current} / ${body.max}</span>
          <span class="${statusClass}">${escapeHtml(body.statusLabel)}</span>
        </div>
        <div class="body-bar-bg">${segHtml}</div>
      </div>`;

    if (editModifiersMode && canEdit) {
      html += renderModifierEditor('body', body.modifiers || [], bodyBase);
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

  // ─── MODIFIER HANDLERS ───
  // Modifiers apply to maxHP of a hit location, or to Body's max. Storage:
  //   charData.hitLocationModifiers = { trackKey: [{name, value}, ...] }
  //   charData.bodyModifiers        = [{name, value}, ...]
  // Empty arrays are cleaned up on save to keep Firestore docs tidy.

  function toggleEditMode() {
    editModifiersMode = !editModifiersMode;
    renderAll();
  }

  async function addModifier(target) {
    if (!ctx.getCanEdit()) return;
    const nameInput = document.getElementById('mod-add-name-' + target);
    const valInput  = document.getElementById('mod-add-val-' + target);
    if (!nameInput || !valInput) return;
    const name = (nameInput.value || '').trim();
    const value = parseInt(valInput.value) || 0;
    if (!name) { nameInput.focus(); return; }

    const charData = ctx.getCharData();
    if (target === 'body') {
      if (!Array.isArray(charData.bodyModifiers)) charData.bodyModifiers = [];
      charData.bodyModifiers.push({ name, value });
      await saveCharacter(ctx.getCharId(), { bodyModifiers: charData.bodyModifiers });
    } else {
      if (!charData.hitLocationModifiers) charData.hitLocationModifiers = {};
      if (!Array.isArray(charData.hitLocationModifiers[target])) {
        charData.hitLocationModifiers[target] = [];
      }
      charData.hitLocationModifiers[target].push({ name, value });
      await saveCharacter(ctx.getCharId(), { hitLocationModifiers: charData.hitLocationModifiers });
    }
    renderAll();
  }

  async function updateModifier(target, i, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const arr = target === 'body'
      ? charData.bodyModifiers
      : (charData.hitLocationModifiers && charData.hitLocationModifiers[target]);
    if (!Array.isArray(arr) || !arr[i]) return;
    if (field === 'value') {
      arr[i].value = parseInt(val) || 0;
    } else {
      arr[i][field] = val;
    }
    const payload = target === 'body'
      ? { bodyModifiers: charData.bodyModifiers }
      : { hitLocationModifiers: charData.hitLocationModifiers };
    await saveCharacter(ctx.getCharId(), payload);
    // Re-render so numeric changes propagate through maxHP / body totals / bar
    // segments. A name-only change doesn't strictly need a re-render but we do
    // one anyway for simplicity.
    renderAll();
  }

  async function deleteModifier(target, i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (target === 'body') {
      if (!Array.isArray(charData.bodyModifiers)) return;
      charData.bodyModifiers.splice(i, 1);
      await saveCharacter(ctx.getCharId(), { bodyModifiers: charData.bodyModifiers });
    } else {
      const arr = charData.hitLocationModifiers && charData.hitLocationModifiers[target];
      if (!Array.isArray(arr)) return;
      arr.splice(i, 1);
      await saveCharacter(ctx.getCharId(), { hitLocationModifiers: charData.hitLocationModifiers });
    }
    renderAll();
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
    powerPoolXpDelta,
    toggleEditMode, addModifier, updateModifier, deleteModifier
  };
}
