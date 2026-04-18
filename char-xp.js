// char-xp.js
// The XP / AP / Power Level bar shown in the character sheet header.
// Read-only for non-owners, editable for owners.
//
// Power levels come from the active ruleset — homebrew rulesets can
// redefine the scale entirely (rename tiers, change XP/AP conversion).
// We look up the current character's powerLevel in the ruleset's
// powerLevels array; if it's not found (e.g. the ruleset removed that
// tier), we fall back to the first entry so rendering still works.
//
// XP spent is calculated elsewhere; this module only renders and saves
// Power Level and max-value fields.

import { saveCharacter } from './char-firestore.js';

export function createXpBar(ctx) {
  // ctx shape:
  //   getCharData()  -> live charData
  //   getCanEdit()   -> boolean
  //   getCharId()    -> string
  //   getRuleset()   -> active ruleset object (has .powerLevels, .defaultPowerLevel)

  function getPowerLevel() {
    const charData = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    return charData.powerLevel || (ruleset && ruleset.defaultPowerLevel) || 'powerless';
  }

  function getPowerDef() {
    const ruleset = ctx.getRuleset();
    const levels = (ruleset && ruleset.powerLevels) || [];
    const current = getPowerLevel();
    return levels.find(p => p.value === current)
      || levels[0]
      || { value: 'powerless', label: 'Powerless', xpPerAp: 10 };
  }

  function renderPowerBar() {
    const charData = ctx.getCharData();
    const canEdit = ctx.getCanEdit();
    const ruleset = ctx.getRuleset();
    const levels = (ruleset && ruleset.powerLevels) || [];
    const bar = document.getElementById('char-power-bar');
    const pl = getPowerDef();
    const xpSpent = charData.xpSpent || 0;
    const maxXp = charData.maxXp || 0;
    const apSpent = charData.apSpent || 0;
    const maxAp = charData.maxAp || 0;

    if (canEdit) {
      const plOpts = levels.map(p =>
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
    const v = field === 'powerLevel' ? val : Math.max(0, parseInt(val) || 0);
    charData[field] = v;
    await saveCharacter(ctx.getCharId(), { [field]: v });
    renderPowerBar();
  }

  return { renderPowerBar, savePowerField };
}
