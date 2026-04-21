// char-overview.js
//
// "State of Things" dashboard tiles that live on the Overview tab.
// Read-only summary of Body / Sanity / Power / Movement / Penalty, computed
// from the same pipeline as the Combat tab so the two views never drift.
//
// Split out of char-combat.js because these tiles are:
//   • visually self-contained (rendered into a separate #state-body host)
//   • pure presentation — no handlers, no state, no Firestore writes
//   • the last of the chunky render blocks sitting in combat.js
//
// Combat's renderAll() triggers an overview repaint on every damage tick
// by calling overview.renderState(result, ruleset). The Penalty tile is
// ALSO reused inline on the Combat tab (top of the tab, right below Roll
// Calc), so this module exports renderPenaltyTile for that caller too.
//
// ctx shape:
//   getCollapsedPenaltyValues() → Set of stat codes whose strain-reduced
//      value is currently collapsed (click-to-toggle in Movement tile).
//      Shared with combat.js so the two views stay in sync without this
//      module needing to own the state itself.
//   getCharData() → current character doc (used by the Penalty tile's
//      Others editor to read otherModifiers; handlers themselves live
//      in combat.js and are exposed via window.*)
//   getCanEdit() → boolean; whether the user can edit this character
//   escapeHtml, fmt → shared formatting helpers

export function createOverviewSection(ctx) {
  const {
    getCollapsedPenaltyValues,
    getCharData,
    getCanEdit,
    escapeHtml,
    fmt
  } = ctx;

  // ─── ORCHESTRATOR ───
  //
  // Read-only summary showing Body, Sanity, Penalty, Power, Movement. Lives
  // on the Overview tab. No controls — players go to Combat tab to edit.
  // We compute everything from the same pipeline as the Combat tab, so
  // numbers always match between the two views.
  function renderState(result, ruleset) {
    const host = document.getElementById('state-body');
    if (!host) return;

    const tiles = [];

    // BODY tile — HP current/max, segmented green→red bar, overall status.
    const body = result.body;
    if (body && body.max > 0) {
      tiles.push(renderBodyTile(body));
    }

    // SANITY tile — SAN current/max, blue→red bar, status label.
    const san = result.san;
    if (san && san.max > 0) {
      tiles.push(renderSanTile(san));
    }

    // POWER tile — power pool current/max, simple fill bar. Always
    // rendered when the pool is present in the result (even if max is 0
    // from a freshly-created character), so the Overview grid stays
    // balanced and players can see "no power yet" at a glance. Slotted
    // next to Body + Sanity in the top row since it behaves like another
    // resource pool (not a derived percentage).
    const power = result.power;
    if (power) {
      tiles.push(renderPowerTile(power));
    }

    // Bottom section — full-width rows below the resource tiles. The Roll
    // Calculator lives on the Combat tab instead (it's a combat tool, not
    // a state summary), so the Overview only shows Movement and Penalty.
    const movementHtml = renderMovementTile(result, ruleset);
    if (movementHtml) tiles.push(movementHtml);
    const charData = getCharData ? getCharData() : null;
    const otherMods = charData && Array.isArray(charData.otherModifiers) ? charData.otherModifiers : [];
    const canEdit = getCanEdit ? getCanEdit() : true;
    tiles.push(renderPenaltyTile(result.pain, result.stress, result.penalty, otherMods, canEdit));

    host.innerHTML = tiles.length
      ? `<div class="state-grid">${tiles.join('')}</div>`
      : '<div class="state-empty">No state data available.</div>';
  }

  // ─── BODY TILE ───

  function renderBodyTile(body) {
    // Body status label — computed in char-derived.js with priority
    // Destroyed > Dead > Incapacitated > Unconscious > Paralyzed > Alive.
    // Falls back to a damage-based label if statusLabel is somehow missing.
    const label = (body.statusLabel && body.statusLabel.trim())
      ? body.statusLabel
      : (body.damage > 0 ? 'Wounded' : 'Healthy');

    // Pill color class — mirrors the severity tiers of the label. We reuse
    // the existing CSS classes rather than adding new ones; Destroyed and
    // Dead share the death palette, Incapacitated uses the disabled tone
    // (same as individual Unconscious/Paralyzed since it's both of them).
    let statusClass;
    if (body.destroyed || body.dead) {
      statusClass = 's-dead';
    } else if (body.incapacitated || body.unconscious || body.paralyzed) {
      statusClass = 's-disabled';
    } else if (body.damage > 0) {
      statusClass = 's-injured';
    } else {
      statusClass = 's-healthy';
    }

    const segHtml = renderBodySegments(body.max, body.damage, Math.min(body.max, 40), body.destroyed);
    return `
      <div class="state-tile">
        <div class="state-tile-head">
          <span class="state-tile-label">Body</span>
          <span class="state-tile-nums">${body.current}<span class="sep">/</span><span class="max">${body.max}</span></span>
        </div>
        <div class="state-bar">${segHtml}</div>
        <span class="state-tile-status ${statusClass}">${escapeHtml(label)}</span>
      </div>`;
  }

  function renderBodySegments(maxHP, damage, segCount, destroyed) {
    // Color progression as damage accumulates, mapped to the full HP range
    // (+max → 0 → -max). Rightmost segments transition first.
    //
    //   current = +max  (damage = 0)        → fully green      (Healthy)
    //   current = 0     (damage = maxHP)    → fully yellow     (Incapacitated:
    //                                           Unconscious and Paralyzed)
    //   current = -max  (damage = 2·maxHP)  → fully red        (Dead)
    //   past -max + all limbs Def.Destroyed → near-black       (Destroyed;
    //                                           character fully annihilated)
    //
    // The black "destroyed" state is gated on the `destroyed` flag (maps
    // to body.destroyed) — a Body past 2·max alone isn't enough, because
    // single-limb degradation (bleeding, exsanguination) can drive Body
    // down without the whole character being gone. destroyed additionally
    // requires all limbs to be Def.Destroyed.
    //
    // Per segment, `base` is how much damage has already chewed through
    // segments to the right of it. Color is driven by how far past `base`
    // the total damage has progressed. Thresholds use strict > so the
    // boundary cases land cleanly — exactly `damage = maxHP` shows fully
    // yellow (not sneaking a red seg in), exactly `2·maxHP` shows fully
    // red, etc.
    if (maxHP <= 0 || segCount <= 0) return '';
    const COLORS = { green: '#4a7a3a', yellow: '#bdb247', red: '#8a3030', destroyed: '#2a1010' };
    const hpPerSeg = maxHP / segCount;
    let html = '';
    for (let i = 1; i <= segCount; i++) {
      const rightDistance = segCount - i + 1;
      const base = (rightDistance - 1) * hpPerSeg;
      let color;
      if      (destroyed && damage > 2 * maxHP + base) color = COLORS.destroyed;
      else if (damage >     maxHP + base)              color = COLORS.red;
      else if (damage >              base)             color = COLORS.yellow;
      else                                              color = COLORS.green;
      html += `<span class="state-bar-seg" style="background:${color}"></span>`;
    }
    return html;
  }

  // ─── SANITY TILE ───

  function renderSanTile(san) {
    // Status label + class mirror the Combat tab's SAN tiers.
    const tierMap = {
      healthy:  { label: 'Healthy',  cls: 's-healthy' },
      inShock:  { label: 'In Shock', cls: 's-shock' },
      insane:   { label: 'Insane',   cls: 's-insane' },
      broken:   { label: 'Broken',   cls: 's-broken' }
    };
    const tier = tierMap[san.status] || tierMap.healthy;
    const segCount = Math.min(san.max, 40);
    const segHtml = renderSanOverviewSegments(san.max, san.damage, segCount);
    return `
      <div class="state-tile">
        <div class="state-tile-head">
          <span class="state-tile-label">Sanity</span>
          <span class="state-tile-nums">${san.current}<span class="sep">/</span><span class="max">${san.max}</span></span>
        </div>
        <div class="state-bar">${segHtml}</div>
        <span class="state-tile-status ${tier.cls}">${escapeHtml(tier.label)}</span>
      </div>`;
  }

  function renderSanOverviewSegments(sanMax, damage, segCount) {
    // Same palette as Combat tab: blue (healthy) → yellow → orange → red.
    // Fully-red state past 3*max, matching the "broken floor" behavior.
    if (sanMax <= 0 || segCount <= 0) return '';
    const COLORS = { blue: '#4a6a9a', yellow: '#bdb247', orange: '#c87a3a', red: '#a63a3a' };
    const dmgPerSeg = sanMax / segCount;
    let html = '';
    for (let i = 1; i <= segCount; i++) {
      const rightDistance = segCount - i + 1;
      const base = (rightDistance - 1) * dmgPerSeg;
      let color;
      if (damage > 2 * sanMax + base)     color = COLORS.red;
      else if (damage > sanMax + base)    color = COLORS.orange;
      else if (damage > base)             color = COLORS.yellow;
      else                                color = COLORS.blue;
      html += `<span class="state-bar-seg" style="background:${color}"></span>`;
    }
    return html;
  }

  // ─── POWER TILE ───

  function renderPowerTile(power) {
    // Always renders — even if max is 0 (new character / power pool not
    // yet purchased). Shows a full empty bar so the tile is always present
    // on the overview grid, mirroring Body/Sanity which always show.
    const max = power.max || 0;
    const current = power.current || 0;
    const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
    // Inherit the Power Pool's actual display color (set in the Combat
    // tab via the color picker). Falls back to a sensible default if the
    // pool hasn't been configured yet. Keeps the two views visually in
    // sync so players can instantly recognize "this is my power bar".
    const color = (power.color && typeof power.color === 'string' && power.color.trim())
      ? power.color
      : '#6a4a9a';
    return `
      <div class="state-tile">
        <div class="state-tile-head">
          <span class="state-tile-label">Power</span>
          <span class="state-tile-nums">${fmt(current)}<span class="sep">/</span><span class="max">${fmt(max)}</span></span>
        </div>
        <div class="state-progress-bar">
          <div class="state-progress-fill" style="width:${pct}%;background:${escapeHtml(color)}"></div>
        </div>
      </div>`;
  }

  // ─── MOVEMENT TILE ───

  function renderMovementTile(result, ruleset) {
    // Pull any derived stat in the 'movement' group. Order preserved from
    // the ruleset so rule authors can shuffle display without code changes.
    const movementStats = (ruleset.derivedStats || [])
      .filter(def => def.group === 'movement')
      .map(def => result.stats.get(def.code))
      .filter(entry => entry && !entry.error && Number.isFinite(entry.value));
    if (movementStats.length === 0) return '';

    // Pull the current collapse-state Set from combat.js so Overview
    // items render with the same expanded/collapsed state as the Combat
    // tab cards. The togglePenaltyValueDisplay handler (wired to window)
    // flips the class on BOTH at the same time via data-code selector,
    // so we only need to read the Set here — we never mutate it.
    const collapsedSet = getCollapsedPenaltyValues();

    const items = movementStats.map(entry => {
      const { def, value } = entry;
      const valStr = fmt(value);
      const unit = def.unit ? `<span class="mi-unit">${escapeHtml(def.unit)}</span>` : '';
      const reduction = entry.penaltyValueReduction || 0;
      const hasStrain = reduction > 0;

      // Strain-reduced stat — emit both display variants and wire the
      // click handler so toggling the Overview item syncs with the same
      // toggle on the Combat tab (they share data-code + .penalty-collapsed).
      if (hasStrain) {
        const effective = Math.max(0, value - reduction);
        const effStr = fmt(effective);
        const redStr = fmt(reduction);
        const collapsed = collapsedSet.has(def.code);
        const collapsedCls = collapsed ? ' penalty-collapsed' : '';
        const expandedTip = `Penalty reduces to ${effStr}${def.unit ? ' ' + def.unit : ''}. Click to show effective.`;
        const effectiveTip = `Base ${valStr} reduced by ${redStr} Penalty. Click to show breakdown.`;
        return `
          <div class="state-movement-item clickable${collapsedCls}" data-code="${escapeHtml(def.code)}" title="${escapeHtml(def.description || '')}" onclick="togglePenaltyValueDisplay('${escapeHtml(def.code)}')">
            <span class="mi-label">${escapeHtml(def.name)}</span>
            <span class="mi-val">
              <span class="mi-expanded" title="${escapeHtml(expandedTip)}">${valStr} <span class="mi-penalty">− ${redStr}</span></span>
              <span class="mi-effective" title="${escapeHtml(effectiveTip)}">${effStr}</span>
              ${unit}
            </span>
          </div>`;
      }

      // Non-strain stat — plain read-only display, no click affordance.
      return `
        <div class="state-movement-item" title="${escapeHtml(def.description || '')}">
          <span class="mi-label">${escapeHtml(def.name)}</span>
          <span class="mi-val">${valStr} ${unit}</span>
        </div>`;
    }).join('');

    return `
      <div class="state-tile state-tile-wide">
        <div class="state-tile-head">
          <span class="state-tile-label">Movement</span>
        </div>
        <div class="state-movement-row">${items}</div>
      </div>`;
  }

  // ─── STRAIN TILE ───
  //
  // Full-width Penalty readout — also used inline on the Combat tab (top
  // of the tab, under Roll Calc). Big severity-tinted percent with a
  // labeled three-row breakdown: Pain / Stress / Others. Pain and Stress
  // are auto-calculated from damage; Others is a free-form list of named
  // ±% entries (Exposure, Encumbrance, etc.). The Others block is where
  // this card earns its name — it's a full CRUD editor for that list,
  // inline in the card.
  //
  function renderPenaltyTile(pain, stress, penalty, otherMods, canEdit) {
    if (!penalty) return '';
    const pct = penalty.percent;
    let pctColor;
    if (pct <= 0)      pctColor = '#666';
    else if (pct < 50) pctColor = '#a0c080';
    else if (pct < 75) pctColor = '#d8a860';
    else               pctColor = '#e07878';
    const painPct   = (pain && pain.finalPercent) || 0;
    const stressPct = (stress && stress.finalPercent) || 0;
    const encPct    = penalty.encumbrancePercent || 0;
    const otherPct  = penalty.otherPercent || 0;

    // Sign formatter for Others values.
    const fmtSigned = (n) => (n > 0 ? '+' + n : String(n));
    const otherSummaryPct = fmtSigned(otherPct);

    const mods = Array.isArray(otherMods) ? otherMods : [];

    // Each other-mod row: name input, ±value input, delete ×. Empty-state
    // message if no mods. + Add Modifier row at the bottom.
    let othersEditor = '';
    if (canEdit || mods.length > 0) {
      othersEditor += '<div class="state-penalty-others">';
      othersEditor += '<div class="state-penalty-others-head">';
      othersEditor += '<span class="state-penalty-others-title">Other modifiers</span>';
      othersEditor += `<span class="state-penalty-others-total">${escapeHtml(otherSummaryPct)}%</span>`;
      othersEditor += '</div>';

      if (mods.length === 0) {
        othersEditor += '<div class="state-penalty-others-empty">No other penalties. Add Exposure, drugged, restrained — anything that drags you down. (Encumbrance is managed on the Inventory tab.)</div>';
      } else {
        mods.forEach((m, i) => {
          const name = (m && m.name) || '';
          const val = (m && Number.isFinite(parseInt(m.value))) ? parseInt(m.value) : 0;
          othersEditor += `<div class="state-penalty-other-row">
            <input type="text" class="state-penalty-other-name" value="${escapeHtml(name)}" placeholder="Name (e.g. Exposure)" ${canEdit ? '' : 'readonly'} onchange="updateOtherModifier(${i}, 'name', this.value)">
            <input type="number" class="state-penalty-other-val" value="${val}" step="1" ${canEdit ? '' : 'readonly'} onchange="updateOtherModifier(${i}, 'value', this.value)">
            <span class="state-penalty-other-unit">%</span>
            ${canEdit ? `<span class="state-penalty-other-del" title="Remove modifier" onclick="deleteOtherModifier(${i})">×</span>` : '<span class="state-penalty-other-del-ph"></span>'}
          </div>`;
        });
      }

      if (canEdit) {
        othersEditor += '<div class="state-penalty-other-add-row">';
        othersEditor += '<button class="state-penalty-other-add-btn" onclick="addOtherModifier()">+ Add Modifier</button>';
        othersEditor += '</div>';
      }

      othersEditor += '</div>';
    }

    // Encumbrance row — read-only, locked like Pain/Stress. Editing
    // happens on the Inventory tab (CAP/ENC/LIFT cards + per-group
    // toggles). We give the row a lock icon and a "managed on Inventory
    // tab" tooltip so players know why it can't be edited here.
    const encTip = 'Encumbrance is auto-calculated from inventory weight vs CAP. Manage it on the Inventory tab.';
    // ENC row is formatted with one decimal if non-integer (matches
    // keepDecimals on the ENC stat def).
    const encDisplay = (Math.round(encPct) === encPct)
      ? `${encPct}%`
      : `${Math.round(encPct * 10) / 10}%`;

    return `
      <div class="state-tile state-tile-wide state-tile-penalty">
        <div class="state-tile-head">
          <span class="state-tile-label">Penalty</span>
          <span class="state-penalty-big" style="color:${pctColor}">${pct}%</span>
        </div>
        <div class="state-penalty-rows-inline">
          <div class="state-penalty-row">
            <span class="state-penalty-k">Pain</span>
            <span class="state-penalty-v">${painPct}%</span>
          </div>
          <div class="state-penalty-row">
            <span class="state-penalty-k">Stress</span>
            <span class="state-penalty-v">${stressPct}%</span>
          </div>
          <div class="state-penalty-row state-penalty-row-locked" title="${escapeHtml(encTip)}">
            <span class="state-penalty-k">Encumbrance <span class="state-penalty-lock">🔒</span></span>
            <span class="state-penalty-v">${encDisplay}</span>
          </div>
          <div class="state-penalty-row">
            <span class="state-penalty-k">Others</span>
            <span class="state-penalty-v">${escapeHtml(otherSummaryPct)}%</span>
          </div>
        </div>
        ${othersEditor}
      </div>`;
  }

  return {
    renderState,
    renderPenaltyTile
  };
}
