// char-conditions.js
//
// Conditions section — Physical / Mental ailments, traumas, disorders,
// diseases, whatever ongoing state needs tracking. Lives on the Overview
// tab in the State of Things grid, directly under the Penalty tile.
//
// Data model (mirrors inventory's snapshot-first pattern so promoting
// a one-off to the personal catalogue is cheap):
//
//   charData.conditions = {
//     physical: [entry, ...],
//     mental:   [entry, ...]
//   }
//
//   entry = {
//     id:        'cond_<rand>',     // per-instance unique id
//     defId:     'cond_xxx' | null, // ref into ruleset preset OR null (one-off)
//     defKind:   'condition',
//     scale:     'minor'|'moderate'|'major'|'massive'|'monumental'|'mega'|'mythical'|'',
//     notes:     string,            // per-instance GM/player notes
//     snapshot:  { name, description, system }
//   }
//
// Snapshot is the authoritative source for display data, same as on
// inventory entries. Preset-linked entries copy the preset's fields
// into snapshot when added; editing the preset later doesn't retroac-
// tively change already-added entries (this matches how inventory
// handles it and is what players expect — "what's on my sheet is
// mine").
//
// ctx shape:
//   getCharId()   → doc id
//   getCharData() → live charData
//   getCanEdit()  → boolean (only owner can modify)
//   getRuleset()  → active ruleset (provides conditions.physical|mental presets)
//   escapeHtml    → shared HTML-escape
//   fmt           → shared number formatter

import { saveCharacter } from './char-firestore.js';

// The seven scale tiers, sync with ruleset.advantageTiers labels. Listed
// in order so the UI can render them as a dropdown without needing the
// ruleset to have been loaded yet.
const SCALE_KEYS = ['minor','moderate','major','massive','monumental','mega','mythical'];
const SCALE_LABELS = {
  minor:      'Minor',
  moderate:   'Moderate',
  major:      'Major',
  massive:    'Massive',
  monumental: 'Monumental',
  mega:       'Mega',
  mythical:   'Mythical'
};

export function createConditionsSection(ctx) {
  const { getCharId, getCharData, getCanEdit, getRuleset } = ctx;
  const escapeHtml = ctx.escapeHtml || defaultEscapeHtml;

  // ─── UI-ONLY STATE ───
  // Which entries have their detail panel expanded in the list. Not
  // persisted; resets on full re-render.
  const expandedEntries = new Set();

  // Modal state. When non-null, a modal is open for either the "add"
  // flow (picking from presets / creating custom) or the "edit" flow.
  //
  // Shape:
  //   { mode: 'add',  category: 'physical'|'mental', view: 'picker'|'custom', draft }
  //   { mode: 'edit', category: 'physical'|'mental', entryId, draft }
  let activeModal = null;

  // ─── HELPERS ───

  function ensureConditions() {
    const c = getCharData();
    if (!c) return null;
    if (!c.conditions || typeof c.conditions !== 'object') {
      c.conditions = { physical: [], mental: [] };
    }
    if (!Array.isArray(c.conditions.physical)) c.conditions.physical = [];
    if (!Array.isArray(c.conditions.mental))   c.conditions.mental   = [];
    return c.conditions;
  }

  // Per-character catalogue of custom-authored condition definitions.
  // Parallel structure to charData.inventory.customDefs — lets the
  // player build up a reusable list of conditions specific to this
  // character (e.g. a unique curse, a recurring illness) without
  // polluting the ruleset's shared preset library.
  //
  // Shape: { physical: [{id,name,description,system}], mental: [...] }
  function ensureConditionDefs() {
    const c = getCharData();
    if (!c) return null;
    if (!c.conditionDefs || typeof c.conditionDefs !== 'object') {
      c.conditionDefs = { physical: [], mental: [] };
    }
    if (!Array.isArray(c.conditionDefs.physical)) c.conditionDefs.physical = [];
    if (!Array.isArray(c.conditionDefs.mental))   c.conditionDefs.mental   = [];
    return c.conditionDefs;
  }

  function genId() {
    return 'cond_' + Math.random().toString(36).slice(2, 10);
  }

  function findEntry(entryId) {
    const conds = ensureConditions();
    if (!conds) return null;
    for (const cat of ['physical', 'mental']) {
      const found = conds[cat].find(e => e && e.id === entryId);
      if (found) return { entry: found, category: cat };
    }
    return null;
  }

  // Pull the display data for an entry. Snapshot-first (entries are the
  // source of truth); if snapshot is missing we fall back to the defId —
  // which might live in either the ruleset preset library OR the
  // per-character personal catalogue. Both are searched.
  function entryDisplay(entry) {
    if (!entry) return { name: '', description: '', system: '' };
    if (entry.snapshot && typeof entry.snapshot === 'object') {
      return {
        name:        entry.snapshot.name        || '',
        description: entry.snapshot.description || '',
        system:      entry.snapshot.system      || ''
      };
    }
    if (entry.defId) {
      const def = findDefById(entry.defId);
      if (def) return {
        name:        def.name        || '',
        description: def.description || '',
        system:      def.system      || ''
      };
    }
    return { name: '', description: '', system: '' };
  }

  // Search both preset pools (ruleset + personal catalogue) for a def.
  // Returns the def object (with an added `source` discriminator) or
  // null if nothing matches. The source is used by the picker to label
  // where a preset came from.
  function findDefById(defId) {
    if (!defId) return null;
    const ruleset = getRuleset();
    const rulesetConds = (ruleset && ruleset.conditions) || {};
    for (const cat of ['physical', 'mental']) {
      const rsHit = (rulesetConds[cat] || []).find(d => d && d.id === defId);
      if (rsHit) return { ...rsHit, source: 'ruleset', category: cat };
    }
    const defs = ensureConditionDefs();
    if (defs) {
      for (const cat of ['physical', 'mental']) {
        const catHit = defs[cat].find(d => d && d.id === defId);
        if (catHit) return { ...catHit, source: 'catalogue', category: cat };
      }
    }
    return null;
  }

  // ─── SAVE ───

  async function save() {
    const c = getCharData();
    if (!c) return;
    // Persist both the entry list and the personal catalogue together —
    // they're conceptually linked (entries can reference catalogue defs)
    // so a split save could leave the sheet briefly inconsistent.
    await saveCharacter(getCharId(), {
      conditions:    c.conditions,
      conditionDefs: c.conditionDefs || { physical: [], mental: [] }
    });
  }

  // ─── PUBLIC RENDER ───
  // The tile itself is rendered by char-overview.js; here we expose the
  // HTML string it should inject into the tile body, plus a modal-root
  // HTML string for the picker/edit modal. The overview module stitches
  // them in at the right positions.

  function renderTileBody() {
    const conds = ensureConditions();
    if (!conds) return '';
    const canEdit = getCanEdit();
    let html = '<div class="cond-columns">';
    html += renderColumn('physical', 'Physical', conds.physical, canEdit);
    html += renderColumn('mental',   'Mental',   conds.mental,   canEdit);
    html += '</div>';
    // Modal root — always rendered so openAddModal/openEditModal have a
    // mount point when triggered. If activeModal is null, the host's
    // renderModal() produces an empty string.
    html += '<div id="cond-modal-root"></div>';
    return html;
  }

  function renderColumn(category, label, entries, canEdit) {
    const addBtn = canEdit
      ? `<button class="cond-add-btn" onclick="condOpenAdd('${category}')" title="Add a ${label.toLowerCase()} condition">+ Add</button>`
      : '';
    let html = `<div class="cond-col cond-col-${category}">
      <div class="cond-col-head">
        <span class="cond-col-label">${escapeHtml(label)}</span>
        <span class="cond-col-count">${entries.length}</span>
        ${addBtn}
      </div>
      <div class="cond-list">`;
    if (entries.length === 0) {
      html += `<div class="cond-empty">${canEdit ? 'No conditions. Click + Add to track one.' : 'No conditions.'}</div>`;
    } else {
      entries.forEach(entry => {
        html += renderEntry(entry, category, canEdit);
      });
    }
    html += '</div></div>';
    return html;
  }

  function renderEntry(entry, category, canEdit) {
    const disp = entryDisplay(entry);
    const scaleKey = (typeof entry.scale === 'string' && SCALE_LABELS[entry.scale]) ? entry.scale : '';
    const scalePill = scaleKey
      ? `<span class="cond-scale cond-scale-${scaleKey}" title="Scale: ${SCALE_LABELS[scaleKey]}">${SCALE_LABELS[scaleKey]}</span>`
      : '<span class="cond-scale cond-scale-none" title="No scale set">—</span>';
    const expanded = expandedEntries.has(entry.id);

    // Secondary line: description or system (whichever exists), truncated.
    const blurb = disp.description || disp.system || '';
    const blurbHtml = blurb
      ? `<span class="cond-blurb">${escapeHtml(blurb.length > 80 ? blurb.slice(0, 77) + '…' : blurb)}</span>`
      : '';

    // Per-entry actions. Swap-category toggles between physical and
    // mental. Edit opens the edit modal. Delete removes with no
    // confirmation (entries are cheap to re-add; adding a confirm dialog
    // would be over-cautious for a low-stakes tracker).
    const otherCategory = category === 'physical' ? 'mental' : 'physical';
    const swapTitle = `Move to ${otherCategory === 'physical' ? 'Physical' : 'Mental'}`;
    const actions = canEdit
      ? `<div class="cond-entry-actions">
          <button class="cond-entry-btn" onclick="event.stopPropagation();condSwapCategory('${escapeHtml(entry.id)}')" title="${escapeHtml(swapTitle)}">↔</button>
          <button class="cond-entry-btn" onclick="event.stopPropagation();condOpenEdit('${escapeHtml(entry.id)}')" title="Edit">✎</button>
          <button class="cond-entry-btn cond-entry-btn-danger" onclick="event.stopPropagation();condRemove('${escapeHtml(entry.id)}')" title="Remove">×</button>
        </div>`
      : '';

    let html = `<div class="cond-entry${expanded ? ' expanded' : ''}" data-id="${escapeHtml(entry.id)}">
      <div class="cond-entry-head" onclick="condToggleEntry('${escapeHtml(entry.id)}')" title="Click to ${expanded ? 'collapse' : 'expand'}">
        ${scalePill}
        <span class="cond-entry-name">${escapeHtml(disp.name || '(unnamed)')}</span>
        ${blurbHtml}
        ${actions}
      </div>`;
    if (expanded) {
      html += '<div class="cond-entry-body">';
      if (disp.description) {
        html += `<div class="cond-entry-block">
          <div class="cond-entry-block-label">Description</div>
          <div class="cond-entry-block-text">${escapeHtml(disp.description)}</div>
        </div>`;
      }
      if (disp.system) {
        html += `<div class="cond-entry-block">
          <div class="cond-entry-block-label">System</div>
          <div class="cond-entry-block-text">${escapeHtml(disp.system)}</div>
        </div>`;
      }
      if (entry.notes) {
        html += `<div class="cond-entry-block">
          <div class="cond-entry-block-label">Notes</div>
          <div class="cond-entry-block-text">${escapeHtml(entry.notes)}</div>
        </div>`;
      }
      if (!disp.description && !disp.system && !entry.notes) {
        html += '<div class="cond-entry-empty">No details.</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── MODAL RENDERING ───
  // Called by the host each render pass. Reads activeModal and returns
  // the modal HTML (empty string when nothing is open). The overview
  // module hosts this inside #cond-modal-root.

  function renderModal() {
    if (!activeModal) return '';
    if (activeModal.mode === 'add') return renderAddModal();
    if (activeModal.mode === 'edit') return renderEditModal();
    return '';
  }

  function renderAddModal() {
    const { category, view } = activeModal;
    const catLabel = category === 'physical' ? 'Physical' : 'Mental';
    const ruleset = getRuleset();
    const rulesetPresets = ((ruleset && ruleset.conditions) || {})[category] || [];
    const catalogue = (ensureConditionDefs() || {})[category] || [];

    let body;
    if (view === 'custom') {
      body = renderCustomForm(activeModal.draft);
    } else {
      // Picker view — two sections (Ruleset, Catalogue) followed by a
      // custom fallback button. Hide each section header when its list
      // is empty so the picker stays compact for sparse setups.
      let sections = '';
      if (rulesetPresets.length > 0) {
        sections += renderPickerSection('Ruleset Presets', 'ruleset', rulesetPresets);
      }
      if (catalogue.length > 0) {
        sections += renderPickerSection('Personal Catalogue', 'catalogue', catalogue);
      }
      if (!sections) {
        sections = `<div class="cond-modal-empty">
          No ${catLabel.toLowerCase()} presets yet — neither the ruleset nor this character's catalogue has any.
          Click <b>+ Custom</b> below to create a one-off entry.
        </div>`;
      }
      body = `
        ${sections}
        <div class="cond-modal-foot">
          <button type="button" class="cond-modal-custom-btn" onclick="condStartCustom()">+ Custom entry</button>
        </div>`;
    }

    const title = view === 'custom'
      ? `Custom ${catLabel} Condition`
      : `Add ${catLabel} Condition`;
    return `<div class="cond-modal-backdrop" onclick="condCloseModal(event)">
      <div class="cond-modal" onclick="event.stopPropagation()">
        <div class="cond-modal-head">
          <span class="cond-modal-title">${escapeHtml(title)}</span>
          <button type="button" class="cond-modal-close" onclick="condCloseModal()" title="Close">×</button>
        </div>
        <div class="cond-modal-body">${body}</div>
      </div>
    </div>`;
  }

  // One section within the picker — a labelled group of preset rows.
  // Each row dispatches to pickPreset with the def id; the resolver
  // finds it in whichever pool it lives.
  function renderPickerSection(label, source, presets) {
    let html = `<div class="cond-picker-section">
      <div class="cond-picker-section-head">
        <span class="cond-picker-section-label">${escapeHtml(label)}</span>
        <span class="cond-picker-section-count">${presets.length}</span>
      </div>
      <div class="cond-picker-list">`;
    presets.forEach(p => {
      const blurb = p.description || p.system || '';
      html += `<button type="button" class="cond-picker-row" onclick="condPickPreset('${escapeHtml(p.id)}')" title="Add this preset">
        <span class="cond-picker-name">${escapeHtml(p.name || '(unnamed)')}</span>
        ${blurb ? `<span class="cond-picker-blurb">${escapeHtml(blurb.length > 100 ? blurb.slice(0, 97) + '…' : blurb)}</span>` : ''}
      </button>`;
    });
    html += '</div></div>';
    return html;
  }

  function renderEditModal() {
    const { category, entryId } = activeModal;
    const found = findEntry(entryId);
    if (!found) return '';
    const catLabel = category === 'physical' ? 'Physical' : 'Mental';
    const draft = activeModal.draft;
    const isPreset = !!found.entry.defId;
    const hasCustomDivergence = draft.name !== draft.sourceName
      || draft.description !== draft.sourceDescription
      || draft.system !== draft.sourceSystem;

    const body = renderEditForm(draft, isPreset, hasCustomDivergence);
    return `<div class="cond-modal-backdrop" onclick="condCloseModal(event)">
      <div class="cond-modal" onclick="event.stopPropagation()">
        <div class="cond-modal-head">
          <span class="cond-modal-title">Edit ${escapeHtml(catLabel)} Condition</span>
          <button type="button" class="cond-modal-close" onclick="condCloseModal()" title="Close">×</button>
        </div>
        <div class="cond-modal-body">${body}</div>
      </div>
    </div>`;
  }

  function renderCustomForm(draft) {
    const scaleOptions = SCALE_KEYS.map(k =>
      `<option value="${k}"${draft.scale === k ? ' selected' : ''}>${SCALE_LABELS[k]}</option>`
    ).join('');
    return `
      <div class="cond-form">
        <div class="cond-form-row">
          <label>Name</label>
          <input type="text" value="${escapeHtml(draft.name || '')}" placeholder="e.g. Broken Arm" oninput="condDraft('name', this.value)" autofocus>
        </div>
        <div class="cond-form-row">
          <label>Scale</label>
          <select oninput="condDraft('scale', this.value)">
            <option value="">— None —</option>
            ${scaleOptions}
          </select>
        </div>
        <div class="cond-form-row">
          <label>Description</label>
          <textarea rows="3" placeholder="Flavor / narrative details." oninput="condDraft('description', this.value)">${escapeHtml(draft.description || '')}</textarea>
        </div>
        <div class="cond-form-row">
          <label>System</label>
          <textarea rows="3" placeholder="Mechanical effects. e.g. −2d to physical rolls involving the arm." oninput="condDraft('system', this.value)">${escapeHtml(draft.system || '')}</textarea>
        </div>
        <div class="cond-form-row">
          <label>Notes</label>
          <textarea rows="2" placeholder="Per-character notes, unique circumstances." oninput="condDraft('notes', this.value)">${escapeHtml(draft.notes || '')}</textarea>
        </div>
        <div class="cond-form-foot">
          <button type="button" class="cond-modal-cancel" onclick="condCloseModal()">Cancel</button>
          <button type="button" class="cond-modal-save" onclick="condSaveCustom()">Add</button>
        </div>
      </div>`;
  }

  function renderEditForm(draft, isPreset, hasCustomDivergence) {
    const scaleOptions = SCALE_KEYS.map(k =>
      `<option value="${k}"${draft.scale === k ? ' selected' : ''}>${SCALE_LABELS[k]}</option>`
    ).join('');
    const presetBadge = isPreset
      ? `<div class="cond-preset-note">${hasCustomDivergence ? '✎ Edited from preset. Saving keeps this instance detached from the original preset.' : '🔗 Linked to a preset. Editing fields below will detach this instance.'}</div>`
      : '';
    // Promote button — only shown for pure custom entries (defId === null).
    // Saving it to the catalogue creates a new reusable def and
    // re-links this entry to point at it, so editing the catalogue
    // later won't update already-placed entries (snapshot-first).
    const promoteBtn = !isPreset
      ? `<button type="button" class="cond-modal-promote" onclick="condPromote()" title="Save this custom entry to your Personal Catalogue so you can reuse it later.">★ Save to Catalogue</button>`
      : '';
    return `
      <div class="cond-form">
        ${presetBadge}
        <div class="cond-form-row">
          <label>Name</label>
          <input type="text" value="${escapeHtml(draft.name || '')}" oninput="condDraft('name', this.value)">
        </div>
        <div class="cond-form-row">
          <label>Scale</label>
          <select oninput="condDraft('scale', this.value)">
            <option value="">— None —</option>
            ${scaleOptions}
          </select>
        </div>
        <div class="cond-form-row">
          <label>Description</label>
          <textarea rows="3" oninput="condDraft('description', this.value)">${escapeHtml(draft.description || '')}</textarea>
        </div>
        <div class="cond-form-row">
          <label>System</label>
          <textarea rows="3" oninput="condDraft('system', this.value)">${escapeHtml(draft.system || '')}</textarea>
        </div>
        <div class="cond-form-row">
          <label>Notes</label>
          <textarea rows="2" oninput="condDraft('notes', this.value)">${escapeHtml(draft.notes || '')}</textarea>
        </div>
        <div class="cond-form-foot">
          ${promoteBtn}
          <div class="cond-form-foot-spacer"></div>
          <button type="button" class="cond-modal-cancel" onclick="condCloseModal()">Cancel</button>
          <button type="button" class="cond-modal-save" onclick="condSaveEdit()">Save</button>
        </div>
      </div>`;
  }

  // ─── HANDLERS ───

  // Toggle an entry's expanded detail panel.
  function toggleEntry(entryId) {
    if (expandedEntries.has(entryId)) expandedEntries.delete(entryId);
    else expandedEntries.add(entryId);
    requestHostRerender();
  }

  // Begin adding: opens the picker modal scoped to a category.
  function openAdd(category) {
    if (!getCanEdit()) return;
    if (category !== 'physical' && category !== 'mental') return;
    activeModal = {
      mode: 'add',
      category,
      view: 'picker',
      draft: freshDraft()
    };
    requestHostRerender();
  }

  // Switch picker → custom form (within the same modal).
  function startCustom() {
    if (!activeModal || activeModal.mode !== 'add') return;
    activeModal.view = 'custom';
    requestHostRerender();
  }

  // Pick a preset. Creates a snapshot-linked entry and commits. The
  // preset can live in the ruleset or in the character's personal
  // catalogue — both are searched by findDefById.
  async function pickPreset(defId) {
    if (!activeModal || activeModal.mode !== 'add') return;
    const def = findDefById(defId);
    if (!def) return;
    // Only allow picking a def from the category we're adding into —
    // prevents cross-category contamination if a def id happened to
    // exist in both lists.
    if (def.category !== activeModal.category) return;
    const conds = ensureConditions();
    if (!conds) return;
    conds[activeModal.category].push({
      id: genId(),
      defId: def.id,
      defKind: 'condition',
      scale: '',
      notes: '',
      snapshot: {
        name:        def.name || '',
        description: def.description || '',
        system:      def.system || ''
      }
    });
    activeModal = null;
    await save();
    requestHostRerender();
  }

  async function saveCustom() {
    if (!activeModal || activeModal.mode !== 'add' || activeModal.view !== 'custom') return;
    const d = activeModal.draft;
    const name = (d.name || '').trim();
    if (!name) return;   // silent guard — button is still clickable, just ignore empty
    const conds = ensureConditions();
    if (!conds) return;
    conds[activeModal.category].push({
      id: genId(),
      defId: null,
      defKind: 'condition',
      scale: SCALE_KEYS.includes(d.scale) ? d.scale : '',
      notes: d.notes || '',
      snapshot: {
        name,
        description: d.description || '',
        system:      d.system || ''
      }
    });
    activeModal = null;
    await save();
    requestHostRerender();
  }

  // Edit flow — pre-fill draft from the entry and show the form.
  function openEdit(entryId) {
    if (!getCanEdit()) return;
    const found = findEntry(entryId);
    if (!found) return;
    const disp = entryDisplay(found.entry);
    activeModal = {
      mode: 'edit',
      category: found.category,
      entryId,
      draft: {
        name:        disp.name,
        description: disp.description,
        system:      disp.system,
        notes:       found.entry.notes || '',
        scale:       found.entry.scale || '',
        sourceName:        disp.name,
        sourceDescription: disp.description,
        sourceSystem:      disp.system
      }
    };
    requestHostRerender();
  }

  async function saveEdit() {
    if (!activeModal || activeModal.mode !== 'edit') return;
    const found = findEntry(activeModal.entryId);
    if (!found) { activeModal = null; requestHostRerender(); return; }
    const d = activeModal.draft;
    const detached = d.name !== d.sourceName
      || d.description !== d.sourceDescription
      || d.system !== d.sourceSystem;

    found.entry.scale = SCALE_KEYS.includes(d.scale) ? d.scale : '';
    found.entry.notes = d.notes || '';
    found.entry.snapshot = {
      name:        (d.name || '').trim(),
      description: d.description || '',
      system:      d.system || ''
    };
    // If the player edited any of the content fields away from the
    // preset's values, detach from the preset — the snapshot is now
    // authoritative and shouldn't be "helpfully" overwritten by a
    // preset edit later.
    if (detached && found.entry.defId) {
      found.entry.defId = null;
    }
    activeModal = null;
    await save();
    requestHostRerender();
  }

  // Promote the current edit-modal's entry to the personal catalogue.
  // Only valid for custom entries (defId === null) — preset-linked
  // entries don't need promoting, they already have a def somewhere.
  //
  // Saves the current draft values into a new catalogue def, then
  // re-links the entry's defId to the new def. Stays in edit mode so
  // the player can see the confirmation banner flip from "custom" to
  // "preset-linked" before closing.
  async function promote() {
    if (!activeModal || activeModal.mode !== 'edit') return;
    const found = findEntry(activeModal.entryId);
    if (!found) return;
    if (found.entry.defId) return;   // already preset-linked, shouldn't happen
    const d = activeModal.draft;
    const name = (d.name || '').trim();
    if (!name) return;
    const defs = ensureConditionDefs();
    if (!defs) return;
    // Create a new def in the SAME category the entry currently lives
    // in. A later swapCategory on the entry won't move its catalogue
    // def — that's intentional (the def is about the concept, the
    // entry is about this character's state).
    const newDef = {
      id: genId(),
      name,
      description: d.description || '',
      system:      d.system      || ''
    };
    defs[found.category].push(newDef);
    // Re-link the entry and update its snapshot so both sides agree.
    found.entry.defId = newDef.id;
    found.entry.snapshot = {
      name,
      description: newDef.description,
      system:      newDef.system
    };
    // Update draft's source-* fields so divergence detection correctly
    // reports "linked, not diverged" now.
    d.sourceName        = name;
    d.sourceDescription = newDef.description;
    d.sourceSystem      = newDef.system;
    await save();
    requestHostRerender();
  }

  // Draft field update — mutate activeModal.draft without re-rendering
  // (onkeystroke focus preservation, same reason we switched other mods
  // to onchange).
  function draft(field, value) {
    if (!activeModal || !activeModal.draft) return;
    activeModal.draft[field] = value;
  }

  // Close modal — also invoked by clicking the backdrop; in that case
  // the event target check prevents accidental dismissal from clicks
  // on modal content bubbling up.
  function closeModal(ev) {
    if (ev && ev.target && ev.currentTarget && ev.target !== ev.currentTarget) return;
    activeModal = null;
    requestHostRerender();
  }

  async function swapCategory(entryId) {
    if (!getCanEdit()) return;
    const found = findEntry(entryId);
    if (!found) return;
    const conds = ensureConditions();
    const src = found.category;
    const dst = src === 'physical' ? 'mental' : 'physical';
    // Remove from source, push to destination. Keep the ID so any open
    // edit panels don't lose their reference.
    conds[src] = conds[src].filter(e => e.id !== entryId);
    conds[dst].push(found.entry);
    await save();
    requestHostRerender();
  }

  async function remove(entryId) {
    if (!getCanEdit()) return;
    const found = findEntry(entryId);
    if (!found) return;
    const conds = ensureConditions();
    conds[found.category] = conds[found.category].filter(e => e.id !== entryId);
    expandedEntries.delete(entryId);
    await save();
    requestHostRerender();
  }

  function freshDraft() {
    return {
      name: '',
      description: '',
      system: '',
      notes: '',
      scale: '',
      sourceName: '',
      sourceDescription: '',
      sourceSystem: ''
    };
  }

  // ─── HOST INTERACTION ───
  // The section doesn't own its own host element; it's embedded inside
  // the overview tile. We ask the host (char-overview.js) to re-render
  // when our state changes.

  function requestHostRerender() {
    if (typeof ctx.requestRerender === 'function') ctx.requestRerender();
  }

  return {
    renderTileBody,
    renderModal,
    toggleEntry,
    openAdd, startCustom, pickPreset, saveCustom,
    openEdit, saveEdit, promote,
    draft, closeModal,
    swapCategory, remove
  };
}

function defaultEscapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
