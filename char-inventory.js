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
import { wrapCollapsibleSection } from './char-util.js';
import { resolveWeapon, rofFlavor, rangedBandFor, meleeBandFor } from './char-weapons.js';

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
        legacyCategory: def.legacyCategory || def.category || '',
        // Weapon snapshot — copied at add-time so later def changes
        // don't retroactively alter existing character entries. Null
        // when the source def isn't a weapon. Deep-clone so range
        // arrays / tag arrays are owned by the entry.
        weapon:       def.weapon ? JSON.parse(JSON.stringify(def.weapon)) : null
      };
    }
    return {
      name: '(unknown item)',
      description: '',
      dimensions: { l: 0, w: 0, h: 0 },
      weight: 0,
      containerOf: null,
      legacyCategory: '',
      weapon: null
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
        legacyCategory: def.legacyCategory || def.category || '',
        // Weapon snapshot — deep clone so mutations on the entry
        // don't leak back to the def.
        weapon:        def.weapon ? JSON.parse(JSON.stringify(def.weapon)) : null
      };
    }
    // Def is missing entirely — build a minimal placeholder snapshot
    // so the entry still renders with a recognizable name.
    return {
      name:          '(unknown item)',
      description:   '',
      dimensions:    { l: 0, w: 0, h: 0 },
      weight:        0,
      containerOf:   null,
      legacyCategory: '',
      weapon:        null
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

  // Central choke point for all inventory writes. Every mutating
  // handler calls this (add/move/delete item, group ops, carry mods).
  // Gating here stops every write path at once without having to
  // decorate each caller. Owners + GMs pass; everyone else is a no-op.
  // Recursively sanitize any entry snapshots' weapon ranges so nested
  // arrays ([s,e] tuples) never hit Firestore. Converts to {s,e}
  // objects on the fly. Walks bySlot groups and stowed, descending
  // into container contents. This is defensive — new entries come
  // through fresh resolver/coercer paths that already produce
  // objects, but legacy snapshots from earlier versions may still be
  // in the stored character doc. Run on every save so Firestore
  // accepts the write.
  function _sanitizeEntryRangesInPlace(entry) {
    if (!entry) return;
    const snap = entry.snapshot;
    if (snap && snap.weapon && snap.weapon.kind === 'melee' && Array.isArray(snap.weapon.ranges)) {
      snap.weapon.ranges = snap.weapon.ranges.map(b => {
        if (b && typeof b === 'object' && !Array.isArray(b)) {
          return { s: Number(b.s) || 0, e: Number(b.e) || 0 };
        }
        if (Array.isArray(b) && b.length >= 2) {
          return { s: Number(b[0]) || 0, e: Number(b[1]) || 0 };
        }
        return { s: 0, e: 0 };
      });
    }
    if (Array.isArray(entry.contents)) {
      entry.contents.forEach(_sanitizeEntryRangesInPlace);
    }
  }

  async function save() {
    if (!getCanEdit()) return;
    const inv = ensureInventory();
    // Walk every entry and normalize weapon.ranges to {s,e} objects
    // so Firestore (which rejects nested arrays) accepts the write.
    // Mutates in place — cheap, and future reads see the clean shape.
    if (inv && inv.bySlot && typeof inv.bySlot === 'object') {
      Object.values(inv.bySlot).forEach(arr => {
        if (Array.isArray(arr)) arr.forEach(_sanitizeEntryRangesInPlace);
      });
    }
    if (Array.isArray(inv && inv.stowed)) {
      inv.stowed.forEach(_sanitizeEntryRangesInPlace);
    }
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

    // Build the row body inline. The wrapper/head are added by
    // wrapCollapsibleSection below so the whole row can be collapsed
    // as a unit (click the "Carry" header). Storage:
    //   prime.collapse.inventory.carry   (per-browser localStorage)
    let row_html = '<div class="inv-carry-cards">';

    // ── CAP CARD ──
    row_html += renderCarryCard({
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
    const ratio = carry.cap > 0
      ? `${fmt(carry.carried)} / ${fmt(carry.cap)} lbs`
      : `${fmt(carry.carried)} lbs (no CAP)`;
    const overBy = Math.max(0, carry.carried - carry.cap);
    const ratioSub = overBy > 0
      ? `<span class="inv-carry-base">over by ${fmt(overBy)} lbs</span>`
      : `<span class="inv-carry-base">within CAP</span>`;
    row_html += renderCarryCard({
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

    let liftBanner = '';
    let liftSeverityCls = '';
    if (carry.lift > 0) {
      const over = carry.carried - carry.lift;
      if (over >= 0) {
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
        const remaining = carry.lift - carry.carried;
        liftBanner = `<div class="inv-carry-banner inv-carry-banner-note">
          <span class="inv-carry-banner-icon">◉</span>
          <span class="inv-carry-banner-txt">Nearing LIFT — ${fmt(remaining)} lbs until max.</span>
        </div>`;
        liftSeverityCls = ' carry-light';
      }
    }

    const fmtPct = (n) => `${n > 0 ? '+' : '−'}${Math.abs(n)}%`;
    const liftParts = [];
    if (carry.liftFromCapPct !== 0) liftParts.push(`${fmtPct(carry.liftFromCapPct)} from CAP`);
    if (carry.liftModTotal      !== 0) liftParts.push(`${fmtPct(carry.liftModTotal)} from LIFT`);
    const liftBaseHtml = liftParts.length === 0
      ? `<span class="inv-carry-base">base ${fmt(carry.rawLift)}</span>`
      : `<span class="inv-carry-base">base ${fmt(carry.rawLift)} · ${liftParts.join(' · ')}</span>`;

    // ── LIFT CARD ──
    row_html += renderCarryCard({
      key:        'lift',
      label:      'Maximum Lift',
      code:       'LIFT',
      open:       liftOpen,
      canEdit,
      valueHtml:  `${fmt(carry.lift)} <span class="inv-carry-unit">lbs</span>`,
      baseHtml:   liftBaseHtml,
      description:'Absolute maximum you can ever carry without a roll. At this weight, ENC is 100% and you cannot move without rolling to "lift". Base: CAP × 11.',
      modifiers:  carry.liftModifiers,
      modUnit:    '%',
      addFn:      'invAddLiftMod',
      updateFn:   'invUpdateLiftMod',
      deleteFn:   'invDeleteLiftMod',
      severityCls: liftSeverityCls,
      banner:     liftBanner
    });

    row_html += '</div>';

    // Wrap the whole row in a collapsible section so the player can
    // hide the full Carry block. Inventory groups below this row have
    // their own per-group collapses (group.collapsed in the char doc);
    // this one is separate and persists per-browser.
    return wrapCollapsibleSection(
      'prime.collapse.inventory.carry',
      '<span class="inv-carry-head-text">Carry</span>',
      row_html,
      { wrapperClass: 'inv-carry-wrap', collapsibleClass: 'inv-carry-head', rerenderHandler: 'inventoryToggleCollapse' }
    );
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
                     onchange="${updateFn}(${idx}, 'name', this.value)"
                     placeholder="Name (e.g. Brawny Trait)"/>
              <input type="number" class="inv-carry-mod-value"
                     value="${value}" step="1"
                     onchange="${updateFn}(${idx}, 'value', this.value)"/>
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
    // Weapons are expandable too — the weapon readout collapses with
    // the namecard. A plain item with no description but a weapon
    // snapshot still gets a clickable name that toggles the weapon
    // card underneath. `hasInfo` stays narrow ("has text content")
    // so the info panel only renders when there's text; `hasExpandable`
    // is the broader trigger for making the whole entry collapsible.
    const hasText = !!((description && description.trim()) || (entry.notes && entry.notes.trim()));
    const hasWeapon = !!(snap && snap.weapon);
    const hasExpandable = hasText || hasWeapon;
    const infoOpen = expandedInfo.has(entry.id);

    // Hover tooltip: first ~80 chars of description as a title attribute
    // on the name. Full description shows when the row is clicked.
    const tooltip = hasText
      ? escapeHtml(truncate((description || entry.notes || '').replace(/\s+/g, ' ').trim(), 80))
      : (hasWeapon ? 'Click to show/hide weapon stats' : '');
    // If there's expandable content, the name is clickable.
    const nameAttrs = hasExpandable
      ? ` class="inv-entry-name inv-entry-name-clickable" title="${tooltip}" onclick="invToggleItemInfo('${escapeHtml(entry.id)}')"`
      : ` class="inv-entry-name"`;

    const isEditing = editingEntryId === entry.id;

    let html = `<div class="inv-entry inv-entry-item${infoOpen ? ' info-open' : ''}${isEditing ? ' editing' : ''}" style="margin-left:${depth * 16}px">
      <div class="inv-entry-head inv-entry-head-item">
        <span class="inv-entry-icon" title="Item">◆</span>
        <span${nameAttrs}>${escapeHtml(name)}${escapeHtml(catLabel)}${hasExpandable ? `<span class="inv-entry-info-caret">${infoOpen ? '▾' : '▸'}</span>` : ''}</span>
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

    if (infoOpen && hasText) {
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

    // Weapon readout — only shows when the entry is expanded (the
    // namecard caret controls it) AND the snapshot carries a weapon.
    // Non-weapon items skip this block entirely.
    if (infoOpen && hasWeapon) {
      html += renderWeaponReadout(entry);
    }

    html += `</div>`;
    return html;
  }

  // Weapon readout block. Designed as a self-contained mini dice
  // calculator — players read the numbers off the card, type them
  // into their Discord dicebot, and roll. The Roll Calc integration
  // ("→ Roll Calc" button) is a secondary convenience, not the
  // primary workflow.
  //
  // Layout:
  //   [Attack block]
  //     Dice pool: "DEX(6) + Melee(3) = 9D10" (click to toggle raw vs penalty-reduced)
  //     Flat bonus: "+2" (DEXMOD)
  //     Difficulty row: base 6 + chips (secondary skill -1, pain +1, etc.), final number
  //     Slot breakdown per term — category-coded colors
  //     "→ Roll Calc" button (secondary)
  //   [Damage block]
  //     Same structure, with an extra "ATK result" input for the
  //     chain-from-attack-to-damage flow
  //   [Chips row]  — DMG, PEN, range info, AMMO, ROF
  //   [Melee range bands] OR ranged range info
  //   [Tags]
  //
  // Per-instance UI state (entry.weaponUI) carries:
  //   showRawAttack  — boolean; toggles raw vs penalty-reduced for Attack
  //   showRawDamage  — boolean; same for Damage
  //   atkResult      — number or null; the attack roll's contested
  //                     result, used to compute final damage dice
  //   (overrides and current range live in entry.weaponOverrides and
  //   entry.currentRange — those drive actual resolver state)
  function renderWeaponReadout(entry) {
    const snap = entry && entry.snapshot;
    const weapon = snap && snap.weapon;
    if (!weapon || (weapon.kind !== 'melee' && weapon.kind !== 'ranged')) return '';

    const character = ctx.getCharData();
    const ruleset   = ctx.getRuleset();

    let penaltyPct = 0;
    try {
      const derived = computeDerivedStats(character, ruleset);
      penaltyPct = (derived && derived.penalty && derived.penalty.percent) || 0;
    } catch (_) { penaltyPct = 0; }

    const ui = entry.weaponUI || {};
    const overrides = entry.weaponOverrides || null;
    const atkResult = Number.isFinite(ui.atkResult) ? ui.atkResult : null;
    const currentRange = Number.isFinite(entry.currentRange) ? entry.currentRange : null;
    // Rapidfire: how many EXTRA AMMO the player wants to spend this
    // round (0 = normal single shot, N>0 = burst). Only meaningful for
    // ranged weapons; melee ignores this. Stored per-entry so each
    // weapon remembers its own rapidfire setting.
    const rapidfireExtra = (weapon.kind === 'ranged'
                            && Number.isFinite(ui.rapidfireExtra)
                            && ui.rapidfireExtra > 0)
      ? Math.floor(ui.rapidfireExtra)
      : 0;

    // Resolve TWICE:
    //   resolved        — with overrides applied (what the user currently sees)
    //   defaultResolved — with NO overrides (so each slot knows its original
    //                     variable name for the override map key). Slots are
    //                     paired by index between the two results.
    // Performance is fine — two cheap compiles + evaluations per weapon.
    const resolved = resolveWeapon(weapon, character, ruleset, overrides, atkResult, penaltyPct, rapidfireExtra);
    if (!resolved) return '';
    const defaultResolved = overrides
      ? resolveWeapon(weapon, character, ruleset, null, atkResult, penaltyPct, rapidfireExtra)
      : resolved;

    // Compute range-based Difficulty chip for the Attack block. Works
    // for both melee (map distance onto weapon's bands) and ranged
    // (map distance past weapon's base range in successive bands).
    // Returns { band, label } or null when no range set.
    let rangeChip = null;
    if (currentRange != null) {
      try {
        if (weapon.kind === 'melee') {
          rangeChip = meleeBandFor(resolved.ranges, currentRange);
        } else {
          rangeChip = rangedBandFor(resolved.range, currentRange);
        }
      } catch (_) { rangeChip = null; }
    }

    const kindLabel = resolved.kind === 'melee' ? 'Melee' : 'Ranged';
    const hasOverride = !!(overrides && (
      (overrides.attack && Object.keys(overrides.attack).length > 0) ||
      (overrides.damage && Object.keys(overrides.damage).length > 0)
    ));
    const hasAnyInstanceState = hasOverride || currentRange != null || atkResult != null || rapidfireExtra > 0;

    const customBadge = hasOverride
      ? '<span class="inv-weapon-custom-badge" title="This weapon has per-instance slot overrides. Click Reset to clear.">custom</span>'
      : '';
    const resetBtn = hasAnyInstanceState
      ? `<button class="inv-weapon-reset-btn" onclick="invWeaponResetOverrides('${escapeHtml(entry.id)}')" title="Clear all slot overrides, range, and ATK result for this weapon">Reset to def</button>`
      : '';
    const canEdit = ctx.getCanEdit();
    const editOpen = !!(ui.editOpen);
    const editBtn = canEdit
      ? `<button class="inv-weapon-edit-btn${editOpen ? ' on' : ''}" onclick="invWeaponToggleEdit('${escapeHtml(entry.id)}')" title="${editOpen ? 'Close the weapon stat editor' : 'Edit damage dice, PEN, range, tags for this specific weapon'}">${editOpen ? '✓ Edit stats' : 'Edit stats'}</button>`
      : '';

    let html = `<div class="inv-weapon">
      <div class="inv-weapon-title">
        <span>Weapon</span>
        <span class="inv-weapon-kind-pill">${kindLabel}</span>
        ${customBadge}
        <span style="flex:1"></span>
        ${editBtn}
        ${resetBtn}
      </div>
      ${editOpen ? renderWeaponSnapshotEditor(entry) : ''}
      ${renderWeaponRapidfireSelector(entry, resolved)}
      <div class="inv-weapon-grid">
        ${renderWeaponRollBlock(entry, 'Attack', resolved.attack, {
          showRaw:       !!ui.showRawAttack,
          penaltyPct,
          isAttack:      true,
          defaultSlots:  defaultResolved.attack.diceSlots.concat(defaultResolved.attack.flatSlots),
          rangeChip,
          rapidfire:     resolved.rapidfire || null
        })}
        ${renderWeaponRollBlock(entry, 'Damage', resolved.damage, {
          showRaw:       !!ui.showRawDamage,
          penaltyPct,
          isAttack:      false,
          atkResult,
          defaultSlots:  defaultResolved.damage.diceSlots.concat(defaultResolved.damage.flatSlots)
        })}
      </div>`;

    // Chips row — DMG, PEN, range info.
    const chips = [];
    chips.push(`<span class="inv-weapon-chip"><span class="inv-weapon-chip-label">DMG</span><span class="inv-weapon-chip-val">${resolved.dice}D10</span></span>`);
    chips.push(`<span class="inv-weapon-chip"><span class="inv-weapon-chip-label">PEN</span><span class="inv-weapon-chip-val">${resolved.pen}</span></span>`);
    if (resolved.kind === 'ranged') {
      chips.push(`<span class="inv-weapon-chip"><span class="inv-weapon-chip-label">Range</span><span class="inv-weapon-chip-val">${resolved.range}ft</span></span>`);
      chips.push(`<span class="inv-weapon-chip"><span class="inv-weapon-chip-label">DMGMOD</span><span class="inv-weapon-chip-val">${resolved.dmgmod >= 0 ? '+' : ''}${resolved.dmgmod}</span></span>`);
      chips.push(renderAmmoTracker(entry, resolved));
      chips.push(renderRofChip(resolved));
    }
    html += `<div class="inv-weapon-row">${chips.join('')}</div>`;

    // Engagement-range selector — distance input + (for melee) the
    // clickable band strip. Distance is stored as feet on
    // entry.currentRange. Clicking a melee band chip auto-fills the
    // distance to that band's start.
    html += renderWeaponRangeSelector(entry, weapon, resolved, currentRange, rangeChip);

    // Tags.
    if (Array.isArray(resolved.tags) && resolved.tags.length > 0) {
      html += `<div class="inv-weapon-tags">`;
      resolved.tags.forEach(t => {
        const desc = t.description ? escapeHtml(t.description) : escapeHtml(t.name || '');
        html += `<span class="inv-weapon-tag" title="${desc}">${escapeHtml(t.name || '')}</span>`;
      });
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  // Engagement-range selector row. Melee and ranged weapons differ:
  //   Melee  — show clickable band chips (Band 0: 0-1ft, Band 1: 1-2ft, ...)
  //            plus a distance input for arbitrary values. Clicking a band
  //            fills the distance to that band's start.
  //   Ranged — just a distance input. The computed band comes from
  //            rangedBandFor(weapon.range, distance) which doubles the
  //            difficulty zone each band past the base range.
  //
  // Always shows the current computed band label when a range is set.
  function renderWeaponRangeSelector(entry, weapon, resolved, currentRange, rangeChip) {
    const id = escapeHtml(entry.id);
    const distVal = currentRange != null ? String(currentRange) : '';
    const distInput = `<input type="number" class="inv-weapon-range-input" min="0" step="1"
                              value="${escapeHtml(distVal)}"
                              placeholder="ft"
                              onchange="invWeaponSetRange('${id}',this.value)"
                              onkeydown="if(event.key==='Enter'){invWeaponSetRange('${id}',this.value);this.blur();}">`;
    const clearBtn = currentRange != null
      ? `<button class="inv-weapon-range-clear" onclick="invWeaponSetRange('${id}','')" title="Clear range">×</button>`
      : '';
    const bandLabel = rangeChip
      ? `<span class="inv-weapon-range-band">${escapeHtml(rangeChip.label)}</span>`
      : '<span class="inv-weapon-range-band none">base</span>';

    let html = `<div class="inv-weapon-range-row">
      <span class="inv-weapon-range-row-label">Engagement range</span>
      ${distInput}<span class="inv-weapon-range-unit">ft</span>
      ${clearBtn}
      ${bandLabel}
    </div>`;

    // Melee: show the band strip, clickable. Each chip snaps distance
    // to the band's start (user can fine-tune with the input).
    if (resolved.kind === 'melee' && Array.isArray(resolved.ranges) && resolved.ranges.length > 0) {
      html += `<div class="inv-weapon-ranges">`;
      resolved.ranges.forEach((band, i) => {
        const s = (band && typeof band === 'object' && !Array.isArray(band))
          ? (Number.isFinite(band.s) ? band.s : 0)
          : (Array.isArray(band) && Number.isFinite(band[0]) ? band[0] : 0);
        const e = (band && typeof band === 'object' && !Array.isArray(band))
          ? (Number.isFinite(band.e) ? band.e : 0)
          : (Array.isArray(band) && Number.isFinite(band[1]) ? band[1] : 0);
        const active = rangeChip && rangeChip.band === i ? ' active' : '';
        html += `<span class="inv-weapon-range clickable${active}" onclick="invWeaponSetRange('${id}',${s})" title="Click to snap to ${fmt(s)}ft">
          <span class="inv-weapon-range-label">+${i}</span>${fmt(s)}–${fmt(e)}ft
        </span>`;
      });
      html += `</div>`;
    }
    return html;
  }

  // ─── RAPIDFIRE SELECTOR ────────────────────────────────────────────
  //
  // Ranged-weapon-only row that lets the player pick how many EXTRA
  // AMMO to spend for this shot. Shows:
  //   - Input (0..N) where N = maxAmmo - 1 (need 1 for the base shot)
  //   - Live computed chips: +DMGMOD, recoil Difficulty, ROF absorption
  //   - Total AMMO cost for the shot (1 + extra)
  //
  // The math is computed in resolveWeapon and surfaced here via
  // resolved.rapidfire. If no rapidfire is selected, only a muted
  // "Rapidfire: 0" row shows so the control is discoverable.
  function renderWeaponRapidfireSelector(entry, resolved) {
    if (!resolved || resolved.kind !== 'ranged') return '';
    const id = escapeHtml(entry.id);
    const ui = entry.weaponUI || {};
    const extra = Number.isFinite(ui.rapidfireExtra) && ui.rapidfireExtra > 0
      ? Math.floor(ui.rapidfireExtra)
      : 0;

    // Max extra = resolved ammo max - 1 (need at least 1 for the
    // base shot). Defensive fallback when AMMO doesn't resolve.
    const ammoMax = (resolved.ammo && Number.isFinite(resolved.ammo.resolved))
      ? Math.max(0, Math.floor(resolved.ammo.resolved))
      : 0;
    const maxExtra = Math.max(0, ammoMax - 1);

    // Chips — only populated when extra > 0 (resolved.rapidfire is
    // null otherwise).
    let chipsHtml = '';
    if (resolved.rapidfire) {
      const rf = resolved.rapidfire;
      chipsHtml += `<span class="inv-weapon-rf-chip rf-dmgmod" title="Each extra AMMO adds +1 to DMGMOD. Flows into the Damage formula.">+${rf.dmgmodBonus} DMGMOD → ${rf.effectiveDmgmod}</span>`;
      if (rf.recoilDifficulty > 0) {
        const str = rf.strVal;
        chipsHtml += `<span class="inv-weapon-rf-chip rf-recoil" title="Recoil: effective DMGMOD ${rf.effectiveDmgmod} exceeds STR ${str} by ${rf.overCapacity}. Capped at extra ammo count ${rf.extra}.">+${rf.recoilDifficulty} Difficulty (recoil)</span>`;
      } else {
        chipsHtml += `<span class="inv-weapon-rf-chip rf-controlled" title="STR ${rf.strVal} handles effective DMGMOD ${rf.effectiveDmgmod}. No recoil difficulty.">controlled · no recoil</span>`;
      }
      if (rf.rofMitigation > 0) {
        chipsHtml += `<span class="inv-weapon-rf-chip rf-rof" title="ROF ${rf.rofValue} absorbs ${rf.rofMitigation} point(s) of recoil difficulty.">ROF absorbs −${rf.rofMitigation}</span>`;
      }
      chipsHtml += `<span class="inv-weapon-rf-chip rf-cost" title="Total AMMO consumed when firing.">${rf.totalAmmoCost} AMMO / shot</span>`;
    } else if (extra === 0 && maxExtra > 0) {
      chipsHtml = `<span class="inv-weapon-rf-hint">Spend extra AMMO for +DMGMOD; recoil kicks in once the effective DMGMOD exceeds your STR.</span>`;
    } else if (maxExtra === 0) {
      chipsHtml = `<span class="inv-weapon-rf-hint">Weapon's AMMO cap is 1 — no extra to spend.</span>`;
    }

    const input = `<input type="number" class="inv-weapon-rf-input" min="0" max="${maxExtra}" step="1" value="${escapeHtml(String(extra))}"
                          ${maxExtra === 0 ? 'disabled' : ''}
                          onchange="invWeaponSetRapidfire('${id}',this.value)"
                          onkeydown="if(event.key==='Enter'){invWeaponSetRapidfire('${id}',this.value);this.blur();}">`;
    const clearBtn = extra > 0
      ? `<button class="inv-weapon-rf-clear" onclick="invWeaponSetRapidfire('${id}','0')" title="Back to single shot">×</button>`
      : '';

    return `<div class="inv-weapon-rf-row">
      <span class="inv-weapon-rf-label">Rapidfire</span>
      <span class="inv-weapon-rf-extra-label">extra AMMO</span>
      ${input}
      <span class="inv-weapon-rf-max">/ ${maxExtra}</span>
      ${clearBtn}
      <span class="inv-weapon-rf-chips">${chipsHtml}</span>
    </div>`;
  }

  // ─── WEAPON SNAPSHOT EDITOR ────────────────────────────────────────
  //
  // Inline compact editor for the weapon's intrinsic stats (dice,
  // PEN, range bands, DMGMOD, AMMO, ROF, tags, kind). Edits write
  // directly to entry.snapshot.weapon so they're per-instance — the
  // catalogue def isn't touched. Rendered when entry.weaponUI.editOpen
  // is true; collapsed otherwise (so weapon cards stay compact).
  //
  // Only owners/GMs can edit — the caller gates on getCanEdit().
  // Tags list pulls from ruleset.weaponTags; kind-specific fields
  // only render for the matching kind.
  function renderWeaponSnapshotEditor(entry) {
    const weapon = entry && entry.snapshot && entry.snapshot.weapon;
    if (!weapon) return '';
    const id = escapeHtml(entry.id);
    const kind = weapon.kind === 'ranged' ? 'ranged' : 'melee';
    const dice = Number.isFinite(weapon.dice) ? weapon.dice : 0;
    const pen  = Number.isFinite(weapon.pen)  ? weapon.pen  : 0;

    let html = `<div class="inv-weapon-editor">
      <div class="inv-weapon-editor-title">Weapon stats — edits apply to THIS weapon only, not the catalogue def</div>
      <div class="inv-weapon-editor-row">
        <div class="inv-weapon-editor-field">
          <label>Kind</label>
          <select onchange="invWeaponSnapSetKind('${id}',this.value)">
            <option value="melee"${kind === 'melee' ? ' selected' : ''}>Melee</option>
            <option value="ranged"${kind === 'ranged' ? ' selected' : ''}>Ranged</option>
          </select>
        </div>
        <div class="inv-weapon-editor-field">
          <label>Damage Dice</label>
          <input type="number" step="1" min="0" value="${escapeHtml(String(dice))}"
                 oninput="invWeaponSnapUpdate('${id}','dice',this.value)">
        </div>
        <div class="inv-weapon-editor-field">
          <label>PEN</label>
          <input type="number" step="1" min="0" value="${escapeHtml(String(pen))}"
                 oninput="invWeaponSnapUpdate('${id}','pen',this.value)">
        </div>
      </div>`;

    if (kind === 'melee') {
      const ranges = Array.isArray(weapon.ranges) ? weapon.ranges : [];
      html += `<div class="inv-weapon-editor-subhead">Range Bands <span class="inv-weapon-editor-hint">(each band adds +1 Difficulty; empty = trivial range)</span></div>`;
      if (ranges.length === 0) {
        html += `<div class="inv-weapon-editor-empty">No range bands defined.</div>`;
      } else {
        ranges.forEach((band, bi) => {
          const s = (band && typeof band === 'object' && !Array.isArray(band))
            ? (Number.isFinite(band.s) ? band.s : 0)
            : (Array.isArray(band) && Number.isFinite(band[0]) ? band[0] : 0);
          const e = (band && typeof band === 'object' && !Array.isArray(band))
            ? (Number.isFinite(band.e) ? band.e : 0)
            : (Array.isArray(band) && Number.isFinite(band[1]) ? band[1] : 0);
          html += `<div class="inv-weapon-editor-band">
            <span class="inv-weapon-editor-band-label">Band ${bi} (+${bi})</span>
            <input type="number" step="0.5" min="0" value="${escapeHtml(String(s))}" placeholder="Start"
                   onchange="invWeaponSnapUpdateRange('${id}',${bi},'start',this.value)">
            <span class="inv-weapon-editor-sep">–</span>
            <input type="number" step="0.5" min="0" value="${escapeHtml(String(e))}" placeholder="End"
                   onchange="invWeaponSnapUpdateRange('${id}',${bi},'end',this.value)">
            <span class="inv-weapon-editor-unit">ft</span>
            <button class="inv-weapon-editor-del" onclick="invWeaponSnapRemoveRange('${id}',${bi})" title="Remove band">×</button>
          </div>`;
        });
      }
      html += `<button class="inv-weapon-editor-add" onclick="invWeaponSnapAddRange('${id}')">+ Add Band</button>`;
    } else {
      const range  = Number.isFinite(weapon.range)  ? weapon.range  : 0;
      const dmgmod = Number.isFinite(weapon.dmgmod) ? weapon.dmgmod : 0;
      const ammo   = weapon.ammo != null ? weapon.ammo : '';
      const rof    = weapon.rof  != null ? weapon.rof  : '';
      html += `<div class="inv-weapon-editor-row">
        <div class="inv-weapon-editor-field">
          <label>Range (ft)</label>
          <input type="number" step="1" min="0" value="${escapeHtml(String(range))}"
                 oninput="invWeaponSnapUpdate('${id}','range',this.value)">
        </div>
        <div class="inv-weapon-editor-field">
          <label>DMGMOD</label>
          <input type="number" step="1" value="${escapeHtml(String(dmgmod))}"
                 oninput="invWeaponSnapUpdate('${id}','dmgmod',this.value)">
        </div>
        <div class="inv-weapon-editor-field">
          <label>AMMO <span class="inv-weapon-editor-hint">(number or formula)</span></label>
          <input type="text" value="${escapeHtml(String(ammo))}"
                 onchange="invWeaponSnapUpdate('${id}','ammo',this.value)">
        </div>
        <div class="inv-weapon-editor-field">
          <label>ROF <span class="inv-weapon-editor-hint">(number or formula)</span></label>
          <input type="text" value="${escapeHtml(String(rof))}"
                 onchange="invWeaponSnapUpdate('${id}','rof',this.value)">
        </div>
      </div>`;
    }

    // Tags — pull from the ruleset's weaponTags catalogue. Each tag
    // is a checkbox; toggling calls weaponSnapToggleTag. Unknown tag
    // ids (ruleset changed since this weapon was created) are still
    // shown at the bottom for completeness.
    const ruleset = getRuleset();
    const rsTags = Array.isArray(ruleset && ruleset.weaponTags) ? ruleset.weaponTags : [];
    const weaponTagIds = Array.isArray(weapon.tags) ? weapon.tags : [];
    html += `<div class="inv-weapon-editor-subhead">Tags</div>`;
    if (rsTags.length === 0) {
      html += `<div class="inv-weapon-editor-empty">No weapon tags defined in this ruleset.</div>`;
    } else {
      html += `<div class="inv-weapon-editor-tags">`;
      rsTags.forEach(t => {
        const checked = weaponTagIds.includes(t.id) ? ' checked' : '';
        const descAttr = t.description
          ? ` title="${escapeHtml(t.description)}"`
          : '';
        html += `<label class="inv-weapon-editor-tag"${descAttr}>
          <input type="checkbox"${checked} onchange="invWeaponSnapToggleTag('${id}','${escapeHtml(t.id)}',this.checked)">
          ${escapeHtml(t.name || t.id)}
        </label>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  // Single Attack / Damage roll block.
  //
  // opts:
  //   showRaw    — boolean; when true display raw numbers, when false
  //                display penalty-reduced numbers. Click on the pool
  //                or flat readouts toggles this per weapon.
  //   penaltyPct — penalty percentage (0-100). Only used to decide
  //                whether to show the raw/reduced toggle at all (if
  //                there's no penalty, both values are identical).
  //   isAttack   — true for Attack block. Drives the Difficulty row
  //                (chips for secondary/specialty skill mitigation —
  //                only relevant to attack rolls, not damage).
  //   atkResult  — damage only; contested attack result if the player
  //                has entered one. Shown in the readout as either
  //                the literal value or a "[ATK]" placeholder.
  function renderWeaponRollBlock(entry, label, roll, opts) {
    if (!roll) return '';
    opts = opts || {};
    const which = label.toLowerCase();
    if (roll.error) {
      return `<div class="inv-weapon-roll">
        <div class="inv-weapon-roll-label">${label}</div>
        <div class="inv-weapon-roll-error">${escapeHtml(roll.error)}</div>
      </div>`;
    }

    // ─── DIFFICULTY (attack only) ───────────────────────────────────
    // Compute final Difficulty up front so we can use it in the flat
    // bonus calc (STATMOD shifts by 6 − finalDiff on attacks). For
    // damage blocks, difficulty is null and no shift applies.
    //
    // additions: positive contributions (Range +N from engagement)
    // mitigation: negative offsets from skill tier (secondary −1,
    //             specialty −2), capped at additions — mitigation
    //             cannot lower Difficulty below the base 6.
    let finalDiff = null;
    let diffAdditions = 0;
    let diffMitigation = 0;
    let diffChipsHtml = '';
    if (opts.isAttack) {
      const additionChips = [];
      const mitigationChips = [];
      if (opts.rangeChip && Number.isFinite(opts.rangeChip.band) && opts.rangeChip.band > 0) {
        diffAdditions += opts.rangeChip.band;
        additionChips.push({
          label: `Range ${opts.rangeChip.label}`,
          delta: opts.rangeChip.band,
          cls: 'penalty'
        });
      }
      // Rapidfire: pre-ROF recoil difficulty is the addition; ROF
      // mitigation is a dedicated mitigation chip. Skill mitigation
      // (secondary/specialty) can then further offset what ROF
      // didn't absorb, following the standard mitigation rules.
      const rf = opts.rapidfire;
      if (rf && rf.recoilDifficulty > 0) {
        diffAdditions += rf.recoilDifficulty;
        additionChips.push({
          label: `Rapidfire recoil (+${rf.extra} ammo, STR ${rf.strVal} vs DMGMOD ${rf.effectiveDmgmod})`,
          delta: rf.recoilDifficulty,
          cls: 'penalty'
        });
        if (rf.rofMitigation > 0) {
          diffMitigation += rf.rofMitigation;
          mitigationChips.push({
            label: `ROF ${rf.rofValue} absorbs recoil`,
            delta: -rf.rofMitigation,
            cls: 'mitigation'
          });
        }
      }
      roll.diceSlots.forEach(s => {
        if (s.category === 'skill') {
          if (s.skillTier === 'secondary') {
            diffMitigation += 1;
            mitigationChips.push({ label: `${s.label} (secondary)`, delta: -1, cls: 'mitigation' });
          } else if (s.skillTier === 'specialty') {
            diffMitigation += 2;
            mitigationChips.push({ label: `${s.label} (specialty)`, delta: -2, cls: 'mitigation' });
          }
        }
      });
      const effectiveMitigation = Math.min(diffMitigation, diffAdditions);
      finalDiff = 6 + diffAdditions - effectiveMitigation;

      const chips = additionChips.concat(mitigationChips.map(c => {
        const wasted = diffMitigation > diffAdditions;
        return wasted
          ? Object.assign({}, c, { label: c.label + ' — already at base', wasted: true })
          : c;
      }));
      diffChipsHtml = chips.map(c => {
        const sign = c.delta >= 0 ? '+' : '−';
        const extraCls = c.wasted ? ' wasted' : '';
        return `<span class="inv-weapon-diff-chip ${c.cls || ''}${extraCls}" title="${escapeHtml(c.label)}">${sign}${Math.abs(c.delta)} ${escapeHtml(c.label)}</span>`;
      }).join('');
    }

    // ─── POOL + FLAT ────────────────────────────────────────────────
    // Penalty reduces the dice pool (stat + skill). Flat bonus
    // (STATMOD) is NOT affected by penalty but IS affected by
    // Difficulty: each point of Difficulty above 6 costs 1 flat,
    // each point below 6 gives 1 flat. Applied once per formula
    // regardless of how many statmod terms appear (STATMOD is
    // conceptually a single bonus even if composed of multiple
    // *MOD references).
    const hasPenalty = opts.penaltyPct > 0 && (
      roll.dicePool !== roll.dicePoolReduced
    );
    const pool = opts.showRaw ? roll.dicePool : roll.dicePoolReduced;
    const baseFlat = roll.flatBonus;      // penalty no longer affects flat
    const hasStatmod = roll.flatSlots.some(s => s.category === 'statmod');
    // Difficulty-STATMOD coupling — attack only, and only if the
    // formula actually references a STATMOD.
    const diffStatmodShift = (opts.isAttack && hasStatmod && finalDiff != null)
      ? (6 - finalDiff)
      : 0;
    const flat = baseFlat + diffStatmodShift;
    const rawKey = opts.isAttack ? 'showRawAttack' : 'showRawDamage';
    const toggleAttrs = hasPenalty
      ? `onclick="invWeaponToggleRaw('${escapeHtml(entry.id)}','${escapeHtml(rawKey)}')" style="cursor:pointer" title="Click to ${opts.showRaw ? 'apply' : 'remove'} ${opts.penaltyPct}% Penalty"`
      : '';

    // Main display: dice pool + flat bonus.
    const flatStr = flat === 0 ? '' :
                    (flat > 0 ? ` + ${flat}` : ` − ${Math.abs(flat)}`);
    const dicePart = `<span class="inv-weapon-roll-pool">${pool}D10</span>`;
    const flatPart = flat !== 0
      ? `<span class="inv-weapon-roll-flat">${flatStr}</span>`
      : '';

    // Penalty badge — tiny pill next to the main value. Only shown
    // when penalty is actually reducing the dice pool. (Penalty no
    // longer affects flat bonus so the badge is pool-only now.)
    const penaltyBadge = hasPenalty
      ? `<span class="inv-weapon-penalty-pill">${opts.showRaw ? 'raw' : `−${opts.penaltyPct}%`}</span>`
      : '';

    // Slot breakdown — one per term. Color by category: stat/statmod
    // with penalty-reduction visual when active; skill with tier
    // badge; weapon consts in neutral. Stat and skill slots become
    // <select> pickers so the user can swap the variable (writes to
    // entry.weaponOverrides).
    //
    // We pair each live slot with the SAME POSITION in the pre-override
    // resolve (opts.defaultSlots). That pre-override slot's label is
    // the ORIGINAL variable name, which is what we need as the
    // override-map key. If the two result arrays happen to differ in
    // length (shouldn't in normal operation), we fall back to using
    // the live slot's own label.
    const defaultSlots = Array.isArray(opts.defaultSlots) ? opts.defaultSlots : null;
    const pairSlot = (liveSlot, i) => {
      const def = defaultSlots && defaultSlots[i];
      const fromVar = (def && def.label) ? def.label : liveSlot.label;
      return renderWeaponSlot(entry, liveSlot, opts, fromVar, which);
    };
    // diceSlots + flatSlots concat follows the same order in both
    // resolves (extractAdditiveTerms walks the AST deterministically).
    // Indexing starts at 0 and runs across both arrays, so dice slots
    // use indices 0..N-1 and flat slots start at N.
    const diceCount = roll.diceSlots.length;
    const diceSlotsHtml = roll.diceSlots.map((s, i) => pairSlot(s, i)).join('');
    const flatSlotsHtml = roll.flatSlots.length > 0
      ? '<br>' + roll.flatSlots.map((s, i) => pairSlot(s, diceCount + i)).join('')
      : '';

    // Difficulty row — attack only. Uses the finalDiff + chips already
    // computed at the top of this function. Also shows the STATMOD
    // coupling as a separate chip when the formula references any
    // statmod (so the player can see the flat-bonus shift).
    let difficultyHtml = '';
    if (opts.isAttack && finalDiff != null) {
      // Add a STATMOD-shift chip to the chips row when it applies.
      let augmentedChipsHtml = diffChipsHtml;
      if (diffStatmodShift !== 0) {
        const sign = diffStatmodShift > 0 ? '+' : '−';
        const cls = diffStatmodShift > 0 ? 'mitigation' : 'penalty';
        const title = diffStatmodShift > 0
          ? `STATMOD +${diffStatmodShift} (Difficulty ${finalDiff} is ${Math.abs(diffStatmodShift)} below base 6)`
          : `STATMOD ${diffStatmodShift} (Difficulty ${finalDiff} is ${Math.abs(diffStatmodShift)} above base 6)`;
        augmentedChipsHtml += `<span class="inv-weapon-diff-chip ${cls}" title="${escapeHtml(title)}">${sign}${Math.abs(diffStatmodShift)} STATMOD</span>`;
      }
      difficultyHtml = `<div class="inv-weapon-diff-row">
        <span class="inv-weapon-diff-label">Difficulty</span>
        <span class="inv-weapon-diff-val">${finalDiff}</span>
        ${augmentedChipsHtml ? `<span class="inv-weapon-diff-chips">${augmentedChipsHtml}</span>` : ''}
      </div>`;
    }

    // ATK input — damage block only. Two modes:
    //   - placeholder: no atkResult entered. Shows "[ATK]" text and a
    //     small "+" button to reveal an input.
    //   - filled: atkResult present. Shows the number with a clear (×)
    //     button. The damage dice pool above ALREADY reflects the
    //     added ATK (resolver bakes it in), so no further math needed.
    let atkRowHtml = '';
    if (!opts.isAttack) {
      const atk = opts.atkResult;
      if (atk == null) {
        atkRowHtml = `<div class="inv-weapon-atk-row">
          <span class="inv-weapon-atk-label">ATK result</span>
          <span class="inv-weapon-atk-placeholder" title="The total from your attack roll (the contested result). Add it so this damage pool shows the real final number.">
            [not rolled]
          </span>
          <input type="number" class="inv-weapon-atk-input" placeholder="e.g. 5"
                 onchange="invWeaponSetAtk('${escapeHtml(entry.id)}',this.value)"
                 onkeydown="if(event.key==='Enter'){invWeaponSetAtk('${escapeHtml(entry.id)}',this.value);}">
        </div>`;
      } else {
        atkRowHtml = `<div class="inv-weapon-atk-row">
          <span class="inv-weapon-atk-label">ATK result</span>
          <span class="inv-weapon-atk-val">${atk}</span>
          <button class="inv-weapon-atk-clear" onclick="invWeaponSetAtk('${escapeHtml(entry.id)}','')" title="Clear — start a new attack">×</button>
          <span class="inv-weapon-atk-note">already rolled in to the dice pool above</span>
        </div>`;
      }
    }

    return `<div class="inv-weapon-roll">
      <div class="inv-weapon-roll-label">${label}</div>
      <div class="inv-weapon-roll-main" ${toggleAttrs}>${dicePart}${flatPart}${penaltyBadge}</div>
      <div class="inv-weapon-roll-slots">${diceSlotsHtml}${flatSlotsHtml}</div>
      ${difficultyHtml}
      ${atkRowHtml}
      <button class="inv-weapon-roll-send" onclick="invWeaponToRollCalc('${escapeHtml(entry.id)}','${which}')" title="Send this roll to the Roll Calculator">→ Roll Calc</button>
    </div>`;
  }

  // Single slot (term) in a roll's breakdown. Color-coded by category:
  //   stat / statmod — orange-ish, shown with the penalty-reduced
  //                    value when Penalty is in effect
  //   skill          — cyan, with tier badge (P/S/Sp for primary/secondary/specialty)
  //   weaponConst    — neutral gray (DMG, PEN, ATK)
  //   literal        — gray (rare — raw numbers in the formula)
  //
  // For stat and skill slots, the label becomes a native `<select>` so
  // the user can swap the variable without navigating away. Changing
  // the select calls invWeaponSetSlotOverride which writes to
  // entry.weaponOverrides and re-renders.
  //
  // Arguments:
  //   entry    — inventory entry (for the id in onchange)
  //   slot     — the live (post-override) slot from the resolver
  //   opts     — roll-block opts (showRaw, penaltyPct, isAttack, ...)
  //   fromVar  — the ORIGINAL variable name at this slot position, used
  //              as the override-map key. Needed because `slot.label`
  //              already reflects the overridden identifier.
  //   whichRoll — 'attack' | 'damage', the override sub-map to target.
  function renderWeaponSlot(entry, slot, opts, fromVar, whichRoll) {
    const showRaw = !!opts.showRaw;
    const value = showRaw ? slot.value : (Number.isFinite(slot.valueReduced) ? slot.valueReduced : slot.value);
    const absVal = Math.abs(value);
    const signStr = slot.sign < 0 ? '−' : '';
    // Category color class — defined in the CSS block.
    let clsColor = 'inv-weapon-slot-const';
    if      (slot.category === 'stat')    clsColor = 'inv-weapon-slot-stat';
    else if (slot.category === 'statmod') clsColor = 'inv-weapon-slot-statmod';
    else if (slot.category === 'skill')   clsColor = 'inv-weapon-slot-skill';
    else if (slot.category === 'literal') clsColor = 'inv-weapon-slot-literal';
    else if (slot.category === 'unknown') clsColor = 'inv-weapon-slot-unknown';
    // Tier badge — tiny letter pill after skill name.
    let tierBadge = '';
    if (slot.category === 'skill' && slot.skillTier) {
      const letter = slot.skillTier === 'primary' ? 'P'
                   : slot.skillTier === 'secondary' ? 'S'
                   : slot.skillTier === 'specialty' ? 'Sp'
                   : '';
      if (letter) tierBadge = `<span class="inv-weapon-tier-badge ${slot.skillTier}" title="${slot.skillTier}">${letter}</span>`;
    }
    // Reduction indicator — show a tiny "(was N)" when we're viewing
    // penalty-reduced and it's actually reduced from the raw value.
    let reductionHint = '';
    if (!showRaw && slot.valueReduced != null && Math.abs(slot.value) !== Math.abs(slot.valueReduced)) {
      reductionHint = ` <span class="inv-weapon-slot-was">(was ${Math.abs(slot.value)})</span>`;
    }

    // Decide whether this slot gets a picker. Stats and skills do;
    // statmods (derived from their base stat, not independently
    // pickable), weapon constants, literals, and unknowns don't.
    const pickable = (slot.category === 'stat' || slot.category === 'skill')
                     && fromVar && whichRoll;
    if (!pickable) {
      return `<span class="inv-weapon-roll-slot ${clsColor}">${escapeHtml(slot.label)}${tierBadge}:${signStr}${absVal}${reductionHint}</span>`;
    }

    // Build the select. Current value (slot.label) is pre-selected.
    // Options come from buildSlotPickerOptions which looks at the
    // ruleset (stats) or the character (skills across tiers).
    const picker = buildSlotPickerOptions(slot.category);
    const idAttr = escapeHtml(entry.id);
    const fromAttr = escapeHtml(fromVar);
    const rollAttr = escapeHtml(whichRoll);
    const currentLabel = slot.label;

    let optsHtml = '';
    if (picker.flat) {
      optsHtml = picker.flat.map(o => {
        const sel = (o.value === currentLabel) ? ' selected' : '';
        return `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(o.label)}</option>`;
      }).join('');
    } else if (Array.isArray(picker.groups)) {
      optsHtml = picker.groups.map(g => {
        if (!g.items || g.items.length === 0) return '';
        const items = g.items.map(o => {
          // Match against both the raw label (for exact-name skills
          // like "Melee") and the sanitized form (for spaces → none),
          // since the current slot label comes back sanitized.
          const sanitized = String(o.value).replace(/[^A-Za-z0-9_]+/g, '');
          const sel = (o.value === currentLabel || sanitized === currentLabel) ? ' selected' : '';
          return `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(o.label)}</option>`;
        }).join('');
        return `<optgroup label="${escapeHtml(g.label)}">${items}</optgroup>`;
      }).join('');
    }

    // If the current slot's value is missing from the picker (e.g. a
    // formula variable the character doesn't have a matching skill
    // for), inject it as a disabled option so the select still shows
    // something sensible rather than defaulting to option[0].
    if (optsHtml.indexOf(' selected>') === -1) {
      optsHtml = `<option value="${escapeHtml(currentLabel)}" selected disabled>${escapeHtml(currentLabel)} (unknown)</option>${optsHtml}`;
    }

    const select = `<select class="inv-weapon-slot-select"
                            onchange="invWeaponSetSlotOverride('${idAttr}','${rollAttr}','${fromAttr}',this.value)"
                            title="Swap this slot for a different ${slot.category}. Select the original to reset.">
      ${optsHtml}
    </select>`;
    return `<span class="inv-weapon-roll-slot ${clsColor}">${select}${tierBadge}:${signStr}${absVal}${reductionHint}</span>`;
  }

  // AMMO tracker chip — shows "current / max" with +/- buttons. The
  // max comes from the resolved AMMO formula; current is stored on
  // entry.currentAmmo (lazy-init to max on first interaction so melee
  // entries and freshly-added ranged ones don't litter with initial
  // currentAmmo values). Decrement fires invWeaponDecAmmo which
  // writes entry.currentAmmo and saves.
  function renderAmmoTracker(entry, resolved) {
    const ammo = resolved.ammo || { resolved: 0, raw: 0, error: null };
    if (ammo.error) {
      return `<span class="inv-weapon-chip" title="${escapeHtml(ammo.error)}"><span class="inv-weapon-chip-label">AMMO</span><span class="inv-weapon-chip-val" style="color:#cc6666">err</span></span>`;
    }
    const max = Number.isFinite(ammo.resolved) ? ammo.resolved : 0;
    // Lazy-init: entry.currentAmmo absent → treat as max.
    const cur = (typeof entry.currentAmmo === 'number')
      ? Math.max(0, Math.min(max, entry.currentAmmo))
      : max;
    const canEdit = getCanEdit();
    const formulaTip = (typeof ammo.raw === 'string' && ammo.raw !== String(ammo.resolved))
      ? ` (${ammo.raw})` : '';
    return `<span class="inv-weapon-ammo" title="AMMO ${cur}/${max}${formulaTip}">
      <span class="inv-weapon-chip-label">AMMO</span>
      ${canEdit ? `<button class="inv-weapon-ammo-btn" onclick="invWeaponAdjustAmmo('${escapeHtml(entry.id)}',-1)" ${cur <= 0 ? 'disabled' : ''} title="Spend 1 AMMO">−</button>` : ''}
      <span class="inv-weapon-ammo-val">${cur}</span>
      <span class="inv-weapon-ammo-sep">/</span>
      <span class="inv-weapon-ammo-max">${max}</span>
      ${canEdit ? `<button class="inv-weapon-ammo-btn" onclick="invWeaponAdjustAmmo('${escapeHtml(entry.id)}',1)" ${cur >= max ? 'disabled' : ''} title="Reload 1 AMMO">+</button>` : ''}
      ${canEdit ? `<button class="inv-weapon-ammo-btn" onclick="invWeaponReloadAmmo('${escapeHtml(entry.id)}')" title="Reload to max" style="width:auto;padding:0 6px;font-size:9px;letter-spacing:.05em">FULL</button>` : ''}
    </span>`;
  }

  // ROF chip — shows the level + flavor label. rofFlavor maps -1..4
  // to Single-Fire / Action / Semi / Auto / Full / Chain.
  function renderRofChip(resolved) {
    const rof = resolved.rof || { resolved: 0, raw: 0, error: null };
    if (rof.error) {
      return `<span class="inv-weapon-chip" title="${escapeHtml(rof.error)}"><span class="inv-weapon-chip-label">ROF</span><span class="inv-weapon-chip-val" style="color:#cc6666">err</span></span>`;
    }
    const level = Number.isFinite(rof.resolved) ? rof.resolved : 0;
    const flavor = rofFlavor(level);
    const label = flavor ? `${level} · ${flavor.label}` : String(level);
    const tip = flavor ? `${flavor.label} — approx ${flavor.perAmmo} projectile${flavor.perAmmo === 1 ? '' : 's'} per ammo` : '';
    return `<span class="inv-weapon-chip" title="${escapeHtml(tip)}"><span class="inv-weapon-chip-label">ROF</span><span class="inv-weapon-chip-val">${escapeHtml(label)}</span></span>`;
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

    // Weapon block — equipment only. Renders underneath the container
    // toggle so an item can be BOTH a weapon AND a container (think
    // a staff with a hidden compartment — unusual but not
    // impossible). Container-kind defs skip this entirely.
    if (defKind === 'equipment') {
      html += renderCatalogManagerWeaponBlock(d, def.id);
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

    // Weapon block — equipment only, same as the edit form. Routes
    // through invCatMgrNewDraft / *-NewWeapon* handlers via the
    // '__new__' target sentinel.
    if (kind === 'equipment') {
      html += renderCatalogManagerWeaponBlock(d, '__new__');
    }

    html += `<div class="inv-edit-panel-actions">
      <button class="inv-add-btn" onclick="invCatMgrSaveNew()">Save to Catalogue</button>
      <button class="inv-add-btn inv-add-btn-ghost" onclick="invCatMgrCancelNew()">Cancel</button>
    </div>`;

    html += `</div>`;
    return html;
  }

  // Shared weapon-block renderer used by both the edit form and the
  // new form. Parameterized by `target`: pass a def id for edit mode
  // (all mutations route through invCatMgrDraft / invCatMgrWeaponRange
  // / invCatMgrWeaponTag with the def id), or pass the sentinel
  // '__new__' for the new-item form (routes through invCatMgrNewDraft
  // and the new-specific variants).
  //
  // The block only renders for equipment-kind drafts — containers
  // can't be weapons (you don't attack with a backpack). Container
  // forms simply skip this block entirely.
  //
  // Data shape on the draft:
  //   isWeapon:       bool     — master toggle; false hides everything below
  //   weaponKind:     'melee' | 'ranged'
  //   weaponDice:     number   — D10 count for damage dice
  //   weaponPen:      number   — armor pierced
  //   weaponRanges:   [{s,e},...]  — melee only. Stored as objects
  //                                    not [s,e] tuples because
  //                                    Firestore rejects nested arrays.
  //   weaponRange:    number   — ranged only, base range in feet
  //   weaponDmgmod:   number   — ranged only, flat damage bonus + recoil req
  //   weaponAmmo:     string   — number OR formula (preserved as-entered)
  //   weaponRof:      string   — number OR formula
  //   weaponTags:     string[] — array of ruleset weapon tag ids
  function renderCatalogManagerWeaponBlock(draft, target) {
    // Routing table — build onclick/oninput call sites based on which
    // form this block is inside. Three targets:
    //   def.id (e.g. 'eq_blah')   — existing personal-catalogue row
    //                               being edited (catMgr)
    //   '__new__'                 — the personal-catalogue "new item"
    //                               form (catMgr)
    //   '__custom__'              — the one-off custom item modal
    //                               (renderCustomForm)
    const isNew    = (target === '__new__');
    const isCustom = (target === '__custom__');
    // Field update site. CatMgr edit uses 3-arg (id,field,value);
    // CatMgr new and custom form both use 2-arg (field,value) against
    // different module handlers.
    const upd = (field, valExpr) => {
      if (isCustom) return `invUpdateCustomDraft('${escapeHtml(field)}',${valExpr})`;
      if (isNew)    return `invCatMgrNewDraft('${escapeHtml(field)}',${valExpr})`;
      return `invCatMgrDraft('${escapeHtml(target)}','${escapeHtml(field)}',${valExpr})`;
    };
    const rngAdd    = () => {
      if (isCustom) return `invCustomDraftWeaponAddRange()`;
      if (isNew)    return `invCatMgrNewWeaponAddRange()`;
      return `invCatMgrWeaponAddRange('${escapeHtml(target)}')`;
    };
    const rngRemove = (bi) => {
      if (isCustom) return `invCustomDraftWeaponRemoveRange(${bi})`;
      if (isNew)    return `invCatMgrNewWeaponRemoveRange(${bi})`;
      return `invCatMgrWeaponRemoveRange('${escapeHtml(target)}',${bi})`;
    };
    const rngUpdate = (bi, which) => {
      if (isCustom) return `invCustomDraftWeaponUpdateRange(${bi},'${which}',this.value)`;
      if (isNew)    return `invCatMgrNewWeaponUpdateRange(${bi},'${which}',this.value)`;
      return `invCatMgrWeaponUpdateRange('${escapeHtml(target)}',${bi},'${which}',this.value)`;
    };
    const tagToggle = (tagId) => {
      if (isCustom) return `invCustomDraftWeaponToggleTag('${escapeHtml(tagId)}',this.checked)`;
      if (isNew)    return `invCatMgrNewWeaponToggleTag('${escapeHtml(tagId)}',this.checked)`;
      return `invCatMgrWeaponToggleTag('${escapeHtml(target)}','${escapeHtml(tagId)}',this.checked)`;
    };

    const isWeapon = !!draft.isWeapon;

    // Toggle row — master on/off for the weapon block. Same visual
    // pattern as "Also a container."
    let html = `<div class="inv-toggle-row">
      <span class="inv-toggle${isWeapon ? ' on' : ''}" onclick="${upd('isWeapon', !isWeapon)}">${isWeapon ? '✓ Also a weapon' : 'Also a weapon'}</span>
      <span class="inv-toggle-hint">Turn on to make this a weapon — reveals damage dice, PEN, range, and tags. Roll formulas come from the ruleset.</span>
    </div>`;

    if (!isWeapon) return html;

    const kind = draft.weaponKind === 'ranged' ? 'ranged' : 'melee';
    const dice   = Number.isFinite(draft.weaponDice)   ? draft.weaponDice   : 0;
    const pen    = Number.isFinite(draft.weaponPen)    ? draft.weaponPen    : 0;
    const range  = Number.isFinite(draft.weaponRange)  ? draft.weaponRange  : 0;
    const dmgmod = Number.isFinite(draft.weaponDmgmod) ? draft.weaponDmgmod : 0;

    html += `<div class="inv-container-block">
      <div class="inv-container-block-title">Weapon Properties</div>

      <div class="inv-pair-row">
        <div class="inv-field" style="max-width:200px">
          <label>Kind</label>
          <select onchange="${upd('weaponKind', 'this.value')}">
            <option value="melee"${kind === 'melee' ? ' selected' : ''}>Melee</option>
            <option value="ranged"${kind === 'ranged' ? ' selected' : ''}>Ranged</option>
          </select>
        </div>
        <div class="inv-field" style="max-width:120px">
          <label>Damage Dice</label>
          <input type="number" step="1" min="0" value="${escapeHtml(String(dice))}"
                 oninput="${upd('weaponDice', 'this.value')}">
        </div>
        <div class="inv-field" style="max-width:120px">
          <label>PEN</label>
          <input type="number" step="1" min="0" value="${escapeHtml(String(pen))}"
                 oninput="${upd('weaponPen', 'this.value')}">
        </div>
      </div>`;

    if (kind === 'melee') {
      const ranges = Array.isArray(draft.weaponRanges) ? draft.weaponRanges : [];
      html += `<div class="inv-field">
        <label>Range Bands (feet)</label>
        <div style="font-size:10px;color:#666;line-height:1.4;margin-bottom:4px">
          Each band adds +1 Difficulty over the previous. Band 0 is +0, Band 1 is +1, etc. Leave empty for trivial range.
        </div>`;
      if (ranges.length === 0) {
        html += `<div style="font-size:11px;color:#666;padding:4px 0">No range bands defined.</div>`;
      } else {
        ranges.forEach((band, bi) => {
          // Support both {s,e} (new) and [s,e] (legacy). Defensive reads
          // so half-migrated data still renders.
          const s = (band && typeof band === 'object' && !Array.isArray(band))
            ? (Number.isFinite(band.s) ? band.s : 0)
            : (Array.isArray(band) && Number.isFinite(band[0]) ? band[0] : 0);
          const e = (band && typeof band === 'object' && !Array.isArray(band))
            ? (Number.isFinite(band.e) ? band.e : 0)
            : (Array.isArray(band) && Number.isFinite(band[1]) ? band[1] : 0);
          html += `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
            <span style="font-size:11px;color:#888;min-width:58px">Band ${bi} (+${bi})</span>
            <input type="number" step="0.5" min="0" value="${escapeHtml(String(s))}" placeholder="Start"
                   style="max-width:80px"
                   oninput="${rngUpdate(bi, 'start')}">
            <span style="color:#666">–</span>
            <input type="number" step="0.5" min="0" value="${escapeHtml(String(e))}" placeholder="End"
                   style="max-width:80px"
                   oninput="${rngUpdate(bi, 'end')}">
            <span style="color:#666;font-size:11px">ft</span>
            <span class="delete-x" style="margin-left:6px"
                  onclick="${rngRemove(bi)}" title="Remove band">×</span>
          </div>`;
        });
      }
      html += `<button class="inv-add-btn inv-add-btn-sm inv-add-btn-ghost" style="margin-top:4px"
                      onclick="${rngAdd()}">+ Add Band</button>
      </div>`;
    } else {
      // ranged
      const ammo = (draft.weaponAmmo == null) ? '' : String(draft.weaponAmmo);
      const rof  = (draft.weaponRof  == null) ? '' : String(draft.weaponRof);
      html += `<div class="inv-pair-row">
        <div class="inv-field" style="max-width:140px">
          <label>Base Range (ft)</label>
          <input type="number" step="1" min="0" value="${escapeHtml(String(range))}"
                 oninput="${upd('weaponRange', 'this.value')}">
          <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">+0 within base, +1 (R→2R), +2 (2R→3R), longshot ×3 per band after.</div>
        </div>
        <div class="inv-field" style="max-width:120px">
          <label>Weapon DMGMOD</label>
          <input type="number" step="1" value="${escapeHtml(String(dmgmod))}"
                 oninput="${upd('weaponDmgmod', 'this.value')}">
          <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">Flat damage bonus + sets Recoil STR requirement.</div>
        </div>
      </div>
      <div class="inv-pair-row">
        <div class="inv-field">
          <label>AMMO (number or formula)</label>
          <input type="text" value="${escapeHtml(ammo)}" placeholder="e.g. 6  or  STR"
                 oninput="${upd('weaponAmmo', 'this.value')}">
          <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">Literal magazine size or a formula like <code>STR</code> or <code>DEXMOD+2</code>.</div>
        </div>
        <div class="inv-field">
          <label>ROF (number or formula)</label>
          <input type="text" value="${escapeHtml(rof)}" placeholder="e.g. 1  or  (DEXMOD/2)-1"
                 oninput="${upd('weaponRof', 'this.value')}">
          <div style="font-size:10px;color:#666;line-height:1.4;margin-top:2px">-1 Single · 0 Action · 1 Semi · 2 Auto · 3 Full · 4 Chain.</div>
        </div>
      </div>`;
    }

    // Tag checkboxes — pulled from the active ruleset's catalogue.
    // Empty ruleset shows a hint. Tooltip carries the description.
    const ruleset = getRuleset() || {};
    const rsTags = Array.isArray(ruleset.weaponTags) ? ruleset.weaponTags : [];
    const tagIds = Array.isArray(draft.weaponTags) ? draft.weaponTags : [];
    html += `<div class="inv-field">
      <label>Tags</label>`;
    if (rsTags.length === 0) {
      html += `<div style="font-size:11px;color:#888;padding:4px 0">This ruleset has no weapon tags defined. The ruleset author can add them under Derived Stats &amp; Combat → Weapon Tags.</div>`;
    } else {
      html += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">`;
      rsTags.forEach(t => {
        const checked = tagIds.includes(t.id) ? ' checked' : '';
        const name = escapeHtml(t.name || t.id);
        const desc = escapeHtml(t.description || '');
        html += `<label style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;font-size:11px;cursor:pointer" title="${desc}">
          <input type="checkbox"${checked} onchange="${tagToggle(t.id)}">
          ${name}
        </label>`;
      });
      html += `</div>`;
    }
    html += `</div></div>`;   // /inv-container-block

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
    // Weapon fields — only relevant for equipment defs (container
    // defs can't be weapons). If the def has a weapon block, seed all
    // its fields; otherwise the draft gets isWeapon=false and empty
    // defaults, so toggling the weapon on in the form reveals them.
    // Tags are copied as a fresh array so edits don't mutate the def
    // until save.
    const w = (defKind === 'equipment' && def.weapon) ? def.weapon : null;
    const weaponFields = {
      isWeapon:       !!w,
      weaponKind:     w ? (w.kind || 'melee') : 'melee',
      weaponDice:     w && Number.isFinite(w.dice)   ? w.dice   : 1,
      weaponPen:      w && Number.isFinite(w.pen)    ? w.pen    : 0,
      weaponRanges:   w && Array.isArray(w.ranges)
                        ? w.ranges.map(b => {
                            if (b && typeof b === 'object' && !Array.isArray(b)) {
                              return {
                                s: Number.isFinite(b.s) ? b.s : 0,
                                e: Number.isFinite(b.e) ? b.e : 0
                              };
                            }
                            if (Array.isArray(b) && b.length >= 2) {
                              return {
                                s: Number.isFinite(b[0]) ? b[0] : 0,
                                e: Number.isFinite(b[1]) ? b[1] : 0
                              };
                            }
                            return { s: 0, e: 0 };
                          })
                        : [],
      weaponRange:    w && Number.isFinite(w.range)  ? w.range  : 30,
      weaponDmgmod:   w && Number.isFinite(w.dmgmod) ? w.dmgmod : 0,
      // ammo/rof can be a number OR a formula string; draft stores the
      // same shape the form typed in, save coerces.
      weaponAmmo:     w ? (w.ammo != null ? String(w.ammo) : '1') : '1',
      weaponRof:      w ? (w.rof  != null ? String(w.rof)  : '0') : '0',
      weaponTags:     w && Array.isArray(w.tags) ? w.tags.slice() : []
    };
    catalogManager.drafts.set(def.id, Object.assign({
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
    }, weaponFields));
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
    applyDraftField(d, field, value, /*isNew=*/false);
  }

  // Save the draft back to the def and persist.
  // ── Weapon range-band + tag handlers ──
  //
  // Range bands are stored as an array of [start, end] pairs. Adding
  // a band chains start = previous band's end, so typing 0-1, 1-2,
  // 2-3 is quick. Removing a band splices. Tag toggles flip the
  // ruleset-tag-id in or out of the weaponTags array.
  //
  // Two variants exist: one targets an EDIT draft (looked up by defId
  // in catalogManager.drafts), the other targets the NEW draft
  // (catalogManager.newDraft). The split exists because the two
  // drafts have different lookup keys — there's no way to write a
  // single handler covering both without introducing a sentinel
  // argument everywhere, and the variants are just thin wrappers.

  function _getEditDraft(defId) {
    return catalogManager.drafts.get(defId);
  }
  function _getNewDraft() {
    return catalogManager.newDraft;
  }

  // Helpers working on any draft (edit or new) — pass the draft in.
  // Range bands are stored as {s, e} objects because Firestore doesn't
  // support nested arrays. Legacy [s, e] entries get converted in
  // place on first touch.
  function _weaponAddRange(d) {
    if (!d) return;
    if (!Array.isArray(d.weaponRanges)) d.weaponRanges = [];
    const prev = d.weaponRanges[d.weaponRanges.length - 1];
    const prevEnd = prev
      ? (prev && typeof prev === 'object' && !Array.isArray(prev)
          ? (Number(prev.e) || 0)
          : (Array.isArray(prev) ? (Number(prev[1]) || 0) : 0))
      : 0;
    d.weaponRanges.push({ s: prevEnd, e: prevEnd + 1 });
    renderCatalogManager();
  }
  function _weaponRemoveRange(d, bandIdx) {
    if (!d || !Array.isArray(d.weaponRanges)) return;
    d.weaponRanges.splice(bandIdx, 1);
    renderCatalogManager();
  }
  function _weaponUpdateRange(d, bandIdx, which, value) {
    if (!d || !Array.isArray(d.weaponRanges)) return;
    let band = d.weaponRanges[bandIdx];
    if (!band) return;
    // Convert legacy [s, e] in place to the {s, e} shape.
    if (Array.isArray(band)) {
      band = { s: Number(band[0]) || 0, e: Number(band[1]) || 0 };
      d.weaponRanges[bandIdx] = band;
    }
    const n = parseFloat(value);
    const safe = Number.isFinite(n) && n >= 0 ? n : 0;
    if (which === 'start') band.s = safe;
    else if (which === 'end') band.e = safe;
    // No re-render — user might still be typing the other side.
  }
  function _weaponToggleTag(d, tagId, on) {
    if (!d) return;
    if (!Array.isArray(d.weaponTags)) d.weaponTags = [];
    const idx = d.weaponTags.indexOf(tagId);
    if (on && idx < 0) d.weaponTags.push(tagId);
    else if (!on && idx >= 0) d.weaponTags.splice(idx, 1);
    // No re-render — checkbox visual handled by browser.
  }

  // Edit-draft variants — wire up via invCatMgrWeapon* window handlers.
  function catMgrWeaponAddRange(defId)                       { _weaponAddRange(_getEditDraft(defId)); }
  function catMgrWeaponRemoveRange(defId, bandIdx)           { _weaponRemoveRange(_getEditDraft(defId), bandIdx); }
  function catMgrWeaponUpdateRange(defId, bandIdx, w, value) { _weaponUpdateRange(_getEditDraft(defId), bandIdx, w, value); }
  function catMgrWeaponToggleTag(defId, tagId, on)           { _weaponToggleTag(_getEditDraft(defId), tagId, on); }

  // New-draft variants — invCatMgrNewWeapon* window handlers.
  function catMgrNewWeaponAddRange()                       { _weaponAddRange(_getNewDraft()); }
  function catMgrNewWeaponRemoveRange(bandIdx)             { _weaponRemoveRange(_getNewDraft(), bandIdx); }
  function catMgrNewWeaponUpdateRange(bandIdx, w, value)   { _weaponUpdateRange(_getNewDraft(), bandIdx, w, value); }
  function catMgrNewWeaponToggleTag(tagId, on)             { _weaponToggleTag(_getNewDraft(), tagId, on); }

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
      // Weapon block — equipment only. If the draft has isWeapon on,
      // write a coerced weapon object; otherwise clear to null so an
      // item that used to be a weapon but isn't anymore doesn't keep
      // stale data.
      def.weapon = d.isWeapon ? buildWeaponFromDraft(d) : null;
    }

    // Drop the draft and close the row.
    catalogManager.drafts.delete(defId);
    catalogManager.expandedDefIds.delete(defId);
    renderCatalogManager();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Coerce a flat draft's weapon fields into the def.weapon schema.
  // Mirrors coerceWeapon in ruleset-defaults.js — if the draft data is
  // malformed the returned object may not match the coercer's output
  // exactly, but the coercer runs again at ruleset-load time so any
  // drift gets cleaned up on the next session. We're just building a
  // "best effort" save shape here.
  function buildWeaponFromDraft(d) {
    const kind = d.weaponKind === 'ranged' ? 'ranged' : 'melee';
    const dice = Number.isFinite(d.weaponDice) ? Math.max(0, Math.floor(d.weaponDice)) : 0;
    const pen  = Number.isFinite(d.weaponPen)  ? Math.max(0, Math.floor(d.weaponPen))  : 0;
    const tags = Array.isArray(d.weaponTags) ? d.weaponTags.slice() : [];
    if (kind === 'melee') {
      // Bands as {s, e} objects — Firestore doesn't accept nested
      // arrays. Accept either shape on input (legacy drafts may still
      // have [s, e]), normalize to objects on output.
      const ranges = Array.isArray(d.weaponRanges)
        ? d.weaponRanges.map(b => {
            let s, e;
            if (b && typeof b === 'object' && !Array.isArray(b)) {
              s = Number(b.s); e = Number(b.e);
            } else if (Array.isArray(b) && b.length >= 2) {
              s = Number(b[0]); e = Number(b[1]);
            } else {
              return null;
            }
            if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
            if (e < s) return null;
            return { s, e };
          }).filter(Boolean)
        : [];
      return { kind: 'melee', dice, pen, tags, ranges };
    }
    // ranged
    const range  = Number.isFinite(d.weaponRange)  ? Math.max(0, d.weaponRange)  : 0;
    const dmgmod = Number.isFinite(d.weaponDmgmod) ? d.weaponDmgmod : 0;
    // ammo/rof: store as number if the draft value is a clean numeric
    // string, otherwise preserve as formula string. Empty string → 0.
    const asNum = (raw, fallback) => {
      const s = (raw == null) ? '' : String(raw).trim();
      if (!s) return fallback;
      const n = Number(s);
      if (Number.isFinite(n) && s === String(n)) return n;
      return s;
    };
    return {
      kind: 'ranged',
      dice, pen, tags,
      range,
      dmgmod,
      ammo: asNum(d.weaponAmmo, 0),
      rof:  asNum(d.weaponRof,  0)
    };
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
      innerPacking: 0.75,
      // Weapon defaults — only surfaced in the form for equipment
      // kind. Container-kind drafts never see the weapon toggle.
      isWeapon: false,
      weaponKind: 'melee',
      weaponDice: 1,
      weaponPen: 0,
      weaponRanges: [],
      weaponRange: 30,
      weaponDmgmod: 0,
      weaponAmmo: '1',
      weaponRof:  '0',
      weaponTags: []
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
    applyDraftField(d, field, value, /*isNew=*/true);
  }

  // Shared field-application logic for both edit drafts and the new
  // draft. Centralizes the field-type dispatch: scalar numerics, the
  // container toggle (which needs a re-render to show/hide the
  // container fields), weapon-specific fields with their own numeric /
  // string / boolean rules, and fall-through for plain string fields.
  //
  // Fields that mutate the DOM structure (isWeapon, weaponKind,
  // alsoContainer) trigger a re-render; field edits that just change
  // a value (dice, PEN, range, ammo formula, etc.) skip the re-render
  // so the input keeps focus mid-typing. This mirrors the behavior
  // of the ruleset-side item editor.
  function applyDraftField(d, field, value, isNew) {
    // Dimensions / weights — numeric, >= 0.
    const nonNegativeNumeric = new Set(['weight','l','w','h','innerL','innerW','innerH','innerPacking']);
    if (nonNegativeNumeric.has(field)) {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) && n >= 0 ? n : 0;
      return;
    }

    // Container dual-role toggle — re-render so the container block
    // appears/disappears.
    if (field === 'alsoContainer') {
      d[field] = !!value;
      renderCatalogManager();
      return;
    }

    // ── Weapon fields ──
    if (field === 'isWeapon') {
      d.isWeapon = !!value;
      renderCatalogManager();   // show/hide the whole weapon block
      return;
    }
    if (field === 'weaponKind') {
      // Swapping kind wipes the old kind's data, same as the
      // ruleset-side item editor. The re-render reveals the new
      // kind-specific fields.
      if (value !== 'melee' && value !== 'ranged') return;
      d.weaponKind = value;
      if (value === 'melee') {
        // Going ranged → melee clears range-specific defaults so the
        // old range/dmgmod/ammo/rof don't linger invisibly.
        d.weaponRanges = d.weaponRanges || [];
      } else {
        // Going melee → ranged, seed defaults if they're missing.
        if (!Number.isFinite(d.weaponRange))  d.weaponRange  = 30;
        if (!Number.isFinite(d.weaponDmgmod)) d.weaponDmgmod = 0;
        if (d.weaponAmmo == null || d.weaponAmmo === '') d.weaponAmmo = '1';
        if (d.weaponRof  == null || d.weaponRof  === '') d.weaponRof  = '0';
      }
      renderCatalogManager();
      return;
    }
    if (field === 'weaponDice' || field === 'weaponPen' || field === 'weaponRange') {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) && n >= 0 ? n : 0;
      return;
    }
    if (field === 'weaponDmgmod') {
      // Allow negatives — some cursed/miscalibrated weapons have -N.
      const n = parseFloat(value);
      d.weaponDmgmod = Number.isFinite(n) ? n : 0;
      return;
    }
    if (field === 'weaponAmmo' || field === 'weaponRof') {
      // Stored as-typed so the user can enter either a plain number
      // ("6") or a formula ("STR" or "(DEXMOD/2)-1"). The save path
      // coerces pure-numeric strings into numbers before writing to
      // def.weapon.ammo / def.weapon.rof.
      d[field] = (typeof value === 'string') ? value : '';
      return;
    }

    // Default fallback — plain string fields (name, description).
    d[field] = typeof value === 'string' ? value : '';
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
        } : null,
        // Weapon block — only present when the draft had isWeapon on.
        // Null omitted for non-weapon equipment to keep the stored
        // shape minimal; the coercer handles missing vs null the same way.
        weapon: d.isWeapon ? buildWeaponFromDraft(d) : null
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
          </div>` : ''}
          ${renderCatalogManagerWeaponBlock(draft, '__custom__')}`}

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
      innerPacking: 0.75,
      // Weapon fields — match the schema used by the personal-catalogue
      // draft so renderCatalogManagerWeaponBlock + buildWeaponFromDraft
      // can be shared. `isWeapon` false means the weapon block is
      // collapsed and no weapon data gets attached to the snapshot on
      // save.
      isWeapon:      false,
      weaponKind:    'melee',
      weaponDice:    1,
      weaponPen:     0,
      weaponRanges:  [],
      weaponRange:   30,
      weaponDmgmod:  0,
      weaponAmmo:    '1',
      weaponRof:     '0',
      weaponTags:    []
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
    // Weapon numeric fields. PEN/dice/range can't go negative; dmgmod
    // is signed (for penalty weapons).
    const weaponNumericNonNeg = new Set(['weaponDice','weaponPen','weaponRange']);
    const weaponNumericSigned = new Set(['weaponDmgmod']);
    // Weapon text fields — stored as strings so formulas like "STR+1"
    // survive. buildWeaponFromDraft coerces numeric strings back to
    // numbers when saving.
    const weaponTextFields = new Set(['weaponAmmo','weaponRof']);

    if (numericFields.has(field)) {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else if (weaponNumericNonNeg.has(field)) {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } else if (weaponNumericSigned.has(field)) {
      const n = parseFloat(value);
      d[field] = Number.isFinite(n) ? Math.floor(n) : 0;
    } else if (weaponTextFields.has(field)) {
      d[field] = (value == null) ? '' : String(value);
    } else if (field === 'alsoContainer') {
      d[field] = !!value;
      renderActiveModal();
      return;
    } else if (field === 'isWeapon') {
      // Boolean toggle coming in as 'true'/'false' from the toggle
      // span's onclick-string, or as an actual boolean.
      d[field] = (value === true || value === 'true');
      renderActiveModal();
      return;
    } else if (field === 'weaponKind') {
      // Kind swap rebuilds the kind-specific fields on the draft so
      // switching melee↔ranged doesn't leave stale ranges or ammo.
      const v = (value === 'ranged') ? 'ranged' : 'melee';
      d.weaponKind = v;
      if (v === 'melee') {
        // Kill ranged-only fields so they don't leak into the save.
        d.weaponRanges = Array.isArray(d.weaponRanges) ? d.weaponRanges : [];
        d.weaponRange  = 0;
        d.weaponDmgmod = 0;
        d.weaponAmmo   = '0';
        d.weaponRof    = '0';
      } else {
        d.weaponRanges = [];
        d.weaponRange  = Number.isFinite(d.weaponRange) && d.weaponRange > 0 ? d.weaponRange : 30;
        d.weaponAmmo   = d.weaponAmmo || '1';
        d.weaponRof    = d.weaponRof  || '0';
      }
      renderActiveModal();
      return;
    } else {
      d[field] = typeof value === 'string' ? value : '';
    }
    // Most text/number tweaks don't need a re-render — the inputs are
    // self-updating. Only structural changes (toggles, kind-swap)
    // re-render above.
  }

  // Custom-form weapon range-band handlers. Mirror the catalog-manager
  // helpers but target activeModal.customDraft instead of
  // catalogManager.drafts, and call renderActiveModal() for UI refresh.
  // Band shape is { s, e } objects — Firestore doesn't allow nested
  // arrays, so we never emit [s, e] tuples.
  function customDraftWeaponAddRange() {
    if (!activeModal || !activeModal.customDraft) return;
    const d = activeModal.customDraft;
    if (!Array.isArray(d.weaponRanges)) d.weaponRanges = [];
    const prev = d.weaponRanges[d.weaponRanges.length - 1];
    const prevEnd = prev
      ? (prev && typeof prev === 'object' && !Array.isArray(prev)
          ? (Number(prev.e) || 0)
          : (Array.isArray(prev) ? (Number(prev[1]) || 0) : 0))
      : 0;
    d.weaponRanges.push({ s: prevEnd, e: prevEnd + 1 });
    renderActiveModal();
  }
  function customDraftWeaponRemoveRange(bandIdx) {
    if (!activeModal || !activeModal.customDraft) return;
    const d = activeModal.customDraft;
    if (!Array.isArray(d.weaponRanges)) return;
    d.weaponRanges.splice(bandIdx, 1);
    renderActiveModal();
  }
  function customDraftWeaponUpdateRange(bandIdx, which, value) {
    if (!activeModal || !activeModal.customDraft) return;
    const d = activeModal.customDraft;
    if (!Array.isArray(d.weaponRanges)) return;
    let band = d.weaponRanges[bandIdx];
    if (!band) return;
    if (Array.isArray(band)) {
      band = { s: Number(band[0]) || 0, e: Number(band[1]) || 0 };
      d.weaponRanges[bandIdx] = band;
    }
    const n = parseFloat(value);
    const safe = Number.isFinite(n) && n >= 0 ? n : 0;
    if (which === 'start') band.s = safe;
    else if (which === 'end') band.e = safe;
    // No re-render — user may still be typing the other side.
  }
  function customDraftWeaponToggleTag(tagId, on) {
    if (!activeModal || !activeModal.customDraft) return;
    const d = activeModal.customDraft;
    if (!Array.isArray(d.weaponTags)) d.weaponTags = [];
    const idx = d.weaponTags.indexOf(tagId);
    if (on && idx < 0) d.weaponTags.push(tagId);
    else if (!on && idx >= 0) d.weaponTags.splice(idx, 1);
    // Tag toggle doesn't re-render the whole modal — the checkbox
    // state is tracked by the browser. If we DID re-render, the
    // cursor position in any focused input would be lost.
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
    // Weapon block — same shape the ruleset's coerceWeapon produces,
    // built from the draft via buildWeaponFromDraft (shared with the
    // personal catalogue manager). Only attached when the user
    // toggled "Also a weapon"; containers never get one.
    if (!isContainer && d.isWeapon) {
      snapshot.weapon = buildWeaponFromDraft(d);
    } else {
      snapshot.weapon = null;
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

  // ── WEAPON HANDLERS ──
  //
  // AMMO bookkeeping lives on the entry itself (entry.currentAmmo) so
  // it's per-instance state rather than per-def. Lazy-init: if the
  // entry doesn't have currentAmmo yet, treat as full (max) on first
  // adjustment. This keeps snapshots clean for ranged weapons the
  // player hasn't interacted with, and means melee entries never
  // accidentally carry a currentAmmo number.

  // Compute the resolved AMMO max for a weapon entry. Returns null
  // when the entry isn't a ranged weapon or when the ammo formula
  // errors out (unresolved variables, parse failure). Callers should
  // treat null as "don't touch currentAmmo."
  function resolvedAmmoMax(entry) {
    const snap = entry && entry.snapshot;
    const weapon = snap && snap.weapon;
    if (!weapon || weapon.kind !== 'ranged') return null;
    const resolved = resolveWeapon(weapon, getCharData(), getRuleset());
    if (!resolved || !resolved.ammo || resolved.ammo.error) return null;
    const n = resolved.ammo.resolved;
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  }

  async function weaponAdjustAmmo(id, delta) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry) return;
    const max = resolvedAmmoMax(entry);
    if (max == null) return;
    // Lazy init: first interaction treats current as max.
    const cur = (typeof entry.currentAmmo === 'number')
      ? Math.max(0, Math.min(max, entry.currentAmmo))
      : max;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    entry.currentAmmo = next;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function weaponReloadAmmo(id) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry) return;
    const max = resolvedAmmoMax(entry);
    if (max == null) return;
    if (entry.currentAmmo === max) return;
    entry.currentAmmo = max;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Toggle the raw-vs-penalty-reduced display on a weapon's roll block.
  // rawKey is either 'showRawAttack' or 'showRawDamage' — which half of
  // the card to flip. State lives on entry.weaponUI so each inventory
  // item independently remembers which mode it's in. Saves to Firestore
  // so the toggle persists across sessions.
  async function weaponToggleRaw(id, rawKey) {
    const entry = findEntry(id);
    if (!entry) return;
    if (!entry.weaponUI || typeof entry.weaponUI !== 'object') entry.weaponUI = {};
    // Only these two keys are meaningful — guard against stray input.
    if (rawKey !== 'showRawAttack' && rawKey !== 'showRawDamage') return;
    entry.weaponUI[rawKey] = !entry.weaponUI[rawKey];
    renderAll();
    // Toggle state is a display preference so non-editors can flip it
    // in the UI too, but only editors have permission to persist. Skip
    // the save for read-only viewers.
    if (getCanEdit()) {
      try { await save(); } catch (e) { console.error('inventory save failed', e); }
    }
  }

  // Store an ATK contested result on a weapon entry. Empty string
  // clears the value (back to the "[not rolled]" placeholder). Accepts
  // numeric input — anything non-numeric clears. The resolver uses
  // entry.weaponUI.atkResult to inject ATK into the damage formula.
  async function weaponSetAtk(id, value) {
    const entry = findEntry(id);
    if (!entry) return;
    if (!entry.weaponUI || typeof entry.weaponUI !== 'object') entry.weaponUI = {};
    const raw = (value == null) ? '' : String(value).trim();
    if (!raw) {
      entry.weaponUI.atkResult = null;
    } else {
      const n = Number(raw);
      entry.weaponUI.atkResult = Number.isFinite(n) ? Math.floor(n) : null;
    }
    renderAll();
    if (getCanEdit()) {
      try { await save(); } catch (e) { console.error('inventory save failed', e); }
    }
  }

  // ─── WEAPON SNAPSHOT EDITING ─────────────────────────────────────
  //
  // Players can edit the intrinsic weapon stats per-instance by
  // flipping weaponUI.editOpen and writing to entry.snapshot.weapon
  // directly. Because snapshots are per-inventory-entry (deep-cloned
  // from the catalogue def at add-time), these edits only affect
  // this one character's copy of the weapon — the catalogue def is
  // untouched. Common use case: player picks up an improvised
  // weapon or a homebrew variant and wants to tweak dice/PEN/range
  // without creating a new catalogue entry.

  async function weaponToggleEdit(id) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry) return;
    if (!entry.weaponUI || typeof entry.weaponUI !== 'object') entry.weaponUI = {};
    entry.weaponUI.editOpen = !entry.weaponUI.editOpen;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Write a simple field on the weapon snapshot. Handles numeric
  // coercion for dice/pen/range/dmgmod and preserves ammo/rof as
  // numbers OR formula strings (same convention as catalogue editors).
  async function weaponSnapUpdate(id, field, value) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry || !entry.snapshot || !entry.snapshot.weapon) return;
    const w = entry.snapshot.weapon;
    const numericNonNeg = new Set(['dice', 'pen', 'range']);
    const numericSigned = new Set(['dmgmod']);
    const numOrFormula = new Set(['ammo', 'rof']);

    if (numericNonNeg.has(field)) {
      const n = parseFloat(value);
      w[field] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } else if (numericSigned.has(field)) {
      const n = parseFloat(value);
      w[field] = Number.isFinite(n) ? Math.floor(n) : 0;
    } else if (numOrFormula.has(field)) {
      const raw = (value == null) ? '' : String(value).trim();
      if (!raw) { w[field] = 0; }
      else {
        const n = Number(raw);
        w[field] = Number.isFinite(n) && raw === String(n) ? n : raw;
      }
    } else {
      return;   // unknown field — ignore
    }
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Kind swap — melee ↔ ranged. Wipes incompatible fields so stale
  // ranges or ammo don't leak into the wrong kind. Also clears any
  // formula overrides since the default formula shape differs between
  // kinds (DEX+Melee+DEXMOD vs DEX+Ranged+DEXMOD) and per-slot
  // overrides keyed to one kind's variable names make no sense on
  // the other.
  async function weaponSnapSetKind(id, newKind) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry || !entry.snapshot || !entry.snapshot.weapon) return;
    const target = (newKind === 'ranged') ? 'ranged' : 'melee';
    const w = entry.snapshot.weapon;
    if (w.kind === target) return;
    // Preserve shared fields (dice, pen, tags); rebuild kind-specific ones.
    const shared = {
      kind: target,
      dice: Number.isFinite(w.dice) ? w.dice : 0,
      pen:  Number.isFinite(w.pen)  ? w.pen  : 0,
      tags: Array.isArray(w.tags) ? w.tags.slice() : []
    };
    entry.snapshot.weapon = (target === 'melee')
      ? Object.assign(shared, { ranges: [] })
      : Object.assign(shared, { range: 30, dmgmod: 0, ammo: 1, rof: 0 });
    // Kind swap invalidates formula overrides (variable names changed).
    entry.weaponOverrides = null;
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  // Melee range band helpers. Bands stored as {s, e} objects
  // (Firestore-safe — no nested arrays). New bands continue from the
  // previous band's end so chained 0-1, 1-2, 2-3 is one click each.
  async function weaponSnapAddRange(id) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry || !entry.snapshot || !entry.snapshot.weapon) return;
    const w = entry.snapshot.weapon;
    if (w.kind !== 'melee') return;
    if (!Array.isArray(w.ranges)) w.ranges = [];
    const prev = w.ranges[w.ranges.length - 1];
    const prevEnd = prev
      ? (prev && typeof prev === 'object' && !Array.isArray(prev)
          ? (Number(prev.e) || 0)
          : (Array.isArray(prev) ? (Number(prev[1]) || 0) : 0))
      : 0;
    w.ranges.push({ s: prevEnd, e: prevEnd + 1 });
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function weaponSnapRemoveRange(id, bandIdx) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry || !entry.snapshot || !entry.snapshot.weapon) return;
    const w = entry.snapshot.weapon;
    if (!Array.isArray(w.ranges)) return;
    w.ranges.splice(bandIdx, 1);
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function weaponSnapUpdateRange(id, bandIdx, which, value) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry || !entry.snapshot || !entry.snapshot.weapon) return;
    const w = entry.snapshot.weapon;
    if (!Array.isArray(w.ranges)) return;
    let band = w.ranges[bandIdx];
    if (!band) return;
    // Legacy [s, e] entries get converted to {s, e} on first touch.
    if (Array.isArray(band)) {
      band = { s: Number(band[0]) || 0, e: Number(band[1]) || 0 };
      w.ranges[bandIdx] = band;
    }
    const n = parseFloat(value);
    const safe = Number.isFinite(n) && n >= 0 ? n : 0;
    if (which === 'start') band.s = safe;
    else if (which === 'end') band.e = safe;
    // No re-render — user might still be typing the other side. Save
    // on-change (browsers fire change on blur) captures the final value.
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function weaponSnapToggleTag(id, tagId, on) {
    if (!getCanEdit()) return;
    const entry = findEntry(id);
    if (!entry || !entry.snapshot || !entry.snapshot.weapon) return;
    const w = entry.snapshot.weapon;
    if (!Array.isArray(w.tags)) w.tags = [];
    const idx = w.tags.indexOf(tagId);
    if (on && idx < 0) w.tags.push(tagId);
    else if (!on && idx >= 0) w.tags.splice(idx, 1);
    renderAll();
    try { await save(); } catch (e) { console.error('inventory save failed', e); }
  }

  async function weaponSetRapidfire(id, value) {
    const entry = findEntry(id);
    if (!entry) return;
    if (!entry.weaponUI || typeof entry.weaponUI !== 'object') entry.weaponUI = {};
    const raw = (value == null) ? '' : String(value).trim();
    if (!raw) {
      entry.weaponUI.rapidfireExtra = 0;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        entry.weaponUI.rapidfireExtra = 0;
      } else {
        // Clamp to maxAmmo - 1 (need 1 for the base shot). Read from
        // the resolved AMMO max — ignores currentAmmo so the player
        // can plan a full burst even if their magazine isn't full,
        // then manually decrement when they actually fire.
        const max = resolvedAmmoMax(entry);
        const cap = (max == null) ? Math.floor(n) : Math.max(0, max - 1);
        entry.weaponUI.rapidfireExtra = Math.min(Math.floor(n), cap);
      }
    }
    renderAll();
    if (getCanEdit()) {
      try { await save(); } catch (e) { console.error('inventory save failed', e); }
    }
  }

  // Apply (or clear) a per-instance slot override on a weapon. The
  // override rewrites a single variable in the Attack or Damage
  // formula at resolve time — e.g. swap DEX for INT, or Melee for
  // KnifeFighting. If `toVar` equals `fromVar` (i.e. "back to
  // default"), the override entry is DELETED from the map so the
  // formula returns to the ruleset default.
  //
  // Arguments:
  //   id      — inventory entry id
  //   roll    — 'attack' | 'damage'
  //   fromVar — original variable name (the one in the ruleset formula)
  //   toVar   — new variable name (stat code or skill name). Empty
  //             string or fromVar clears the override.
  async function weaponSetSlotOverride(id, roll, fromVar, toVar) {
    const entry = findEntry(id);
    if (!entry) return;
    if (roll !== 'attack' && roll !== 'damage') return;
    if (!fromVar) return;
    if (!entry.weaponOverrides || typeof entry.weaponOverrides !== 'object') {
      entry.weaponOverrides = {};
    }
    if (!entry.weaponOverrides[roll] || typeof entry.weaponOverrides[roll] !== 'object') {
      entry.weaponOverrides[roll] = {};
    }
    const safeTo = (toVar == null) ? '' : String(toVar).trim();
    if (!safeTo || safeTo === fromVar) {
      delete entry.weaponOverrides[roll][fromVar];
    } else {
      entry.weaponOverrides[roll][fromVar] = safeTo;
    }
    // Clean up empty sub-objects so the "hasOverride" check stays
    // accurate even after toggling an override off.
    if (Object.keys(entry.weaponOverrides[roll]).length === 0) {
      delete entry.weaponOverrides[roll];
    }
    if (Object.keys(entry.weaponOverrides).length === 0) {
      entry.weaponOverrides = null;
    }
    renderAll();
    if (getCanEdit()) {
      try { await save(); } catch (e) { console.error('inventory save failed', e); }
    }
  }

  // Wipe all per-instance overrides and the current range back to the
  // weapon's default. Leaves ammo counter alone (that's not an
  // "override" per se — it's a gameplay state).
  async function weaponResetOverrides(id) {
    const entry = findEntry(id);
    if (!entry) return;
    let touched = false;
    if (entry.weaponOverrides) { entry.weaponOverrides = null; touched = true; }
    if (entry.currentRange != null) { entry.currentRange = null; touched = true; }
    if (entry.weaponUI && entry.weaponUI.atkResult != null) {
      entry.weaponUI.atkResult = null;
      touched = true;
    }
    if (entry.weaponUI && entry.weaponUI.rapidfireExtra > 0) {
      entry.weaponUI.rapidfireExtra = 0;
      touched = true;
    }
    if (!touched) return;
    renderAll();
    if (getCanEdit()) {
      try { await save(); } catch (e) { console.error('inventory save failed', e); }
    }
  }

  // Set the current engagement range for a weapon (in feet). Used to
  // compute the Range chip in the Attack's Difficulty row. Melee
  // weapons map the distance onto their range bands (+N difficulty
  // per band past 0). Ranged weapons use the base range + distance
  // via rangedBandFor().
  //
  // Empty string clears the range (Difficulty goes back to base 6).
  async function weaponSetRange(id, value) {
    const entry = findEntry(id);
    if (!entry) return;
    const raw = (value == null) ? '' : String(value).trim();
    if (!raw) {
      entry.currentRange = null;
    } else {
      const n = Number(raw);
      entry.currentRange = Number.isFinite(n) && n >= 0 ? n : null;
    }
    renderAll();
    if (getCanEdit()) {
      try { await save(); } catch (e) { console.error('inventory save failed', e); }
    }
  }

  // Build the list of options for a slot picker. Category dictates
  // the option set:
  //   stat  → all ruleset.stats (flat list)
  //   skill → character's primary + secondary + specialty skills,
  //           grouped by tier. Secondary/specialty live as arrays on
  //           the character; primary is keyed by name on the ruleset.
  //
  // Returns an object:
  //   {
  //     flat:      [{value, label, tier}]    — for stats (tier null)
  //     groups:    [{label, items: [{value, label, tier}]}]  — for skills
  //   }
  //
  // One of the two fields will be populated, never both.
  function buildSlotPickerOptions(category) {
    if (category === 'stat') {
      const ruleset = getRuleset();
      const stats = Array.isArray(ruleset && ruleset.stats) ? ruleset.stats : [];
      return {
        flat: stats.map(s => ({
          value: (s.code || '').toUpperCase(),
          label: (s.code || '').toUpperCase(),
          tier:  null
        })),
        groups: null
      };
    }
    if (category === 'skill') {
      const ruleset = getRuleset();
      const character = getCharData();
      const primary = Array.isArray(ruleset && ruleset.primarySkills) ? ruleset.primarySkills : [];
      const skills = (character && character.skills) || {};
      const secondary = Array.isArray(skills.secondary) ? skills.secondary : [];
      const specialty = Array.isArray(skills.specialty) ? skills.specialty : [];
      const groups = [];
      if (primary.length > 0) {
        groups.push({
          label: 'Primary',
          items: primary.map(s => ({
            value: s.name || s.code || '',
            label: s.name || s.code || '',
            tier:  'primary'
          })).filter(o => o.value)
        });
      }
      if (secondary.length > 0) {
        groups.push({
          label: 'Secondary (−1 Difficulty)',
          items: secondary.map(s => ({
            value: s.name || '',
            label: s.name || '',
            tier:  'secondary'
          })).filter(o => o.value)
        });
      }
      if (specialty.length > 0) {
        groups.push({
          label: 'Specialty (−2 Difficulty)',
          items: specialty.map(s => ({
            value: s.name || '',
            label: s.name || '',
            tier:  'specialty'
          })).filter(o => o.value)
        });
      }
      return { flat: null, groups };
    }
    return { flat: null, groups: null };
  }

  // Send a weapon's attack or damage roll to the Roll Calculator. The
  // actual Roll Calc state lives in char-rollcalc.js — we route the
  // call through ctx.sendWeaponToRollCalc which character.html wires
  // up at module-create time. This keeps char-inventory unaware of
  // char-rollcalc's internals (the two modules are otherwise
  // independent).
  //
  // which = 'attack' | 'damage'
  function weaponToRollCalc(id, which) {
    const entry = findEntry(id);
    if (!entry) return;
    const snap = entry && entry.snapshot;
    const weapon = snap && snap.weapon;
    if (!weapon) return;

    // Resolve with the SAME inputs the on-sheet readout uses: live
    // overrides, atkResult, rapidfire, and current penalty. That way
    // Roll Calc mirrors what the player sees on the weapon card.
    const character = getCharData();
    const ruleset   = getRuleset();
    const ui = entry.weaponUI || {};
    const overrides = entry.weaponOverrides || null;
    const atkResult = Number.isFinite(ui.atkResult) ? ui.atkResult : null;
    const rapidfireExtra = (weapon.kind === 'ranged'
                            && Number.isFinite(ui.rapidfireExtra)
                            && ui.rapidfireExtra > 0)
      ? Math.floor(ui.rapidfireExtra)
      : 0;
    let penaltyPct = 0;
    try {
      const derived = computeDerivedStats(character, ruleset);
      penaltyPct = (derived && derived.penalty && derived.penalty.percent) || 0;
    } catch (_) { penaltyPct = 0; }

    const resolved = resolveWeapon(weapon, character, ruleset, overrides, atkResult, penaltyPct, rapidfireExtra);
    if (!resolved) return;
    const roll = which === 'damage' ? resolved.damage : resolved.attack;
    if (!roll || roll.error) {
      alert('Weapon roll has an error: ' + (roll && roll.error ? roll.error : 'unknown'));
      return;
    }

    // Match the card readout: penalty reduces the pool only (stat +
    // skill), STATMOD stays raw. For attack rolls, also apply the
    // Difficulty-STATMOD coupling so the flat bonus delivered to
    // Roll Calc reflects what the player sees on the card.
    const dicePool = Number.isFinite(roll.dicePoolReduced) ? roll.dicePoolReduced : roll.dicePool;
    let flatBonus = roll.flatBonus;
    // Difficulty fields — only populated for attack rolls; damage has
    // no Difficulty. Baseline is 6 + range additions + rapidfire
    // recoil. Mitigation (passed separately so Roll Calc shows the
    // full breakdown) covers ROF absorption + skill-tier mitigation.
    let rcDifficulty = null;
    let rcMitigation = null;
    if (which === 'attack') {
      // Re-compute finalDiff from the resolved weapon's attack slots
      // the same way the card does: +N per range band, +recoil from
      // rapidfire, −1 per secondary skill, −2 per specialty skill,
      // mitigation capped at additions (never dips below base 6).
      const currentRange = Number.isFinite(entry.currentRange) ? entry.currentRange : null;
      let additions = 0;
      let mitigation = 0;
      if (currentRange != null) {
        let chip = null;
        try {
          chip = weapon.kind === 'melee'
            ? meleeBandFor(resolved.ranges, currentRange)
            : rangedBandFor(resolved.range, currentRange);
        } catch (_) { chip = null; }
        if (chip && Number.isFinite(chip.band) && chip.band > 0) additions = chip.band;
      }
      if (resolved.rapidfire) {
        additions += resolved.rapidfire.recoilDifficulty;
        mitigation += resolved.rapidfire.rofMitigation;
      }
      roll.diceSlots.forEach(s => {
        if (s.category === 'skill') {
          if (s.skillTier === 'secondary') mitigation += 1;
          else if (s.skillTier === 'specialty') mitigation += 2;
        }
      });
      const effectiveMit = Math.min(mitigation, additions);
      const finalDiff = 6 + additions - effectiveMit;
      const hasStatmod = roll.flatSlots.some(s => s.category === 'statmod');
      if (hasStatmod) flatBonus += (6 - finalDiff);

      // Build Roll Calc difficulty fields. Send the raw base +
      // additions as Difficulty, the full mitigation total as
      // Mitigation (Roll Calc applies min(mit, diff−base) internally
      // so over-mitigation doesn't dip below 6). Reduction is 0 —
      // that's a separate GM-set field Roll Calc surfaces for
      // per-encounter adjustments.
      rcDifficulty = 6 + additions;
      rcMitigation = mitigation;
    }

    const weaponName = (snap && snap.name) || 'Weapon';
    // Annotate the label with anything non-default so it's obvious
    // on the Roll Calc side what's baked into the numbers.
    const atkHint = (which === 'damage' && atkResult != null) ? ` (+ATK ${atkResult})` : '';
    const rfHint = (rapidfireExtra > 0) ? ` (+${rapidfireExtra} rapidfire)` : '';
    const label = `${weaponName} · ${which === 'damage' ? 'Damage' : 'Attack'}${atkHint}${rfHint}`;

    if (typeof ctx.sendWeaponToRollCalc === 'function') {
      const payload = { dicePool, flatBonus, label };
      // Only include difficulty fields for attack rolls (and only
      // when computed — they'll be null for damage). Roll Calc
      // leaves its current values alone when fields are missing.
      if (rcDifficulty != null) payload.difficulty = rcDifficulty;
      if (rcMitigation != null) payload.mitigation = rcMitigation;
      ctx.sendWeaponToRollCalc(payload);
    } else {
      console.warn('[weaponToRollCalc] ctx.sendWeaponToRollCalc missing; cannot deliver', label);
      alert('Roll Calc bridge is not wired up. (Reload the page; if this persists the feature is half-deployed.)');
    }
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
    // One-off custom form — weapon range/tag helpers
    customDraftWeaponAddRange,
    customDraftWeaponRemoveRange,
    customDraftWeaponUpdateRange,
    customDraftWeaponToggleTag,
    tickQty,
    // Weapon readout — AMMO tracker and Roll Calc send
    weaponAdjustAmmo,
    weaponReloadAmmo,
    weaponToggleRaw,
    weaponSetAtk,
    weaponSetRapidfire,
    weaponSetSlotOverride,
    weaponResetOverrides,
    weaponSetRange,
    // Per-instance weapon stat editor (edit snapshot.weapon directly)
    weaponToggleEdit,
    weaponSnapUpdate,
    weaponSnapSetKind,
    weaponSnapAddRange,
    weaponSnapRemoveRange,
    weaponSnapUpdateRange,
    weaponSnapToggleTag,
    weaponToRollCalc,
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
    // Personal catalogue — weapon range-bands and tag toggles
    catMgrWeaponAddRange,
    catMgrWeaponRemoveRange,
    catMgrWeaponUpdateRange,
    catMgrWeaponToggleTag,
    catMgrNewWeaponAddRange,
    catMgrNewWeaponRemoveRange,
    catMgrNewWeaponUpdateRange,
    catMgrNewWeaponToggleTag,
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
