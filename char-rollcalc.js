// char-rollcalc.js
//
// Roll Calculator — the quick "how many dice will I actually roll?" scratch
// pad that lives at the top of the Combat tab. Split out of char-combat.js
// so that file can focus on the actual combat UI (health, injuries, sanity,
// power, etc.) instead of also carrying the dice-math helper.
//
// This module is self-contained:
//   • owns its own UI state (rollCalcState) — persisted in memory only
//   • renders its own tile
//   • handles all its own input events via targeted DOM repaints
//   • has zero knowledge of other combat UI
//
// It talks to the rest of the app through a small ctx object:
//   ctx.getRuleset()      → current ruleset (stats, derivedStats, skills)
//   ctx.getCharData()     → current character (stats, skills, etc.)
//   ctx.computeDerivedStats(charData, ruleset) → live Strain %, stat mods
//   ctx.escapeHtml(s)     → HTML-escape helper (shared with combat)
//   ctx.fmt(n)            → number formatter (trims trailing zeroes)
//
// Changing a stat/skill dropdown triggers an internal re-render of just
// this tile — no external renderAll() call needed. Typing into number
// inputs does a tighter repaint that leaves input focus intact.

import { computeDerivedStats as defaultCompute } from './char-derived.js';

export function createRollCalc(ctx) {
  // Fallback compute in case caller didn't pass one — keeps the module
  // usable standalone if someone imports it into a different app.
  const computeStats = ctx.computeDerivedStats || defaultCompute;
  const escapeHtml = ctx.escapeHtml || defaultEscapeHtml;
  const fmt = ctx.fmt || defaultFmt;

  // ─── STATE ───
  // Persists across tile re-renders so typing / dropdown picks survive
  // combat-triggered refreshes (damage ticks, etc.). Not saved anywhere —
  // it's a scratch pad, not character data.
  // Three configurable dice slots. Each slot can be any of:
  //   'none'    — contributes 0, no statmod
  //   'stat'    — picks a base stat (STR/DEX/PER/INT/CHA/POW); contributes
  //               its VALUE to the pool and its MOD competes for statmod
  //   'derived' — picks a derived stat (HP/SAN/SPD/etc); contributes its
  //               VALUE to the pool; does NOT contribute a statmod (per
  //               spec: only base stats compete for STATMOD)
  //   'skill'   — picks a primary/secondary/specialty skill; contributes
  //               its VALUE to the pool; no statmod
  //   'custom'  — raw number typed in the override field
  //
  // Per-slot keys are remembered even when the kind switches, so toggling
  // STAT→SKILL→STAT preserves the player's STAT pick from earlier. The
  // override is reset whenever the kind or source changes — we want the
  // live value from the new pick, not stale numbers from a prior slot.
  const state = {
    slots: [
      { kind: 'stat',  statKey: 'STR', skillKey: '__none__', derivedKey: '', override: null },
      { kind: 'skill', statKey: 'STR', skillKey: '__none__', derivedKey: '', override: null },
      { kind: 'none',  statKey: 'STR', skillKey: '__none__', derivedKey: '', override: null }
    ],
    // Static roll modifier. null = auto (inherit from the highest-valued
    // base stat in the slots). Number = player manually overrode it.
    statmodOverride: null,
    difficulty: 6,
    mitigation: 0,
    reduction:  0,
    showRaw:    false,       // false = Penalty-reduced pool; true = pre-Penalty
    passive:    false        // true = skip Penalty (e.g. resistance check)
  };

  // ─── DROPDOWN OPTIONS ───

  // Build the list of options the STAT dropdown offers. Pulls every base
  // stat and rollable derived stat (everything in result.stats) so you
  // can roll with anything the ruleset defines — including SAN, HP, etc.
  function buildStatOptions(result, charData, ruleset) {
    const opts = [];
    const baseStats = (ruleset.stats || []).filter(s => s && s.code);
    baseStats.forEach(s => {
      const value = (charData.stats && charData.stats[s.code.toLowerCase()]) || 0;
      const mod = (result.vars && result.vars[s.code + 'MOD'])
        ? result.vars[s.code + 'MOD']
        : 0;
      opts.push({
        key:   s.code,
        label: s.code + (s.name ? ` — ${s.name}` : ''),
        value: Math.max(0, parseInt(value) || 0),
        mod:   parseInt(mod) || 0,
        group: 'base'
      });
    });
    // Derived stats — only ones with a finite computed value. Pull rollMod
    // from the entry if it was evaluated; fall back to 0.
    (ruleset.derivedStats || []).forEach(def => {
      if (!def.code) return;
      const entry = result.stats.get(def.code);
      if (!entry || !Number.isFinite(entry.value)) return;
      opts.push({
        key:   def.code,
        label: def.code + (def.name ? ` — ${def.name}` : ''),
        value: Math.max(0, Math.floor(entry.value)),
        mod:   Number.isFinite(entry.rollModifier) ? entry.rollModifier : 0,
        group: 'derived'
      });
    });
    return opts;
  }

  // Skill dropdown options — aggregates primary / secondary / specialty.
  // Primary skills come from the ruleset (fixed catalog); secondary and
  // specialty are free-form per-character.
  function buildSkillOptions(charData, ruleset) {
    const opts = [];
    // Primary: the ruleset defines which exist; charData stores values.
    const primaries = (ruleset.primarySkills || []);
    const primaryVals = (charData.skills && charData.skills.primary) || {};
    primaries.forEach(p => {
      const name = (typeof p === 'string') ? p : (p.name || '');
      if (!name) return;
      opts.push({
        key:   'P:' + name,
        label: name + ' (Primary)',
        value: parseInt(primaryVals[name]) || 0,
        group: 'primary'
      });
    });
    // Secondary — free-form array of {name, value}.
    const secondaries = (charData.skills && Array.isArray(charData.skills.secondary))
      ? charData.skills.secondary : [];
    secondaries.forEach(s => {
      if (!s || !s.name) return;
      opts.push({
        key:   'S:' + s.name,
        label: s.name + ' (Secondary)',
        value: parseInt(s.value) || 0,
        group: 'secondary'
      });
    });
    // Specialty — same shape as secondary.
    const specialties = (charData.skills && Array.isArray(charData.skills.specialty))
      ? charData.skills.specialty : [];
    specialties.forEach(s => {
      if (!s || !s.name) return;
      opts.push({
        key:   'X:' + s.name,
        label: s.name + ' (Specialty)',
        value: parseInt(s.value) || 0,
        group: 'specialty'
      });
    });
    return opts;
  }

  // ─── DICE DISTRIBUTION MATH ───

  // Analytical distribution of the result of a PRIME roll, using the
  // normal approximation. Given a dice pool, a per-die target number (the
  // effective difficulty), and a fixed stat modifier, returns the mean and
  // the 70% central interval (15th and 85th percentiles under normal).
  //
  // Mechanics modeled:
  //   • rolling a 1   → −1 result, no explosion
  //   • rolling D..9  → +1 result, no explosion  (only when D ≤ 9)
  //   • rolling a 10  → +1 result AND re-roll a new die ("explodes")
  //   • all else      → 0 result
  //
  // The explosion chain is geometric: each 10 triggers another die with
  // the same rules, so per-seat expectations are E[X]/(1−0.1). Difficulty
  // above 10 doesn't change per-die probability (only 10s can hit); the
  // caller passes that penalty into the stat modifier instead.
  function computeRollDistribution(pool, difficulty, statmod) {
    if (pool <= 0) {
      return { mean: statmod, std: 0, low: statmod, high: statmod };
    }
    // Clamp difficulty for the dice calculation. Below 2 is equivalent to
    // D=2 (1s still subtract). Above 10 is equivalent to D=10 (only 10s
    // can still succeed); the excess is handled by effStatmod.
    const D = Math.max(2, Math.min(10, parseInt(difficulty) || 2));

    const p_neg     = 0.1;             // rolling a 1
    const p_pos_nx  = (10 - D) / 10;   // rolling D..9 (+1, no explode)
    const p_pos_ex  = 0.1;             // rolling 10   (+1, explode)

    // Raw per-die contribution X (before the explosion chain).
    // E[X]  = p_pos_nx + p_pos_ex − p_neg       = (10 − D) / 10
    // E[X²] = p_pos_nx + p_pos_ex + p_neg       = (12 − D) / 10  (|±1|² = 1)
    const EX  = p_pos_nx + p_pos_ex - p_neg;
    const EX2 = p_pos_nx + p_pos_ex + p_neg;

    // Per-seat Y = X + I·Y' where I = indicator(rolled 10), Y' is an
    // independent copy of Y (the recursive explosion).
    //   E[Y]  = E[X] / (1 − p_ex)
    //   E[Y²] = (E[X²] + 2·p_ex·E[Y]) / (1 − p_ex)
    const EY  = EX  / (1 - p_pos_ex);
    const EY2 = (EX2 + 2 * p_pos_ex * EY) / (1 - p_pos_ex);
    const VY  = Math.max(0, EY2 - EY * EY);

    const mean = pool * EY + statmod;
    const std  = Math.sqrt(pool * VY);
    // Central 70% interval — ±1.036σ under a normal approximation. Good
    // enough for N ≥ 3 or so; at very small pools the distribution is
    // skewed but the numbers still communicate "roughly this range".
    const Z_70 = 1.036;
    return {
      mean,
      std,
      low:  mean - Z_70 * std,
      high: mean + Z_70 * std
    };
  }

  // Resolve the current calculation inputs by combining state with the
  // Unified slot resolution. Walks each slot, figures out what it's
  // contributing (value + optional statmod), and returns a full picture
  // the tile can render from.
  //
  // STATMOD rule (per spec): only slots that are 'stat' kind (i.e. BASE
  // stats — STR/DEX/PER/INT/CHA/POW) compete. The slot with the highest
  // raw stat VALUE contributes its MOD. Ties go to the lowest-numbered
  // slot (Slot 1 wins over Slot 2, etc.). If no slot is a base stat,
  // auto-statmod is 0. Player override always wins.
  //
  // Derived stats and skills DO NOT contribute a statmod, even if the
  // derived stat has a rollModifier defined. This is intentional: PRIME's
  // STATMOD is a property of base stats in the roll, not a general
  // "roll bonus from whatever's in the pool".
  function resolve(result, charData, ruleset) {
    const statOpts  = buildStatOptions(result, charData, ruleset);
    const skillOpts = buildSkillOptions(charData, ruleset);

    // Per-slot resolution. Returns a rich object so the UI can show
    // breakdown-friendly labels ("STR 5", "Athletics 4", "Custom 7").
    const resolvedSlots = state.slots.map((slot, idx) => {
      const r = {
        index: idx,
        kind: slot.kind,
        value: 0,
        // These describe what was PICKED (for labels/tooltips). null if
        // nothing is picked or the kind doesn't support that pick.
        picked: null,       // the matched option object
        // baseStat: true when this slot is eligible to contribute STATMOD
        // (kind==='stat' and the pick is a base stat).
        baseStat: false
    };
      if (slot.kind === 'none') return r;
      if (slot.kind === 'custom') {
        r.value = slot.override != null ? slot.override : 0;
        return r;
      }
      if (slot.kind === 'stat') {
        const key = slot.statKey;
        const picked = statOpts.find(o => o.key === key && o.group === 'base');
        r.picked = picked || null;
        if (slot.override != null) r.value = slot.override;
        else if (picked) r.value = picked.value;
        r.baseStat = !!picked;   // only base stats satisfy 'stat' kind for statmod
        return r;
      }
      if (slot.kind === 'derived') {
        const key = slot.derivedKey || '';
        const picked = statOpts.find(o => o.key === key && o.group === 'derived');
        r.picked = picked || null;
        if (slot.override != null) r.value = slot.override;
        else if (picked) r.value = picked.value;
        return r;
      }
      if (slot.kind === 'skill') {
        const key = slot.skillKey;
        if (key === '__none__') return r;
        const picked = skillOpts.find(o => o.key === key);
        r.picked = picked || null;
        if (slot.override != null) r.value = slot.override;
        else if (picked) r.value = picked.value;
        return r;
      }
      return r;
    });

    // STATMOD — pick the base-stat slot with the highest stat VALUE.
    // "Value" here is the picked stat's base value (e.g. STR 5), NOT
    // the slot's override. That way an override of 3 on a STR 5 stat
    // still counts as STR for tie-breaking purposes.
    const statSlots = resolvedSlots.filter(s => s.baseStat && s.picked);
    let autoStatmod = 0;
    let statmodSource = null;
    if (statSlots.length > 0) {
      // Pick the slot with the highest picked.value. Ties → earliest
      // slot (Array.prototype.reduce with < preserves the first max).
      let winner = statSlots[0];
      for (let i = 1; i < statSlots.length; i++) {
        if (statSlots[i].picked.value > winner.picked.value) winner = statSlots[i];
      }
      autoStatmod = winner.picked.mod || 0;
      statmodSource = winner;
    }
    const statmod = state.statmodOverride != null
      ? state.statmodOverride
      : autoStatmod;

    const diff = parseInt(state.difficulty) || 0;
    const mit  = parseInt(state.mitigation) || 0;
    const red  = parseInt(state.reduction)  || 0;
    const effDifficulty = Math.max(0, diff - mit - red);
    const diffDelta = effDifficulty - 6;
    const effStatmod = statmod - diffDelta;

    const basePool = Math.max(0, resolvedSlots.reduce(
      (sum, s) => sum + (parseInt(s.value) || 0), 0
    ));
    const penaltyPct = (result.penalty && result.penalty.percent) || 0;
    const isPassive = state.passive === true;
    const penaltyDice = isPassive ? 0 : Math.floor(basePool * penaltyPct / 100);
    const finalPool = Math.max(0, basePool - penaltyDice);

    const dist = computeRollDistribution(finalPool, effDifficulty, effStatmod);

    return {
      statOpts, skillOpts, resolvedSlots,
      statmod, autoStatmod, statmodSource,
      diff, mit, red, effDifficulty, diffDelta, effStatmod,
      basePool, penaltyPct, penaltyDice, finalPool,
      isPassive, dist
    };
  }

  // ─── FORMATTING HELPERS ───

  // Format the expected-result display. For pool=0 it's deterministic
  // (just the statmod); otherwise show the mean with the 70% CI range.
  function formatExpected(dist, pool) {
    const meanRound = Math.round(dist.mean);
    const sign = meanRound >= 0 ? '+' : '−';
    const meanText = `${sign}${Math.abs(meanRound)}`;
    if (pool <= 0) {
      return { meanText, rangeText: 'fixed result (no dice)' };
    }
    const lowRound  = Math.round(dist.low);
    const highRound = Math.round(dist.high);
    if (lowRound === highRound) {
      return { meanText, rangeText: '~70% land here' };
    }
    const lowSign  = lowRound  >= 0 ? '+' : '−';
    const highSign = highRound >= 0 ? '+' : '−';
    return {
      meanText,
      rangeText: `likely ${lowSign}${Math.abs(lowRound)} — ${highSign}${Math.abs(highRound)}`
    };
  }

  // Base-stat dropdown — only STR/DEX/PER/INT/CHA/POW (ruleset.stats).
  // No optgroups: flat list. Used for slot kind='stat'.
  function buildBaseStatSelectHtml(opts, selectedKey) {
    const base = opts.filter(o => o.group === 'base');
    let html = '';
    base.forEach(o => {
      html += `<option value="${escapeHtml(o.key)}"${o.key === selectedKey ? ' selected' : ''}>${escapeHtml(o.label)} (${o.value})</option>`;
    });
    return html;
  }

  // Derived-stat dropdown — everything in ruleset.derivedStats (HP, SPD,
  // SAN, etc.). Flat list. Used for slot kind='derived'.
  function buildDerivedStatSelectHtml(opts, selectedKey) {
    const derived = opts.filter(o => o.group === 'derived');
    let html = '';
    derived.forEach(o => {
      html += `<option value="${escapeHtml(o.key)}"${o.key === selectedKey ? ' selected' : ''}>${escapeHtml(o.label)} (${o.value})</option>`;
    });
    return html;
  }

  function buildSkillSelectHtml(opts, selectedKey) {
    const by = { primary: [], secondary: [], specialty: [] };
    opts.forEach(o => { if (by[o.group]) by[o.group].push(o); });
    let html = `<option value="__none__"${selectedKey === '__none__' ? ' selected' : ''}>— None (0) —</option>`;
    ['primary', 'secondary', 'specialty'].forEach(g => {
      if (by[g].length === 0) return;
      const label = g.charAt(0).toUpperCase() + g.slice(1);
      html += `<optgroup label="${label}">`;
      by[g].forEach(o => {
        html += `<option value="${escapeHtml(o.key)}"${o.key === selectedKey ? ' selected' : ''}>${escapeHtml(o.label)} (${o.value})</option>`;
      });
      html += '</optgroup>';
    });
    return html;
  }

  // Render one dice slot. All three slots use the same component; the
  // only thing that varies is the slot index (for the setter wiring)
  // and the default label above the row.
  //
  // Layout:
  //   [Kind dropdown] [Source dropdown (if kind is stat/derived/skill)] [Value input]
  //
  // Widths handled via CSS: kind is narrow (it only holds 5 options),
  // source stretches to fill, value is fixed-width.
  function renderSlotField(r, slotIdx, label) {
    const slot = state.slots[slotIdx];
    const kind = slot.kind;

    // Kind picker — always rendered. Same 5 options for every slot.
    const kindSelect = `
      <select class="rc-select rc-select-slot-kind"
              onchange="rollCalcSetSlotKind(${slotIdx}, this.value)"
              title="Pick what this dice input represents: a base stat, a derived stat, a skill, a custom number, or nothing.">
        <option value="none"${kind === 'none'    ? ' selected' : ''}>— None —</option>
        <option value="stat"${kind === 'stat'    ? ' selected' : ''}>Stat</option>
        <option value="skill"${kind === 'skill'  ? ' selected' : ''}>Skill</option>
        <option value="derived"${kind === 'derived' ? ' selected' : ''}>Derived</option>
        <option value="custom"${kind === 'custom' ? ' selected' : ''}>Custom</option>
      </select>`;

    // Source picker — content depends on kind. For 'none' and 'custom'
    // there's no source to pick, so we omit it.
    let sourcePicker = '';
    if (kind === 'stat') {
      const html = buildBaseStatSelectHtml(r.statOpts, slot.statKey);
      sourcePicker = `<select class="rc-select rc-select-slot-src"
              onchange="rollCalcSetSlotStat(${slotIdx}, this.value)"
              title="Pick a base stat. Its value joins the pool; the highest-valued stat across all slots contributes its STATMOD.">${html}</select>`;
    } else if (kind === 'derived') {
      const html = buildDerivedStatSelectHtml(r.statOpts, slot.derivedKey);
      const placeholder = html ? '' : '<option value="">— no derived stats —</option>';
      sourcePicker = `<select class="rc-select rc-select-slot-src"
              onchange="rollCalcSetSlotDerived(${slotIdx}, this.value)"
              title="Pick a derived stat. Its value joins the pool; derived stats do not contribute a STATMOD.">${placeholder}${html}</select>`;
    } else if (kind === 'skill') {
      const html = buildSkillSelectHtml(r.skillOpts, slot.skillKey);
      sourcePicker = `<select class="rc-select rc-select-slot-src"
              onchange="rollCalcSetSlotSkill(${slotIdx}, this.value)"
              title="Pick a skill. Its value joins the pool.">${html}</select>`;
    }

    // Numeric value input — always rendered for everything except 'none'.
    let numInput;
    if (kind === 'none') {
      numInput = `<input type="number" class="rc-num" value="0" disabled
                         title="Pick a source in the first dropdown to enable this slot.">`;
    } else {
      const slotR = r.resolvedSlots[slotIdx];
      const tipBase = kind === 'custom'
        ? 'Custom dice — raw number added to the pool.'
        : 'Value — auto-fills from the picker, editable for custom scenarios.';
      numInput = `<input type="number" class="rc-num"
                         value="${slotR.value}"
                         oninput="rollCalcSetSlotValue(${slotIdx}, this.value)"
                         title="${escapeHtml(tipBase)}">`;
    }

    // Row markup — always three positions when a source picker exists,
    // two positions otherwise (kind + value). CSS classes convey the
    // layout variant for styling.
    const hasSource = (kind === 'stat' || kind === 'derived' || kind === 'skill');
    const rowCls = hasSource ? 'rc-field-row rc-field-row-slot-3' : 'rc-field-row rc-field-row-slot-2';

    return `
      <div class="rc-field">
        <label class="rc-label">${escapeHtml(label)}</label>
        <div class="${rowCls}">${kindSelect}${sourcePicker}${numInput}</div>
      </div>`;
  }

  // Statmod field tooltip — explains which slot's STATMOD auto-populated
  // the field, and where tie-breaks resolved. Player override still wins.
  function statmodTip(r) {
    const base = 'Static roll bonus — auto-fills from the highest-valued base stat across your slots, override for custom rolls.';
    if (state.statmodOverride != null) {
      return base + ' (Currently overridden — the auto value would be ' +
        (r.autoStatmod >= 0 ? '+' : '') + r.autoStatmod + '.)';
    }
    if (!r.statmodSource) {
      return base + ' No base stat in any slot, so auto-statmod is 0.';
    }
    const src = r.statmodSource.picked;
    return base + ` Using ${src.key}MOD (from Slot ${r.statmodSource.index + 1}: ${src.key} ${src.value}).`;
  }

  // Format the Pool line inside the breakdown. Shows each contributing
  // slot explicitly (skipping 'none' slots) — e.g. "STR 5 + Athletics 4
  // + Custom 7 = 16d". Makes it easy to audit the pool at a glance.
  function poolLineText(r) {
    const parts = [];
    r.resolvedSlots.forEach(s => {
      if (s.kind === 'none') return;
      const label = slotLabel(s);
      parts.push(label ? `${label} ${s.value}` : `${s.value}`);
    });
    if (parts.length === 0) return `<b>0d</b>`;
    return `${parts.join(' + ')} = <b>${r.basePool}d</b>`;
  }

  // Short label describing what this slot resolved to — used in the
  // breakdown. Empty string when there's nothing worth labelling.
  function slotLabel(resolvedSlot) {
    const s = resolvedSlot;
    if (s.kind === 'stat')    return s.picked ? s.picked.key : '';
    if (s.kind === 'derived') return s.picked ? s.picked.key : '';
    if (s.kind === 'skill')   return s.picked
      ? s.picked.label.replace(/\s*\(.*\)\s*$/, '')  // strip "(Primary)" suffix
      : '';
    if (s.kind === 'custom')  return 'Custom';
    return '';
  }

  // ─── TILE RENDER ───

  // Full tile render — called by combat.js in its renderAll pipeline.
  // Returns HTML string; caller stitches it into the combat tab.
  function renderTile(result, ruleset, charData) {
    const r = resolve(result, charData, ruleset);

    const displayedPool = state.showRaw ? r.basePool : r.finalPool;
    const displayedMod  = r.effStatmod;
    const modSign = displayedMod >= 0 ? '+' : '−';
    const modAbs  = Math.abs(displayedMod);
    const toggleTip = r.isPassive
      ? 'Passive — Strain does not apply to this roll.'
      : (state.showRaw
        ? `Showing raw pool. Click to see ${r.finalPool}d after Strain.`
        : `Showing Strain-reduced pool. Click to see raw ${r.basePool}d.`);

    const diffNote = r.diffDelta === 0
      ? 'baseline'
      : (r.diffDelta > 0 ? `+${r.diffDelta} above baseline` : `${r.diffDelta} below baseline`);
    const statmodNote = r.diffDelta === 0
      ? ''
      : ` (${r.statmod >= 0 ? '+' : '−'}${Math.abs(r.statmod)} base ${r.diffDelta > 0 ? '−' : '+'} ${Math.abs(r.diffDelta)})`;

    const expected = formatExpected(r.dist, r.finalPool);
    const penaltyLine = r.isPassive
      ? `<div class="rc-line"><span class="rc-k">Penalty</span><span class="rc-v">— <span class="rc-dim">(passive — ignored)</span></span></div>`
      : `<div class="rc-line"><span class="rc-k">Penalty</span><span class="rc-v">−${r.penaltyDice}d  <span class="rc-dim">(${r.penaltyPct}% of ${r.basePool})</span></span></div>`;

    return `
      <div class="state-tile state-tile-wide state-tile-rollcalc">
        <div class="state-tile-head">
          <span class="state-tile-label">Roll Calculator</span>
          <div class="rc-mode" role="group" aria-label="Roll mode">
            <button type="button" class="rc-mode-btn${!r.isPassive ? ' active' : ''}" onclick="rollCalcSetPassive(false)" title="Active roll — Strain reduces your dice pool">Active</button>
            <button type="button" class="rc-mode-btn${r.isPassive ? ' active' : ''}"  onclick="rollCalcSetPassive(true)"  title="Passive roll — Strain does not apply (resistance checks)">Passive</button>
          </div>
          <span class="rc-hint">(Dice 1 + Dice 2 + Dice 3) @ Difficulty + Mod</span>
        </div>

        <div class="rc-grid">
          ${renderSlotField(r, 0, 'Dice 1')}
          ${renderSlotField(r, 1, 'Dice 2')}
          ${renderSlotField(r, 2, 'Dice 3')}

          <div class="rc-field">
            <label class="rc-label">Stat Mod</label>
            <input type="number" class="rc-num" value="${r.statmod}"
                   oninput="rollCalcSetStatmod(this.value)"
                   title="${escapeHtml(statmodTip(r))}">
          </div>

          <div class="rc-field">
            <label class="rc-label">Difficulty</label>
            <input type="number" class="rc-num" value="${r.diff}"
                   oninput="rollCalcSetDifficulty(this.value)"
                   title="Base difficulty (PRIME baseline is 6)">
          </div>

          <div class="rc-field">
            <label class="rc-label">Mitigation</label>
            <input type="number" class="rc-num" value="${r.mit}"
                   oninput="rollCalcSetMitigation(this.value)"
                   title="Difficulty Mitigation — subtracted from raw difficulty">
          </div>

          <div class="rc-field">
            <label class="rc-label">Reduction</label>
            <input type="number" class="rc-num" value="${r.red}"
                   oninput="rollCalcSetReduction(this.value)"
                   title="Difficulty Reduction — subtracted from raw difficulty">
          </div>
        </div>

        <div class="rc-output">
          <div class="rc-output-pair">
            <button type="button" class="rc-big${r.isPassive ? ' rc-big-passive' : ''}" onclick="rollCalcToggle()" title="${escapeHtml(toggleTip)}">
              <span class="rc-big-label">Dice Pool</span>
              <span class="rc-big-main">
                <span class="rc-big-num ${state.showRaw && !r.isPassive ? 'rc-raw' : ''}">${displayedPool}d</span>
                <span class="rc-big-mod">${modSign}${modAbs}</span>
              </span>
              <span class="rc-big-diff">@ diff ${r.effDifficulty}${r.isPassive ? ' · passive' : ''}</span>
            </button>
            <div class="rc-expected">
              <span class="rc-big-label">Expected Result</span>
              <span class="rc-expected-mean">${expected.meanText}</span>
              <span class="rc-expected-range">${escapeHtml(expected.rangeText)}</span>
            </div>
          </div>
          <div class="rc-breakdown">
            <div class="rc-line"><span class="rc-k">Pool</span><span class="rc-v">${poolLineText(r)}</span></div>
            ${penaltyLine}
            <div class="rc-line"><span class="rc-k">After Strain</span><span class="rc-v"><b>${r.finalPool}d</b></span></div>
            <div class="rc-line"><span class="rc-k">Difficulty</span><span class="rc-v">${r.diff} − ${r.mit} mit − ${r.red} red = <b>${r.effDifficulty}</b>  <span class="rc-dim">(${diffNote})</span></span></div>
            <div class="rc-line"><span class="rc-k">Stat mod</span><span class="rc-v"><b>${modSign}${modAbs}</b>${escapeHtml(statmodNote)}</span></div>
          </div>
        </div>
      </div>`;
  }

  // ─── REPAINT ───

  // Full-tile repaint — replaces the .state-tile-rollcalc element's
  // outerHTML with a freshly rendered copy. Used when something changed
  // that affects dropdown options or labels (e.g. picking a new stat).
  // Cheaper than the combat renderAll because it only touches one tile.
  function repaintTile() {
    const tile = document.querySelector('.state-tile-rollcalc');
    if (!tile) return;
    const ruleset = ctx.getRuleset();
    const charData = ctx.getCharData();
    if (!ruleset) return;
    const result = computeStats(charData, ruleset);
    tile.outerHTML = renderTile(result, ruleset, charData);
  }

  // Targeted repaint — recompute and rewrite only the output areas (big
  // pool, expected result, breakdown, mode pills). Keeps input focus
  // stable so typing into the number fields feels responsive.
  function repaintOutput() {
    const tile = document.querySelector('.state-tile-rollcalc');
    if (!tile) return;
    const ruleset = ctx.getRuleset();
    const charData = ctx.getCharData();
    if (!ruleset) return;
    const result = computeStats(charData, ruleset);
    const r = resolve(result, charData, ruleset);

    const displayedPool = state.showRaw ? r.basePool : r.finalPool;
    const displayedMod  = r.effStatmod;
    const modSign = displayedMod >= 0 ? '+' : '−';
    const modAbs  = Math.abs(displayedMod);

    // Active/Passive pill state.
    const modeBtns = tile.querySelectorAll('.rc-mode-btn');
    if (modeBtns.length === 2) {
      modeBtns[0].classList.toggle('active', !r.isPassive);
      modeBtns[1].classList.toggle('active',  r.isPassive);
    }

    // Big dice pool button.
    const bigBtn = tile.querySelector('.rc-big');
    if (bigBtn) bigBtn.classList.toggle('rc-big-passive', r.isPassive);

    const bigNum = tile.querySelector('.rc-big-num');
    if (bigNum) {
      bigNum.textContent = `${displayedPool}d`;
      bigNum.classList.toggle('rc-raw', state.showRaw && !r.isPassive);
    }
    const bigMod = tile.querySelector('.rc-big-mod');
    if (bigMod) bigMod.textContent = `${modSign}${modAbs}`;
    const bigDiff = tile.querySelector('.rc-big-diff');
    if (bigDiff) bigDiff.textContent = `@ diff ${r.effDifficulty}${r.isPassive ? ' · passive' : ''}`;

    // Expected result block.
    const expected = formatExpected(r.dist, r.finalPool);
    const expMean  = tile.querySelector('.rc-expected-mean');
    const expRange = tile.querySelector('.rc-expected-range');
    if (expMean)  expMean.textContent  = expected.meanText;
    if (expRange) expRange.textContent = expected.rangeText;

    const diffNote = r.diffDelta === 0
      ? 'baseline'
      : (r.diffDelta > 0 ? `+${r.diffDelta} above baseline` : `${r.diffDelta} below baseline`);
    const statmodNote = r.diffDelta === 0
      ? ''
      : ` (${r.statmod >= 0 ? '+' : '−'}${Math.abs(r.statmod)} base ${r.diffDelta > 0 ? '−' : '+'} ${Math.abs(r.diffDelta)})`;

    const penaltyLineHtml = r.isPassive
      ? `<div class="rc-line"><span class="rc-k">Penalty</span><span class="rc-v">— <span class="rc-dim">(passive — ignored)</span></span></div>`
      : `<div class="rc-line"><span class="rc-k">Penalty</span><span class="rc-v">−${r.penaltyDice}d  <span class="rc-dim">(${r.penaltyPct}% of ${r.basePool})</span></span></div>`;

    const bd = tile.querySelector('.rc-breakdown');
    if (bd) {
      bd.innerHTML = `
        <div class="rc-line"><span class="rc-k">Pool</span><span class="rc-v">${poolLineText(r)}</span></div>
        ${penaltyLineHtml}
        <div class="rc-line"><span class="rc-k">After Strain</span><span class="rc-v"><b>${r.finalPool}d</b></span></div>
        <div class="rc-line"><span class="rc-k">Difficulty</span><span class="rc-v">${r.diff} − ${r.mit} mit − ${r.red} red = <b>${r.effDifficulty}</b>  <span class="rc-dim">(${diffNote})</span></span></div>
        <div class="rc-line"><span class="rc-k">Stat mod</span><span class="rc-v"><b>${modSign}${modAbs}</b>${escapeHtml(statmodNote)}</span></div>`;
    }
  }

  // ─── HANDLERS ───
  // Dropdown picks rebuild the whole tile (labels / selected options change).
  // Number inputs do a tighter repaint so typing doesn't lose focus.

  // Slot setters — one set of functions handles all three slots by
  // index. Changing the kind or source resets the override (so the new
  // pick shows its live value, not stale data from the previous one).
  // Value changes skip the full tile rebuild to preserve input focus.
  function getSlot(idx) {
    const i = parseInt(idx);
    if (!Number.isFinite(i) || i < 0 || i >= state.slots.length) return null;
    return state.slots[i];
  }
  function setSlotKind(idx, kind) {
    const slot = getSlot(idx);
    if (!slot) return;
    const valid = new Set(['none','stat','skill','derived','custom']);
    slot.kind = valid.has(kind) ? kind : 'none';
    slot.override = null;
    repaintTile();
  }
  function setSlotStat(idx, key) {
    const slot = getSlot(idx);
    if (!slot) return;
    slot.statKey = key;
    slot.override = null;
    repaintTile();
  }
  function setSlotSkill(idx, key) {
    const slot = getSlot(idx);
    if (!slot) return;
    slot.skillKey = key;
    slot.override = null;
    repaintTile();
  }
  function setSlotDerived(idx, key) {
    const slot = getSlot(idx);
    if (!slot) return;
    slot.derivedKey = key;
    slot.override = null;
    repaintTile();
  }
  function setSlotValue(idx, v) {
    const slot = getSlot(idx);
    if (!slot) return;
    const n = parseFloat(v);
    slot.override = Number.isFinite(n) ? n : 0;
    repaintOutput();
  }

  function setStatmod(v) {
    state.statmodOverride = parseFloat(v);
    if (!Number.isFinite(state.statmodOverride)) state.statmodOverride = 0;
    repaintOutput();
  }
  function setDifficulty(v) {
    state.difficulty = parseInt(v) || 0;
    repaintOutput();
  }
  function setMitigation(v) {
    state.mitigation = parseInt(v) || 0;
    repaintOutput();
  }
  function setReduction(v) {
    state.reduction = parseInt(v) || 0;
    repaintOutput();
  }
  function toggleShowRaw() {
    state.showRaw = !state.showRaw;
    repaintOutput();
  }
  function setPassive(flag) {
    state.passive = !!flag;
    repaintOutput();
  }

  return {
    renderTile,
    repaintTile,
    repaintOutput,
    // Unified per-slot setters (slot index = 0, 1, 2)
    setSlotKind, setSlotStat, setSlotSkill, setSlotDerived, setSlotValue,
    setStatmod,
    setDifficulty, setMitigation, setReduction,
    toggleShowRaw, setPassive
  };
}

// Default helpers — used if ctx doesn't supply them. Matches the versions
// that live in char-combat.js / char-util.js so behavior stays identical.
function defaultEscapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function defaultFmt(n) {
  if (n == null || !Number.isFinite(n)) return '0';
  // Trim trailing zeroes so 2.50 → 2.5 and 4.00 → 4.
  return (Math.round(n * 100) / 100).toString();
}
