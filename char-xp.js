// char-xp.js
// The XP / AP / Power Level bar shown in the character sheet header.
// Read-only for non-owners, editable for owners (Power Level dropdown,
// Max XP, Max AP).
//
// XP spent is calculated elsewhere from stat and skill values; this module
// only renders and saves Power Level and max-value fields. The main file
// calls xpBar.renderPowerBar() whenever xpSpent changes.

import { POWER_LEVELS } from './char-constants.js';
import { saveCharacter } from './char-firestore.js';

export function createXpBar(ctx) {
  // ctx shape:
  //   getCharData()  -> the live charData object
  //   getCanEdit()   -> boolean
  //   getCharId()    -> string

  function getPowerLevel() {
    return ctx.getCharData().powerLevel || 'powerless';
  }

  function getPowerDef() {
    return POWER_LEVELS.find(p => p.value === getPowerLevel()) || POWER_LEVELS[0];
  }

  function renderPowerBar() {
    const charData = ctx.getCharData();
    const canEdit = ctx.getCanEdit();
    const bar = document.getElementById('char-power-bar');
    const pl = getPowerDef();
    const xpSpent = charData.xpSpent || 0;
    const maxXp = charData.maxXp || 0;
    const apSpent = charData.apSpent || 0;
    const maxAp = charData.maxAp || 0;

    if (canEdit) {
      const plOpts = POWER_LEVELS.map(p =>
        `<option value="${p.value}" ${p.value === getPowerLevel() ? 'selected' : ''}>` +
        `${p.label} (${p.xpPerAp} XP/AP)</option>`
      ).join('');
      bar.innerHTML =
        `<div class="power-pill">` +
          `<select class="power-select" onchange="savePowerField('powerLevel',this.value)">${plOpts}</select>` +
        `</div>` +
        `<div class="power-pill">` +
          `<span class="pill-label">XP</span>` +
          `<span class="pill-val">${xpSpent}</span>` +
          `<span class="power-sep">/</span>` +
          `<input type="number" class="power-num-input" value="${maxXp}" min="0" ` +
          `onchange="savePowerField('maxXp',this.value)" title="Max XP">` +
        `</div>` +
        `<div class="power-pill">` +
          `<span class="pill-label">AP</span>` +
          `<span class="pill-val">${apSpent}</span>` +
          `<span class="power-sep">/</span>` +
          `<input type="number" class="power-num-input" value="${maxAp}" min="0" ` +
          `onchange="savePowerField('maxAp',this.value)" title="Max AP">` +
        `</div>`;
    } else {
      bar.innerHTML =
        `<div class="power-pill">` +
          `<span class="pill-val">${pl.label}</span>` +
          `<span class="pill-sub">(${pl.xpPerAp} XP/AP)</span>` +
        `</div>` +
        `<div class="power-pill">` +
          `<span class="pill-label">XP</span>` +
          `<span class="pill-val">${xpSpent} / ${maxXp}</span>` +
        `</div>` +
        `<div class="power-pill">` +
          `<span class="pill-label">AP</span>` +
          `<span class="pill-val">${apSpent} / ${maxAp}</span>` +
        `</div>`;
    }
  }

  async function savePowerField(field, val) {
    const charData = ctx.getCharData();
    // powerLevel is a string key; everything else is a non-negative int.
    const v = field === 'powerLevel' ? val : Math.max(0, parseInt(val) || 0);
    charData[field] = v;
    await saveCharacter(ctx.getCharId(), { [field]: v });
    renderPowerBar();
  }

  return { renderPowerBar, savePowerField };
}