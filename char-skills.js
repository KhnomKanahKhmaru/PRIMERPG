// char-skills.js
// Handles the Skills section: Primary, Secondary, and Specialty skills.
//
// Design notes:
// - Primary skills are keyed by name (e.g. charData.skills.primary.Athletics = 4)
// - Secondary skills are an array of { name, under, value } where `under` is
//   the Primary skill they descend from. Cap = min(2× primary, skillMax).
// - Specialty skills are an array of { name, under, value } where `under` is
//   a Secondary skill. Cap = min(secondary + parent_primary, skillMax).
//
// XP cost tables and the skill cap come from the active ruleset. A
// homebrew ruleset can make skills cheaper, more expensive, or change
// the top level (e.g. skillMax=20 for a "cosmic" game).
//
// Skill level labels (0–10 or whatever) still come from char-constants —
// those are baked into the PRIME fiction. If a ruleset exceeds the
// label array's length, the highest label is reused.

import { SKILL_LABELS } from './char-constants.js';
import { saveCharacter } from './char-firestore.js';

export function createSkillsSection(ctx) {
  // ctx shape:
  //   getCharData()          -> live charData
  //   getCanEdit()           -> boolean
  //   getCharId()            -> string
  //   getPrimarySkillDefs()  -> array of { name, description }
  //   getSkillsEditMode()    -> boolean
  //   setSkillsEditMode(v)   -> setter
  //   saveXpSpent()          -> async
  //   getRuleset()           -> active ruleset

  // ─── RULESET-DRIVEN HELPERS ───

  function getSkillMax() {
    const rs = ctx.getRuleset();
    return (rs && rs.skillMax) || 10;
  }

  function getPrimXpAt(v) {
    const rs = ctx.getRuleset();
    const table = (rs && rs.primarySkillXp) || [];
    return table[v] || 0;
  }

  function getSecXpAt(v) {
    const rs = ctx.getRuleset();
    const table = (rs && rs.secondarySkillXp) || [];
    return table[v] || 0;
  }

  function getSpecXpAt(v) {
    const rs = ctx.getRuleset();
    const table = (rs && rs.specialtySkillXp) || [];
    return table[v] || 0;
  }

  // Label lookup — if the ruleset allows more levels than the label
  // array defines, pin to the last label.
  function getSkillLabelAt(v) {
    return SKILL_LABELS[Math.min(v, SKILL_LABELS.length - 1)] || '';
  }

  // ─── VALUE LOOKUPS ───

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
    const skillMax = getSkillMax();

    grid.innerHTML = defs.map(s => {
      const val = primary[s.name] || 0;
      const cost = getPrimXpAt(val);
      const levelText = getSkillLabelAt(val);
      const editor = editMode
        ? `<input type="number" class="skill-input" min="0" max="${skillMax}" value="${val}" ` +
            `oninput="this.previousElementSibling.textContent=window.skillLabelAt(parseInt(this.value)||0);this.nextElementSibling.textContent=window.skillXpLabel(this.value,'p')" ` +
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
    const skillMax = getSkillMax();
    const list = document.getElementById('secondary-skills-list');
    const secondary = (charData.skills && charData.skills.secondary) ? charData.skills.secondary : [];

    list.innerHTML = secondary.length === 0
      ? '<div style="grid-column:1/-1;color:#555;font-size:11px;font-style:italic;padding:4px 2px">None defined.</div>'
      : secondary.map((s, i) => {
          const cap = Math.min(skillMax, 2 * getPrimaryVal(s.under));
          const cost = getSecXpAt(s.value || 0);
          const levelText = getSkillLabelAt(s.value || 0);
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
                `oninput="this.previousElementSibling.textContent=window.skillLabelAt(parseInt(this.value)||0);this.nextElementSibling.textContent=window.skillXpLabel(this.value,'s')" ` +
                `onchange="saveSecSkill(${i},this.value)" title="Max: min(2× ${s.under}, ${skillMax}) = ${cap}">` +
              `<span style="font-size:9px;color:#666;width:34px;flex-shrink:0;text-align:right">${cost}xp</span>` +
              `<span class="mod-delete" onclick="deleteSecSkill(${i})">×</span>`
            : `<span class="skill-val-display" style="width:20px;flex-shrink:0">${s.value || 0}</span>`;
          // Hover tooltip — shown when description is set. Same
          // visual language as primary-skill tooltips. In edit mode,
          // the tooltip is replaced by an inline description textarea
          // so the author can type/edit without leaving the row. The
          // textarea sits OUTSIDE the hover-clip issue because edit
          // mode shows it inline, not as a popup.
          const safeDesc = (s.description || '').replace(/"/g, '&quot;');
          const descBlock = editMode
            ? `<textarea class="skill-desc-edit" rows="2"
                          placeholder="Description (optional) — shown as hover tooltip."
                          onchange="updateSecSkillDescription(${i},this.value)">${escapeText(s.description || '')}</textarea>`
            : (s.description
                ? `<div class="skill-tooltip">${escapeText(s.description)}</div>`
                : '');
          return `<div class="skill-item${editMode ? ' skill-item-editing' : ''}">` +
            nameBlock +
            descBlock +
            `<span style="font-size:10px;color:#888;flex:1 1 0;min-width:0;max-width:100%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${levelText}</span>` +
            editor +
          `</div>`;
        }).join('');

    if (canEdit && editMode) {
      document.getElementById('sec-skill-add-row').style.display = 'flex';
      document.getElementById('sec-skill-under').innerHTML = defs
        .map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    } else {
      document.getElementById('sec-skill-add-row').style.display = 'none';
    }

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
    const skillMax = getSkillMax();
    const list = document.getElementById('specialty-skills-list');
    const specialty = (charData.skills && charData.skills.specialty) ? charData.skills.specialty : [];
    const secondary = (charData.skills && charData.skills.secondary) || [];

    list.innerHTML = specialty.length === 0
      ? '<div style="grid-column:1/-1;color:#555;font-size:11px;font-style:italic;padding:4px 2px">None defined.</div>'
      : specialty.map((s, i) => {
          const secEntry = secondary.find(x => x.name === s.under) || { value: 0, under: '' };
          const cap = Math.min(skillMax, getSecondaryVal(s.under) + getPrimaryVal(secEntry.under));
          const cost = getSpecXpAt(s.value || 0);
          const levelText = getSkillLabelAt(s.value || 0);
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
                `oninput="this.previousElementSibling.textContent=window.skillLabelAt(parseInt(this.value)||0);this.nextElementSibling.textContent=window.skillXpLabel(this.value,'sp')" ` +
                `onchange="saveSpecSkill(${i},this.value)" title="Max: min(${s.under}+primary, ${skillMax}) = ${cap}">` +
              `<span style="font-size:9px;color:#666;width:34px;flex-shrink:0;text-align:right">${cost}xp</span>` +
              `<span class="mod-delete" onclick="deleteSpecSkill(${i})">×</span>`
            : `<span class="skill-val-display" style="width:20px;flex-shrink:0">${s.value || 0}</span>`;
          const descBlock = editMode
            ? `<textarea class="skill-desc-edit" rows="2"
                          placeholder="Description (optional) — shown as hover tooltip."
                          onchange="updateSpecSkillDescription(${i},this.value)">${escapeText(s.description || '')}</textarea>`
            : (s.description
                ? `<div class="skill-tooltip">${escapeText(s.description)}</div>`
                : '');
          return `<div class="skill-item${editMode ? ' skill-item-editing' : ''}">` +
            nameBlock +
            descBlock +
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
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.skills) charData.skills = {};
    if (!charData.skills.primary) charData.skills.primary = {};
    charData.skills.primary[name] = Math.max(0, Math.min(getSkillMax(), parseInt(val) || 0));
    await saveCharacter(ctx.getCharId(), { 'skills.primary': charData.skills.primary });
    await ctx.saveXpSpent();
    renderSecondarySkills();
    renderSpecialtySkills();
  }

  // ─── SECONDARY SKILLS HANDLERS ───

  async function addSecondarySkill() {
    if (!ctx.getCanEdit()) return;
    const name = document.getElementById('sec-skill-name').value.trim();
    const under = document.getElementById('sec-skill-under').value;
    if (!name || !under) return;
    // Optional description from the add row — falls back to empty
    // string if the input isn't present or the user didn't type one.
    const descEl = document.getElementById('sec-skill-desc');
    const description = descEl ? descEl.value.trim() : '';
    const charData = ctx.getCharData();
    if (!charData.skills) charData.skills = {};
    if (!charData.skills.secondary) charData.skills.secondary = [];
    charData.skills.secondary.push({ name, under, value: 0, description });
    await saveCharacter(ctx.getCharId(), { 'skills.secondary': charData.skills.secondary });
    document.getElementById('sec-skill-name').value = '';
    if (descEl) descEl.value = '';
    renderSecondarySkills();
  }

  async function saveSecSkill(i, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const skillMax = getSkillMax();
    const sec = charData.skills.secondary[i];
    const cap = Math.min(skillMax, 2 * getPrimaryVal(sec.under));
    const v = Math.max(0, Math.min(cap, parseInt(val) || 0));
    if (v < (parseInt(val) || 0)) {
      alert(`Secondary skill cannot exceed min(2× its Primary, ${skillMax}). ${sec.under} = ${getPrimaryVal(sec.under)}, max = ${cap}.`);
    }
    sec.value = v;
    await saveCharacter(ctx.getCharId(), { 'skills.secondary': charData.skills.secondary });
    await ctx.saveXpSpent();
    renderSpecialtySkills();
  }

  async function renameSecSkill(i, val) {
    if (!ctx.getCanEdit()) return;
    const name = (val || '').trim();
    if (!name) { alert('Skill name cannot be empty.'); renderSecondarySkills(); return; }
    const charData = ctx.getCharData();
    const oldName = charData.skills.secondary[i].name;
    charData.skills.secondary[i].name = name;
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
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    charData.skills.secondary.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { 'skills.secondary': charData.skills.secondary });
    await ctx.saveXpSpent();
    renderSecondarySkills();
  }

  // Update the description of a secondary skill. Description is a
  // free-text string the player authors when creating or editing the
  // skill — shown as a hover tooltip on the skill row (same visual
  // language as primary skills' ruleset-authored descriptions). Empty
  // string is valid and stored as-is; it means "no description, no
  // tooltip".
  async function updateSecSkillDescription(i, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.skills || !charData.skills.secondary || !charData.skills.secondary[i]) return;
    charData.skills.secondary[i].description = (typeof val === 'string') ? val : '';
    await saveCharacter(ctx.getCharId(), { 'skills.secondary': charData.skills.secondary });
    // No re-render — the textarea keeps its own content, and the
    // tooltip only matters next time the player hovers.
  }

  // ─── SPECIALTY SKILLS HANDLERS ───

  async function addSpecialtySkill() {
    if (!ctx.getCanEdit()) return;
    const name = document.getElementById('spec-skill-name').value.trim();
    const under = document.getElementById('spec-skill-under').value;
    if (!name || !under) return;
    const descEl = document.getElementById('spec-skill-desc');
    const description = descEl ? descEl.value.trim() : '';
    const charData = ctx.getCharData();
    if (!charData.skills) charData.skills = {};
    if (!charData.skills.specialty) charData.skills.specialty = [];
    charData.skills.specialty.push({ name, under, value: 0, description });
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    document.getElementById('spec-skill-name').value = '';
    if (descEl) descEl.value = '';
    renderSpecialtySkills();
  }

  async function saveSpecSkill(i, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const skillMax = getSkillMax();
    const spec = charData.skills.specialty[i];
    const sec = (charData.skills.secondary || []).find(x => x.name === spec.under) || { value: 0, under: '' };
    const cap = Math.min(skillMax, getSecondaryVal(spec.under) + getPrimaryVal(sec.under));
    const v = Math.max(0, Math.min(cap, parseInt(val) || 0));
    if (v < (parseInt(val) || 0)) {
      alert(`Specialty cannot exceed min(Secondary + Primary, ${skillMax}). Max = ${cap}.`);
    }
    spec.value = v;
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    await ctx.saveXpSpent();
  }

  async function renameSpecSkill(i, val) {
    if (!ctx.getCanEdit()) return;
    const name = (val || '').trim();
    if (!name) { alert('Skill name cannot be empty.'); renderSpecialtySkills(); return; }
    const charData = ctx.getCharData();
    charData.skills.specialty[i].name = name;
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    renderSpecialtySkills();
  }

  async function deleteSpecSkill(i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    charData.skills.specialty.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
    await ctx.saveXpSpent();
    renderSpecialtySkills();
  }

  // Same pattern as updateSecSkillDescription — stores a free-text
  // description on the specialty skill for hover display.
  async function updateSpecSkillDescription(i, val) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    if (!charData.skills || !charData.skills.specialty || !charData.skills.specialty[i]) return;
    charData.skills.specialty[i].description = (typeof val === 'string') ? val : '';
    await saveCharacter(ctx.getCharId(), { 'skills.specialty': charData.skills.specialty });
  }

  return {
    buildSkillsSection, toggleSkillsEdit,
    renderPrimarySkills, renderSecondarySkills, renderSpecialtySkills,
    saveSkill,
    addSecondarySkill, saveSecSkill, renameSecSkill, deleteSecSkill,
    addSpecialtySkill, saveSpecSkill, renameSpecSkill, deleteSpecSkill,
    // Description text for player-authored skills (secondary + specialty).
    // Primary skill descriptions live in the ruleset and are handled by
    // the descriptions module instead — these are for the skills the
    // player themselves created on their sheet.
    updateSecSkillDescription, updateSpecSkillDescription,
  };
}

// Small HTML-text escape helper — used for description blocks where
// content flows into inline HTML. Called enough times below to warrant
// a module-level helper rather than inlining at each site.
function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
