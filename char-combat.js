// char-combat.js
// Renders the Combat tab on the character sheet:
//   - Derived stats (HP, SPD, AGL, Reflex, etc.) grouped by category
//   - Hit locations with damage trackers
//   - Power Pool purchase UI
//
// Values auto-recompute on every render via char-derived.js. Recomputing
// is cheap (<1ms) so no caching; simpler and always current.

import { saveCharacter } from './char-firestore.js';
import { computeDerivedStats, powerPoolXpCost, TRAUMA_TIERS } from './char-derived.js';
import { createRollCalc } from './char-rollcalc.js';
import { createPowerSection } from './char-power.js';
import { createOverviewSection } from './char-overview.js';

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
    const ruleset = ctx.getRuleset();
    const charData = ctx.getCharData();

    // Always try to update the Overview's State-of-Things tile. It lives
    // on a different tab but reads the same computed state — we refresh it
    // on every Combat renderAll so the two views never drift.
    if (ruleset) {
      const result = computeDerivedStats(charData, ruleset);
      overview.renderState(result, ruleset);
    }

    if (!container) return;
    if (!ruleset) {
      container.innerHTML = '<div class="combat-empty">No ruleset loaded.</div>';
      return;
    }

    const result = computeDerivedStats(charData, ruleset);

    let html = '';
    // Roll Calculator at the very top — the quick "how many dice will I
    // actually roll?" scratch pad you reach for mid-turn. Sits ahead of
    // Movement so it's the first thing visible when you swap to Combat.
    html += rollcalc.renderTile(result, ruleset, charData);
    // Strain summary right below — it's the biggest single factor affecting
    // the Roll Calculator, so seeing them side-by-side (top of tab) is the
    // most useful at-a-glance pairing. The detailed Pain/Stress editors
    // still live inline in their Health and Sanity sections below.
    html += overview.renderStrainTile(result.pain, result.stress, result.strain);
    // Movement below — speed, agility, reflex. Fast-lookup info you need
    // during play, positioned ahead of the more detailed health UI.
    html += renderDerivedStatsSection(result, ruleset, { includeGroups: ['movement'] });
    // Health section — HP/FORT cards + hit locations + Body + injuries.
    html += renderHitLocationsSection(result);
    // Sanity section — mental health pool, placed between physical and power.
    html += renderSanSection(result);
    // All other derived stat groups (mental, etc.) render below.
    html += renderDerivedStatsSection(result, ruleset, { excludeGroups: ['movement'] });
    // Power last (its own complex section with resource bar).
    html += power.renderSection(result, ruleset, charData);
    container.innerHTML = html || '<div class="combat-empty">No combat data configured in this ruleset.</div>';
  }

  // ─── STATE OF THINGS (overview dashboard) ───
  // Extracted to char-overview.js. The module renders Body / Sanity /
  // Power / Movement / Strain tiles into the Overview tab's #state-body
  // host. We also re-use its renderStrainTile inline on the Combat tab.
  //
  // We inject getCollapsedStrainValues so Movement tile can read the
  // same collapse state as the Combat-tab stat cards without owning it.
  const overview = createOverviewSection({
    getCollapsedStrainValues: () => collapsedStrainValues,
    escapeHtml,
    fmt
  });


  // ─── ROLL CALCULATOR ───
  // Extracted to char-rollcalc.js. We get a module instance with all its
  // own state, render, and handlers. Combat.js's renderAll() calls
  // rollcalc.renderTile(result, ruleset, charData) to stitch the tile
  // into the combat tab; the module handles its own internal repaints
  // when the user interacts with its inputs.
  const rollcalc = createRollCalc({
    getRuleset:  ctx.getRuleset,
    getCharData: ctx.getCharData,
    computeDerivedStats,
    escapeHtml,
    fmt
  });

  // ─── POWER SECTION ───
  // Extracted to char-power.js. Resource bar + Power Pool purchase UI plus
  // all the tick/set handlers. We inject a `rerender` that points to our
  // renderAll, so power actions re-paint the whole Combat tab the way they
  // did when they lived inline.
  const power = createPowerSection({
    getCharId:   ctx.getCharId,
    getCharData: ctx.getCharData,
    getCanEdit:  ctx.getCanEdit,
    getRuleset:  ctx.getRuleset,
    saveXpSpent: ctx.saveXpSpent,
    rerender:    () => renderAll(),
    saveCharacter,
    computeDerivedStats,
    powerPoolXpCost,
    escapeHtml,
    fmt
  });


  // ─── DERIVED STATS ───

  function renderDerivedStatsSection(result, ruleset, opts) {
    opts = opts || {};
    const includeGroups = Array.isArray(opts.includeGroups) ? new Set(opts.includeGroups) : null;
    const excludeGroups = new Set(Array.isArray(opts.excludeGroups) ? opts.excludeGroups : []);
    const groups = ruleset.derivedStatGroups || [];

    // Bucket stats by group code. Stats with an invalid group fall into an
    // "orphan" bucket shown at the end.
    // Exclusions:
    //   - POWER → rendered in its own section (resource bar + controls)
    //   - 'health' group → rendered inside the Health section (cards above
    //     Hit Locations list)
    //   - Any group listed in opts.excludeGroups
    //   - If opts.includeGroups is set, ONLY those groups render here
    const buckets = new Map();
    groups.forEach(g => buckets.set(g.code, []));
    const orphans = [];
    result.stats.forEach((entry) => {
      if (entry.def.code === 'POWER') return;
      if (entry.def.code === 'SAN') return;        // rendered in its own section
      if (entry.def.group === 'health') return;
      const g = entry.def.group;
      if (includeGroups && !includeGroups.has(g)) return;
      if (excludeGroups.has(g)) return;
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

  // UI-only state: which cards currently have their dice-mod panel expanded.
  // Set of stat codes. Not persisted across reloads.
  const expandedDiceMods = new Set();
  // Tracks which stat cards have their strain-reduced value COLLAPSED —
  // i.e. showing just the final effective number ("7.5 ft/sec") rather
  // than the full breakdown ("10 − 2.5 ft/sec"). Per-stat toggle, lives
  // in memory only (resets on full re-render, persists across in-place
  // toggles via pure CSS class swap, no render needed).
  const collapsedStrainValues = new Set();

  // Toggle handler for the strain-value display. CSS-driven: flips a class
  // on the card(s) with this stat code, so both display variants live in
  // the DOM and we swap visibility without running renderAll. That avoids
  // losing focus/scroll and makes the click feel instant.
  function toggleStrainValueDisplay(code) {
    if (!code) return;
    if (collapsedStrainValues.has(code)) collapsedStrainValues.delete(code);
    else collapsedStrainValues.add(code);
    // Flip the class on BOTH the Combat-tab card and the Overview movement
    // item. They share data-code, so one selector catches both views —
    // click in either place, both views update in sync without a render.
    const targets = document.querySelectorAll(
      `.ds-card[data-code="${CSS.escape(code)}"], .state-movement-item[data-code="${CSS.escape(code)}"]`
    );
    targets.forEach(el => el.classList.toggle('strain-collapsed'));
  }

  function renderDsCard(entry) {
    const { def, value, error, rollModifier, diceMods, diceModTotal } = entry;
    const canEdit = ctx.getCanEdit();
    const display = error ? 'ERR' : fmt(value);
    const unit = def.unit ? ` <span class="ds-card-unit">${escapeHtml(def.unit)}</span>` : '';

    // Inline strain value reduction — for movement-style stats flagged as
    // strainReducesValue. Two display modes baked into the markup at once:
    //
    //   EXPANDED (default):  "10 − 2.5 ft/sec"   ← base and reduction both shown
    //   COLLAPSED:           "7.5 ft/sec"        ← pre-computed effective value
    //
    // The card has a 'strain-collapsed' class if the player clicked to
    // collapse; CSS hides whichever span is inactive. Click anywhere on
    // the value toggles the class in-place (no re-render). Both spans
    // carry their own tooltip explaining the other mode.
    let valueBody;
    const valReduction = entry.strainValueReduction || 0;
    const hasStrainDisplay = valReduction > 0 && Number.isFinite(value) && !error;
    if (hasStrainDisplay) {
      const effective = Math.max(0, value - valReduction);
      const reductionStr = fmt(valReduction);
      const effectiveStr = fmt(effective);
      const baseStr = fmt(value);
      const pct = entry.strainPercent || 0;
      const expandedTip = `Strain reduces this value by ${reductionStr} (${pct}% of base ${baseStr}). Effective: ${effectiveStr}${def.unit ? ' ' + def.unit : ''}. Click to show effective only.`;
      const collapsedTip = `Effective ${effectiveStr}${def.unit ? ' ' + def.unit : ''} — base ${baseStr} reduced by ${reductionStr} (${pct}% Strain). Click to show breakdown.`;
      valueBody = `<span class="ds-card-strain-toggle" onclick="toggleStrainValueDisplay('${escapeHtml(def.code)}')">` +
          `<span class="ds-card-strain-expanded" title="${escapeHtml(expandedTip)}">${baseStr} <span class="ds-card-strain-reduction">− ${reductionStr}</span></span>` +
          `<span class="ds-card-strain-effective" title="${escapeHtml(collapsedTip)}">${effectiveStr}</span>` +
        `</span>`;
    } else {
      valueBody = display;
    }

    const errTitle = error ? ` title="${escapeHtml(error)}"` : '';
    const codeBadge = def.code && def.code !== def.name
      ? ` <span class="ds-card-code">${escapeHtml(def.code)}</span>`
      : '';
    const rawFormula = (def.formula || '').trim();
    const isIdentityFormula = rawFormula.toUpperCase() === def.code;
    const formulaBadge = (rawFormula && !isIdentityFormula)
      ? `<div class="ds-card-formula">${escapeHtml(rawFormula.replace(/\s+/g, ' '))}</div>`
      : '';

    // Top-right STATIC mod badge — read-only. Shows the rollModifier value
    // (e.g. STRMOD for Health). Added to the total of a roll's summed dice.
    //   roll = sum of (value)D10 + rollModifier
    // This is separate from dice mods, which add bonus DICE to the pool.
    let rollBadge = '';
    if (Number.isFinite(rollModifier)) {
      const sign = rollModifier > 0 ? '+' : (rollModifier < 0 ? '−' : '±');
      const absNum = Math.abs(rollModifier);
      const tip = def.rollModifier
        ? `Static roll modifier: ${def.rollModifier} — added to the roll total`
        : 'Static roll modifier — added to the roll total';
      rollBadge = `<div class="ds-card-rollmod" title="${escapeHtml(tip)}">${sign}${absNum}</div>`;
    }

    // Bottom-area DICE MOD pill — editable. Shows the FINAL dice count the
    // player actually rolls, factoring in dice modifiers AND Strain penalty
    // (for active rolls). Click to expand an editor with the full breakdown.
    //
    // When the pool == base dice (no mods AND no strain penalty), nothing
    // to show in view-only mode — keeps clean cards. Edit mode still shows
    // the "+ Dice Mod" pill so players can add mods.
    const hasDiceMods = Array.isArray(diceMods) && diceMods.length > 0;
    const isPassive = entry.isPassive === true;
    const strainPenalty = entry.strainPenalty || 0;
    const finalDice = Number.isFinite(entry.finalDice)
      ? entry.finalDice
      : (Number.isFinite(value) ? value : 0);
    const baseDice = Number.isFinite(value) ? value : 0;
    const dicePoolDiffersFromBase = finalDice !== baseDice;
    const openPanel = expandedDiceMods.has(def.code);
    let dicePill = '';
    if (canEdit || hasDiceMods || dicePoolDiffersFromBase) {
      let pillLabel;
      let pillClass;
      if (dicePoolDiffersFromBase || hasDiceMods) {
        pillLabel = `${finalDice}d`;
        pillClass = ' has-mods';
      } else {
        pillLabel = '+ Dice Mod';
        pillClass = ' empty';
      }
      const tipParts = [];
      tipParts.push(`Rolling ${finalDice}d (base ${baseDice})`);
      if (hasDiceMods) {
        const sign = diceModTotal >= 0 ? '+' : '−';
        tipParts.push(`${sign}${Math.abs(diceModTotal)}d bonus`);
      }
      if (strainPenalty > 0) {
        tipParts.push(`−${strainPenalty}d Strain`);
      } else if (isPassive) {
        tipParts.push('passive — Strain does not apply');
      }
      if (canEdit) tipParts.push('Click to edit');
      const pillTip = tipParts.join(' · ');
      dicePill = canEdit
        ? `<button class="ds-card-dicepill${openPanel ? ' open' : ''}${pillClass}"
                  onclick="toggleDiceModPanel('${escapeHtml(def.code)}')"
                  title="${escapeHtml(pillTip)}"
                  type="button">${pillLabel}</button>`
        : `<span class="ds-card-dicepill has-mods readonly" title="${escapeHtml(pillTip)}">${pillLabel}</span>`;
    }

    // Expanded panel content (dice modifier editor).
    let panelHtml = '';
    if (openPanel && canEdit) {
      panelHtml = renderDiceModPanel(def.code, value, diceMods, diceModTotal, {
        isPassive,
        strainPenalty,
        finalDice,
        strainPercent: entry.strainPercent || 0
      });
    }

    const collapsedClass = hasStrainDisplay && collapsedStrainValues.has(def.code)
      ? ' strain-collapsed'
      : '';

    return `
      <div class="ds-card${openPanel ? ' rollmod-open' : ''}${collapsedClass}" data-code="${escapeHtml(def.code)}"${errTitle}>
        ${rollBadge}
        <div class="ds-card-name">${escapeHtml(def.name)}${codeBadge}</div>
        ${formulaBadge}
        <div class="ds-card-value${error ? ' ds-card-error' : ''}">${valueBody}${unit}</div>
        ${dicePill}
        ${def.description ? `<div class="ds-card-desc">${escapeHtml(def.description)}</div>` : ''}
        ${panelHtml}
      </div>`;
  }

  // Dice modifier editor panel — lives inside an expanded card. Shows the
  // total dice the player rolls (base + all mods − strain) at the top, then
  // the list of mods with name/value/delete, then an add button.
  function renderDiceModPanel(code, baseValue, diceMods, diceModTotal, strainInfo) {
    const mods = Array.isArray(diceMods) ? diceMods : [];
    const base = Number.isFinite(baseValue) ? baseValue : 0;
    const modTotal = diceModTotal || 0;
    const si = strainInfo || { isPassive: false, strainPenalty: 0, finalDice: base + modTotal, strainPercent: 0 };

    let html = '<div class="ds-rollmod-panel">';

    // Summary line: the final dice count with a compact breakdown.
    //   "Rolling 12d   = 10 base + 2 bonus"
    //   "Rolling 8d    = 10 base + 2 bonus − 4 strain (50%)"
    //   "Rolling 10d   = 10 base  (passive — strain doesn't apply)"
    const breakdownParts = [`${base} base`];
    if (modTotal !== 0) breakdownParts.push(`${modTotal >= 0 ? '+' : '−'} ${Math.abs(modTotal)} bonus`);
    if (si.strainPenalty > 0) breakdownParts.push(`− ${si.strainPenalty} strain (${si.strainPercent}%)`);
    const passiveNote = si.isPassive && si.strainPercent > 0
      ? '<span class="ds-dm-passive-note"> · passive roll · strain does not apply</span>'
      : '';
    html += `<div class="ds-dicemod-summary">
      <span class="ds-dm-summary-label">Rolling</span>
      <span class="ds-dm-summary-value">${si.finalDice}d</span>
      <span class="ds-dm-summary-breakdown">= ${breakdownParts.join(' ')}${passiveNote}</span>
    </div>`;

    if (mods.length === 0) {
      html += '<div class="mod-empty">No dice modifiers. Add bonus dice from abilities or traits.</div>';
    } else {
      html += '<div class="mod-list">';
      mods.forEach((mod, idx) => {
        html += `<div class="mod-item">
          <input type="text" class="mod-name-input" value="${escapeHtml(mod.name || '')}" placeholder="e.g. Brawny Trait"
                 onchange="updateDiceMod('${escapeHtml(code)}',${idx},'name',this.value)">
          <input type="number" class="mod-val-input" value="${mod.value || 0}" step="1"
                 onchange="updateDiceMod('${escapeHtml(code)}',${idx},'value',this.value)"
                 title="Bonus dice (negative = penalty dice)">
          <span class="mod-delete" onclick="deleteDiceMod('${escapeHtml(code)}',${idx})" title="Delete">×</span>
        </div>`;
      });
      html += '</div>';
    }
    html += `<div class="mod-add-row"><button class="mod-add-btn" onclick="addDiceMod('${escapeHtml(code)}')">+ Add dice mod</button></div>`;
    html += '</div>';
    return html;
  }

  // ─── DICE MOD HANDLERS ───

  function toggleDiceModPanel(code) {
    if (expandedDiceMods.has(code)) expandedDiceMods.delete(code);
    else expandedDiceMods.add(code);
    renderAll();
  }

  async function addDiceMod(code) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.diceModifiers || typeof charData.diceModifiers !== 'object') {
      charData.diceModifiers = {};
    }
    if (!Array.isArray(charData.diceModifiers[code])) charData.diceModifiers[code] = [];
    charData.diceModifiers[code].push({ name: '', value: 1 });
    expandedDiceMods.add(code);
    await saveCharacter(ctx.getCharId(), { diceModifiers: charData.diceModifiers });
    renderAll();
  }

  async function updateDiceMod(code, idx, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const list = charData.diceModifiers && charData.diceModifiers[code];
    if (!Array.isArray(list) || !list[idx]) return;
    if (field === 'name') list[idx].name = typeof val === 'string' ? val : '';
    else if (field === 'value') list[idx].value = parseInt(val) || 0;
    await saveCharacter(ctx.getCharId(), { diceModifiers: charData.diceModifiers });
    renderAll();
  }

  async function deleteDiceMod(code, idx) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const list = charData.diceModifiers && charData.diceModifiers[code];
    if (!Array.isArray(list) || !list[idx]) return;
    list.splice(idx, 1);
    if (list.length === 0) delete charData.diceModifiers[code];
    await saveCharacter(ctx.getCharId(), { diceModifiers: charData.diceModifiers });
    renderAll();
  }

  // ─── PAIN / STRESS ───
  //
  // Pain is % of Body missing. Stress is % of SAN range used up (with 3×
  // denominator to account for SAN's negative range). Strain = Pain + Stress
  // and is used to reduce dice pools on active rolls.
  //
  // Both show as clickable pills with the same interaction pattern as Dice
  // Mod pills: click to expand an inline editor with percentile modifiers.

  const expandedPainPanel = { open: false };
  const expandedStressPanel = { open: false };

  function renderPainPill(result) {
    const pain = result.pain;
    if (!pain) return '';
    const canEdit = ctx.getCanEdit();
    const strain = result.strain || { percent: 0 };
    return renderStrainPill({
      id: 'pain',
      label: 'Pain',
      data: pain,
      strain,
      expanded: expandedPainPanel.open,
      canEdit,
      toggleFn: 'togglePainPanel',
      addFn: 'addPainMod',
      updateFn: 'updatePainMod',
      deleteFn: 'deletePainMod',
      baseDescription: `${pain.basePercent}% base = ${(result.body && result.body.damage) || 0} / ${(result.body && result.body.max) || 0} Body missing`
    });
  }

  function renderStressPill(result) {
    const stress = result.stress;
    if (!stress) return '';
    const canEdit = ctx.getCanEdit();
    const strain = result.strain || { percent: 0 };
    const sanMax = (result.san && result.san.max) || 0;
    return renderStrainPill({
      id: 'stress',
      label: 'Stress',
      data: stress,
      strain,
      expanded: expandedStressPanel.open,
      canEdit,
      toggleFn: 'toggleStressPanel',
      addFn: 'addStressMod',
      updateFn: 'updateStressMod',
      deleteFn: 'deleteStressMod',
      baseDescription: `${stress.basePercent}% base = ${(result.san && result.san.damage) || 0} / ${sanMax * 3} SAN range lost`
    });
  }

  // Shared renderer for Pain and Stress — same layout, different data/handlers.
  function renderStrainPill(opts) {
    const {
      id, label, data, strain, expanded, canEdit,
      toggleFn, addFn, updateFn, deleteFn, baseDescription
    } = opts;

    const mods = Array.isArray(data.modifiers) ? data.modifiers : [];
    const finalPct = data.finalPercent;
    const pillClass = finalPct === 0 ? ' strain-zero' : (finalPct >= 75 ? ' strain-crit' : (finalPct >= 50 ? ' strain-heavy' : ' strain-light'));

    let html = `<div class="strain-block">`;
    // Header row: always visible. Click toggles the panel (if editable).
    const tipParts = [baseDescription];
    if (mods.length > 0) {
      const sign = data.modTotal >= 0 ? '+' : '−';
      tipParts.push(`${sign}${Math.abs(data.modTotal)}% from modifiers`);
    }
    tipParts.push(`Strain total: ${strain.percent}%`);
    if (canEdit) tipParts.push('Click to edit modifiers');
    const tip = tipParts.join(' · ');

    const openClass = expanded ? ' open' : '';
    const headTag = canEdit ? 'button' : 'div';
    const headAttrs = canEdit
      ? `type="button" onclick="${toggleFn}()"`
      : '';
    html += `<${headTag} class="strain-head${openClass}${pillClass}" ${headAttrs} title="${escapeHtml(tip)}">
      <span class="strain-label">${escapeHtml(label)}</span>
      <span class="strain-percent">${finalPct}%</span>
      <span class="strain-breakdown">${data.basePercent}% base${data.modTotal !== 0 ? ` ${data.modTotal > 0 ? '+' : '−'} ${Math.abs(data.modTotal)}%` : ''}</span>
    </${headTag}>`;

    if (expanded && canEdit) {
      html += '<div class="strain-panel">';
      html += `<div class="strain-panel-base">Base: ${data.basePercent}% (computed from ${label === 'Pain' ? 'Body damage' : 'SAN damage'})</div>`;
      if (mods.length === 0) {
        html += '<div class="mod-empty">No modifiers. Add percentile adjustments (e.g. "Adrenaline: −10%" or "Fatigue: +15%").</div>';
      } else {
        html += '<div class="mod-list">';
        mods.forEach((mod, idx) => {
          html += `<div class="mod-item">
            <input type="text" class="mod-name-input" value="${escapeHtml(mod.name || '')}" placeholder="e.g. Adrenaline Surge"
                   onchange="${updateFn}(${idx},'name',this.value)">
            <input type="number" class="mod-val-input" value="${mod.value || 0}" step="1"
                   onchange="${updateFn}(${idx},'value',this.value)"
                   title="Percentile modifier (signed)">
            <span class="mod-unit">%</span>
            <span class="mod-delete" onclick="${deleteFn}(${idx})" title="Delete">×</span>
          </div>`;
        });
        html += '</div>';
      }
      html += `<div class="mod-add-row"><button class="mod-add-btn" onclick="${addFn}()">+ Add modifier</button></div>`;
      html += `<div class="strain-panel-total">Total: ${finalPct}% → contributes to Strain (${strain.percent}% overall)</div>`;
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function togglePainPanel() {
    expandedPainPanel.open = !expandedPainPanel.open;
    renderAll();
  }
  function toggleStressPanel() {
    expandedStressPanel.open = !expandedStressPanel.open;
    renderAll();
  }

  async function addPainMod() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.painModifiers)) charData.painModifiers = [];
    charData.painModifiers.push({ name: '', value: 0 });
    expandedPainPanel.open = true;
    await saveCharacter(ctx.getCharId(), { painModifiers: charData.painModifiers });
    renderAll();
  }
  async function updatePainMod(idx, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.painModifiers) || !charData.painModifiers[idx]) return;
    if (field === 'name') charData.painModifiers[idx].name = typeof val === 'string' ? val : '';
    else if (field === 'value') charData.painModifiers[idx].value = parseInt(val) || 0;
    await saveCharacter(ctx.getCharId(), { painModifiers: charData.painModifiers });
    renderAll();
  }
  async function deletePainMod(idx) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.painModifiers) || !charData.painModifiers[idx]) return;
    charData.painModifiers.splice(idx, 1);
    await saveCharacter(ctx.getCharId(), { painModifiers: charData.painModifiers });
    renderAll();
  }

  async function addStressMod() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.stressModifiers)) charData.stressModifiers = [];
    charData.stressModifiers.push({ name: '', value: 0 });
    expandedStressPanel.open = true;
    await saveCharacter(ctx.getCharId(), { stressModifiers: charData.stressModifiers });
    renderAll();
  }
  async function updateStressMod(idx, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.stressModifiers) || !charData.stressModifiers[idx]) return;
    if (field === 'name') charData.stressModifiers[idx].name = typeof val === 'string' ? val : '';
    else if (field === 'value') charData.stressModifiers[idx].value = parseInt(val) || 0;
    await saveCharacter(ctx.getCharId(), { stressModifiers: charData.stressModifiers });
    renderAll();
  }
  async function deleteStressMod(idx) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.stressModifiers) || !charData.stressModifiers[idx]) return;
    charData.stressModifiers.splice(idx, 1);
    await saveCharacter(ctx.getCharId(), { stressModifiers: charData.stressModifiers });
    renderAll();
  }

  // ─── HIT LOCATIONS ───

  // UI-only state: whether we're in "edit modifiers" mode for the Hit Locations
  // section. Not persisted; resets on page reload.
  let editModifiersMode = false;

  function renderHitLocationsSection(result) {
    if (!result.locations || result.locations.length === 0) return '';
    const body = result.body || { max: 0, current: 0, dead: false, statusLabel: 'Alive', modifiers: [] };
    const canEdit = ctx.getCanEdit();
    const ruleset = ctx.getRuleset();

    let html = '<div class="combat-section">';
    // Section-level title is "Health" now. This section houses:
    //   - Health derived stat cards (HP, FORT, anything else in the 'health' group)
    //   - Hit Locations list (with its own sub-header + Edit Modifiers button)
    //   - Body bar
    //   - Injuries manager
    html += '<div class="combat-section-title">Health</div>';

    // Cards from the 'health' derived stat group, rendered at the top of the
    // section as an overview strip. These are ALSO filtered OUT of the normal
    // derived stats grid (renderDerivedStatsSection) so they don't appear twice.
    const healthStats = [];
    result.stats.forEach(entry => {
      if (entry.def.group === 'health') healthStats.push(entry);
    });
    if (healthStats.length > 0) {
      html += '<div class="ds-grid health-cards">';
      healthStats.forEach(entry => { html += renderDsCard(entry); });
      html += '</div>';
    }

    // "Hit Locations" sub-header with the Edit Modifiers button. Acts as the
    // divider between the cards overview and the location bars below.
    html += '<div class="combat-subsection-head">';
    html += '<div class="combat-subsection-title">Hit Locations</div>';
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

    // Pain indicator — percent of Body missing, editable modifiers. Sits
    // between Body (which shows physical damage) and Injuries (detailed
    // wound list), conceptually linking "how hurt you are" to "what hurts".
    html += renderPainPill(result);

    // Injuries manager — a collapsible list of wounds with degradation tracking.
    html += renderInjuriesSection(result);

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
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',1)" title="Take 1 HP damage">−</button>
          <input type="number" class="hl-dmg-input" value="${remaining}" min="${-damageCap}" max="${maxHP}"
                 onchange="setHitLocationDmg('${trackKey}',this.value)"
                 title="Current HP (type to set directly)">
          <button class="hl-dmg-btn" onclick="tickHitLocationDmg('${trackKey}',-1)" title="Heal 1 HP">+</button>
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

    // Phase 4 (location is Def.Destroyed): the limb has no HP of its own
    // anymore — it's gone — so its bar stops tracking per-limb damage and
    // instead becomes a live readout of the shared Body pool. Uses the
    // same 4-state palette as the Body bar itself:
    //
    //   Body = +max (undamaged)   → green
    //   Body = 0    (Incapacitated) → yellow
    //   Body = -max (Dead)         → red
    //   past -max + all Def.Destroyed (Destroyed) → near-black
    //
    // Same gating as the Body bar: black only shows when body.destroyed is
    // true (which requires all limbs Def.Destroyed). Otherwise, a single
    // limb's degradation pushing Body past 2·max would wrongly turn the
    // bar black even though the character isn't totally annihilated.
    //
    // The limb's bar is scaled to its own `maxHP` segment count regardless
    // of Body's size — each segment represents body.max/maxHP points of
    // Body damage, computed the same right-to-left `base` way.
    if (status === 'definitelyDestroyed' && body && body.max > 0) {
      const BODY_COLORS = {
        green:     COLORS.green,
        yellow:    COLORS.yellow,
        red:       COLORS.red,
        // Use the limb's `black` tone (matches Body bar's destroyed color)
        // rather than limb's `deepRed`, since we want "completely gone"
        // here, not "just very injured".
        destroyed: COLORS.black
      };
      const hpPerSeg = body.max / maxHP;
      let html = '';
      for (let i = 1; i <= maxHP; i++) {
        const rightDistance = maxHP - i + 1;
        const base = (rightDistance - 1) * hpPerSeg;
        let color;
        if      (body.destroyed && body.damage > 2 * body.max + base) color = BODY_COLORS.destroyed;
        else if (body.damage >     body.max + base) color = BODY_COLORS.red;
        else if (body.damage >                base) color = BODY_COLORS.yellow;
        else                                        color = BODY_COLORS.green;
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

    // Color progression — same scheme as the Overview Body tile so the two
    // views stay visually in sync:
    //
    //   current = +max  (damage = 0)        → fully green      (Healthy)
    //   current = 0     (damage = maxHP)    → fully yellow     (Incapacitated:
    //                                           Unconscious and Paralyzed)
    //   current = -max  (damage = 2·maxHP)  → fully red        (Dead)
    //   past -max + all limbs Def.Destroyed → near-black       (Destroyed;
    //                                           character fully annihilated)
    //
    // The "destroyed" black state is gated on body.destroyed — a Body past
    // 2·max alone isn't enough, because single-limb degradation (bleeding,
    // exsanguination) can drive Body down without the whole character being
    // gone. body.destroyed additionally requires all limbs to be Def.Destroyed.
    //
    // Per segment, `base` is how much damage has already chewed through
    // segments to the right of it. Rightmost segments transition first.
    const COLORS = { green: '#4a7a4a', yellow: '#bdb247', red: '#8a3030', destroyed: '#0f0a0a' };
    const hpPerSeg = body.max / segCount;
    let segHtml = '';
    for (let i = 1; i <= segCount; i++) {
      const rightDistance = segCount - i + 1;
      const base = (rightDistance - 1) * hpPerSeg;
      let color;
      if      (body.destroyed && body.damage > 2 * body.max + base) color = COLORS.destroyed;
      else if (body.damage >     body.max + base) color = COLORS.red;
      else if (body.damage >                base) color = COLORS.yellow;
      else                                        color = COLORS.green;
      segHtml += `<span class="hl-seg" style="background:${color}"></span>`;
    }

    // Status label styling. Priority matches the statusLabel tiers computed
    // in char-derived.js — Destroyed and Dead share the death styling (both
    // read as "body.dead" since destroyed is a stronger form of dead).
    // Incapacitated joins Unconscious/Paralyzed under the "impaired" tone.
    let statusClass = 'body-status';
    if (body.dead) statusClass += ' body-status-dead';
    else if (body.incapacitated || body.unconscious || body.paralyzed) statusClass += ' body-status-impaired';
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

  // ─── INJURIES ───
  //
  // Collapsible manager under the Body bar. Injuries are grouped by hit
  // location (collapsible sub-groups), so you can see "Torso (2)" at a glance
  // and expand to see the injuries there. Each individual injury is ALSO
  // collapsible within its location group for full detail editing.
  //
  // UI-only state: which injury cards are expanded, and which location groups
  // are open. Not persisted — resets each page load. Location groups with
  // injuries default to expanded; locations you explicitly collapse stay
  // collapsed for the session.
  const expandedInjuries = new Set();
  const openInjuryLocations = new Set();
  let injuryLocationsInitialized = false;
  // Whether the whole Injuries section is shown.
  let injuriesOpen = false;
  // Which locations are currently selected in the quick-add form. A Set of
  // trackKeys. One or more can be selected (one = normal add; multi = AoE).
  // Persists across renders within a session so rapid sequential adds to the
  // same spots don't require reselecting. Auto-initialized to just 'torso'
  // the first time the section renders with locations available.
  const quickAddLocations = new Set();
  let quickAddLocationsInitialized = false;

  // Convert a non-negative integer to its English ordinal string.
  //   ordinal(1) → "1st", ordinal(2) → "2nd", ordinal(3) → "3rd"
  //   ordinal(11) → "11th", ordinal(21) → "21st", ordinal(42) → "42nd"
  // Standard rule: "th" unless the last TWO digits are 11/12/13, in which
  // case "th"; otherwise the last digit picks st/nd/rd for 1/2/3.
  function ordinal(n) {
    const abs = Math.abs(n);
    const mod100 = abs % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + 'th';
    const mod10 = abs % 10;
    if (mod10 === 1) return n + 'st';
    if (mod10 === 2) return n + 'nd';
    if (mod10 === 3) return n + 'rd';
    return n + 'th';
  }

  function renderInjuriesSection(result) {
    const canEdit = ctx.getCanEdit();
    const injuries = result.injuries || [];
    const count = injuries.length;

    // On first render (or first render after data loads), auto-open any
    // location group that has injuries. User-driven toggles after that
    // stick for the session.
    if (!injuryLocationsInitialized) {
      injuries.forEach(inj => openInjuryLocations.add(inj.location));
      injuryLocationsInitialized = true;
    }

    let html = '<div class="injury-section">';
    html += `<div class="injury-head" onclick="toggleInjurySection()">
      <span class="injury-head-caret">${injuriesOpen ? '▾' : '▸'}</span>
      <span class="injury-head-title">Injuries</span>
      <span class="injury-head-count">${count}</span>
    </div>`;

    if (!injuriesOpen) { html += '</div>'; return html; }

    // Quick-add inline form when the section is expanded.
    if (canEdit) {
      const locations = result.locations || [];

      // Initialize the quick-add location selection to 'torso' (or first
      // available) the first time we render. After that, respect whatever
      // the user has toggled — they're likely still setting up the next AoE
      // or single-target add.
      if (!quickAddLocationsInitialized && locations.length > 0) {
        const defaultLoc = locations.some(l => l.trackKey === 'torso')
          ? 'torso'
          : locations[0].trackKey;
        quickAddLocations.add(defaultLoc);
        quickAddLocationsInitialized = true;
      }

      // Top row: name + degree + Add button. Kept on one tidy line.
      html += `<div class="injury-quickadd-row">
        <input type="text" id="qadd-inj-name" class="qadd-inj-name" placeholder="Injury name"
               onkeydown="if(event.key==='Enter')quickAddInjury()">
        <input type="number" id="qadd-inj-level" class="qadd-inj-level" placeholder="Deg"
               min="0" max="99" value="1"
               onkeydown="if(event.key==='Enter')quickAddInjury()">
        <button class="injury-add-btn" onclick="quickAddInjury()">Add</button>
      </div>`;

      // Second row: location chips. Multi-select. Torso default. "All" chip
      // at the start toggles select-all. When multiple chips are selected,
      // Add will create one injury per selected location (e.g. AoE attacks).
      const allSelected = locations.length > 0
        && locations.every(l => quickAddLocations.has(l.trackKey));
      const chipHtml = locations.map(l => {
        const label = getLocationDisplayName(l.def, l.index);
        const on = quickAddLocations.has(l.trackKey);
        return `<button class="injury-loc-chip${on ? ' on' : ''}"
                        onclick="toggleQuickAddLocation('${escapeHtml(l.trackKey)}')"
                        type="button">${escapeHtml(label)}</button>`;
      }).join('');

      html += `<div class="injury-quickadd-locs">
        <span class="injury-quickadd-locs-label">Locations:</span>
        <button class="injury-loc-chip injury-loc-chip-all${allSelected ? ' on' : ''}"
                onclick="toggleQuickAddAllLocations()"
                type="button">All</button>
        ${chipHtml}
      </div>`;
    }

    // "Hit Locations" divider + grouped list. Only locations that have
    // injuries show as groups — empty ones stay out of the list to avoid
    // clutter. Add via the quick-add form above.
    html += '<div class="injury-divider">Hit Locations</div>';

    if (count === 0) {
      html += '<div class="injury-empty">No injuries recorded.</div>';
    } else {
      html += renderInjuryGroupsByLocation(injuries, result, canEdit);
    }

    html += '</div>';
    return html;
  }

  function renderInjuryGroupsByLocation(injuries, result, canEdit) {
    // Group injuries by trackKey, preserving the order hit locations appear
    // in the ruleset (so Head first, then Torso, then Arms, then Legs, etc.).
    const locations = result.locations || [];
    const locationOrder = locations.map(l => l.trackKey);

    const groups = new Map();
    locationOrder.forEach(k => groups.set(k, []));
    injuries.forEach(inj => {
      const loc = inj.location || 'torso';
      if (!groups.has(loc)) groups.set(loc, []);
      groups.get(loc).push(inj);
    });

    let html = '<div class="injury-loc-groups">';
    groups.forEach((groupInjuries, trackKey) => {
      if (groupInjuries.length === 0) return;  // hide empty groups
      const locLabel = locationLabel(trackKey, locations) || trackKey;
      const open = openInjuryLocations.has(trackKey);
      html += `<div class="injury-loc-group${open ? ' open' : ''}">`;
      html += `<div class="injury-loc-head" onclick="toggleInjuryLocation('${escapeHtml(trackKey)}')">
        <span class="injury-loc-caret">${open ? '▾' : '▸'}</span>
        <span class="injury-loc-label">${escapeHtml(locLabel)}</span>
        <span class="injury-loc-count">${groupInjuries.length}</span>
      </div>`;
      if (open) {
        html += '<div class="injury-list">';
        groupInjuries.forEach(inj => { html += renderInjuryCard(inj, canEdit, result); });
        html += '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  // A single injury card. Compact header when collapsed; full editor when open.
  // Header layout (collapsed):
  //   ▸ [Name]  [7th Degree]  [Torso pill]  [Degrades Every 6 Hours]  [trauma badges…]
  function renderInjuryCard(inj, canEdit, result) {
    const open = expandedInjuries.has(inj.id);
    const locations = result.locations || [];
    const locLabel = locationLabel(inj.location, locations) || inj.location;
    const severity = severityClass(inj.diff);

    // Degree text — ordinal. If modified, show "(from 7th)" in a tiny note.
    let degreeText;
    if (inj.currentLevel === inj.baseLevel) {
      degreeText = `${ordinal(inj.currentLevel)} Degree`;
    } else {
      degreeText = `${ordinal(inj.currentLevel)} Degree <span class="injury-base-note">(base ${ordinal(inj.baseLevel)})</span>`;
    }

    // Rate text — "Degrades Every X" or "Stable" if below threshold.
    const rateText = inj.rate
      ? `Degrades ${escapeHtml(inj.rate.label)}`
      : '<span class="injury-norate">Stable</span>';

    // Trauma badges on the header — visible even when collapsed. Each badge
    // is a small pill colored by the trauma's severity tier. Hover reveals
    // description and system text via the native title attribute (simple
    // tooltip; fancy custom tooltips can come later).
    const traumaBadges = (inj.traumas || []).map(t => {
      const tierSlug = (t.level || 'Minor').toLowerCase();
      const tip = [
        (t.level || 'Minor') + ' Trauma',
        t.description || '',
        t.system ? '⚙ ' + t.system : ''
      ].filter(Boolean).join('\n');
      return `<span class="trauma-badge tt-${tierSlug}" title="${escapeHtml(tip)}">${escapeHtml(t.name || '(unnamed)')}</span>`;
    }).join('');

    let html = `<div class="injury-card ${severity}${open ? ' open' : ''}">`;
    html += `<div class="injury-card-head" onclick="toggleInjuryExpand('${inj.id}')">
      <span class="injury-caret">${open ? '▾' : '▸'}</span>
      <span class="injury-name">${escapeHtml(inj.name || '(unnamed)')}</span>
      <span class="injury-degree">${degreeText}</span>
      ${canEdit ? `<span class="injury-quickmod" onclick="event.stopPropagation()">
        <button class="injury-qm-btn" onclick="event.stopPropagation();tickInjuryQuickmod('${inj.id}',-1)" title="Quickmod −1">−</button>
        <button class="injury-qm-btn" onclick="event.stopPropagation();tickInjuryQuickmod('${inj.id}',1)" title="Quickmod +1">+</button>
      </span>` : ''}
      <span class="injury-loc-pill">${escapeHtml(locLabel)}</span>
      <span class="injury-rate">${rateText}</span>
      ${traumaBadges ? `<span class="injury-trauma-badges">${traumaBadges}</span>` : ''}
      ${canEdit ? `<button class="injury-quickdelete" onclick="event.stopPropagation();removeInjury('${inj.id}')" title="Delete injury">×</button>` : ''}
    </div>`;

    if (open) {
      html += renderInjuryBody(inj, canEdit, result);
    }
    html += '</div>';
    return html;
  }

  function renderInjuryBody(inj, canEdit, result) {
    const locations = result.locations || [];

    // Location options — dedupe by trackKey. Use the display name the hit
    // location section uses (paired limbs get Right/Left labels).
    const locOptions = locations.map(l => {
      const displayName = getLocationDisplayName(l.def, l.index);
      const selected = l.trackKey === inj.location ? 'selected' : '';
      return `<option value="${escapeHtml(l.trackKey)}" ${selected}>${escapeHtml(displayName)}</option>`;
    }).join('');

    const rateExplain = inj.rate
      ? `Degrades ${inj.rate.label} — ${escapeHtml(inj.rate.tier)} tier. Rate driven by base ${ordinal(inj.baseLevel)} Degree${inj.effectiveBase !== inj.baseLevel ? ` (effective ${ordinal(inj.effectiveBase)} after modifiers)` : ''} vs half-HP ${inj.halfHp} (diff +${inj.diff})`
      : `Stable — below degradation threshold (needs base ≥ ${inj.halfHp}; currently ${inj.effectiveBase})`;

    let html = '<div class="injury-card-body">';

    // Top-row editable fields: name, base level, location.
    if (canEdit) {
      html += `<div class="injury-fields">
        <label class="injury-field injury-field-name">
          <span>Name</span>
          <input type="text" value="${escapeHtml(inj.name)}" maxlength="60"
                 onchange="updateInjuryField('${inj.id}','name',this.value)">
        </label>
        <label class="injury-field injury-field-level">
          <span>Base Level</span>
          <input type="number" value="${inj.baseLevel}" min="0" max="99"
                 onchange="updateInjuryField('${inj.id}','baseLevel',this.value)">
        </label>
        <label class="injury-field injury-field-loc">
          <span>Location</span>
          <select onchange="updateInjuryField('${inj.id}','location',this.value)">${locOptions}</select>
        </label>
      </div>`;
      html += `<label class="injury-field injury-field-desc">
        <span>Description</span>
        <textarea rows="2" maxlength="500"
                  onchange="updateInjuryField('${inj.id}','description',this.value)"
                  placeholder="Narrative details about this injury...">${escapeHtml(inj.description)}</textarea>
      </label>`;
    } else {
      // Read-only view
      html += `<div class="injury-fields-ro">
        <div><span class="ro-label">Location:</span> ${escapeHtml(locationLabel(inj.location, locations) || inj.location)}</div>
        <div><span class="ro-label">Base Level:</span> ${inj.baseLevel}</div>
        ${inj.description ? `<div class="injury-desc-ro">${escapeHtml(inj.description)}</div>` : ''}
      </div>`;
    }

    html += `<div class="injury-rate-info">${rateExplain}</div>`;

    // Two separate modifier lists — level (adjusts current severity) and
    // degradation (adjusts rate lookup only).
    html += renderInjuryModList(inj.id, 'level', 'Level Modifiers',
      'adjust current severity only', inj.levelModifiers, canEdit);
    html += renderInjuryModList(inj.id, 'degradation', 'Degradation Modifiers',
      'shift rate lookup — use for stabilization, destabilizing traumas, etc.',
      inj.degradationModifiers, canEdit);

    // Traumas sub-list
    html += renderTraumaList(inj, canEdit);

    if (canEdit) {
      html += `<div class="injury-delete-row">
        <button class="injury-delete-btn" onclick="removeInjury('${inj.id}')">Delete Injury</button>
      </div>`;
    }

    html += '</div>';
    return html;
  }

  function renderInjuryModList(injId, kind, title, hint, mods, canEdit) {
    const arr = Array.isArray(mods) ? mods : [];
    const rows = arr.length === 0
      ? '<div class="mod-empty">No modifiers.</div>'
      : arr.map((m, i) => `
        <div class="mod-item">
          <input type="text" class="mod-name-input" value="${escapeHtml(m.name || '')}"
                 placeholder="Modifier name" ${canEdit ? '' : 'disabled'}
                 onchange="updateInjuryMod('${injId}','${kind}',${i},'name',this.value)">
          <input type="number" class="mod-val-input" value="${parseInt(m.value) || 0}"
                 ${canEdit ? '' : 'disabled'}
                 onchange="updateInjuryMod('${injId}','${kind}',${i},'value',this.value)">
          ${canEdit ? `<span class="mod-delete" onclick="deleteInjuryMod('${injId}','${kind}',${i})">×</span>` : ''}
        </div>`).join('');

    const addRow = canEdit
      ? `<div class="mod-add-row">
          <input type="text" class="mod-name-input" id="inj-mod-name-${injId}-${kind}" placeholder="Name">
          <input type="number" class="mod-val-input" id="inj-mod-val-${injId}-${kind}" placeholder="±" value="0">
          <button class="mod-add-btn" onclick="addInjuryMod('${injId}','${kind}')">Add</button>
        </div>`
      : '';

    return `
      <div class="injury-mod-block">
        <div class="injury-mod-head">
          <span class="injury-mod-title">${escapeHtml(title)}</span>
          <span class="injury-mod-hint">${escapeHtml(hint)}</span>
        </div>
        <div class="mod-list">${rows}</div>
        ${addRow}
      </div>`;
  }

  function renderTraumaList(inj, canEdit) {
    const traumas = inj.traumas || [];
    let html = '<div class="trauma-block">';
    html += `<div class="trauma-head">
      <span class="trauma-title">Traumas</span>
      <span class="trauma-count">${traumas.length}</span>
    </div>`;

    if (traumas.length === 0) {
      html += '<div class="trauma-empty">No traumas attached.</div>';
    } else {
      html += '<div class="trauma-list">';
      traumas.forEach((t, i) => { html += renderTraumaCard(inj.id, t, i, canEdit); });
      html += '</div>';
    }

    if (canEdit) {
      html += `<div class="trauma-add-row">
        <button class="trauma-add-btn" onclick="addTrauma('${inj.id}')">+ Add Trauma</button>
      </div>`;
    }

    html += '</div>';
    return html;
  }

  function renderTraumaCard(injId, trauma, idx, canEdit) {
    const tierOpts = TRAUMA_TIERS.map(t =>
      `<option value="${t}" ${trauma.level === t ? 'selected' : ''}>${t}</option>`
    ).join('');

    if (!canEdit) {
      return `<div class="trauma-card">
        <div class="trauma-card-head">
          <span class="trauma-tier">(${escapeHtml(trauma.level || 'Minor')})</span>
          <span class="trauma-name">${escapeHtml(trauma.name || '(unnamed)')}</span>
        </div>
        ${trauma.description ? `<div class="trauma-desc">${escapeHtml(trauma.description)}</div>` : ''}
        ${trauma.system ? `<div class="trauma-system"><span class="trauma-sys-label">System:</span> ${escapeHtml(trauma.system)}</div>` : ''}
      </div>`;
    }

    return `<div class="trauma-card editing">
      <div class="trauma-card-head">
        <select class="trauma-tier-select" onchange="updateTraumaField('${injId}',${idx},'level',this.value)">
          ${tierOpts}
        </select>
        <input type="text" class="trauma-name-input" value="${escapeHtml(trauma.name || '')}"
               placeholder="Trauma name" maxlength="60"
               onchange="updateTraumaField('${injId}',${idx},'name',this.value)">
        <span class="mod-delete" onclick="removeTrauma('${injId}',${idx})">×</span>
      </div>
      <label class="trauma-field">
        <span>Description</span>
        <textarea rows="2" maxlength="300"
                  onchange="updateTraumaField('${injId}',${idx},'description',this.value)"
                  placeholder="Flavor / what the trauma represents">${escapeHtml(trauma.description || '')}</textarea>
      </label>
      <label class="trauma-field">
        <span>System</span>
        <textarea rows="2" maxlength="500"
                  onchange="updateTraumaField('${injId}',${idx},'system',this.value)"
                  placeholder="Mechanical effect. GMs implement via degradation modifiers above.">${escapeHtml(trauma.system || '')}</textarea>
      </label>
    </div>`;
  }

  // Given a location trackKey, return its display name. Null if not found.
  function locationLabel(trackKey, locations) {
    const l = locations.find(x => x.trackKey === trackKey);
    if (!l) return null;
    return getLocationDisplayName(l.def, l.index);
  }

  // CSS class hint based on the injury's diff (effective base minus half-HP).
  // Maps to severity tier coloring.
  function severityClass(diff) {
    if (diff < 0) return 'severity-none';
    if (diff <= 2) return 'severity-minor';
    if (diff <= 5) return 'severity-moderate';
    if (diff <= 8) return 'severity-major';
    if (diff <= 11) return 'severity-massive';
    if (diff <= 14) return 'severity-monumental';
    if (diff <= 17) return 'severity-mega';
    return 'severity-mythical';
  }

  // ─── SAN (SANITY) SECTION ───
  //
  // Dedicated section for mental health. Placed between physical health and
  // power. Damage is LINEAR (no FORT reduction) — this mirrors the spec that
  // mental wounds stack directly.
  //
  // Visual bar: 4 phases, same palette as HP location bars.
  //   Phase 1 (green→yellow): 0 damage → max damage      (Healthy → In Shock)
  //   Phase 2 (yellow→red):   max → 2*max                (In Shock → Insane)
  //   Phase 3 (red→deepRed):  2*max → 3*max              (Insane → Broken)
  //   Phase 4 (deepRed→black): 3*max → 4*max+            (Broken, deepening)
  //
  // Breaking Point reference panel renders when status === 'broken' so the
  // player has the roll outcomes right in front of them. Not auto-rolled —
  // system narratively triggers the roll; the UI just tells you what the
  // results mean.

  let editSanModifiersMode = false;

  function renderSanSection(result) {
    const san = result.san;
    if (!san) return '';  // ruleset doesn't define SAN — skip entirely
    const canEdit = ctx.getCanEdit();

    // Cap segment count so very high-SAN characters don't render a runaway
    // row of micro-segments. Each segment represents max/segCount damage.
    const SEG_CAP = 80;
    const segCount = Math.min(Math.max(san.max, 1), SEG_CAP);

    let html = '<div class="combat-section san-section">';

    // Header with title + Edit Modifiers button (parallel to Hit Locations).
    html += '<div class="combat-section-head">';
    html += '<div class="combat-section-title">Sanity</div>';
    if (canEdit) {
      html += `<button class="hl-edit-btn${editSanModifiersMode ? ' active' : ''}" onclick="toggleSanModifierEdit()">` +
              `${editSanModifiersMode ? 'Done' : 'Edit Modifiers'}</button>`;
    }
    html += '</div>';

    // Sanity stat card at the top — shows name, code, formula, value, and
    // description. Gives the player a clear reminder of what SAN is and
    // what they roll for mental resistances.
    const sanEntry = result.stats.get('SAN');
    if (sanEntry) {
      html += '<div class="ds-grid san-card-wrap">';
      html += renderDsCard(sanEntry);
      html += '</div>';
    }

    // Status line: SAN label, current/max, colored status pill.
    const statusClass = 'san-status-' + san.status;
    html += '<div class="san-top-row">';
    html += '<span class="san-label">SAN</span>';
    html += `<span class="san-nums"><span class="san-current">${san.current}</span><span class="san-slash"> / </span><span class="san-max">${san.max}</span></span>`;
    html += `<span class="san-status-pill ${statusClass}">${escapeHtml(san.statusLabel)}</span>`;
    html += '</div>';

    // Penalty text — empty when Healthy, printed in italic otherwise.
    if (san.penaltyText) {
      html += `<div class="san-penalty">${escapeHtml(san.penaltyText)}</div>`;
    }

    // Segmented bar.
    html += '<div class="san-bar">';
    html += renderSanSegments(san.max, san.damage, segCount);
    html += '</div>';

    // Damage controls (input shows effective current; +/- tick damage).
    if (canEdit) {
      // Max theoretical damage we might want to represent — 4x max covers
      // past-Broken state. Input clamp prevents absurd inputs.
      const damageCap = Math.max(san.max * 5, 10);
      html += `<div class="san-controls">
        <button class="hl-dmg-btn" onclick="tickSanDmg(1)" title="Take 1 Mental Damage">−</button>
        <input type="number" class="san-dmg-input" value="${san.current}" min="${-damageCap}" max="${san.max}"
               onchange="setSanCurrent(this.value)"
               title="Current SAN (type to set directly)">
        <button class="hl-dmg-btn" onclick="tickSanDmg(-1)" title="Heal 1 SAN">+</button>
      </div>`;
    } else {
      html += `<div class="san-controls san-controls-ro"><span class="san-current-ro">${san.current} / ${san.max}</span></div>`;
    }

    // Edit modifiers panel — same shape as Body modifier panel.
    if (editSanModifiersMode && canEdit) {
      html += renderSanModifierPanel(san);
    }

    // Stress indicator — percent of SAN's full range (max → -2×max) that's
    // been used up. Editable percentile modifiers, parallels Pain pill in
    // the Health section. Combines with Pain to form Strain, which reduces
    // dice pools on non-passive active rolls.
    html += renderStressPill(result);

    // Damages manager — simplified Injuries for mental health. Renders below
    // the bar and above the Breaking Point panel (if present). Players use
    // this to record specific mental wounds (e.g. "Traumatic Memory 3rd Degree")
    // that then feed back into the SAN damage pool.
    html += renderSanDamagesSection(result);

    // Breaking Point reference — shown whenever Broken. This is guidance,
    // not automation. GM rolls d10 per PRIME rules and applies the result.
    if (san.status === 'broken') {
      html += renderBreakingPointPanel();
    }

    html += '</div>';
    return html;
  }

  // UI-only state for Damages, mirroring the Injuries pattern.
  const expandedSanDamages = new Set();
  let sanDamagesOpen = false;

  function renderSanDamagesSection(result) {
    const san = result.san;
    const damages = (san && san.damages) || [];
    const canEdit = ctx.getCanEdit();

    let html = '<div class="injury-section san-damages-section">';
    html += `<div class="injury-head" onclick="toggleSanDamagesSection()">
      <span class="injury-head-caret">${sanDamagesOpen ? '▾' : '▸'}</span>
      <span class="injury-head-title">Damages</span>
      <span class="injury-head-count">${damages.length}</span>
    </div>`;

    if (!sanDamagesOpen) { html += '</div>'; return html; }

    // Quickadd form — just name + degree. No location, no AoE (SAN is one pool).
    if (canEdit) {
      html += `<div class="injury-quickadd-row san-qadd-row">
        <input type="text" id="qadd-sandmg-name" class="qadd-inj-name" placeholder="Damage name"
               onkeydown="if(event.key==='Enter')quickAddSanDamage()">
        <input type="number" id="qadd-sandmg-level" class="qadd-inj-level" placeholder="Deg"
               min="0" max="99" value="1"
               onkeydown="if(event.key==='Enter')quickAddSanDamage()">
        <button class="injury-add-btn" onclick="quickAddSanDamage()">Add</button>
      </div>`;
    }

    if (damages.length === 0) {
      html += '<div class="injury-empty">No damages recorded.</div>';
    } else {
      html += '<div class="injury-list">';
      damages.forEach(d => { html += renderSanDamageCard(d, canEdit); });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  // Single damage card. Compact header when collapsed, full editor when open.
  // Header reads: [caret] [Name] [Nth Degree] [−][+] [×]
  function renderSanDamageCard(dmg, canEdit) {
    const open = expandedSanDamages.has(dmg.id);

    let degreeText;
    if (dmg.currentLevel === dmg.baseLevel) {
      degreeText = `${ordinal(dmg.currentLevel)} Degree`;
    } else {
      degreeText = `${ordinal(dmg.currentLevel)} Degree <span class="injury-base-note">(base ${ordinal(dmg.baseLevel)})</span>`;
    }

    let html = `<div class="injury-card${open ? ' open' : ''}">`;
    html += `<div class="injury-card-head" onclick="toggleSanDamageExpand('${dmg.id}')">
      <span class="injury-caret">${open ? '▾' : '▸'}</span>
      <span class="injury-name">${escapeHtml(dmg.name || '(unnamed)')}</span>
      <span class="injury-degree">${degreeText}</span>
      ${canEdit ? `<span class="injury-quickmod" onclick="event.stopPropagation()">
        <button class="injury-qm-btn" onclick="event.stopPropagation();tickSanDamageQuickmod('${dmg.id}',-1)" title="Quickmod −1">−</button>
        <button class="injury-qm-btn" onclick="event.stopPropagation();tickSanDamageQuickmod('${dmg.id}',1)" title="Quickmod +1">+</button>
      </span>` : ''}
      ${canEdit ? `<button class="injury-quickdelete" onclick="event.stopPropagation();removeSanDamage('${dmg.id}')" title="Delete damage">×</button>` : ''}
    </div>`;

    if (open) {
      html += renderSanDamageBody(dmg, canEdit);
    }
    html += '</div>';
    return html;
  }

  function renderSanDamageBody(dmg, canEdit) {
    let html = '<div class="injury-card-body">';

    if (canEdit) {
      html += `<div class="injury-fields">
        <div class="injury-field">
          <span>Name</span>
          <input type="text" value="${escapeHtml(dmg.name || '')}" placeholder="Damage name"
                 onchange="updateSanDamageField('${dmg.id}','name',this.value)">
        </div>
        <div class="injury-field">
          <span>Base Degree</span>
          <input type="number" value="${dmg.baseLevel}" min="0" max="99"
                 onchange="updateSanDamageField('${dmg.id}','baseLevel',this.value)">
        </div>
      </div>
      <div class="injury-field injury-field-desc">
        <span>Description</span>
        <textarea rows="2" placeholder="What caused this, what it feels like, etc."
                  onchange="updateSanDamageField('${dmg.id}','description',this.value)">${escapeHtml(dmg.description || '')}</textarea>
      </div>`;
    } else {
      html += `<div class="injury-fields-ro">
        <div><span class="ro-label">Base</span>${ordinal(dmg.baseLevel)} Degree</div>
        ${dmg.description ? `<div class="injury-desc-ro">${escapeHtml(dmg.description)}</div>` : ''}
      </div>`;
    }

    // Level modifiers (parallels injury level modifiers — a list of named
    // signed values that shift currentLevel).
    const mods = Array.isArray(dmg.levelModifiers) ? dmg.levelModifiers : [];
    html += '<div class="injury-mod-block">';
    html += '<div class="injury-mod-head"><span class="injury-mod-title">Level Modifiers</span><span class="injury-mod-hint">Adjust current Degree (feeds SAN damage pool)</span></div>';
    if (mods.length === 0) {
      html += '<div class="mod-empty">No modifiers.</div>';
    } else {
      html += '<div class="mod-list">';
      mods.forEach((mod, idx) => {
        html += `<div class="mod-item">
          <input type="text" class="mod-name-input" value="${escapeHtml(mod.name || '')}" placeholder="Modifier name"
                 ${canEdit ? `onchange="updateSanDamageMod('${dmg.id}',${idx},'name',this.value)"` : 'readonly'}>
          <input type="number" class="mod-val-input" value="${mod.value || 0}" step="1"
                 ${canEdit ? `onchange="updateSanDamageMod('${dmg.id}',${idx},'value',this.value)"` : 'readonly'}>
          ${canEdit ? `<span class="mod-delete" onclick="deleteSanDamageMod('${dmg.id}',${idx})" title="Delete modifier">×</span>` : ''}
        </div>`;
      });
      html += '</div>';
    }
    if (canEdit) html += `<div class="mod-add-row"><button class="mod-add-btn" onclick="addSanDamageMod('${dmg.id}')">+ Add modifier</button></div>`;
    html += '</div>';

    if (canEdit) {
      html += `<div class="injury-delete-row">
        <button class="injury-delete-btn" onclick="removeSanDamage('${dmg.id}')">Delete Damage</button>
      </div>`;
    }

    html += '</div>';
    return html;
  }

  // Segment colors go: cool blue (healthy) → yellow (in shock) → orange
  // (insane) → red (broken). Once damage hits the Broken threshold (3×max),
  // every segment is fully red and stays red no matter how much further the
  // damage goes — Broken is the narrative floor, not a waypoint to worse.
  function renderSanSegments(sanMax, damage, segCount) {
    if (sanMax <= 0 || segCount <= 0) return '';
    const COLORS = {
      blue:   '#4a6a9a',
      yellow: '#bdb247',
      orange: '#c87a3a',
      red:    '#a63a3a'
    };
    const dmgPerSeg = sanMax / segCount;

    let html = '';
    for (let i = 1; i <= segCount; i++) {
      // rightDistance = how far from the right edge (1 = rightmost). Damage
      // eats the bar right-to-left.
      const rightDistance = segCount - i + 1;
      const base = (rightDistance - 1) * dmgPerSeg;

      let color;
      if (damage > 2 * sanMax + base) color = COLORS.red;
      else if (damage > sanMax + base) color = COLORS.orange;
      else if (damage > base) color = COLORS.yellow;
      else color = COLORS.blue;

      html += `<span class="san-seg" style="background:${color}"></span>`;
    }
    return html;
  }

  function renderSanModifierPanel(san) {
    const mods = Array.isArray(san.modifiers) ? san.modifiers : [];
    let html = '<div class="hl-mod-panel">';
    html += '<div class="mod-panel-head"><span class="mod-base">SAN Modifiers</span><span class="mod-panel-hint">stack onto max</span></div>';
    if (mods.length === 0) {
      html += '<div class="mod-empty">No modifiers.</div>';
    } else {
      html += '<div class="mod-list">';
      mods.forEach((mod, idx) => {
        html += `<div class="mod-item">
          <input type="text" class="mod-name-input" value="${escapeHtml(mod.name || '')}" placeholder="Modifier name"
                 onchange="updateSanMod(${idx}, 'name', this.value)">
          <input type="number" class="mod-val-input" value="${mod.value || 0}" step="1"
                 onchange="updateSanMod(${idx}, 'value', this.value)">
          <span class="mod-delete" onclick="deleteSanMod(${idx})" title="Delete modifier">×</span>
        </div>`;
      });
      html += '</div>';
    }
    html += `<div class="mod-add-row">
      <button class="mod-add-btn" onclick="addSanMod()">+ Add modifier</button>
    </div>`;
    html += '</div>';
    return html;
  }

  function renderBreakingPointPanel() {
    // Roll table is d10 (per PRIME convention). Results ordered high→low
    // because you'd rather score 7 than -1.
    return `<div class="san-breakpoint">
      <div class="san-breakpoint-title">⚠ Breaking Point</div>
      <div class="san-breakpoint-intro">Roll once when first Broken; reroll with each additional Mental Damage. You may take any lower-roll option if you roll higher.</div>
      <div class="san-breakpoint-table">
        <div class="san-bp-row san-bp-tier-best"><span class="san-bp-roll">7</span><span class="san-bp-name">Renewal</span><span class="san-bp-desc">Mental awakening — restore full SAN.</span></div>
        <div class="san-bp-row san-bp-tier-good"><span class="san-bp-roll">5–6</span><span class="san-bp-name">Partial Recovery</span><span class="san-bp-desc">Recover ½ SAN.</span></div>
        <div class="san-bp-row san-bp-tier-neutral"><span class="san-bp-roll">3–4</span><span class="san-bp-name">Steadied</span><span class="san-bp-desc">No negative effect (still reroll on further Mental Damage).</span></div>
        <div class="san-bp-row san-bp-tier-bad"><span class="san-bp-roll">1–2</span><span class="san-bp-name">Psychotic Break</span><span class="san-bp-desc">In control but antagonistic — act against allies/mission.</span></div>
        <div class="san-bp-row san-bp-tier-worst"><span class="san-bp-roll">0</span><span class="san-bp-name">Indefinitely Insane</span><span class="san-bp-desc">Uncontrollable, irrational, effectively a vegetable.</span></div>
        <div class="san-bp-row san-bp-tier-fatal"><span class="san-bp-roll">−1</span><span class="san-bp-name">Immediately Suicidal</span><span class="san-bp-desc">Must end own life by most effective means; Indefinitely Insane for all other purposes.</span></div>
      </div>
    </div>`;
  }

  // ─── SAN HANDLERS ───

  async function tickSanDmg(delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const cur = Math.max(0, Number.isFinite(charData.sanDamage) ? charData.sanDamage : 0);
    const next = Math.max(0, cur + delta);
    charData.sanDamage = next;
    await saveCharacter(ctx.getCharId(), { sanDamage: next });
    renderAll();
  }

  // Input shows CURRENT (max - total damage). Typing sets current.
  // Manual damage (sanDamage) is the only thing we can edit directly here —
  // structured damages' contribution is floor we can't dip below without
  // editing them. If the typed current would require NEGATIVE manual damage,
  // we clamp manual to 0.
  async function setSanCurrent(val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    const result = computeDerivedStats(charData, ruleset);
    if (!result.san) return;
    const sanMax = result.san.max;
    const damagesContribution = result.san.damagesContribution || 0;

    const typed = parseInt(val);
    if (!Number.isFinite(typed)) return;
    const floorCurrent = -(sanMax * 5);
    const clampedCurrent = Math.min(sanMax, Math.max(floorCurrent, typed));
    const totalDesiredDamage = Math.max(0, sanMax - clampedCurrent);
    // Manual portion = total - structured damages. Clamped at 0 since we can
    // only control manual; going below requires editing the damages themselves.
    const manual = Math.max(0, totalDesiredDamage - damagesContribution);

    charData.sanDamage = manual;
    await saveCharacter(ctx.getCharId(), { sanDamage: manual });
    renderAll();
  }

  function toggleSanModifierEdit() {
    if (!ctx.getCanEdit()) return;
    editSanModifiersMode = !editSanModifiersMode;
    renderAll();
  }

  async function addSanMod() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.sanModifiers)) charData.sanModifiers = [];
    charData.sanModifiers.push({ name: '', value: 0 });
    await saveCharacter(ctx.getCharId(), { sanModifiers: charData.sanModifiers });
    renderAll();
  }

  async function updateSanMod(idx, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.sanModifiers) || !charData.sanModifiers[idx]) return;
    if (field === 'name') charData.sanModifiers[idx].name = typeof val === 'string' ? val : '';
    else if (field === 'value') charData.sanModifiers[idx].value = parseInt(val) || 0;
    await saveCharacter(ctx.getCharId(), { sanModifiers: charData.sanModifiers });
    renderAll();
  }

  async function deleteSanMod(idx) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.sanModifiers) || !charData.sanModifiers[idx]) return;
    charData.sanModifiers.splice(idx, 1);
    await saveCharacter(ctx.getCharId(), { sanModifiers: charData.sanModifiers });
    renderAll();
  }

  // ─── SAN DAMAGES ───
  //
  // Structured mental wounds. Parallel to injuries but simpler: no location,
  // no traumas, no degradation. Each damage has a name, description, a
  // baseLevel (Degree) and optional level modifiers.

  function newSanDamageId() {
    return 'sandmg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function toggleSanDamagesSection() {
    sanDamagesOpen = !sanDamagesOpen;
    renderAll();
  }

  function toggleSanDamageExpand(id) {
    if (expandedSanDamages.has(id)) expandedSanDamages.delete(id);
    else expandedSanDamages.add(id);
    renderAll();
  }

  async function quickAddSanDamage() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.sanDamages)) charData.sanDamages = [];

    const nameEl  = document.getElementById('qadd-sandmg-name');
    const levelEl = document.getElementById('qadd-sandmg-level');

    const name = nameEl ? (nameEl.value || '').trim() : '';
    const baseLevel = levelEl ? Math.max(0, parseInt(levelEl.value) || 0) : 0;

    const dmg = {
      id: newSanDamageId(),
      name,
      description: '',
      baseLevel,
      levelModifiers: []
    };
    charData.sanDamages.push(dmg);
    expandedSanDamages.add(dmg.id);
    sanDamagesOpen = true;
    await saveCharacter(ctx.getCharId(), { sanDamages: charData.sanDamages });
    renderAll();
    const freshNameEl = document.getElementById('qadd-sandmg-name');
    if (freshNameEl) { freshNameEl.value = ''; freshNameEl.focus(); }
  }

  async function removeSanDamage(id) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.sanDamages)) return;
    charData.sanDamages = charData.sanDamages.filter(d => d.id !== id);
    expandedSanDamages.delete(id);
    await saveCharacter(ctx.getCharId(), { sanDamages: charData.sanDamages });
    renderAll();
  }

  async function updateSanDamageField(id, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const dmg = (charData.sanDamages || []).find(d => d.id === id);
    if (!dmg) return;
    if (field === 'baseLevel') {
      dmg.baseLevel = Math.max(0, parseInt(val) || 0);
    } else if (field === 'name' || field === 'description') {
      dmg[field] = typeof val === 'string' ? val : '';
    } else {
      return;
    }
    await saveCharacter(ctx.getCharId(), { sanDamages: charData.sanDamages });
    renderAll();
  }

  // Quickmod: +/- on collapsed header. Find-or-create a "Quickmod" level
  // modifier, zero removes it. Same pattern as injuries.
  async function tickSanDamageQuickmod(id, delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const dmg = (charData.sanDamages || []).find(d => d.id === id);
    if (!dmg) return;
    if (!Array.isArray(dmg.levelModifiers)) dmg.levelModifiers = [];

    const QM_NAME = 'Quickmod';
    const idx = dmg.levelModifiers.findIndex(m => m && m.name === QM_NAME);
    if (idx === -1) {
      if (delta !== 0) dmg.levelModifiers.push({ name: QM_NAME, value: delta });
    } else {
      const next = (parseInt(dmg.levelModifiers[idx].value) || 0) + delta;
      if (next === 0) dmg.levelModifiers.splice(idx, 1);
      else dmg.levelModifiers[idx].value = next;
    }
    await saveCharacter(ctx.getCharId(), { sanDamages: charData.sanDamages });
    renderAll();
  }

  async function addSanDamageMod(id) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const dmg = (charData.sanDamages || []).find(d => d.id === id);
    if (!dmg) return;
    if (!Array.isArray(dmg.levelModifiers)) dmg.levelModifiers = [];
    dmg.levelModifiers.push({ name: '', value: 0 });
    await saveCharacter(ctx.getCharId(), { sanDamages: charData.sanDamages });
    renderAll();
  }

  async function updateSanDamageMod(id, idx, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const dmg = (charData.sanDamages || []).find(d => d.id === id);
    if (!dmg || !Array.isArray(dmg.levelModifiers) || !dmg.levelModifiers[idx]) return;
    if (field === 'name') dmg.levelModifiers[idx].name = typeof val === 'string' ? val : '';
    else if (field === 'value') dmg.levelModifiers[idx].value = parseInt(val) || 0;
    await saveCharacter(ctx.getCharId(), { sanDamages: charData.sanDamages });
    renderAll();
  }

  async function deleteSanDamageMod(id, idx) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const dmg = (charData.sanDamages || []).find(d => d.id === id);
    if (!dmg || !Array.isArray(dmg.levelModifiers) || !dmg.levelModifiers[idx]) return;
    dmg.levelModifiers.splice(idx, 1);
    await saveCharacter(ctx.getCharId(), { sanDamages: charData.sanDamages });
    renderAll();
  }

  // ─── POWER SECTION ───
  // Rendered by char-power.js — see createPowerSection() wiring above.
  // We just call power.renderSection(result, ruleset, charData) in the
  // combat renderAll pipeline and stitch the returned HTML into place.

  // ─── HANDLERS ───

  async function tickHitLocationDmg(trackKey, delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.hitLocationDamage) charData.hitLocationDamage = {};
    // +/- only affects the manual damage pool. Injury damage is separate
    // and controlled via the Injuries section. Trying to "heal below zero
    // manual" would be weird UX; we clamp at 0 and let injuries still
    // contribute whatever they contribute.
    const cur = charData.hitLocationDamage[trackKey] || 0;
    charData.hitLocationDamage[trackKey] = Math.max(0, cur + delta);
    await saveCharacter(ctx.getCharId(), { hitLocationDamage: charData.hitLocationDamage });
    renderAll();
  }

  async function setHitLocationDmg(trackKey, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.hitLocationDamage) charData.hitLocationDamage = {};

    // The input now shows CURRENT HP (remaining = maxHP - effective damage),
    // so we need to convert that back to "desired effective damage" before
    // solving for the manual damage value. Fetch maxHP from computed stats.
    const ruleset = ctx.getRuleset();
    const result = computeDerivedStats(charData, ruleset);
    const locEntry = (result.locations || []).find(l => l.trackKey === trackKey);
    if (!locEntry) return;
    const maxHP = locEntry.maxHP || 0;

    const typed = parseInt(val);
    if (!Number.isFinite(typed)) return;
    // Clamp current HP between a generous floor (for past-DefDestroyed states)
    // and the location's maxHP (no overheal above max).
    const floorCurrent = -(maxHP * 4);
    const desiredCurrent = Math.min(maxHP, Math.max(floorCurrent, typed));
    const desired = Math.max(0, maxHP - desiredCurrent);

    // Given `desired` effective damage + existing injury instances at this
    // location + current FORT, solve for the manual damage value M. See
    // previous revision for the derivation; two cases:
    //
    //   Case B: M <= highest injury → manual is NOT the new highest.
    //     M = FORT*(desired - I[0]) - (sum(I) - I[0])
    //     Valid if M is in [0, I[0]]
    //
    //   Case A: M > highest injury → manual IS the new highest.
    //     M = desired - sum(I)/FORT
    //     Valid if M > I[0]
    //
    // Fallback clamp at 0 if desired is below the injury-only effective floor.
    const injuries = Array.isArray(charData.injuries) ? charData.injuries : [];
    const injInstances = injuries
      .filter(inj => (inj.location || 'torso') === trackKey)
      .map(inj => {
        const base = Number.isFinite(inj.baseLevel) ? inj.baseLevel : 0;
        const mods = Array.isArray(inj.levelModifiers) ? inj.levelModifiers : [];
        const modTotal = mods.reduce((a, m) => a + (parseInt(m.value) || 0), 0);
        return Math.max(0, base + modTotal);
      })
      .filter(lvl => lvl > 0)
      .sort((a, b) => b - a);

    const fort = (result.vars && result.vars.FORT) || 1;

    let manual;
    if (injInstances.length === 0) {
      manual = desired;
    } else {
      const injHighest = injInstances[0];
      const injSum = injInstances.reduce((s, v) => s + v, 0);
      const othersSum = injSum - injHighest;

      const mCaseB = fort * (desired - injHighest) - othersSum;
      if (mCaseB >= 0 && mCaseB <= injHighest) {
        manual = Math.max(0, Math.round(mCaseB));
      } else {
        const mCaseA = desired - injSum / fort;
        if (mCaseA > injHighest) {
          manual = Math.max(0, Math.round(mCaseA));
        } else {
          manual = 0;
        }
      }
    }

    charData.hitLocationDamage[trackKey] = manual;
    await saveCharacter(ctx.getCharId(), { hitLocationDamage: charData.hitLocationDamage });
    renderAll();
  }

  // ─── POWER HANDLERS ──────────────────────────────────────────────
  // All Power Pool and POWER resource handlers live in char-power.js.
  // The `power` module instance (created above) owns them. We re-export
  // the same names at the bottom of this factory so character.html's
  // existing window bindings keep working unchanged.


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

  // ─── INJURY / TRAUMA HANDLERS ───
  // Storage: charData.injuries = [{ id, name, description, baseLevel,
  //   location, levelModifiers, degradationModifiers, traumas }]

  function toggleInjurySection() {
    injuriesOpen = !injuriesOpen;
    // When closing, also collapse all individual cards so re-opening is clean.
    if (!injuriesOpen) expandedInjuries.clear();
    renderAll();
  }

  function toggleInjuryExpand(id) {
    if (expandedInjuries.has(id)) expandedInjuries.delete(id);
    else expandedInjuries.add(id);
    renderAll();
  }

  // Toggle whether a hit-location group (in the Injuries section) shows its
  // contained injuries. UI-only — doesn't persist to Firestore.
  function toggleInjuryLocation(trackKey) {
    if (openInjuryLocations.has(trackKey)) openInjuryLocations.delete(trackKey);
    else openInjuryLocations.add(trackKey);
    renderAll();
  }

  function newInjuryId() {
    return 'inj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function newTraumaId() {
    return 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Toggle a single location chip in the quick-add form.
  function toggleQuickAddLocation(trackKey) {
    if (quickAddLocations.has(trackKey)) quickAddLocations.delete(trackKey);
    else quickAddLocations.add(trackKey);
    // If we just cleared every selection, re-seed with the toggled key so
    // there's always at least one selected. (Alternative: allow empty and
    // disable the Add button; this is simpler.)
    if (quickAddLocations.size === 0) quickAddLocations.add(trackKey);
    renderAll();
  }

  // Toggle select-all. If every location is already selected, deselect all
  // except the first (always keep at least one selected for Add to do anything).
  function toggleQuickAddAllLocations() {
    const charData = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    const result = computeDerivedStats(charData, ruleset);
    const locations = result.locations || [];
    if (locations.length === 0) return;
    const allOn = locations.every(l => quickAddLocations.has(l.trackKey));
    if (allOn) {
      quickAddLocations.clear();
      quickAddLocations.add(locations[0].trackKey);
    } else {
      quickAddLocations.clear();
      locations.forEach(l => quickAddLocations.add(l.trackKey));
    }
    renderAll();
  }

  // Create an injury for each selected location. One injury per location,
  // all sharing the name/level/description. They get independent IDs,
  // modifiers, and traumas — so healing, modifying, or deleting one doesn't
  // touch the others. Useful for AoE damage (grenades, sweeping attacks,
  // environmental hazards).
  //
  // After adding: fields reset (name clears, degree back to 1). Location
  // selection is KEPT so rapid sequential adds to the same AoE pattern are
  // fast. Focus returns to the name field.
  async function quickAddInjury() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.injuries)) charData.injuries = [];

    const nameEl  = document.getElementById('qadd-inj-name');
    const levelEl = document.getElementById('qadd-inj-level');

    const name     = nameEl  ? (nameEl.value || '').trim() : '';
    const baseLevel = levelEl ? Math.max(0, parseInt(levelEl.value) || 0) : 0;

    // Snapshot the selected locations at the moment of add. If no locations
    // are selected for some reason, default to torso so we never silently
    // do nothing.
    const targets = quickAddLocations.size > 0
      ? Array.from(quickAddLocations)
      : ['torso'];

    targets.forEach(location => {
      const inj = {
        id: newInjuryId(),
        name,
        description: '',
        baseLevel,
        location,
        levelModifiers: [],
        degradationModifiers: [],
        traumas: []
      };
      charData.injuries.push(inj);
      // Auto-expand each new injury card so all created injuries are visible.
      expandedInjuries.add(inj.id);
      openInjuryLocations.add(location);
    });

    injuriesOpen = true;
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
    // Re-focus the name field so rapid sequential adds are smooth. Fields
    // reset: name clears; level stays at whatever you typed (often you're
    // applying the same level several times in a row).
    const freshNameEl = document.getElementById('qadd-inj-name');
    if (freshNameEl) { freshNameEl.value = ''; freshNameEl.focus(); }
  }

  async function removeInjury(id) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.injuries)) return;
    charData.injuries = charData.injuries.filter(x => x.id !== id);
    expandedInjuries.delete(id);
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  async function updateInjuryField(id, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === id);
    if (!inj) return;
    if (field === 'baseLevel') {
      inj.baseLevel = Math.max(0, parseInt(val) || 0);
    } else if (field === 'location' || field === 'name' || field === 'description') {
      inj[field] = typeof val === 'string' ? val : '';
    } else {
      return;
    }
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  // Quickmod: a single-click +/- on the injury's collapsed header to adjust
  // the current Degree without opening the card. Works by find-or-creating
  // a level modifier named "Quickmod" on the injury.
  //
  // If the resulting value is 0, we remove the modifier entirely so the
  // modifier list stays tidy — clicking + then − returns to baseline cleanly.
  async function tickInjuryQuickmod(injId, delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === injId);
    if (!inj) return;
    if (!Array.isArray(inj.levelModifiers)) inj.levelModifiers = [];

    const QM_NAME = 'Quickmod';
    let qmIdx = inj.levelModifiers.findIndex(m => m && m.name === QM_NAME);
    if (qmIdx === -1) {
      // Doesn't exist yet — create with the delta value.
      if (delta !== 0) inj.levelModifiers.push({ name: QM_NAME, value: delta });
    } else {
      const cur = parseInt(inj.levelModifiers[qmIdx].value) || 0;
      const next = cur + delta;
      if (next === 0) {
        // Remove to keep the modifier list clean when returning to baseline.
        inj.levelModifiers.splice(qmIdx, 1);
      } else {
        inj.levelModifiers[qmIdx].value = next;
      }
    }
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  // kind = 'level' | 'degradation' — which modifier list on the injury.
  function injuryModListRef(inj, kind) {
    if (kind === 'level') {
      if (!Array.isArray(inj.levelModifiers)) inj.levelModifiers = [];
      return inj.levelModifiers;
    } else if (kind === 'degradation') {
      if (!Array.isArray(inj.degradationModifiers)) inj.degradationModifiers = [];
      return inj.degradationModifiers;
    }
    return null;
  }

  async function addInjuryMod(injId, kind) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === injId);
    if (!inj) return;
    const nameEl = document.getElementById(`inj-mod-name-${injId}-${kind}`);
    const valEl  = document.getElementById(`inj-mod-val-${injId}-${kind}`);
    const name = nameEl ? (nameEl.value || '').trim() : '';
    const value = valEl ? (parseInt(valEl.value) || 0) : 0;
    if (!name) { if (nameEl) nameEl.focus(); return; }
    const list = injuryModListRef(inj, kind);
    if (!list) return;
    list.push({ name, value });
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  async function updateInjuryMod(injId, kind, i, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === injId);
    if (!inj) return;
    const list = injuryModListRef(inj, kind);
    if (!list || !list[i]) return;
    if (field === 'value') list[i].value = parseInt(val) || 0;
    else list[i][field] = val;
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  async function deleteInjuryMod(injId, kind, i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === injId);
    if (!inj) return;
    const list = injuryModListRef(inj, kind);
    if (!list) return;
    list.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  async function addTrauma(injId) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === injId);
    if (!inj) return;
    if (!Array.isArray(inj.traumas)) inj.traumas = [];
    inj.traumas.push({
      id: newTraumaId(),
      name: '',
      level: 'Minor',
      description: '',
      system: ''
    });
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  async function removeTrauma(injId, i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === injId);
    if (!inj || !Array.isArray(inj.traumas)) return;
    inj.traumas.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
    renderAll();
  }

  async function updateTraumaField(injId, i, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const inj = (charData.injuries || []).find(x => x.id === injId);
    if (!inj || !Array.isArray(inj.traumas) || !inj.traumas[i]) return;
    inj.traumas[i][field] = typeof val === 'string' ? val : '';
    await saveCharacter(ctx.getCharId(), { injuries: charData.injuries });
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
    // Power — delegated to char-power.js module. Same proxy pattern as
    // rollcalc: keep the original names so character.html's window bindings
    // don't need to know about the module split.
    tickPowerPool:    power.tickPowerPool,
    setPowerPool:     power.setPowerPool,
    tickPower:        power.tickPower,
    setPower:         power.setPower,
    setPowerColor:    power.setPowerColor,
    setPowerName:     power.setPowerName,
    powerPoolXpDelta: power.powerPoolXpDelta,
    toggleEditMode, addModifier, updateModifier, deleteModifier,
    // Injuries / Traumas
    toggleInjurySection, toggleInjuryExpand, toggleInjuryLocation,
    quickAddInjury, toggleQuickAddLocation, toggleQuickAddAllLocations,
    removeInjury, updateInjuryField,
    tickInjuryQuickmod,
    addInjuryMod, updateInjuryMod, deleteInjuryMod,
    addTrauma, removeTrauma, updateTraumaField,
    // Sanity
    tickSanDmg, setSanCurrent, toggleSanModifierEdit,
    addSanMod, updateSanMod, deleteSanMod,
    // Sanity Damages
    toggleSanDamagesSection, toggleSanDamageExpand,
    quickAddSanDamage, removeSanDamage, updateSanDamageField,
    tickSanDamageQuickmod,
    addSanDamageMod, updateSanDamageMod, deleteSanDamageMod,
    // Card dice modifiers (player/GM-editable bonus dice for rolls)
    toggleDiceModPanel, addDiceMod, updateDiceMod, deleteDiceMod,
    // Strain value-display toggle (click to collapse "10 − 2.5" to "7.5")
    toggleStrainValueDisplay,
    // Roll Calculator — delegated to char-rollcalc.js module. These are
    // thin proxies so the existing window.rollCalc* wirings in
    // character.html keep working without needing to know the module split.
    rollCalcSetStat:       rollcalc.setStat,
    rollCalcSetSkill:      rollcalc.setSkill,
    rollCalcSetStatValue:  rollcalc.setStatValue,
    rollCalcSetSkillValue: rollcalc.setSkillValue,
    rollCalcSetStatmod:    rollcalc.setStatmod,
    rollCalcSetDifficulty: rollcalc.setDifficulty,
    rollCalcSetMitigation: rollcalc.setMitigation,
    rollCalcSetReduction:  rollcalc.setReduction,
    rollCalcToggle:        rollcalc.toggleShowRaw,
    rollCalcSetPassive:    rollcalc.setPassive,
    // Pain / Stress (percentile modifiers feeding Strain)
    togglePainPanel, addPainMod, updatePainMod, deletePainMod,
    toggleStressPanel, addStressMod, updateStressMod, deleteStressMod
  };
}
