// char-situations.js
// Handles the Situations section at the bottom of the character sheet.
//
// A Situation is a narrative threat, obligation, or opportunity looming
// over the character. It has a Clock — a countable interval (e.g. 5 Days,
// 3 Sessions) that ticks down during play. When the Clock reaches 0 the
// Situation "takes place" and pauses itself until the GM resets it.
//
// Roles:
//   - Character owner (player): sees non-hidden Situations, reads the
//     player-view text, can't edit anything. Cards don't flip.
//   - Playgroup Leader / Admin (GM): sees everything including hidden
//     Situations, can flip between Player View and GM View, ticks the
//     Clock, toggles paused/hidden, edits fields, deletes, creates.
//   - Anyone else viewing the sheet: same as player.
//
// Flip state is local-only (not persisted). A card flipped to GM view
// stays flipped until the user flips it back or reloads.
//
// Data shape on charData:
//   charData.situations: [{
//     id,                 // unique ID for edit/delete targeting
//     name,
//     playerView,         // what the player reads (vague)
//     gmView,             // what the GM sees (specific)
//     intervalCount,      // clock number (e.g. 5)
//     intervalUnit,       // clock unit (e.g. "Days")
//     hidden,             // true = invisible to player
//     paused,             // true = visible but clock frozen
//     assignedBy,         // uid of creator (for audit trail)
//     assignedByName,     // username cached at creation for display
//     createdAt           // timestamp
//   }, ...]

import { saveCharacter } from './char-firestore.js';

export function createSituationsSection(ctx) {
  // ctx shape:
  //   getCharData()   -> live charData
  //   getCanEdit()    -> boolean (character owner)
  //   getIsGM()       -> boolean (Leader or Admin of the character's playgroup)
  //   getCharId()     -> string
  //   getMyUid()      -> string (currently logged-in user's UID)
  //   getMyUsername() -> string (for assignedByName on new entries)

  // Per-session flip state: card id → 'player' | 'gm'. Default is 'player'.
  // Not persisted; resets on reload. Only the GM can flip (the player view
  // never has access to the GM side, so flipping is meaningless for them).
  const flipState = {};

  // Per-session "is this card in edit mode" state. GM-only.
  const editState = {};

  // ─── STATE HELPERS ───

  function getSituations() {
    const charData = ctx.getCharData();
    return Array.isArray(charData.situations) ? charData.situations : [];
  }

  // Persist the entire situations array in one write. Small list, so the
  // simpler overwrite-everything pattern is fine here.
  async function save() {
    const charData = ctx.getCharData();
    await saveCharacter(ctx.getCharId(), { situations: charData.situations || [] });
  }

  // Generate a short ID. Collision-proof for in-list scope.
  function newId() {
    return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // What view a card should currently render. GM's default is Player view
  // (matches what the player sees) so a GM doesn't accidentally leak GM
  // info over someone's shoulder. They flip intentionally.
  function currentFace(sit) {
    return flipState[sit.id] || 'player';
  }

  // ─── RENDERING ───

  function renderAll() {
    const list = document.getElementById('situations-list');
    const addBtn = document.getElementById('situations-add-btn');
    if (!list) return;

    const isGM = ctx.getIsGM();
    const situations = getSituations();

    // GMs see every Situation. Players/everyone else only see non-hidden.
    const visible = isGM ? situations : situations.filter(s => !s.hidden);

    if (addBtn) addBtn.style.display = isGM ? 'inline-block' : 'none';

    if (visible.length === 0) {
      list.innerHTML = `<div class="sit-empty">${isGM
        ? 'No situations yet — add one below.'
        : 'No situations at the moment.'}</div>`;
      return;
    }

    list.innerHTML = visible.map(s => renderCard(s, isGM)).join('');
  }

  function renderCard(sit, isGM) {
    // Edit mode (GM only) takes precedence over view/flip modes.
    if (isGM && editState[sit.id]) return renderEditCard(sit);

    const face = currentFace(sit);
    const expired = (sit.intervalCount || 0) <= 0;

    // Clock: text if expired, otherwise count + unit. Paused cards get a
    // distinct style regardless of which face is showing.
    const clockText = expired
      ? 'This Situation is now taking place.'
      : `${sit.intervalCount} ${sit.intervalUnit || ''}`.trim();

    // GM-only badges: flag when something's hidden from the player or paused.
    const gmBadges = isGM ? [
      sit.hidden ? '<span class="sit-badge sit-badge-hidden" title="Hidden from player">Hidden</span>' : '',
      sit.paused && !expired ? '<span class="sit-badge sit-badge-paused" title="Clock paused">Paused</span>' : '',
      expired ? '<span class="sit-badge sit-badge-expired" title="Clock has expired">Expired</span>' : ''
    ].filter(Boolean).join('') : '';

    // The "who assigned this" line. Only shown for GMs since players don't
    // need to know who's orchestrating the threat.
    const assignedLine = isGM && sit.assignedByName
      ? `<div class="sit-assigned">assigned by ${escapeHtml(sit.assignedByName)}</div>`
      : '';

    // GM controls — flip button, edit, clock ticker, pause/hide toggles, delete.
    const gmControls = isGM ? renderGmControls(sit, face, expired) : '';

    // Body text differs by face. Player always sees playerView. GM can flip.
    const bodyText = face === 'gm' ? (sit.gmView || '') : (sit.playerView || '');

    const cardClasses = ['sit-card'];
    if (expired) cardClasses.push('sit-card-expired');
    else if (sit.paused) cardClasses.push('sit-card-paused');
    if (sit.hidden) cardClasses.push('sit-card-hidden');
    if (face === 'gm') cardClasses.push('sit-card-gm-face');

    return `
      <div class="${cardClasses.join(' ')}">
        <div class="sit-card-top">
          <div class="sit-clock">${escapeHtml(clockText)}</div>
          <div class="sit-badges">${gmBadges}</div>
        </div>
        <div class="sit-card-name">${escapeHtml(sit.name || '(Unnamed)')}</div>
        <div class="sit-card-body">${escapeHtml(bodyText)}</div>
        ${assignedLine}
        ${gmControls}
      </div>`;
  }

  // GM-only controls row under a card. Contains:
  //   - Flip button (toggle player/gm face)
  //   - Tick controls (− / number input / +) — disabled if expired
  //   - Pause toggle
  //   - Hide toggle
  //   - Edit, Delete
  function renderGmControls(sit, face, expired) {
    const flipLabel = face === 'gm' ? '⇆ Player View' : '⇆ GM View';
    const pauseLabel = sit.paused ? 'Resume' : 'Pause';
    const hideLabel  = sit.hidden ? 'Unhide'  : 'Hide';
    const tickDisabled = expired ? 'disabled' : '';

    return `
      <div class="sit-gm-controls">
        <button class="sit-ctrl-btn sit-flip-btn" onclick="flipSituation('${sit.id}')">${flipLabel}</button>
        <div class="sit-clock-ticker">
          <button class="sit-tick-btn" onclick="tickSituation('${sit.id}',-1)" title="Decrement">−</button>
          <input type="number" class="sit-clock-input" value="${sit.intervalCount ?? 0}" min="0"
                 onchange="setSituationClock('${sit.id}',this.value)"
                 ${tickDisabled}>
          <button class="sit-tick-btn" onclick="tickSituation('${sit.id}',1)" title="Increment">+</button>
        </div>
        <button class="sit-ctrl-btn" onclick="togglePauseSituation('${sit.id}')">${pauseLabel}</button>
        <button class="sit-ctrl-btn" onclick="toggleHideSituation('${sit.id}')">${hideLabel}</button>
        <button class="sit-ctrl-btn" onclick="startEditSituation('${sit.id}')">Edit</button>
        <button class="sit-ctrl-btn sit-ctrl-danger" onclick="deleteSituation('${sit.id}')">Delete</button>
      </div>`;
  }

  // GM-only inline edit form. Replaces the card's body while editing.
  function renderEditCard(sit) {
    return `
      <div class="sit-card sit-card-editing">
        <div class="sit-edit-form">
          <div class="sit-edit-row">
            <div class="sit-edit-field" style="flex:1">
              <label>Name</label>
              <input type="text" id="sit-edit-name-${sit.id}" value="${escapeHtml(sit.name || '')}">
            </div>
          </div>
          <div class="sit-edit-row">
            <div class="sit-edit-field" style="width:100px">
              <label>Interval</label>
              <input type="number" id="sit-edit-count-${sit.id}" value="${sit.intervalCount ?? 0}" min="0">
            </div>
            <div class="sit-edit-field" style="flex:1">
              <label>Unit</label>
              <input type="text" id="sit-edit-unit-${sit.id}" value="${escapeHtml(sit.intervalUnit || '')}" placeholder="Days / Sessions / Months…">
            </div>
          </div>
          <div class="sit-edit-field">
            <label>Player View <span class="sit-edit-sublabel">(vague description the player reads)</span></label>
            <textarea id="sit-edit-player-${sit.id}" rows="2" placeholder="The Clock is ticking…">${escapeHtml(sit.playerView || '')}</textarea>
          </div>
          <div class="sit-edit-field">
            <label>GM View <span class="sit-edit-sublabel">(full details only GMs see)</span></label>
            <textarea id="sit-edit-gm-${sit.id}" rows="3" placeholder="The specifics, stakes, what happens when the clock hits 0…">${escapeHtml(sit.gmView || '')}</textarea>
          </div>
          <div class="sit-edit-actions">
            <button class="sit-ctrl-btn sit-ctrl-primary" onclick="saveEditSituation('${sit.id}')">Save</button>
            <button class="sit-ctrl-btn" onclick="cancelEditSituation('${sit.id}')">Cancel</button>
          </div>
        </div>
      </div>`;
  }

  // ─── CREATE FORM ───
  //
  // GM clicks "+ Add Situation" → inline form appears. Uses the same edit
  // form shape as the per-card edit mode but lives in its own container.

  let addFormOpen = false;
  const addDraft = { name: '', intervalCount: 5, intervalUnit: 'Days', playerView: '', gmView: '' };

  function openAddForm() {
    if (!ctx.getIsGM()) return;
    addFormOpen = true;
    // Reset draft so stale data doesn't leak between opens.
    Object.assign(addDraft, { name: '', intervalCount: 5, intervalUnit: 'Days', playerView: '', gmView: '' });
    renderAddForm();
  }

  function closeAddForm() {
    addFormOpen = false;
    renderAddForm();
  }

  function renderAddForm() {
    const container = document.getElementById('situations-add-form');
    if (!container) return;
    if (!addFormOpen) { container.innerHTML = ''; container.style.display = 'none'; return; }
    container.style.display = 'block';
    container.innerHTML = `
      <div class="sit-card sit-card-editing">
        <div class="sit-edit-form">
          <div class="sit-edit-header">New Situation</div>
          <div class="sit-edit-row">
            <div class="sit-edit-field" style="flex:1">
              <label>Name</label>
              <input type="text" id="sit-new-name" value="${escapeHtml(addDraft.name)}" placeholder="e.g. Mobbed Up">
            </div>
          </div>
          <div class="sit-edit-row">
            <div class="sit-edit-field" style="width:100px">
              <label>Interval</label>
              <input type="number" id="sit-new-count" value="${addDraft.intervalCount}" min="0">
            </div>
            <div class="sit-edit-field" style="flex:1">
              <label>Unit</label>
              <input type="text" id="sit-new-unit" value="${escapeHtml(addDraft.intervalUnit)}" placeholder="Days / Sessions / Months…">
            </div>
          </div>
          <div class="sit-edit-field">
            <label>Player View <span class="sit-edit-sublabel">(vague description the player reads)</span></label>
            <textarea id="sit-new-player" rows="2" placeholder="The Clock is ticking…">${escapeHtml(addDraft.playerView)}</textarea>
          </div>
          <div class="sit-edit-field">
            <label>GM View <span class="sit-edit-sublabel">(full details only GMs see)</span></label>
            <textarea id="sit-new-gm" rows="3" placeholder="The specifics, stakes, what happens when the clock hits 0…">${escapeHtml(addDraft.gmView)}</textarea>
          </div>
          <div class="sit-edit-actions">
            <button class="sit-ctrl-btn sit-ctrl-primary" onclick="commitNewSituation()">Create</button>
            <button class="sit-ctrl-btn" onclick="closeNewSituation()">Cancel</button>
          </div>
        </div>
      </div>`;
  }

  async function commitNew() {
    const name = (document.getElementById('sit-new-name').value || '').trim();
    if (!name) {
      alert('Please give the Situation a name.');
      return;
    }
    const charData = ctx.getCharData();
    if (!Array.isArray(charData.situations)) charData.situations = [];
    const sit = {
      id: newId(),
      name,
      intervalCount: Math.max(0, parseInt(document.getElementById('sit-new-count').value) || 0),
      intervalUnit: (document.getElementById('sit-new-unit').value || '').trim(),
      playerView: (document.getElementById('sit-new-player').value || '').trim(),
      gmView: (document.getElementById('sit-new-gm').value || '').trim(),
      hidden: false,
      paused: false,
      assignedBy: ctx.getMyUid(),
      assignedByName: ctx.getMyUsername() || '',
      createdAt: new Date()
    };
    charData.situations.push(sit);
    await save();
    closeAddForm();
    renderAll();
  }

  // ─── HANDLERS ───

  function flip(id) {
    flipState[id] = flipState[id] === 'gm' ? 'player' : 'gm';
    renderAll();
  }

  async function tick(id, delta) {
    if (!ctx.getIsGM()) return;
    const charData = ctx.getCharData();
    const sit = (charData.situations || []).find(s => s.id === id);
    if (!sit) return;
    const newCount = Math.max(0, (sit.intervalCount || 0) + delta);
    sit.intervalCount = newCount;
    // If we just hit 0, auto-pause so the "Now taking place" state is stable
    // and doesn't keep ticking down on subsequent sessions until the GM
    // explicitly resets. The GM can unpause to resume counting upward if
    // they want to repurpose the clock.
    if (newCount === 0) sit.paused = true;
    await save();
    renderAll();
  }

  async function setClock(id, val) {
    if (!ctx.getIsGM()) return;
    const charData = ctx.getCharData();
    const sit = (charData.situations || []).find(s => s.id === id);
    if (!sit) return;
    const parsed = Math.max(0, parseInt(val) || 0);
    sit.intervalCount = parsed;
    if (parsed === 0) sit.paused = true;
    else if (parsed > 0 && sit.paused) {
      // Typing a positive value is probably the GM resetting an expired
      // clock — unpause so it starts ticking again.
      sit.paused = false;
    }
    await save();
    renderAll();
  }

  async function togglePause(id) {
    if (!ctx.getIsGM()) return;
    const charData = ctx.getCharData();
    const sit = (charData.situations || []).find(s => s.id === id);
    if (!sit) return;
    sit.paused = !sit.paused;
    await save();
    renderAll();
  }

  async function toggleHide(id) {
    if (!ctx.getIsGM()) return;
    const charData = ctx.getCharData();
    const sit = (charData.situations || []).find(s => s.id === id);
    if (!sit) return;
    sit.hidden = !sit.hidden;
    await save();
    renderAll();
  }

  async function remove(id) {
    if (!ctx.getIsGM()) return;
    const charData = ctx.getCharData();
    const sit = (charData.situations || []).find(s => s.id === id);
    if (!sit) return;
    if (!confirm(`Delete "${sit.name}"? This cannot be undone.`)) return;
    charData.situations = (charData.situations || []).filter(s => s.id !== id);
    await save();
    renderAll();
  }

  function startEdit(id) {
    if (!ctx.getIsGM()) return;
    editState[id] = true;
    renderAll();
  }

  function cancelEdit(id) {
    editState[id] = false;
    renderAll();
  }

  async function saveEdit(id) {
    if (!ctx.getIsGM()) return;
    const charData = ctx.getCharData();
    const sit = (charData.situations || []).find(s => s.id === id);
    if (!sit) return;
    const name = (document.getElementById('sit-edit-name-' + id).value || '').trim();
    if (!name) { alert('Please give the Situation a name.'); return; }
    sit.name          = name;
    sit.intervalCount = Math.max(0, parseInt(document.getElementById('sit-edit-count-' + id).value) || 0);
    sit.intervalUnit  = (document.getElementById('sit-edit-unit-' + id).value || '').trim();
    sit.playerView    = (document.getElementById('sit-edit-player-' + id).value || '').trim();
    sit.gmView        = (document.getElementById('sit-edit-gm-' + id).value || '').trim();
    editState[id] = false;
    await save();
    renderAll();
  }

  // ─── UTIL ───

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    renderAll,
    openAddForm, closeAddForm, commitNew,
    flip, tick, setClock, togglePause, toggleHide, remove,
    startEdit, cancelEdit, saveEdit
  };
}
