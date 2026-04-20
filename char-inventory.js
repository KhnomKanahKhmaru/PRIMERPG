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

  // Which item entries have their description panel expanded. Separate
  // from expandedEntries because containers use expansion for "show
  // contents" and items use it for "show description/notes" — different
  // semantics, different default state (always collapsed for items).
  const expandedInfo = new Set();

  // Which slots have their whole section collapsed. Stored BY CODE.
  // Default is all-open. Used so a user can fold away unused slots.
  const collapsedSlots = new Set();

  // Which groups are collapsed — stored by group id. We do persist the
  // group's own `collapsed` flag to Firestore (part of the group record),
  // but we mirror it here for fast read access during render.
  //
  // Modal state for the "Add Item" and "Add Container" flows. Null when
  // no modal is open. Expanded shape: {
  //   kind:       'container' | 'item',
  //   target:     slotCode | groupId | entryId,
  //   targetKind: 'slot' | 'group' | 'container',
  //   targetLabel: string,
  //   showCustomForm: boolean,   // whether the inline custom def form is open
  //   customDraft: { ... }       // in-progress custom def fields
  // }
  let activeModal = null;

  // Character-scoped id counter for group/def synthesis. Prefixed so
  // ruleset ids (cont_ / eq_) and character custom ids (cust_cont_ /
  // cust_eq_) don't collide.
  const _nextInvId = (() => {
    let n = 0;
    return (prefix) => `${prefix}_${Date.now().toString(36)}_${(n++).toString(36)}`;
  })();

  // ─── DEF LOOKUP ───
  //
  // Under the unified schema, the ruleset has ONE items array — no more
  // containers/equipment split. An item is a container when its def's
  // `containerOf` block is populated. Character-scoped custom defs work
  // the same way; they live in charData.inventory.customDefs.containers
  // and .equipment for backwards compatibility with older charData but
  // get read as a merged pool (both arrays are walked on lookup).
  //
  // defKind on entries is now cosmetic — kept for legacy entries that
  // already have it set, but new entries don't need to distinguish.
  // containerness is determined by def.containerOf, not by defKind.

  function getItemDef(id) {
    if (!id) return null;
    const ruleset = getRuleset();
    const fromRuleset = (ruleset.items || []).find(x => x.id === id);
    if (fromRuleset) return fromRuleset;
    const inv = ensureInventory();
    // Walk both legacy customDef buckets so older character data still
    // resolves. New custom defs written today land in `.equipment` (for
    // plain items) or `.containers` (for custom pure-containers), but
    // either bucket works at lookup time.
    const fromCustomEq   = (inv.customDefs.equipment  || []).find(x => x.id === id);
    if (fromCustomEq) return fromCustomEq;
    const fromCustomCont = (inv.customDefs.containers || []).find(x => x.id === id);
    if (fromCustomCont) return fromCustomCont;
    return null;
  }

  // Legacy aliases — the rest of the module still calls these. They all
  // resolve via getItemDef now, so the legacy containers/equipment split
  // no longer matters at lookup time.
  function getContainerDef(id) { return getItemDef(id); }
  function getEquipmentDef(id) { return getItemDef(id); }

  function getDefForEntry(entry) {
    if (!entry) return null;
    return getItemDef(entry.defId);
  }

  // An entry "is a container" if its def has a containerOf block.
  // defKind is no longer consulted for this — the def's shape is
  // authoritative. This correctly handles:
  //   - Ruleset items with containerOf = container
  //   - Ruleset items without containerOf = plain item
  //   - Character custom defs follow the same rule
  //   - Legacy entries with defKind='container' (migrated defs now
  //     have containerOf synthesized from old top-level dims)
  function entryIsContainer(entry) {
    const def = getDefForEntry(entry);
    return !!(def && def.containerOf);
  }

  // Get the inner container spec (dimensions + packingEfficiency) from
  // an entry that is a container. After migration, every container's
  // capacity lives in def.containerOf. For legacy defs that still
  // expose top-level dimensions/packingEfficiency (migration safety),
  // we fall back to those if containerOf is missing.
  function innerSpec(entry) {
    const def = getDefForEntry(entry);
    if (!def) return null;
    if (def.containerOf) return def.containerOf;
    // Legacy fallback — shouldn't happen post-migration but defensive.
    if (def.packingEfficiency != null) {
      return { dimensions: def.dimensions, packingEfficiency: def.packingEfficiency };
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

  // Legacy alias for the existing name used throughout the module.
  const _nextId = () => _nextInvId('inv');

  // Well-known group ids. On-Person is fixed and always present; its
  // contents come from bySlot (the body-slot map) rather than its own
  // array. The default Stowed group is added on new-character / migration.
  const GROUP_ONPERSON_ID = 'grp_onperson';
  const GROUP_STOWED_ID   = 'grp_stowed';

  // Ensure charData.inventory has the current expected shape. Mutates in
  // place. Called before any read/write so legacy characters don't crash.
  //
  // Handles three migration paths:
  //   1. No inventory at all              → create fresh with On-Person + Stowed
  //   2. Old shape (bySlot + flat stowed) → wrap into groups, keep bySlot
  //   3. Current shape                    → validate and fill any gaps
  //
  // customDefs holds per-character one-off defs — one-offs created right
  // from the sheet, not promoted to the ruleset. Lookups walk customDefs
  // as a fallback, so these entries render and weigh just like ruleset
  // defs do.
  function ensureInventory() {
    const charData = getCharData();
    if (!charData.inventory || typeof charData.inventory !== 'object') {
      charData.inventory = {};
    }
    const inv = charData.inventory;

    // bySlot: always an object. Body slots hang off it directly.
    if (!inv.bySlot || typeof inv.bySlot !== 'object') inv.bySlot = {};

    // customDefs: always shaped { containers: [], equipment: [] }.
    if (!inv.customDefs || typeof inv.customDefs !== 'object') inv.customDefs = {};
    if (!Array.isArray(inv.customDefs.containers)) inv.customDefs.containers = [];
    if (!Array.isArray(inv.customDefs.equipment))  inv.customDefs.equipment  = [];

    // Legacy migration — old inventories had a top-level `stowed` array
    // instead of groups. Convert it into a "Stowed" group so the player's
    // existing data is preserved and keeps working. We don't seed a fresh
    // Stowed group for NEW characters — users add their own groups via
    // +Add Group.
    const hadLegacyStowed = Array.isArray(inv.stowed);
    if (!Array.isArray(inv.groups)) inv.groups = [];

    // On-Person: always present, always first. Its contents are the body
    // slots (bySlot), which live outside groups. The group entry itself
    // carries just metadata (name, collapsed state).
    if (!inv.groups.find(g => g.id === GROUP_ONPERSON_ID)) {
      inv.groups.unshift({
        id: GROUP_ONPERSON_ID,
        name: 'On-Person',
        kind: 'onPerson',
        collapsed: false
      });
    }

    // Preserve legacy Stowed data by wrapping it in a group — only if
    // that legacy array actually existed AND had content worth keeping.
    // Empty legacy stowed just gets discarded.
    if (hadLegacyStowed && inv.stowed.length > 0 && !inv.groups.find(g => g.id === GROUP_STOWED_ID)) {
      inv.groups.push({
        id: GROUP_STOWED_ID,
        name: 'Stowed',
        kind: 'custom',
        collapsed: false,
        contents: inv.stowed.slice()
      });
    }

    // Drop the legacy top-level stowed field after migrating (or
    // discarding) it. Keeps the Firestore doc clean.
    if (hadLegacyStowed) delete inv.stowed;

    // Validate every group entry and make sure custom groups have a
    // contents array. Malformed groups get dropped rather than crashing.
    inv.groups = inv.groups.filter(g => {
      if (!g || typeof g !== 'object' || !g.id || !g.kind) return false;
      if (g.kind === 'custom' && !Array.isArray(g.contents)) g.contents = [];
      return true;
    });

    return inv;
  }

  // Walk the inventory tree, calling visit(entry) for each item/container
  // entry — not groups themselves. Used for find-by-id and remove-by-id.
  function walkTree(visit) {
    const inv = ensureInventory();
    const visitArr = (arr) => {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i++) {
        visit(arr[i], arr, i);
        if (Array.isArray(arr[i].contents)) visitArr(arr[i].contents);
      }
    };
    // Body slot contents (under On-Person)
    Object.values(inv.bySlot).forEach(visitArr);
    // Custom-group contents
    (inv.groups || []).forEach(g => {
      if (g.kind === 'custom') visitArr(g.contents);
    });
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
      if (!Array.isArray(arr)) return false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].id === id) { arr.splice(i, 1); return true; }
        if (Array.isArray(arr[i].contents) && removeFromArr(arr[i].contents)) return true;
      }
      return false;
    };
    for (const slotCode of Object.keys(inv.bySlot)) {
      if (removeFromArr(inv.bySlot[slotCode])) return true;
    }
    for (const g of inv.groups) {
      if (g.kind === 'custom' && removeFromArr(g.contents)) return true;
    }
    return false;
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

    // Groups-first layout: On-Person (wraps slots) plus any custom
    // groups (free-form contents array). One group header per entry
    // in inv.groups, rendered in order. Custom groups may be renamed
    // or deleted; On-Person cannot.
    inv.groups.forEach(group => {
      html += renderGroup(group, ruleset, inv, canEdit);
    });

    // Add-group button at the bottom. Custom groups only — On-Person
    // is special and always exists.
    if (canEdit) {
      html += `<div class="inv-add-group-row">
        <button class="inv-add-btn inv-add-btn-ghost" onclick="invAddGroup()">+ Add Group</button>
        <span class="inv-add-group-hint">e.g. Vehicle, Safe House, Stash — anything that isn't on your body.</span>
      </div>`;
    }

    // Modal host — only gets content when activeModal is set.
    html += '<div id="inv-modal-root"></div>';

    host.innerHTML = html;

    if (activeModal) renderActiveModal();
  }

  // ─── GROUP RENDERER ───
  //
  // Each group is a top-level collapsible section. On-Person's body is
  // the ruleset's body slots (each a sub-section). Custom groups have a
  // flat contents array — containers and loose items at the top level.

  function renderGroup(group, ruleset, inv, canEdit) {
    const collapsed = !!group.collapsed;
    const isOnPerson = group.kind === 'onPerson';

    // Totals: weight and count across everything in the group. For
    // On-Person, this is the sum of every body slot's contents; for
    // custom groups, it's the sum of the group's contents array.
    const { totalWeight, totalCount } = isOnPerson
      ? tallyBySlot(inv.bySlot, ruleset.bodySlots || [])
      : tallyArr(group.contents || []);

    // Header actions. On-Person has no rename/delete; custom groups do.
    const extraHeaderActions = (!isOnPerson && canEdit) ? `
      <button class="inv-group-btn" onclick="event.stopPropagation();invRenameGroup('${escapeHtml(group.id)}')" title="Rename group">✎</button>
      <button class="inv-group-btn inv-group-btn-danger" onclick="event.stopPropagation();invDeleteGroup('${escapeHtml(group.id)}')" title="Delete group (and everything in it)">×</button>
    ` : '';

    let html = `<div class="inv-group${collapsed ? ' collapsed' : ''}${isOnPerson ? ' inv-group-onperson' : ' inv-group-custom'}">
      <div class="inv-group-head" onclick="invToggleGroupCollapse('${escapeHtml(group.id)}')">
        <span class="inv-group-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="inv-group-label">${escapeHtml(group.name)}</span>
        <span class="inv-group-meta">${totalCount} item${totalCount === 1 ? '' : 's'} · ${fmt(totalWeight)} lb${totalWeight === 1 ? '' : 's'}</span>
        ${extraHeaderActions}
      </div>`;

    if (!collapsed) {
      html += '<div class="inv-group-body">';
      if (isOnPerson) {
        // Render each body slot as a sub-section of On-Person.
        ruleset.bodySlots.forEach(slot => {
          html += renderSlotSection(slot, inv.bySlot[slot.code] || [], canEdit);
        });
      } else {
        // Description banner at the top of the group body — only shown
        // for custom groups that have one. Whitespace-preserving so the
        // user's line breaks survive. Sits above the contents so a long
        // group description doesn't push the items too far down.
        if (group.description && group.description.trim()) {
          html += `<div class="inv-group-desc">${escapeHtml(group.description)}</div>`;
        }
        // Custom group — flat contents list plus add buttons at the bottom.
        const entries = Array.isArray(group.contents) ? group.contents : [];
        if (entries.length === 0) {
          html += '<div class="inv-empty-row">Empty.</div>';
        } else {
          entries.forEach(e => { html += renderEntry(e, 0, canEdit); });
        }
        if (canEdit) {
          html += `<div class="inv-group-actions">
            <button class="inv-add-btn" onclick="invOpenAddContainer('${escapeHtml(group.id)}','group')">+ Add Container</button>
            <button class="inv-add-btn inv-add-btn-ghost" onclick="invOpenAddItem('${escapeHtml(group.id)}','group')">+ Add Loose Item</button>
          </div>`;
        }
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── TALLY HELPERS ───
  //
  // Recursively sum weight and item counts for a given scope. Weight
  // flows all the way up — a pouch inside a backpack inside a trunk
  // contributes to all three tallies.

  function tallyEntry(entry) {
    const def = getDefForEntry(entry);
    const qty = entry.quantity || 1;
    let weight = def ? (def.weight || 0) * qty : 0;
    let count = qty;
    if (Array.isArray(entry.contents)) {
      entry.contents.forEach(c => {
        const sub = tallyEntry(c);
        weight += sub.weight;
        count += sub.count;
      });
    }
    return { weight, count };
  }

  function tallyArr(arr) {
    let totalWeight = 0;
    let totalCount = 0;
    (arr || []).forEach(e => {
      const t = tallyEntry(e);
      totalWeight += t.weight;
      totalCount += t.count;
    });
    return { totalWeight, totalCount };
  }

  function tallyBySlot(bySlot, bodySlots) {
    let totalWeight = 0;
    let totalCount = 0;
    (bodySlots || []).forEach(slot => {
      const t = tallyArr(bySlot[slot.code] || []);
      totalWeight += t.totalWeight;
      totalCount += t.totalCount;
    });
    return { totalWeight, totalCount };
  }

  // ─── BODY SLOT SUBSECTION ───
  //
  // Renders a single body slot as a subsection inside the On-Person
  // group. Same shape as the custom-group body but with slot-specific
  // targeting for the Add buttons.

  function renderSlotSection(slot, entries, canEdit) {
    const collapsed = collapsedSlots.has(slot.code);
    const { totalWeight, totalCount } = tallyArr(entries);

    let html = `<div class="inv-slot-section${collapsed ? ' collapsed' : ''}">
      <div class="inv-slot-head" onclick="invToggleSlot('${escapeHtml(slot.code)}')">
        <span class="inv-slot-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="inv-slot-label">${escapeHtml(slot.label)}</span>
        <span class="inv-slot-meta">${totalCount} item${totalCount === 1 ? '' : 's'} · ${fmt(totalWeight)} lb${totalWeight === 1 ? '' : 's'}</span>
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
          <button class="inv-add-btn" onclick="invOpenAddContainer('${escapeHtml(slot.code)}','slot')">+ Add Container</button>
          <button class="inv-add-btn inv-add-btn-ghost" onclick="invOpenAddItem('${escapeHtml(slot.code)}','slot')">+ Add Loose Item</button>
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

    // Build an explanatory tooltip for the capacity cell so players
    // hovering over "1200/3024 in³" can see what those numbers mean.
    // Shows the raw volume and packing efficiency that produced the
    // "available" figure.
    const rawVolume = (dims.l || 0) * (dims.w || 0) * (dims.h || 0);
    const pkEff = spec ? (spec.packingEfficiency || 0.75) : 0.75;
    const capTip = `Used / usable volume.\nUsable = ${fmt(dims.l)}×${fmt(dims.w)}×${fmt(dims.h)} (${fmt(rawVolume)} in³ raw) × ${fmt(pkEff)} packing efficiency = ${fmt(stats.availableVolume)} in³.\nPacking efficiency accounts for wasted space between irregular items.`;

    let html = `<div class="inv-entry inv-entry-container${open ? ' open' : ''}" style="margin-left:${depth * 16}px">
      <div class="inv-entry-head" onclick="invToggleEntry('${escapeHtml(entry.id)}')">
        <span class="inv-entry-caret">${open ? '▾' : '▸'}</span>
        <span class="inv-entry-icon" title="Container">▣</span>
        <span class="inv-entry-name">${escapeHtml(name)}</span>
        <span class="inv-entry-dims">${fmt(outerDims.l)}×${fmt(outerDims.w)}×${fmt(outerDims.h)} in</span>
        <span class="inv-entry-capacity" title="${escapeHtml(capTip)}">${fmt(stats.usedVolume)}/${fmt(stats.availableVolume)} in³ (${pct}%)</span>
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
    const hasInfo = !!((def.description && def.description.trim()) || (entry.notes && entry.notes.trim()));
    const infoOpen = expandedInfo.has(entry.id);

    // Hover tooltip: first ~80 chars of description as a title attribute
    // on the name. Full description shows when the row is clicked.
    const tooltip = hasInfo
      ? escapeHtml(truncate((def.description || entry.notes || '').replace(/\s+/g, ' ').trim(), 80))
      : '';
    // If there's info to show, the name is clickable to toggle the
    // expanded panel. If not, the row is purely informational.
    const nameAttrs = hasInfo
      ? ` class="inv-entry-name inv-entry-name-clickable" title="${tooltip}" onclick="invToggleItemInfo('${escapeHtml(entry.id)}')"`
      : ` class="inv-entry-name"`;

    let html = `<div class="inv-entry inv-entry-item${infoOpen ? ' info-open' : ''}" style="margin-left:${depth * 16}px">
      <div class="inv-entry-head inv-entry-head-item">
        <span class="inv-entry-icon" title="Item">◆</span>
        <span${nameAttrs}>${escapeHtml(name)}${escapeHtml(catLabel)}${hasInfo ? `<span class="inv-entry-info-caret">${infoOpen ? '▾' : '▸'}</span>` : ''}</span>
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
      </div>`;

    if (infoOpen && hasInfo) {
      const desc = (def.description || '').trim();
      const notes = (entry.notes || '').trim();
      html += `<div class="inv-entry-info">`;
      if (desc) {
        html += `<div class="inv-entry-info-desc">${escapeHtml(desc)}</div>`;
      }
      if (notes) {
        html += `<div class="inv-entry-info-notes"><span class="inv-entry-info-label">Notes:</span> ${escapeHtml(notes)}</div>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  // Truncate a string to a max length, adding "…" if truncated. Avoids
  // breaking mid-word when possible — trims back to the previous space
  // rather than cutting a word in half.
  function truncate(s, max) {
    if (!s || s.length <= max) return s || '';
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
  }

  // ─── MODALS: ADD CONTAINER / ADD ITEM ───
  //
  // Both modals pull from the ruleset's items catalog plus the
  // character's custom defs. The Container modal filters to items with
  // a containerOf block (those are the things that can hold stuff).
  // The Item modal shows the full catalog.
  //
  // NOTE: In Turn 4 this gets replaced with a category-tree picker that
  // lets users drill down by category. For now the picker is flat.

  function renderActiveModal() {
    const root = document.getElementById('inv-modal-root');
    if (!root) return;
    if (!activeModal) { root.innerHTML = ''; return; }

    // Custom-def form takes over the modal when open. When the user is
    // filling in their one-off item, we don't want the catalog list
    // cluttering up the view.
    if (activeModal.showCustomForm) {
      root.innerHTML = renderCustomForm();
      return;
    }

    // Group edit form (Add Group / Rename Group) — a simple two-field
    // dialog for the group's name and description. Separate modal kind
    // because it has nothing in common with the picker modals.
    if (activeModal.kind === 'groupEdit') {
      root.innerHTML = renderGroupEditModal();
      return;
    }

    const ruleset = getRuleset();
    const inv = ensureInventory();

    // Collect all candidate defs from both sources. Each entry carries
    // its `kind` (for instantiation's defKind field — container or
    // equipment based on whether def.containerOf is set) and its
    // `source` (for the UI "custom" pill).
    const allDefs = [];
    (ruleset.items || []).forEach(def => {
      const kind = def.containerOf ? 'container' : 'equipment';
      allDefs.push({ kind, def, source: 'ruleset' });
    });
    (inv.customDefs.containers || []).forEach(def => {
      allDefs.push({ kind: 'container', def, source: 'custom' });
    });
    (inv.customDefs.equipment || []).forEach(def => {
      const kind = def.containerOf ? 'container' : 'equipment';
      allDefs.push({ kind, def, source: 'custom' });
    });

    if (activeModal.kind === 'container') {
      // Containers only — anything with a containerOf block.
      const options = allDefs.filter(o => !!o.def.containerOf);
      root.innerHTML = renderModal({
        title: 'Add Container',
        subtitle: activeModal.targetLabel || '',
        options,
        emptyMsg: 'No containers in this ruleset yet. Use "+ Custom" below to make a one-off for this character, or open the ruleset editor\'s Inventory tab to add reusable ones.',
        onPickAttr: 'invPickContainerDef',
        customKind: 'container'
      });
    } else if (activeModal.kind === 'item') {
      // Items — show everything (including containers, since the player
      // might want to stuff a container into another container).
      root.innerHTML = renderModal({
        title: 'Add Item',
        subtitle: activeModal.targetLabel || '',
        options: allDefs,
        emptyMsg: 'No items in this ruleset yet. Use "+ Custom" below to make a one-off for this character, or open the ruleset editor\'s Inventory tab to add reusable ones.',
        onPickAttr: 'invPickItemDef',
        customKind: 'equipment'
      });
    }
  }

  function renderModal({ title, subtitle, options, emptyMsg, onPickAttr, customKind }) {
    const listHtml = options.length === 0
      ? `<div class="inv-modal-empty">${escapeHtml(emptyMsg)}</div>`
      : options.map(opt => {
          const d = opt.def.dimensions || { l: 0, w: 0, h: 0 };
          const cat = opt.def.category ? `<span class="inv-modal-cat">${escapeHtml(opt.def.category)}</span>` : '';
          const isContainerDual = opt.kind === 'equipment' && opt.def.containerOf;
          const dualPill = isContainerDual ? '<span class="inv-modal-dual">dual-role</span>' : '';
          // Mark character-local custom defs with a distinct pill so users
          // see at a glance that an entry only exists on this character.
          const customPill = opt.source === 'custom' ? '<span class="inv-modal-custom">custom</span>' : '';
          // Custom defs also get a × button to delete them from the
          // character's catalog. Ruleset defs don't — those belong to
          // the ruleset editor.
          const deleteBtn = opt.source === 'custom'
            ? `<button class="inv-modal-opt-delete" onclick="event.stopPropagation();invDeleteCustomDef('${escapeHtml(opt.kind)}','${escapeHtml(opt.def.id)}')" title="Delete this custom def and remove all instances of it from this character">×</button>`
            : '';
          return `<div class="inv-modal-opt" onclick="${onPickAttr}('${escapeHtml(opt.kind)}','${escapeHtml(opt.def.id)}')">
            <div class="inv-modal-opt-header">
              <div class="inv-modal-opt-name">${escapeHtml(opt.def.name)}${cat}${dualPill}${customPill}</div>
              ${deleteBtn}
            </div>
            <div class="inv-modal-opt-meta">${fmt(d.l)}×${fmt(d.w)}×${fmt(d.h)} in · ${fmt(opt.def.weight || 0)} lb</div>
            ${opt.def.description ? `<div class="inv-modal-opt-desc">${escapeHtml(opt.def.description)}</div>` : ''}
          </div>`;
        }).join('');

    // "+ Custom" button at the bottom lets the user define a one-off
    // container/item right from the sheet without leaving the flow.
    const customBtn = customKind
      ? `<div class="inv-modal-custom-row">
          <button class="inv-add-btn" onclick="invOpenCustomForm('${escapeHtml(customKind)}')">+ Custom ${customKind === 'container' ? 'Container' : 'Item'}…</button>
          <span class="inv-modal-custom-hint">One-off for this character — won't appear on others.</span>
        </div>`
      : '';

    return `<div class="inv-modal-backdrop" onclick="invCloseModal(event)">
      <div class="inv-modal" onclick="event.stopPropagation()">
        <div class="inv-modal-head">
          <div class="inv-modal-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="inv-modal-sub">${escapeHtml(subtitle)}</div>` : ''}
          <button class="inv-modal-close" onclick="invCloseModal()">×</button>
        </div>
        <div class="inv-modal-body">
          ${listHtml}
          ${customBtn}
        </div>
      </div>
    </div>`;
  }

  // ─── CUSTOM DEF FORM ───
  //
  // In-modal form for creating a character-scoped one-off def. Saves to
  // inv.customDefs and immediately instantiates an entry at the modal's
  // target. Pattern matches the ruleset editor's card layout so it feels
  // familiar, just collapsed into a form.

  function renderCustomForm() {
    const draft = activeModal.customDraft || {};
    const isContainer = activeModal.customKind === 'container';
    const isContainerDual = !!draft.alsoContainer;
    const title = isContainer ? 'New Container (one-off)' : 'New Item (one-off)';

    return `<div class="inv-modal-backdrop" onclick="invCloseModal(event)">
      <div class="inv-modal" onclick="event.stopPropagation()">
        <div class="inv-modal-head">
          <div class="inv-modal-title">${escapeHtml(title)}</div>
          <div class="inv-modal-sub">${escapeHtml(activeModal.targetLabel || '')}</div>
          <button class="inv-modal-close" onclick="invCloseModal()">×</button>
        </div>
        <div class="inv-modal-body inv-custom-form">

          <div class="inv-field">
            <label>Name</label>
            <input type="text" id="inv-custom-name" value="${escapeHtml(draft.name || '')}" placeholder="${escapeHtml(isContainer ? 'Duct-tape Satchel' : 'Lucky Zippo')}" oninput="invUpdateCustomDraft('name',this.value)">
          </div>

          <div class="inv-field">
            <label>Description</label>
            <textarea rows="3" id="inv-custom-desc" placeholder="Optional — flavor, special properties, notes." oninput="invUpdateCustomDraft('description',this.value)">${escapeHtml(draft.description || '')}</textarea>
          </div>

          ${!isContainer ? `<div class="inv-field">
            <label>Category (optional)</label>
            <input type="text" value="${escapeHtml(draft.category || '')}" placeholder="firearm, melee, ammo, tool, armor, misc" oninput="invUpdateCustomDraft('category',this.value)">
          </div>` : ''}

          <div class="inv-field">
            <label>Dimensions (L × W × H, inches)</label>
            <div class="inv-dims-row">
              <input type="number" step="0.25" min="0" value="${escapeHtml(String(draft.l || 0))}" placeholder="L" oninput="invUpdateCustomDraft('l',this.value)">
              <input type="number" step="0.25" min="0" value="${escapeHtml(String(draft.w || 0))}" placeholder="W" oninput="invUpdateCustomDraft('w',this.value)">
              <input type="number" step="0.25" min="0" value="${escapeHtml(String(draft.h || 0))}" placeholder="H" oninput="invUpdateCustomDraft('h',this.value)">
            </div>
          </div>

          <div class="inv-field">
            <label>Weight (lbs)</label>
            <input type="number" step="0.1" min="0" value="${escapeHtml(String(draft.weight || 0))}" oninput="invUpdateCustomDraft('weight',this.value)" style="max-width:140px">
          </div>

          ${isContainer ? `<div class="inv-field" style="max-width:260px">
            <label title="Fraction of the container's raw L×W×H volume that can actually hold items. 1.0 = perfectly-fitted hard case, 0.75 = typical soft bag, 0.5 = loose sack or odd shape.">Packing Efficiency (0.1 – 1.0)</label>
            <input type="number" step="0.05" min="0.1" max="1.0" value="${escapeHtml(String(draft.packingEfficiency || 0.75))}" oninput="invUpdateCustomDraft('packingEfficiency',this.value)">
            <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">1.0 = fitted case · 0.75 = typical bag · 0.5 = loose sack</div>
          </div>` : `
          <div class="inv-toggle-row">
            <span class="inv-toggle${isContainerDual ? ' on' : ''}" onclick="invUpdateCustomDraft('alsoContainer',${!isContainerDual})">${isContainerDual ? '✓ Also a container' : 'Also a container'}</span>
            <span class="inv-toggle-hint">Toggle for ammo pouches, quivers, holsters.</span>
          </div>
          ${isContainerDual ? `<div class="inv-container-block">
            <div class="inv-container-block-title">Container Capacity</div>
            <div class="inv-field">
              <label>Inner Dimensions (L × W × H, inches)</label>
              <div class="inv-dims-row">
                <input type="number" step="0.25" min="0" value="${escapeHtml(String(draft.innerL || 0))}" placeholder="L" oninput="invUpdateCustomDraft('innerL',this.value)">
                <input type="number" step="0.25" min="0" value="${escapeHtml(String(draft.innerW || 0))}" placeholder="W" oninput="invUpdateCustomDraft('innerW',this.value)">
                <input type="number" step="0.25" min="0" value="${escapeHtml(String(draft.innerH || 0))}" placeholder="H" oninput="invUpdateCustomDraft('innerH',this.value)">
              </div>
            </div>
            <div class="inv-field" style="max-width:260px">
              <label title="Fraction of the inner L×W×H volume that can actually hold items. 1.0 = perfectly-fitted hard case, 0.75 = typical soft bag, 0.5 = loose sack or odd shape.">Packing Efficiency (0.1 – 1.0)</label>
              <input type="number" step="0.05" min="0.1" max="1.0" value="${escapeHtml(String(draft.innerPacking || 0.75))}" oninput="invUpdateCustomDraft('innerPacking',this.value)">
              <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">1.0 = fitted case · 0.75 = typical bag · 0.5 = loose sack</div>
            </div>
          </div>` : ''}`}

          <div class="inv-modal-actions">
            <button class="inv-add-btn" onclick="invSaveCustomDef()">Save &amp; Add</button>
            <button class="inv-add-btn inv-add-btn-ghost" onclick="invCancelCustomForm()">Cancel</button>
          </div>

        </div>
      </div>
    </div>`;
  }

  // ─── GROUP EDIT MODAL ───
  //
  // Single modal shared by Add Group and Rename Group. Distinguished by
  // activeModal.groupEditMode ('add' | 'edit') which only affects the
  // header label and the save handler's target.

  function renderGroupEditModal() {
    const draft = activeModal.groupDraft || {};
    const isAdd = activeModal.groupEditMode === 'add';
    const title = isAdd ? 'New Group' : 'Edit Group';
    const hint = isAdd
      ? 'Groups are containers for things not on your body — e.g. Vehicle, Stash, Safe House.'
      : '';

    return `<div class="inv-modal-backdrop" onclick="invCloseModal(event)">
      <div class="inv-modal" onclick="event.stopPropagation()">
        <div class="inv-modal-head">
          <div class="inv-modal-title">${escapeHtml(title)}</div>
          ${hint ? `<div class="inv-modal-sub">${escapeHtml(hint)}</div>` : ''}
          <button class="inv-modal-close" onclick="invCloseModal()">×</button>
        </div>
        <div class="inv-modal-body inv-custom-form">

          <div class="inv-field">
            <label>Name</label>
            <input type="text" value="${escapeHtml(draft.name || '')}" placeholder="e.g. Vehicle, Safe House, Stash" oninput="invUpdateGroupDraft('name',this.value)" autofocus>
          </div>

          <div class="inv-field">
            <label>Description</label>
            <textarea rows="4" placeholder="Optional — what is this? Where is it? What's its purpose?" oninput="invUpdateGroupDraft('description',this.value)">${escapeHtml(draft.description || '')}</textarea>
          </div>

          <div class="inv-modal-actions">
            <button class="inv-add-btn" onclick="invSaveGroup()">${isAdd ? 'Create' : 'Save'}</button>
            <button class="inv-add-btn inv-add-btn-ghost" onclick="invCloseModal()">Cancel</button>
          </div>

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

  // Click on an item row toggles its description panel. Separate state
  // set from containers so the two semantics don't tangle.
  function toggleItemInfo(id) {
    if (expandedInfo.has(id)) expandedInfo.delete(id);
    else expandedInfo.add(id);
    renderAll();
  }

  // ─── GROUP HANDLERS ───

  async function toggleGroupCollapse(groupId) {
    const inv = ensureInventory();
    const g = (inv.groups || []).find(x => x.id === groupId);
    if (!g) return;
    g.collapsed = !g.collapsed;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // addGroup and renameGroup are thin wrappers that open the shared
  // Group Edit modal in the right mode. Actual persistence happens in
  // saveGroup when the user hits Save.

  function addGroup() {
    if (!getCanEdit()) return;
    activeModal = {
      kind: 'groupEdit',
      groupEditMode: 'add',
      groupDraft: { name: '', description: '' }
    };
    renderActiveModal();
  }

  function renameGroup(groupId) {
    if (!getCanEdit()) return;
    const inv = ensureInventory();
    const g = (inv.groups || []).find(x => x.id === groupId);
    if (!g || g.kind === 'onPerson') return;
    activeModal = {
      kind: 'groupEdit',
      groupEditMode: 'edit',
      groupEditId: groupId,
      groupDraft: { name: g.name || '', description: g.description || '' }
    };
    renderActiveModal();
  }

  function updateGroupDraft(field, value) {
    if (!activeModal || activeModal.kind !== 'groupEdit') return;
    if (!activeModal.groupDraft) activeModal.groupDraft = {};
    activeModal.groupDraft[field] = typeof value === 'string' ? value : '';
    // Don't re-render — the inputs are self-updating. Re-rendering
    // would steal focus from the field the user is typing into.
  }

  async function saveGroup() {
    if (!activeModal || activeModal.kind !== 'groupEdit') return;
    const draft = activeModal.groupDraft || {};
    const name = (draft.name || '').trim();
    if (!name) {
      alert('Please enter a name.');
      return;
    }
    const description = (draft.description || '').trim();
    const inv = ensureInventory();

    if (activeModal.groupEditMode === 'add') {
      inv.groups.push({
        id: _nextInvId('grp'),
        name,
        description,
        kind: 'custom',
        collapsed: false,
        contents: []
      });
    } else if (activeModal.groupEditMode === 'edit') {
      const g = (inv.groups || []).find(x => x.id === activeModal.groupEditId);
      if (!g || g.kind === 'onPerson') { closeModal(); return; }
      g.name = name;
      g.description = description;
    }

    closeModal();
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function deleteGroup(groupId) {
    if (!getCanEdit()) return;
    const inv = ensureInventory();
    const g = (inv.groups || []).find(x => x.id === groupId);
    if (!g || g.kind === 'onPerson') return;
    const hasStuff = Array.isArray(g.contents) && g.contents.length > 0;
    if (hasStuff) {
      if (!confirm(`Delete "${g.name}" and everything inside (${g.contents.length} top-level items)? This cannot be undone.`)) return;
    } else {
      if (!confirm(`Delete "${g.name}"?`)) return;
    }
    inv.groups = inv.groups.filter(x => x.id !== groupId);
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // ─── ADD FLOW HANDLERS ───
  //
  // `target` identifies where the new entry goes. Possible shapes:
  //   { targetKind: 'slot',      target: slotCode }   → inv.bySlot[slotCode]
  //   { targetKind: 'group',     target: groupId }    → group.contents
  //   { targetKind: 'container', target: entryId }    → entry.contents
  //
  // The legacy '__stowed__' code is translated into the Stowed group if
  // one exists (unlikely to hit this path post-migration, but defensive).

  function resolveTargetLabel(target, targetKind) {
    const ruleset = getRuleset();
    const inv = ensureInventory();
    if (targetKind === 'container') {
      const parent = findEntry(target);
      return parent ? `Inside: ${entryName(parent)}` : '';
    }
    if (targetKind === 'group') {
      const g = inv.groups.find(x => x.id === target);
      return g ? `To: ${g.name}` : '';
    }
    if (targetKind === 'slot') {
      const slot = (ruleset.bodySlots || []).find(s => s.code === target);
      return slot ? `To slot: ${slot.label}` : '';
    }
    return '';
  }

  function openAddContainer(target, targetKind) {
    if (!getCanEdit()) return;
    // Back-compat: second arg used to be a boolean `fromContainer`.
    // Normalize to the new targetKind.
    if (targetKind === true) targetKind = 'container';
    if (!targetKind) targetKind = 'slot';
    activeModal = {
      kind: 'container',
      target,
      targetKind,
      targetLabel: resolveTargetLabel(target, targetKind),
      showCustomForm: false
    };
    renderActiveModal();
  }

  function openAddItem(target, targetKind) {
    if (!getCanEdit()) return;
    if (!targetKind) targetKind = 'slot';
    activeModal = {
      kind: 'item',
      target,
      targetKind,
      targetLabel: resolveTargetLabel(target, targetKind),
      showCustomForm: false
    };
    renderActiveModal();
  }

  function closeModal() {
    activeModal = null;
    const root = document.getElementById('inv-modal-root');
    if (root) root.innerHTML = '';
  }

  // ─── CUSTOM DEF FORM HANDLERS ───

  function openCustomForm(customKind) {
    if (!activeModal) return;
    activeModal.showCustomForm = true;
    activeModal.customKind = customKind;
    activeModal.customDraft = {
      name: '',
      description: '',
      category: '',
      l: 6, w: 3, h: 1,
      weight: 0.5,
      packingEfficiency: 0.75,
      alsoContainer: false,
      innerL: 0, innerW: 0, innerH: 0,
      innerPacking: 0.75
    };
    renderActiveModal();
  }

  function cancelCustomForm() {
    if (!activeModal) return;
    activeModal.showCustomForm = false;
    activeModal.customDraft = null;
    renderActiveModal();
  }

  // Delete a custom def from the character's catalog. Also rips out
  // every inventory entry that references it — otherwise those entries
  // would render as "(deleted def)" and clutter the sheet. Confirms
  // before deleting if there are live instances.
  async function deleteCustomDef(defKind, defId) {
    if (!getCanEdit()) return;
    const inv = ensureInventory();
    const bucket = defKind === 'container' ? inv.customDefs.containers : inv.customDefs.equipment;
    const def = bucket.find(x => x.id === defId);
    if (!def) return;

    // Find every entry that uses this def so we can warn + clean up.
    const refs = [];
    walkTree(entry => { if (entry.defId === defId) refs.push(entry); });

    const msg = refs.length > 0
      ? `Delete "${def.name}" from this character's custom catalog? This also removes ${refs.length} instance${refs.length === 1 ? '' : 's'} of it from your inventory.`
      : `Delete "${def.name}" from this character's custom catalog?`;
    if (!confirm(msg)) return;

    // Remove every entry referencing the def — use the same id-walk
    // removal path as the entry × button. Collect ids first, remove
    // after, so we're not mutating the tree mid-walk.
    const idsToRemove = refs.map(r => r.id);
    idsToRemove.forEach(id => {
      removeEntry(id);
      expandedEntries.delete(id);
      expandedInfo.delete(id);
    });

    // Now drop the def itself.
    const idx = bucket.findIndex(x => x.id === defId);
    if (idx >= 0) bucket.splice(idx, 1);

    renderActiveModal();   // refresh the picker so the row disappears
    renderAll();           // refresh the sheet so removed instances vanish
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  function updateCustomDraft(field, value) {
    if (!activeModal || !activeModal.customDraft) return;
    const d = activeModal.customDraft;
    // Numeric fields — coerce, clamp non-negative. Text fields pass through.
    const numericFields = new Set(['l','w','h','weight','packingEfficiency','innerL','innerW','innerH','innerPacking']);
    if (numericFields.has(field)) {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else if (field === 'alsoContainer') {
      d[field] = !!value;
      // Re-render so the inner-container block shows/hides.
      renderActiveModal();
      return;
    } else {
      d[field] = typeof value === 'string' ? value : '';
    }
    // Most text/number tweaks don't need a re-render — the inputs are
    // self-updating. Only structural changes (toggles) re-render above.
  }

  async function saveCustomDef() {
    if (!activeModal || !activeModal.customDraft) return;
    const d = activeModal.customDraft;
    const name = (d.name || '').trim();
    if (!name) {
      alert('Please enter a name.');
      return;
    }
    const inv = ensureInventory();
    const isContainer = activeModal.customKind === 'container';

    // Build the def record — same schema as ruleset defs, with a
    // `cust_`-prefixed id so the source is legible.
    let def;
    if (isContainer) {
      def = {
        id: _nextInvId('cust_cont'),
        name,
        description: (d.description || '').trim(),
        dimensions: { l: d.l || 0, w: d.w || 0, h: d.h || 0 },
        weight: d.weight || 0,
        packingEfficiency: clampEff(d.packingEfficiency, 0.75),
        defaultSlot: null
      };
      inv.customDefs.containers.push(def);
    } else {
      def = {
        id: _nextInvId('cust_eq'),
        name,
        description: (d.description || '').trim(),
        dimensions: { l: d.l || 0, w: d.w || 0, h: d.h || 0 },
        weight: d.weight || 0,
        category: (d.category || '').trim(),
        weaponId: null,
        containerOf: d.alsoContainer ? {
          dimensions: { l: d.innerL || 0, w: d.innerW || 0, h: d.innerH || 0 },
          packingEfficiency: clampEff(d.innerPacking, 0.75)
        } : null
      };
      inv.customDefs.equipment.push(def);
    }

    // Immediately instantiate a new entry using this def at the modal's
    // target. Saves the player two clicks — they created the def *so that*
    // they could use it; no reason to make them pick from the catalog
    // afterward.
    const defKind = isContainer ? 'container' : 'equipment';
    if (activeModal.kind === 'container') {
      await instantiateAndPlace(defKind, def.id, /*isContainerRole=*/true);
    } else {
      await instantiateAndPlace(defKind, def.id, /*isContainerRole=*/!!def.containerOf);
    }
  }

  function clampEff(v, fallback) {
    const n = Number.isFinite(v) ? v : parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0.1, Math.min(1.0, n));
  }

  // Shared instantiation path — used by catalog-picked defs AND by the
  // just-created custom def flow. Builds an entry, routes to the right
  // container array based on targetKind, saves.
  async function instantiateAndPlace(defKind, defId, isContainerRole) {
    const inv = ensureInventory();
    const newEntry = {
      id: _nextId(),
      defId,
      defKind,
      quantity: 1
    };
    if (isContainerRole) newEntry.contents = [];

    const tgt = activeModal.target;
    const tkind = activeModal.targetKind;
    let placed = false;
    if (tkind === 'container') {
      const parent = findEntry(tgt);
      if (parent) {
        if (!Array.isArray(parent.contents)) parent.contents = [];
        parent.contents.push(newEntry);
        expandedEntries.add(parent.id);
        placed = true;
      }
    } else if (tkind === 'group') {
      const g = inv.groups.find(x => x.id === tgt);
      if (g && g.kind === 'custom') {
        if (!Array.isArray(g.contents)) g.contents = [];
        g.contents.push(newEntry);
        placed = true;
      }
    } else if (tkind === 'slot') {
      if (!Array.isArray(inv.bySlot[tgt])) inv.bySlot[tgt] = [];
      inv.bySlot[tgt].push(newEntry);
      placed = true;
    }

    if (!placed) { closeModal(); return; }

    if (isContainerRole) expandedEntries.add(newEntry.id);
    closeModal();
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function pickContainerDef(defKind, defId) {
    if (!activeModal || activeModal.kind !== 'container') return;
    // Container picks are always container-role.
    await instantiateAndPlace(defKind, defId, /*isContainerRole=*/true);
  }

  async function pickItemDef(defKind, defId) {
    if (!activeModal || activeModal.kind !== 'item') return;
    // An item can secretly also be a container if its def has a
    // containerOf block — that flag flows through to entryIsContainer.
    const def = defKind === 'equipment' ? getEquipmentDef(defId) : getContainerDef(defId);
    const isContainerRole = !!(def && def.containerOf) || defKind === 'container';
    await instantiateAndPlace(defKind, defId, isContainerRole);
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
    expandedInfo.delete(id);
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  return {
    renderAll,
    toggleSlot,
    toggleEntry,
    toggleItemInfo,
    toggleGroupCollapse,
    addGroup,
    renameGroup,
    deleteGroup,
    updateGroupDraft,
    saveGroup,
    openAddContainer,
    openAddItem,
    closeModal,
    pickContainerDef,
    pickItemDef,
    openCustomForm,
    cancelCustomForm,
    updateCustomDraft,
    saveCustomDef,
    deleteCustomDef,
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
