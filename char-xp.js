// char-xp.js
// Renders the XP / AP economy pill at the top-right of the Overview
// section. Read-only for non-owners, editable for owners via a modal.
//
// Economy model (new — replaces the legacy Power Level system):
//   • Total XP = charData.maxXp (player edits directly)
//       The total XP earned from creation + any GM awards. NOT
//       decremented when XP is spent — "spent" is a derived count.
//   • Total AP = charData.maxAp + charData.apFromXp
//       maxAp    = AP earned directly via play (player edits)
//       apFromXp = AP gained by spending XP at ruleset.xpToApRate
//   • XP spent = stat/skill/etc. costs + (apFromXp × xpToApRate)
//   • AP spent = sum of Ability AP costs (computed by character.html)
//   • Remaining = Total − Spent (negative ⇒ overspent, shown red)

import { saveCharacter } from './char-firestore.js';

export function createXpBar(ctx) {
  // ctx shape:
  //   getCharData()    -> live charData
  //   getCanEdit()     -> boolean
  //   getCharId()      -> string
  //   getRuleset()     -> active ruleset (startingXp/AP, xpToApRate)
  //   getXpSpent()     -> base XP spent (excluding apFromXp conversion)
  //   getApSpent()     -> AP spent on Abilities
  //   onEconomyChange()-> optional, called after save so other UIs
  //                      (Ability budget pill etc.) can re-render

  function getEconomy() {
    const charData = ctx.getCharData() || {};
    const ruleset = ctx.getRuleset() || {};
    const startingXp = Number.isFinite(ruleset.startingXp) ? ruleset.startingXp : 0;
    const startingAp = Number.isFinite(ruleset.startingAp) ? ruleset.startingAp : 0;
    const rate = Math.max(1, Math.floor(ruleset.xpToApRate || 3));

    // maxXp / maxAp are PLAYER-EDITABLE totals. Default to ruleset
    // starting values for fresh characters that haven't opened the
    // edit modal yet — the field will be undefined on those, and we
    // synthesize the starting value so the display isn't a sad zero.
    const maxXp = Number.isFinite(charData.maxXp) ? charData.maxXp : startingXp;
    const maxAp = Number.isFinite(charData.maxAp) ? charData.maxAp : startingAp;
    const apFromXp = Number.isFinite(charData.apFromXp) ? charData.apFromXp : 0;

    const xpSpentBase = (typeof ctx.getXpSpent === 'function') ? (ctx.getXpSpent() || 0) : 0;
    const apSpent     = (typeof ctx.getApSpent === 'function') ? (ctx.getApSpent() || 0) : 0;

    // XP spent ledger includes the XP burned to buy AP via conversion.
    const xpSpentTotal = xpSpentBase + (apFromXp * rate);

    const totalAp = maxAp + apFromXp;
    const xpRemaining = maxXp - xpSpentTotal;
    const apRemaining = totalAp - apSpent;

    return {
      maxXp, maxAp, apFromXp, totalAp,
      xpSpent: xpSpentTotal, apSpent,
      xpRemaining, apRemaining,
      rate, startingXp, startingAp
    };
  }

  function renderPowerBar() {
    const bar = document.getElementById('char-xp-bar');
    if (!bar) return;
    const e = getEconomy();
    const canEdit = ctx.getCanEdit();

    // Build one pill: always show "spent / total" as the main row,
    // then a sub-line indicating remaining (green) or overspent (red).
    // Even when remaining is 0 we render the sub-line so the layout
    // stays consistent; "0 remaining" reads cleanly as a balanced state.
    function pill(label, spent, total, remaining) {
      const over = remaining < 0;
      const sub = over
        ? `<span class="xp-pill-sub xp-pill-sub-over">overspent by ${-remaining}</span>`
        : `<span class="xp-pill-sub xp-pill-sub-rem">${remaining} remaining</span>`;
      return `
        <div class="xp-pill-row${over ? ' xp-pill-row-over' : ''}">
          <span class="xp-pill-label">${label}</span>
          <div class="xp-pill-stack">
            <span class="xp-pill-vals"><span class="xp-pill-spent">${spent}</span><span class="xp-pill-sep">/</span><span class="xp-pill-total">${total}</span></span>
            ${sub}
          </div>
        </div>`;
    }

    const editBtn = canEdit
      ? `<button class="xp-pill-edit" onclick="window.openXpEditModal()" title="Edit XP and AP totals">✎</button>`
      : '';

    bar.innerHTML = `
      ${pill('XP', e.xpSpent, e.maxXp, e.xpRemaining)}
      ${pill('AP', e.apSpent, e.totalAp, e.apRemaining)}
      ${editBtn}
    `;
  }

  // ── EDIT MODAL ──
  function openXpEditModal() {
    if (!ctx.getCanEdit()) return;
    const e = getEconomy();
    const overlay = document.getElementById('xp-edit-overlay');
    if (!overlay) return;

    const xpInput  = document.getElementById('xp-edit-maxXp');
    const apInput  = document.getElementById('xp-edit-maxAp');
    const buyInput = document.getElementById('xp-edit-buyAp');
    const buyHint  = document.getElementById('xp-edit-buyAp-hint');
    const totalsHint = document.getElementById('xp-edit-totals-hint');

    xpInput.value = e.maxXp;
    apInput.value = e.maxAp;
    buyInput.value = 0;

    function refreshHints() {
      const buy = Math.max(0, parseInt(buyInput.value, 10) || 0);
      const xpCost = buy * e.rate;
      buyHint.textContent = buy > 0
        ? `${buy} AP × ${e.rate} XP = ${xpCost} XP will be deducted`
        : `Rate: ${e.rate} XP = 1 AP`;
      const newMaxXp = Math.max(0, parseInt(xpInput.value, 10) || 0);
      const newMaxAp = Math.max(0, parseInt(apInput.value, 10) || 0);
      const newApFromXp = e.apFromXp + buy;
      const newXpSpent = (e.xpSpent - e.apFromXp * e.rate) + (newApFromXp * e.rate);
      const xpRem = newMaxXp - newXpSpent;
      const apRem = (newMaxAp + newApFromXp) - e.apSpent;
      const xpOk = xpRem >= 0;
      const apOk = apRem >= 0;
      totalsHint.innerHTML =
        `<div>Total XP: <strong>${newMaxXp}</strong>, Spent: ${newXpSpent}, ` +
        `<span style="color:${xpOk ? '#8c8' : '#e66'}">${xpOk ? 'Remaining' : 'Overspent'}: ${Math.abs(xpRem)}</span></div>` +
        `<div>Total AP: <strong>${newMaxAp + newApFromXp}</strong> (${newMaxAp} earned + ${newApFromXp} bought), Spent: ${e.apSpent}, ` +
        `<span style="color:${apOk ? '#8c8' : '#e66'}">${apOk ? 'Remaining' : 'Overspent'}: ${Math.abs(apRem)}</span></div>`;
    }

    xpInput.oninput = refreshHints;
    apInput.oninput = refreshHints;
    buyInput.oninput = refreshHints;
    refreshHints();

    overlay.style.display = 'flex';
  }

  function closeXpEditModal() {
    const overlay = document.getElementById('xp-edit-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function saveXpEditModal() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const e = getEconomy();
    const xpInput  = document.getElementById('xp-edit-maxXp');
    const apInput  = document.getElementById('xp-edit-maxAp');
    const buyInput = document.getElementById('xp-edit-buyAp');
    const newMaxXp = Math.max(0, parseInt(xpInput.value, 10) || 0);
    const newMaxAp = Math.max(0, parseInt(apInput.value, 10) || 0);
    const buyAp = Math.max(0, parseInt(buyInput.value, 10) || 0);
    const newApFromXp = e.apFromXp + buyAp;

    const updates = {
      maxXp: newMaxXp,
      maxAp: newMaxAp,
      apFromXp: newApFromXp
    };
    Object.assign(charData, updates);
    await saveCharacter(ctx.getCharId(), updates);

    closeXpEditModal();
    renderPowerBar();
    if (typeof ctx.onEconomyChange === 'function') ctx.onEconomyChange();
  }

  // Expose modal handlers as window globals for inline onclick attrs.
  window.openXpEditModal  = openXpEditModal;
  window.closeXpEditModal = closeXpEditModal;
  window.saveXpEditModal  = saveXpEditModal;

  // Legacy alias — older callsites may still hit this. Power Level
  // field is dropped silently; other fields go through.
  async function savePowerField(field, val) {
    if (!ctx.getCanEdit()) return;
    if (field === 'powerLevel') return;
    const charData = ctx.getCharData();
    const v = Math.max(0, parseInt(val, 10) || 0);
    charData[field] = v;
    await saveCharacter(ctx.getCharId(), { [field]: v });
    renderPowerBar();
    if (typeof ctx.onEconomyChange === 'function') ctx.onEconomyChange();
  }

  return { renderPowerBar, savePowerField };
}
