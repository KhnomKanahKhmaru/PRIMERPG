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
import { computeDerivedStats } from './char-derived.js';

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

  // Which carry cards (CAP / ENC / LIFT) have their modifier editor
  // expanded. Set of card keys: 'cap', 'enc', 'lift'. Click the card
  // header to toggle. Session-only, not persisted.
  const expandedCarryCards = new Set();

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

  // Inline entry-edit state. Only one entry can be in edit mode at a
  // time — opening a second one auto-closes the first. While editing,
  // the draft is held OUTSIDE the entry (so we don't mutate the stored
  // snapshot on every keystroke); on Save it replaces the snapshot and
  // persists. On Cancel, the draft is discarded.
  //
  // Shape:
  //   editingEntryId: string (the entry's id) | null
  //   editDraft: { name, description, weight, dimensions:{l,w,h},
  //                isContainer, innerL, innerW, innerH, innerPacking }
  let editingEntryId = null;
  let editDraft = null;

  // Personal Catalogue manager. Separate from activeModal (the picker)
  // because they have nothing in common and shouldn't share state.
  //
  // When open, the manager is a modal overlay with a list of all the
  // character's custom defs. Each can be inline-edited (same semantics
  // as the entry edit panel, but against the def instead of an entry's
  // snapshot). New defs can be added. Deleting a def here uses the
  // instance-preserving delete — existing sheet entries keep their
  // snapshot data.
  //
  // Shape:
  //   open:             boolean
  //   expandedDefIds:   Set<string>   (which rows are expanded for editing)
  //   drafts:           Map<id, draft>  (per-def working drafts)
  //   newDraft:         draft | null   (inline "create new" form state)
  //   newKind:          'container' | 'equipment' | null
  let catalogManager = {
    open: false,
    expandedDefIds: new Set(),
    drafts: new Map(),
    newDraft: null,
    newKind: null
  };

  // View mode: 'inventory' shows the character's actual kit (groups +
  // slots + items they own). 'catalog' shows the read-only ruleset
  // catalog — every item the ruleset defines, organized by category.
  // Toggled via the header bar at the top of the panel. Not persisted
  // across reloads; defaults to 'inventory'.
  let viewMode = 'inventory';

  // Which categories are collapsed in the catalog view. Stored BY ID.
  // Default is all-expanded so users immediately see what's available.
  const collapsedCatalogCats = new Set();

  // Which items have their description/details expanded in the catalog
  // view. Items render collapsed by default (just name + summary); click
  // to expand full details. Keyed by item id.
  const expandedCatalogItems = new Set();

  // Which item's Add-target dropdown is currently open. Only one at a
  // time (clicking a different item's ▾ closes the previous). Null when
  // no dropdown is open. Stored as the item id.
  let catalogAddMenuFor = null;

  // Short-lived confirmation toast for catalog adds. Shows "Added
  // Shotgun to Back" or similar after a successful add. Auto-clears
  // on next render (so it's essentially one-render-lifetime).
  let lastAddToast = null;

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

  // ─── SNAPSHOT-FIRST ACCESSORS ───
  //
  // Entries carry a `snapshot` object that holds name, dimensions,
  // weight, description, and containerOf. This is the source of truth
  // for display and calculations. The def is only consulted as a
  // fallback for legacy entries that haven't been snapshot-migrated,
  // or to look up external references (like the ruleset category tree).
  //
  // Every accessor below reads from snapshot first, falls through to
  // the def as a safety net. Post-migration the fallback should never
  // fire, but it keeps us robust against mid-render migration gaps.

  function entrySnapshot(entry) {
    if (entry && entry.snapshot) return entry.snapshot;
    // Synthesize a snapshot on-the-fly if missing — used as a last
    // resort so accessors never return null fields.
    const def = getDefForEntry(entry);
    if (def) {
      return {
        name:         def.name || '',
        description:  def.description || '',
        dimensions:   def.dimensions || { l: 0, w: 0, h: 0 },
        weight:       def.weight || 0,
        containerOf:  def.containerOf || null,
        legacyCategory: def.legacyCategory || def.category || ''
      };
    }
    return {
      name: '(unknown item)',
      description: '',
      dimensions: { l: 0, w: 0, h: 0 },
      weight: 0,
      containerOf: null,
      legacyCategory: ''
    };
  }

  // An entry "is a container" if its snapshot has a containerOf block.
  // Falls back to def and entry metadata for safety against missing
  // snapshot (e.g. pre-migration legacy entries loaded mid-transaction).
  function entryIsContainer(entry) {
    if (!entry) return false;
    const snap = entry.snapshot;
    if (snap && snap.containerOf) return true;
    if (snap) return false;   // snapshot exists and explicitly has no containerOf
    // No snapshot — fall back to def + legacy signals.
    const def = getDefForEntry(entry);
    if (def && def.containerOf) return true;
    if (entry.defKind === 'container') return true;
    if (Array.isArray(entry.contents)) return true;
    return false;
  }

  // Inner container spec (dimensions + packingEfficiency). Reads from
  // the snapshot's containerOf. Legacy fallback for entries without
  // snapshots, matching the old behavior.
  function innerSpec(entry) {
    const snap = entry && entry.snapshot;
    if (snap && snap.containerOf) return snap.containerOf;
    // Fallback for pre-migration entries.
    const def = getDefForEntry(entry);
    if (!def) return null;
    if (def.containerOf) return def.containerOf;
    if (def.packingEfficiency != null) {
      return { dimensions: def.dimensions, packingEfficiency: def.packingEfficiency };
    }
    return null;
  }

  // Display name. Priority: explicit customName (player rename) →
  // snapshot.name → def.name → placeholder. Edits to a container's name
  // via the pencil icon go into snapshot.name, not customName, so
  // customName is mostly unused going forward but preserved for any
  // legacy entries that set it.
  function entryName(entry) {
    if (entry.customName && entry.customName.trim()) return entry.customName.trim();
    const snap = entry.snapshot;
    if (snap && snap.name) return snap.name;
    const def = getDefForEntry(entry);
    return def && def.name ? def.name : '(missing def)';
  }

  // Convenience: entry's own dimensions. Reads snapshot.dimensions.
  function entryDimensions(entry) {
    return entrySnapshot(entry).dimensions || { l: 0, w: 0, h: 0 };
  }

  // Convenience: entry's own weight.
  function entryWeight(entry) {
    return entrySnapshot(entry).weight || 0;
  }

  // Convenience: entry's own description.
  function entryDescription(entry) {
    return entrySnapshot(entry).description || '';
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
    const spec = innerSpec(entry);
    const ownWeight = entryWeight(entry);
    const result = {
      totalWeight:     ownWeight * (entry.quantity || 1),
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
      // Read dimensions/weight from the child's snapshot, not from
      // its def — children carry their own data post-migration.
      const cd = entryDimensions(child);
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
        result.totalWeight += entryWeight(child) * qty;
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

    // customDefs: always shaped { containers: [], equipment: [] }.
    if (!inv.customDefs || typeof inv.customDefs !== 'object') inv.customDefs = {};
    if (!Array.isArray(inv.customDefs.containers)) inv.customDefs.containers = [];
    if (!Array.isArray(inv.customDefs.equipment))  inv.customDefs.equipment  = [];

    // bySlot is legacy. Kept as an always-empty object during the
    // migration transition so any code still reading it sees empty
    // arrays (turning those branches into no-ops). Will be deleted
    // entirely once the render path stops consulting it.
    //
    // If inv.bySlot exists with data when we open the character, the
    // body-slot → subgroup migration below moves that data into
    // subgroups inside On-Person and then deletes inv.bySlot. The
    // shim re-creates an empty object so old readers don't crash.

    // Legacy flat-stowed migration (pre-groups-era). Convert into a
    // "Stowed" group so players' existing data keeps working. New chars
    // don't get a default Stowed group — they add their own.
    const hadLegacyStowed = Array.isArray(inv.stowed);
    if (!Array.isArray(inv.groups)) inv.groups = [];

    // On-Person: always present, always first. Post-refactor, On-Person
    // is a regular group with its own `contents` array. Previously its
    // contents lived in bySlot (the body-slot map); those get migrated
    // into subgroups of On-Person below.
    let onPerson = inv.groups.find(g => g.id === GROUP_ONPERSON_ID);
    if (!onPerson) {
      onPerson = {
        id: GROUP_ONPERSON_ID,
        name: 'On-Person',
        kind: 'onPerson',
        collapsed: false,
        contents: []
      };
      inv.groups.unshift(onPerson);
    }
    // Make sure On-Person has a contents array — older docs stored
    // items in bySlot, not here, so contents wasn't needed.
    if (!Array.isArray(onPerson.contents)) onPerson.contents = [];

    // Preserve legacy Stowed data by wrapping it in a group — only if
    // that legacy array actually existed AND had content worth keeping.
    if (hadLegacyStowed && inv.stowed.length > 0 && !inv.groups.find(g => g.id === GROUP_STOWED_ID)) {
      inv.groups.push({
        id: GROUP_STOWED_ID,
        name: 'Stowed',
        kind: 'custom',
        collapsed: false,
        contents: inv.stowed.slice()
      });
    }
    if (hadLegacyStowed) delete inv.stowed;

    // ── BODY-SLOT → SUBGROUP MIGRATION ──
    //
    // Body slots are gone. Each non-empty legacy slot becomes a subgroup
    // inside On-Person, preserving its items. Slot labels are read from
    // the current ruleset when available (so "back" renders as "Back");
    // if the ruleset no longer has that slot defined, we title-case the
    // code as a fallback.
    //
    // Empty slots are discarded — no point cluttering On-Person with
    // seven empty "Head", "Shoulders" etc. buckets.
    //
    // Idempotent: after migration the bySlot field is deleted, so
    // reopening the same character is a no-op.
    if (inv.bySlot && typeof inv.bySlot === 'object') {
      const ruleset = getRuleset ? getRuleset() : null;
      const slotLabels = new Map();
      if (ruleset && Array.isArray(ruleset.bodySlots)) {
        ruleset.bodySlots.forEach(s => { if (s && s.code) slotLabels.set(s.code, s.label || s.code); });
      }
      Object.keys(inv.bySlot).forEach(slotCode => {
        const items = inv.bySlot[slotCode];
        if (!Array.isArray(items) || items.length === 0) return;
        const label = slotLabels.get(slotCode) || slotCode.charAt(0).toUpperCase() + slotCode.slice(1).replace(/_/g, ' ');
        // Use a deterministic subgroup id based on slot code so
        // migrations don't create duplicates if run twice.
        const subId = 'grp_migrated_' + slotCode;
        if (!onPerson.contents.some(n => n && n.id === subId)) {
          onPerson.contents.push({
            id: subId,
            name: label,
            kind: 'custom',
            collapsed: false,
            contents: items.slice()
          });
        }
      });
      delete inv.bySlot;
    }

    // Shim: always ensure inv.bySlot exists as an empty object so any
    // remaining legacy reader sees `{}`, not `undefined`. Turn 2 of
    // the slot→group refactor will strip the last readers; until then
    // this keeps everything working.
    if (!inv.bySlot || typeof inv.bySlot !== 'object') inv.bySlot = {};

    // Validate every top-level group and ensure contents is an array.
    inv.groups = inv.groups.filter(g => {
      if (!g || typeof g !== 'object' || !g.id || !g.kind) return false;
      if (!Array.isArray(g.contents)) g.contents = [];
      return true;
    });

    // Recursively validate subgroups — any node in contents that looks
    // like a group (has kind 'custom') must have a contents array.
    // Entries (defId / defKind present) are left alone here.
    normalizeGroupTree(inv.groups);

    // ── SNAPSHOT MIGRATION ──
    //
    // Every entry now carries a `snapshot` object — its own copy of the
    // def's name, dimensions, weight, description, and containerOf at
    // the moment of placement. Entries use this for display/calculation
    // rather than looking up the def each time. Result: deleting a def
    // (custom or ruleset) doesn't strand entries as "(deleted def)" —
    // they keep their own data.
    //
    // Legacy entries (placed before this migration) have no snapshot.
    // For those, look up the def and populate the snapshot from it.
    // If the def is also missing, we build a minimal snapshot with
    // "(unknown item)" placeholders so the entry still renders.
    //
    // Idempotent: entries with a snapshot already are left alone.
    migrateSnapshots(inv);

    return inv;
  }

  // Walk the group tree, making sure every group node has a contents
  // array and dropping anything malformed. Called after any migration
  // step that might have left the tree in a partial state.
  function normalizeGroupTree(groups) {
    if (!Array.isArray(groups)) return;
    groups.forEach(g => {
      if (!g || typeof g !== 'object') return;
      if (isGroupNode(g)) {
        if (!Array.isArray(g.contents)) g.contents = [];
        // Recurse into subgroup children.
        g.contents = g.contents.filter(child => {
          if (!child || typeof child !== 'object') return false;
          if (isGroupNode(child)) {
            if (!Array.isArray(child.contents)) child.contents = [];
            normalizeGroupTree([child]);
          }
          return true;
        });
      }
    });
  }

  // A node is a "group" (vs an entry) when it has a `kind` field of
  // 'custom' or 'onPerson'. Entries don't have that field (they have
  // defKind + defId). This is the single discriminator used throughout
  // the walk code.
  function isGroupNode(node) {
    return !!(node && (node.kind === 'custom' || node.kind === 'onPerson'));
  }

  // Walk every entry in the inventory tree and ensure it has a
  // `snapshot` field. See ensureInventory for rationale. Post-refactor,
  // the tree is entirely groups-and-entries; bySlot is gone.
  function migrateSnapshots(inv) {
    const ruleset = getRuleset ? getRuleset() : null;
    // `visit` walks an array that may hold entries OR subgroups.
    // Entries get their snapshot populated; groups are recursed into.
    const visit = (arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach(node => {
        if (!node || typeof node !== 'object') return;
        if (isGroupNode(node)) {
          visit(node.contents);
        } else {
          // Entry — populate snapshot if missing.
          if (!node.snapshot) {
            node.snapshot = buildSnapshotFromDef(node, ruleset, inv);
          }
          // Recurse into container contents so nested legacy entries
          // get migrated too.
          if (Array.isArray(node.contents)) visit(node.contents);
        }
      });
    };
    (inv.groups || []).forEach(g => visit(g.contents));
  }

  // Build a snapshot object for an entry by looking up its def in the
  // ruleset + customDefs. Used during migration of legacy entries AND
  // during instantiation of new ones. Deep-copies dimensions and
  // containerOf so snapshot edits don't mutate shared def references.
  function buildSnapshotFromDef(entry, ruleset, inv) {
    const def = findDefInSources(entry.defId, ruleset, inv);
    if (def) {
      // Determine containerOf. Three possible def shapes:
      //   1. Unified ruleset item with `containerOf` block — use it.
      //   2. Legacy pure-container with top-level `packingEfficiency`
      //      and no explicit containerOf — synthesize containerOf from
      //      dimensions + packingEfficiency (they represent the inner
      //      capacity in the old schema).
      //   3. Plain item — null.
      let containerOf = null;
      if (def.containerOf) {
        containerOf = {
          dimensions:        deepCopyDims(def.containerOf.dimensions),
          packingEfficiency: Number.isFinite(def.containerOf.packingEfficiency) ? def.containerOf.packingEfficiency : 0.75
        };
      } else if (def.packingEfficiency != null) {
        containerOf = {
          dimensions:        deepCopyDims(def.dimensions),
          packingEfficiency: Number.isFinite(def.packingEfficiency) ? def.packingEfficiency : 0.75
        };
      }
      return {
        name:          def.name || '',
        description:   def.description || '',
        dimensions:    deepCopyDims(def.dimensions),
        weight:        Number.isFinite(def.weight) ? def.weight : 0,
        containerOf,
        // Legacy category string preserved so weapon-linkage etc. can
        // still resolve if needed. defaultSlot NOT snapshotted because
        // it's only useful during catalog-add.
        legacyCategory: def.legacyCategory || def.category || ''
      };
    }
    // Def is missing entirely — build a minimal placeholder snapshot
    // so the entry still renders with a recognizable name.
    return {
      name:          '(unknown item)',
      description:   '',
      dimensions:    { l: 0, w: 0, h: 0 },
      weight:        0,
      containerOf:   entry.defKind === 'container' || Array.isArray(entry.contents) ? {
        dimensions: { l: 0, w: 0, h: 0 },
        packingEfficiency: 0.75
      } : null,
      legacyCategory: ''
    };
  }

  // Helper: find a def across ruleset.items + customDefs.{containers,equipment}.
  // Returns null if no match. Same logic as getItemDef but without
  // requiring the module's context getters — used by migrations that
  // may run before the full module is wired up.
  function findDefInSources(defId, ruleset, inv) {
    if (!defId) return null;
    const fromRuleset = ((ruleset && ruleset.items) || []).find(x => x.id === defId);
    if (fromRuleset) return fromRuleset;
    const fromEq   = ((inv && inv.customDefs && inv.customDefs.equipment)  || []).find(x => x.id === defId);
    if (fromEq) return fromEq;
    const fromCont = ((inv && inv.customDefs && inv.customDefs.containers) || []).find(x => x.id === defId);
    if (fromCont) return fromCont;
    return null;
  }

  function deepCopyDims(d) {
    if (!d || typeof d !== 'object') return { l: 0, w: 0, h: 0 };
    return {
      l: Number.isFinite(d.l) ? d.l : 0,
      w: Number.isFinite(d.w) ? d.w : 0,
      h: Number.isFinite(d.h) ? d.h : 0
    };
  }

  // Walk the inventory tree, calling visit(entry, parentArray, index)
  // for each item/container entry. Groups are traversed into but never
  // passed to the visitor — visit() is called only on entries.
  //
  // Post-refactor, every entry lives inside some group's contents (or
  // nested inside a container or subgroup within that). There are no
  // more body slots to special-case.
  function walkTree(visit) {
    const inv = ensureInventory();
    const visitArr = (arr) => {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i++) {
        const node = arr[i];
        if (!node || typeof node !== 'object') continue;
        if (isGroupNode(node)) {
          // Subgroup — don't call visit, just recurse.
          visitArr(node.contents);
        } else {
          // Entry — call visit, then recurse into its container contents.
          visit(node, arr, i);
          if (Array.isArray(node.contents)) visitArr(node.contents);
        }
      }
    };
    (inv.groups || []).forEach(g => visitArr(g.contents));
  }

  function findEntry(id) {
    if (!id) return null;
    let found = null;
    walkTree((entry) => { if (entry.id === id) found = entry; });
    return found;
  }

  function removeEntry(id) {
    const inv = ensureInventory();
    // Remove a node (entry OR subgroup) from whichever array it lives
    // in. Recurses through subgroups and container contents equally.
    const removeFromArr = (arr) => {
      if (!Array.isArray(arr)) return false;
      for (let i = 0; i < arr.length; i++) {
        const node = arr[i];
        if (!node || typeof node !== 'object') continue;
        if (node.id === id) { arr.splice(i, 1); return true; }
        if (Array.isArray(node.contents) && removeFromArr(node.contents)) return true;
      }
      return false;
    };
    for (const g of inv.groups) {
      if (removeFromArr(g.contents)) return true;
    }
    return false;
  }

  // Find the subgroup (or top-level group) with the given id. Walks the
  // nested subgroup tree. Returns null if not found. Used by placement
  // targeting when the user picks a specific subgroup from a menu.
  function findGroup(id) {
    if (!id) return null;
    const inv = ensureInventory();
    const search = (nodes) => {
      if (!Array.isArray(nodes)) return null;
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        if (isGroupNode(node)) {
          if (node.id === id) return node;
          const nested = search(node.contents);
          if (nested) return nested;
        }
      }
      return null;
    };
    // Top-level groups (On-Person + custom) are in inv.groups directly.
    for (const g of inv.groups || []) {
      if (g.id === id) return g;
      const nested = search(g.contents);
      if (nested) return nested;
    }
    return null;
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

    const inv = ensureInventory();
    const canEdit = getCanEdit();

    // View toggle header: always at the top, switches between the
    // character's actual inventory and the read-only ruleset catalog.
    // Owner-only Manage Catalogue button floats to the right; it opens
    // a modal for CRUD on the character's personal catalogue (custom
    // defs) without needing to go through the Add → + Custom flow.
    let html = `<div class="inv-view-toggle">
      <div class="inv-view-toggle-left">
        <button class="inv-view-btn${viewMode === 'inventory' ? ' on' : ''}" onclick="invSetViewMode('inventory')">Inventory</button>
        <button class="inv-view-btn${viewMode === 'catalog'   ? ' on' : ''}" onclick="invSetViewMode('catalog')">Catalog</button>
      </div>
      ${canEdit ? `<button class="inv-manage-btn" onclick="invOpenManageCatalog()" title="Create, edit, and delete items in your personal catalogue for this character.">Manage Personal Catalogue</button>` : ''}
    </div>`;

    // Toast confirming the last add/promote action, if any. Fades
    // after 3s via the timer that set it. Renders in either view.
    if (lastAddToast) {
      html += `<div class="inv-add-toast">${escapeHtml(lastAddToast)}</div>`;
    }

    if (viewMode === 'catalog') {
      html += renderCatalogView(ruleset, inv);
    } else {
      // Carry stats — three cards (CAP / ENC / LIFT) at the top of the
      // inventory view. They show the current derived carry state and
      // let the player manage named modifiers on each. Derived in sync
      // with char-derived.js; modifiers are stored on the character
      // (capModifiers, liftModifiers, encModifiers arrays).
      const charData = getCharData();
      if (charData) {
        const derived = computeDerivedStats(charData, ruleset);
        html += renderCarryCards(derived.carry, canEdit);
      }

      // Inventory view — groups-first layout: On-Person (wraps slots)
      // plus any custom groups. One group header per entry in inv.groups,
      // rendered in order. Custom groups may be renamed/deleted;
      // On-Person cannot.
      inv.groups.forEach(group => {
        html += renderGroup(group, ruleset, inv, canEdit);
      });

      // Add-group button at the bottom of the inventory view. Custom
      // groups only — On-Person is special and always exists.
      if (canEdit) {
        html += `<div class="inv-add-group-row">
          <button class="inv-add-btn inv-add-btn-ghost" onclick="invAddGroup()">+ Add Group</button>
          <span class="inv-add-group-hint">e.g. Vehicle, Safe House, Stash — anything that isn't on your body.</span>
        </div>`;
      }
    }

    // Modal host — only gets content when activeModal is set.
    html += '<div id="inv-modal-root"></div>';

    // Personal Catalogue manager — separate modal root so it stacks
    // cleanly above the picker when both would be open (rare, but
    // possible if a user Ctrl-clicks or script-triggers; better to have
    // predictable ordering than overlap chaos).
    html += '<div id="inv-catalog-manager-root"></div>';

    host.innerHTML = html;

    if (activeModal) renderActiveModal();
    // Always touch the manager root — when open, render the modal;
    // when closed, explicitly clear it. Without the explicit clear,
    // a stale modal could persist in environments that re-use DOM
    // references rather than rebuilding from the host's innerHTML.
    if (catalogManager.open) {
      renderCatalogManager();
    } else {
      const mgrRoot = document.getElementById('inv-catalog-manager-root');
      if (mgrRoot) mgrRoot.innerHTML = '';
    }
  }

  // ─── CARRY CARDS (CAP / ENC / LIFT) ───
  //
  // Three cards at the top of the Inventory tab showing the character's
  // current carry stats. Each card has:
  //   - A current value (post-modifier)
  //   - A base value (pre-modifier, if mods are in play)
  //   - A toggle-to-expand modifier editor with named ± entries
  //
  // CAP and LIFT accept percent modifiers (+50% = ×1.5). ENC modifiers
  // are additive to the % value directly. See char-derived.js for the
  // math; this file is purely presentation + CRUD.

  function renderCarryCards(carry, canEdit) {
    if (!carry) return '';
    const capOpen  = expandedCarryCards.has('cap');
    const encOpen  = expandedCarryCards.has('enc');
    const liftOpen = expandedCarryCards.has('lift');

    // Over-capacity severity tint on ENC. Mirrors the Pain/Stress pill
    // color scale so players read severity at a glance.
    const encPct = carry.encPercent || 0;
    const encSev = encPct >= 75 ? ' carry-crit'
                 : encPct >= 50 ? ' carry-heavy'
                 : encPct >= 25 ? ' carry-light'
                 : ' carry-zero';

    let html = '<div class="inv-carry-cards">';

    // ── CAP CARD ──
    html += renderCarryCard({
      key:        'cap',
      label:      'Carrying Capacity',
      code:       'CAP',
      open:       capOpen,
      canEdit,
      valueHtml:  `${fmt(carry.cap)} <span class="inv-carry-unit">lbs</span>`,
      baseHtml:   (carry.capModTotal !== 0)
                    ? `<span class="inv-carry-base">base ${fmt(carry.rawCap)} ${carry.capModTotal > 0 ? '+' : '−'} ${Math.abs(carry.capModTotal)}%</span>`
                    : `<span class="inv-carry-base">base ${fmt(carry.rawCap)}</span>`,
      description:'Maximum weight you can carry without penalty. Base: STR × 10. Abilities and modifiers adjust this.',
      modifiers:  carry.capModifiers,
      modUnit:    '%',
      addFn:      'invAddCapMod',
      updateFn:   'invUpdateCapMod',
      deleteFn:   'invDeleteCapMod',
      severityCls:''
    });

    // ── ENC CARD ──
    // ENC shows current % + the ratio that produced it. The card is
    // "informational" — you can still add named mods (Exhausted: +10%)
    // but the raw ENC from carried/CAP flows in automatically.
    const ratio = carry.cap > 0
      ? `${fmt(carry.carried)} / ${fmt(carry.cap)} lbs`
      : `${fmt(carry.carried)} lbs (no CAP)`;
    const overBy = Math.max(0, carry.carried - carry.cap);
    const ratioSub = overBy > 0
      ? `<span class="inv-carry-base">over by ${fmt(overBy)} lbs</span>`
      : `<span class="inv-carry-base">within CAP</span>`;
    html += renderCarryCard({
      key:        'enc',
      label:      'Encumbrance',
      code:       'ENC',
      open:       encOpen,
      canEdit,
      valueHtml:  `${fmt(encPct)}<span class="inv-carry-unit">%</span>`,
      baseHtml:   `<div class="inv-carry-ratio">${ratio}</div>${ratioSub}${carry.encModTotal !== 0 ? `<span class="inv-carry-base"> · mods ${carry.encModTotal > 0 ? '+' : '−'}${Math.abs(carry.encModTotal)}%</span>` : ''}`,
      description:'Penalty from carrying weight above CAP. +10% per increment over CAP (continuous). Hits 100% at LIFT.',
      modifiers:  carry.encModifiers,
      modUnit:    '%',
      addFn:      'invAddEncMod',
      updateFn:   'invUpdateEncMod',
      deleteFn:   'invDeleteEncMod',
      severityCls: encSev
    });

    // LIFT banner + card highlight. Two tiers:
    //   at LIFT exactly — an "at LIFT" warning
    //   over LIFT — a "cannot carry" danger banner with the overflow
    // The ENC card's own severity tint already hits red at 100%, so
    // this banner adds the actionable detail: how much over, and what
    // it means mechanically. We also add a severity class to the card
    // itself so its border glows to draw the eye.
    let liftBanner = '';
    let liftSeverityCls = '';
    if (carry.lift > 0) {
      const over = carry.carried - carry.lift;
      if (over >= 0) {
        // At or over LIFT.
        if (over === 0) {
          liftBanner = `<div class="inv-carry-banner inv-carry-banner-warn">
            <span class="inv-carry-banner-icon">⚠</span>
            <span class="inv-carry-banner-txt"><strong>At LIFT.</strong> ENC is 100%. You cannot move without rolling to lift.</span>
          </div>`;
          liftSeverityCls = ' carry-heavy';
        } else {
          liftBanner = `<div class="inv-carry-banner inv-carry-banner-danger">
            <span class="inv-carry-banner-icon">⛔</span>
            <span class="inv-carry-banner-txt"><strong>Over LIFT by ${fmt(over)} lbs.</strong> You cannot carry this weight without a successful lift roll — drop something, or test STR to hoist it.</span>
          </div>`;
          liftSeverityCls = ' carry-crit';
        }
      } else if (carry.carried >= carry.lift * 0.9) {
        // Approaching LIFT — within 10% of max. Soft heads-up.
        const remaining = carry.lift - carry.carried;
        liftBanner = `<div class="inv-carry-banner inv-carry-banner-note">
          <span class="inv-carry-banner-icon">◉</span>
          <span class="inv-carry-banner-txt">Nearing LIFT — ${fmt(remaining)} lbs until max.</span>
        </div>`;
        liftSeverityCls = ' carry-light';
      }
    }

    // ── LIFT CARD ──
    html += renderCarryCard({
      key:        'lift',
      label:      'Maximum Lift',
      code:       'LIFT',
      open:       liftOpen,
      canEdit,
      valueHtml:  `${fmt(carry.lift)} <span class="inv-carry-unit">lbs</span>`,
      baseHtml:   (carry.liftModTotal !== 0)
                    ? `<span class="inv-carry-base">base ${fmt(carry.rawLift)} ${carry.liftModTotal > 0 ? '+' : '−'} ${Math.abs(carry.liftModTotal)}%</span>`
                    : `<span class="inv-carry-base">base ${fmt(carry.rawLift)}</span>`,
      description:'Absolute maximum you can ever carry without a roll. At this weight, ENC is 100% and you cannot move without rolling to "lift". Base: CAP × 11.',
      modifiers:  carry.liftModifiers,
      modUnit:    '%',
      addFn:      'invAddLiftMod',
      updateFn:   'invUpdateLiftMod',
      deleteFn:   'invDeleteLiftMod',
      severityCls: liftSeverityCls,
      banner:     liftBanner
    });

    html += '</div>';
    return html;
  }

  // One carry card. Shared markup for CAP / ENC / LIFT — they all have
  // the same visual shape: big value, base/ratio sub-line, description,
  // an optional banner (warnings/notices), and an expandable modifier
  // editor.
  function renderCarryCard(opts) {
    const {
      key, label, code, open, canEdit, valueHtml, baseHtml,
      description, modifiers, modUnit, addFn, updateFn, deleteFn, severityCls,
      banner
    } = opts;
    const mods = Array.isArray(modifiers) ? modifiers : [];
    const modsClass = mods.length > 0 ? ' has-mods' : '';

    let html = `<div class="inv-carry-card${open ? ' open' : ''}${modsClass}${severityCls || ''}">
      <div class="inv-carry-head" onclick="invToggleCarryCard('${key}')" title="Click to ${open ? 'collapse' : 'expand'} ${label} modifiers">
        <div class="inv-carry-label">
          <span class="inv-carry-name">${escapeHtml(label)}</span>
          <span class="inv-carry-code">${escapeHtml(code)}</span>
        </div>
        <div class="inv-carry-value">${valueHtml}</div>
        <div class="inv-carry-sub">${baseHtml || ''}</div>
      </div>
      ${banner || ''}
      <div class="inv-carry-desc">${escapeHtml(description || '')}</div>`;

    if (open) {
      html += `<div class="inv-carry-panel">`;
      if (mods.length === 0) {
        html += `<div class="inv-carry-empty">No modifiers. ${canEdit ? 'Add one below.' : ''}</div>`;
      } else {
        html += `<div class="inv-carry-mods">`;
        mods.forEach((m, idx) => {
          const name  = (m && m.name)  || '';
          const value = (m && typeof m.value === 'number') ? m.value : 0;
          html += `<div class="inv-carry-mod-row">`;
          if (canEdit) {
            html += `
              <input type="text" class="inv-carry-mod-name"
                     value="${escapeHtml(name)}"
                     oninput="${updateFn}(${idx}, 'name', this.value)"
                     placeholder="Name (e.g. Brawny Trait)"/>
              <input type="number" class="inv-carry-mod-value"
                     value="${value}" step="1"
                     oninput="${updateFn}(${idx}, 'value', this.value)"/>
              <span class="inv-carry-mod-unit">${escapeHtml(modUnit)}</span>
              <button class="inv-carry-mod-del" onclick="${deleteFn}(${idx})" title="Remove modifier">×</button>`;
          } else {
            const sign = value > 0 ? '+' : (value < 0 ? '−' : '±');
            html += `
              <span class="inv-carry-mod-name readonly">${escapeHtml(name || '(unnamed)')}</span>
              <span class="inv-carry-mod-value readonly">${sign}${Math.abs(value)}${escapeHtml(modUnit)}</span>`;
          }
          html += `</div>`;
        });
        html += `</div>`;
      }
      if (canEdit) {
        html += `<button class="inv-carry-add" onclick="${addFn}()">+ Add Modifier</button>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  function toggleCarryCard(key) {
    if (!key) return;
    if (expandedCarryCards.has(key)) expandedCarryCards.delete(key);
    else expandedCarryCards.add(key);
    renderAll();
  }

  // ── CAP/LIFT/ENC modifier CRUD ──
  // Three parallel arrays on the character object. Same patterns as
  // painModifiers / stressModifiers — add a default-named entry,
  // update per field, delete by index. Save after each change so
  // the change persists even if the session ends mid-edit.

  function addCarryMod(arrayKey, defaultName) {
    if (!getCanEdit()) return;
    const c = getCharData();
    if (!c) return;
    if (!Array.isArray(c[arrayKey])) c[arrayKey] = [];
    c[arrayKey].push({ name: defaultName || '', value: 0 });
    saveCharacter(getCharId(), c);
    // Expand the card matching this array so the new row is visible.
    const key = (arrayKey === 'capModifiers')  ? 'cap'
             : (arrayKey === 'liftModifiers') ? 'lift'
             : (arrayKey === 'encModifiers')  ? 'enc' : null;
    if (key) expandedCarryCards.add(key);
    renderAll();
  }
  function updateCarryMod(arrayKey, idx, field, raw) {
    if (!getCanEdit()) return;
    const c = getCharData();
    if (!c || !Array.isArray(c[arrayKey]) || !c[arrayKey][idx]) return;
    if (field === 'name') {
      c[arrayKey][idx].name = String(raw || '');
    } else if (field === 'value') {
      const n = parseFloat(raw);
      c[arrayKey][idx].value = Number.isFinite(n) ? n : 0;
    }
    saveCharacter(getCharId(), c);
    renderAll();
  }
  function deleteCarryMod(arrayKey, idx) {
    if (!getCanEdit()) return;
    const c = getCharData();
    if (!c || !Array.isArray(c[arrayKey])) return;
    c[arrayKey].splice(idx, 1);
    saveCharacter(getCharId(), c);
    renderAll();
  }

  function addCapMod()    { addCarryMod('capModifiers',  ''); }
  function addLiftMod()   { addCarryMod('liftModifiers', ''); }
  function addEncMod()    { addCarryMod('encModifiers',  ''); }
  function updateCapMod(i,f,v)  { updateCarryMod('capModifiers',  i, f, v); }
  function updateLiftMod(i,f,v) { updateCarryMod('liftModifiers', i, f, v); }
  function updateEncMod(i,f,v)  { updateCarryMod('encModifiers',  i, f, v); }
  function deleteCapMod(i)  { deleteCarryMod('capModifiers',  i); }
  function deleteLiftMod(i) { deleteCarryMod('liftModifiers', i); }
  function deleteEncMod(i)  { deleteCarryMod('encModifiers',  i); }

  // Toggle a group's countsForEncumbrance flag. Called from the group
  // header checkbox. Inverts the current effective value — if the
  // group was counting (explicitly or by default), it stops counting;
  // if it wasn't, it starts.
  function toggleGroupEncumbrance(groupId) {
    if (!getCanEdit()) return;
    const c = getCharData();
    if (!c) return;
    const group = findGroup(groupId);
    if (!group) return;
    // Compute current effective state: onPerson defaults true, others false.
    const currentlyCounts = (typeof group.countsForEncumbrance === 'boolean')
      ? group.countsForEncumbrance
      : (group.kind === 'onPerson');
    group.countsForEncumbrance = !currentlyCounts;
    saveCharacter(getCharId(), c);
    renderAll();
  }

  // ─── GROUP RENDERER ───
  //
  // Each group is a top-level collapsible section. On-Person's body is
  // the ruleset's body slots (each a sub-section). Custom groups have a
  // flat contents array — containers and loose items at the top level.

  function renderGroup(group, ruleset, inv, canEdit, depth) {
    if (depth == null) depth = 0;
    const collapsed = !!group.collapsed;
    const isOnPerson = group.kind === 'onPerson';
    const isSubgroup = depth > 0;

    // Totals: weight and count across everything in the group,
    // recursively including nested subgroups.
    const { totalWeight, totalCount } = tallyArr(group.contents || []);

    // Header actions. On-Person cannot be renamed or deleted. Custom
    // groups and subgroups both allow it. Subgroups use the same
    // rename/delete flow as top-level custom groups — the handlers
    // walk the tree to find the target by id, so depth doesn't matter.
    const extraHeaderActions = (!isOnPerson && canEdit) ? `
      <button class="inv-group-btn" onclick="event.stopPropagation();invRenameGroup('${escapeHtml(group.id)}')" title="Rename group">✎</button>
      <button class="inv-group-btn inv-group-btn-danger" onclick="event.stopPropagation();invDeleteGroup('${escapeHtml(group.id)}')" title="Delete group (and everything in it)">×</button>
    ` : '';

    // "Counts for encumbrance" toggle. On-Person defaults true (and
    // stays true unless the player explicitly flips it off). Custom
    // groups default false (must be turned on). The effective value:
    //   explicit boolean on the group record wins;
    //   otherwise fall back to the kind default.
    // Inline button styled as a pill with an obvious on/off state.
    // Click stops propagation so it doesn't also collapse the group.
    const countsForEnc = (typeof group.countsForEncumbrance === 'boolean')
      ? group.countsForEncumbrance
      : (group.kind === 'onPerson');
    const encTitle = countsForEnc
      ? `Items in this group COUNT toward your Encumbrance. Click to stop counting.`
      : `Items in this group do NOT count toward your Encumbrance. Click to start counting.`;
    const encToggle = canEdit ? `
      <button class="inv-group-enc-toggle${countsForEnc ? ' on' : ''}"
              onclick="event.stopPropagation();invToggleGroupEncumbrance('${escapeHtml(group.id)}')"
              title="${escapeHtml(encTitle)}">
        ${countsForEnc ? '⚖ ENC' : '○ ENC'}
      </button>` : (countsForEnc ? `<span class="inv-group-enc-badge">⚖ ENC</span>` : '');

    const groupClasses = [
      'inv-group',
      collapsed ? 'collapsed' : '',
      isOnPerson ? 'inv-group-onperson' : 'inv-group-custom',
      isSubgroup ? 'inv-group-sub' : ''
    ].filter(Boolean).join(' ');

    // Subgroups are indented relative to their parent group's body.
    // Depth * 16px matches the indent scheme used by container entries
    // nested inside other containers.
    const indentStyle = isSubgroup ? `style="margin-left:${depth * 16}px"` : '';

    let html = `<div class="${groupClasses}" ${indentStyle}>
      <div class="inv-group-head" onclick="invToggleGroupCollapse('${escapeHtml(group.id)}')">
        <span class="inv-group-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="inv-group-label">${escapeHtml(group.name)}</span>
        <span class="inv-group-meta">${totalCount} item${totalCount === 1 ? '' : 's'} · ${fmt(totalWeight)} lb${totalWeight === 1 ? '' : 's'}</span>
        ${encToggle}
        ${extraHeaderActions}
      </div>`;

    if (!collapsed) {
      html += '<div class="inv-group-body">';

      // Description banner at the top — custom groups and subgroups
      // can both have one. On-Person traditionally doesn't.
      if (!isOnPerson && group.description && group.description.trim()) {
        html += `<div class="inv-group-desc">${escapeHtml(group.description)}</div>`;
      }

      // Walk contents: mix of entries and subgroups. Subgroups recurse
      // via renderGroup with incremented depth; entries go through the
      // normal entry renderer.
      const contents = Array.isArray(group.contents) ? group.contents : [];
      if (contents.length === 0) {
        html += '<div class="inv-empty-row">Empty.</div>';
      } else {
        contents.forEach(node => {
          if (isGroupNode(node)) {
            // Nested subgroup. Recurse.
            html += renderGroup(node, ruleset, inv, canEdit, depth + 1);
          } else {
            // Regular entry (container or item).
            html += renderEntry(node, 0, canEdit);
          }
        });
      }

      // Action row at the bottom of every group's body. Three buttons:
      // add a container, add a loose item, and add a subgroup (for
      // further organizational nesting).
      if (canEdit) {
        html += `<div class="inv-group-actions">
          <button class="inv-add-btn" onclick="invOpenAddContainer('${escapeHtml(group.id)}','group')">+ Add Container</button>
          <button class="inv-add-btn inv-add-btn-ghost" onclick="invOpenAddItem('${escapeHtml(group.id)}','group')">+ Add Loose Item</button>
          <button class="inv-add-btn inv-add-btn-ghost" onclick="invAddSubgroup('${escapeHtml(group.id)}')" title="Add a nested group inside this one (e.g. inside On-Person: Back, Belt, Holster).">+ Add Subgroup</button>
        </div>`;
      }

      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── CATALOG VIEW ───
  //
  // Read-only browser of the ruleset's item catalog, organized by
  // category. Mirrors the ruleset editor's structure but without any
  // edit controls — players just see what exists in their world.
  //
  // Walks `ruleset.categories` as a tree via parent pointers, nests
  // items under their categories. Items with null/missing category land
  // under the built-in "Miscellaneous" bucket.
  //
  // Each item row shows name + dimensions + weight by default. Click
  // to expand — description, container capacity (if it's a container),
  // packing efficiency, default body slot, etc.

  function renderCatalogView(ruleset, inv) {
    const items = Array.isArray(ruleset.items) ? ruleset.items : [];
    const categories = Array.isArray(ruleset.categories) ? ruleset.categories : [];

    if (items.length === 0 && categories.length <= 1) {
      return `<div class="inv-empty">This ruleset's catalog is empty. Open the ruleset editor's Inventory tab to add items and categories.</div>`;
    }

    // Group items by category id. Items with null or deleted categoryId
    // fall into Miscellaneous automatically (the display-time fallback).
    const itemsByCat = new Map();
    const validCatIds = new Set(categories.map(c => c.id));
    items.forEach(it => {
      const cid = (it.categoryId && validCatIds.has(it.categoryId)) ? it.categoryId : 'cat_misc';
      if (!itemsByCat.has(cid)) itemsByCat.set(cid, []);
      itemsByCat.get(cid).push(it);
    });

    // Build a parent → children map so we can walk the tree.
    const byParent = new Map();
    categories.forEach(c => {
      const pid = c.parentId || '__root__';
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(c);
    });

    // Also expose character-scoped custom defs at the top of the
    // catalog, since the player might want to see those too. They
    // don't live in the ruleset's categories — we synthesize a
    // "Custom (this character only)" pseudo-section for them.
    const customDefs = [];
    (inv.customDefs.containers || []).forEach(d => customDefs.push(d));
    (inv.customDefs.equipment  || []).forEach(d => customDefs.push(d));

    let html = `<div class="cat-view-header">
      <div class="cat-view-title">Ruleset Catalog</div>
      <div class="cat-view-sub">Browse-only view of every item this ruleset defines. Add items to your character from the Inventory view.</div>
    </div>`;

    // Custom section first — the player's own one-offs. Only renders if
    // any exist so empty charDefs don't clutter the view.
    if (customDefs.length > 0) {
      html += renderCatalogCustomSection(customDefs);
    }

    // Walk the ruleset's category tree. Render each category header,
    // then its items (sorted alphabetically for browsability), then
    // recurse into children.
    const renderCatNode = (cat, depth) => {
      const catItems = (itemsByCat.get(cat.id) || []).slice().sort(sortByName);
      const children = byParent.get(cat.id) || [];
      const collapsed = collapsedCatalogCats.has(cat.id);
      const directCount = catItems.length;
      // Total count through descendants — shown in the header to give
      // a sense of how much lives under each branch without needing
      // to expand every subcategory.
      const totalCount = countItemsRecursive(cat, itemsByCat, byParent);

      let out = `<div class="cat-view-section" style="margin-left:${depth * 18}px">
        <div class="cat-view-section-head${children.length === 0 && directCount === 0 ? ' empty' : ''}" onclick="invToggleCatalogCat('${escapeHtml(cat.id)}')">
          <span class="cat-view-caret">${collapsed ? '▸' : '▾'}</span>
          <span class="cat-view-name">${escapeHtml(cat.name)}</span>
          <span class="cat-view-count" title="${directCount} direct · ${totalCount} including subcategories">${directCount}${totalCount !== directCount ? ` / ${totalCount}` : ''}</span>
        </div>`;

      if (!collapsed) {
        if (cat.description && cat.description.trim()) {
          out += `<div class="cat-view-desc" style="margin-left:${(depth + 1) * 18}px">${escapeHtml(cat.description)}</div>`;
        }
        if (directCount === 0 && children.length === 0) {
          out += `<div class="cat-view-empty-row" style="margin-left:${(depth + 1) * 18}px">Empty.</div>`;
        } else {
          catItems.forEach(it => { out += renderCatalogItem(it, depth + 1); });
          children.forEach(ch => { out += renderCatNode(ch, depth + 1); });
        }
      }
      out += `</div>`;
      return out;
    };

    (byParent.get('__root__') || []).forEach(cat => { html += renderCatNode(cat, 0); });

    return html;
  }

  // Helper: case-insensitive name sort. Used for alphabetical ordering
  // within a category.
  function sortByName(a, b) {
    const an = (a.name || '').toLowerCase();
    const bn = (b.name || '').toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  }

  // Helper: recursively count items in a category and all descendants.
  // Used for the "total" badge on category headers.
  function countItemsRecursive(cat, itemsByCat, byParent) {
    let n = (itemsByCat.get(cat.id) || []).length;
    (byParent.get(cat.id) || []).forEach(ch => { n += countItemsRecursive(ch, itemsByCat, byParent); });
    return n;
  }

  // The "Custom" synthetic section — character-scoped custom defs with
  // a distinct visual treatment so users remember these aren't shared.
  function renderCatalogCustomSection(customDefs) {
    const sorted = customDefs.slice().sort(sortByName);
    const collapsed = collapsedCatalogCats.has('__custom__');
    let html = `<div class="cat-view-section cat-view-section-custom">
      <div class="cat-view-section-head" onclick="invToggleCatalogCat('__custom__')">
        <span class="cat-view-caret">${collapsed ? '▸' : '▾'}</span>
        <span class="cat-view-name">Custom</span>
        <span class="cat-view-custom-badge">this character only</span>
        <span class="cat-view-count">${sorted.length}</span>
      </div>`;
    if (!collapsed) {
      html += `<div class="cat-view-desc" style="margin-left:18px">One-off items and containers created on this character's sheet. Not visible to other characters.</div>`;
      sorted.forEach(it => { html += renderCatalogItem(it, 1, /*isCustom=*/true); });
    }
    html += `</div>`;
    return html;
  }

  // Render a single item row in the catalog view. Collapsed by default:
  // name + container pill + dims + weight + Add button. Clicking the
  // name region expands detail; clicking the Add button places the item
  // on the character; clicking the Add dropdown shows target choices.
  function renderCatalogItem(it, depth, isCustom) {
    const dims = it.dimensions || { l: 0, w: 0, h: 0 };
    const isContainer = !!it.containerOf;
    const open = expandedCatalogItems.has(it.id);
    const addMenuOpen = catalogAddMenuFor === it.id;
    const containerPill = isContainer ? '<span class="cat-view-container-pill" title="Container — can hold other items">container</span>' : '';
    const customPill = isCustom ? '<span class="cat-view-item-custom">custom</span>' : '';
    const weight = it.weight || 0;
    const hasDetail = !!(
      (it.description && it.description.trim()) ||
      it.containerOf ||
      (it.legacyCategory && it.legacyCategory.trim())
    );

    const canEdit = getCanEdit();

    // Clicking the caret/name area toggles the description panel.
    // Clicking the Add button or its dropdown trigger is stopped from
    // propagating so those don't also expand the row.
    let html = `<div class="cat-view-item${open ? ' open' : ''}${hasDetail ? ' expandable' : ''}" style="margin-left:${depth * 18}px">
      <div class="cat-view-item-head">
        <div class="cat-view-item-main" ${hasDetail ? `onclick="invToggleCatalogItem('${escapeHtml(it.id)}')"` : ''}>
          <span class="cat-view-item-caret">${hasDetail ? (open ? '▾' : '▸') : '•'}</span>
          <span class="cat-view-item-name">${escapeHtml(it.name || '(unnamed)')}</span>
          ${containerPill}
          ${customPill}
          <span class="cat-view-item-dims">${fmt(dims.l)}×${fmt(dims.w)}×${fmt(dims.h)} in</span>
          <span class="cat-view-item-weight">${fmt(weight)} lb</span>
        </div>`;

    // Add button — owner-only. Split into two halves:
    //   • Left: quick-add using smart default
    //   • Right (▾): drop-down menu of explicit targets
    if (canEdit) {
      html += `<div class="cat-view-add-split">
        <button class="cat-view-add-btn" onclick="event.stopPropagation();invCatalogQuickAdd('${escapeHtml(it.id)}')" title="Add to ${escapeHtml(smartDefaultLabel(it))}">+ Add</button>
        <button class="cat-view-add-drop${addMenuOpen ? ' open' : ''}" onclick="event.stopPropagation();invCatalogToggleAddMenu('${escapeHtml(it.id)}')" title="Choose destination…">▾</button>
      </div>`;
    }

    html += `</div>`;

    // Floating drop-down menu for target choice — rendered inline so
    // it naturally sits below its owner button. CSS pins it absolutely
    // relative to the row.
    if (addMenuOpen && canEdit) {
      html += renderCatalogAddMenu(it);
    }

    // Detail panel — description, container capacity, default slot,
    // etc. Rendered only when open AND there's something to show.
    if (open && hasDetail) {
      html += `<div class="cat-view-item-detail">`;
      if (it.description && it.description.trim()) {
        html += `<div class="cat-view-item-desc">${escapeHtml(it.description)}</div>`;
      }
      if (isContainer) {
        const cof = it.containerOf;
        const cofDims = cof.dimensions || { l: 0, w: 0, h: 0 };
        const rawCap = (cofDims.l || 0) * (cofDims.w || 0) * (cofDims.h || 0);
        const usable = rawCap * (cof.packingEfficiency || 0.75);
        html += `<div class="cat-view-item-cap">
          <span class="cat-view-item-cap-label">Capacity:</span>
          <span class="cat-view-item-cap-val">${fmt(cofDims.l)}×${fmt(cofDims.w)}×${fmt(cofDims.h)} in · ${fmt(cof.packingEfficiency || 0.75)} packing · <b>${fmt(usable)} in³ usable</b></span>
        </div>`;
      }
      // Note: item defs may carry a legacy `defaultSlot` field pointing
      // at a body-slot code. Body slots no longer exist, so we don't
      // show this field in the catalog detail panel.
      if (it.legacyCategory && it.legacyCategory.trim()) {
        html += `<div class="cat-view-item-legacy">
          <span class="cat-view-item-cap-label">Legacy tag:</span>
          <span class="cat-view-item-cap-val">${escapeHtml(it.legacyCategory)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  // Compute the short human-readable label for the smart default target
  // of an item — used as the `+ Add` button's tooltip.
  //
  //   - Container with defaultSlot → "Back" (the slot's label)
  //   - Container without defaultSlot → "Stowed" (or "a new Stowed group")
  //   - Non-container → "Stowed"
  //
  // Purely descriptive; the actual placement logic lives in
  // smartDefaultTarget below.
  function smartDefaultLabel(it) {
    const target = smartDefaultTarget(it);
    if (!target) return 'your inventory';
    if (target.kind === 'slot') {
      const ruleset = getRuleset();
      const slot = (ruleset.bodySlots || []).find(s => s.code === target.code);
      return slot ? slot.label : target.code;
    }
    if (target.kind === 'group') {
      const inv = ensureInventory();
      const g = inv.groups.find(x => x.id === target.id);
      return g ? g.name : 'a group';
    }
    if (target.kind === 'newGroup') return 'a new Stowed group';
    return 'your inventory';
  }

  // Determine where a catalog item should go when the user quick-adds.
  // Smart-default target selection for the catalog's quick-add button.
  // Returns { kind, ...targetRef }. Falls back to creating a new group
  // if nothing exists yet.
  //
  // Priority order:
  //   1. An existing custom group named "Stowed" (case-insensitive)
  //   2. First existing custom top-level group
  //   3. On-Person (always exists; everything gets dumped in its root)
  //
  // Body slots no longer exist as targets. Items go into groups.
  function smartDefaultTarget(it) {
    const inv = ensureInventory();
    const topLevel = inv.groups || [];

    const customGroups = topLevel.filter(g => g.kind === 'custom');
    const stowed = customGroups.find(g => (g.name || '').trim().toLowerCase() === 'stowed');
    if (stowed) return { kind: 'group', id: stowed.id };
    if (customGroups.length > 0) return { kind: 'group', id: customGroups[0].id };

    // Fall back to On-Person's root (not any subgroup — user's choice
    // to subdivide further is respected). On-Person is guaranteed to
    // exist via ensureInventory.
    const onPerson = topLevel.find(g => g.kind === 'onPerson');
    if (onPerson) return { kind: 'group', id: onPerson.id };

    // Extreme edge case — no groups at all. Ask for a new group to be
    // created so the item has somewhere to live.
    return { kind: 'newGroup' };
  }

  // Render the Add-target dropdown menu for an item. Lists every group
  // and subgroup in the tree (indented), plus every container as a
  // nested target. Body slots no longer exist.
  function renderCatalogAddMenu(it) {
    const inv = ensureInventory();

    let html = `<div class="cat-view-add-menu">`;
    html += `<div class="cat-view-add-menu-label">Add to:</div>`;

    // Groups tree — walk every top-level group (On-Person + any custom
    // ones) and recurse into subgroups. Each level gets an indent marker
    // (a chevron-prefix) so the hierarchy reads correctly even inside a
    // flat dropdown.
    const topLevel = inv.groups || [];
    if (topLevel.length > 0) {
      html += `<div class="cat-view-add-menu-section">Groups</div>`;
      const walk = (nodes, depth) => {
        nodes.forEach(node => {
          if (!node || !isGroupNode(node)) return;
          const indent = depth === 0 ? '' : '&nbsp;'.repeat(depth * 3) + '└ ';
          html += `<div class="cat-view-add-menu-opt" onclick="event.stopPropagation();invCatalogAddTo('${escapeHtml(it.id)}','group','${escapeHtml(node.id)}')">${indent}${escapeHtml(node.name)}</div>`;
          if (Array.isArray(node.contents)) walk(node.contents, depth + 1);
        });
      };
      walk(topLevel, 0);
    }

    // Existing containers — find every container in the inventory tree
    // and offer it as a nested target. Names include the container's
    // position for disambiguation.
    const containerTargets = collectContainerTargets();
    if (containerTargets.length > 0) {
      html += `<div class="cat-view-add-menu-section">Inside Container</div>`;
      containerTargets.forEach(c => {
        html += `<div class="cat-view-add-menu-opt" onclick="event.stopPropagation();invCatalogAddTo('${escapeHtml(it.id)}','container','${escapeHtml(c.id)}')">${escapeHtml(c.label)}</div>`;
      });
    }

    html += `<div class="cat-view-add-menu-divider"></div>`;
    html += `<div class="cat-view-add-menu-opt cat-view-add-menu-opt-new" onclick="event.stopPropagation();invCatalogAddToNewGroup('${escapeHtml(it.id)}')">+ Create new group…</div>`;

    html += `</div>`;
    return html;
  }

  // Walk the full group tree and collect every container entry as a
  // dropdown-ready target. Labels include the ancestor context so
  // identical container names in different groups are disambiguated.
  function collectContainerTargets() {
    const inv = ensureInventory();
    const results = [];
    const visit = (arr, ancestorLabel) => {
      if (!Array.isArray(arr)) return;
      arr.forEach(node => {
        if (!node || typeof node !== 'object') return;
        if (isGroupNode(node)) {
          // Subgroup — recurse, using the subgroup's name as the new
          // ancestor context.
          visit(node.contents, node.name);
        } else if (entryIsContainer(node)) {
          const name = entryName(node);
          const label = ancestorLabel ? `${name} · in ${ancestorLabel}` : name;
          results.push({ id: node.id, label });
          visit(node.contents, name);
        }
      });
    };
    (inv.groups || []).forEach(g => visit(g.contents, g.name));
    return results;
  }

  // ─── TALLY HELPERS ───
  //
  // Recursively sum weight and item counts for a given scope. Weight
  // flows all the way up — a pouch inside a backpack inside a trunk
  // contributes to all three tallies.

  function tallyEntry(entry) {
    // Weight comes from the entry's snapshot (the post-Turn-A source of
    // truth). Reading from the def would miss:
    //   1. One-off custom items (defId is null; no def to read)
    //   2. Edited entries whose snapshot diverged from the def
    //   3. Entries whose def was deleted from the catalogue
    // entryWeight() handles all three — falls through from snapshot to
    // def to zero.
    const qty = entry.quantity || 1;
    let weight = entryWeight(entry) * qty;
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

  // Sum weight and item count across a contents array. The array may
  // contain entries (counted via tallyEntry) AND subgroups (recursed
  // into — groups themselves contribute zero but their contents roll
  // up). Used for group headers across all nesting levels.
  function tallyArr(arr) {
    let totalWeight = 0;
    let totalCount = 0;
    (arr || []).forEach(node => {
      if (!node || typeof node !== 'object') return;
      if (isGroupNode(node)) {
        // Subgroup — recurse. Groups themselves have no weight / aren't
        // counted as items; their contents contribute.
        const t = tallyArr(node.contents || []);
        totalWeight += t.totalWeight;
        totalCount += t.totalCount;
      } else {
        const t = tallyEntry(node);
        totalWeight += t.weight;
        totalCount += t.count;
      }
    });
    return { totalWeight, totalCount };
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
    // Post-snapshot, we can render an entry even when its def is gone
    // from the ruleset/customDefs — the snapshot carries all the
    // display data. Only fall back to the placeholder if we have
    // literally no snapshot AND no def (shouldn't happen after
    // ensureInventory has run, but defensive).
    const def = getDefForEntry(entry);
    const snap = entry.snapshot;
    if (!def && !snap) {
      return `<div class="inv-entry inv-entry-missing" style="margin-left:${depth * 16}px">
        <span class="inv-entry-name">(no data: ${escapeHtml(entry.defId || '')})</span>
        ${canEdit ? `<button class="inv-row-btn" onclick="invRemoveEntry('${escapeHtml(entry.id)}')">Remove</button>` : ''}
      </div>`;
    }

    const open = expandedEntries.has(entry.id);
    const stats = computeContainerStats(entry);
    const spec = innerSpec(entry);
    const dims = (spec && spec.dimensions) || { l: 0, w: 0, h: 0 };
    const name = entryName(entry);
    // Outer dimensions come from the entry's own snapshot — this lets
    // in-sheet edits change just this instance's size without touching
    // other instances of the same def.
    const outerDims = entryDimensions(entry);
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

    const isEditing = editingEntryId === entry.id;

    let html = `<div class="inv-entry inv-entry-container${open ? ' open' : ''}${isEditing ? ' editing' : ''}" style="margin-left:${depth * 16}px">
      <div class="inv-entry-head" onclick="invToggleEntry('${escapeHtml(entry.id)}')">
        <span class="inv-entry-caret">${open ? '▾' : '▸'}</span>
        <span class="inv-entry-icon" title="Container">▣</span>
        <span class="inv-entry-name">${escapeHtml(name)}</span>
        <span class="inv-entry-dims">${fmt(outerDims.l)}×${fmt(outerDims.w)}×${fmt(outerDims.h)} in</span>
        <span class="inv-entry-capacity" title="${escapeHtml(capTip)}">${fmt(stats.usedVolume)}/${fmt(stats.availableVolume)} in³ (${pct}%)</span>
        <span class="inv-entry-weight">${fmt(stats.totalWeight)} lb</span>
        ${badge}
        ${canEdit ? `<button class="inv-row-btn inv-row-btn-edit" onclick="event.stopPropagation();invOpenEntryEdit('${escapeHtml(entry.id)}')" title="Edit this instance (changes only this one, not the template).">✎</button>` : ''}
        ${canEdit ? `<button class="inv-row-btn inv-row-btn-danger" onclick="event.stopPropagation();invRemoveEntry('${escapeHtml(entry.id)}')" title="Remove this container (and everything inside)">×</button>` : ''}
      </div>`;

    // Inline edit panel for this container. Renders between the head
    // and the contents body so the user can see their container stay
    // in place while tweaking its fields. The panel is wide enough to
    // hold L×W×H rows and a description field.
    if (isEditing) {
      html += renderEntryEditPanel(entry, /*asContainer=*/true, depth);
    }

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
    // Post-snapshot, we can render even with no def. Placeholder only
    // fires in pathological cases (no snapshot AND no def).
    const def = getDefForEntry(entry);
    const snap = entry.snapshot;
    if (!def && !snap) {
      return `<div class="inv-entry inv-entry-missing" style="margin-left:${depth * 16}px">
        <span class="inv-entry-name">(no data: ${escapeHtml(entry.defId || '')})</span>
        ${canEdit ? `<button class="inv-row-btn" onclick="invRemoveEntry('${escapeHtml(entry.id)}')">Remove</button>` : ''}
      </div>`;
    }

    const name = entryName(entry);
    const dims = entryDimensions(entry);
    const qty = entry.quantity || 1;
    const totalWeight = entryWeight(entry) * qty;
    // Legacy category string — only ruleset items carry this.
    // Prefer snapshot's copy, fall back to def.category for very old
    // pre-snapshot data.
    const legacyCat = (snap && snap.legacyCategory) || (def && def.category) || '';
    const catLabel = legacyCat ? ` · ${legacyCat}` : '';
    const description = entryDescription(entry);
    const hasInfo = !!((description && description.trim()) || (entry.notes && entry.notes.trim()));
    const infoOpen = expandedInfo.has(entry.id);

    // Hover tooltip: first ~80 chars of description as a title attribute
    // on the name. Full description shows when the row is clicked.
    const tooltip = hasInfo
      ? escapeHtml(truncate((description || entry.notes || '').replace(/\s+/g, ' ').trim(), 80))
      : '';
    // If there's info to show, the name is clickable to toggle the
    // expanded panel. If not, the row is purely informational.
    const nameAttrs = hasInfo
      ? ` class="inv-entry-name inv-entry-name-clickable" title="${tooltip}" onclick="invToggleItemInfo('${escapeHtml(entry.id)}')"`
      : ` class="inv-entry-name"`;

    const isEditing = editingEntryId === entry.id;

    let html = `<div class="inv-entry inv-entry-item${infoOpen ? ' info-open' : ''}${isEditing ? ' editing' : ''}" style="margin-left:${depth * 16}px">
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
        ${canEdit ? `<button class="inv-row-btn inv-row-btn-edit" onclick="invOpenEntryEdit('${escapeHtml(entry.id)}')" title="Edit this instance (changes only this one, not the template).">✎</button>` : ''}
        ${canEdit ? `<button class="inv-row-btn inv-row-btn-danger" onclick="invRemoveEntry('${escapeHtml(entry.id)}')" title="Remove this item">×</button>` : ''}
      </div>`;

    // Inline edit panel for plain items — simpler than the container
    // version (no inner dims / packing fields).
    if (isEditing) {
      html += renderEntryEditPanel(entry, /*asContainer=*/false, depth);
    }

    if (infoOpen && hasInfo) {
      const desc = (description || '').trim();
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

  // ─── INLINE ENTRY EDIT ───
  //
  // Per-instance edit panel that tweaks the entry's snapshot. The def
  // is never touched — edits stay local to this one entry. The panel
  // renders inline (not as a modal) between the entry's head row and
  // its contents, so the user can see their container's new dimensions
  // affect its capacity math live.
  //
  // Flow:
  //   • User clicks ✎ → openEntryEdit(id) copies snapshot into editDraft
  //   • User types → updateEditDraft(field, value) mutates draft
  //   • User clicks Save → saveEntryEdit writes draft back to snapshot + persists
  //   • User clicks Cancel → cancelEntryEdit discards draft, closes panel

  function renderEntryEditPanel(entry, asContainer, depth) {
    if (!editDraft) return '';
    const d = editDraft;
    // Indentation lines up with the entry body so the panel reads as
    // belonging to the entry above it.
    const margin = (depth + 1) * 16;

    let html = `<div class="inv-edit-panel" style="margin-left:${margin}px" onclick="event.stopPropagation()">
      <div class="inv-edit-panel-title">Edit this ${asContainer ? 'container' : 'item'} <span class="inv-edit-panel-hint">— changes apply only to this instance</span></div>

      <div class="inv-field">
        <label>Name</label>
        <input type="text" value="${escapeHtml(d.name || '')}" oninput="invUpdateEditDraft('name',this.value)" placeholder="e.g. Duffel Bag">
      </div>

      <div class="inv-field">
        <label>Description</label>
        <textarea rows="2" oninput="invUpdateEditDraft('description',this.value)" placeholder="Optional — notes, flavor text, condition.">${escapeHtml(d.description || '')}</textarea>
      </div>

      <div class="inv-pair-row">
        <div class="inv-field">
          <label>Weight (lbs)</label>
          <input type="number" step="0.1" min="0" value="${escapeHtml(String(d.weight || 0))}" oninput="invUpdateEditDraft('weight',this.value)">
        </div>
        <div class="inv-field">
          <label>Dimensions (L × W × H, inches)</label>
          <div class="inv-dims-row">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.l || 0))}" placeholder="L" oninput="invUpdateEditDraft('l',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.w || 0))}" placeholder="W" oninput="invUpdateEditDraft('w',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.h || 0))}" placeholder="H" oninput="invUpdateEditDraft('h',this.value)">
          </div>
        </div>
      </div>`;

    // Container-only fields: inner dimensions + packing efficiency.
    // These live in snapshot.containerOf.
    if (asContainer) {
      html += `<div class="inv-container-block">
        <div class="inv-container-block-title">Container Capacity</div>
        <div class="inv-field">
          <label>Inner Dimensions (L × W × H, inches)</label>
          <div class="inv-dims-row">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerL || 0))}" placeholder="L" oninput="invUpdateEditDraft('innerL',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerW || 0))}" placeholder="W" oninput="invUpdateEditDraft('innerW',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerH || 0))}" placeholder="H" oninput="invUpdateEditDraft('innerH',this.value)">
          </div>
        </div>
        <div class="inv-field" style="max-width:260px">
          <label title="Fraction of the inner L×W×H volume that can actually hold items.">Packing Efficiency (0.1 – 1.0)</label>
          <input type="number" step="0.05" min="0.1" max="1.0" value="${escapeHtml(String(d.innerPacking != null ? d.innerPacking : 0.75))}" oninput="invUpdateEditDraft('innerPacking',this.value)">
          <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">1.0 = fitted case · 0.75 = typical bag · 0.5 = loose sack</div>
        </div>
      </div>`;
    }

    html += `<div class="inv-edit-panel-actions">
      <button class="inv-add-btn" onclick="invSaveEntryEdit()">Save</button>
      <button class="inv-add-btn inv-add-btn-ghost" onclick="invCancelEntryEdit()">Cancel</button>
      <button class="inv-add-btn inv-add-btn-promote" onclick="invPromoteEntryToCatalogue()" title="Copy this instance's current fields (name, dimensions, weight, description, capacity) into your personal catalogue as a reusable template. Does not modify this instance.">Save to Personal Catalogue</button>
    </div>`;

    html += `</div>`;
    return html;
  }

  // Open the edit panel for a given entry. Copies the entry's snapshot
  // into a draft object so the user can tweak without mutating the
  // persisted data until Save is clicked.
  function openEntryEdit(entryId) {
    if (!getCanEdit()) return;
    const entry = findEntry(entryId);
    if (!entry) return;
    const snap = entrySnapshot(entry);
    const isContainer = entryIsContainer(entry);
    const dims = snap.dimensions || { l: 0, w: 0, h: 0 };
    const innerDims = (snap.containerOf && snap.containerOf.dimensions) || { l: 0, w: 0, h: 0 };
    editDraft = {
      name:         snap.name || '',
      description:  snap.description || '',
      weight:       snap.weight || 0,
      l:            dims.l || 0,
      w:            dims.w || 0,
      h:            dims.h || 0,
      isContainer,
      innerL:       innerDims.l || 0,
      innerW:       innerDims.w || 0,
      innerH:       innerDims.h || 0,
      innerPacking: (snap.containerOf && Number.isFinite(snap.containerOf.packingEfficiency))
        ? snap.containerOf.packingEfficiency
        : 0.75
    };
    editingEntryId = entryId;
    renderAll();
  }

  // Patch a single field in the edit draft as the user types. Numeric
  // fields get coerced; text fields pass through. Does NOT re-render —
  // the inputs are self-managing and re-rendering would steal focus.
  function updateEditDraft(field, value) {
    if (!editDraft) return;
    const numericFields = new Set(['weight','l','w','h','innerL','innerW','innerH','innerPacking']);
    if (numericFields.has(field)) {
      const n = parseFloat(value);
      editDraft[field] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else {
      editDraft[field] = typeof value === 'string' ? value : '';
    }
  }

  // Commit the draft back to the entry's snapshot and save.
  async function saveEntryEdit() {
    if (!editDraft || !editingEntryId) return;
    const entry = findEntry(editingEntryId);
    if (!entry) { cancelEntryEdit(); return; }
    const d = editDraft;

    // Build the new snapshot from the draft. containerOf is included
    // only when the entry was already a container (we don't promote/
    // demote container-ness from the inline edit panel — that's too
    // surprising a change to make here; user should remove and re-add).
    const newSnapshot = {
      name:           (d.name || '').trim() || '(unnamed)',
      description:    (d.description || '').trim(),
      dimensions:     { l: d.l || 0, w: d.w || 0, h: d.h || 0 },
      weight:         d.weight || 0,
      containerOf:    d.isContainer ? {
        dimensions:        { l: d.innerL || 0, w: d.innerW || 0, h: d.innerH || 0 },
        packingEfficiency: clampEff(d.innerPacking, 0.75)
      } : null,
      legacyCategory: (entry.snapshot && entry.snapshot.legacyCategory) || ''
    };
    entry.snapshot = newSnapshot;

    editingEntryId = null;
    editDraft = null;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Discard the draft and close the panel. No save call.
  function cancelEntryEdit() {
    editingEntryId = null;
    editDraft = null;
    renderAll();
  }

  // "Save to Personal Catalogue" — copies the entry's CURRENT snapshot
  // into a new catalog def so the user can pick it again later from
  // the Add Container / Add Item modals. The entry on the sheet is
  // NOT modified — it stays a free-standing instance with its own
  // snapshot. The catalog def gets a fresh id; if a def with the same
  // name already exists, we warn so the user doesn't accidentally
  // shadow their existing one.
  //
  // Uses the current edit draft if the panel is open (so edits-in-flight
  // get promoted too). If no panel is open, uses the entry's snapshot
  // as-is. Either way, the promotion is just a copy — the entry's
  // defId is not rewritten to point at the new catalog def. That keeps
  // the mental model simple: "catalog is templates for future picks;
  // existing instances are self-contained."
  async function promoteEntryToCatalogue() {
    if (!getCanEdit()) return;
    if (!editingEntryId) return;
    const entry = findEntry(editingEntryId);
    if (!entry) return;

    // Source the snapshot data from the current draft (edits-in-flight
    // should propagate) OR the entry's stored snapshot as a fallback.
    const source = editDraft || null;
    const snap = entry.snapshot || {};

    const name = (source ? source.name : snap.name || '').trim();
    if (!name) { alert('Please enter a name before saving to the catalogue.'); return; }

    const inv = ensureInventory();

    // Duplicate-name check across both custom buckets. Warns rather
    // than blocks — user might genuinely want two "Rifle Case" defs
    // (e.g. short and long versions). Confirm lets them proceed.
    const existingNames = [
      ...(inv.customDefs.containers || []).map(x => (x.name || '').toLowerCase()),
      ...(inv.customDefs.equipment  || []).map(x => (x.name || '').toLowerCase())
    ];
    if (existingNames.includes(name.toLowerCase())) {
      if (!confirm(`A catalogue entry named "${name}" already exists. Save another copy anyway?`)) return;
    }

    // Build the def fields from the draft (if present) or snapshot.
    const dims = source
      ? { l: source.l || 0, w: source.w || 0, h: source.h || 0 }
      : (snap.dimensions || { l: 0, w: 0, h: 0 });
    const weight = source ? (source.weight || 0) : (snap.weight || 0);
    const description = (source ? source.description : snap.description || '').trim();
    const isContainer = !!(snap.containerOf || (source && source.isContainer));

    // Inner-container fields: prefer the draft, fall back to snapshot.
    const innerDims = source
      ? { l: source.innerL || 0, w: source.innerW || 0, h: source.innerH || 0 }
      : ((snap.containerOf && snap.containerOf.dimensions) || { l: 0, w: 0, h: 0 });
    const innerPacking = source
      ? clampEff(source.innerPacking, 0.75)
      : ((snap.containerOf && Number.isFinite(snap.containerOf.packingEfficiency)) ? snap.containerOf.packingEfficiency : 0.75);

    let def;
    if (isContainer) {
      // Legacy container schema — top-level packingEfficiency, dimensions
      // represent inner capacity. Matches the shape other custom
      // containers use on this character.
      def = {
        id: _nextInvId('cust_cont'),
        name,
        description,
        dimensions: { l: innerDims.l || dims.l || 0, w: innerDims.w || dims.w || 0, h: innerDims.h || dims.h || 0 },
        weight,
        packingEfficiency: innerPacking
      };
      inv.customDefs.containers.push(def);
    } else {
      def = {
        id: _nextInvId('cust_eq'),
        name,
        description,
        dimensions: dims,
        weight,
        category: '',
        weaponId: null,
        containerOf: null
      };
      inv.customDefs.equipment.push(def);
    }

    // Ephemeral toast-style confirmation via the catalog-add toast
    // mechanism (already wired to fade after 3s). Keeps the feedback
    // loop short.
    lastAddToast = `Saved "${name}" to your personal catalogue.`;
    renderAll();
    setTimeout(() => {
      if (lastAddToast && lastAddToast.startsWith('Saved "')) {
        lastAddToast = null;
        renderAll();
      }
    }, 3000);

    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // ─── PERSONAL CATALOGUE MANAGER ───
  //
  // Standalone modal for CRUD on the character's custom defs. Opened
  // from the inventory tab header. Separate from the Add Container/Add
  // Item picker flow — creating a def here does NOT place it on the
  // sheet. That keeps the two flows mentally distinct:
  //
  //   • Picker's + Custom: "I need this thing, and it's going HERE"
  //   • Manager:           "I'm building my catalogue, no placement yet"

  function renderCatalogManager() {
    const root = document.getElementById('inv-catalog-manager-root');
    if (!root) return;
    if (!catalogManager.open) { root.innerHTML = ''; return; }

    const inv = ensureInventory();
    const containers = (inv.customDefs.containers || []);
    const equipment  = (inv.customDefs.equipment  || []);
    const total = containers.length + equipment.length;

    let body = '';
    if (total === 0 && !catalogManager.newDraft) {
      body = `<div class="inv-cat-mgr-empty">
        Your personal catalogue is empty. Create one-off items and containers that only exist on this character — they won't appear on other characters' sheets or in the shared ruleset.
      </div>`;
    }

    // New-def inline form at the top if the user clicked + New X.
    if (catalogManager.newDraft) {
      body += renderCatalogManagerNewForm();
    }

    // Containers section
    if (containers.length > 0) {
      body += `<div class="inv-cat-mgr-section-label">Containers <span class="inv-cat-mgr-section-count">${containers.length}</span></div>`;
      body += containers.map(def => renderCatalogManagerRow(def, 'container')).join('');
    }

    // Equipment section
    if (equipment.length > 0) {
      body += `<div class="inv-cat-mgr-section-label">Items <span class="inv-cat-mgr-section-count">${equipment.length}</span></div>`;
      body += equipment.map(def => renderCatalogManagerRow(def, 'equipment')).join('');
    }

    const addRow = `<div class="inv-manage-add-row">
      <button class="inv-add-btn" onclick="invCatMgrStartNew('container')">+ New Container</button>
      <button class="inv-add-btn inv-add-btn-ghost" onclick="invCatMgrStartNew('equipment')">+ New Item</button>
      <span class="inv-manage-add-hint">New defs land here in your personal catalogue — they don't appear on your sheet until you add them through the normal flow.</span>
    </div>`;

    root.innerHTML = `<div class="inv-modal-backdrop" onclick="invCatMgrCloseIfBackdrop(event)">
      <div class="inv-modal inv-modal-manage" onclick="event.stopPropagation()">
        <div class="inv-modal-head">
          <div class="inv-modal-title">Personal Catalogue</div>
          <div class="inv-modal-sub">One-off items and containers for this character only.</div>
          <button class="inv-modal-close" onclick="invCatMgrClose()">×</button>
        </div>
        <div class="inv-modal-body">
          ${body}
          ${addRow}
        </div>
      </div>
    </div>`;
  }

  // Render one row in the manager. Collapsed shows summary (name, dims,
  // weight, container pill, delete ×). Expanded shows the full edit
  // form (same fields as renderEntryEditPanel but targeting the def
  // directly instead of a snapshot).
  function renderCatalogManagerRow(def, defKind) {
    const isContainer = defKind === 'container' || (defKind === 'equipment' && !!def.containerOf);
    const expanded = catalogManager.expandedDefIds.has(def.id);
    const dims = def.dimensions || { l: 0, w: 0, h: 0 };
    const weight = def.weight || 0;
    const containerPill = isContainer ? '<span class="inv-cat-mgr-container-pill">container</span>' : '';
    const dualPill = (defKind === 'equipment' && def.containerOf) ? '<span class="inv-modal-dual">dual-role</span>' : '';
    // Reference count — how many instances of this def exist on the
    // sheet. Shown as a pill so the user knows editing the def could
    // conceptually affect N rows (but post-snapshot, it doesn't — only
    // NEW placements use the current def fields).
    let refCount = 0;
    walkTree(e => { if (e.defId === def.id) refCount++; });
    const refPill = refCount > 0 ? `<span class="inv-cat-mgr-ref-pill" title="${refCount} instance${refCount === 1 ? '' : 's'} of this def currently on the sheet. Existing instances keep their own snapshot data — edits here only affect NEW placements from the picker.">${refCount} on sheet</span>` : '';

    let html = `<div class="inv-manage-card${expanded ? ' open' : ''}">
      <div class="inv-manage-card-head" onclick="invCatMgrToggleRow('${escapeHtml(def.id)}')">
        <span class="inv-manage-card-caret">${expanded ? '▾' : '▸'}</span>
        <span class="inv-manage-card-name">${escapeHtml(def.name || '(unnamed)')}</span>
        ${containerPill}
        ${dualPill}
        ${refPill}
        <span class="inv-manage-card-dims">${fmt(dims.l)}×${fmt(dims.w)}×${fmt(dims.h)} in</span>
        <span class="inv-manage-card-weight">${fmt(weight)} lb</span>
        <button class="inv-row-btn inv-row-btn-danger" onclick="event.stopPropagation();invCatMgrDelete('${escapeHtml(defKind)}','${escapeHtml(def.id)}')" title="Delete this def from your personal catalogue. Existing sheet instances are preserved.">×</button>
      </div>`;

    if (expanded) {
      html += renderCatalogManagerEditForm(def, defKind);
    }
    html += `</div>`;
    return html;
  }

  // Inline edit form for an existing def in the manager. Mirrors the
  // custom-def form from the picker flow but without the auto-place
  // step — save writes the def, that's it.
  function renderCatalogManagerEditForm(def, defKind) {
    // Seed the draft if not already present. Pattern: edit is always
    // against a working draft; save copies draft → def.
    if (!catalogManager.drafts.has(def.id)) {
      seedCatalogManagerDraft(def, defKind);
    }
    const d = catalogManager.drafts.get(def.id);
    const isContainer = defKind === 'container';
    const isDualCapable = defKind === 'equipment';
    const hasContainerBlock = isContainer || (isDualCapable && d.alsoContainer);

    let html = `<div class="inv-manage-card-body">
      <div class="inv-field">
        <label>Name</label>
        <input type="text" value="${escapeHtml(d.name || '')}" oninput="invCatMgrDraft('${escapeHtml(def.id)}','name',this.value)" placeholder="e.g. My Heirloom Knife">
      </div>

      <div class="inv-field">
        <label>Description</label>
        <textarea rows="2" oninput="invCatMgrDraft('${escapeHtml(def.id)}','description',this.value)" placeholder="Optional — flavor text, special properties, condition.">${escapeHtml(d.description || '')}</textarea>
      </div>

      <div class="inv-pair-row">
        <div class="inv-field">
          <label>Weight (lbs)</label>
          <input type="number" step="0.1" min="0" value="${escapeHtml(String(d.weight || 0))}" oninput="invCatMgrDraft('${escapeHtml(def.id)}','weight',this.value)">
        </div>
        <div class="inv-field">
          <label>Dimensions (L × W × H, inches)</label>
          <div class="inv-dims-row">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.l || 0))}" placeholder="L" oninput="invCatMgrDraft('${escapeHtml(def.id)}','l',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.w || 0))}" placeholder="W" oninput="invCatMgrDraft('${escapeHtml(def.id)}','w',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.h || 0))}" placeholder="H" oninput="invCatMgrDraft('${escapeHtml(def.id)}','h',this.value)">
          </div>
        </div>
      </div>`;

    // Dual-role toggle — only shown for equipment (container defs are
    // always containers; converting requires delete + recreate).
    if (isDualCapable) {
      html += `<div class="inv-toggle-row">
        <span class="inv-toggle${d.alsoContainer ? ' on' : ''}" onclick="invCatMgrDraft('${escapeHtml(def.id)}','alsoContainer',${!d.alsoContainer})">${d.alsoContainer ? '✓ Also a container' : 'Also a container'}</span>
        <span class="inv-toggle-hint">Turn on to let this item hold other items (backpacks, pouches, holsters).</span>
      </div>`;
    }

    if (hasContainerBlock) {
      html += `<div class="inv-container-block">
        <div class="inv-container-block-title">Container Capacity</div>
        <div class="inv-field">
          <label>Inner Dimensions (L × W × H, inches)</label>
          <div class="inv-dims-row">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerL || 0))}" placeholder="L" oninput="invCatMgrDraft('${escapeHtml(def.id)}','innerL',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerW || 0))}" placeholder="W" oninput="invCatMgrDraft('${escapeHtml(def.id)}','innerW',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerH || 0))}" placeholder="H" oninput="invCatMgrDraft('${escapeHtml(def.id)}','innerH',this.value)">
          </div>
        </div>
        <div class="inv-field" style="max-width:260px">
          <label title="Fraction of the inner L×W×H volume that can actually hold items.">Packing Efficiency (0.1 – 1.0)</label>
          <input type="number" step="0.05" min="0.1" max="1.0" value="${escapeHtml(String(d.innerPacking != null ? d.innerPacking : 0.75))}" oninput="invCatMgrDraft('${escapeHtml(def.id)}','innerPacking',this.value)">
          <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">1.0 = fitted case · 0.75 = typical bag · 0.5 = loose sack</div>
        </div>
      </div>`;
    }

    html += `<div class="inv-edit-panel-actions">
      <button class="inv-add-btn" onclick="invCatMgrSaveEdit('${escapeHtml(defKind)}','${escapeHtml(def.id)}')">Save Changes</button>
      <button class="inv-add-btn inv-add-btn-ghost" onclick="invCatMgrCollapseRow('${escapeHtml(def.id)}')">Cancel</button>
    </div>`;

    html += `</div>`;
    return html;
  }

  // Render the inline form for creating a new def. Appears at the top
  // of the modal when the user clicks + New Container / + New Item.
  function renderCatalogManagerNewForm() {
    const d = catalogManager.newDraft;
    const kind = catalogManager.newKind;
    const isContainer = kind === 'container';
    const isDualCapable = kind === 'equipment';
    const hasContainerBlock = isContainer || (isDualCapable && d.alsoContainer);
    const title = isContainer ? 'New Container' : 'New Item';

    let html = `<div class="inv-cat-mgr-new-form">
      <div class="inv-cat-mgr-new-title">${escapeHtml(title)}</div>

      <div class="inv-field">
        <label>Name</label>
        <input type="text" value="${escapeHtml(d.name || '')}" oninput="invCatMgrNewDraft('name',this.value)" placeholder="e.g. ${isContainer ? 'Leather Satchel' : 'Lockpicks'}" autofocus>
      </div>

      <div class="inv-field">
        <label>Description</label>
        <textarea rows="2" oninput="invCatMgrNewDraft('description',this.value)" placeholder="Optional — flavor text, special properties.">${escapeHtml(d.description || '')}</textarea>
      </div>

      <div class="inv-pair-row">
        <div class="inv-field">
          <label>Weight (lbs)</label>
          <input type="number" step="0.1" min="0" value="${escapeHtml(String(d.weight || 0))}" oninput="invCatMgrNewDraft('weight',this.value)">
        </div>
        <div class="inv-field">
          <label>Dimensions (L × W × H, inches)</label>
          <div class="inv-dims-row">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.l || 0))}" placeholder="L" oninput="invCatMgrNewDraft('l',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.w || 0))}" placeholder="W" oninput="invCatMgrNewDraft('w',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.h || 0))}" placeholder="H" oninput="invCatMgrNewDraft('h',this.value)">
          </div>
        </div>
      </div>`;

    if (isDualCapable) {
      html += `<div class="inv-toggle-row">
        <span class="inv-toggle${d.alsoContainer ? ' on' : ''}" onclick="invCatMgrNewDraft('alsoContainer',${!d.alsoContainer})">${d.alsoContainer ? '✓ Also a container' : 'Also a container'}</span>
        <span class="inv-toggle-hint">Turn on to let this item hold other items.</span>
      </div>`;
    }

    if (hasContainerBlock) {
      html += `<div class="inv-container-block">
        <div class="inv-container-block-title">Container Capacity</div>
        <div class="inv-field">
          <label>Inner Dimensions (L × W × H, inches)</label>
          <div class="inv-dims-row">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerL || 0))}" placeholder="L" oninput="invCatMgrNewDraft('innerL',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerW || 0))}" placeholder="W" oninput="invCatMgrNewDraft('innerW',this.value)">
            <input type="number" step="0.25" min="0" value="${escapeHtml(String(d.innerH || 0))}" placeholder="H" oninput="invCatMgrNewDraft('innerH',this.value)">
          </div>
        </div>
        <div class="inv-field" style="max-width:260px">
          <label>Packing Efficiency (0.1 – 1.0)</label>
          <input type="number" step="0.05" min="0.1" max="1.0" value="${escapeHtml(String(d.innerPacking != null ? d.innerPacking : 0.75))}" oninput="invCatMgrNewDraft('innerPacking',this.value)">
          <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">1.0 = fitted case · 0.75 = typical bag · 0.5 = loose sack</div>
        </div>
      </div>`;
    }

    html += `<div class="inv-edit-panel-actions">
      <button class="inv-add-btn" onclick="invCatMgrSaveNew()">Save to Catalogue</button>
      <button class="inv-add-btn inv-add-btn-ghost" onclick="invCatMgrCancelNew()">Cancel</button>
    </div>`;

    html += `</div>`;
    return html;
  }

  // Seed a draft object from an existing def. Copies all the editable
  // fields into a flat shape the form can bind to.
  function seedCatalogManagerDraft(def, defKind) {
    const dims = def.dimensions || { l: 0, w: 0, h: 0 };
    // Container defs carry packingEfficiency at top level (legacy
    // schema) AND may have a containerOf block (post-unification).
    // Equipment defs use containerOf only. We support both.
    let innerDims = { l: 0, w: 0, h: 0 };
    let innerPacking = 0.75;
    let alsoContainer = false;
    if (defKind === 'container') {
      if (def.containerOf) {
        innerDims = def.containerOf.dimensions || dims;
        innerPacking = Number.isFinite(def.containerOf.packingEfficiency) ? def.containerOf.packingEfficiency : 0.75;
      } else {
        innerDims = dims;
        innerPacking = Number.isFinite(def.packingEfficiency) ? def.packingEfficiency : 0.75;
      }
    } else if (def.containerOf) {
      alsoContainer = true;
      innerDims = def.containerOf.dimensions || { l: 0, w: 0, h: 0 };
      innerPacking = Number.isFinite(def.containerOf.packingEfficiency) ? def.containerOf.packingEfficiency : 0.75;
    }
    catalogManager.drafts.set(def.id, {
      name:         def.name || '',
      description:  def.description || '',
      weight:       def.weight || 0,
      l:            dims.l || 0,
      w:            dims.w || 0,
      h:            dims.h || 0,
      alsoContainer,
      innerL:       innerDims.l || 0,
      innerW:       innerDims.w || 0,
      innerH:       innerDims.h || 0,
      innerPacking
    });
  }

  // ── Handlers ──

  function openManageCatalog() {
    if (!getCanEdit()) return;
    catalogManager.open = true;
    catalogManager.expandedDefIds.clear();
    catalogManager.drafts.clear();
    catalogManager.newDraft = null;
    catalogManager.newKind = null;
    renderAll();
  }

  function catMgrClose() {
    catalogManager.open = false;
    catalogManager.expandedDefIds.clear();
    catalogManager.drafts.clear();
    catalogManager.newDraft = null;
    catalogManager.newKind = null;
    renderAll();
  }

  function catMgrCloseIfBackdrop(ev) {
    if (!ev || ev.target === ev.currentTarget) catMgrClose();
  }

  function catMgrToggleRow(defId) {
    if (catalogManager.expandedDefIds.has(defId)) {
      catalogManager.expandedDefIds.delete(defId);
      // Drop any pending draft when collapsing — matches the Cancel
      // behavior of the inline edit panel on the sheet.
      catalogManager.drafts.delete(defId);
    } else {
      // Only one row expanded at a time — keeps the UI focused and
      // avoids stale drafts piling up.
      catalogManager.expandedDefIds.clear();
      catalogManager.drafts.clear();
      catalogManager.expandedDefIds.add(defId);
    }
    renderCatalogManager();
  }

  function catMgrCollapseRow(defId) {
    catalogManager.expandedDefIds.delete(defId);
    catalogManager.drafts.delete(defId);
    renderCatalogManager();
  }

  // Update a single field in a per-def draft.
  function catMgrDraft(defId, field, value) {
    const d = catalogManager.drafts.get(defId);
    if (!d) return;
    const numericFields = new Set(['weight','l','w','h','innerL','innerW','innerH','innerPacking']);
    if (numericFields.has(field)) {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else if (field === 'alsoContainer') {
      d[field] = !!value;
      renderCatalogManager();   // show/hide container block
    } else {
      d[field] = typeof value === 'string' ? value : '';
    }
  }

  // Save the draft back to the def and persist.
  async function catMgrSaveEdit(defKind, defId) {
    const inv = ensureInventory();
    const bucket = defKind === 'container' ? inv.customDefs.containers : inv.customDefs.equipment;
    const def = bucket.find(x => x.id === defId);
    if (!def) return;
    const d = catalogManager.drafts.get(defId);
    if (!d) return;

    const name = (d.name || '').trim();
    if (!name) { alert('Please enter a name.'); return; }

    // Write back. Shape varies by kind — containers use legacy
    // packingEfficiency at top-level (matches how saveCustomDef creates
    // them); equipment uses containerOf block.
    def.name = name;
    def.description = (d.description || '').trim();
    def.dimensions = { l: d.l || 0, w: d.w || 0, h: d.h || 0 };
    def.weight = d.weight || 0;
    if (defKind === 'container') {
      def.packingEfficiency = clampEff(d.innerPacking, 0.75);
      // Legacy container defs use dimensions as inner dims. If the user
      // entered different innerDims, sync them back to dimensions so
      // the legacy schema stays coherent.
      def.dimensions = { l: d.innerL || d.l || 0, w: d.innerW || d.w || 0, h: d.innerH || d.h || 0 };
    } else {
      def.containerOf = d.alsoContainer ? {
        dimensions: { l: d.innerL || 0, w: d.innerW || 0, h: d.innerH || 0 },
        packingEfficiency: clampEff(d.innerPacking, 0.75)
      } : null;
    }

    // Drop the draft and close the row.
    catalogManager.drafts.delete(defId);
    catalogManager.expandedDefIds.delete(defId);
    renderCatalogManager();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Instance-preserving delete from the manager. Reuses the same
  // implementation as the picker modal's × — confirms, removes the
  // def, leaves sheet instances alone (their snapshots carry them).
  async function catMgrDelete(defKind, defId) {
    await deleteCustomDef(defKind, defId);
    // deleteCustomDef re-renders the picker modal (activeModal) which
    // isn't what's open here. Re-render the manager so the row drops.
    renderCatalogManager();
  }

  // Start the inline "new def" form at the top of the modal. kind
  // determines whether it's a container or equipment draft.
  function catMgrStartNew(kind) {
    catalogManager.newKind = kind;
    catalogManager.newDraft = {
      name: '',
      description: '',
      weight: 0,
      l: 0, w: 0, h: 0,
      alsoContainer: false,
      innerL: 0, innerW: 0, innerH: 0,
      innerPacking: 0.75
    };
    renderCatalogManager();
  }

  function catMgrCancelNew() {
    catalogManager.newDraft = null;
    catalogManager.newKind = null;
    renderCatalogManager();
  }

  function catMgrNewDraft(field, value) {
    const d = catalogManager.newDraft;
    if (!d) return;
    const numericFields = new Set(['weight','l','w','h','innerL','innerW','innerH','innerPacking']);
    if (numericFields.has(field)) {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else if (field === 'alsoContainer') {
      d[field] = !!value;
      renderCatalogManager();
    } else {
      d[field] = typeof value === 'string' ? value : '';
    }
  }

  // Commit the new-def draft to the customDefs bucket. Does NOT
  // instantiate on the sheet — the manager is about catalog CRUD, not
  // placement.
  async function catMgrSaveNew() {
    const d = catalogManager.newDraft;
    const kind = catalogManager.newKind;
    if (!d || !kind) return;
    const name = (d.name || '').trim();
    if (!name) { alert('Please enter a name.'); return; }
    const inv = ensureInventory();

    let def;
    if (kind === 'container') {
      def = {
        id: _nextInvId('cust_cont'),
        name,
        description: (d.description || '').trim(),
        dimensions: { l: d.l || 0, w: d.w || 0, h: d.h || 0 },
        weight: d.weight || 0,
        packingEfficiency: clampEff(d.innerPacking, 0.75)
      };
      // Container dimensions double as inner dims in the legacy schema.
      // If the user entered different innerDims, prefer those.
      if (d.innerL || d.innerW || d.innerH) {
        def.dimensions = { l: d.innerL || d.l || 0, w: d.innerW || d.w || 0, h: d.innerH || d.h || 0 };
      }
      inv.customDefs.containers.push(def);
    } else {
      def = {
        id: _nextInvId('cust_eq'),
        name,
        description: (d.description || '').trim(),
        dimensions: { l: d.l || 0, w: d.w || 0, h: d.h || 0 },
        weight: d.weight || 0,
        category: '',
        weaponId: null,
        containerOf: d.alsoContainer ? {
          dimensions: { l: d.innerL || 0, w: d.innerW || 0, h: d.innerH || 0 },
          packingEfficiency: clampEff(d.innerPacking, 0.75)
        } : null
      };
      inv.customDefs.equipment.push(def);
    }

    catalogManager.newDraft = null;
    catalogManager.newKind = null;
    renderCatalogManager();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
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
      // Containers only. Use the `kind` field we assigned when
      // collecting allDefs — it's already normalized across both
      // legacy (top-level packingEfficiency, no containerOf block)
      // and unified (containerOf block) def shapes. Checking
      // o.def.containerOf directly would miss legacy custom container
      // defs, which live in customDefs.containers but carry their
      // packing data at the top level.
      const options = allDefs.filter(o => o.kind === 'container');
      root.innerHTML = renderModal({
        title: 'Add Container',
        subtitle: activeModal.targetLabel || '',
        options,
        emptyMsg: 'No containers in this ruleset yet. Use "+ Custom" below to make a one-off for this character, or open the ruleset editor\'s Inventory tab to add reusable ones.',
        onPickAttr: 'invPickContainerDef',
        customKind: 'container'
      });
    } else if (activeModal.kind === 'item') {
      // Items only. Same authoritative-kind rule as above — excluding
      // everything classified as 'container', whether that's a ruleset
      // item with containerOf, a custom equipment with containerOf
      // (dual-role), or a legacy custom container with top-level
      // packingEfficiency.
      const options = allDefs.filter(o => o.kind !== 'container');
      root.innerHTML = renderModal({
        title: 'Add Item',
        subtitle: activeModal.targetLabel || '',
        options,
        emptyMsg: 'No items in this ruleset yet. Use "+ Custom" below to make a one-off for this character, or open the ruleset editor\'s Inventory tab to add reusable ones.',
        onPickAttr: 'invPickItemDef',
        customKind: 'equipment'
      });
    }
  }

  function renderModal({ title, subtitle, options, emptyMsg, onPickAttr, customKind }) {
    // Split options into two visually-separate sections:
    //   • Personal Catalogue — character-scoped custom defs
    //   • Ruleset Catalogue  — defs from the shared ruleset
    // When both are empty, show the emptyMsg.
    const personal = options.filter(o => o.source === 'custom');
    const ruleset  = options.filter(o => o.source === 'ruleset');

    // Build option row markup. Same shape for both sections.
    const optRow = (opt) => {
      const d = opt.def.dimensions || { l: 0, w: 0, h: 0 };
      const cat = opt.def.category ? `<span class="inv-modal-cat">${escapeHtml(opt.def.category)}</span>` : '';
      const isContainerDual = opt.kind === 'equipment' && opt.def.containerOf;
      const dualPill = isContainerDual ? '<span class="inv-modal-dual">dual-role</span>' : '';
      // Personal-catalogue entries get a × delete button. Deletion now
      // removes ONLY the def itself — existing instances on the sheet
      // are preserved (they render as "deleted def" placeholders and
      // can be kept or manually removed by the user).
      const deleteBtn = opt.source === 'custom'
        ? `<button class="inv-modal-opt-delete" onclick="event.stopPropagation();invDeleteCustomDef('${escapeHtml(opt.kind)}','${escapeHtml(opt.def.id)}')" title="Delete from personal catalogue. Existing instances on the sheet are preserved.">×</button>`
        : '';
      return `<div class="inv-modal-opt" onclick="${onPickAttr}('${escapeHtml(opt.kind)}','${escapeHtml(opt.def.id)}')">
        <div class="inv-modal-opt-header">
          <div class="inv-modal-opt-name">${escapeHtml(opt.def.name)}${cat}${dualPill}</div>
          ${deleteBtn}
        </div>
        <div class="inv-modal-opt-meta">${fmt(d.l)}×${fmt(d.w)}×${fmt(d.h)} in · ${fmt(opt.def.weight || 0)} lb</div>
        ${opt.def.description ? `<div class="inv-modal-opt-desc">${escapeHtml(opt.def.description)}</div>` : ''}
      </div>`;
    };

    // Build the list. When one section is empty, show only the other
    // with no header (to avoid a dangling "Personal Catalogue" label
    // over nothing). When both are empty, fall back to emptyMsg.
    let listHtml = '';
    if (options.length === 0) {
      listHtml = `<div class="inv-modal-empty">${escapeHtml(emptyMsg)}</div>`;
    } else {
      if (personal.length > 0) {
        listHtml += `<div class="inv-modal-section-label" title="Items you've made specifically for this character. Not visible on other characters.">Personal Catalogue <span class="inv-modal-section-count">${personal.length}</span></div>`;
        listHtml += personal.map(optRow).join('');
      }
      if (ruleset.length > 0) {
        listHtml += `<div class="inv-modal-section-label" title="Items defined in the shared ruleset. Available to every character using this ruleset.">Ruleset Catalogue <span class="inv-modal-section-count">${ruleset.length}</span></div>`;
        listHtml += ruleset.map(optRow).join('');
      }
    }

    // "+ Custom" button at the bottom lets the user define a one-off
    // container/item right from the sheet without leaving the flow.
    // The new one lands in the Personal Catalogue at the top of the
    // modal next time they open it.
    const customBtn = customKind
      ? `<div class="inv-modal-custom-row">
          <button class="inv-add-btn" onclick="invOpenCustomForm('${escapeHtml(customKind)}')">+ Custom ${customKind === 'container' ? 'Container' : 'Item'}…</button>
          <span class="inv-modal-custom-hint">Adds a one-off to your sheet. To save it for reuse, use the ✎ pencil → "Save to Personal Catalogue".</span>
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
  // Single modal shared by Add Group, Add Subgroup, and Rename Group.
  // activeModal.groupEditMode ('add' | 'addSubgroup' | 'edit') drives
  // the header label, hint text, and the saveGroup handler's target.

  function renderGroupEditModal() {
    const draft = activeModal.groupDraft || {};
    const mode = activeModal.groupEditMode || 'add';
    const isAdd = mode === 'add';
    const isSub = mode === 'addSubgroup';
    const title = isAdd ? 'New Group' : isSub ? 'New Subgroup' : 'Edit Group';
    let hint = '';
    let placeholder = 'e.g. Vehicle, Safe House, Stash';
    if (isAdd) {
      hint = 'Groups are top-level buckets for things not on your body — e.g. Vehicle, Stash, Safe House.';
    } else if (isSub) {
      // Find parent name for a more grounded hint.
      const parent = findGroup(activeModal.groupParentId);
      const parentName = parent ? parent.name : 'this group';
      hint = `Creates a subgroup inside "${parentName}". Use subgroups to organize things — e.g. inside On-Person: Back, Belt, Holster; inside Vehicle: Glove Box, Trunk.`;
      placeholder = 'e.g. Back, Belt, Glove Box, Bedroom';
    }

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
            <input type="text" value="${escapeHtml(draft.name || '')}" placeholder="${escapeHtml(placeholder)}" oninput="invUpdateGroupDraft('name',this.value)" autofocus>
          </div>

          <div class="inv-field">
            <label>Description</label>
            <textarea rows="4" placeholder="Optional — what is this? Where is it? What's its purpose?" oninput="invUpdateGroupDraft('description',this.value)">${escapeHtml(draft.description || '')}</textarea>
          </div>

          <div class="inv-modal-actions">
            <button class="inv-add-btn" onclick="invSaveGroup()">${(isAdd || isSub) ? 'Create' : 'Save'}</button>
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

  // ─── CATALOG VIEW HANDLERS ───

  function setViewMode(mode) {
    if (mode !== 'inventory' && mode !== 'catalog') return;
    if (viewMode === mode) return;
    viewMode = mode;
    renderAll();
  }

  function toggleCatalogCat(id) {
    if (collapsedCatalogCats.has(id)) collapsedCatalogCats.delete(id);
    else collapsedCatalogCats.add(id);
    renderAll();
  }

  function toggleCatalogItem(id) {
    if (expandedCatalogItems.has(id)) expandedCatalogItems.delete(id);
    else expandedCatalogItems.add(id);
    // Close any open add-menu when expanding/collapsing — keeps UI tidy.
    catalogAddMenuFor = null;
    renderAll();
  }

  // Toggle the "Add to..." dropdown for a specific catalog item. Only
  // one menu is open at a time — opening a new one closes any previous.
  function catalogToggleAddMenu(id) {
    catalogAddMenuFor = (catalogAddMenuFor === id) ? null : id;
    renderAll();
  }

  // Quick-add: place the catalog item using the smart default target,
  // no dropdown. The add button's main half calls this.
  async function catalogQuickAdd(id) {
    const ruleset = getRuleset();
    const def = (ruleset.items || []).find(x => x.id === id)
             || findCustomDefById(id);
    if (!def) return;
    const target = smartDefaultTarget(def);
    if (!target) return;
    await catalogPlaceItem(def, target);
  }

  // Explicit-target add: user picked a specific destination from the
  // dropdown. target is { kind, code?, id? } matching the row the user
  // clicked.
  async function catalogAddTo(itemId, targetKind, targetId) {
    const ruleset = getRuleset();
    const def = (ruleset.items || []).find(x => x.id === itemId)
             || findCustomDefById(itemId);
    if (!def) return;
    let target;
    if (targetKind === 'slot')      target = { kind: 'slot',      code: targetId };
    else if (targetKind === 'group') target = { kind: 'group',     id:   targetId };
    else if (targetKind === 'container') target = { kind: 'container', id: targetId };
    else return;
    await catalogPlaceItem(def, target);
  }

  // "Create new group…" option — prompts for a name, creates the group,
  // then places the item there. Menu closes after.
  async function catalogAddToNewGroup(itemId) {
    const ruleset = getRuleset();
    const def = (ruleset.items || []).find(x => x.id === itemId)
             || findCustomDefById(itemId);
    if (!def) return;
    const name = prompt('Name for the new group:', 'Stowed');
    if (!name || !name.trim()) return;
    const inv = ensureInventory();
    const newGroup = {
      id: _nextInvId('grp'),
      name: name.trim(),
      description: '',
      kind: 'custom',
      collapsed: false,
      contents: []
    };
    inv.groups.push(newGroup);
    await catalogPlaceItem(def, { kind: 'group', id: newGroup.id });
  }

  // Look up a custom def by id from either customDefs bucket.
  // Returns null if not found.
  function findCustomDefById(id) {
    const inv = ensureInventory();
    return (inv.customDefs.containers || []).find(x => x.id === id)
        || (inv.customDefs.equipment  || []).find(x => x.id === id)
        || null;
  }

  // Unified placement path. Builds the inventory entry, routes it to
  // the right array based on target.kind, and saves. Sets a toast
  // message describing where it went.
  async function catalogPlaceItem(def, target) {
    const inv = ensureInventory();
    const ruleset = getRuleset();
    const defKind = def.containerOf ? 'container' : 'equipment';
    // Snapshot is baked at placement time. The `def` argument itself
    // is the current def — we pass a synthetic entry with just the
    // defId to buildSnapshotFromDef, which re-resolves it against the
    // current ruleset/customDefs. This keeps the snapshot logic in one
    // place rather than duplicating the field-copying here.
    const newEntry = {
      id: _nextId(),
      defId: def.id,
      defKind,
      quantity: 1,
      snapshot: buildSnapshotFromDef({ defId: def.id }, ruleset, inv)
    };
    if (def.containerOf) newEntry.contents = [];

    let whereLabel = '';
    if (target.kind === 'group') {
      // Accept any group in the tree (On-Person, custom top-level,
      // or nested subgroups). findGroup walks the whole structure.
      const g = findGroup(target.id);
      if (!g || !isGroupNode(g)) return;
      if (!Array.isArray(g.contents)) g.contents = [];
      g.contents.push(newEntry);
      whereLabel = g.name;
    } else if (target.kind === 'container') {
      const parent = findEntry(target.id);
      if (!parent) return;
      if (!Array.isArray(parent.contents)) parent.contents = [];
      parent.contents.push(newEntry);
      expandedEntries.add(parent.id);
      whereLabel = `inside ${entryName(parent)}`;
    } else if (target.kind === 'newGroup') {
      // Smart default asked for a new "Stowed" group because no suitable
      // existing target was found. Create it, then place the item.
      const newGroup = {
        id: _nextInvId('grp'),
        name: 'Stowed',
        description: '',
        kind: 'custom',
        collapsed: false,
        contents: [newEntry]
      };
      inv.groups.push(newGroup);
      whereLabel = newGroup.name;
    } else {
      return;
    }

    if (def.containerOf) expandedEntries.add(newEntry.id);

    // Close any open menu and prepare the toast for the next render.
    catalogAddMenuFor = null;
    lastAddToast = `Added ${def.name} → ${whereLabel}`;

    renderAll();
    // Toast auto-clears after a few seconds — schedule a re-render
    // with the toast null so the confirmation fades on its own.
    setTimeout(() => {
      if (lastAddToast) {
        lastAddToast = null;
        renderAll();
      }
    }, 3000);

    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // ─── GROUP HANDLERS ───
  //
  // Groups now form a tree: On-Person + any custom top-level groups at
  // the root, with arbitrary subgroups nested inside each. Every
  // handler here walks the tree via findGroup so it works at any depth.
  //
  // On-Person is special — it can't be renamed or deleted, but
  // subgroups INSIDE On-Person can be (they're just custom groups).

  async function toggleGroupCollapse(groupId) {
    const g = findGroup(groupId);
    if (!g) return;
    g.collapsed = !g.collapsed;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // addGroup and renameGroup open the shared Group Edit modal. Actual
  // persistence happens in saveGroup when the user hits Save.

  function addGroup() {
    if (!getCanEdit()) return;
    activeModal = {
      kind: 'groupEdit',
      groupEditMode: 'add',
      groupDraft: { name: '', description: '' }
    };
    renderActiveModal();
  }

  // Add a subgroup inside an existing group (or subgroup). The parent
  // is identified by id and located via findGroup so any depth works.
  // Opens the same Group Edit modal in add-subgroup mode — on save,
  // the new subgroup is pushed into the parent's contents rather than
  // onto the top-level inv.groups.
  function addSubgroup(parentGroupId) {
    if (!getCanEdit()) return;
    const parent = findGroup(parentGroupId);
    if (!parent) return;
    activeModal = {
      kind: 'groupEdit',
      groupEditMode: 'addSubgroup',
      groupParentId: parentGroupId,
      groupDraft: { name: '', description: '' }
    };
    renderActiveModal();
  }

  function renameGroup(groupId) {
    if (!getCanEdit()) return;
    const g = findGroup(groupId);
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
    // Don't re-render — inputs are self-updating. Re-rendering would
    // steal focus from the field being typed into.
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
      // Top-level custom group — pushed into inv.groups.
      inv.groups.push({
        id: _nextInvId('grp'),
        name,
        description,
        kind: 'custom',
        collapsed: false,
        contents: []
      });
    } else if (activeModal.groupEditMode === 'addSubgroup') {
      // Subgroup — pushed into the parent's contents. Parent may be
      // at any depth in the tree, so findGroup does the walk.
      const parent = findGroup(activeModal.groupParentId);
      if (!parent) { closeModal(); return; }
      if (!Array.isArray(parent.contents)) parent.contents = [];
      parent.contents.push({
        id: _nextInvId('grp'),
        name,
        description,
        kind: 'custom',
        collapsed: false,
        contents: []
      });
    } else if (activeModal.groupEditMode === 'edit') {
      const g = findGroup(activeModal.groupEditId);
      if (!g || g.kind === 'onPerson') { closeModal(); return; }
      g.name = name;
      g.description = description;
    }

    closeModal();
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Delete a group or subgroup. Walks the tree to find the node and
  // the parent array it lives in, then splices it out. On-Person is
  // guarded — can't delete. Confirm dialog with item count if non-empty.
  async function deleteGroup(groupId) {
    if (!getCanEdit()) return;
    const g = findGroup(groupId);
    if (!g || g.kind === 'onPerson') return;
    const itemCount = Array.isArray(g.contents) ? g.contents.length : 0;
    if (itemCount > 0) {
      if (!confirm(`Delete "${g.name}" and everything inside (${itemCount} item${itemCount === 1 ? '' : 's'})? This cannot be undone.`)) return;
    } else {
      if (!confirm(`Delete "${g.name}"?`)) return;
    }
    // Remove from the tree — walk both top-level and nested contents.
    const inv = ensureInventory();
    const removeFrom = (arr) => {
      if (!Array.isArray(arr)) return false;
      for (let i = 0; i < arr.length; i++) {
        const node = arr[i];
        if (!node || typeof node !== 'object') continue;
        if (node.id === groupId && isGroupNode(node)) {
          arr.splice(i, 1);
          return true;
        }
        if (isGroupNode(node) && removeFrom(node.contents)) return true;
      }
      return false;
    };
    // Top-level groups live in inv.groups; subgroups live in a group's
    // contents. Try top-level first.
    if (!removeFrom(inv.groups)) {
      // Must be a subgroup — walk each top-level group's contents.
      for (const top of inv.groups || []) {
        if (removeFrom(top.contents)) break;
      }
    }
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
    if (targetKind === 'container') {
      const parent = findEntry(target);
      return parent ? `Inside: ${entryName(parent)}` : '';
    }
    if (targetKind === 'group') {
      // Walks the full tree so subgroup labels work. On-Person and
      // nested subgroups all render correctly.
      const g = findGroup(target);
      return g ? `To: ${g.name}` : '';
    }
    // Legacy 'slot' targeting — no-op after the slot → group refactor.
    return '';
  }

  function openAddContainer(target, targetKind) {
    if (!getCanEdit()) return;
    // Back-compat: second arg used to be a boolean `fromContainer`.
    // Normalize to the new targetKind.
    if (targetKind === true) targetKind = 'container';
    // Default to 'group' — any caller passing no kind assumes a group
    // target. The old 'slot' default no longer makes sense post-refactor.
    if (!targetKind) targetKind = 'group';
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
    if (!targetKind) targetKind = 'group';
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

    // Count references so we can inform the user. Instances are NOT
    // auto-removed — they persist as "deleted def" placeholders on
    // the sheet. User can remove them individually or re-create the
    // def to restore their display. This matches users' intuition:
    // deleting a template shouldn't nuke their actual stuff.
    let refCount = 0;
    walkTree(entry => { if (entry.defId === defId) refCount++; });

    const msg = refCount > 0
      ? `Remove "${def.name}" from your personal catalogue?\n\n${refCount} instance${refCount === 1 ? '' : 's'} on your sheet will remain (shown as "deleted def") until you remove ${refCount === 1 ? 'it' : 'them'} manually.`
      : `Remove "${def.name}" from your personal catalogue?`;
    if (!confirm(msg)) return;

    // Drop the def — leave instances alone.
    const idx = bucket.findIndex(x => x.id === defId);
    if (idx >= 0) bucket.splice(idx, 1);

    renderActiveModal();   // refresh the picker so the row disappears
    renderAll();           // refresh the sheet so orphaned entries re-render
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

  // Create a one-off entry from the inline custom form in the picker
  // modal. NO catalog side effect — the entry is built directly with
  // its own snapshot and placed on the sheet. To promote it into the
  // personal catalogue later, the user hits "Save to Personal Catalogue"
  // from the entry's pencil-edit panel.
  //
  // Kept named `saveCustomDef` for back-compat with existing window
  // handler wiring. Despite the name, no def is written to customDefs.
  async function saveCustomDef() {
    if (!activeModal || !activeModal.customDraft) return;
    const d = activeModal.customDraft;
    const name = (d.name || '').trim();
    if (!name) {
      alert('Please enter a name.');
      return;
    }
    const isContainer = activeModal.customKind === 'container';

    // Build the snapshot directly from the draft — this is what
    // getDefForEntry fallback would synthesize anyway, so we just
    // construct it up front. defId stays null because there's no
    // backing catalog def.
    const snapshot = {
      name,
      description: (d.description || '').trim(),
      dimensions:  { l: d.l || 0, w: d.w || 0, h: d.h || 0 },
      weight:      d.weight || 0,
      containerOf: null,
      legacyCategory: ''
    };
    if (isContainer) {
      snapshot.containerOf = {
        dimensions:        { l: d.l || 0, w: d.w || 0, h: d.h || 0 },
        packingEfficiency: clampEff(d.packingEfficiency, 0.75)
      };
    } else if (d.alsoContainer) {
      snapshot.containerOf = {
        dimensions:        { l: d.innerL || 0, w: d.innerW || 0, h: d.innerH || 0 },
        packingEfficiency: clampEff(d.innerPacking, 0.75)
      };
    }

    const isContainerRole = !!snapshot.containerOf;
    const defKind = isContainerRole ? 'container' : 'equipment';

    // Place it directly. `instantiateAndPlaceOneOff` is a sibling of
    // instantiateAndPlace that doesn't require a catalog def — it
    // takes the pre-built snapshot instead.
    await instantiateAndPlaceOneOff(defKind, snapshot, isContainerRole);
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
    const ruleset = getRuleset();
    // Build the new entry with its snapshot baked in right away. The
    // snapshot is what the sheet reads for display + calculation, so
    // future def edits/deletes don't affect this instance.
    const newEntry = {
      id: _nextId(),
      defId,
      defKind,
      quantity: 1,
      snapshot: buildSnapshotFromDef({ defId }, ruleset, inv)
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
      // Accept placements into any group or subgroup (On-Person, custom
      // top-level groups, and nested subgroups all qualify). findGroup
      // walks the full tree.
      const g = findGroup(tgt);
      if (g && isGroupNode(g)) {
        if (!Array.isArray(g.contents)) g.contents = [];
        g.contents.push(newEntry);
        placed = true;
      }
    } else if (tkind === 'slot') {
      // Legacy 'slot' targeting — body slots are gone, so this path
      // is a no-op. Kept so any stale menu callers don't throw.
      placed = false;
    }

    if (!placed) { closeModal(); return; }

    if (isContainerRole) expandedEntries.add(newEntry.id);
    closeModal();
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // One-off variant: used when the user creates an item via the
  // "+ Custom" form in the picker. Takes a pre-built snapshot instead
  // of a defId — no catalog def exists yet. The entry's defId is null
  // so lookups correctly report "no def" and fall through to snapshot.
  async function instantiateAndPlaceOneOff(defKind, snapshot, isContainerRole) {
    const inv = ensureInventory();
    const newEntry = {
      id: _nextId(),
      defId: null,              // no backing def — purely a one-off
      defKind,
      quantity: 1,
      snapshot: snapshot        // already pre-built by caller
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
      // Accept placements into any group or subgroup (On-Person, custom
      // top-level groups, and nested subgroups all qualify). findGroup
      // walks the full tree.
      const g = findGroup(tgt);
      if (g && isGroupNode(g)) {
        if (!Array.isArray(g.contents)) g.contents = [];
        g.contents.push(newEntry);
        placed = true;
      }
    } else if (tkind === 'slot') {
      // Legacy 'slot' targeting — body slots are gone, so this path
      // is a no-op. Kept so any stale menu callers don't throw.
      placed = false;
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
    addSubgroup,
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
    removeEntry: removeEntryHandler,
    // Catalog view
    setViewMode,
    toggleCatalogCat,
    toggleCatalogItem,
    catalogToggleAddMenu,
    catalogQuickAdd,
    catalogAddTo,
    catalogAddToNewGroup,
    // Inline entry edit
    openEntryEdit,
    updateEditDraft,
    saveEntryEdit,
    cancelEntryEdit,
    promoteEntryToCatalogue,
    // Manage personal catalogue
    openManageCatalog,
    catMgrClose,
    catMgrCloseIfBackdrop,
    catMgrToggleRow,
    catMgrCollapseRow,
    catMgrDraft,
    catMgrSaveEdit,
    catMgrDelete,
    catMgrStartNew,
    catMgrCancelNew,
    catMgrNewDraft,
    catMgrSaveNew,
    // Carry cards (CAP / ENC / LIFT) + group-level encumbrance toggle
    toggleCarryCard,
    addCapMod, updateCapMod, deleteCapMod,
    addLiftMod, updateLiftMod, deleteLiftMod,
    addEncMod, updateEncMod, deleteEncMod,
    toggleGroupEncumbrance
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
