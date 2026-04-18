// char-advantages.js
// Handles the Advantages and Disadvantages sections at the bottom of the
// character sheet.
//
// Each side renders as a series of cards grouped by category (Physical,
// Mental, Social, Background, Special). Cards show:
//   - XP cost/grant + tier label + name on top (bold)
//   - Italicized flavor description
//   - Plain-text mechanical system
//
// Players pick from a dropdown populated by the active ruleset's catalog.
// A "+ Custom entry" option at the bottom lets the GM add a free-text
// advantage/disadvantage that isn't in the ruleset.
//
// Non-repeatable entries can only be taken once per character. The picker
// filters out any non-repeatable entry already on the character.
//
// Data shape on charData:
//   charData.advantages:    [{ name, tier, isCustom, description?, system? }, ...]
//   charData.disadvantages: [{ name, tier, isCustom, description?, system? }, ...]
//
// Ruleset entries store only { name, tier, isCustom:false } — description
// and system come from the ruleset catalog at render time, so editing the
// ruleset propagates automatically. Custom entries carry their own
// description, system, and category locally.

import { saveCharacter } from './char-firestore.js';

export function createAdvantagesSection(ctx) {
  // ctx shape:
  //   getCharData()   -> live charData
  //   getCanEdit()    -> boolean
  //   getCharId()     -> string
  //   getRuleset()    -> active ruleset
  //   saveXpSpent()   -> async: recompute total XP after any change

  // Fallback tier labels if the ruleset is missing them (shouldn't happen
  // with a normalized ruleset, but keeps rendering safe).
  const TIER_FALLBACK = ['Minor','Moderate','Major','Massive','Monumental','Mega','Mythical'];

  const CATEGORIES = [
    { code: 'physical',   label: 'Physical'   },
    { code: 'mental',     label: 'Mental'     },
    { code: 'social',     label: 'Social'     },
    { code: 'background', label: 'Background' },
    { code: 'special',    label: 'Special'    }
  ];

  // ─── RULESET LOOKUPS ───

  function tiersFor(side) {
    const rs = ctx.getRuleset() || {};
    const arr = side === 'adv' ? rs.advantageTiers : rs.disadvantageTiers;
    if (Array.isArray(arr) && arr.length > 0) return arr;
    return TIER_FALLBACK.map(label => ({ label, description: '', xp: 0 }));
  }

  function catalogFor(side) {
    const rs = ctx.getRuleset() || {};
    const arr = side === 'adv' ? rs.advantages : rs.disadvantages;
    return Array.isArray(arr) ? arr : [];
  }

  function charKey(side) { return side === 'adv' ? 'advantages' : 'disadvantages'; }

  // XP value for a given entry. Ruleset entries look up the tier's XP;
  // custom entries do the same using the character's stored tier index.
  function xpValueFor(side, entry) {
    const tiers = tiersFor(side);
    const t = tiers[entry.tier] || tiers[0] || { xp: 0 };
    return Number.isFinite(t.xp) ? t.xp : 0;
  }

  // Signed XP contribution to total spent: positive for advantages (cost),
  // negative for disadvantages (grant).
  function xpDeltaFor(side, entry) {
    const xp = xpValueFor(side, entry);
    return side === 'adv' ? xp : -xp;
  }

  // Tier label for an entry.
  function tierLabelFor(side, entry) {
    const tiers = tiersFor(side);
    return (tiers[entry.tier] && tiers[entry.tier].label) || TIER_FALLBACK[entry.tier] || '?';
  }

  // Description, system, category for an entry — prefer ruleset data for
  // non-custom entries so ruleset edits propagate.
  function detailsFor(side, entry) {
    if (entry.isCustom) {
      return {
        description: entry.description || '',
        system: entry.system || '',
        category: entry.category || 'special'
      };
    }
    const match = catalogFor(side).find(e => e.name === entry.name);
    return {
      description: match ? (match.description || '') : '',
      system: match ? (match.system || '') : '',
      category: match ? (match.category || 'special') : 'special'
    };
  }

  // Is this entry repeatable? Custom entries default to non-repeatable;
  // ruleset entries check the catalog.
  function isRepeatable(side, entry) {
    if (entry.isCustom) return entry.repeatable === true;
    const match = catalogFor(side).find(e => e.name === entry.name);
    return match ? (match.repeatable === true) : false;
  }

  // ─── PUBLIC: XP DELTA (for calcTotalXp) ───

  // Total signed XP contributed by this section. Advantages add to total
  // spent; disadvantages subtract from it (grant free XP back).
  function totalXpDelta() {
    const charData = ctx.getCharData();
    let total = 0;
    (charData.advantages    || []).forEach(e => { total += xpDeltaFor('adv', e); });
    (charData.disadvantages || []).forEach(e => { total += xpDeltaFor('dis', e); });
    return total;
  }

  // ─── RENDERING ───

  function renderAll() {
    renderSide('adv');
    renderSide('dis');
    const canEdit = ctx.getCanEdit();
    const advAdd = document.getElementById('adv-add-btn');
    const disAdd = document.getElementById('dis-add-btn');
    if (advAdd) advAdd.style.display = canEdit ? 'inline-block' : 'none';
    if (disAdd) disAdd.style.display = canEdit ? 'inline-block' : 'none';
  }

  function renderSide(side) {
    const container = document.getElementById(side + '-list');
    if (!container) return;
    const charData = ctx.getCharData();
    const entries = charData[charKey(side)] || [];

    if (entries.length === 0) {
      container.innerHTML = `<div class="ad-empty">No ${side === 'adv' ? 'advantages' : 'disadvantages'} ${ctx.getCanEdit() ? 'yet — add some below.' : 'selected.'}</div>`;
      return;
    }

    // Group entries by category. Remember the original index so edit/delete
    // actions can locate the correct slot in the source array.
    const buckets = {};
    CATEGORIES.forEach(c => { buckets[c.code] = []; });
    entries.forEach((entry, origIdx) => {
      const details = detailsFor(side, entry);
      const cat = details.category;
      if (!buckets[cat]) buckets[cat] = [];
      buckets[cat].push({ entry, origIdx, details });
    });

    let html = '';
    CATEGORIES.forEach(c => {
      const items = buckets[c.code];
      if (!items || items.length === 0) return;
      html += `<div class="ad-cat-group">`;
      html += `<div class="ad-cat-title">${c.label}</div>`;
      html += `<div class="ad-cards">`;
      items.forEach(({ entry, origIdx, details }) => {
        html += renderCard(side, entry, origIdx, details);
      });
      html += `</div></div>`;
    });

    container.innerHTML = html || `<div class="ad-empty">No ${side === 'adv' ? 'advantages' : 'disadvantages'} selected.</div>`;
  }

  function renderCard(side, entry, origIdx, details) {
    const xp = xpValueFor(side, entry);
    // Display convention:
    //   Advantages cost XP — show plain "12 XP"
    //   Disadvantages grant XP — show "+12 XP" to signal the positive gain
    const xpStr = xp === 0
      ? '0 XP'
      : (side === 'adv' ? `${xp} XP` : `+${xp} XP`);
    const xpClass = side === 'adv' ? 'ad-card-xp-adv' : 'ad-card-xp-dis';
    const tierLabel = tierLabelFor(side, entry);
    const customBadge = entry.isCustom ? `<span class="ad-card-custom" title="Custom / GM-granted">Custom</span>` : '';
    const deleteBtn = ctx.getCanEdit()
      ? `<span class="ad-card-delete" onclick="removeAdEntry('${side}',${origIdx})" title="Remove">×</span>`
      : '';

    // System and description are optional; only render their rows if present.
    const descHtml = details.description
      ? `<div class="ad-card-desc">${escapeHtml(details.description)}</div>` : '';
    const sysHtml = details.system
      ? `<div class="ad-card-system">${escapeHtml(details.system)}</div>` : '';

    return `
      <div class="ad-card">
        <div class="ad-card-head">
          <span class="ad-card-xp ${xpClass}">${xpStr}</span>
          <span class="ad-card-tier">${tierLabel}</span>
          <span class="ad-card-name">${escapeHtml(entry.name)}</span>
          ${customBadge}
          ${deleteBtn}
        </div>
        ${descHtml}
        ${sysHtml}
      </div>`;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── ADD FLOW ───
  //
  // Clicking "+ Add Advantage" opens a modal-style form inline. The form has:
  //   1. A search input that filters the catalog by name
  //   2. A dropdown listing catalog entries, grouped by category as <optgroup>
  //   3. A "Custom entry" option at the bottom that switches the form into
  //      a free-text mode (name, category, tier, description, system)
  //   4. Save / Cancel buttons
  //
  // Non-repeatable ruleset entries already taken by the character are
  // filtered out of the dropdown so the user can't double-pick.

  // Per-side form state (mode + custom fields + current catalog selection).
  const formState = {
    adv: { open: false, mode: 'catalog', catalogName: '', searchText: '',
           customName: '', customCategory: 'physical', customTier: 0,
           customDescription: '', customSystem: '' },
    dis: { open: false, mode: 'catalog', catalogName: '', searchText: '',
           customName: '', customCategory: 'physical', customTier: 0,
           customDescription: '', customSystem: '' }
  };

  function openAddForm(side) {
    if (!ctx.getCanEdit()) return;
    formState[side].open = true;
    // Reset transient state so a reopen doesn't surface stale input.
    Object.assign(formState[side], {
      mode: 'catalog', catalogName: '', searchText: '',
      customName: '', customCategory: 'physical', customTier: 0,
      customDescription: '', customSystem: ''
    });
    renderAddForm(side);
  }

  function closeAddForm(side) {
    formState[side].open = false;
    const container = document.getElementById(side + '-add-form');
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
  }

  function renderAddForm(side) {
    const container = document.getElementById(side + '-add-form');
    if (!container) return;
    const st = formState[side];
    if (!st.open) { container.innerHTML = ''; container.style.display = 'none'; return; }
    container.style.display = 'block';

    const charData = ctx.getCharData();
    const catalog = catalogFor(side);
    const tiers = tiersFor(side);
    const takenNonRepeatable = new Set(
      (charData[charKey(side)] || [])
        .filter(e => !e.isCustom && !isRepeatable(side, e))
        .map(e => e.name)
    );

    // Filter the catalog by search text and dedupe already-taken non-repeatables.
    const search = (st.searchText || '').toLowerCase().trim();
    const availableByCategory = {};
    CATEGORIES.forEach(c => { availableByCategory[c.code] = []; });
    catalog.forEach(entry => {
      if (takenNonRepeatable.has(entry.name)) return;
      if (search && !entry.name.toLowerCase().includes(search)) return;
      const cat = entry.category || 'special';
      if (!availableByCategory[cat]) availableByCategory[cat] = [];
      availableByCategory[cat].push(entry);
    });

    // ── CATALOG MODE ──
    if (st.mode === 'catalog') {
      const optgroups = CATEGORIES
        .map(c => {
          const items = availableByCategory[c.code];
          if (!items || items.length === 0) return '';
          return `<optgroup label="${c.label}">` +
            items.map(e => {
              const xp = xpValueFor(side, e);
              const tierLbl = (tiers[e.tier] && tiers[e.tier].label) || TIER_FALLBACK[e.tier] || '?';
              // Match card convention: advantages = plain "12 XP", disadvantages = "+12 XP".
              const xpStr = side === 'adv' ? `${xp} XP` : `+${xp} XP`;
              const selected = e.name === st.catalogName ? 'selected' : '';
              return `<option value="${escapeHtml(e.name)}" ${selected}>${xpStr} · ${tierLbl} · ${escapeHtml(e.name)}</option>`;
            }).join('') +
          `</optgroup>`;
        })
        .filter(Boolean)
        .join('');

      const catalogEmpty = !optgroups;

      // Preview the currently-selected entry (description + system).
      let preview = '';
      if (st.catalogName) {
        const match = catalog.find(e => e.name === st.catalogName);
        if (match) {
          const desc = match.description ? `<div class="ad-card-desc">${escapeHtml(match.description)}</div>` : '';
          const sys = match.system ? `<div class="ad-card-system">${escapeHtml(match.system)}</div>` : '';
          preview = `<div class="ad-form-preview">${desc}${sys}</div>`;
        }
      }

      container.innerHTML = `
        <div class="ad-form">
          <div class="ad-form-header">
            <span class="ad-form-title">Add ${side === 'adv' ? 'Advantage' : 'Disadvantage'}</span>
            <span class="ad-form-mode-switch" onclick="setAdFormMode('${side}','custom')">Create custom →</span>
          </div>
          <input type="text" class="ad-form-search" placeholder="Search by name…"
                 value="${escapeHtml(st.searchText)}"
                 oninput="updateAdFormSearch('${side}',this.value)">
          ${catalogEmpty
            ? `<div class="ad-form-empty">No ${search ? 'matching entries' : 'entries available'} in the ruleset${search ? '' : ' (or all non-repeatable entries are already taken)'}. You can still create a custom entry.</div>`
            : `<select class="ad-form-select" size="8" onchange="updateAdFormCatalog('${side}',this.value)" ondblclick="commitAdFormCatalog('${side}')">${optgroups}</select>`
          }
          ${preview}
          <div class="ad-form-actions">
            <button class="ad-form-btn ad-form-btn-primary"
                    onclick="commitAdFormCatalog('${side}')"
                    ${catalogEmpty || !st.catalogName ? 'disabled' : ''}>
              Add
            </button>
            <button class="ad-form-btn" onclick="closeAdForm('${side}')">Cancel</button>
          </div>
        </div>`;
      return;
    }

    // ── CUSTOM MODE ──
    const catOptions = CATEGORIES.map(c =>
      `<option value="${c.code}" ${c.code === st.customCategory ? 'selected' : ''}>${c.label}</option>`
    ).join('');
    const tierOptions = tiers.map((t, i) =>
      `<option value="${i}" ${i === st.customTier ? 'selected' : ''}>${i+1}. ${escapeHtml(t.label || ('Tier ' + (i+1)))} (${side === 'adv' ? '' : '+'}${t.xp || 0} XP)</option>`
    ).join('');

    container.innerHTML = `
      <div class="ad-form">
        <div class="ad-form-header">
          <span class="ad-form-title">Custom ${side === 'adv' ? 'Advantage' : 'Disadvantage'}</span>
          <span class="ad-form-mode-switch" onclick="setAdFormMode('${side}','catalog')">← Pick from ruleset</span>
        </div>
        <div class="ad-form-field">
          <label>Name</label>
          <input type="text" value="${escapeHtml(st.customName)}"
                 placeholder="e.g. Marked by the Crown"
                 oninput="updateAdFormCustom('${side}','name',this.value)">
        </div>
        <div class="ad-form-row">
          <div class="ad-form-field">
            <label>Category</label>
            <select onchange="updateAdFormCustom('${side}','category',this.value)">${catOptions}</select>
          </div>
          <div class="ad-form-field">
            <label>Tier</label>
            <select onchange="updateAdFormCustom('${side}','tier',parseInt(this.value))">${tierOptions}</select>
          </div>
        </div>
        <div class="ad-form-field">
          <label>Description <span style="color:#555;font-weight:400;text-transform:none;letter-spacing:0">— flavor</span></label>
          <textarea rows="2" placeholder="Flavor text"
                    oninput="updateAdFormCustom('${side}','description',this.value)">${escapeHtml(st.customDescription)}</textarea>
        </div>
        <div class="ad-form-field">
          <label>System <span style="color:#555;font-weight:400;text-transform:none;letter-spacing:0">— mechanical effect</span></label>
          <textarea rows="2" placeholder="Mechanical effect"
                    oninput="updateAdFormCustom('${side}','system',this.value)">${escapeHtml(st.customSystem)}</textarea>
        </div>
        <div class="ad-form-actions">
          <button class="ad-form-btn ad-form-btn-primary"
                  onclick="commitAdFormCustom('${side}')"
                  ${!st.customName.trim() ? 'disabled' : ''}>
            Add
          </button>
          <button class="ad-form-btn" onclick="closeAdForm('${side}')">Cancel</button>
        </div>
      </div>`;
  }

  // ─── FORM HANDLERS ───

  function setFormMode(side, mode) {
    formState[side].mode = mode;
    renderAddForm(side);
  }

  function updateSearch(side, val) {
    formState[side].searchText = val;
    renderAddForm(side);
  }

  function updateCatalog(side, name) {
    formState[side].catalogName = name;
    renderAddForm(side);
  }

  function updateCustom(side, field, value) {
    formState[side][ 'custom' + field.charAt(0).toUpperCase() + field.slice(1) ] = value;
    // Re-render only if the change affects button enablement or dropdowns.
    if (field === 'name') {
      // Minimal repaint: flip the disabled state on the Add button without
      // re-rendering the whole form (which would steal focus from the field).
      const form = document.getElementById(side + '-add-form');
      if (!form) return;
      const btn = form.querySelector('.ad-form-btn-primary');
      if (btn) btn.disabled = !value.trim();
    }
  }

  // Commit a ruleset-catalog entry onto the character.
  async function commitCatalog(side) {
    const st = formState[side];
    if (!st.catalogName) return;
    const catalog = catalogFor(side);
    const match = catalog.find(e => e.name === st.catalogName);
    if (!match) return;

    // Double-check the non-repeatable rule in case state drifted.
    const charData = ctx.getCharData();
    const list = charData[charKey(side)] || [];
    if (!match.repeatable && list.some(e => !e.isCustom && e.name === match.name)) {
      alert(`"${match.name}" can only be taken once.`);
      return;
    }

    const newEntry = {
      name: match.name,
      tier: match.tier,
      isCustom: false
    };

    if (!charData[charKey(side)]) charData[charKey(side)] = [];
    charData[charKey(side)].push(newEntry);

    await saveCharacter(ctx.getCharId(), { [charKey(side)]: charData[charKey(side)] });
    await ctx.saveXpSpent();
    closeAddForm(side);
    renderSide(side);
  }

  // Commit a custom free-text entry onto the character.
  async function commitCustom(side) {
    const st = formState[side];
    const name = (st.customName || '').trim();
    if (!name) return;

    const charData = ctx.getCharData();
    const newEntry = {
      name,
      tier: st.customTier,
      category: st.customCategory,
      description: (st.customDescription || '').trim(),
      system: (st.customSystem || '').trim(),
      isCustom: true
    };

    if (!charData[charKey(side)]) charData[charKey(side)] = [];
    charData[charKey(side)].push(newEntry);

    await saveCharacter(ctx.getCharId(), { [charKey(side)]: charData[charKey(side)] });
    await ctx.saveXpSpent();
    closeAddForm(side);
    renderSide(side);
  }

  async function removeEntry(side, i) {
    if (!ctx.getCanEdit()) return;
    const charData = ctx.getCharData();
    const list = charData[charKey(side)];
    if (!list || !list[i]) return;
    if (!confirm(`Remove "${list[i].name}"?`)) return;
    list.splice(i, 1);
    await saveCharacter(ctx.getCharId(), { [charKey(side)]: list });
    await ctx.saveXpSpent();
    renderSide(side);
  }

  return {
    renderAll, renderSide,
    totalXpDelta,
    openAddForm, closeAddForm,
    setFormMode, updateSearch, updateCatalog, updateCustom,
    commitCatalog, commitCustom,
    removeEntry,
  };
}
