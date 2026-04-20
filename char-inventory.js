// char-inventory.js
//
// Inventory tab — nested container tree with live overflow computation.
// Characters attach containers to body slots (from the ruleset's bodySlots
// catalog) and drop items into them; containers can also nest inside other
// containers without depth limit.
//
// The system is INFORMATIONAL ONLY — overflow is flagged with a red pill
// and a tooltip, but nothing prevents putting too much stuff in a bag.
// GMs adjudicate whether a bulging duffel is "it works, just conspicuous"
// or "no, you can't fit a shotgun in a purse." Storage model:
//
//   charData.inventory = {
//     bySlot: { [slotCode]: [entry, ...], ... },
//     stowed: [entry, ...]                        // not worn; in a vehicle, etc.
//   }
//
//   entry = {
//     id:        'inv_...',             // per-instance unique id
//     defId:     'cont_...' | 'eq_...', // reference into ruleset catalog
//     defKind:   'container' | 'equipment',
//     quantity:  1,
//     customName?: string,               // optional per-instance rename
//     notes?:    string,
//     contents?: [entry, ...]            // only for containers / equipment
//                                        // with a containerOf block
//   }
//
// The ruleset-side defs hold the size/weight/packing schema. Inventory
// entries hold only the reference + per-instance quirks, so a ruleset
// edit (say, resizing a duffel bag def) instantly reflects on every
// character using it. No data duplication, no migration pain.
//
// ctx shape:
//   getCharId()   → doc id
//   getCharData() → live charData
//   getCanEdit()  → boolean (only owner can modify)
//   getRuleset()  → active ruleset (provides bodySlots, containers, equipment)
//   saveCharacter → Firestore writer
//   escapeHtml    → shared HTML-escape
//   fmt           → shared number formatter

import { saveCharacter } from './char-firestore.js';

export function createInventorySection(ctx) {
  const { getCharId, getCharData, getCanEdit, getRuleset } = ctx;
  const escapeHtml = ctx.escapeHtml || defaultEscapeHtml;
  const fmt = ctx.fmt || defaultFmt;

  // ─── UI-ONLY STATE ───
  //
  // Which containers are currently expanded (showing their contents). A
  // Set of entry ids. Not persisted — reset on page reload. Top-level
  // slot sections default to open; nested containers default to closed.

  const expandedEntries = new Set();

  // Which slots have their whole section collapsed. Stored BY CODE.
  // Default is all-open. Used so a user can fold away unused slots.
  const collapsedSlots = new Set();

  // Modal state for the "Add Item" and "Add Container" flows. Null when
  // no modal is open. { kind: 'container'|'item', target: slotCode | entryId }
  let activeModal = null;

  // ─── DEF LOOKUP ───

  function getContainerDef(id) {
    const ruleset = getRuleset();
    return (ruleset.containers || []).find(c => c.id === id) || null;
  }
  function getEquipmentDef(id) {
    const ruleset = getRuleset();
    return (ruleset.equipment || []).find(e => e.id === id) || null;
  }
  function getDefForEntry(entry) {
    if (!entry) return null;
    return entry.defKind === 'container' ? getContainerDef(entry.defId)
         : entry.defKind === 'equipment' ? getEquipmentDef(entry.defId)
         : null;
  }

  // An entry "is a container" if its def is a Container, OR if it's an
  // Equipment with a containerOf block. Same shape either way — we just
  // have to look in two places for the dimensions/packing.
  function entryIsContainer(entry) {
    const def = getDefForEntry(entry);
    if (!def) return false;
    if (entry.defKind === 'container') return true;
    if (entry.defKind === 'equipment' && def.containerOf) return true;
    return false;
  }

  // Get the "inner" container spec (dimensions + packingEfficiency) from
  // an entry that is a container. For pure Container defs this is the
  // def itself. For Equipment with containerOf, it's the nested block.
  function innerSpec(entry) {
    const def = getDefForEntry(entry);
    if (!def) return null;
    if (entry.defKind === 'container') {
      return { dimensions: def.dimensions, packingEfficiency: def.packingEfficiency };
    }
    if (entry.defKind === 'equipment' && def.containerOf) {
      return def.containerOf;
    }
    return null;
  }

  // Display name: custom rename wins, otherwise def name. Falls back to
  // a placeholder if the def has since been deleted from the ruleset
  // (avoids blanking out everything when a GM cleans up the catalog).
  function entryName(entry) {
    if (entry.customName && entry.customName.trim()) return entry.customName.trim();
    const def = getDefForEntry(entry);
    return def && def.name ? def.name : '(missing def)';
  }

  // ─── OVERFLOW COMPUTATION ───
  //
  // Walk a container entry's contents bottom-up, computing aggregate
  // weight, used volume, and per-axis overflow. Items that don't fit
  // dimensionally (longest item dim > longest container dim, etc.) are
  // still counted toward volume — GM adjudicates the whole mess.
  //
  // Returns: {
  //   totalWeight,     // pounds, including self + all descendants
  //   usedVolume,      // cubic inches used by direct children's outer dims
  //   availableVolume, // inner dims × packingEfficiency, cubic inches
  //   volumeOver,      // boolean
  //   volumeOverBy,    // cubic inches overflowing, >= 0
  //   dimIssues        // [{entryId, axis, itemVal, contVal}] per-item dim overflows
  // }

  function computeContainerStats(entry) {
    const def = getDefForEntry(entry);
    const spec = innerSpec(entry);
    const result = {
      totalWeight:     (def && def.weight) ? def.weight * (entry.quantity || 1) : 0,
      usedVolume:      0,
      availableVolume: 0,
      volumeOver:      false,
      volumeOverBy:    0,
      dimIssues:       []
    };
    if (!spec) return result;
    const d = spec.dimensions || { l: 0, w: 0, h: 0 };
    const rawVolume = (d.l || 0) * (d.w || 0) * (d.h || 0);
    const eff = Number.isFinite(spec.packingEfficiency) ? spec.packingEfficiency : 0.75;
    result.availableVolume = rawVolume * eff;

    // Longest container dimension for the per-item fit check.
    const contMaxDim = Math.max(d.l || 0, d.w || 0, d.h || 0);

    const contents = Array.isArray(entry.contents) ? entry.contents : [];
    contents.forEach(child => {
      const cdef = getDefForEntry(child);
      if (!cdef) return;
      const cd = cdef.dimensions || { l: 0, w: 0, h: 0 };
      const qty = child.quantity || 1;

      // Volume and weight contribution. Both stack with quantity — carrying
      // 10 shotgun shells is 10× the volume of one shell (approximately;
      // realistically they'd tessellate tighter, but the packing efficiency
      // factor already accounts for that).
      const itemVolume = (cd.l || 0) * (cd.w || 0) * (cd.h || 0) * qty;
      result.usedVolume += itemVolume;

      // Longest-axis dimension check. If an item's longest dimension
      // exceeds the container's longest dimension, it can't fit at any
      // orientation without bulging. Record the issue; still count the
      // volume.
      const itemMaxDim = Math.max(cd.l || 0, cd.w || 0, cd.h || 0);
      if (itemMaxDim > contMaxDim && contMaxDim > 0) {
        result.dimIssues.push({
          entryId: child.id,
          itemVal: itemMaxDim,
          contVal: contMaxDim
        });
      }

      // Recurse: the child's totalWeight flows up (a backpack-in-backpack's
      // contents weigh on the outer pack too).
      if (entryIsContainer(child)) {
        const sub = computeContainerStats(child);
        result.totalWeight += sub.totalWeight;
      } else {
        result.totalWeight += (cdef.weight || 0) * qty;
      }
    });

    if (result.usedVolume > result.availableVolume) {
      result.volumeOver = true;
      result.volumeOverBy = result.usedVolume - result.availableVolume;
    }
    return result;
  }

  // ─── ID HELPERS ───

  const _nextId = (() => {
    let n = 0;
    return () => `inv_${Date.now().toString(36)}_${(n++).toString(36)}`;
  })();

  // Ensure charData.inventory has the expected shape. Mutates in place.
  // Called before any read/write so legacy characters don't crash.
  function ensureInventory() {
    const charData = getCharData();
    if (!charData.inventory || typeof charData.inventory !== 'object') {
      charData.inventory = { bySlot: {}, stowed: [] };
    }
    if (!charData.inventory.bySlot || typeof charData.inventory.bySlot !== 'object') {
      charData.inventory.bySlot = {};
    }
    if (!Array.isArray(charData.inventory.stowed)) {
      charData.inventory.stowed = [];
    }
    return charData.inventory;
  }

  // Walk the inventory tree, calling visit(entry, parentArray, index) for
  // each entry. Useful for find-by-id, remove-by-id, etc.
  function walkTree(visit) {
    const inv = ensureInventory();
    const visitArr = (arr) => {
      for (let i = 0; i < arr.length; i++) {
        visit(arr[i], arr, i);
        if (Array.isArray(arr[i].contents)) visitArr(arr[i].contents);
      }
    };
    Object.values(inv.bySlot).forEach(visitArr);
    visitArr(inv.stowed);
  }

  function findEntry(id) {
    if (!id) return null;
    let found = null;
    walkTree((entry) => { if (entry.id === id) found = entry; });
    return found;
  }

  function removeEntry(id) {
    const inv = ensureInventory();
    const removeFromArr = (arr) => {
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].id === id) { arr.splice(i, 1); return true; }
        if (Array.isArray(arr[i].contents) && removeFromArr(arr[i].contents)) return true;
      }
      return false;
    };
    for (const slotCode of Object.keys(inv.bySlot)) {
      if (removeFromArr(inv.bySlot[slotCode])) return true;
    }
    return removeFromArr(inv.stowed);
  }

  // ─── PERSISTENCE ───

  async function save() {
    const inv = ensureInventory();
    await saveCharacter(getCharId(), { inventory: inv });
  }

  // ─── MAIN RENDER ───

  function renderAll() {
    const host = document.getElementById('inventory-content');
    if (!host) return;
    const ruleset = getRuleset();
    if (!ruleset) {
      host.innerHTML = '<div class="inv-empty">No ruleset loaded.</div>';
      return;
    }
    if (!Array.isArray(ruleset.bodySlots) || ruleset.bodySlots.length === 0) {
      host.innerHTML = '<div class="inv-empty">This ruleset defines no body slots. Open the ruleset editor to add some.</div>';
      return;
    }

    const inv = ensureInventory();
    const canEdit = getCanEdit();

    let html = '';

    // One section per body slot. Each shows the containers attached, plus
    // an "Add Container" button. Empty slots are still shown — visible
    // slot list tells the player what they're wearing (or not).
    ruleset.bodySlots.forEach(slot => {
      html += renderSlotSection(slot, inv.bySlot[slot.code] || [], canEdit);
    });

    // The Stowed bucket is always last — things not currently worn.
    html += renderStowedSection(inv.stowed, canEdit);

    // Modal host — only gets content when activeModal is set.
    html += '<div id="inv-modal-root"></div>';

    host.innerHTML = html;

    if (activeModal) renderActiveModal();
  }

  // ─── SECTION RENDERERS ───

  function renderSlotSection(slot, entries, canEdit) {
    const collapsed = collapsedSlots.has(slot.code);
    const entryCount = entries.length;
    const totalWeight = entries.reduce((acc, e) => {
      if (entryIsContainer(e)) return acc + computeContainerStats(e).totalWeight;
      const def = getDefForEntry(e);
      return acc + (def ? (def.weight || 0) * (e.quantity || 1) : 0);
    }, 0);

    let html = `<div class="inv-slot-section${collapsed ? ' collapsed' : ''}">
      <div class="inv-slot-head" onclick="invToggleSlot('${escapeHtml(slot.code)}')">
        <span class="inv-slot-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="inv-slot-label">${escapeHtml(slot.label)}</span>
        <span class="inv-slot-meta">${entryCount} item${entryCount === 1 ? '' : 's'} · ${fmt(totalWeight)} lb${totalWeight === 1 ? '' : 's'}</span>
      </div>`;

    if (!collapsed) {
      html += '<div class="inv-slot-body">';
      if (entries.length === 0) {
        html += '<div class="inv-empty-row">Empty.</div>';
      } else {
        entries.forEach(e => { html += renderEntry(e, 0, canEdit); });
      }
      if (canEdit) {
        html += `<div class="inv-slot-actions">
          <button class="inv-add-btn" onclick="invOpenAddContainer('${escapeHtml(slot.code)}')">+ Add Container</button>
          <button class="inv-add-btn inv-add-btn-ghost" onclick="invOpenAddItem('${escapeHtml(slot.code)}','slot')">+ Add Loose Item</button>
        </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderStowedSection(entries, canEdit) {
    const collapsed = collapsedSlots.has('__stowed__');
    const entryCount = entries.length;
    const totalWeight = entries.reduce((acc, e) => {
      if (entryIsContainer(e)) return acc + computeContainerStats(e).totalWeight;
      const def = getDefForEntry(e);
      return acc + (def ? (def.weight || 0) * (e.quantity || 1) : 0);
    }, 0);

    let html = `<div class="inv-slot-section inv-slot-stowed${collapsed ? ' collapsed' : ''}">
      <div class="inv-slot-head" onclick="invToggleSlot('__stowed__')">
        <span class="inv-slot-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="inv-slot-label">Stowed</span>
        <span class="inv-slot-meta">${entryCount} item${entryCount === 1 ? '' : 's'} · ${fmt(totalWeight)} lb${totalWeight === 1 ? '' : 's'}</span>
      </div>`;

    if (!collapsed) {
      html += '<div class="inv-slot-body">';
      if (entries.length === 0) {
        html += '<div class="inv-empty-row">Nothing stowed. Items here live in a vehicle, a safehouse, or aren\'t currently on your person.</div>';
      } else {
        entries.forEach(e => { html += renderEntry(e, 0, canEdit); });
      }
      if (canEdit) {
        html += `<div class="inv-slot-actions">
          <button class="inv-add-btn" onclick="invOpenAddContainer('__stowed__')">+ Add Container</button>
          <button class="inv-add-btn inv-add-btn-ghost" onclick="invOpenAddItem('__stowed__','slot')">+ Add Loose Item</button>
        </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── ENTRY RENDERERS ───
  //
  // An entry is either a container (renders as a collapsible card with
  // contents + add buttons inside) or a leaf item (renders as a single
  // row). Depth controls left indentation so nesting reads clearly.

  function renderEntry(entry, depth, canEdit) {
    if (entryIsContainer(entry)) {
      return renderContainerEntry(entry, depth, canEdit);
    }
    return renderItemEntry(entry, depth, canEdit);
  }

  function renderContainerEntry(entry, depth, canEdit) {
    const def = getDefForEntry(entry);
    if (!def) {
      return `<div class="inv-entry inv-entry-missing" style="margin-left:${depth * 16}px">
        <span class="inv-entry-name">(deleted def: ${escapeHtml(entry.defId || '')})</span>
        ${canEdit ? `<button class="inv-row-btn" onclick="invRemoveEntry('${escapeHtml(entry.id)}')">Remove</button>` : ''}
      </div>`;
    }

    const open = expandedEntries.has(entry.id);
    const stats = computeContainerStats(entry);
    const spec = innerSpec(entry);
    const dims = (spec && spec.dimensions) || { l: 0, w: 0, h: 0 };
    const name = entryName(entry);
    const outerDims = def.dimensions || { l: 0, w: 0, h: 0 };
    const hasOverflow = stats.volumeOver || stats.dimIssues.length > 0;

    let badge = '';
    if (hasOverflow) {
      const parts = [];
      if (stats.volumeOver) parts.push(`Vol +${fmt(stats.volumeOverBy)} in³`);
      if (stats.dimIssues.length > 0) parts.push(`${stats.dimIssues.length} dim issue${stats.dimIssues.length === 1 ? '' : 's'}`);
      const tipParts = [];
      if (stats.volumeOver) {
        tipParts.push(`Volume: using ${fmt(stats.usedVolume)}/${fmt(stats.availableVolume)} in³ (${fmt(stats.volumeOverBy)} over).`);
      }
      if (stats.dimIssues.length > 0) {
        tipParts.push('Items exceeding container\'s longest dimension:');
        stats.dimIssues.forEach(d => {
          const child = (entry.contents || []).find(c => c.id === d.entryId);
          const childName = child ? entryName(child) : '(?)';
          tipParts.push(`• ${childName} (${fmt(d.itemVal)} > ${fmt(d.contVal)})`);
        });
      }
      tipParts.push('GM adjudicates what\'s physically possible.');
      badge = `<span class="inv-overflow-pill" title="${escapeHtml(tipParts.join('\n'))}">${parts.join(' · ')}</span>`;
    }

    const pct = stats.availableVolume > 0
      ? Math.min(999, Math.round((stats.usedVolume / stats.availableVolume) * 100))
      : 0;

    let html = `<div class="inv-entry inv-entry-container${open ? ' open' : ''}" style="margin-left:${depth * 16}px">
      <div class="inv-entry-head" onclick="invToggleEntry('${escapeHtml(entry.id)}')">
        <span class="inv-entry-caret">${open ? '▾' : '▸'}</span>
        <span class="inv-entry-icon" title="Container">▣</span>
        <span class="inv-entry-name">${escapeHtml(name)}</span>
        <span class="inv-entry-dims">${fmt(outerDims.l)}×${fmt(outerDims.w)}×${fmt(outerDims.h)} in</span>
        <span class="inv-entry-capacity">${fmt(stats.usedVolume)}/${fmt(stats.availableVolume)} in³ (${pct}%)</span>
        <span class="inv-entry-weight">${fmt(stats.totalWeight)} lb</span>
        ${badge}
        ${canEdit ? `<button class="inv-row-btn inv-row-btn-danger" onclick="event.stopPropagation();invRemoveEntry('${escapeHtml(entry.id)}')" title="Remove this container (and everything inside)">×</button>` : ''}
      </div>`;

    if (open) {
      html += '<div class="inv-entry-body">';
      const contents = Array.isArray(entry.contents) ? entry.contents : [];
      if (contents.length === 0) {
        html += `<div class="inv-empty-row" style="margin-left:${(depth + 1) * 16}px">Empty.</div>`;
      } else {
        contents.forEach(child => { html += renderEntry(child, depth + 1, canEdit); });
      }
      if (canEdit) {
        html += `<div class="inv-entry-actions" style="margin-left:${(depth + 1) * 16}px">
          <button class="inv-add-btn inv-add-btn-sm" onclick="invOpenAddContainer('${escapeHtml(entry.id)}',true)">+ Container</button>
          <button class="inv-add-btn inv-add-btn-sm inv-add-btn-ghost" onclick="invOpenAddItem('${escapeHtml(entry.id)}','container')">+ Item</button>
        </div>`;
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function renderItemEntry(entry, depth, canEdit) {
    const def = getDefForEntry(entry);
    if (!def) {
      return `<div class="inv-entry inv-entry-missing" style="margin-left:${depth * 16}px">
        <span class="inv-entry-name">(deleted def: ${escapeHtml(entry.defId || '')})</span>
        ${canEdit ? `<button class="inv-row-btn" onclick="invRemoveEntry('${escapeHtml(entry.id)}')">Remove</button>` : ''}
      </div>`;
    }

    const name = entryName(entry);
    const dims = def.dimensions || { l: 0, w: 0, h: 0 };
    const qty = entry.quantity || 1;
    const totalWeight = (def.weight || 0) * qty;
    const catLabel = def.category ? ` · ${def.category}` : '';

    let html = `<div class="inv-entry inv-entry-item" style="margin-left:${depth * 16}px">
      <div class="inv-entry-head inv-entry-head-item">
        <span class="inv-entry-icon" title="Item">◆</span>
        <span class="inv-entry-name">${escapeHtml(name)}${escapeHtml(catLabel)}</span>
        <span class="inv-entry-qty">${canEdit
          ? `<button class="inv-qty-btn" onclick="invTickQty('${escapeHtml(entry.id)}',-1)" title="Decrease quantity" ${qty <= 1 ? 'disabled' : ''}>−</button>`
          : ''}
          <span class="inv-qty-val">×${qty}</span>
          ${canEdit
          ? `<button class="inv-qty-btn" onclick="invTickQty('${escapeHtml(entry.id)}',1)" title="Increase quantity">+</button>`
          : ''}
        </span>
        <span class="inv-entry-dims">${fmt(dims.l)}×${fmt(dims.w)}×${fmt(dims.h)} in</span>
        <span class="inv-entry-weight">${fmt(totalWeight)} lb</span>
        ${canEdit ? `<button class="inv-row-btn inv-row-btn-danger" onclick="invRemoveEntry('${escapeHtml(entry.id)}')" title="Remove this item">×</button>` : ''}
      </div>
    </div>`;
    return html;
  }

  // ─── MODALS: ADD CONTAINER / ADD ITEM ───
  //
  // Both modals pull from the ruleset catalogs and let the player pick a
  // def to instantiate. Container modal filters to `ruleset.containers`
  // plus any `ruleset.equipment` with a `containerOf` block (dual-role
  // items like ammo pouches count as containers for placement purposes).
  // Item modal lists all equipment.

  function renderActiveModal() {
    const root = document.getElementById('inv-modal-root');
    if (!root) return;
    if (!activeModal) { root.innerHTML = ''; return; }

    const ruleset = getRuleset();
    if (activeModal.kind === 'container') {
      // Container modal — ruleset containers + equipment-with-containerOf
      const options = [];
      (ruleset.containers || []).forEach(c => options.push({ kind: 'container', def: c }));
      (ruleset.equipment || []).filter(e => e.containerOf).forEach(e => options.push({ kind: 'equipment', def: e }));
      root.innerHTML = renderModal({
        title: 'Add Container',
        subtitle: activeModal.targetLabel || '',
        options,
        emptyMsg: 'No containers or container-like equipment in this ruleset yet. Open the ruleset editor\'s Inventory tab to add some.',
        onPickAttr: 'invPickContainerDef'
      });
    } else if (activeModal.kind === 'item') {
      const options = (ruleset.equipment || []).map(e => ({ kind: 'equipment', def: e }));
      root.innerHTML = renderModal({
        title: 'Add Item',
        subtitle: activeModal.targetLabel || '',
        options,
        emptyMsg: 'No equipment in this ruleset yet. Open the ruleset editor\'s Inventory tab to add some.',
        onPickAttr: 'invPickItemDef'
      });
    }
  }

  function renderModal({ title, subtitle, options, emptyMsg, onPickAttr }) {
    const listHtml = options.length === 0
      ? `<div class="inv-modal-empty">${escapeHtml(emptyMsg)}</div>`
      : options.map(opt => {
          const d = opt.def.dimensions || { l: 0, w: 0, h: 0 };
          const cat = opt.def.category ? `<span class="inv-modal-cat">${escapeHtml(opt.def.category)}</span>` : '';
          const isContainerDual = opt.kind === 'equipment' && opt.def.containerOf;
          const dualPill = isContainerDual ? '<span class="inv-modal-dual">dual-role</span>' : '';
          return `<div class="inv-modal-opt" onclick="${onPickAttr}('${escapeHtml(opt.kind)}','${escapeHtml(opt.def.id)}')">
            <div class="inv-modal-opt-name">${escapeHtml(opt.def.name)}${cat}${dualPill}</div>
            <div class="inv-modal-opt-meta">${fmt(d.l)}×${fmt(d.w)}×${fmt(d.h)} in · ${fmt(opt.def.weight || 0)} lb</div>
            ${opt.def.description ? `<div class="inv-modal-opt-desc">${escapeHtml(opt.def.description)}</div>` : ''}
          </div>`;
        }).join('');

    return `<div class="inv-modal-backdrop" onclick="invCloseModal(event)">
      <div class="inv-modal" onclick="event.stopPropagation()">
        <div class="inv-modal-head">
          <div class="inv-modal-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="inv-modal-sub">${escapeHtml(subtitle)}</div>` : ''}
          <button class="inv-modal-close" onclick="invCloseModal()">×</button>
        </div>
        <div class="inv-modal-body">
          ${listHtml}
        </div>
      </div>
    </div>`;
  }

  // ─── HANDLERS ───

  function toggleSlot(slotCode) {
    if (collapsedSlots.has(slotCode)) collapsedSlots.delete(slotCode);
    else collapsedSlots.add(slotCode);
    renderAll();
  }

  function toggleEntry(id) {
    if (expandedEntries.has(id)) expandedEntries.delete(id);
    else expandedEntries.add(id);
    renderAll();
  }

  // Add-container flow. `target` is a slot code, the special '__stowed__'
  // string, or (when fromContainer=true) a parent entry id.
  function openAddContainer(target, fromContainer = false) {
    if (!getCanEdit()) return;
    const ruleset = getRuleset();
    let label = '';
    if (fromContainer) {
      const parent = findEntry(target);
      label = parent ? `Inside: ${entryName(parent)}` : '';
    } else if (target === '__stowed__') {
      label = 'To: Stowed';
    } else {
      const slot = (ruleset.bodySlots || []).find(s => s.code === target);
      label = slot ? `To slot: ${slot.label}` : '';
    }
    activeModal = { kind: 'container', target, fromContainer, targetLabel: label };
    renderActiveModal();
  }

  function openAddItem(target, targetKind) {
    if (!getCanEdit()) return;
    const ruleset = getRuleset();
    let label = '';
    if (targetKind === 'container') {
      const parent = findEntry(target);
      label = parent ? `Inside: ${entryName(parent)}` : '';
    } else if (target === '__stowed__') {
      label = 'To: Stowed (loose)';
    } else {
      const slot = (ruleset.bodySlots || []).find(s => s.code === target);
      label = slot ? `To slot: ${slot.label} (loose)` : '';
    }
    activeModal = { kind: 'item', target, targetKind, targetLabel: label };
    renderActiveModal();
  }

  function closeModal() {
    activeModal = null;
    const root = document.getElementById('inv-modal-root');
    if (root) root.innerHTML = '';
  }

  async function pickContainerDef(defKind, defId) {
    if (!activeModal || activeModal.kind !== 'container') return;
    const inv = ensureInventory();
    const newEntry = {
      id: _nextId(),
      defId,
      defKind,
      quantity: 1,
      contents: []
    };
    if (activeModal.fromContainer) {
      const parent = findEntry(activeModal.target);
      if (!parent) { closeModal(); return; }
      if (!Array.isArray(parent.contents)) parent.contents = [];
      parent.contents.push(newEntry);
      expandedEntries.add(parent.id);
    } else if (activeModal.target === '__stowed__') {
      inv.stowed.push(newEntry);
    } else {
      const slotCode = activeModal.target;
      if (!Array.isArray(inv.bySlot[slotCode])) inv.bySlot[slotCode] = [];
      inv.bySlot[slotCode].push(newEntry);
    }
    expandedEntries.add(newEntry.id);   // auto-expand the new container
    closeModal();
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function pickItemDef(defKind, defId) {
    if (!activeModal || activeModal.kind !== 'item') return;
    const inv = ensureInventory();
    const def = defKind === 'equipment' ? getEquipmentDef(defId) : getContainerDef(defId);
    const newEntry = {
      id: _nextId(),
      defId,
      defKind,
      quantity: 1
    };
    // Equipment with containerOf gets contents array too (it IS a container).
    if (def && def.containerOf) newEntry.contents = [];

    if (activeModal.targetKind === 'container') {
      const parent = findEntry(activeModal.target);
      if (!parent) { closeModal(); return; }
      if (!Array.isArray(parent.contents)) parent.contents = [];
      parent.contents.push(newEntry);
      expandedEntries.add(parent.id);
    } else if (activeModal.target === '__stowed__') {
      inv.stowed.push(newEntry);
    } else {
      const slotCode = activeModal.target;
      if (!Array.isArray(inv.bySlot[slotCode])) inv.bySlot[slotCode] = [];
      inv.bySlot[slotCode].push(newEntry);
    }
    closeModal();
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function tickQty(id, delta) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry) return;
    const next = Math.max(1, (entry.quantity || 1) + delta);
    if (next === entry.quantity) return;
    entry.quantity = next;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function removeEntryHandler(id) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry) return;
    const isBig = entryIsContainer(entry) && Array.isArray(entry.contents) && entry.contents.length > 0;
    if (isBig) {
      const name = entryName(entry);
      if (!confirm(`Remove "${name}" and everything inside? This cannot be undone.`)) return;
    }
    removeEntry(id);
    expandedEntries.delete(id);
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  return {
    renderAll,
    toggleSlot,
    toggleEntry,
    openAddContainer,
    openAddItem,
    closeModal,
    pickContainerDef,
    pickItemDef,
    tickQty,
    removeEntry: removeEntryHandler
  };
}

// Default helpers — used if ctx didn't supply them.
function defaultEscapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function defaultFmt(n) {
  if (n == null || !Number.isFinite(n)) return '0';
  return (Math.round(n * 100) / 100).toString();
}
