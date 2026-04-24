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
import { createConditionsSection } from './char-conditions.js';
import { wrapCollapsibleSection } from './char-util.js';

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
    // ── ROLL CALCULATOR SECTION ──
    // The "what will I roll right now" block. Groups the Roll
    // Calculator tile with the Penalty summary tile as one visual
    // unit because the two numbers are read together mid-turn — the
    // Roll Calc tells you your dice pool after Penalty reduction, and
    // the Penalty tile tells you where the reduction came from. They
    // live in one outer collapsible section so players who don't want
    // either visible (e.g. during exploration scenes) can hide them
    // both with a single click.
    //
    // The inner tiles each retain their own internal collapse for
    // granular control — collapsing the outer section hides both at
    // once; collapsing an inner tile affects only that tile. Storage
    // keys don't conflict since the outer section uses its own slug.
    const rollCalcSectionBody =
      rollcalc.renderTile(result, ruleset, charData) +
      overview.renderPenaltyTile(
        result.pain, result.stress, result.penalty,
        Array.isArray(charData.otherModifiers) ? charData.otherModifiers : [],
        ctx.getCanEdit(),
        {
          collapsible: true,
          slug: 'penalty-combat',
          rerenderHandler: 'combatToggleTile'
        }
      );
    html += wrapCollapsibleSection(
      'prime.collapse.combat.rollcalc-section',
      '<span class="combat-section-title-text">Roll Calculator</span>',
      rollCalcSectionBody,
      {
        wrapperClass: 'combat-section combat-section-rollcalc',
        collapsibleClass: 'combat-section-title',
        rerenderHandler: 'combatToggleCollapse'
      }
    );
    // Combat Tracker — action-economy widget. Personal per-character
    // tracker of Action / Fast Actions / Movement / SPR / Reactions
    // within a round. Injects auto-managed entries into Other Mods
    // for Fast Action and Sprint penalties. Sits between Roll Calc
    // and the movement/health detail sections so it's visible
    // without scrolling during combat.
    html += renderCombatTrackerSection(result);
    // Movement below — speed, agility, reflex. Fast-lookup info you need
    // during play, positioned ahead of the more detailed health UI.
    html += renderDerivedStatsSection(result, ruleset, { includeGroups: ['movement'] });
    // Health section — HP/FORT cards + hit locations + Body + injuries.
    html += renderHitLocationsSection(result);
    // Sanity section — mental health pool, placed between physical and power.
    html += renderSanSection(result);
    // All other derived stat groups (mental, etc.) render below.
    // 'carry' is excluded because CAP / LIFT / ENC render as their own
    // cards at the top of the Inventory tab — putting them here too
    // would duplicate them (which is where the stray "Other" section
    // was coming from before). The three carry stats are authored with
    // `group: 'carry'` precisely so they can be filtered out here.
    html += renderDerivedStatsSection(result, ruleset, { excludeGroups: ['movement', 'carry'] });
    // Power last (its own complex section with resource bar).
    html += power.renderSection(result, ruleset, charData);
    container.innerHTML = html || '<div class="combat-empty">No combat data configured in this ruleset.</div>';
  }

  // ─── STATE OF THINGS (overview dashboard) ───
  // Extracted to char-overview.js. The module renders Body / Sanity /
  // Power / Movement / Penalty tiles into the Overview tab's #state-body
  // host. We also re-use its renderPenaltyTile inline on the Combat tab.
  //
  // We inject getCollapsedPenaltyValues so Movement tile can read the
  // same collapse state as the Combat-tab stat cards without owning it.
  // ─── CONDITIONS SECTION ───
  // Extracted to char-conditions.js. Renders inside the Overview tile
  // grid (via the overview section's renderConditionsTile wrapper).
  // We pass a requestRerender callback so the module can trigger a
  // fresh renderAll() when its state changes (entry added/edited/etc).
  const conditionsSection = createConditionsSection({
    getCharId:   ctx.getCharId,
    getCharData: ctx.getCharData,
    getCanEdit:  ctx.getCanEdit,
    getRuleset:  ctx.getRuleset,
    escapeHtml,
    fmt,
    requestRerender: () => renderAll()
  });

  const overview = createOverviewSection({
    getCollapsedPenaltyValues: () => collapsedPenaltyValues,
    getCharData: ctx.getCharData,
    getCanEdit:  ctx.getCanEdit,
    escapeHtml,
    fmt,
    conditionsSection,
    // Forward the description renderer from sectionCtx so the Body /
    // Sanity / Penalty tiles can show the ruleset-authored, player-
    // overridable description blocks. Read lazily because sectionCtx
    // gets renderDescriptionDisplay attached AFTER combat.js runs its
    // factory (the descriptions module is instantiated last so it can
    // call back into stats/combat for re-renders). Using a getter
    // means whatever value sectionCtx has at render time wins.
    renderDescriptionDisplay: (category, id, opts) =>
      (typeof ctx.renderDescriptionDisplay === 'function')
        ? ctx.renderDescriptionDisplay(category, id, opts)
        : ''
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
      // Each stat group is its own collapsible section. Storage key
      // includes the group code (e.g. 'movement', 'mental') so toggles
      // survive the order of groups being rearranged in the ruleset.
      const headHtml = `<span class="combat-section-title-text">${escapeHtml(g.label)}</span>`;
      let bodyHtml = '<div class="ds-grid">';
      stats.forEach(entry => { bodyHtml += renderDsCard(entry); });
      bodyHtml += '</div>';
      html += wrapCollapsibleSection(
        `prime.collapse.combat.group-${g.code}`,
        headHtml,
        bodyHtml,
        { wrapperClass: 'combat-section', collapsibleClass: 'combat-section-title', rerenderHandler: 'combatToggleCollapse' }
      );
    });
    if (orphans.length > 0) {
      const headHtml = `<span class="combat-section-title-text">Other</span>`;
      let bodyHtml = '<div class="ds-grid">';
      orphans.forEach(entry => { bodyHtml += renderDsCard(entry); });
      bodyHtml += '</div>';
      html += wrapCollapsibleSection(
        'prime.collapse.combat.group-other',
        headHtml,
        bodyHtml,
        { wrapperClass: 'combat-section', collapsibleClass: 'combat-section-title', rerenderHandler: 'combatToggleCollapse' }
      );
    }
    return html;
  }

  // UI-only state: which cards currently have their dice-mod panel expanded.
  // Set of stat codes. Not persisted across reloads.
  const expandedDiceMods = new Set();
  // Tracks which stat cards have their penalty-reduced value COLLAPSED —
  // i.e. showing just the final effective number ("7.5 ft/sec") rather
  // than the full breakdown ("10 − 2.5 ft/sec"). Per-stat toggle, lives
  // in memory only (resets on full re-render, persists across in-place
  // toggles via pure CSS class swap, no render needed).
  const collapsedPenaltyValues = new Set();

  // Speed conversion panel expanded state. Per-stat code. The panel
  // shows a single chosen conversion (3s / 6s / min / hr / mph / km/h
  // / m/s) computed from the card's effective (post-Penalty) value.
  // Opt-in per stat def via def.showSpeedConversions. Session-only,
  // resets on full re-render.
  const expandedSpeedConversions = new Set();

  // Speed conversion table — maps a conversion key to its label, unit
  // suffix, and multiplier against ft/sec. The 'sec' key is the
  // identity (native ft/sec) so users can explicitly reset back to
  // the base unit from the conversion panel's dropdown.
  //
  // Shared between the main card value (which swaps the displayed
  // value AND unit when a non-'sec' choice is active) and the
  // conversion panel (which shows the full seven options with
  // previews). Keeping one source of truth means a label/mult edit
  // only has to happen here.
  const SPEED_CONVERSION_TABLE = {
    'sec':  { label: 'per second',   unit: 'ft/sec', mult: 1 },
    '3s':   { label: '3 seconds',    unit: 'ft',     mult: 3 },
    '6s':   { label: '6 seconds',    unit: 'ft',     mult: 6 },
    '1min': { label: 'per minute',   unit: 'ft',     mult: 60 },
    '1hr':  { label: 'per hour',     unit: 'ft',     mult: 3600 },
    'mph':  { label: 'miles/hour',   unit: 'mph',    mult: 3600 / 5280 },
    'kmh':  { label: 'km/hour',      unit: 'km/h',   mult: 0.3048 * 3.6 },
    'mps':  { label: 'meters/sec',   unit: 'm/s',    mult: 0.3048 }
  };
  const SPEED_CONVERSION_ORDER = ['sec','3s','6s','1min','1hr','mph','kmh','mps'];

  // Format a speed-converted value with unit-appropriate precision.
  // ft distances: comma-thousands for big (≥1k), integer for medium
  // (≥100), one decimal otherwise. All other units: always one decimal.
  // Kept as a free function (not nested in the panel renderer) so the
  // main card value can use the exact same formatting.
  function formatSpeedValue(n, unit) {
    if (!Number.isFinite(n)) return '0';
    if (unit === 'ft') {
      if (n >= 1000) return Math.round(n).toLocaleString('en-US');
      if (n >= 100)  return Math.round(n).toString();
      return (Math.round(n * 10) / 10).toString();
    }
    return (Math.round(n * 10) / 10).toString();
  }

  // Per-stat selection of WHICH conversion to show in the panel AND
  // on the main card value. Map<statCode, conversionKey>. Defaults
  // to 'sec' (native ft/sec, no conversion applied) so cards open
  // in their natural state. Picking any other key in the panel's
  // dropdown persists here and causes the main card value to swap
  // units — e.g. selecting '6s' makes the card read "30 ft" instead
  // of "5 ft/sec". Collapsing the panel preserves the choice; the
  // user has to open the panel and pick 'sec' to revert. Valid keys
  // match SPEED_CONVERSION_TABLE above.
  const speedConversionChoice = new Map();

  // Toggle handler for the penalty-value display. CSS-driven: flips a class
  // on the card(s) with this stat code, so both display variants live in
  // the DOM and we swap visibility without running renderAll. That avoids
  // losing focus/scroll and makes the click feel instant.
  function togglePenaltyValueDisplay(code) {
    if (!code) return;
    if (collapsedPenaltyValues.has(code)) collapsedPenaltyValues.delete(code);
    else collapsedPenaltyValues.add(code);
    // Flip the class on BOTH the Combat-tab card and the Overview movement
    // item. They share data-code, so one selector catches both views —
    // click in either place, both views update in sync without a render.
    const targets = document.querySelectorAll(
      `.ds-card[data-code="${CSS.escape(code)}"], .state-movement-item[data-code="${CSS.escape(code)}"]`
    );
    targets.forEach(el => el.classList.toggle('penalty-collapsed'));
  }

  // Toggle the speed-conversions panel for a specific stat. Triggers a
  // full re-render since the panel's presence changes card height and
  // the contents depend on current state. Called from the caret button
  // rendered inside renderDsCard for stats with def.showSpeedConversions.
  function toggleSpeedConversions(code) {
    if (!code) return;
    if (expandedSpeedConversions.has(code)) expandedSpeedConversions.delete(code);
    else expandedSpeedConversions.add(code);
    renderAll();
  }

  // Change which conversion is displayed for a given stat. Full
  // re-render so BOTH the panel result AND the main card value swap
  // to the new unit. The card reads the CURRENT effective (post-
  // Penalty) value each render so penalty changes propagate
  // automatically.
  //
  // 'sec' is the identity choice — selecting it displays the card in
  // its native ft/sec rather than any scaled unit. Users pick 'sec'
  // to revert a previously-set override.
  function setSpeedConversionChoice(code, choice) {
    if (!code) return;
    if (!SPEED_CONVERSION_TABLE[choice]) return;
    speedConversionChoice.set(code, choice);
    renderAll();
  }

  function renderDsCard(entry) {
    const { def, value, error, rollModifier, diceMods, diceModTotal } = entry;
    const canEdit = ctx.getCanEdit();

    // Speed-conversion override — when this stat has showSpeedConversions
    // AND the user has picked a conversion key other than 'sec', the
    // card's main value displays the scaled result in the chosen unit
    // instead of the native ft/sec. Choice persists on the
    // speedConversionChoice Map across re-renders, so collapsing the
    // panel doesn't revert the display (the user sees what they picked
    // until they pick 'per second' explicitly to go back).
    //
    // `activeConv` is the lookup entry, null when not overriding.
    // Downstream code uses it to swap value and unit in lockstep.
    let activeConv = null;
    if (def.showSpeedConversions === true && Number.isFinite(value) && !error) {
      const choice = speedConversionChoice.get(def.code);
      if (choice && choice !== 'sec' && SPEED_CONVERSION_TABLE[choice]) {
        activeConv = SPEED_CONVERSION_TABLE[choice];
      }
    }

    const display = error
      ? 'ERR'
      : (activeConv ? formatSpeedValue(value * activeConv.mult, activeConv.unit) : fmt(value));
    const unitStr = activeConv
      ? activeConv.unit
      : (def.unit || '');
    const unit = unitStr ? ` <span class="ds-card-unit">${escapeHtml(unitStr)}</span>` : '';

    // Inline penalty value reduction — for movement-style stats flagged as
    // penaltyReducesValue. Two display modes baked into the markup at once:
    //
    //   EXPANDED (default):  "10 − 2.5 ft/sec"   ← base and reduction both shown
    //   COLLAPSED:           "7.5 ft/sec"        ← pre-computed effective value
    //
    // The card has a 'penalty-collapsed' class if the player clicked to
    // collapse; CSS hides whichever span is inactive. Click anywhere on
    // the value toggles the class in-place (no re-render). Both spans
    // carry their own tooltip explaining the other mode.
    //
    // When a speed conversion is active, BOTH spans scale by the
    // conversion multiplier so the card stays coherent — e.g. at 6s
    // scale a "30 − 15 ft" breakdown replaces "5 − 2.5 ft/sec".
    let valueBody;
    const valReduction = entry.penaltyValueReduction || 0;
    const hasPenaltyDisplay = valReduction > 0 && Number.isFinite(value) && !error;
    if (hasPenaltyDisplay) {
      const effective = Math.max(0, value - valReduction);
      // Scale all three values by the active conversion if one is set.
      // Formatter picks thousand-separators / decimals based on the
      // destination unit so the display stays readable at both scales.
      const scale = activeConv ? activeConv.mult : 1;
      const scaleUnit = activeConv ? activeConv.unit : '';
      const fmtScaled = (n) => activeConv ? formatSpeedValue(n * scale, scaleUnit) : fmt(n);
      const reductionStr = fmtScaled(valReduction);
      const effectiveStr = fmtScaled(effective);
      const baseStr      = fmtScaled(value);
      const pct = entry.penaltyPercent || 0;
      const unitLabel = activeConv ? activeConv.unit : (def.unit || '');
      const unitSuffix = unitLabel ? ' ' + unitLabel : '';
      const expandedTip = `Penalty reduces this value by ${reductionStr} (${pct}% of base ${baseStr}). Effective: ${effectiveStr}${unitSuffix}. Click to show effective only.`;
      const collapsedTip = `Effective ${effectiveStr}${unitSuffix} — base ${baseStr} reduced by ${reductionStr} (${pct}% Penalty). Click to show breakdown.`;
      valueBody = `<span class="ds-card-penalty-toggle" onclick="togglePenaltyValueDisplay('${escapeHtml(def.code)}')">` +
          `<span class="ds-card-penalty-expanded" title="${escapeHtml(expandedTip)}">${baseStr} <span class="ds-card-penalty-reduction">− ${reductionStr}</span></span>` +
          `<span class="ds-card-penalty-effective" title="${escapeHtml(collapsedTip)}">${effectiveStr}</span>` +
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
    //
    // Hidden entirely for non-rollable stats — if you don't roll the stat,
    // the modifier is meaningless. (Moved the isRollable check below the
    // dice-pill block just to centralize the derive, but we reference it
    // here by re-deriving locally; both calls are cheap.)
    let rollBadge = '';
    if (def.rollable !== false && Number.isFinite(rollModifier)) {
      const sign = rollModifier > 0 ? '+' : (rollModifier < 0 ? '−' : '±');
      const absNum = Math.abs(rollModifier);
      const tip = def.rollModifier
        ? `Static roll modifier: ${def.rollModifier} — added to the roll total`
        : 'Static roll modifier — added to the roll total';
      rollBadge = `<div class="ds-card-rollmod" title="${escapeHtml(tip)}">${sign}${absNum}</div>`;
    }

    // Bottom-area DICE MOD pill — editable. Shows the FINAL dice count the
    // player actually rolls, factoring in dice modifiers AND Penalty
    // (for active rolls). Click to expand an editor with the full breakdown.
    //
    // ALWAYS shown for rollable stats — even when the pool equals the base
    // and there are no mods. Previously the pill was suppressed in that
    // "clean" case, which left cards like HP / SAN / INIT showing just a
    // big number with no visual cue that the number IS a dice pool. Always
    // showing the "Xd" pill makes "these are dice stats" unambiguous at
    // a glance and unifies with the click-to-edit affordance.
    //
    // SKIPPED ENTIRELY for stats marked `rollable: false` (SPD, SPR, AGL,
    // RFX, FORT — static derived values that aren't rolled as dice pools).
    // Default `rollable === true` preserves behavior for existing stats
    // (HP, SAN, INIT, and any ruleset-authored stat without the field).
    const hasDiceMods = Array.isArray(diceMods) && diceMods.length > 0;
    const isPassive = entry.isPassive === true;
    const penaltyDice = entry.penaltyDice || 0;
    const finalDice = Number.isFinite(entry.finalDice)
      ? entry.finalDice
      : (Number.isFinite(value) ? value : 0);
    const baseDice = Number.isFinite(value) ? value : 0;
    const dicePoolDiffersFromBase = finalDice !== baseDice;
    const openPanel = expandedDiceMods.has(def.code);
    const isRollable = def.rollable !== false;
    let dicePill = '';
    if (isRollable) {
      // Pill label: "X DICE" always. The full word "DICE" is used
      // instead of the terse "d" suffix so the pill reads as an
      // unambiguous "this is a dice pool" label even at a glance.
      // Previously showed "Xd" which looked more like a shorthand
      // number-with-unit than a "dice stat" signifier.
      const pillLabel = `${finalDice} DICE`;
      let pillClass;
      if (dicePoolDiffersFromBase || hasDiceMods) {
        pillClass = ' has-mods';
      } else {
        pillClass = ' empty';
      }
      const tipParts = [];
      tipParts.push(`Rolling ${finalDice}d (base ${baseDice})`);
      if (hasDiceMods) {
        const sign = diceModTotal >= 0 ? '+' : '−';
        tipParts.push(`${sign}${Math.abs(diceModTotal)}d bonus`);
      }
      if (penaltyDice > 0) {
        tipParts.push(`−${penaltyDice}d Penalty`);
      } else if (isPassive) {
        tipParts.push('passive — Penalty does not apply');
      }
      if (canEdit) tipParts.push('Click to edit');
      const pillTip = tipParts.join(' · ');
      dicePill = canEdit
        ? `<button class="ds-card-dicepill${openPanel ? ' open' : ''}${pillClass}"
                  onclick="toggleDiceModPanel('${escapeHtml(def.code)}')"
                  title="${escapeHtml(pillTip)}"
                  type="button">${pillLabel}</button>`
        : `<span class="ds-card-dicepill${pillClass} readonly" title="${escapeHtml(pillTip)}">${pillLabel}</span>`;
    } else if ((def.allowValueMods === true || def.allowPenaltyFilter === true) && canEdit) {
      // Non-rollable stats that opt into value mods or the penalty
      // filter get an "EDIT" pill instead of the dice pill. Same
      // toggle behavior — click to expand the stat-edit panel.
      // Without this the panel would be unreachable on SPD/SPR
      // because the dice pill (the normal click target) is gated on
      // isRollable.
      const vmCount = Array.isArray(entry.valueMods) ? entry.valueMods.length : 0;
      const charData = ctx.getCharData();
      const hasFilter = !!(charData && charData.penaltyFilters && charData.penaltyFilters[def.code]);
      const hasEdits = vmCount > 0 || hasFilter;
      const pillLabel = hasEdits ? 'EDIT ✎' : 'EDIT';
      const pillClass = hasEdits ? ' has-mods' : ' empty';
      const hints = [];
      if (def.allowValueMods) hints.push('flat value bonuses');
      if (def.allowPenaltyFilter) hints.push('per-source Penalty filter');
      const pillTip = `Click to edit: ${hints.join(', ')}`;
      dicePill = `<button class="ds-card-dicepill${openPanel ? ' open' : ''}${pillClass}"
                  onclick="toggleDiceModPanel('${escapeHtml(def.code)}')"
                  title="${escapeHtml(pillTip)}"
                  type="button">${pillLabel}</button>`;
    }

    // Expanded panel content — dice modifier editor plus, for opted-in
    // stats (allowValueMods / allowPenaltyFilter), sections for flat
    // value bonuses and per-source Penalty whitelist. See
    // renderStatEditPanel for the section breakdown.
    let panelHtml = '';
    if (openPanel && canEdit) {
      panelHtml = renderStatEditPanel(def, value, diceMods, diceModTotal, {
        isPassive,
        penaltyDice,
        finalDice,
        penaltyPercent: entry.penaltyPercent || 0
      }, entry.valueMods || [], entry.valueModTotal || 0);
    }

    const collapsedClass = hasPenaltyDisplay && collapsedPenaltyValues.has(def.code)
      ? ' penalty-collapsed'
      : '';

    // Speed conversions — opt-in via def.showSpeedConversions. Shows a
    // small ⇅ caret button next to the value that toggles an inline
    // panel with a dropdown + result for a single chosen conversion
    // (3s / 6s / 1min / 1hr / mph / km/h / m/s). The math uses the
    // EFFECTIVE (post-Penalty) value; the panel displays the effective
    // value and Penalty % explicitly so the link is visible.
    let speedToggle = '';
    let speedPanelHtml = '';
    if (def.showSpeedConversions === true && Number.isFinite(value) && !error) {
      const isOpen = expandedSpeedConversions.has(def.code);
      const effective = hasPenaltyDisplay ? Math.max(0, value - valReduction) : value;
      const penaltyPct = entry.penaltyPercent || 0;
      const tip = isOpen
        ? `Hide speed conversions for ${def.name}.`
        : `Show a speed conversion (3s / 6s / min / hr / mph / km·h / m·s). Uses the current effective value (post-Penalty).`;
      speedToggle = `<button class="ds-card-conv-toggle${isOpen ? ' open' : ''}"
            onclick="toggleSpeedConversions('${escapeHtml(def.code)}')"
            title="${escapeHtml(tip)}"
            type="button">⇅</button>`;
      if (isOpen) {
        // Default to 'sec' (native ft/sec, identity conversion) when
        // no choice is set — the panel opens showing the card's native
        // value in its natural unit, and the user picks from there to
        // override. Explicitly picking 'sec' again is how users revert
        // the card from a scaled view back to ft/sec.
        const choice = speedConversionChoice.get(def.code) || 'sec';
        speedPanelHtml = renderSpeedConversionsPanel(def, value, effective, penaltyPct, choice);
      }
    }

    return `
      <div class="ds-card${openPanel ? ' rollmod-open' : ''}${collapsedClass}" data-code="${escapeHtml(def.code)}"${errTitle}>
        ${rollBadge}
        <div class="ds-card-name">${escapeHtml(def.name)}${codeBadge}</div>
        ${formulaBadge}
        <div class="ds-card-value${error ? ' ds-card-error' : ''}">${valueBody}${unit}${speedToggle}</div>
        ${dicePill}
        ${ctx.renderDescriptionDisplay
          ? ctx.renderDescriptionDisplay('derivedStats', def.code, { wrapperClass: 'ds-card-desc' })
          : (def.description ? `<div class="ds-card-desc">${escapeHtml(def.description)}</div>` : '')}
        ${speedPanelHtml}
        ${panelHtml}
      </div>`;
  }

  // Render the speed-conversions panel for a stat card. Dropdown lets
  // the player pick one of seven conversions; the result displays
  // alongside. The result follows the SAME click-to-toggle convention
  // as the main stat value — wrapped in the `ds-card-penalty-toggle`
  // classes so clicking either one flips the whole card's
  // `.penalty-collapsed` state. That keeps the main value and the
  // conversion result in sync without any extra handler wiring.
  //
  // Inputs:
  //   def        — stat def (for name / unit labels)
  //   baseValue  — pre-Penalty value
  //   effective  — post-Penalty value
  //   penaltyPct — current Penalty %
  //   choice     — selected conversion key
  //
  // The panel value is treated as feet per second. SPDUP is also
  // ft/sec-equivalent because it's added to SPD (see the default
  // stat's description).
  function renderSpeedConversionsPanel(def, baseValue, effective, penaltyPct, choice) {
    const b = Number.isFinite(baseValue) ? baseValue : 0;
    const e = Number.isFinite(effective) ? effective : 0;
    const reduction = Math.max(0, b - e);

    // Shared conversion table (SPEED_CONVERSION_TABLE) owns the label/
    // unit/multiplier values. We just read from it here — the order
    // and formatting rules live with the table so adding a new
    // conversion is a one-place edit.
    const order = SPEED_CONVERSION_ORDER;
    const units = SPEED_CONVERSION_TABLE;
    const sel = units[choice] || units['sec'];
    const fmtN = formatSpeedValue;

    // Per-choice computed values.
    const resultEff  = e * sel.mult;
    const resultBase = b * sel.mult;
    const resultRed  = reduction * sel.mult;

    // Secondary /hr-in-miles label for long distances.
    const hrInMilesEff  = (choice === '1hr' && resultEff  >= 5280)
      ? ` <span class="ds-conv-sub">(${fmtN(resultEff  / 5280, 'mph')} mi)</span>` : '';
    const hrInMilesBase = (choice === '1hr' && resultBase >= 5280)
      ? ` <span class="ds-conv-sub">(${fmtN(resultBase / 5280, 'mph')} mi)</span>` : '';

    // The result block — when Penalty is active, wrap in the same
    // `ds-card-penalty-toggle` structure as the main value. Clicking
    // either view flips the card's `.penalty-collapsed` class, which
    // CSS uses to swap the visible span. When there's no Penalty,
    // render a single value (no toggle needed).
    const hasPenalty = penaltyPct > 0 && reduction > 0;
    let resultHtml;
    if (hasPenalty) {
      const expandedTip = `Base ${fmtN(resultBase, sel.unit)} reduced by ${fmtN(resultRed, sel.unit)} (${penaltyPct}% Penalty). Effective: ${fmtN(resultEff, sel.unit)} ${sel.unit}. Click to show effective only.`;
      const collapsedTip = `Effective ${fmtN(resultEff, sel.unit)} ${sel.unit} — base ${fmtN(resultBase, sel.unit)} reduced by ${fmtN(resultRed, sel.unit)} (${penaltyPct}% Penalty). Click to show breakdown.`;
      resultHtml =
        `<span class="ds-card-penalty-toggle ds-conv-result-wrap" onclick="togglePenaltyValueDisplay('${escapeHtml(def.code)}')">` +
          `<span class="ds-card-penalty-expanded ds-conv-result" title="${escapeHtml(expandedTip)}">` +
            `${fmtN(resultBase, sel.unit)} ` +
            `<span class="ds-card-penalty-reduction">− ${fmtN(resultRed, sel.unit)}</span> ` +
            `<span class="ds-conv-u">${escapeHtml(sel.unit)}</span>${hrInMilesBase}` +
          `</span>` +
          `<span class="ds-card-penalty-effective ds-conv-result" title="${escapeHtml(collapsedTip)}">` +
            `${fmtN(resultEff, sel.unit)} <span class="ds-conv-u">${escapeHtml(sel.unit)}</span>${hrInMilesEff}` +
          `</span>` +
        `</span>`;
    } else {
      resultHtml = `<span class="ds-conv-result">${fmtN(resultEff, sel.unit)} <span class="ds-conv-u">${escapeHtml(sel.unit)}</span>${hrInMilesEff}</span>`;
    }

    // Context line showing which value the math uses. Kept even when
    // the result itself shows the breakdown, because it communicates
    // the per-second source value that all the multipliers come from.
    const unitTxt = def.unit || 'ft/sec';
    const baseFmt = fmtN(b, 'ft');
    const effFmt  = fmtN(e, 'ft');
    let ctxLine;
    if (hasPenalty) {
      ctxLine = `<span class="ds-conv-ctx-k">Using effective</span> <span class="ds-conv-ctx-v">${effFmt} ${escapeHtml(unitTxt)}</span><span class="ds-conv-ctx-sub"> (base ${baseFmt} − ${penaltyPct}% Penalty)</span>`;
    } else {
      ctxLine = `<span class="ds-conv-ctx-k">Using</span> <span class="ds-conv-ctx-v">${effFmt} ${escapeHtml(unitTxt)}</span><span class="ds-conv-ctx-sub"> (no Penalty applied)</span>`;
    }

    // Dropdown options — labels include a quick preview of the EFFECTIVE
    // result so a skim of the menu answers all seven at once.
    const optionsHtml = order.map(key => {
      const u = units[key];
      const previewVal = e * u.mult;
      const preview = `${fmtN(previewVal, u.unit)} ${u.unit}`;
      return `<option value="${key}"${key === choice ? ' selected' : ''}>${u.label} — ${preview}</option>`;
    }).join('');

    return `<div class="ds-card-conv-panel" aria-label="Speed conversions">
      <div class="ds-conv-ctx">${ctxLine}</div>
      <div class="ds-conv-picker">
        <select class="ds-conv-select" onchange="setSpeedConversionChoice('${escapeHtml(def.code)}', this.value)">
          ${optionsHtml}
        </select>
        <span class="ds-conv-eq">=</span>
        ${resultHtml}
      </div>
    </div>`;
  }

  // Dice modifier editor panel — lives inside an expanded card. Shows the
  // total dice the player rolls (base + all mods − Penalty) at the top, then
  // the list of mods with name/value/delete, then an add button.
  // Stat-edit panel — shows up when a stat card is expanded via its
  // dice pill (click on "Xd"). Renders three sections in order:
  //
  //   1. Dice Modifiers — named +/− bonuses to the dice POOL (all
  //      rollable stats). Always shown; this is the original panel.
  //
  //   2. Value Modifiers — named flat bonuses to the stat's VALUE
  //      (e.g. SPD +2 "Running Shoes"). Shown only when def.allowValueMods.
  //
  //   3. Penalty Sources — per-source whitelist for which Strain
  //      contributors affect THIS stat's Penalty %. Missing filter
  //      object = legacy behavior (all sources apply). Shown only
  //      when def.allowPenaltyFilter.
  //
  // Sections 2 and 3 read their state from the live charData so
  // changes persist through renders. Handlers are below: addValueMod,
  // updateValueMod, deleteValueMod, togglePenaltyFilterSource,
  // togglePenaltyFilterOther, setPenaltyFilterMode.
  function renderStatEditPanel(def, baseValue, diceMods, diceModTotal, penaltyInfo, valueMods, valueModTotal) {
    const code = def.code;
    const mods = Array.isArray(diceMods) ? diceMods : [];
    const vMods = Array.isArray(valueMods) ? valueMods : [];
    const base = Number.isFinite(baseValue) ? baseValue : 0;
    const modTotal = diceModTotal || 0;
    const si = penaltyInfo || { isPassive: false, penaltyDice: 0, finalDice: base + modTotal, penaltyPercent: 0 };

    let html = '<div class="ds-rollmod-panel">';

    // ── Section 1: Dice summary + Dice Modifiers ──
    //
    // Summary line: the final dice count with a compact breakdown.
    //   "Rolling 12d   = 10 base + 2 bonus"
    //   "Rolling 8d    = 10 base + 2 bonus − 4 penalty (50%)"
    //   "Rolling 10d   = 10 base  (passive — Penalty doesn't apply)"
    //
    // Non-rollable stats (SPD, SPR, etc.) skip the dice summary
    // and dice-mod list entirely — those sections only make sense
    // for stats you actually roll.
    const isRollable = def.rollable !== false;
    if (isRollable) {
      const breakdownParts = [`${base} base`];
      if (modTotal !== 0) breakdownParts.push(`${modTotal >= 0 ? '+' : '−'} ${Math.abs(modTotal)} bonus`);
      if (si.penaltyDice > 0) breakdownParts.push(`− ${si.penaltyDice} penalty (${si.penaltyPercent}%)`);
      const passiveNote = si.isPassive && si.penaltyPercent > 0
        ? '<span class="ds-dm-passive-note"> · passive roll · Penalty does not apply</span>'
        : '';
      html += `<div class="ds-dicemod-summary">
        <span class="ds-dm-summary-label">Rolling</span>
        <span class="ds-dm-summary-value">${si.finalDice}d</span>
        <span class="ds-dm-summary-breakdown">= ${breakdownParts.join(' ')}${passiveNote}</span>
      </div>`;

      html += `<div class="ds-edit-section-head">Dice Modifiers</div>`;
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
    }

    // ── Section 2: Value Modifiers ──
    //
    // Named flat bonuses to the stat's raw value. Shown for stats
    // that opt in via def.allowValueMods. Layout parallels dice
    // mods — name + signed value + delete.
    if (def.allowValueMods === true) {
      const unitLabel = def.unit ? ` ${def.unit}` : '';
      const totalDisplay = valueModTotal !== 0
        ? ` <span class="ds-edit-section-total">(${valueModTotal >= 0 ? '+' : ''}${valueModTotal}${unitLabel} total)</span>`
        : '';
      html += `<div class="ds-edit-section-head">Value Modifiers${totalDisplay}</div>`;
      if (vMods.length === 0) {
        html += `<div class="mod-empty">No value modifiers. Add flat bonuses like "Running Shoes: +2" to your ${escapeHtml(def.name)}.</div>`;
      } else {
        html += '<div class="mod-list">';
        vMods.forEach((mod, idx) => {
          html += `<div class="mod-item">
            <input type="text" class="mod-name-input" value="${escapeHtml(mod.name || '')}" placeholder="e.g. Running Shoes"
                   onchange="updateValueMod('${escapeHtml(code)}',${idx},'name',this.value)">
            <input type="number" class="mod-val-input" value="${mod.value || 0}" step="${def.keepDecimals ? 'any' : '1'}"
                   onchange="updateValueMod('${escapeHtml(code)}',${idx},'value',this.value)"
                   title="Flat value bonus (negative = penalty)">
            <span class="mod-delete" onclick="deleteValueMod('${escapeHtml(code)}',${idx})" title="Delete">×</span>
          </div>`;
        });
        html += '</div>';
      }
      html += `<div class="mod-add-row"><button class="mod-add-btn" onclick="addValueMod('${escapeHtml(code)}')">+ Add value mod</button></div>`;
    }

    // ── Section 3: Penalty Sources ──
    //
    // Per-source whitelist. Controls which Strain contributors
    // (Pain, Stress, Encumbrance, individual Other entries) affect
    // THIS stat's Penalty %. Missing filter object on the character
    // = legacy behavior (all sources apply). Clicking a checkbox
    // materializes the filter object if it didn't exist, seeded to
    // match current behavior (everything on); unchecking then
    // removes that source's contribution to this stat.
    if (def.allowPenaltyFilter === true) {
      const charData = ctx.getCharData();
      // Backfill ids on any legacy otherModifiers that predate the
      // filter feature. Side effect — saves if anything changed.
      ensureOtherModIds(charData);
      const filters = (charData && charData.penaltyFilters && typeof charData.penaltyFilters === 'object')
        ? charData.penaltyFilters : null;
      const thisFilter = (filters && filters[code] && typeof filters[code] === 'object')
        ? filters[code] : null;
      // "No filter set" = legacy-apply-all. Display that explicitly so
      // the player knows what state they're in. One click on any
      // checkbox will switch to the filtered mode.
      const hasFilter = !!thisFilter;
      const headState = hasFilter ? 'Filtered' : 'Default (all sources apply)';
      html += `<div class="ds-edit-section-head">Penalty Sources <span class="ds-edit-section-state">${escapeHtml(headState)}</span></div>`;

      // Helper to render a single source checkbox row. When hasFilter
      // is false, every box renders checked (that's the legacy
      // behavior being displayed). Clicking any of them initializes
      // the filter object, defaulting to the current "all true" state,
      // then toggles the clicked box off.
      const otherMods = Array.isArray(charData && charData.otherModifiers) ? charData.otherModifiers : [];
      const srcRow = (key, label) => {
        const checked = hasFilter ? (thisFilter[key] === true) : true;
        return `<label class="ds-edit-filter-row">
          <input type="checkbox"${checked ? ' checked' : ''}
                 onchange="togglePenaltyFilterSource('${escapeHtml(code)}','${key}',this.checked)">
          <span class="ds-edit-filter-label">${escapeHtml(label)}</span>
          <span class="ds-edit-filter-hint">${escapeHtml(key === 'pain' ? 'from damage' : key === 'stress' ? 'from SAN loss' : 'from load')}</span>
        </label>`;
      };
      html += '<div class="ds-edit-filter-list">';
      html += srcRow('pain', 'Pain');
      html += srcRow('stress', 'Stress');
      html += srcRow('encumbrance', 'Encumbrance');
      // Individual Other entries — each gets its own checkbox so the
      // GM can say "only the Wounded Leg from Other affects SPD,
      // ignore the Drugged one."
      if (otherMods.length > 0) {
        html += '<div class="ds-edit-filter-other-head">Other:</div>';
        otherMods.forEach(m => {
          if (!m || !m.id) return;
          const otherFilter = hasFilter ? (thisFilter.other && typeof thisFilter.other === 'object' ? thisFilter.other : null) : null;
          const checked = hasFilter ? (otherFilter && otherFilter[m.id] === true) : true;
          const name = m.name || '(unnamed)';
          const val = parseInt(m.value) || 0;
          const valStr = (val >= 0 ? '+' : '') + val + '%';
          html += `<label class="ds-edit-filter-row ds-edit-filter-other">
            <input type="checkbox"${checked ? ' checked' : ''}
                   onchange="togglePenaltyFilterOther('${escapeHtml(code)}','${escapeHtml(m.id)}',this.checked)">
            <span class="ds-edit-filter-label">${escapeHtml(name)}</span>
            <span class="ds-edit-filter-hint">${escapeHtml(valStr)}</span>
          </label>`;
        });
      }
      html += '</div>';
      if (hasFilter) {
        html += `<div class="mod-add-row"><button class="mod-add-btn" onclick="clearPenaltyFilter('${escapeHtml(code)}')">Reset to default (all sources)</button></div>`;
      }
    }

    html += '</div>';
    return html;
  }

  // Legacy alias — kept in case external modules or future code
  // reach for the old name. Delegates to the new unified panel
  // with empty value-mod args.
  function renderDiceModPanel(code, baseValue, diceMods, diceModTotal, penaltyInfo) {
    // Synthesize a minimal def so the panel only renders the dice
    // section (allowValueMods / allowPenaltyFilter absent). Used by
    // nothing currently — left for defensive compatibility.
    const def = { code, rollable: true, name: code };
    return renderStatEditPanel(def, baseValue, diceMods, diceModTotal, penaltyInfo, [], 0);
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

  // ─── VALUE MOD HANDLERS ───
  //
  // Value modifiers are named flat bonuses to a stat's displayed
  // value (e.g. "Running Shoes: +2" on SPD). Storage mirrors dice
  // modifiers but on charData.valueMods. Each entry: {id, name, value}.
  // Handlers mirror addDiceMod / updateDiceMod / deleteDiceMod.

  async function addValueMod(code) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.valueMods || typeof charData.valueMods !== 'object') {
      charData.valueMods = {};
    }
    if (!Array.isArray(charData.valueMods[code])) charData.valueMods[code] = [];
    charData.valueMods[code].push({
      id: 'vm_' + Math.random().toString(36).slice(2, 10),
      name: '',
      value: 1
    });
    expandedDiceMods.add(code);
    await saveCharacter(ctx.getCharId(), { valueMods: charData.valueMods });
    renderAll();
  }

  async function updateValueMod(code, idx, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const list = charData.valueMods && charData.valueMods[code];
    if (!Array.isArray(list) || !list[idx]) return;
    if (field === 'name') {
      list[idx].name = typeof val === 'string' ? val : '';
    } else if (field === 'value') {
      // Value mods accept floats for keepDecimals stats (like SPD).
      // parseFloat covers both integer and decimal inputs.
      const n = parseFloat(val);
      list[idx].value = Number.isFinite(n) ? n : 0;
    }
    await saveCharacter(ctx.getCharId(), { valueMods: charData.valueMods });
    renderAll();
  }

  async function deleteValueMod(code, idx) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const list = charData.valueMods && charData.valueMods[code];
    if (!Array.isArray(list) || !list[idx]) return;
    list.splice(idx, 1);
    if (list.length === 0) delete charData.valueMods[code];
    await saveCharacter(ctx.getCharId(), { valueMods: charData.valueMods });
    renderAll();
  }

  // ─── PENALTY FILTER HANDLERS ───
  //
  // The filter object is created LAZILY on first edit. Until the
  // player clicks a checkbox, charData.penaltyFilters[code] doesn't
  // exist and the stat uses legacy "all sources apply" behavior.
  //
  // When a box is first toggled, we materialize the filter seeded
  // with the CURRENT "everything on" state, then flip just the
  // clicked box. This preserves the visible state from the player's
  // perspective — they uncheck one source, everything else stays on.
  //
  // Helper: seed a fresh filter object from the live charData's
  // other-modifiers so the "Other" sub-map starts complete.
  function seedFilterObject(charData) {
    const otherMods = Array.isArray(charData && charData.otherModifiers) ? charData.otherModifiers : [];
    const otherMap = {};
    otherMods.forEach(m => { if (m && m.id) otherMap[m.id] = true; });
    return { pain: true, stress: true, encumbrance: true, other: otherMap };
  }

  // Backfill `id` on any legacy otherModifiers that predate the
  // penalty-filter feature. Without this, legacy mods silently fail
  // both filter lookup AND the rendered checkbox list (my filter
  // code skips any mod without an id). Fires lazily — the first
  // time the panel opens on a character with legacy data — and
  // persists the new ids so the fixup only runs once.
  //
  // Also extends any existing penalty filters so the newly-idd
  // mods are marked "applied" (matching the legacy-behavior
  // assumption that every source contributed).
  function ensureOtherModIds(charData) {
    if (!charData || !Array.isArray(charData.otherModifiers)) return;
    let changed = false;
    charData.otherModifiers.forEach(m => {
      if (m && typeof m === 'object' && !m.id) {
        m.id = 'om_' + Math.random().toString(36).slice(2, 10);
        changed = true;
        // Extend existing filters so the legacy mod is still
        // "applied" under whitelist semantics. If this is the
        // first time the user has ever opened a penalty filter
        // panel, charData.penaltyFilters is absent and this is
        // a no-op.
        extendFiltersWithOtherId(charData, m.id, true);
      }
    });
    if (changed) {
      const updates = { otherModifiers: charData.otherModifiers };
      if (charData.penaltyFilters) updates.penaltyFilters = charData.penaltyFilters;
      // Fire and forget — don't block the render on the save.
      saveCharacter(ctx.getCharId(), updates).catch(e => console.error('otherMod backfill save failed', e));
    }
  }

  async function togglePenaltyFilterSource(code, sourceKey, checked) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.penaltyFilters || typeof charData.penaltyFilters !== 'object') {
      charData.penaltyFilters = {};
    }
    if (!charData.penaltyFilters[code] || typeof charData.penaltyFilters[code] !== 'object') {
      // First edit — materialize from current legacy state so only
      // the clicked box appears to change.
      charData.penaltyFilters[code] = seedFilterObject(charData);
    }
    charData.penaltyFilters[code][sourceKey] = !!checked;
    await saveCharacter(ctx.getCharId(), { penaltyFilters: charData.penaltyFilters });
    renderAll();
  }

  async function togglePenaltyFilterOther(code, otherId, checked) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.penaltyFilters || typeof charData.penaltyFilters !== 'object') {
      charData.penaltyFilters = {};
    }
    if (!charData.penaltyFilters[code] || typeof charData.penaltyFilters[code] !== 'object') {
      charData.penaltyFilters[code] = seedFilterObject(charData);
    }
    if (!charData.penaltyFilters[code].other || typeof charData.penaltyFilters[code].other !== 'object') {
      charData.penaltyFilters[code].other = {};
    }
    charData.penaltyFilters[code].other[otherId] = !!checked;
    await saveCharacter(ctx.getCharId(), { penaltyFilters: charData.penaltyFilters });
    renderAll();
  }

  async function clearPenaltyFilter(code) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.penaltyFilters || typeof charData.penaltyFilters !== 'object') return;
    delete charData.penaltyFilters[code];
    // Purge the object entirely if empty so the saved shape stays
    // minimal (no stale `penaltyFilters: {}` field).
    if (Object.keys(charData.penaltyFilters).length === 0) {
      delete charData.penaltyFilters;
      await saveCharacter(ctx.getCharId(), { penaltyFilters: null });
    } else {
      await saveCharacter(ctx.getCharId(), { penaltyFilters: charData.penaltyFilters });
    }
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
    const penalty = result.penalty || { percent: 0 };
    return renderStrainPill({
      id: 'pain',
      label: 'Pain',
      data: pain,
      penalty,
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
    const penalty = result.penalty || { percent: 0 };
    const sanMax = (result.san && result.san.max) || 0;
    return renderStrainPill({
      id: 'stress',
      label: 'Stress',
      data: stress,
      penalty,
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
      id, label, data, penalty, expanded, canEdit,
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
    tipParts.push(`Penalty total: ${penalty.percent}%`);
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
      html += `<div class="strain-panel-total">Total: ${finalPct}% → contributes to Penalty (${penalty.percent}% overall)</div>`;
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

  // ─── COMBAT TRACKER ───
  //
  // Personal per-character action-economy tracker. Matches the rule:
  // Fast Action / SPR / Reaction penalties persist until that character's
  // next turn (handled by the Start My Turn reset button).
  //
  // State lives on charData.combatTracker:
  //   round:              Int   — display-only round number
  //   collapsed:          Bool  — widget collapsed state (per-character)
  //   autoApplyPenalty:   Bool  — when false, tracker doesn't inject
  //                               Other Mods (display-only mode)
  //   actionsUsed:        Int   — 0 or N (increments for each action)
  //   actionsGranted:     Int   — base 1, +1 per Chain cash-in
  //   fastActions:        Int   — count taken this turn-window
  //   sprIncrements:      Int   — count of +SPR increments this round
  //   movementUsed:       Num   — feet spent this round
  //   reactionsTaken:     Int   — count taken since my last turn
  //
  // Missing field → all zeros, autoApplyPenalty=true, collapsed=false.
  // Zero migration risk.
  //
  // Penalty injection: two entries maintained in charData.otherModifiers
  // with { source: 'tracker', trackerKey: <key> } flags so they can be
  // found and auto-managed without interfering with user-authored
  // entries.
  //
  //   Combat: Fast Actions → 25% × max(0, fastActions − AGL)
  //   Combat: Sprint       → 25% × sprIncrements

  // Get the live tracker state object, creating defaults as needed.
  // Never writes to charData — callers that mutate must persist.
  function getTrackerState() {
    const charData = ctx.getCharData();
    if (!charData) return null;
    const t = charData.combatTracker;
    if (t && typeof t === 'object') return t;
    // Lazy-init the default shape. Caller decides whether to save.
    return {
      round: 1,
      collapsed: false,
      autoApplyPenalty: true,
      actionsUsed: 0,
      actionsGranted: 1,
      fastActions: 0,
      fastReactions: 0,
      sprIncrements: 0,
      movementUsed: 0,
      reactionsTaken: 0
    };
  }

  function ensureTrackerState(charData) {
    if (!charData.combatTracker || typeof charData.combatTracker !== 'object') {
      charData.combatTracker = {
        round: 1,
        collapsed: false,
        autoApplyPenalty: true,
        actionsUsed: 0,
        actionsGranted: 1,
        fastActions: 0,
        fastReactions: 0,
        sprIncrements: 0,
        movementUsed: 0,
        reactionsTaken: 0
      };
    }
    return charData.combatTracker;
  }

  // Read AGL from the live derived stats — drives Fast Action free
  // allotment and the Reaction "free" cap. Falls back to 0 if the stat
  // doesn't exist or the character has zero in it.
  //
  // Computes derived stats fresh rather than reaching through ctx
  // (the ctx doesn't expose this) — the render cycle already calls
  // computeDerivedStats multiple times per frame, so the cost is
  // negligible and there's no stale-state risk.
  function getTrackerAgility() {
    const charData = ctx.getCharData();
    const ruleset  = ctx.getRuleset();
    if (!charData || !ruleset) return 0;
    try {
      const result = computeDerivedStats(charData, ruleset);
      // stats is a Map<statCode, entry>. Entry carries .value and
      // handles formula evaluation — no base-stats lookup needed.
      const agl = result && result.stats && result.stats.get
        ? result.stats.get('AGL')
        : null;
      if (!agl || !Number.isFinite(agl.value)) return 0;
      return Math.max(0, Math.floor(agl.value));
    } catch (e) {
      return 0;
    }
  }

  // Compute the Penalty % that the tracker currently contributes, split
  // into per-key values. Each action-economy source gets its OWN AGL
  // "free" pool — so AGL 2 grants 2 free Fast Actions AND 2 free Fast
  // Reactions AND 2 free Reactions (separate stacking), not 2 free
  // across-the-board. Sprint doesn't interact with AGL.
  function computeTrackerPenalty(state, agility) {
    const fastFree = Math.max(0, agility);
    const fastBilled = Math.max(0, (state.fastActions || 0) - fastFree);
    const fastReactBilled = Math.max(0, (state.fastReactions || 0) - fastFree);
    return {
      fastActions:   fastBilled * 25,
      fastReactions: fastReactBilled * 25,
      sprint:        (state.sprIncrements || 0) * 25
    };
  }

  // Sync the tracker's two managed otherModifiers entries to reflect
  // current state. Mutates charData.otherModifiers; does NOT save.
  // Returns true if anything changed (so caller knows to persist).
  //
  // Rules:
  //   - autoApplyPenalty: false → both entries removed (display-only mode)
  //   - fastActions/sprint contribution = 0 → that entry removed
  //   - entry otherwise exists with the right value
  //   - entries carry { source: 'tracker', trackerKey: 'fastActions'|'sprint' }
  function syncTrackerOtherMods(charData) {
    if (!charData) return false;
    if (!Array.isArray(charData.otherModifiers)) charData.otherModifiers = [];
    const state = ensureTrackerState(charData);
    const agility = getTrackerAgility();
    const pen = computeTrackerPenalty(state, agility);
    const desired = [];
    if (state.autoApplyPenalty !== false) {
      if (pen.fastActions   > 0) desired.push({ key: 'fastActions',   name: 'Combat: Fast Actions',   value: pen.fastActions });
      if (pen.fastReactions > 0) desired.push({ key: 'fastReactions', name: 'Combat: Fast Reactions', value: pen.fastReactions });
      if (pen.sprint        > 0) desired.push({ key: 'sprint',        name: 'Combat: Sprint',         value: pen.sprint });
    }

    let changed = false;
    // Index existing tracker entries by trackerKey for fast lookup.
    const existing = new Map();
    charData.otherModifiers.forEach((m, i) => {
      if (m && m.source === 'tracker' && typeof m.trackerKey === 'string') {
        existing.set(m.trackerKey, { mod: m, index: i });
      }
    });
    // Update-or-insert desired entries.
    desired.forEach(d => {
      const found = existing.get(d.key);
      if (found) {
        if (found.mod.value !== d.value || found.mod.name !== d.name) {
          found.mod.value = d.value;
          found.mod.name  = d.name;
          changed = true;
        }
        existing.delete(d.key);
      } else {
        const newId = 'om_' + Math.random().toString(36).slice(2, 10);
        charData.otherModifiers.push({
          id: newId,
          name: d.name,
          value: d.value,
          source: 'tracker',
          trackerKey: d.key
        });
        // New entry — extend active per-stat penalty filters so the
        // new contribution is "applied" under whitelist semantics by
        // default. BUT: the Sprint penalty should never hit SPD or
        // SPR themselves (you don't get a movement Penalty for...
        // moving fast). For Sprint specifically, we seed SPD/SPR
        // filters with this id set to FALSE so the contribution is
        // explicitly excluded. If SPD/SPR don't have a filter object
        // yet, materialize one via seedFilterObject so the exclusion
        // sticks (whitelist mode must be active on the stat for
        // per-source filtering to work).
        if (d.key === 'sprint') {
          extendFiltersWithOtherIdExcludingStats(charData, newId, true, ['SPD', 'SPR']);
        } else {
          extendFiltersWithOtherId(charData, newId, true);
        }
        changed = true;
      }
    });
    // Remove any tracker-managed entries we no longer want.
    existing.forEach(({ mod, index }) => {
      // Re-locate by id since the array may have shifted during the
      // desired-insert phase.
      const realIdx = charData.otherModifiers.findIndex(m => m === mod);
      if (realIdx >= 0) {
        if (mod.id) purgeOtherIdFromFilters(charData, mod.id);
        charData.otherModifiers.splice(realIdx, 1);
        changed = true;
      }
    });
    return changed;
  }

  // ─── OTHER MODIFIERS (part of Penalty) ───
  //
  // Named ±% entries that contribute to Penalty alongside Pain and Stress.
  // Examples: Exposure, Encumbrance, drugged, restrained, sleep-deprived.
  // Values can be negative to model buffs that offset existing Penalty.
  // Editor lives inline in the Penalty card; these handlers are bound to
  // window by the combat.html glue.

  async function addOtherMod() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.otherModifiers)) charData.otherModifiers = [];
    const newId = 'om_' + Math.random().toString(36).slice(2, 10);
    charData.otherModifiers.push({ id: newId, name: '', value: 0 });
    // Auto-extend any existing penalty filters so the new Other mod
    // is "applied" by default where filtering is active. Without this,
    // whitelist semantics hide the new entry from stats that already
    // have a filter object — counter-intuitive ("why doesn't this
    // 25% apply?"). Missing filters are untouched (stats still in
    // legacy mode stay there).
    const changedFilters = extendFiltersWithOtherId(charData, newId, true);
    const updates = { otherModifiers: charData.otherModifiers };
    if (changedFilters) updates.penaltyFilters = charData.penaltyFilters;
    await saveCharacter(ctx.getCharId(), updates);
    renderAll();
  }
  async function updateOtherMod(idx, field, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.otherModifiers) || !charData.otherModifiers[idx]) return;
    // Tracker-sourced entries are owned by the Combat Tracker widget
    // — editing them here would immediately be overwritten by the
    // next syncTrackerOtherMods pass anyway. Reject silently.
    if (charData.otherModifiers[idx].source === 'tracker') return;
    if (field === 'name') charData.otherModifiers[idx].name = typeof val === 'string' ? val : '';
    else if (field === 'value') charData.otherModifiers[idx].value = parseInt(val) || 0;
    await saveCharacter(ctx.getCharId(), { otherModifiers: charData.otherModifiers });
    renderAll();
  }
  async function deleteOtherMod(idx) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.otherModifiers) || !charData.otherModifiers[idx]) return;
    // Block deletes on tracker-owned entries — user should use
    // the tracker's Start My Turn / counter buttons to clear them.
    // Re-adding manually would desync.
    if (charData.otherModifiers[idx].source === 'tracker') return;
    const removed = charData.otherModifiers[idx];
    charData.otherModifiers.splice(idx, 1);
    // Clean up any per-stat filter entries that referenced this
    // otherMod's id. Avoids dangling filter keys in saved data.
    const changedFilters = (removed && removed.id)
      ? purgeOtherIdFromFilters(charData, removed.id)
      : false;
    const updates = { otherModifiers: charData.otherModifiers };
    if (changedFilters) updates.penaltyFilters = charData.penaltyFilters;
    await saveCharacter(ctx.getCharId(), updates);
    renderAll();
  }

  // Mutate charData.penaltyFilters so every stat with an active
  // filter object gets `filter.other[otherId] = applied` set. Returns
  // true if any changes were made. Does NOT create new filter
  // objects — only extends ones that already exist.
  function extendFiltersWithOtherId(charData, otherId, applied) {
    const filters = charData.penaltyFilters;
    if (!filters || typeof filters !== 'object') return false;
    let changed = false;
    Object.keys(filters).forEach(statCode => {
      const f = filters[statCode];
      if (!f || typeof f !== 'object') return;
      if (!f.other || typeof f.other !== 'object') f.other = {};
      if (f.other[otherId] !== applied) {
        f.other[otherId] = applied;
        changed = true;
      }
    });
    return changed;
  }

  // Same as extendFiltersWithOtherId but with an explicit exclusion
  // list. Stats in `excludeStats` get `filter.other[otherId] = false`
  // regardless of other logic, and their filter objects are MATERIALIZED
  // (seeded from current state) if they didn't exist yet. This is the
  // hook for auto-exclusions like "Sprint penalty doesn't apply to
  // Movement" — we proactively seed SPD/SPR filters with the new
  // Sprint mod marked false so the penalty never leaks into their
  // computation.
  //
  // Non-excluded stats that already have filter objects still get
  // the new id marked applied=true (same as plain extend).
  function extendFiltersWithOtherIdExcludingStats(charData, otherId, applied, excludeStats) {
    if (!charData.penaltyFilters || typeof charData.penaltyFilters !== 'object') {
      charData.penaltyFilters = {};
    }
    const filters = charData.penaltyFilters;
    const excludeSet = new Set(excludeStats || []);
    let changed = false;
    // First: materialize + mark false for every exclusion target.
    excludeSet.forEach(statCode => {
      if (!filters[statCode] || typeof filters[statCode] !== 'object') {
        filters[statCode] = seedFilterObject(charData);
        changed = true;
      }
      if (!filters[statCode].other || typeof filters[statCode].other !== 'object') {
        filters[statCode].other = {};
        changed = true;
      }
      if (filters[statCode].other[otherId] !== false) {
        filters[statCode].other[otherId] = false;
        changed = true;
      }
    });
    // Second: mark applied on any OTHER stat that already has a filter
    // (normal extend behavior).
    Object.keys(filters).forEach(statCode => {
      if (excludeSet.has(statCode)) return;
      const f = filters[statCode];
      if (!f || typeof f !== 'object') return;
      if (!f.other || typeof f.other !== 'object') f.other = {};
      if (f.other[otherId] !== applied) {
        f.other[otherId] = applied;
        changed = true;
      }
    });
    return changed;
  }

  // Strip otherId from every stat's filter.other sub-map. Called
  // after an Other mod is deleted so the saved shape stays clean.
  function purgeOtherIdFromFilters(charData, otherId) {
    const filters = charData.penaltyFilters;
    if (!filters || typeof filters !== 'object') return false;
    let changed = false;
    Object.keys(filters).forEach(statCode => {
      const f = filters[statCode];
      if (!f || !f.other || typeof f.other !== 'object') return;
      if (otherId in f.other) {
        delete f.other[otherId];
        changed = true;
      }
    });
    return changed;
  }

  // ─── COMBAT TRACKER HANDLERS ───
  //
  // Each mutation sets the field on charData.combatTracker, runs
  // syncTrackerOtherMods if the field affects Penalty, and saves
  // both combatTracker + (if changed) otherModifiers. The handlers
  // are bound to window via character.html.

  async function trackerPersist(charData) {
    const updates = { combatTracker: charData.combatTracker };
    // Always persist otherModifiers alongside since sync may have
    // mutated them. Filters too in case extendFiltersWithOtherId
    // fired on a new entry.
    updates.otherModifiers = charData.otherModifiers;
    if (charData.penaltyFilters) updates.penaltyFilters = charData.penaltyFilters;
    await saveCharacter(ctx.getCharId(), updates);
  }

  // Generic counter adjust — clamps to zero, supports +1/-1 from
  // buttons. Auto-syncs Penalty when the affected counter drives it.
  async function trackerAdjust(field, delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    const next = Math.max(0, (state[field] || 0) + delta);
    if (next === (state[field] || 0)) return;
    state[field] = next;
    // Fields that drive the Penalty injection — any change needs to
    // re-sync the tracker-sourced Other Mod entries.
    if (field === 'fastActions' || field === 'fastReactions' || field === 'sprIncrements') {
      syncTrackerOtherMods(charData);
    }
    await trackerPersist(charData);
    renderAll();
  }

  async function trackerSet(field, value) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    const n = parseFloat(value);
    // Per-field minimum. Round is the only counter that can't drop
    // below 1 (a "Round 0" doesn't make sense — combat starts at 1).
    // Everything else clamps to 0.
    const minValue = (field === 'round') ? 1 : 0;
    const next = Number.isFinite(n) ? Math.max(minValue, n) : minValue;
    if (next === state[field]) return;
    state[field] = next;
    if (field === 'fastActions' || field === 'fastReactions' || field === 'sprIncrements') {
      syncTrackerOtherMods(charData);
    }
    await trackerPersist(charData);
    renderAll();
  }

  // Start My Turn — clears Round-level counters + reactions. Leaves
  // round number, collapsed, autoApplyPenalty alone. Purges the
  // tracker's Other Mod entries (both keys) by syncing after reset.
  async function trackerStartMyTurn() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    state.actionsUsed = 0;
    state.actionsGranted = 1;
    state.fastActions = 0;
    state.fastReactions = 0;
    state.sprIncrements = 0;
    state.movementUsed = 0;
    state.reactionsTaken = 0;
    syncTrackerOtherMods(charData);
    await trackerPersist(charData);
    renderAll();
  }

  // Next Round — increments round display only. Per the design,
  // Penalty and counters stay until Start My Turn fires. The round
  // number is purely for player awareness / synchronization with
  // the GM at the table.
  async function trackerNextRound() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    state.round = (state.round || 1) + 1;
    await trackerPersist(charData);
    renderAll();
  }

  // Reset Round — drops the round counter back to 1 without touching
  // any other counters. For combat start/end: "new fight starts, round
  // 1 again." Doesn't reset per-turn counters (use Start My Turn for
  // that) or the Penalty toggle. Deliberately a separate button from
  // Start My Turn so clearing the round display doesn't nuke
  // mid-combat state.
  async function trackerResetRound() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    if ((state.round || 1) === 1) return;
    state.round = 1;
    await trackerPersist(charData);
    renderAll();
  }

  // Chain Fast Actions → +1 Action. Costs 4 fastActions tokens and
  // grants 1 extra action for this turn. Tracker surfaces the button
  // when fastActions >= 4; the count-down syncs Penalty downward
  // too (since we billed based on the stacked count, spending 4
  // reduces the Fast Action penalty contribution).
  async function trackerChainActions() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    if ((state.fastActions || 0) < 4) return;
    state.fastActions -= 4;
    state.actionsGranted = (state.actionsGranted || 1) + 1;
    syncTrackerOtherMods(charData);
    await trackerPersist(charData);
    renderAll();
  }

  async function trackerToggleAutoApply() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    state.autoApplyPenalty = state.autoApplyPenalty === false ? true : false;
    // Flipping the toggle changes which Other Mod entries should exist.
    syncTrackerOtherMods(charData);
    await trackerPersist(charData);
    renderAll();
  }

  async function trackerToggleCollapse() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    state.collapsed = !state.collapsed;
    await trackerPersist(charData);
    renderAll();
  }

  // Movement step interval — feet-based. Called by the ft dropdown
  // and the custom ft input. Clamps to 0.1 minimum so users can't
  // get stuck at 0. Setting this value also implicitly deselects any
  // seconds preset since the conversion is one-way; the ft value is
  // the source of truth.
  async function trackerSetMovementIntervalFt(value) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) return;
    const next = Math.max(0.1, Math.round(n * 10) / 10);
    if (next === state.movementIntervalFt) return;
    state.movementIntervalFt = next;
    await trackerPersist(charData);
    renderAll();
  }

  // Movement step interval — seconds-based. Converts via current SPD.
  // If SPD is 0 (incapacitated), no-op — the user should fix the
  // underlying stat first, not pretend to move.
  async function trackerSetMovementIntervalSec(value) {
    if (!ctx.getCanEdit()) return;
    if (value == null || value === '') return;
    const sec = parseFloat(value);
    if (!Number.isFinite(sec) || sec <= 0) return;
    const charData = ctx.getCharData();
    const ruleset  = ctx.getRuleset();
    try {
      const r = computeDerivedStats(charData, ruleset);
      const spd = r && r.stats && r.stats.get && r.stats.get('SPD');
      const spdVal = (spd && Number.isFinite(spd.value)) ? spd.value : 0;
      if (spdVal <= 0) return;
      const ft = Math.round(spdVal * sec * 10) / 10;
      const state = ensureTrackerState(charData);
      if (ft === state.movementIntervalFt) return;
      state.movementIntervalFt = ft;
      await trackerPersist(charData);
      renderAll();
    } catch (e) {
      // computeDerivedStats failed — leave state alone
    }
  }

  // Step movement by the current interval × direction. `direction` is
  // +1 or -1. Uses the persisted movementIntervalFt (defaulting to 5
  // if unset for backward-compat with characters saved before this
  // feature). Clamps movementUsed at 0 minimum; no cap on the upper
  // end — users may exceed budget intentionally to flag overextension.
  async function trackerMovementStep(direction) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const state = ensureTrackerState(charData);
    const interval = (state.movementIntervalFt != null && Number.isFinite(parseFloat(state.movementIntervalFt)))
      ? parseFloat(state.movementIntervalFt)
      : 5;
    const delta = direction * interval;
    const next = Math.max(0, (state.movementUsed || 0) + delta);
    if (next === state.movementUsed) return;
    state.movementUsed = Math.round(next * 10) / 10;
    await trackerPersist(charData);
    renderAll();
  }

  // ─── COMBAT TRACKER (UI) ───
  //
  // Widget grid below Roll Calc. Seven tiles arranged in a responsive
  // row; wraps on narrow viewports. Each tile is self-contained —
  // handlers call trackerAdjust / trackerSet / trackerStartMyTurn /
  // trackerNextRound / trackerChainActions / trackerToggleAutoApply.
  //
  // Tile order (left to right, reading order):
  //   1. Round         — display + "Next Round" button
  //   2. Turn          — "Start My Turn" reset button
  //   3. Action        — used / granted, with Chain 4-FA button when ready
  //   4. Fast Actions  — ± counter, shows free (AGL) vs billed
  //   5. SPR           — ± counter, shows penalty contribution
  //   6. Movement      — budget readout + ± 5ft + text input + Spend SPR
  //   7. Reactions     — ± counter + pending Difficulty badge
  //
  // Collapsed state lives on charData.combatTracker.collapsed so it
  // persists per-character across reloads.
  function renderCombatTrackerSection(result) {
    const charData = ctx.getCharData();
    if (!charData) return '';
    const state = getTrackerState();
    if (!state) return '';
    const canEdit = ctx.getCanEdit();
    const agility = getTrackerAgility();

    // SPD / SPR — read from derived stats for the Movement tile.
    // Values include current Penalty-adjusted effective values, so the
    // budget respects status effects automatically.
    const spd = result && result.stats && result.stats.get && result.stats.get('SPD');
    const spr = result && result.stats && result.stats.get && result.stats.get('SPR');
    const spdBase  = (spd && Number.isFinite(spd.value)) ? spd.value : 0;
    const sprBase  = (spr && Number.isFinite(spr.value)) ? spr.value : 0;
    // Round-long movement budget. PRIME round is ~6 seconds → six
    // seconds of SPD ft/sec. Each SPR increment sprints for the full
    // round too, adding sprBase × 6 feet (not sprBase × 1 — sprinting
    // for only one second of the round would be a strange way to
    // commit to sprinting). This matches the flavor: SPR is "ft/sec
    // added to your movement rate for the round" not "a one-second
    // burst". Example: SPD 5 + SPR 3 + 1 sprint increment → (5+3)×6
    // = 48 ft budget, which is 5×6=30 base + 3×6=18 from sprint.
    const movementBudget = Math.round((spdBase * 6 + (state.sprIncrements || 0) * sprBase * 6) * 10) / 10;
    const movementUsed   = state.movementUsed || 0;
    const movementLeft   = Math.max(0, movementBudget - movementUsed);

    // Penalty contributions this tile actively shows.
    const trackerPen = computeTrackerPenalty(state, agility);
    const fastFree  = Math.max(0, agility - (state.fastActions || 0));
    const fastBilled = Math.max(0, (state.fastActions || 0) - agility);

    // Reaction pending difficulty — reactions past AGL incur a
    // stacking +1 Difficulty per additional reaction. Tracker
    // exposes the computed value; Roll Calc reads it (not yet
    // implemented in Roll Calc itself — that's a follow-up).
    const reactionsFree = Math.max(0, agility);
    const pendingReactionDiff = Math.max(0, (state.reactionsTaken || 0) - reactionsFree);

    // Chain gating — show the "Chain 4 → +1 Action" button when the
    // player has stacked enough Fast Actions.
    const canChain = (state.fastActions || 0) >= 4;

    // Section header: collapsible title + settings toggle for
    // autoApplyPenalty. Matches Roll Calc's section chrome.
    const collapsed = !!state.collapsed;
    const caret = collapsed ? '▸' : '▾';
    const autoPenOn = state.autoApplyPenalty !== false;
    const autoPenLabel = autoPenOn ? 'Penalty: LIVE' : 'Penalty: off';
    const autoPenTip = autoPenOn
      ? 'Click to disable: tracker will stop injecting Fast-Action / Sprint entries into Penalty (display only).'
      : 'Click to enable: tracker will actively inject Fast-Action / Sprint Penalty entries.';

    // Section header — caret + title on the left, round control cluster
    // + Start My Turn + Penalty toggle on the right. Round and Turn
    // are bookkeeping so they live in the header rather than
    // consuming a tile each in the body grid.
    const roundValHead = state.round || 1;
    const showResetRoundHead = roundValHead > 1;
    let head = `<div class="combat-tracker-head">
      <button class="combat-tracker-caret" onclick="trackerToggleCollapse()" type="button" title="${collapsed ? 'Expand' : 'Collapse'} tracker">
        <span class="combat-tracker-caret-icon">${caret}</span>
        <span class="combat-tracker-title">Combat Tracker</span>
      </button>
      <div class="combat-tracker-head-controls">
        ${canEdit ? `
          <div class="combat-tracker-head-round" title="Round number. Informational — purely a counter for table-wide sync.">
            <span class="combat-tracker-head-round-label">Round</span>
            <input type="number" class="combat-tracker-head-round-input" value="${roundValHead}" min="1" step="1"
                   onchange="trackerSet('round', this.value)" onfocus="this.select()"
                   title="Click to set round number directly">
            <button class="combat-tracker-head-btn" onclick="trackerNextRound()" type="button" title="Advance round counter (doesn't reset per-turn counters).">+1</button>
            ${showResetRoundHead ? `<button class="combat-tracker-head-btn" onclick="trackerResetRound()" type="button" title="Reset round counter to 1.">Reset</button>` : ''}
          </div>
          <button class="combat-tracker-head-turn" onclick="trackerStartMyTurn()" type="button" title="Resets Action, Fast Actions, Fast Reactions, SPR, Movement, Follow/Fall-back, Reactions. Clears tracker-injected Penalty.">Start My Turn</button>
          <button class="combat-tracker-autopen ${autoPenOn ? 'on' : 'off'}" onclick="trackerToggleAutoApply()" title="${escapeHtml(autoPenTip)}" type="button">${autoPenLabel}</button>
        ` : `
          <div class="combat-tracker-head-round"><span class="combat-tracker-head-round-label">Round</span><span class="combat-tracker-head-round-readonly">${roundValHead}</span></div>
        `}
      </div>
    </div>`;

    if (collapsed) {
      // Collapsed form shows a compact summary line so the player can
      // glance at the key numbers without expanding. Only non-zero
      // counters appear, to keep the line short in the common case.
      const summaryBits = [];
      summaryBits.push(`Round ${state.round || 1}`);
      if ((state.actionsUsed || 0) > 0 || (state.actionsGranted || 1) > 1) {
        summaryBits.push(`Action ${state.actionsUsed || 0}/${state.actionsGranted || 1}`);
      }
      if ((state.fastActions || 0) > 0)             summaryBits.push(`${state.fastActions} FA`);
      if ((state.fastReactions || 0) > 0)           summaryBits.push(`${state.fastReactions} FR`);
      if ((state.sprIncrements || 0) > 0)           summaryBits.push(`${state.sprIncrements} SPR`);
      if (movementUsed > 0)                          summaryBits.push(`${movementUsed}/${movementBudget}ft`);
      if ((state.reactionsTaken || 0) > 0)          summaryBits.push(`${state.reactionsTaken} react`);
      return `<div class="combat-section combat-section-tracker">
        ${head}
        <div class="combat-tracker-summary">${summaryBits.join(' · ')}</div>
      </div>`;
    }

    // ─ Expanded body — grouped tile layout ─
    //
    // Three sections:
    //   "On your turn"         — Action, Fast Actions, Movement
    //   "Off your turn"        — Reactions, Fast Reactions, Follow/Fall-back
    //   "On or off your turn"  — Sprint
    //
    // Round counter and Start My Turn button moved up into the header
    // bar (they're bookkeeping, not really per-turn state). Each
    // group gets its own row; tiles within a row use the same
    // responsive grid.
    const btn = canEdit ? '' : ' disabled';

    // Editable big-number helper. Renders an <input> styled to look
    // like the big value display — click to focus, type to edit,
    // blur/Enter commits via trackerSet. Read-only when !canEdit.
    const editableBig = (field, value, extraClass) => {
      const roOnly = canEdit ? '' : ' readonly';
      return `<input type="number" class="ct-tile-value-edit${extraClass ? ' ' + extraClass : ''}"
             value="${value}" min="0" step="1"
             onchange="trackerSet('${field}', this.value)"
             onfocus="this.select()"
             title="Click to edit directly"${roOnly}>`;
    };

    // ── Action tile (On your turn) ──
    const actionTile = `
      <div class="ct-tile ct-tile-action" title="Main actions — attacks, abilities, big interactions. Chain 4 Fast Actions to earn an extra.">
        <div class="ct-tile-label">Action</div>
        <div class="ct-tile-value">
          ${editableBig('actionsUsed', state.actionsUsed || 0)}
          <span class="ct-tile-denom">/${state.actionsGranted || 1}</span>
        </div>
        <div class="ct-tile-controls">
          <button class="ct-btn" onclick="trackerAdjust('actionsUsed', -1)" type="button"${btn} title="Undo an action">−</button>
          <button class="ct-btn" onclick="trackerAdjust('actionsUsed', 1)" type="button"${btn} title="Use an action">+</button>
        </div>
        ${canChain ? `<div class="ct-tile-extra"><button class="ct-btn ct-btn-accent ct-btn-wide" onclick="trackerChainActions()" type="button"${btn} title="Spend 4 Fast Actions to grant +1 Action this turn.">Chain 4 FA → +1 Action</button></div>` : ''}
      </div>`;

    // ── Fast Actions tile (On your turn) ──
    const fastTile = `
      <div class="ct-tile ct-tile-fastactions" title="Quick actions — draw a weapon, chamber a shell, open a door. First ${agility} are free (via AGL ${agility}). Each additional adds 25% Penalty until Start My Turn.">
        <div class="ct-tile-label">Fast Actions</div>
        <div class="ct-tile-value">
          ${editableBig('fastActions', state.fastActions || 0)}
        </div>
        <div class="ct-tile-controls">
          <button class="ct-btn" onclick="trackerAdjust('fastActions', -1)" type="button"${btn}>−</button>
          <button class="ct-btn" onclick="trackerAdjust('fastActions', 1)" type="button"${btn}>+</button>
        </div>
        <div class="ct-tile-hint">
          ${
            fastFree > 0
              ? `${fastFree} free left (AGL)`
              : fastBilled > 0
                ? `<span class="ct-tile-penalty">${trackerPen.fastActions}% Penalty</span>`
                : `next is +25% Penalty`
          }
        </div>
      </div>`;

    // ── Movement tile helper ──
    //
    // Movement is ONE pool: the same `movementUsed` counter regardless
    // of whether the movement happened on-turn or off-turn. The tile
    // is rendered TWICE — once in "On your turn" (titled "Movement")
    // and once in "Off your turn" (titled "Follow / Fall-back") — so
    // the widget is reachable in both phases of the round. Both
    // instances display identical state and identical controls;
    // mutating either updates both. The `variant` arg only changes
    // the tile's title and tooltip wording.
    //
    // Interval state (movementIntervalFt) is also shared — a step
    // preset picked in one instance applies to the other because
    // it's a single user preference.
    const sprPerIncrementFt = Math.round(sprBase * 6 * 10) / 10;
    const intervalFt = (state.movementIntervalFt != null && Number.isFinite(parseFloat(state.movementIntervalFt)))
      ? Math.max(0.1, parseFloat(state.movementIntervalFt))
      : 5;
    const intervalDisplay = Number.isInteger(intervalFt) ? String(intervalFt) : intervalFt.toFixed(1);
    const ftPresets = [1, 5, 10, 25];
    if (!ftPresets.includes(intervalFt) && intervalFt > 0) ftPresets.push(intervalFt);
    ftPresets.sort((a, b) => a - b);
    const ftOptions = ftPresets
      .map(v => `<option value="${v}"${v === intervalFt ? ' selected' : ''}>${v} ft</option>`)
      .join('');
    const secondsPresets = [
      { label: '1s', sec: 1 },
      { label: '2s', sec: 2 },
      { label: '3s', sec: 3 },
      { label: '6s (full round)', sec: 6 }
    ];
    const secondsOptions = secondsPresets.map(p => {
      const ft = Math.round(spdBase * p.sec * 10) / 10;
      const isActive = Math.abs(ft - intervalFt) < 0.05 && spdBase > 0;
      return `<option value="${p.sec}"${isActive ? ' selected' : ''}>${p.label} (${ft} ft)</option>`;
    }).join('');

    const renderMovementTile = (variant) => {
      // variant: 'onTurn' | 'offTurn' — only affects title/tooltip
      const title = variant === 'offTurn' ? 'Follow / Fall-back' : 'Movement';
      const variantTip = variant === 'offTurn'
        ? `Off-turn movement (Follow / Fall-back). THIS IS THE SAME COUNTER as on-turn Movement — off-turn movement just refers to when you use it, not a separate budget. Base SPD × 6s = ${Math.round(spdBase * 6 * 10) / 10} ft. Each SPR increment adds ${sprPerIncrementFt} ft.`
        : `On-turn movement. Base SPD × 6s = ${Math.round(spdBase * 6 * 10) / 10} ft. Each SPR increment adds ${sprPerIncrementFt} ft (SPR ${sprBase} ft/sec × 6s). The same counter is shown in the Off-your-turn group as Follow / Fall-back — off-turn movement draws from this same pool.`;
      const extraClass = variant === 'offTurn' ? 'ct-tile-followfallback' : 'ct-tile-movement';
      return `
      <div class="ct-tile ${extraClass} ct-tile-wide" title="${escapeHtml(variantTip)}">
        <div class="ct-tile-label">${title}</div>
        <div class="ct-tile-value">
          ${editableBig('movementUsed', movementUsed)}
          <span class="ct-tile-denom">/ ${movementBudget}</span>
          <span class="ct-tile-unit">ft</span>
        </div>
        <div class="ct-tile-controls">
          <button class="ct-btn" onclick="trackerMovementStep(-1)" type="button"${btn} title="Subtract one interval of Movement (currently ${intervalDisplay} ft)">−${intervalDisplay}</button>
          <button class="ct-btn" onclick="trackerMovementStep(1)" type="button"${btn} title="Add one interval of Movement (currently ${intervalDisplay} ft)">+${intervalDisplay}</button>
        </div>
        <div class="ct-tile-interval">
          <span class="ct-interval-label">Step:</span>
          <select class="ct-interval-select" onchange="trackerSetMovementIntervalFt(this.value)"${canEdit ? '' : ' disabled'} title="Set the interval in feet">
            ${ftOptions}
          </select>
          <select class="ct-interval-select" onchange="trackerSetMovementIntervalSec(this.value)"${canEdit ? '' : ' disabled'} title="Set the interval in seconds (× current SPD ${spdBase} ft/sec)">
            <option value="">or by seconds…</option>
            ${secondsOptions}
          </select>
          <input type="number" class="ct-interval-custom" min="0.1" step="0.1" value="${intervalFt}"
                 onchange="trackerSetMovementIntervalFt(this.value)"
                 title="Custom ft interval"${canEdit ? '' : ' readonly'}>
          <span class="ct-interval-unit">ft</span>
        </div>
        <div class="ct-tile-hint">
          ${movementLeft > 0 ? `${movementLeft} ft remaining` : `at budget — tap SPR to extend`}
          <button class="ct-btn ct-btn-tight" onclick="trackerAdjust('sprIncrements', 1)" type="button"${btn} title="Spend +1 SPR: extends the Movement budget by ${sprPerIncrementFt} ft and adds 25% Penalty.">+SPR</button>
        </div>
      </div>`;
    };
    const movementTile = renderMovementTile('onTurn');
    const followFallbackTile = renderMovementTile('offTurn');

    // ── Reactions tile (Off your turn) ──
    //
    // Reactions (Dodge/Defend/Counter/Clash) have their own AGL free
    // pool, separate from Fast Actions and Fast Reactions. Stacking
    // Difficulty kicks in past AGL — NOT a Penalty source.
    const reactTile = `
      <div class="ct-tile ct-tile-reactions" title="Reactions taken since your last turn. First ${reactionsFree} are free (via AGL). Each beyond that adds +1 Difficulty to the NEXT Reaction you take.">
        <div class="ct-tile-label">Reactions</div>
        <div class="ct-tile-value">
          ${editableBig('reactionsTaken', state.reactionsTaken || 0)}
        </div>
        <div class="ct-tile-controls">
          <button class="ct-btn" onclick="trackerAdjust('reactionsTaken', -1)" type="button"${btn}>−</button>
          <button class="ct-btn" onclick="trackerAdjust('reactionsTaken', 1)" type="button"${btn}>+</button>
        </div>
        <div class="ct-tile-hint">
          ${
            pendingReactionDiff > 0
              ? `<span class="ct-tile-penalty">Next: +${pendingReactionDiff} Difficulty</span>`
              : (state.reactionsTaken || 0) < agility
                ? `${agility - (state.reactionsTaken || 0)} free left`
                : `next is +1 Difficulty`
          }
        </div>
      </div>`;

    // ── Fast Reactions tile (Off your turn) ──
    //
    // Fast Reactions = Fast Actions performed as Reactions (contesting,
    // quick-draws out of turn, etc). Same 25% Penalty per use past the
    // AGL free pool, but AGL is INDEPENDENT from Fast Actions and
    // Reactions — AGL 2 means 2 free FA + 2 free FR + 2 free Reactions.
    const fastReactFree = Math.max(0, agility - (state.fastReactions || 0));
    const fastReactBilled = Math.max(0, (state.fastReactions || 0) - agility);
    const fastReactTile = `
      <div class="ct-tile ct-tile-fastreactions" title="Fast Actions performed as Reactions — contesting a door close, quick-drawing during someone else's turn, etc. First ${agility} are free (via AGL ${agility}, independent from Fast Actions). Each additional adds 25% Penalty until Start My Turn.">
        <div class="ct-tile-label">Fast Reactions</div>
        <div class="ct-tile-value">
          ${editableBig('fastReactions', state.fastReactions || 0)}
        </div>
        <div class="ct-tile-controls">
          <button class="ct-btn" onclick="trackerAdjust('fastReactions', -1)" type="button"${btn}>−</button>
          <button class="ct-btn" onclick="trackerAdjust('fastReactions', 1)" type="button"${btn}>+</button>
        </div>
        <div class="ct-tile-hint">
          ${
            fastReactFree > 0
              ? `${fastReactFree} free left (AGL)`
              : fastReactBilled > 0
                ? `<span class="ct-tile-penalty">${trackerPen.fastReactions}% Penalty</span>`
                : `next is +25% Penalty`
          }
        </div>
      </div>`;

    // ── Sprint tile (On or off your turn) ──
    const sprTile = `
      <div class="ct-tile ct-tile-spr" title="Each SPR increment adds ${sprPerIncrementFt} ft to your Movement budget this round (SPR ${sprBase} ft/sec × 6s) and 25% Penalty on physical actions (not Movement itself) until Start My Turn. Can be tapped on or off your turn.">
        <div class="ct-tile-label">Sprint</div>
        <div class="ct-tile-value">
          ${editableBig('sprIncrements', state.sprIncrements || 0)}
        </div>
        <div class="ct-tile-controls">
          <button class="ct-btn" onclick="trackerAdjust('sprIncrements', -1)" type="button"${btn}>−</button>
          <button class="ct-btn" onclick="trackerAdjust('sprIncrements', 1)" type="button"${btn}>+</button>
        </div>
        <div class="ct-tile-hint">
          ${(state.sprIncrements || 0) > 0 ? `<span class="ct-tile-penalty">${trackerPen.sprint}% Penalty</span>` : `+${sprPerIncrementFt} ft/increment`}
        </div>
      </div>`;

    // Assemble the three groups. Each group has its own subheader and
    // its own grid so tiles within a group sit together but groups
    // read as distinct phases of the round.
    //
    // Movement budget readout lives in the group HEADERS for both
    // "On your turn" and "Off your turn" since the SAME Movement
    // counter is reachable from either group's tile. Showing the
    // readout in both heads reinforces the shared-pool concept —
    // same number in both places because it's literally one value.
    const budgetOver = movementUsed > movementBudget;
    const budgetClass = budgetOver ? 'combat-tracker-group-budget over' : 'combat-tracker-group-budget';
    const budgetTitle = `Movement budget. Base SPD × 6s = ${Math.round(spdBase * 6 * 10) / 10} ft${(state.sprIncrements || 0) > 0 ? `, extended by ${(state.sprIncrements || 0) * sprPerIncrementFt} ft from ${state.sprIncrements} Sprint increment${(state.sprIncrements || 0) === 1 ? '' : 's'}` : ''}.`;
    const budgetBadge = `<span class="${budgetClass}" title="${escapeHtml(budgetTitle)}">Movement: ${movementUsed} / ${movementBudget} ft${budgetOver ? ' ⚠' : ''}</span>`;

    const body = `
      <div class="combat-tracker-group">
        <div class="combat-tracker-group-head">
          <span class="combat-tracker-group-title">On your turn</span>
          ${budgetBadge}
        </div>
        <div class="combat-tracker-grid">
          ${actionTile}
          ${fastTile}
          ${movementTile}
        </div>
      </div>
      <div class="combat-tracker-group">
        <div class="combat-tracker-group-head">
          <span class="combat-tracker-group-title">Off your turn</span>
          ${budgetBadge}
        </div>
        <div class="combat-tracker-grid">
          ${reactTile}
          ${fastReactTile}
          ${followFallbackTile}
        </div>
      </div>
      <div class="combat-tracker-group">
        <div class="combat-tracker-group-head">
          <span class="combat-tracker-group-title">On or off your turn</span>
        </div>
        <div class="combat-tracker-grid">
          ${sprTile}
        </div>
      </div>
    `;

    return `<div class="combat-section combat-section-tracker">
      ${head}
      ${body}
    </div>`;
  }

  // ─── EXHAUSTION BAR (Combat tab) ───
  //
  // Vertical fill-bar widget that sits adjacent to the Hit Locations
  // list. Mirrors the three-tier palette of the Overview tile but in
  // a tall, narrow format so it reads as a "reservoir" during play.
  //
  // Widget layout (top to bottom):
  //   Label          "Exhaustion"
  //   Big number     current / max
  //   Vertical bar   segments fill from the bottom; damage chews from top
  //   Status pill    Ready / Tired / Exhausted / Unconscious
  //   ± buttons      quick adjust for manual damage
  //
  // The bar itself visualizes damage via color bands on each segment,
  // just like HP hit locations and the SAN pool tile do. Because EXH
  // can go deeply negative (-2×max), the bar has THREE zones mapped
  // to three color tiers: "positive" (ready), "0 to -max" (tired),
  // "-max to -2×max" (exhausted).
  //
  // ± buttons write to `charData.exhDamage` (scalar manual damage),
  // parallel to how SAN's manual damage field works. Structured
  // damages (named entries with level modifiers) are a Turn-2
  // feature — for now the widget just provides the simplest
  // adjustment affordance.
  function renderExhBar(exh) {
    if (!exh || exh.max <= 0) return '';
    const canEdit = ctx.getCanEdit();
    const tierMap = {
      ready:        { label: 'Ready',        cls: 'e-ready' },
      tired:        { label: 'Tired',        cls: 'e-tired' },
      exhausted:    { label: 'Exhausted',    cls: 'e-exhausted' },
      unconscious:  { label: 'Unconscious',  cls: 'e-unconscious' }
    };
    const tier = tierMap[exh.status] || tierMap.ready;

    // Segment count: one segment per EXH point, capped at a sane max.
    // Small characters (EXH 3) get 3 segments; large characters (EXH 12)
    // get 12. Bar height scales with the HL list naturally.
    const segCount = Math.max(1, Math.min(exh.max, 20));
    // Damage chews from the TOP downward. Negative current values mean
    // "past zero" — the bar renders empty, and the tier changes to
    // Tired/Exhausted to communicate the severity. At knockout, whole
    // bar is red-shaded.
    const segHtml = renderExhBarSegments(exh.max, exh.damage, segCount);

    // ± buttons. Each click adjusts the manual damage by 1 up or down.
    // trackerAdjust-style: goes through exhAdjust which saves + re-renders.
    // Disabled when the character sheet is read-only.
    const btn = canEdit ? '' : ' disabled';

    return `
      <div class="exh-bar-widget" title="Exhaustion — stamina pool. Spend to Exert on rolls, or take damage from exertion/exposure. At −2× max you fall Unconscious.">
        <div class="exh-bar-label">Exhaustion</div>
        <div class="exh-bar-nums">
          <span class="exh-bar-current">${exh.current}</span>
          <span class="exh-bar-sep">/</span>
          <span class="exh-bar-max">${exh.max}</span>
        </div>
        <div class="exh-bar-fill">${segHtml}</div>
        <div class="exh-bar-status ${tier.cls}">${escapeHtml(tier.label)}</div>
        <div class="exh-bar-controls">
          <button class="exh-bar-btn" onclick="exhAdjust(-1)" type="button"${btn} title="Heal 1 EXH (regain stamina)">−</button>
          <button class="exh-bar-btn" onclick="exhAdjust(1)" type="button"${btn} title="Damage 1 EXH (spend / exert)">+</button>
        </div>
      </div>`;
  }

  function renderExhBarSegments(exhMax, damage, segCount) {
    // Vertical bar — top-to-bottom rendering order puts segment 1 at
    // the TOP. Damage chews from the top (so the bar "empties" from
    // above, like a liquid draining). Color palette matches the
    // Overview tile: green → yellow → orange → red as damage deepens
    // past max thresholds.
    const COLORS = { green: '#4a8a4a', yellow: '#bdb247', orange: '#c87a3a', red: '#a63a3a', empty: '#1a1a18' };
    const dmgPerSeg = exhMax / segCount;
    let html = '';
    for (let i = 1; i <= segCount; i++) {
      // i=1 is the TOPMOST segment. It represents the HIGHEST point
      // of the pool, so it empties first. When total damage reaches
      // i × dmgPerSeg, this segment is "eaten". Past that, the
      // color bands show how deep into negative you are.
      const topBoundary = i * dmgPerSeg;
      let color;
      if (damage >= topBoundary + 2 * exhMax)      color = COLORS.red;      // past -2×max — unconscious zone
      else if (damage >= topBoundary + exhMax)     color = COLORS.orange;   // past -max — exhausted zone
      else if (damage >= topBoundary)              color = COLORS.yellow;   // past 0 — tired zone
      else                                          color = COLORS.green;    // still in positive — ready zone
      // Empty look for segments that are depleted (damage ate this
      // segment in the positive zone). Render with a slightly darker
      // fill so the eaten-vs-remaining distinction is visible even
      // when the whole bar has shifted yellow/orange for status.
      const isEaten = damage >= topBoundary && color === COLORS.green;
      const fillColor = isEaten ? COLORS.empty : color;
      html += `<span class="exh-bar-seg" style="background:${fillColor}"></span>`;
    }
    return html;
  }

  // EXH adjust handler — called from the ± buttons on the Combat-tab
  // bar widget. Mutates charData.exhDamage additively, clamps at 0 to
  // prevent negative damage (which would mean "above max EXH" — use
  // exhModifiers for bonus caps instead). Upper end is NOT clamped
  // because going past max is the whole point of the mechanic.
  async function exhAdjust(delta) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const cur = Math.max(0, Number.isFinite(charData.exhDamage) ? charData.exhDamage : 0);
    const next = Math.max(0, cur + delta);
    if (next === cur) return;
    charData.exhDamage = next;
    await saveCharacter(ctx.getCharId(), { exhDamage: next });
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

    // Build the body HTML (everything that goes INSIDE the section);
    // wrapCollapsibleSection handles the outer wrapper + caret head.

    let body_html = '';

    // Cards from the 'health' derived stat group, rendered at the top of the
    // section as an overview strip. These are ALSO filtered OUT of the normal
    // derived stats grid (renderDerivedStatsSection) so they don't appear twice.
    //
    // EXH is ALSO filtered out here — it has its own dedicated vertical-bar
    // widget rendered inline with the Hit Locations list below, so showing
    // it as a compact stat card at the top would be redundant.
    const healthStats = [];
    result.stats.forEach(entry => {
      if (entry.def.group === 'health' && entry.def.code !== 'EXH') healthStats.push(entry);
    });
    if (healthStats.length > 0) {
      body_html += '<div class="ds-grid health-cards">';
      healthStats.forEach(entry => { body_html += renderDsCard(entry); });
      body_html += '</div>';
    }

    // "Hit Locations" sub-header with the Edit Modifiers button. Acts as the
    // divider between the cards overview and the location bars below.
    body_html += '<div class="combat-subsection-head">';
    body_html += '<div class="combat-subsection-title">Hit Locations</div>';
    if (canEdit) {
      body_html += `<button class="hl-edit-btn${editModifiersMode ? ' active' : ''}" onclick="toggleHlModifierEdit()">` +
              `${editModifiersMode ? 'Done' : 'Edit Modifiers'}</button>`;
    }
    body_html += '</div>';

    // Hit Locations + EXH rail. Side-by-side layout:
    //   [ EXH vertical bar ]  [ Hit Location rows ]
    // EXH is thematically physical (third pillar alongside HP/SAN) so it
    // lives adjacent to the body diagram — players can see at a glance
    // "how wrecked am I bodily, AND how much is left in the tank."
    // The EXH rail is only rendered if the character actually has an
    // EXH pool (exh.max > 0); otherwise the HL list goes full-width.
    const exhBarHtml = (result.exh && result.exh.max > 0) ? renderExhBar(result.exh) : '';
    body_html += '<div class="hl-row-wrap">';
    if (exhBarHtml) body_html += exhBarHtml;
    body_html += '<div class="hl-list">';
    result.locations.forEach(loc => { body_html += renderHlRow(loc, body); });
    body_html += '</div>';
    body_html += '</div>';

    // Body total goes at the bottom, summarizing the overall state after
    // you've read through the individual locations above.
    body_html += renderBodyBlock(body);

    // Pain indicator — percent of Body missing, editable modifiers. Sits
    // between Body (which shows physical damage) and Injuries (detailed
    // wound list), conceptually linking "how hurt you are" to "what hurts".
    body_html += renderPainPill(result);

    // Injuries manager — a collapsible list of wounds with degradation tracking.
    body_html += renderInjuriesSection(result);

    // Wrap with collapsible shell. Key is stable across re-renders;
    // click routes to window.combatToggleCollapse (defined in
    // character.html) which toggles the flag and re-invokes renderAll.
    // Title reads from the ruleset's 'health' group label so a renamed
    // group propagates (e.g. "Physical", "Body", "Vitality").
    const healthGroup = (ruleset.derivedStatGroups || []).find(g => g.code === 'health');
    const healthTitle = (healthGroup && healthGroup.label) ? healthGroup.label : 'Health';
    return wrapCollapsibleSection(
      'prime.collapse.combat.health',
      `<span class="combat-section-title-text">${escapeHtml(healthTitle)}</span>`,
      body_html,
      { wrapperClass: 'combat-section', collapsibleClass: 'combat-section-title', rerenderHandler: 'combatToggleCollapse' }
    );
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
        <div class="body-bar-bg">${segHtml}</div>`;

    // Description block (player-overridable). Same ruleset source as
    // the Overview Body tile — tileDescriptions.body. Renders below
    // the segmented bar so it doesn't crowd the numeric row. Wrapped
    // in an explicit combat-body-desc class for scoped CSS.
    if (ctx.renderDescriptionDisplay) {
      html += ctx.renderDescriptionDisplay('tiles', 'body', { wrapperClass: 'combat-section-desc' });
    }

    html += `</div>`;

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

    // Build the section body (everything below the title). The Edit
    // Modifiers button goes INSIDE the collapsible header so players
    // can still reach it, but clicks on it stop propagation so they
    // don't also collapse the section.
    let body_html = '';

    // Sanity stat card at the top — shows name, code, formula, value, and
    // description. Gives the player a clear reminder of what SAN is and
    // what they roll for mental resistances.
    const sanEntry = result.stats.get('SAN');
    if (sanEntry) {
      body_html += '<div class="ds-grid san-card-wrap">';
      body_html += renderDsCard(sanEntry);
      body_html += '</div>';
    }

    // Status line: SAN label, current/max, colored status pill.
    const statusClass = 'san-status-' + san.status;
    body_html += '<div class="san-top-row">';
    body_html += '<span class="san-label">SAN</span>';
    body_html += `<span class="san-nums"><span class="san-current">${san.current}</span><span class="san-slash"> / </span><span class="san-max">${san.max}</span></span>`;
    body_html += `<span class="san-status-pill ${statusClass}">${escapeHtml(san.statusLabel)}</span>`;
    body_html += '</div>';

    // Penalty text — empty when Healthy, printed in italic otherwise.
    if (san.penaltyText) {
      body_html += `<div class="san-penalty">${escapeHtml(san.penaltyText)}</div>`;
    }

    // Segmented bar.
    body_html += '<div class="san-bar">';
    body_html += renderSanSegments(san.max, san.damage, segCount);
    body_html += '</div>';

    // Description block (player-overridable). Mirrors the Overview
    // Sanity tile — pulls from ruleset.tileDescriptions.sanity, with
    // optional per-character override via the descriptions module.
    if (ctx.renderDescriptionDisplay) {
      body_html += ctx.renderDescriptionDisplay('tiles', 'sanity', { wrapperClass: 'combat-section-desc' });
    }

    // Damage controls (input shows effective current; +/- tick damage).
    if (canEdit) {
      const damageCap = Math.max(san.max * 5, 10);
      body_html += `<div class="san-controls">
        <button class="hl-dmg-btn" onclick="tickSanDmg(1)" title="Take 1 Mental Damage">−</button>
        <input type="number" class="san-dmg-input" value="${san.current}" min="${-damageCap}" max="${san.max}"
               onchange="setSanCurrent(this.value)"
               title="Current SAN (type to set directly)">
        <button class="hl-dmg-btn" onclick="tickSanDmg(-1)" title="Heal 1 SAN">+</button>
      </div>`;
    } else {
      body_html += `<div class="san-controls san-controls-ro"><span class="san-current-ro">${san.current} / ${san.max}</span></div>`;
    }

    // Edit modifiers panel — same shape as Body modifier panel.
    if (editSanModifiersMode && canEdit) {
      body_html += renderSanModifierPanel(san);
    }

    // Stress indicator — percent of SAN's full range (max → -2×max) that's
    // been used up. Editable percentile modifiers, parallels Pain pill in
    // the Health section. Combines with Pain to form Strain, which reduces
    // dice pools on non-passive active rolls.
    body_html += renderStressPill(result);

    // Damages manager — simplified Injuries for mental health.
    body_html += renderSanDamagesSection(result);

    // Breaking Point reference — shown whenever Broken. This is guidance,
    // not automation. GM rolls d10 per PRIME rules and applies the result.
    if (san.status === 'broken') {
      body_html += renderBreakingPointPanel();
    }

    // Head: title + the Edit Modifiers button (event.stopPropagation
    // on the button prevents its click from also collapsing the section).
    // Title reads from the ruleset's 'mental' group label so a renamed
    // group propagates (e.g. "Sanity", "Mental", "Psyche").
    const ruleset = ctx.getRuleset();
    const mentalGroup = (ruleset.derivedStatGroups || []).find(g => g.code === 'mental');
    const sanTitle = (mentalGroup && mentalGroup.label) ? mentalGroup.label : 'Sanity';
    let head_html = `<span class="combat-section-title-text">${escapeHtml(sanTitle)}</span>`;
    if (canEdit) {
      head_html += `<button class="hl-edit-btn${editSanModifiersMode ? ' active' : ''}" onclick="event.stopPropagation();toggleSanModifierEdit()">` +
                   `${editSanModifiersMode ? 'Done' : 'Edit Modifiers'}</button>`;
    }

    return wrapCollapsibleSection(
      'prime.collapse.combat.sanity',
      head_html,
      body_html,
      { wrapperClass: 'combat-section san-section', collapsibleClass: 'combat-section-title combat-section-head', rerenderHandler: 'combatToggleCollapse' }
    );
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
    // Card value modifiers (flat bonuses on SPD/SPR-style stats)
    addValueMod, updateValueMod, deleteValueMod,
    // Per-stat penalty source filter (whitelist; toggling materializes)
    togglePenaltyFilterSource, togglePenaltyFilterOther, clearPenaltyFilter,
    // Penalty value-display toggle (click to collapse "10 − 2.5" to "7.5")
    togglePenaltyValueDisplay,
    // Speed conversions panel toggle (⇅ caret on SPD/SPDUP cards)
    toggleSpeedConversions,
    setSpeedConversionChoice,
    // Roll Calculator — delegated to char-rollcalc.js module. These are
    // thin proxies so the existing window.rollCalc* wirings in
    // character.html keep working without needing to know the module split.
    rollCalcSetSlotKind:    rollcalc.setSlotKind,
    rollCalcSetSlotStat:    rollcalc.setSlotStat,
    rollCalcSetSlotSkill:   rollcalc.setSlotSkill,
    rollCalcSetSlotDerived: rollcalc.setSlotDerived,
    rollCalcSetSlotValue:   rollcalc.setSlotValue,
    rollCalcSetStatmod:     rollcalc.setStatmod,
    rollCalcSetDifficulty:  rollcalc.setDifficulty,
    rollCalcApplyReactionDifficulty: rollcalc.applyReactionDifficulty,
    rollCalcSetMitigation:  rollcalc.setMitigation,
    rollCalcSetReduction:   rollcalc.setReduction,
    rollCalcToggle:         rollcalc.toggleShowRaw,
    rollCalcSetPassive:     rollcalc.setPassive,
    // Weapon → Roll Calc bridge. Called by char-inventory's weapon
    // readout when the user clicks "→ Roll Calc" on an attack or
    // damage block. Fills the calc's slot 0 with the resolved dice
    // pool (as a 'custom' override) and statmodOverride with the
    // resolved flat bonus, clearing slots 1/2. See char-rollcalc.js
    // for the full loadout semantics.
    rollCalcLoadWeapon:     rollcalc.loadWeaponRoll,
    // Overview tile collapse — click handler on state-tile headers
    overviewToggleTile:     (slug) => overview.toggleTile(slug),
    // Per-roll Penalty component toggles
    rollCalcTogglePenalty:      rollcalc.togglePenaltyComponent,
    rollCalcTogglePenaltyPanel: rollcalc.togglePenaltyPanel,
    rollCalcResetPenalty:       rollcalc.resetPenaltyToggles,
    // Pain / Stress (percentile modifiers feeding Penalty via Pain and Stress components)
    togglePainPanel, addPainMod, updatePainMod, deletePainMod,
    toggleStressPanel, addStressMod, updateStressMod, deleteStressMod,
    // Other modifiers (free-form ±% entries like Exposure, Encumbrance)
    addOtherMod, updateOtherMod, deleteOtherMod,
    // Exhaustion (EXH) — Combat-tab vertical bar widget
    exhAdjust,
    // Combat Tracker (action economy tracker — per-character round state)
    trackerAdjust, trackerSet, trackerStartMyTurn, trackerNextRound,
    trackerResetRound, trackerChainActions,
    trackerToggleAutoApply, trackerToggleCollapse,
    trackerSetMovementIntervalFt, trackerSetMovementIntervalSec, trackerMovementStep,
    // Afflictions tile (Conditions / Circumstances tracker on Overview tab)
    condOpenAdd:       conditionsSection.openAdd,
    condStartCustom:   conditionsSection.startCustom,
    condPickPreset:    conditionsSection.pickPreset,
    condSaveCustom:    conditionsSection.saveCustom,
    condOpenEdit:      conditionsSection.openEdit,
    condSaveEdit:      conditionsSection.saveEdit,
    condPromote:       conditionsSection.promote,
    condDraft:         conditionsSection.draft,
    condCloseModal:    conditionsSection.closeModal,
    condSwapCategory:  conditionsSection.swapCategory,
    condRemove:        conditionsSection.remove,
    condToggleEntry:   conditionsSection.toggleEntry
  };
}
