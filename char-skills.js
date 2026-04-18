// char-skills.js
// Handles the Skills section: Primary, Secondary, and Specialty skills.
//
// Design notes:
// - Primary skills are keyed by name (e.g. charData.skills.primary.Athletics = 4)
// - Secondary skills are an array of { name, under, value } where `under` is
//   the Primary skill they descend from. Cap = min(2× primary, 10).
// - Specialty skills are an array of { name, under, value } where `under` is
//   a Secondary skill. Cap = min(secondary + parent_primary, 10).
//
// Renaming a Secondary cascades: all Specialties whose `under` matches the old
// name are updated to the new name in the same Firestore write.
//
// Uses the factory pattern — createSkillsSection(ctx) is called once and
// returns a bundle of handlers that the main file wires into window.

import {
  SKILL_LABELS,
  PRIM_XP,
  SEC_XP,
  SPEC_XP
} from './char-constants.js';
import { saveCharacter } from './char-firestore.js';

export function createSkillsSection(ctx) {
  // ctx shape:
  //   getCharData()          -> the live charData object
  //   getCanEdit()           -> boolean
  //   getCharId()            -> string
  //   getPrimarySkillDefs()  -> array of { name, description } from the ruleset
  //   getSkillsEditMode()    -> boolean (is edit mode on?)
  //   setSkillsEditMode(v)   -> setter for the above
  //   saveXpSpent()          -> async: recompute and persist total XP

  // ─── VALUE LOOKUPS ───
  // Private helpers for computing caps on secondary and specialty skills.

  function getPrimaryVal(name) {
    const charData = ctx.getCharData();
    return ((charData.skills && charData.skills.primary) || {})[name] || 0;
  }

  function getSecondaryVal(name) {
    const charData = ctx.getCharData();
    const list = (charData.skills && charData.skills.secondary) || [];
    return (list.find(s => s.name === name) || { value: 0 }).value;
  }

  // ─── RENDERERS ───

  function buildSkillsSection() {
    renderPrimarySkills();
    renderSecondarySkills();
    renderSpecialtySkills();
    if (ctx.getCanEdit()) {
      document.getElementById('skills-edit-btn').style.display = 'inline';
    }
  }

  function renderPrimarySkills() {
    const charData = ctx.getCharData();
    const editMode = ctx.getSkillsEditMode();
    const defs = ctx.getPrimarySkillDefs();
    const grid = document.getElementById('primary-skills-grid');
    const primary = (charData.skills && charData.skills.primary) ? charData.skills.primary : {};

    grid.innerHTML = defs.map(s => {
      const val = primary[s.name] || 0;
      const cost = PRIM_XP[val] || 0;
      const levelText = SKILL_LABELS[val];
      const editor = editMode
        ? `<input type="number" class="skill-input" min="0" max="10" value="${val}" ` +
            `oninput="this.previousElementSibling.textContent=window.SKILL_LABELS_GLOBAL[Math.min(10,Math.max(0,parseInt(this.value)||0))];this.nextElementSibling.textContent=skillXpLabel(this.value,'p')" ` +
            `onchange="saveSkill('${s.name}',this.value)">` +
          `<span style="font-size:9px;color:#666;width:34px;flex-shrink:0;text-align:right">${cost}xp</span>`
        : `<span class="skill-val-display" style="width:20px;flex-shrink:0">${val}</span>`;
      return `<div class="skill-item">` +
        `<span class="skill-name" style="width:80px;flex-shrink:0">${s.name}</span>` +
        `<div class="skill-tooltip">${s.description}</div>` +
        `<span style="font-size:10px;color:#888;flex:1 1 0;min-width:0;max-width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${levelText}</span>` +
        editor +
      `</div>`;
    }).join('');
  }

  function renderSecondarySkills() {
    const charData = ctx.getCharData();
    const editMode = ctx.getSkillsEditMode();
    const canEdit = ctx.getCanEdit();
    const defs = ctx.getPrimarySkillDefs();
    const list = document.getElementById('secondary-skills-list');
    const secondary = (charData.skills && charData.skills.secondary) ? charData.skills.secondary : [];

    list.innerHTML = secondary.length === 0
      ? '<div style="grid-column:1/-1;color:#555;font-size:11px;font-style:italic;padding:4px 2px">None defined.</div>'
      : secondary.map((s, i) => {
          const cap = Math.min(10, 2 * getPrimaryVal(s.under));
          const cost = SEC_XP[s.value || 0] || 0;
          const levelText = SKILL_LABELS[s.value || 0];
          const safeName = (s.name || '').replace(/"/g, '&quot;');
          const nameBlock = editMode
            ? `<div style="display:flex;flex-direction:column;width:90px;flex-shrink:0;min-width:0;gap:2px">` +
                `<input type="text" value="${safeName}" onchange="renameSecSkill(${i},this.value)" style="background:#0a0a0a;border:1px solid #222;color:#e0e0e0;font-family:'Open Sans',sans-serif;font-size:11px;padding:2px 4px;border-radius:2px;outline:none;width:100%;box-sizing:border-box">` +
                `<span class="sec-skill-under">under ${s.under}</span>` +
              `</div>`
            : `<div style="display:flex;flex-direction:column;width:90px;flex-shrink:0;min-width:0">` +
                `<span class="skill-name">${s.name}</span>` +
                `<span class="sec-skill-under">under ${s.under}</span>` +
              `</div>`;
          const editor = editMode
            ? `<input type="number" class="skill-input" min="0" max="${cap}" value="${s.value || 0}" ` +
                `oninput="this.previousElementSibling.textContent=window.SKILL_LABELS_GLOBAL[Math.min(10,Math.max(0,parseInt(this.value)||0))];this.nextElementSibling.textContent=skillXpLabel(this.value,'s')" ` +
                `onchange="saveSecSkill(${i},this.value)" title="Max: min(2× ${s.under}, 10) = ${cap}">` +
              `<span style="font-size:9px;color:#666;width:34px;flex-shrink:0;text-align:right">${cost}xp</span>` +
              `<span class="mod-delete" onclick="deleteSecSkill(${i})">×</span>`
            : `<span class="skill-val-display" style="width:20px;flex-shrink:0">${s.value || 0}</span>`;
          return `<div class="skill-item">` +
            nameBlock +
            `<span style="font-size:10px;color:#888;flex:1 1 0;min-width:0;max-width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${levelText}</span>` +
            editor +
          `</div>`;
        }).join('');

    // The "add secondary" row includes a dropdown of Primary skills to attach under.
    if (canEdit && editMode) {
      document.getElementById('sec-skill-add-row').style.display = 'flex';
      document.getElementById('sec-skill-under').innerHTML = defs
        .map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    } else {
      document.getElementById('sec-skill-add-row').style.display = 'none';
    }

    // Specialty "under" dropdown depends on what Secondaries exist, so refresh it.
    updateSpecUnder();
  }

  function updateSpecUnder() {
    const charData = ctx.getCharData();
    const editMode = ctx.getSkillsEditMode();
    const canEdit = ctx.getCanEdit();
    const secondary = (charData.skills && charData.skills.secondary) ? charData.skills.secondary : [];
    if (canEdit && editMode) {
      document.getElementById('spec-skill-add-row').style.display = 'flex';
      document.getElementById('spec-skill-under').innerHTML = secondary.length > 0
        ? secondary.map(s => `<option value="${s.name}">${s.name}</option>`).join('')
        : '<option value="">No secondary skills yet</option>';
    } else {
      document.getElementById('spec-skill-add-row').style.display = 'none';
    }
  }

  function renderSpecialtySkills() {
    const charData = ctx.getCharData();
    const editMode = ctx.getSkillsEditMode();
    const list = document.getElementById('specialty-skills-list');
    const specialty = (charData.skills && charData.skills.specialty) ? charData.skills.specialty : [];
    const secondary = (charData.skills && charData.skills.secondary) || [];

    list.innerHTML = specialty.length === 0
      ? '<div style="grid-column:1/-1;color:#555;font-size:11px;font-style:italic;padding:4px 2px">None defined.</div>'
      : specialty.map((s, i) => {
          // Cap requires knowing the Secondary's own Primary parent.
          const secEntry = secondary.find(x => x.name === s.under) || { value: 0, under: '' };
          const cap = Math.min(10, getSecondaryVal(s.under) + getPrimaryVal(secEntry.under));
          const cost = SPEC_XP[s.value || 0] || 0;
          const levelText = SKILL_LABELS[s.value || 0];
          const safeName = (s.name || '').replace(/"/g, '&quot;');
          const nameBlock = editMode
            ? `<div style="display:flex;flex-direction:column;width:90px;flex-shrink:0;min-width:0;gap:2px">` +
                `<input type="text" value="${safeName}" onchange="renameSpecSkill(${i},this.value)" style="background:#0a0a0a;border:1px solid #222;color:#e0e0e0;font-family:'Open Sans',sans-serif;font-size:11px;padding:2px 4px;border-radius:2px;outline:none;width:100%;box-sizing:border-box">` +
                `<span class="sec-skill-under">under ${s.under}</span>` +
              `</div>`
            : `<div style="display:flex;flex-direction:column;width:90px;flex-shrink:0;min-width:0">` +
                `<span class="skill-name">${s.name}</span>` +
                `<span class="sec-skill-under">under ${s.under}</span>` +
              `</div>`;
          const editor = editMode
            ? `<input type="number" class="skill-input" min="0" max="${cap}" value="${s.value || 0}" ` +
                `oninput="this.previousElementSibling.textContent=window.SKILL_LABELS_GLOBAL[Math.min(10,Math.max(0,parseInt(this.value)||0))];this.nextElementSibling.textContent=skillXpLabel(this.value,'sp')" ` +
                `onchange="saveSpecSkill(${i},this.value)" title="Max: min(${s.under}+primary, 10) = ${cap}">` +
              `<span style="font-size:9px;color:#666;width:34px;flex-shrink:0;text-align:right">${cost}xp</span>` +
              `<span class="mod-delete" onclick="deleteSpecSkill(${i})">×</span>`
            : `<span class="skill-val-display" style="width:20px;flex-shrink:0">${s.value || 0}</span>`;
          return `<div class="skill-item">` +
            nameBlock +
            `<span style="font-size:10px;color:#888;flex:1 1 0;min-width:0;max-width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${levelText}</span>` +
            editor +
          `</div>`;
        }).join('');

    updateSpecUnder();
  }

  // ─── EDIT MODE TOGGLE ───

  function toggleSkillsEdit() {
    ctx.setSkillsEditMode(!ctx.getSkillsEditMode());
    document.getElementById('skills-edit-btn').textContent = ctx.getSkillsEditMode() ? 'Done' : 'Edit';
    renderPrimarySkills();
    renderSecondarySkills();
    renderSpecialtySkills();
  }

  // ─── PRIMARY SKILLS HANDLERS ───

  async function saveSkill(name, val) {
    const charData = ctx.getCharData();
    if (!charData.skills) charData.skills = {};
    if (!charData.skills.primary) charData.skills.primary = {};
    charData.skills.primary[name] = Math.max(0, Math.min(10, parseInt(val) || 0));
    await saveCharacter(ctx.getCharId(), { 'skills.primary': charData.skills.primary });
    await ctx.saveXpSpent();
    // Secondary and Specialty caps depend on Primary values, so re-render them.
    renderSecondarySkills();
    renderSpecialtySkills();
  }

  // ─── SECONDARY SKILLS HANDLERS ───

  async function addSecondarySkill() {
    const name = document.getElementById('sec-skill-name').value.trim();
    const under = document.getElementById('sec-skill-under').value;
    if (!name || !under) return;
    const charData = ctx.getCharData();
    if (!charData.skills) charData.skills = {};
    if (!charData.skills.secondary) charData.skills.secondary = [];
    charData.skills.secondary.push({ name, under, value: 0 });
    await saveCharacter(ctx.getCharId(), { 'skills.secondary': charData.skills.secondary });
    document.getElementById('sec-skill-name').value = '';
    renderSecondarySkills();
  }

  async function saveSecSkill(i, val) {
    const charData = ctx.getCharData();
    const sec = charData.skills.secondary[i];
    const cap = Math.min(10, 2 * getPrimaryVal(sec.under));
    const v = Math.max(0, Math.min(cap, parseInt(val) || 0));
    // Warn but don't error if user tried to go over cap.
    if (v < (parseInt(val) || 0)) {
      alert(`Secondary skill cannot exceed min(2× its Primary, 10). ${sec.under} = ${getPrimaryVal(sec.under)}, max = ${cap}.`);
    }
    sec.value = v;
    await saveCharacter(ctx.getCharId(), { 'skills.secondary': charData.skills.secondary });
    await ctx.saveXpSpent();
    renderSpecialtySkills();
  }

  async function renameSecSkill(i, val) {
    const name = (val || '').trim();
    if (!name) { alert('Skill name cannot be empty.'); renderSecondarySkills(); return; }
    const charData = ctx.getCharData();
    const oldName = charData.skills.secondary[i].name;
    charData.skills.secondary[i].name = name;
    // Cascade the rename to any specialties pointing at this secondary.
    (charData.skills.specialty || []).forEach(sp => {
      if (sp.under === oldName) sp.under = name;
    });
    await saveCharacter(ctx.getCharId(), {
      'skills.secondary': charData.skills.secondary,
      'skills.specialty': charData.skills.specialty || []
    });
    renderSecondarySkills();
    renderSpecialtySkills();
  }

  async function deleteSecSkill(i) {
    const charData = ctx.getCharData();
    charData.skills.secondary.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { 'skills.secondary': charData.skills.secondary });
    await ctx.saveXpSpent();
    renderSecondarySkills();
  }

  // ─── SPECIALTY SKILLS HANDLERS ───

  async function addSpecialtySkill() {
    const name = document.getElementById('spec-skill-name').value.trim();
    const under = document.getElementById('spec-skill-under').value;
    if (!name || !under) return;
    const charData = ctx.getCharData();
    if (!charData.skills) charData.skills = {};
    if (!charData.skills.specialty) charData.skills.specialty = [];
    charData.skills.specialty.push({ name, under, value: 0 });
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    document.getElementById('spec-skill-name').value = '';
    renderSpecialtySkills();
  }

  async function saveSpecSkill(i, val) {
    const charData = ctx.getCharData();
    const spec = charData.skills.specialty[i];
    const sec = (charData.skills.secondary || []).find(x => x.name === spec.under) || { value: 0, under: '' };
    const cap = Math.min(10, getSecondaryVal(spec.under) + getPrimaryVal(sec.under));
    const v = Math.max(0, Math.min(cap, parseInt(val) || 0));
    if (v < (parseInt(val) || 0)) {
      alert(`Specialty cannot exceed min(Secondary + Primary, 10). Max = ${cap}.`);
    }
    spec.value = v;
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    await ctx.saveXpSpent();
  }

  async function renameSpecSkill(i, val) {
    const name = (val || '').trim();
    if (!name) { alert('Skill name cannot be empty.'); renderSpecialtySkills(); return; }
    const charData = ctx.getCharData();
    charData.skills.specialty[i].name = name;
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    renderSpecialtySkills();
  }

  async function deleteSpecSkill(i) {
    const charData = ctx.getCharData();
    charData.skills.specialty.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    await ctx.saveXpSpent();
    renderSpecialtySkills();
  }

  return {
    // Orchestration
    buildSkillsSection,
    toggleSkillsEdit,

    // Individual renderers (some needed for cross-section refreshes)
    renderPrimarySkills, renderSecondarySkills, renderSpecialtySkills,

    // Primary
    saveSkill,

    // Secondary
    addSecondarySkill, saveSecSkill, renameSecSkill, deleteSecSkill,

    // Specialty
    addSpecialtySkill, saveSpecSkill, renameSpecSkill, deleteSpecSkill,
  };
}
