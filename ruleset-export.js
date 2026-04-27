// ─── ruleset-export.js ─────────────────────────────────────────────
//
// Export rulesets and their components to JSON for backup, sharing
// with Claude (or other tools), or transfer between rulesets.
//
// Three levels of granularity, all JSON-only:
//   1. exportRuleset(ruleset)      — entire ruleset document
//   2. exportAbilityCatalogue(...) — just the abilityCatalogue
//   3. exportItemCatalogue(...)    — just the itemCatalogue (when it
//                                    exists; safe no-op until then)
//   4. exportBuilder(...)          — a single Builder + the catalogue
//                                    metadata (canonicalTiers and
//                                    defaults) it depends on, so the
//                                    exported chunk is self-contained
//                                    enough to make sense out-of-context
//
// Each helper returns the JSON string. UI calls then route to either
// the clipboard or a file download.
//
// Format conventions:
//   • Top-level "_export" object identifies the type and version, so
//     a future import flow can detect the kind of payload it's
//     receiving without guessing.
//   • Pretty-printed (2-space indent) for human review and so diffs
//     are readable.
//   • The actual ruleset/catalogue/builder data lives under a
//     payload-typed key — `ruleset`, `abilityCatalogue`, `builder`.
//
// Usage from inline UI:
//
//   import { exportRuleset, copyToClipboard, downloadJson } from
//     './ruleset-export.js';
//
//   const json = exportRuleset(state);
//   copyToClipboard(json);
//   downloadJson(json, `ruleset-${state.name}.json`);
// ───────────────────────────────────────────────────────────────────

const EXPORT_VERSION = 1;

// Build a self-describing wrapper around the payload.
function wrap(kind, payload, extras) {
  return Object.assign({
    _export: {
      kind,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString()
    }
  }, extras || {}, payload);
}

// Pretty-print to JSON with stable key order. We don't go to the
// trouble of canonicalizing keys (Object.keys order in modern JS is
// stable enough for our case — round-tripping through JSON.stringify
// preserves insertion order), but we do strip undefined fields so the
// output stays compact.
function toJson(obj) {
  return JSON.stringify(obj, (k, v) => v === undefined ? undefined : v, 2);
}

// ─── EXPORTS ───

// Whole ruleset. Pass the full top-level state object as you'd save
// it to Firestore. Includes everything: name, description, stats,
// skills, abilityCatalogue, itemCatalogue (if present), etc. Strips
// any client-side state fields that start with __ or are explicit
// transient markers.
export function exportRuleset(ruleset) {
  if (!ruleset || typeof ruleset !== 'object') {
    throw new Error('exportRuleset: no ruleset provided');
  }
  // Defensive copy — caller's object stays untouched.
  const clean = stripTransient(ruleset);
  return toJson(wrap('ruleset', { ruleset: clean }, {
    rulesetName: typeof ruleset.name === 'string' ? ruleset.name : ''
  }));
}

// Just the ability catalogue (everything under ruleset.abilityCatalogue).
// Includes types, categories, builders, defaults, canonicalTiers — the
// full thing. Useful for sharing a self-contained catalogue between
// rulesets.
export function exportAbilityCatalogue(ruleset) {
  if (!ruleset || typeof ruleset !== 'object') {
    throw new Error('exportAbilityCatalogue: no ruleset provided');
  }
  const cat = ruleset.abilityCatalogue;
  if (!cat || typeof cat !== 'object') {
    throw new Error('exportAbilityCatalogue: ruleset has no abilityCatalogue');
  }
  return toJson(wrap('abilityCatalogue', { abilityCatalogue: stripTransient(cat) }, {
    rulesetName: typeof ruleset.name === 'string' ? ruleset.name : '',
    catalogueName: typeof cat.name === 'string' ? cat.name : ''
  }));
}

// Just the item catalogue. Until the Items system exists in the
// ruleset schema, this throws a clear error so the calling button
// can show a "no items yet" message.
export function exportItemCatalogue(ruleset) {
  if (!ruleset || typeof ruleset !== 'object') {
    throw new Error('exportItemCatalogue: no ruleset provided');
  }
  const cat = ruleset.itemCatalogue;
  if (!cat || typeof cat !== 'object') {
    throw new Error('No itemCatalogue exists on this ruleset yet.');
  }
  return toJson(wrap('itemCatalogue', { itemCatalogue: stripTransient(cat) }, {
    rulesetName: typeof ruleset.name === 'string' ? ruleset.name : '',
    catalogueName: typeof cat.name === 'string' ? cat.name : ''
  }));
}

// A single Builder. Includes the Builder itself plus enough catalogue
// context to interpret its tier references and default-overrides:
//   • canonicalTiers (so feature/flaw tier costs round-trip)
//   • defaultFeatures + defaultFlaws (so override entries make sense)
// The category path is included as metadata for traceability but the
// import flow (when built) will let the user pick where to drop it.
export function exportBuilder(ruleset, builder, contextPath) {
  if (!ruleset || typeof ruleset !== 'object') {
    throw new Error('exportBuilder: no ruleset provided');
  }
  if (!builder || typeof builder !== 'object') {
    throw new Error('exportBuilder: no builder provided');
  }
  const cat = ruleset.abilityCatalogue || {};
  return toJson(wrap('builder', {
    builder: stripTransient(builder),
    catalogueContext: {
      canonicalTiers: cat.canonicalTiers ? JSON.parse(JSON.stringify(cat.canonicalTiers)) : null,
      defaultFeatures: Array.isArray(cat.defaultFeatures) ? JSON.parse(JSON.stringify(cat.defaultFeatures)) : [],
      defaultFlaws:    Array.isArray(cat.defaultFlaws)    ? JSON.parse(JSON.stringify(cat.defaultFlaws))    : []
    }
  }, {
    rulesetName: typeof ruleset.name === 'string' ? ruleset.name : '',
    builderName: typeof builder.name === 'string' ? builder.name : '',
    contextPath: contextPath || null
  }));
}

// ─── ACTIONS ───

// Copy a string to the clipboard. Returns a Promise that resolves
// true on success and false on failure (without throwing — the
// caller decides whether to alert).
export async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback for older browsers / non-secure contexts: use a hidden
    // textarea + execCommand. Less reliable but covers more cases.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.error('copyToClipboard failed:', err);
    return false;
  }
}

// Trigger a browser download of a JSON string with the given filename.
// Sanitizes the filename — strips path separators and other unsafe
// characters, ensures .json extension.
export function downloadJson(text, filename) {
  if (!text) return;
  const safeName = sanitizeFilename(filename || 'export.json');
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation — Safari sometimes needs the URL alive briefly.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── HELPERS ───

// Drop client-only transient fields. We keep this minimal — the
// schema is designed to be Firestore-clean already, but defensively
// strip __-prefixed keys anywhere in the tree, plus any keys named
// literally `__source` (used internally by resolveBuilderFeatures).
function stripTransient(obj) {
  if (Array.isArray(obj)) return obj.map(stripTransient);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const key of Object.keys(obj)) {
      if (key.startsWith('__')) continue;
      out[key] = stripTransient(obj[key]);
    }
    return out;
  }
  return obj;
}

function sanitizeFilename(name) {
  // Replace anything not safe with a hyphen. Keep dots so the .json
  // extension survives, but collapse runs of unsafe chars.
  let safe = String(name)
    .replace(/[\/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safe) safe = 'export';
  if (!/\.json$/i.test(safe)) safe += '.json';
  return safe;
}
