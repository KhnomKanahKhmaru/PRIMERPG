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
  const state = {
    statKey:     'STR',      // dropdown code — base stat, derived stat, or 'custom'
    statOverride: null,      // number; null = use picked stat's live value
    statmodOverride: null,   // number; null = use picked stat's live mod
    skillKey:    '__none__', // skill name, '__none__' (skip), or 'custom'
    skillOverride: null,
    // Extra dice slot — optional third input. kind selects the source:
    //   'none'   — slot disabled, contributes 0 dice, no statmod effect
    //   'stat'   — pick from base + derived stats; contributes that stat
    //              to the pool AND enters the statmod competition
    //   'skill'  — pick from primary/secondary/specialty skills
    //   'custom' — player types a raw number
    extraKind:     'none',
    extraStatKey:  'STR',    // used when extraKind === 'stat'
    extraSkillKey: '__none__',// used when extraKind === 'skill'
    extraOverride: null,     // number; active for 'custom' always,
                             // and for 'stat'/'skill' as an override
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
  // picked dropdown option's live values. Overrides win over live data.
  function resolve(result, charData, ruleset) {
    const statOpts = buildStatOptions(result, charData, ruleset);
    const skillOpts = buildSkillOptions(charData, ruleset);
    const pickedStat = statOpts.find(o => o.key === state.statKey);
    const pickedSkill = skillOpts.find(o => o.key === state.skillKey);

    const statValue = state.statOverride != null
      ? state.statOverride
      : (pickedStat ? pickedStat.value : 0);
    const skillValue = state.skillOverride != null
      ? state.skillOverride
      : (pickedSkill ? pickedSkill.value : 0);

    // Extra slot — up to one more source of dice. Can be a stat, skill,
    // or raw number. Tracks the picked option so we can show the live
    // source-value alongside a manual override (if the player typed one).
    let extraValue = 0;
    let pickedExtraStat = null;
    let pickedExtraSkill = null;
    if (state.extraKind === 'stat') {
      pickedExtraStat = statOpts.find(o => o.key === state.extraStatKey) || null;
      extraValue = state.extraOverride != null
        ? state.extraOverride
        : (pickedExtraStat ? pickedExtraStat.value : 0);
    } else if (state.extraKind === 'skill') {
      pickedExtraSkill = skillOpts.find(o => o.key === state.extraSkillKey) || null;
      extraValue = state.extraOverride != null
        ? state.extraOverride
        : (pickedExtraSkill ? pickedExtraSkill.value : 0);
    } else if (state.extraKind === 'custom') {
      extraValue = state.extraOverride != null ? state.extraOverride : 0;
    }
    // 'none' leaves extraValue = 0

    // STATMOD — by default, inherits the picked Stat slot's mod. If the
    // Extra slot is also a STAT AND its raw stat value is higher than
    // the primary Stat slot's, we use THAT stat's mod instead. Player
    // override wins over the auto-pick.
    //
    // Why "raw stat value" and not the pool-contribution value: the rule
    // is "whichever stat is highest contributes its mod" — and STAT's
    // identity (which stat the character has) is measured by the base
    // number on the character sheet, not by what was typed into the
    // override field for this specific calc.
    let autoStatmod = pickedStat ? pickedStat.mod : 0;
    if (state.extraKind === 'stat' && pickedExtraStat) {
      const primaryBase = pickedStat ? pickedStat.value : -Infinity;
      const extraBase   = pickedExtraStat.value;
      if (extraBase > primaryBase) {
        autoStatmod = pickedExtraStat.mod;
      }
    }
    const statmod = state.statmodOverride != null
      ? state.statmodOverride
      : autoStatmod;

    const diff   = parseInt(state.difficulty) || 0;
    const mit    = parseInt(state.mitigation) || 0;
    const red    = parseInt(state.reduction)  || 0;
    const effDifficulty = Math.max(0, diff - mit - red);
    const diffDelta = effDifficulty - 6;
    const effStatmod = statmod - diffDelta;

    // Pool sums all three slots. A slot with kind 'none' or a 0 value
    // simply adds 0 (it's already accounted for above).
    const basePool = Math.max(0,
      (parseInt(statValue)  || 0) +
      (parseInt(skillValue) || 0) +
      (parseInt(extraValue) || 0)
    );
    const penaltyPct = (result.penalty && result.penalty.percent) || 0;
    // Passive rolls bypass Strain — used for resistance checks.
    const isPassive = state.passive === true;
    const penaltyDice = isPassive ? 0 : Math.floor(basePool * penaltyPct / 100);
    const finalPool = Math.max(0, basePool - penaltyDice);

    // Distribution of result = pool rolls + effStatmod. Based on the pool
    // the player actually rolls (post-Penalty if active, raw if passive).
    const dist = computeRollDistribution(finalPool, effDifficulty, effStatmod);

    return {
      statOpts, skillOpts, pickedStat, pickedSkill,
      statValue, skillValue, extraValue,
      pickedExtraStat, pickedExtraSkill,
      statmod,
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

  function buildStatSelectHtml(opts, selectedKey) {
    if (selectedKey === undefined) selectedKey = state.statKey;
    const base = opts.filter(o => o.group === 'base');
    const derived = opts.filter(o => o.group === 'derived');
    let html = '';
    if (base.length > 0) {
      html += '<optgroup label="Stats">';
      base.forEach(o => {
        html += `<option value="${escapeHtml(o.key)}"${o.key === selectedKey ? ' selected' : ''}>${escapeHtml(o.label)} (${o.value})</option>`;
      });
      html += '</optgroup>';
    }
    if (derived.length > 0) {
      html += '<optgroup label="Derived">';
      derived.forEach(o => {
        html += `<option value="${escapeHtml(o.key)}"${o.key === selectedKey ? ' selected' : ''}>${escapeHtml(o.label)} (${o.value})</option>`;
      });
      html += '</optgroup>';
    }
    html += `<option value="custom"${selectedKey === 'custom' ? ' selected' : ''}>— Custom —</option>`;
    return html;
  }

  function buildSkillSelectHtml(opts, selectedKey) {
    if (selectedKey === undefined) selectedKey = state.skillKey;
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
    html += `<option value="custom"${selectedKey === 'custom' ? ' selected' : ''}>— Custom —</option>`;
    return html;
  }

  // Render the Extra Dice field — a third pool input. Kind picker
  // controls what follows: 'none' shows nothing, 'stat' shows a stat
  // picker + override, 'skill' shows a skill picker + override,
  // 'custom' shows just a numeric input. The pool sums whatever value
  // this slot resolves to (0 when kind='none').
  function renderExtraField(r, statOptionsHtml, skillOptionsHtml) {
    const kind = state.extraKind;
    // Kind selector — always rendered.
    const kindSelect = `
      <select class="rc-select rc-select-extra-kind" onchange="rollCalcSetExtraKind(this.value)" title="Pick what this third input represents — another stat, a skill, a custom number, or none">
        <option value="none"${kind === 'none'   ? ' selected' : ''}>— None —</option>
        <option value="stat"${kind === 'stat'   ? ' selected' : ''}>Stat</option>
        <option value="skill"${kind === 'skill' ? ' selected' : ''}>Skill</option>
        <option value="custom"${kind === 'custom' ? ' selected' : ''}>Custom</option>
      </select>`;

    // Source picker — a second dropdown for stat/skill kinds, or empty
    // space (to keep column alignment) for custom/none.
    let sourcePicker = '';
    if (kind === 'stat') {
      // Rebuild the stat select with the EXTRA slot's selection.
      const html = buildStatSelectHtml(r.statOpts, state.extraStatKey);
      sourcePicker = `<select class="rc-select" onchange="rollCalcSetExtraStat(this.value)" title="Pick a stat — its value joins the pool, and the highest-stat's mod wins statmod">${html}</select>`;
    } else if (kind === 'skill') {
      const html = buildSkillSelectHtml(r.skillOpts, state.extraSkillKey);
      sourcePicker = `<select class="rc-select" onchange="rollCalcSetExtraSkill(this.value)" title="Pick a skill — its value joins the pool">${html}</select>`;
    }

    // Numeric input — always rendered for stat/skill/custom. For 'none'
    // we show a disabled placeholder so the column layout doesn't jump.
    let numInput;
    if (kind === 'none') {
      numInput = `<input type="number" class="rc-num" value="0" disabled title="Pick a source above to enable this slot">`;
    } else {
      const tip = kind === 'custom'
        ? 'Custom dice — raw number added to the pool'
        : 'Value — auto-fills from the picker, editable for custom scenarios';
      numInput = `<input type="number" class="rc-num" value="${r.extraValue}"
                   oninput="rollCalcSetExtraValue(this.value)"
                   title="${escapeHtml(tip)}">`;
    }

    // Three-column row when stat/skill (kind | source | value); two
    // columns when custom or none (kind | value — source hidden).
    const rowHtml = (kind === 'stat' || kind === 'skill')
      ? `<div class="rc-field-row rc-field-row-extra-three">${kindSelect}${sourcePicker}${numInput}</div>`
      : `<div class="rc-field-row">${kindSelect}${numInput}</div>`;

    return `
      <div class="rc-field">
        <label class="rc-label">Extra Dice</label>
        ${rowHtml}
      </div>`;
  }

  // Statmod field tooltip — explains where the auto-value came from.
  // Mentions stat-slot competition when Extra is also a stat so the
  // player understands why statmod might not match the picked Stat's.
  function statmodTip(r) {
    const base = 'Static roll bonus — auto-fills from picked stat, override for custom rolls.';
    if (state.extraKind !== 'stat' || !r.pickedExtraStat) return base;
    const primaryVal = r.pickedStat ? r.pickedStat.value : 0;
    const extraVal = r.pickedExtraStat.value;
    if (extraVal > primaryVal) {
      return base + ` Using ${r.pickedExtraStat.key}MOD — ${r.pickedExtraStat.key} (${extraVal}) is higher than ${r.pickedStat ? r.pickedStat.key : '—'} (${primaryVal}).`;
    }
    if (extraVal === primaryVal && r.pickedStat) {
      return base + ` Tie between ${r.pickedStat.key} and ${r.pickedExtraStat.key} — using ${r.pickedStat.key}MOD.`;
    }
    return base + ` ${r.pickedStat ? r.pickedStat.key : '—'} (${primaryVal}) is higher than ${r.pickedExtraStat.key} (${extraVal}).`;
  }

  // Format the Pool line inside the breakdown. Shows each contributing
  // slot explicitly when Extra is active, otherwise falls back to the
  // original stat+skill form. Includes a small label per term so the
  // player can trace which number came from which slot at a glance.
  function poolLineText(r) {
    const parts = [
      `${r.statValue}`
    ];
    parts.push(`+ ${r.skillValue}`);
    if (state.extraKind !== 'none') parts.push(`+ ${r.extraValue}`);
    return `${parts.join(' ')} = <b>${r.basePool}d</b>`;
  }

  // ─── TILE RENDER ───

  // Full tile render — called by combat.js in its renderAll pipeline.
  // Returns HTML string; caller stitches it into the combat tab.
  function renderTile(result, ruleset, charData) {
    const r = resolve(result, charData, ruleset);

    const statOptionsHtml = buildStatSelectHtml(r.statOpts);
    const skillOptionsHtml = buildSkillSelectHtml(r.skillOpts);

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
          <span class="rc-hint">(STAT + SKILL + EXTRA) @ Difficulty + Mod</span>
        </div>

        <div class="rc-grid">
          <div class="rc-field">
            <label class="rc-label">Stat</label>
            <div class="rc-field-row">
              <select class="rc-select" onchange="rollCalcSetStat(this.value)">
                ${statOptionsHtml}
              </select>
              <input type="number" class="rc-num" value="${r.statValue}"
                     oninput="rollCalcSetStatValue(this.value)"
                     title="Stat value — auto-fills from dropdown, editable for custom scenarios">
            </div>
          </div>

          <div class="rc-field">
            <label class="rc-label">Skill</label>
            <div class="rc-field-row">
              <select class="rc-select" onchange="rollCalcSetSkill(this.value)">
                ${skillOptionsHtml}
              </select>
              <input type="number" class="rc-num" value="${r.skillValue}"
                     oninput="rollCalcSetSkillValue(this.value)"
                     title="Skill value — auto-fills from dropdown, editable for custom scenarios">
            </div>
          </div>

          ${renderExtraField(r, statOptionsHtml, skillOptionsHtml)}

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

  function setStat(key) {
    state.statKey = key;
    // Clear value/mod overrides when switching stat — user probably wants
    // the new stat's fresh values, not the override from the previous one.
    state.statOverride = null;
    state.statmodOverride = null;
    repaintTile();
  }
  function setSkill(key) {
    state.skillKey = key;
    state.skillOverride = null;
    repaintTile();
  }
  function setStatValue(v) {
    state.statOverride = parseFloat(v);
    if (!Number.isFinite(state.statOverride)) state.statOverride = 0;
    repaintOutput();
  }
  function setSkillValue(v) {
    state.skillOverride = parseFloat(v);
    if (!Number.isFinite(state.skillOverride)) state.skillOverride = 0;
    repaintOutput();
  }
  function setStatmod(v) {
    state.statmodOverride = parseFloat(v);
    if (!Number.isFinite(state.statmodOverride)) state.statmodOverride = 0;
    repaintOutput();
  }

  // Extra slot setters. setExtraKind switches what type the extra slot
  // is (stat/skill/custom/none) — that changes the UI so we do a full
  // tile repaint. The per-source key setters also need a tile repaint
  // because the number input's displayed live value changes. The
  // override setter only changes the computed pool, so it uses the
  // lighter repaintOutput (keeps focus on the input).
  function setExtraKind(kind) {
    const valid = new Set(['none','stat','skill','custom']);
    state.extraKind = valid.has(kind) ? kind : 'none';
    // Clear any stale override when switching source type — otherwise
    // a number typed against "stat" would leak into "skill"'s field.
    state.extraOverride = null;
    repaintTile();
  }
  function setExtraStat(key) {
    state.extraStatKey = key;
    state.extraOverride = null;
    repaintTile();
  }
  function setExtraSkill(key) {
    state.extraSkillKey = key;
    state.extraOverride = null;
    repaintTile();
  }
  function setExtraValue(v) {
    state.extraOverride = parseFloat(v);
    if (!Number.isFinite(state.extraOverride)) state.extraOverride = 0;
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
    setStat, setSkill,
    setStatValue, setSkillValue, setStatmod,
    // Extra dice slot (third input — stat / skill / custom / none)
    setExtraKind, setExtraStat, setExtraSkill, setExtraValue,
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
