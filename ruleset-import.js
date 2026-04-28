// ─── ruleset-import.js ─────────────────────────────────────────────
//
// Import JSON exports back into a ruleset. Counterpart to
// ruleset-export.js. Three import scopes:
//
//   1. importRuleset       — replace OR merge a whole ruleset
//   2. importAbilityCatalogue — replace OR merge the abilityCatalogue
//   3. importBuilder       — drop a single Builder into a chosen
//                            Category (always additive, never replaces
//                            the whole catalogue)
//
// The functions in this module DO NOT mutate Firestore directly. They
// return a result object containing:
//   { kind, mode, applied, summary, warnings }
// where:
//   • applied       — the new state object the caller should commit
//                     to its in-memory `state` (then Save when ready)
//   • summary       — human-readable string describing what changed
//                     (used in the post-import toast)
//   • warnings      — array of strings (unknown fields, format issues,
//                     etc.) — caller can show or ignore
//
// The caller is responsible for stashing the PRE-import state for
// undo before applying the result. This module is pure given inputs.
//
// VALIDATION STRATEGY (hybrid):
//   • Strict on `_export.kind` — must match what the user picked,
//     otherwise we throw. This prevents "I meant to import a Builder
//     but I pasted a whole-ruleset payload" silent disasters.
//   • Lenient on internals — we run the result through
//     window.normalizeRuleset() (or its piecewise equivalents) so
//     missing fields get filled in with defaults.
// ───────────────────────────────────────────────────────────────────

// Parse a JSON string + envelope-validate. Returns the inner payload
// + envelope metadata. Throws with a clear message if the payload is
// malformed or doesn't match the expected `kind`.
//
// expectedKind: 'ruleset' | 'abilityCatalogue' | 'itemCatalogue' | 'builder'
export function parseAndValidate(jsonText, expectedKind) {
  if (!jsonText || typeof jsonText !== 'string') {
    throw new Error('No JSON text provided.');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error('Not valid JSON: ' + err.message);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Parsed JSON is not an object.');
  }
  // Envelope check.
  const envelope = parsed._export;
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Missing _export envelope. This file does not look like a ruleset export.');
  }
  if (envelope.kind !== expectedKind) {
    throw new Error(`Expected an export of kind "${expectedKind}", but this file is a "${envelope.kind}" export.`);
  }
  if (typeof envelope.version !== 'number' || envelope.version < 1) {
    throw new Error('Unrecognized export version: ' + envelope.version);
  }
  return { envelope, parsed };
}

// ─── RULESET IMPORT ───
//
// mode: 'replace' | 'merge'
//
// Replace: the caller's currentState is wiped and replaced with the
// imported ruleset (after normalization). Top-level Firestore-only
// metadata fields (id, ownerId, createdAt) are preserved from
// currentState — the imported payload's user data overwrites
// everything else.
//
// Merge: items are layered on top of currentState. For arrays of
// objects with stable ids (stats, skills, weapons, abilityCatalogue
// builders, etc.) merge means "by-id update, append new". For scalar
// fields (name, description), merge means "imported wins if non-empty".
// Catalogue defaults & tier tables: imported wins (these are global-
// shape, can't be partially merged sensibly).
export function importRuleset(currentState, jsonText, mode) {
  const { parsed } = parseAndValidate(jsonText, 'ruleset');
  const incoming = parsed.ruleset;
  if (!incoming || typeof incoming !== 'object') {
    throw new Error('Export envelope is missing the `ruleset` payload.');
  }
  const warnings = [];

  // Preserve Firestore identity fields from current state regardless
  // of mode. The imported payload may not even have these (it shouldn't,
  // but old exports might).
  const preserved = {
    id:        currentState ? currentState.id        : undefined,
    ownerId:   currentState ? currentState.ownerId   : undefined,
    createdAt: currentState ? currentState.createdAt : undefined
  };

  let applied;
  let summary;
  if (mode === 'replace') {
    applied = deepClone(incoming);
    Object.keys(preserved).forEach(k => {
      if (preserved[k] !== undefined) applied[k] = preserved[k];
    });
    summary = `Replaced ruleset with imported data (${describeRuleset(incoming)}).`;
  } else if (mode === 'merge') {
    applied = mergeRulesets(currentState || {}, incoming, warnings);
    Object.keys(preserved).forEach(k => {
      if (preserved[k] !== undefined) applied[k] = preserved[k];
    });
    summary = `Merged imported ruleset into existing one (${describeRuleset(incoming)}).`;
  } else {
    throw new Error('Unknown mode: ' + mode);
  }

  // Run through normalizeRuleset to repair shape / fill defaults.
  if (typeof window !== 'undefined' && typeof window.normalizeRuleset === 'function') {
    applied = window.normalizeRuleset(applied);
  } else {
    warnings.push('normalizeRuleset() not available — schema not validated.');
  }

  return { kind: 'ruleset', mode, applied, summary, warnings };
}

// ─── ABILITY CATALOGUE IMPORT ───
export function importAbilityCatalogue(currentState, jsonText, mode) {
  const { parsed } = parseAndValidate(jsonText, 'abilityCatalogue');
  const incomingCat = parsed.abilityCatalogue;
  if (!incomingCat || typeof incomingCat !== 'object') {
    throw new Error('Export envelope is missing the `abilityCatalogue` payload.');
  }
  const warnings = [];
  const applied = deepClone(currentState || {});
  let summary;

  if (mode === 'replace') {
    applied.abilityCatalogue = deepClone(incomingCat);
    summary = `Replaced Ability Catalogue with imported data (${describeCatalogue(incomingCat)}).`;
  } else if (mode === 'merge') {
    applied.abilityCatalogue = mergeAbilityCatalogue(applied.abilityCatalogue || {}, incomingCat, warnings);
    summary = `Merged imported Ability Catalogue (${describeCatalogue(incomingCat)}).`;
  } else {
    throw new Error('Unknown mode: ' + mode);
  }

  if (typeof window !== 'undefined' && typeof window.normalizeRuleset === 'function') {
    // normalizeRuleset operates on the whole ruleset; we feed our
    // partial state through and trust it to leave non-catalogue fields
    // alone (it does — it only normalizes specific known keys).
    Object.assign(applied, window.normalizeRuleset(applied));
  } else {
    warnings.push('normalizeRuleset() not available — catalogue schema not validated.');
  }

  return { kind: 'abilityCatalogue', mode, applied, summary, warnings };
}

// ─── BUILDER IMPORT ───
//
// Drops a single Builder into the destination. Two routing modes:
//
// (A) Place into a Category (default). targetTypeKey + targetCategoryId
//     (or targetCategoryName for new-category) determine where the
//     imported Builder lands. If the imported Builder's id collides
//     with one in that category, it replaces in place.
//
// (B) Overwrite a specific Builder by id. opts.overwriteBuilderId
//     forces the imported Builder to take that id, regardless of
//     what id the imported JSON has, and writes it into whichever
//     category currently holds the targeted Builder. Use this when
//     the GM wants to round-trip-edit an existing Builder.
//
// `mode` only affects id-collision handling for case (A); it's ignored
// in case (B) since overwrite is the explicit intent there.
export function importBuilder(currentState, jsonText, mode, opts) {
  const { parsed } = parseAndValidate(jsonText, 'builder');
  const incomingBuilder = parsed.builder;
  if (!incomingBuilder || typeof incomingBuilder !== 'object') {
    throw new Error('Export envelope is missing the `builder` payload.');
  }
  opts = opts || {};
  const warnings = [];

  const applied = deepClone(currentState || {});
  if (!applied.abilityCatalogue || typeof applied.abilityCatalogue !== 'object') {
    applied.abilityCatalogue = {};
  }
  const cat = applied.abilityCatalogue;
  const typeKey = opts.targetTypeKey || 'ability';

  if (!cat.types || typeof cat.types !== 'object') cat.types = {};
  if (!cat.types[typeKey] || typeof cat.types[typeKey] !== 'object') {
    cat.types[typeKey] = { label: typeKey, categories: [] };
  }
  const tBucket = cat.types[typeKey];
  if (!Array.isArray(tBucket.categories)) tBucket.categories = [];

  // Mode (B) — overwrite a specific Builder by id. Find the category
  // that currently holds that id, replace in place, force the imported
  // Builder's id to match.
  let summary;
  if (opts.overwriteBuilderId) {
    let foundCategory = null;
    let foundIdx = -1;
    for (const c of tBucket.categories) {
      if (!c || !Array.isArray(c.builders)) continue;
      const idx = c.builders.findIndex(b => b && b.id === opts.overwriteBuilderId);
      if (idx >= 0) {
        foundCategory = c;
        foundIdx = idx;
        break;
      }
    }
    if (!foundCategory) {
      throw new Error(`Builder to overwrite (id "${opts.overwriteBuilderId}") not found in this catalogue.`);
    }
    const newBuilder = deepClone(incomingBuilder);
    const oldBuilder = foundCategory.builders[foundIdx];
    const oldName = oldBuilder.name || '(unnamed)';
    // Force the id so the open editor's references stay valid.
    newBuilder.id = opts.overwriteBuilderId;
    foundCategory.builders[foundIdx] = newBuilder;
    summary = `Overwrote Builder "${oldName}" with imported "${newBuilder.name || '(unnamed)'}" in "${foundCategory.name}".`;

    // Note re: imported builder's original id — we silently drop it
    // in favor of the open editor's id. This is the explicit intent
    // when the GM picked "Overwrite current Builder."

    // Same catalogueContext handling as path (A) below.
    const ctx = parsed.catalogueContext;
    if (ctx && typeof ctx === 'object') {
      if (!cat.canonicalTiers || typeof cat.canonicalTiers !== 'object') {
        cat.canonicalTiers = deepClone(ctx.canonicalTiers || {});
        warnings.push('Catalogue had no tier table — copied from imported Builder context.');
      } else if (ctx.canonicalTiers && tierTablesMismatch(cat.canonicalTiers, ctx.canonicalTiers)) {
        warnings.push('Imported Builder was authored against a different tier cost table; AP costs may shift in this catalogue.');
      }
    }

    if (typeof window !== 'undefined' && typeof window.normalizeRuleset === 'function') {
      Object.assign(applied, window.normalizeRuleset(applied));
    } else {
      warnings.push('normalizeRuleset() not available — Builder schema not validated.');
    }
    return { kind: 'builder', mode, applied, summary, warnings };
  }

  // Mode (A) — place into a chosen Category.
  // Resolve target category — either by id or by creating a new one.
  let category = null;
  if (opts.targetCategoryId) {
    category = tBucket.categories.find(c => c && c.id === opts.targetCategoryId);
    if (!category) {
      warnings.push(`Target category "${opts.targetCategoryId}" not found; creating a new one.`);
    }
  }
  if (!category) {
    const newName = opts.targetCategoryName || 'Imported';
    category = {
      id: 'cat_' + Math.random().toString(36).slice(2, 10),
      name: newName,
      description: '',
      builders: []
    };
    tBucket.categories.push(category);
  }
  if (!Array.isArray(category.builders)) category.builders = [];

  // Drop the Builder in. If id collides, replace in-place.
  const newBuilder = deepClone(incomingBuilder);
  const existingIdx = category.builders.findIndex(b => b && b.id === newBuilder.id);
  if (existingIdx >= 0) {
    const oldName = category.builders[existingIdx].name || '(unnamed)';
    category.builders[existingIdx] = newBuilder;
    summary = `Replaced Builder "${oldName}" with imported "${newBuilder.name || '(unnamed)'}" in "${category.name}".`;
  } else {
    category.builders.push(newBuilder);
    summary = `Added Builder "${newBuilder.name || '(unnamed)'}" to "${category.name}".`;
  }

  // If the export included catalogueContext (canonicalTiers + defaults)
  // and the target catalogue is empty/uninitialized for those, copy
  // them in. We DON'T overwrite existing tier tables or defaults —
  // those are catalogue-wide and the GM may have customized them.
  // Just warn if there's a tier-name mismatch that'd make the
  // imported Builder's features price differently here.
  const ctx = parsed.catalogueContext;
  if (ctx && typeof ctx === 'object') {
    if (!cat.canonicalTiers || typeof cat.canonicalTiers !== 'object') {
      cat.canonicalTiers = deepClone(ctx.canonicalTiers || {});
      warnings.push('Catalogue had no tier table — copied from imported Builder context.');
    } else if (ctx.canonicalTiers && tierTablesMismatch(cat.canonicalTiers, ctx.canonicalTiers)) {
      warnings.push('Imported Builder was authored against a different tier cost table; AP costs may shift in this catalogue.');
    }
  }

  if (typeof window !== 'undefined' && typeof window.normalizeRuleset === 'function') {
    Object.assign(applied, window.normalizeRuleset(applied));
  } else {
    warnings.push('normalizeRuleset() not available — Builder schema not validated.');
  }

  return { kind: 'builder', mode, applied, summary, warnings };
}

// ─── HELPERS ───

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function describeRuleset(rs) {
  const stats = Array.isArray(rs.stats) ? rs.stats.length : 0;
  const skills = Array.isArray(rs.skills) ? rs.skills.length : 0;
  const cat = rs.abilityCatalogue || {};
  const builderCount = countBuilders(cat);
  return `${stats} stats, ${skills} skills, ${builderCount} Builders`;
}

function describeCatalogue(cat) {
  return `${countBuilders(cat)} Builders, ${(cat.defaultFeatures || []).length} default features, ${(cat.defaultFlaws || []).length} default flaws`;
}

function countBuilders(cat) {
  let n = 0;
  if (cat && cat.types && typeof cat.types === 'object') {
    Object.values(cat.types).forEach(t => {
      if (t && Array.isArray(t.categories)) {
        t.categories.forEach(c => {
          if (c && Array.isArray(c.builders)) n += c.builders.length;
        });
      }
    });
  }
  if (cat && Array.isArray(cat.categories)) {
    // Legacy shape — fall through to count those too.
    cat.categories.forEach(c => {
      if (c && Array.isArray(c.builders)) n += c.builders.length;
    });
  }
  return n;
}

function tierTablesMismatch(a, b) {
  if (!a || !b) return false;
  const tiers = ['minor','moderate','major','massive','monumental','mega','mythical'];
  return ['featureCosts', 'flawRefunds'].some(table => {
    const aT = (a[table] && typeof a[table] === 'object') ? a[table] : {};
    const bT = (b[table] && typeof b[table] === 'object') ? b[table] : {};
    return tiers.some(tier => Number(aT[tier] || 0) !== Number(bT[tier] || 0));
  });
}

// ─── MERGE ROUTINES ───
// Merge an incoming ruleset over the current one. Strategy:
//   • Top-level scalars (name, description, ...): imported wins if it
//     has a non-empty value.
//   • Identified arrays (stats/skills/weapons/etc.): per-id update +
//     append new. Items in current with no matching id in incoming
//     are kept (not deleted).
//   • abilityCatalogue: delegate to mergeAbilityCatalogue.
function mergeRulesets(current, incoming, warnings) {
  const out = deepClone(current);
  // Scalar overrides
  ['name', 'description', 'systemNotes', 'theme'].forEach(k => {
    if (typeof incoming[k] === 'string' && incoming[k].trim()) out[k] = incoming[k];
  });
  // Identified-array fields
  // (powerLevels removed — Power Levels were deprecated when the
  // economy was rewritten to use a flat xpToApRate.)
  const idArrays = ['stats', 'skills', 'weapons', 'derivedStats'];
  idArrays.forEach(k => {
    if (Array.isArray(incoming[k])) {
      out[k] = mergeById(Array.isArray(out[k]) ? out[k] : [], incoming[k]);
    }
  });
  // Catalogue
  if (incoming.abilityCatalogue) {
    out.abilityCatalogue = mergeAbilityCatalogue(out.abilityCatalogue || {}, incoming.abilityCatalogue, warnings);
  }
  if (incoming.itemCatalogue) {
    out.itemCatalogue = deepClone(incoming.itemCatalogue);
  }
  return out;
}

function mergeAbilityCatalogue(current, incoming, warnings) {
  const out = deepClone(current);
  // Top-level scalars
  ['name', 'description', 'enabled'].forEach(k => {
    if (incoming[k] !== undefined) out[k] = incoming[k];
  });
  // Tier tables — imported wins (these are catalogue-wide).
  if (incoming.canonicalTiers) out.canonicalTiers = deepClone(incoming.canonicalTiers);
  // Default features/flaws — merged by id (so authoring against a
  // pre-existing default set doesn't blow it away).
  if (Array.isArray(incoming.defaultFeatures)) {
    out.defaultFeatures = mergeById(Array.isArray(out.defaultFeatures) ? out.defaultFeatures : [], incoming.defaultFeatures);
  }
  if (Array.isArray(incoming.defaultFlaws)) {
    out.defaultFlaws = mergeById(Array.isArray(out.defaultFlaws) ? out.defaultFlaws : [], incoming.defaultFlaws);
  }
  // Types → categories → builders. Merge by id at each level.
  if (incoming.types && typeof incoming.types === 'object') {
    if (!out.types || typeof out.types !== 'object') out.types = {};
    Object.keys(incoming.types).forEach(typeKey => {
      const inT = incoming.types[typeKey];
      if (!inT || typeof inT !== 'object') return;
      if (!out.types[typeKey] || typeof out.types[typeKey] !== 'object') {
        out.types[typeKey] = deepClone(inT);
        return;
      }
      const outT = out.types[typeKey];
      if (typeof inT.label === 'string') outT.label = inT.label;
      if (typeof inT.description === 'string') outT.description = inT.description;
      if (Array.isArray(inT.categories)) {
        outT.categories = mergeCategories(Array.isArray(outT.categories) ? outT.categories : [], inT.categories);
      }
    });
  }
  return out;
}

function mergeCategories(current, incoming) {
  const out = current.slice();
  incoming.forEach(inCat => {
    if (!inCat || !inCat.id) return;
    const idx = out.findIndex(c => c && c.id === inCat.id);
    if (idx < 0) {
      out.push(deepClone(inCat));
      return;
    }
    const cur = out[idx];
    if (typeof inCat.name === 'string')        cur.name = inCat.name;
    if (typeof inCat.description === 'string') cur.description = inCat.description;
    if (Array.isArray(inCat.builders)) {
      cur.builders = mergeById(Array.isArray(cur.builders) ? cur.builders : [], inCat.builders);
    }
  });
  return out;
}

// Merge two arrays of objects with .id — incoming wins on id collision,
// new ids append to end. Items in current without a matching incoming
// id are preserved.
function mergeById(currentArr, incomingArr) {
  const out = currentArr.slice();
  const indexById = new Map();
  out.forEach((it, i) => { if (it && it.id) indexById.set(it.id, i); });
  incomingArr.forEach(it => {
    if (!it || !it.id) {
      // Items without ids — just append. Could happen with malformed
      // exports. Better than dropping them silently.
      out.push(deepClone(it));
      return;
    }
    const idx = indexById.get(it.id);
    if (idx === undefined) {
      indexById.set(it.id, out.length);
      out.push(deepClone(it));
    } else {
      out[idx] = deepClone(it);
    }
  });
  return out;
}
