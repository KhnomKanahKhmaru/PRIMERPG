// ═══════════════════════════════════════════════════════════════════
// DESCRIPTION OVERRIDES — inline editor module
// ═══════════════════════════════════════════════════════════════════
//
// Centralized UI + handlers for the player's "override this description"
// flow. Phase 1 is wired into two surfaces (base stats and derived
// stats); later phases will reuse the same state machine and renderers
// for skills, advantages, tags, conditions.
//
// State: one description can be "open for editing" at a time. The open
// editor's {category, id} live in `activeEditor`; re-rendering the sheet
// preserves the state and redraws the textarea in place.
//
// Callers wire this up via createDescriptionsModule(ctx) where ctx
// provides:
//   - getCharData()     → current character object
//   - getRuleset()      → current ruleset object
//   - getCanEdit()      → boolean (can the current user edit this sheet)
//   - saveCharacter()   → persists to Firestore
//   - requestRerender() → triggers UI refresh
//   - escapeHtml(s)     → HTML-entity escape
//
// The module exports:
//   - handlers wired to window.descOpen/Save/Cancel/Reset
//   - renderDescriptionDisplay(category, id, fallbackText) → HTML for
//     a description block with pencil/reset/textarea affordances

import {
  resolveDescription,
  hasDescriptionOverride,
  ensureDescriptionOverrideBucket
} from './char-util.js';

export function createDescriptionsModule(ctx) {
  // {category, id} of the description currently being edited — null when
  // nothing is in edit mode. Only one editor can be open at a time; opening
  // a second one implicitly closes the first.
  let activeEditor = null;

  // A transient draft buffer so the textarea keeps its typed value across
  // re-renders. Keyed "category::id" since we only need one slot.
  let draft = '';

  function keyOf(category, id) { return category + '::' + id; }

  function openEditor(category, id) {
    if (!ctx.getCanEdit()) return;
    // Seed the draft with the currently-resolved description so the
    // textarea shows the current value (override or ruleset default).
    const character = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    draft = resolveDescription(category, id, ruleset, character);
    activeEditor = { category, id };
    ctx.requestRerender();
  }

  function cancelEditor() {
    activeEditor = null;
    draft = '';
    ctx.requestRerender();
  }

  function updateDraft(value) {
    // Keep the draft in sync with the textarea — no re-render on every
    // keystroke (textarea is self-managing; re-rendering would steal
    // focus and make typing impossible).
    draft = (typeof value === 'string') ? value : '';
  }

  async function saveEditor() {
    if (!activeEditor || !ctx.getCanEdit()) return;
    const { category, id } = activeEditor;
    const character = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    if (!character) return;

    const trimmed = (draft || '').trim();
    const rulesetDefault = resolveDescription(category, id, ruleset, null);

    // If the player typed something identical to the ruleset default,
    // treat it as "no override" — don't bloat the character doc with
    // redundant data. This also handles the case where a player opens
    // the editor and immediately saves without changes.
    if (trimmed === (rulesetDefault || '').trim()) {
      removeOverride(character, category, id);
    } else {
      const bucket = ensureDescriptionOverrideBucket(character, category);
      bucket[id] = trimmed;
    }

    activeEditor = null;
    draft = '';
    ctx.requestRerender();
    try { await ctx.saveCharacter(); } catch (e) { console.error('descriptions save failed', e); }
  }

  async function resetOverride(category, id) {
    if (!ctx.getCanEdit()) return;
    const character = ctx.getCharData();
    if (!character) return;
    removeOverride(character, category, id);
    // If the editor happened to be open on this one, close it — the
    // draft is now stale relative to the restored default.
    if (activeEditor && activeEditor.category === category && activeEditor.id === id) {
      activeEditor = null;
      draft = '';
    }
    ctx.requestRerender();
    try { await ctx.saveCharacter(); } catch (e) { console.error('descriptions reset failed', e); }
  }

  // Drop a single override. Cleans up empty category buckets + the
  // top-level descriptionOverrides object to keep the saved shape tidy
  // (Firestore rejects undefined, so we fully delete rather than set
  // to undefined).
  function removeOverride(character, category, id) {
    const overrides = character && character.descriptionOverrides;
    if (!overrides || typeof overrides !== 'object') return;
    const bucket = overrides[category];
    if (!bucket || typeof bucket !== 'object') return;
    delete bucket[id];
    if (Object.keys(bucket).length === 0) delete overrides[category];
    if (Object.keys(overrides).length === 0) delete character.descriptionOverrides;
  }

  // ─── RENDERER ───
  //
  // Emits the HTML for a description cell. Three states:
  //   1. Editing (activeEditor matches) → textarea + save/cancel buttons
  //   2. Hover-showing controls → description text + pencil (+ reset if overridden)
  //   3. Plain text display (no edit rights) → description text only
  //
  // `opts`:
  //   wrapperClass — CSS class for the outer container (callers scope
  //                  their own styling hooks, e.g. 'ds-card-desc-wrap')
  //   emptyHidden  — if true, render nothing when there's no description
  //                  to show (no pencil either). Matches the existing
  //                  `def.description ? ... : ''` pattern.
  function renderDescriptionDisplay(category, id, opts) {
    opts = opts || {};
    const wrapperClass = opts.wrapperClass || 'pc-desc-wrap';
    const emptyHidden = opts.emptyHidden !== false;
    const canEdit = ctx.getCanEdit();
    const character = ctx.getCharData();
    const ruleset = ctx.getRuleset();
    const text = resolveDescription(category, id, ruleset, character);
    const isOverridden = hasDescriptionOverride(category, id, character);
    const isEditing = activeEditor
      && activeEditor.category === category
      && activeEditor.id === id;

    // Encode the ids once — interpolated into HTML attributes several
    // times, and they might contain characters like apostrophes in
    // skill names ("Lockpicking's corner-case") that would break
    // naive string concat.
    const cId = ctx.escapeHtml(category);
    const iId = ctx.escapeHtml(id);

    if (isEditing) {
      // Textarea editor. The save/cancel buttons live INSIDE the
      // wrapper so callers can style the whole thing as a block.
      return `<div class="${wrapperClass} pc-desc-editing">
        <textarea class="pc-desc-textarea" rows="4"
                  oninput="descUpdateDraft(this.value)"
                  onkeydown="if(event.key==='Escape')descCancelEditor();"
                  autofocus>${ctx.escapeHtml(draft)}</textarea>
        <div class="pc-desc-edit-actions">
          <button class="pc-desc-btn pc-desc-btn-save" onclick="descSaveEditor()">Save</button>
          <button class="pc-desc-btn pc-desc-btn-cancel" onclick="descCancelEditor()">Cancel</button>
          ${isOverridden ? `<button class="pc-desc-btn pc-desc-btn-reset" onclick="descResetOverride('${cId}','${iId}')" title="Restore to ruleset default">↺ Reset to default</button>` : ''}
        </div>
      </div>`;
    }

    // Nothing to show AND no edit rights → empty string, matches the
    // old conditional render pattern for def.description.
    if (!text && !canEdit) {
      return emptyHidden ? '' : `<div class="${wrapperClass}"></div>`;
    }

    // Build the hoverable controls. Pencil appears on hover (CSS
    // handles visibility); reset appears on hover only when there's
    // an override to reset. No-edit-rights users see just the text.
    const overrideIndicator = isOverridden
      ? `<span class="pc-desc-override-dot" title="This description has been customized on your sheet. Reset with the ↺ button.">•</span>`
      : '';
    let controls = '';
    if (canEdit) {
      controls = `<span class="pc-desc-controls">
        <button class="pc-desc-pencil" onclick="descOpenEditor('${cId}','${iId}')" title="Edit this description on your sheet (overrides the ruleset default).">✎</button>`;
      if (isOverridden) {
        controls += `<button class="pc-desc-reset" onclick="descResetOverride('${cId}','${iId}')" title="Restore the ruleset default.">↺</button>`;
      }
      controls += `</span>`;
    }

    // Empty-text placeholder so editors have something to click.
    // Italic + muted so players can tell the field is empty (vs. a
    // real description). Only shown when canEdit is true; view-only
    // mode with empty text already short-circuited above.
    const body = text
      ? ctx.escapeHtml(text)
      : `<span class="pc-desc-empty-placeholder">(no description — click to add one)</span>`;

    return `<div class="${wrapperClass} pc-desc-static${isOverridden ? ' pc-desc-has-override' : ''}">
      <span class="pc-desc-text">${body}${overrideIndicator}</span>
      ${controls}
    </div>`;
  }

  return {
    openEditor,
    cancelEditor,
    saveEditor,
    updateDraft,
    resetOverride,
    renderDescriptionDisplay,
    // Internal: so consumers can check if a particular editor is open
    // (used by surfaces that need to suppress their own click handlers
    // while an editor is active).
    isEditingActive: () => !!activeEditor
  };
}
