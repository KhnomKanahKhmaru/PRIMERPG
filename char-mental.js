// char-mental.js
// Handles the three subsections of the Mental block on the character sheet:
// Morals, Moral Obligations, and Mental Conditions (aka "Disorders" in
// the code). Each subsection has a read-only view, an edit view, and
// add/save/delete handlers that persist to Firestore.
//
// This module uses the factory pattern: call createMentalSection(ctx) once,
// where ctx provides getters for the pieces of shared state we need. The
// returned object is a bundle of render functions and event handlers that
// the caller wires into window so inline HTML handlers can reach them.

import {
  MORAL_SEVERITY,
  CONDITION_SEVERITY,
  OBLIGATION_SEVERITY
} from './char-constants.js';
import { severityLabel, severitySelectHtml } from './char-util.js';
import { saveCharacter } from './char-firestore.js';

export function createMentalSection(ctx) {
  // ctx shape:
  //   getCharData()         -> the live charData object (mutable)
  //   getCanEdit()          -> boolean
  //   getCharId()           -> string
  //   getAvailableRulesets() -> array of { name, morals } for the chip picker

  // Raw selectedMorals may be stored as plain strings (legacy format) or as
  // { name, severity } objects (new format). Always normalize to objects.
  function normalizeSelectedMorals() {
    return (ctx.getCharData().selectedMorals || [])
      .map(m => typeof m === 'string' ? { name: m, severity: 'Minor' } : m);
  }

  // ─── MORALS ───

  function renderMoralsView() {
    const selected = normalizeSelectedMorals();
    const display = document.getElementById('moral-cards-display');
    if (selected.length === 0) {
      display.innerHTML = '<div class="moral-empty">No morals selected.</div>';
      return;
    }
    display.innerHTML = selected.map(m =>
      `<div class="moral-card-item">` +
        `<div class="moral-card-top">` +
          `<span style="font-size:11px;color:#888;font-weight:500">` +
            severityLabel(m.severity, MORAL_SEVERITY) +
          `</span>` +
        `</div>` +
        `<div class="moral-card-name">${m.name}</div>` +
      `</div>`
    ).join('');
  }

  async function updateMoralSeverity(i, severity) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const selected = normalizeSelectedMorals();
    if (i >= 0 && i < selected.length) selected[i].severity = severity;
    charData.selectedMorals = selected;
    await saveCharacter(ctx.getCharId(), { selectedMorals: selected });
  }

  // Build the edit-mode UI: ruleset-grouped chips for available morals,
  // plus a severity picker for each currently-selected moral. Wildcard
  // entries (empty moral strings) render as a "+ Custom…" chip.
  function editMorals() {
    document.getElementById('morals-view').style.display = 'none';
    document.getElementById('morals-edit-btn').style.display = 'none';
    document.getElementById('morals-edit-mode').style.display = 'block';

    const selected = normalizeSelectedMorals();
    const selectedNames = selected.map(m => m.name);
    const rulesets = ctx.getAvailableRulesets();

    const chipsHtml = rulesets.map(rs => {
      let hasWildcard = false;
      const regularChips = rs.morals.map(m => {
        if (!m || !m.trim()) { hasWildcard = true; return ''; }
        const isSelected = selectedNames.includes(m);
        const escapedName = m.replace(/'/g, "\\'");
        return `<div class="moral-chip ${isSelected ? 'selected' : ''}" ` +
               `onclick="toggleMoral('${escapedName}',this)">${m}</div>`;
      }).filter(x => x).join('');
      const wildcardChip = hasWildcard
        ? `<div class="moral-chip" style="border-style:dashed;color:#888" ` +
          `onclick="addCustomMoral()">+ Custom…</div>`
        : '';
      return `<div class="moral-group">` +
               `<div class="moral-group-title">${rs.name}</div>` +
               `<div class="moral-chips">${regularChips}${wildcardChip}</div>` +
             `</div>`;
    }).join('');

    const severityHtml = selected.length === 0 ? '' :
      `<div style="margin-top:12px;border-top:1px solid #1a1a1a;padding-top:10px">` +
        `<div style="font-size:10px;color:#444;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Severity</div>` +
        selected.map((m, i) =>
          `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px;color:#888">` +
            severitySelectHtml(m.severity, `updateMoralSeverity(${i},this.value)`, MORAL_SEVERITY) +
            `<span>${m.name}</span>` +
            `<span class="mod-delete" onclick="removeMoralByIndex(${i})" style="margin-left:auto">×</span>` +
          `</div>`
        ).join('') +
      `</div>`;

    document.getElementById('morals-by-ruleset').innerHTML = chipsHtml + severityHtml;
  }

  async function addCustomMoral() {
    if (!ctx.getCanEdit()) return;
    const name = prompt('Enter custom moral (one word or short phrase):');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    const charData = ctx.getCharData();
    let selected = normalizeSelectedMorals();
    if (selected.some(m => m.name.toLowerCase() === trimmed.toLowerCase())) {
      alert('You already have that moral.');
      return;
    }
    selected.push({ name: trimmed, severity: 'Minor' });
    charData.selectedMorals = selected;
    await saveCharacter(ctx.getCharId(), { selectedMorals: selected });
    editMorals();
  }

  async function removeMoralByIndex(i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    let selected = normalizeSelectedMorals();
    selected.splice(i, 1);
    charData.selectedMorals = selected;
    await saveCharacter(ctx.getCharId(), { selectedMorals: selected });
    editMorals();
  }

  function doneMorals() {
    document.getElementById('morals-view').style.display = 'block';
    document.getElementById('morals-edit-btn').style.display = 'inline';
    document.getElementById('morals-edit-mode').style.display = 'none';
    renderMoralsView();
  }

  async function toggleMoral(moral, el) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    let selected = normalizeSelectedMorals();
    if (selected.some(m => m.name === moral)) {
      selected = selected.filter(m => m.name !== moral);
    } else {
      selected.push({ name: moral, severity: 'Minor' });
    }
    charData.selectedMorals = selected;
    await saveCharacter(ctx.getCharId(), { selectedMorals: selected });
    // Re-render the edit panel so the severity picker for the newly-added
    // moral appears (and disappears on untoggle) without needing to close
    // and reopen edit mode. editMorals() rebuilds the whole panel from
    // current state, including chip selection visuals.
    editMorals();
  }

  // ─── OBLIGATIONS ───

  function renderObligationsView() {
    const charData = ctx.getCharData();
    const canEdit = ctx.getCanEdit();
    const o = charData.moralObligations || [];
    document.getElementById('obligations-view').innerHTML = o.length === 0
      ? '<div style="color:#333;font-size:12px">None.</div>'
      : o.map((x, i) =>
          `<div class="obligation-entry">` +
            `<div class="entry-header">` +
              `<span style="font-size:12px;font-weight:600;color:#aaa">` +
                severityLabel(x.severity, OBLIGATION_SEVERITY) +
              `</span>` +
              (canEdit ? `<span class="entry-delete" onclick="deleteObligation(${i})">×</span>` : '') +
            `</div>` +
            `I have to <span class="entry-text">${x.obligation || '___'}</span> ` +
            `because I <span class="entry-text">${x.violation || '___'}</span>` +
          `</div>`
        ).join('');
  }

  function renderObligationsList() {
    const charData = ctx.getCharData();
    const o = charData.moralObligations || [];
    document.getElementById('obligations-list').innerHTML = o.length === 0
      ? '<div style="color:#333;font-size:12px;margin-bottom:8px">No entries yet.</div>'
      : o.map((x, i) =>
          `<div class="obligation-entry">` +
            `<div class="entry-header">` +
              severitySelectHtml(x.severity, `saveObligation(${i},'severity',this.value)`, OBLIGATION_SEVERITY) +
              `<span class="entry-delete" onclick="deleteObligation(${i})">×</span>` +
            `</div>` +
            `I have to <input class="entry-input" value="${x.obligation || ''}" placeholder="..." onchange="saveObligation(${i},'obligation',this.value)"> ` +
            `because I <input class="entry-input" value="${x.violation || ''}" placeholder="..." onchange="saveObligation(${i},'violation',this.value)">` +
          `</div>`
        ).join('');
  }

  function editObligations() {
    document.getElementById('obligations-view').style.display = 'none';
    document.getElementById('obligations-edit-btn').style.display = 'none';
    document.getElementById('obligations-edit-mode').style.display = 'block';
    document.getElementById('add-obligation-btn').style.display = 'inline-block';
    renderObligationsList();
  }

  function doneObligations() {
    document.getElementById('obligations-view').style.display = 'block';
    document.getElementById('obligations-edit-btn').style.display = 'inline';
    document.getElementById('obligations-edit-mode').style.display = 'none';
    renderObligationsView();
  }

  async function addObligation() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const o = charData.moralObligations || [];
    o.push({ obligation: '', violation: '', severity: 'Minor' });
    charData.moralObligations = o;
    await saveCharacter(ctx.getCharId(), { moralObligations: o });
    renderObligationsList();
  }

  async function saveObligation(i, f, v) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const o = charData.moralObligations || [];
    if (o[i]) o[i][f] = v;
    charData.moralObligations = o;
    await saveCharacter(ctx.getCharId(), { moralObligations: o });
  }

  async function deleteObligation(i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    charData.moralObligations.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { moralObligations: charData.moralObligations });
    renderObligationsList();
  }

  // ─── MENTAL CONDITIONS (stored as "mentalDisorders" for legacy reasons) ───

  function renderDisordersView() {
    const charData = ctx.getCharData();
    const canEdit = ctx.getCanEdit();
    const d = charData.mentalDisorders || [];
    document.getElementById('disorders-view').innerHTML = d.length === 0
      ? '<div style="color:#333;font-size:12px">None.</div>'
      : d.map((x, i) => {
          // Replace the word "Condition" in the severity label with the
          // condition's own name, so e.g. "Minor Cynophobia (−1 Difficulty / 1 Break Point)".
          const label = severityLabel(x.severity, CONDITION_SEVERITY)
            .replace('Condition', x.disorder || 'Condition');
          return `<div class="disorder-entry">` +
            `<div class="entry-header">` +
              `<span style="font-size:12px;font-weight:600;color:#aaa">${label}</span>` +
              (canEdit ? `<span class="entry-delete" onclick="deleteDisorder(${i})">×</span>` : '') +
            `</div>` +
            `I have <span class="entry-text">${x.disorder || '___'}</span> ` +
            `which means <span class="entry-text">${x.description || '___'}</span> ` +
            `and if triggered I might <span class="entry-text">${x.symptoms || '___'}</span>` +
          `</div>`;
        }).join('');
  }

  function renderDisordersList() {
    const charData = ctx.getCharData();
    const d = charData.mentalDisorders || [];
    document.getElementById('disorders-list').innerHTML = d.length === 0
      ? '<div style="color:#333;font-size:12px;margin-bottom:8px">No entries yet.</div>'
      : d.map((x, i) =>
          `<div class="disorder-entry">` +
            `<div class="entry-header">` +
              severitySelectHtml(x.severity, `saveDisorder(${i},'severity',this.value)`, CONDITION_SEVERITY) +
              `<span class="entry-header-type">${x.disorder || 'Condition'}</span>` +
              `<span class="entry-delete" onclick="deleteDisorder(${i})">×</span>` +
            `</div>` +
            `I have <input class="entry-input" value="${x.disorder || ''}" placeholder="condition name..." onchange="saveDisorder(${i},'disorder',this.value);rerenderDisorderHeader(${i},this.value)"> ` +
            `which means <input class="entry-input" value="${x.description || ''}" placeholder="..." onchange="saveDisorder(${i},'description',this.value)"> ` +
            `and if triggered I might <input class="entry-input" value="${x.symptoms || ''}" placeholder="..." onchange="saveDisorder(${i},'symptoms',this.value)">` +
          `</div>`
        ).join('');
  }

  // Live-update the badge in the entry header as the user types a condition name
  function rerenderDisorderHeader(i, val) {
    const headers = document.querySelectorAll('#disorders-list .entry-header-type');
    if (headers[i]) headers[i].textContent = val || 'Condition';
  }

  function editDisorders() {
    document.getElementById('disorders-view').style.display = 'none';
    document.getElementById('disorders-edit-btn').style.display = 'none';
    document.getElementById('disorders-edit-mode').style.display = 'block';
    document.getElementById('add-disorder-btn').style.display = 'inline-block';
    renderDisordersList();
  }

  function doneDisorders() {
    document.getElementById('disorders-view').style.display = 'block';
    document.getElementById('disorders-edit-btn').style.display = 'inline';
    document.getElementById('disorders-edit-mode').style.display = 'none';
    renderDisordersView();
  }

  async function addDisorder() {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const d = charData.mentalDisorders || [];
    d.push({ disorder: '', description: '', symptoms: '', severity: 'Minor' });
    charData.mentalDisorders = d;
    await saveCharacter(ctx.getCharId(), { mentalDisorders: d });
    renderDisordersList();
  }

  async function saveDisorder(i, f, v) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const d = charData.mentalDisorders || [];
    if (d[i]) d[i][f] = v;
    charData.mentalDisorders = d;
    await saveCharacter(ctx.getCharId(), { mentalDisorders: d });
  }

  async function deleteDisorder(i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    charData.mentalDisorders.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { mentalDisorders: charData.mentalDisorders });
    renderDisordersList();
  }

  // Public interface
  return {
    // View renderers — called by main file after load & mode changes
    renderMoralsView, renderObligationsView, renderDisordersView,

    // Edit-mode toggles (wired to window for inline onclick handlers)
    editMorals, doneMorals,
    editObligations, doneObligations,
    editDisorders, doneDisorders,

    // Morals handlers
    updateMoralSeverity, addCustomMoral, removeMoralByIndex, toggleMoral,

    // Obligations handlers
    addObligation, saveObligation, deleteObligation,

    // Conditions handlers
    addDisorder, saveDisorder, deleteDisorder, rerenderDisorderHeader,
  };
}
