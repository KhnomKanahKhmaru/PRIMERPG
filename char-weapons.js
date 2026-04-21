// char-weapons.js
//
// Weapon resolver — given a weapon snapshot on an inventory entry, the
// live character, and the active ruleset, compute everything the UI
// needs to display the weapon's attack/damage readout AND to wire a
// "Send to Roll Calculator" button.
//
// What a resolver call produces:
//   {
//     kind: 'melee' | 'ranged',
//     attack: {
//       formula:  string,     // raw ruleset formula, unsubstituted
//       value:    number,     // evaluated total
//       slots:    [{ label, value, rawContribution }, ...],  // for Roll Calc
//       error:    string|null
//     },
//     damage: { ... same shape ... },
//     dice:   number,         // weapon's damage dice count (the D10s)
//     pen:    number,
//     tags:   [{ id, name, description }, ...],  // resolved against ruleset.weaponTags
//     // Melee-only:
//     ranges: [[s,e], ...],   // pass-through from snapshot
//     // Ranged-only:
//     range:       number,    // base range in feet
//     ammo:        { raw, resolved, error },  // raw string/number, resolved number
//     rof:         { raw, resolved, error },
//     dmgmod:      number
//   }
//
// The resolver is DATA-ONLY. It never touches the DOM, dispatches no
// events, and doesn't mutate the character. UI code (char-inventory.js
// for weapon readout cards, char-rollcalc.js for the load-weapon path)
// calls this and renders the result.

import { parseFormula, evalFormula, buildSymbolTable } from './char-derived.js';

// Resolve an ammo/rof value that may be a literal number or a formula
// string referencing character symbols. Returns { raw, resolved, error }.
//   raw       — the author's original value (passthrough for UI readout)
//   resolved  — the computed number after evaluation; null if error
//   error     — human-readable message or null
function resolveAmmoRof(value, symbols) {
  if (value == null) return { raw: 0, resolved: 0, error: null };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { raw: value, resolved: Math.max(0, Math.floor(value)), error: null };
  }
  if (typeof value === 'string' && value.trim()) {
    const compiled = parseFormula(value);
    if (compiled.error) return { raw: value, resolved: null, error: compiled.message || 'Parse error' };
    const n = evalFormula(compiled, symbols);
    if (n == null || !Number.isFinite(n)) return { raw: value, resolved: null, error: 'Unresolved variables' };
    return { raw: value, resolved: Math.max(0, Math.floor(n)), error: null };
  }
  return { raw: value, resolved: 0, error: null };
}

// Evaluate one of the four ruleset attack/damage formulas with the
// weapon's own constants mixed into the symbol table. Returns
// { formula, value, slots, error }.
//
// Weapon-local symbols injected on top of the character symbols:
//   DMG    — weapon dice count (the damage-dice number)
//   PEN    — weapon PEN
//   DMGMOD — the weapon's own dmgmod (ranged only; 0 for melee so the
//            melee damage formula can reference DMGMOD without error)
//   ATK    — placeholder 0. Represents the attack roll RESULT, which
//            can't be known at render time — the UI swaps this in when
//            the player chains an attack→damage roll. Kept as 0 here
//            so damage formulas that reference ATK still evaluate to a
//            "base damage" readout before the attack is rolled.
//
// Output split:
//   - DICE POOL: sum of terms whose variable name does NOT end in 'MOD'.
//     These become the count of D10s rolled against the TN.
//   - FLAT BONUS: sum of terms whose variable name ends in 'MOD'.
//     Added to the number of successes after the roll (STATMODs act as
//     a passive floor for the final Result in PRIME).
//
// The rule is simple: any variable suffixed with MOD is flat. That
// covers STATMOD, DEXMOD, STRMOD, DMGMOD (weapon's own for ranged),
// POWMOD, SIZEMOD, and any custom *MOD a ruleset author adds.
// Literal numbers go into the dice pool by default — there's no
// established convention that "+3" in a formula means flat vs dice,
// and dice-pool is the more common case. Authors who want a flat
// literal should expose it via a named *MOD variable in their
// symbol table.
function isFlatVar(name) {
  return typeof name === 'string' && /MOD$/.test(name);
}

function resolveRollFormula(formulaStr, symbols, weaponSymbols) {
  if (!formulaStr || typeof formulaStr !== 'string') {
    return {
      formula: '', dicePool: 0, flatBonus: 0,
      diceSlots: [], flatSlots: [], error: 'Missing formula'
    };
  }
  const mergedSymbols = Object.assign({}, symbols, weaponSymbols);
  const compiled = parseFormula(formulaStr);
  if (compiled.error) {
    return {
      formula: formulaStr, dicePool: 0, flatBonus: 0,
      diceSlots: [], flatSlots: [], error: compiled.message || 'Parse error'
    };
  }
  // Sanity eval to catch unresolved variables up front — clearer error
  // than just returning 0 in the slot breakdown.
  const total = evalFormula(compiled, mergedSymbols);
  if (total == null) {
    const missing = listMissingVars(compiled, mergedSymbols);
    return {
      formula:   formulaStr,
      dicePool:  0,
      flatBonus: 0,
      diceSlots: [],
      flatSlots: [],
      error:     missing.length > 0 ? 'Missing: ' + missing.join(', ') : 'Eval error'
    };
  }
  // Decompose into additive terms, then bucket by flat vs dice based
  // on whether any referenced variable name ends in MOD. Compound
  // terms like "SOMETHING + OTHERMOD" wouldn't normally occur at a
  // single leaf, but if they do we classify the whole leaf as flat
  // (conservative — MOD-flavored leaves go flat).
  const terms = extractAdditiveTerms(compiled, mergedSymbols);
  const diceSlots = [];
  const flatSlots = [];
  let dicePool  = 0;
  let flatBonus = 0;
  terms.forEach(term => {
    if (term.isFlat) {
      flatBonus += term.value;
      flatSlots.push(term);
    } else {
      dicePool += term.value;
      diceSlots.push(term);
    }
  });
  // Dice pool is a count — clamp to non-negative integer so the Roll
  // Calc never gets a -2 dice input. Flat bonus stays signed.
  dicePool = Math.max(0, Math.floor(dicePool));
  return {
    formula:   formulaStr,
    dicePool,
    flatBonus,
    diceSlots,
    flatSlots,
    error:     null
  };
}

// Walk a compiled AST and list any variable names that don't have
// a matching symbol-table entry. Used for actionable error messages
// when a formula references something the character doesn't define.
function listMissingVars(compiled, symbols) {
  const missing = new Set();
  const walk = (node) => {
    if (!node) return;
    switch (node.kind) {
      case 'var':
        if (!(node.name in symbols)) missing.add(node.name);
        break;
      case 'unary': walk(node.arg); break;
      case 'binop': walk(node.left); walk(node.right); break;
      case 'call':  node.args.forEach(walk); break;
    }
  };
  walk(compiled.ast);
  return Array.from(missing);
}

// Break a compiled additive expression into human-readable terms for
// the slot hint. Only handles top-level + and - chains; anything more
// complex (multiplication, function calls at the top) gets returned as
// a single opaque "formula" slot. This is fine because the four
// ruleset weapon formulas are all simple sums in practice.
//
// Each term carries an `isFlat` boolean: true if the term's expression
// references a variable ending in MOD (STATMOD, DEXMOD, etc), false
// otherwise. Callers use this to bucket terms into dice pool vs flat
// bonus for the Roll Calculator.
function extractAdditiveTerms(compiled, symbols) {
  const terms = [];
  const walk = (node, sign) => {
    if (!node) return;
    if (node.kind === 'binop' && node.op === '+') {
      walk(node.left, sign);
      walk(node.right, sign);
      return;
    }
    if (node.kind === 'binop' && node.op === '-') {
      walk(node.left, sign);
      walk(node.right, -sign);
      return;
    }
    // Leaf (not a recognized addition operand). Evaluate it as a
    // mini-expression and stash.
    const v = evalFormula({ ast: node }, symbols);
    const label = termLabel(node);
    // Gather all variable references inside this leaf; if ANY of them
    // is MOD-suffixed, the whole leaf is classified as flat. This
    // conservative rule handles edge cases like `2 * STRMOD` correctly
    // (whole expression is treated as flat because STRMOD is flat).
    const varRefs = [];
    collectVarRefs(node, varRefs);
    const isFlat = varRefs.some(isFlatVar);
    terms.push({
      label,
      value: (v == null ? 0 : v) * sign,
      sign,
      isFlat
    });
  };
  walk(compiled.ast, 1);
  return terms;
}

// Collect every variable name referenced inside an AST node. Used by
// extractAdditiveTerms to classify a leaf as flat-vs-dice based on
// whether any of its variables are MOD-suffixed.
function collectVarRefs(node, out) {
  if (!node) return;
  switch (node.kind) {
    case 'var':   out.push(node.name); break;
    case 'unary': collectVarRefs(node.arg, out); break;
    case 'binop': collectVarRefs(node.left, out); collectVarRefs(node.right, out); break;
    case 'call':  node.args.forEach(a => collectVarRefs(a, out)); break;
  }
}

// Best-effort human label for an AST node — used to build slot labels.
function termLabel(node) {
  if (!node) return '?';
  if (node.kind === 'var') return node.name;
  if (node.kind === 'num') return String(node.value);
  if (node.kind === 'unary' && node.op === '-') return '-' + termLabel(node.arg);
  return '(expr)';
}

// MAIN ENTRY POINT.
//
// weapon     — the weapon snapshot object from an inventory entry.
//              Shape matches what coerceWeapon() in ruleset-defaults.js
//              produces: { kind, dice, pen, tags, ranges?|range?, ... }.
// character  — live character doc (charData).
// ruleset    — active ruleset.
//
// Returns the readout object described at the top of this file. If the
// weapon argument is null/undefined or has no kind, returns null.
export function resolveWeapon(weapon, character, ruleset) {
  if (!weapon || (weapon.kind !== 'melee' && weapon.kind !== 'ranged')) return null;

  const symbols = buildSymbolTable(character || {}, ruleset || {});
  const rsWeapons = (ruleset && ruleset.weapons) || {};
  const rsTags    = Array.isArray(ruleset && ruleset.weaponTags) ? ruleset.weaponTags : [];

  // Weapon-local symbols overlaid on character symbols. DMGMOD falls
  // back to whatever the character symbol table already had (DEXMOD
  // or similar) so formulas that reference it outside the weapon's
  // own dmgmod work; the weapon's own dmgmod is a separate concept
  // stored under WEAPONDMGMOD for authors who want to distinguish.
  const weaponSymbols = {
    DMG: Number.isFinite(weapon.dice)   ? weapon.dice   : 0,
    PEN: Number.isFinite(weapon.pen)    ? weapon.pen    : 0,
    ATK: 0   // placeholder — see resolveRollFormula comment
  };
  // Ranged weapons contribute a dmgmod bonus to the damage formula.
  // Melee weapons don't have one, but the formula engine expects a
  // number; default to 0 so a shared formula works for both. Authors
  // who need to distinguish weapon-dmgmod from stat-DMGMOD should use
  // WEAPONDMGMOD in the formula explicitly.
  if (weapon.kind === 'ranged') {
    weaponSymbols.WEAPONDMGMOD = Number.isFinite(weapon.dmgmod) ? weapon.dmgmod : 0;
    // Also override DMGMOD for ranged weapons so the default formula
    // `DEX + DMG + ATK + DMGMOD` behaves as the user expects (the
    // DMGMOD in that formula is the weapon's, not the DEX stat-mod).
    weaponSymbols.DMGMOD = weaponSymbols.WEAPONDMGMOD;
  } else {
    weaponSymbols.WEAPONDMGMOD = 0;
  }

  const attackFormula = (weapon.kind === 'melee')
    ? (rsWeapons.meleeAttackFormula  || 'DEX + Melee + DEXMOD')
    : (rsWeapons.rangedAttackFormula || 'DEX + Ranged + DEXMOD');
  const damageFormula = (weapon.kind === 'melee')
    ? (rsWeapons.meleeDamageFormula  || 'STR + DMG + ATK + STRMOD')
    : (rsWeapons.rangedDamageFormula || 'DEX + DMG + ATK + DMGMOD');

  const attack = resolveRollFormula(attackFormula, symbols, weaponSymbols);
  const damage = resolveRollFormula(damageFormula, symbols, weaponSymbols);

  // Resolve tags against the ruleset catalogue. Unknown ids are
  // silently dropped (the author may have deleted a tag after a
  // character snapshotted the weapon). UI sees only the resolvable
  // ones and reflects a consistent picture.
  const tagIds = Array.isArray(weapon.tags) ? weapon.tags : [];
  const tags = [];
  tagIds.forEach(id => {
    const def = rsTags.find(t => t.id === id);
    if (def) tags.push({ id: def.id, name: def.name || id, description: def.description || '' });
  });

  const out = {
    kind: weapon.kind,
    attack,
    damage,
    dice: Number.isFinite(weapon.dice) ? weapon.dice : 0,
    pen:  Number.isFinite(weapon.pen)  ? weapon.pen  : 0,
    tags
  };

  if (weapon.kind === 'melee') {
    // Normalize ranges to {s, e} objects even if the snapshot came
    // from the old [s,e]-array format. Downstream display code (range
    // chips, meleeBandFor) expects {s, e}.
    out.ranges = Array.isArray(weapon.ranges)
      ? weapon.ranges.map(r => {
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            return { s: Number(r.s) || 0, e: Number(r.e) || 0 };
          }
          if (Array.isArray(r) && r.length >= 2) {
            return { s: Number(r[0]) || 0, e: Number(r[1]) || 0 };
          }
          return { s: 0, e: 0 };
        })
      : [];
  } else {
    out.range  = Number.isFinite(weapon.range) ? weapon.range : 0;
    out.dmgmod = weaponSymbols.WEAPONDMGMOD;
    out.ammo   = resolveAmmoRof(weapon.ammo, symbols);
    out.rof    = resolveAmmoRof(weapon.rof,  symbols);
  }

  return out;
}

// Translate ROF level to the flavor text "N projectiles per ammo".
// Maps from the rules given in the design doc. Passed through to the
// UI so players see what their ROF level MEANS at a glance.
const ROF_FLAVOR = {
  '-1': { label: 'Single-Fire',    perAmmo: 1  },
  '0':  { label: 'Action Fire',    perAmmo: 1  },
  '1':  { label: 'Semi-Automatic', perAmmo: 5  },
  '2':  { label: 'Automatic',      perAmmo: 6  },
  '3':  { label: 'Fully Automatic', perAmmo: 10 },
  '4':  { label: 'Chain Automatic', perAmmo: 50 }
};
export function rofFlavor(level) {
  if (level == null || !Number.isFinite(level)) return null;
  const clamped = Math.max(-1, Math.min(4, Math.round(level)));
  return ROF_FLAVOR[String(clamped)] || null;
}

// Given a ranged weapon's base range (in feet) and the target's
// distance, return the difficulty band. Bands per the design doc:
//   +0 within base range
//   +1 from R to 2R
//   +2 from 2R to 3R
//   +3 from 3R to 6R (longshot scales doubling)
//   +4 from 6R to 9R   (3R * 3)
//   +5 from 9R to 18R  (6R * 3), etc.
//
// The "longshot" scale after band 2 doubles/triples each step, matching
// the design note: "+3 at (Range*3)*2, +4 at (Range*3)*3".
// We cap at +10 to avoid runaway values for extreme ranges.
export function rangedBandFor(baseRange, distance) {
  if (!Number.isFinite(baseRange) || baseRange <= 0) return { band: 0, label: 'Unknown' };
  if (!Number.isFinite(distance) || distance < 0)    distance = 0;
  if (distance <= baseRange)      return { band: 0, label: '+0 (close)' };
  if (distance <= baseRange * 2)  return { band: 1, label: '+1' };
  if (distance <= baseRange * 3)  return { band: 2, label: '+2' };
  // Longshot — base is 3R, each subsequent band multiplies the
  // threshold by 3. Band 3 covers (3R, 9R]; band 4 covers (9R, 27R];
  // band 5 covers (27R, 81R]; etc.
  let threshold = baseRange * 3;
  let band = 2;
  while (distance > threshold && band < 10) {
    threshold *= 3;
    band++;
  }
  return { band, label: '+' + band + ' (longshot)' };
}

// Given a melee weapon's ranges array ([{s,e},...] — or legacy
// [[s,e],...]) and a distance in feet, return the band (0-indexed)
// and a label. If the distance is past the last band's end, the
// difficulty keeps stepping up by 1 per additional band-length past
// the max, capped at +10. Returns { band, label } so the UI can
// display a consistent string.
export function meleeBandFor(ranges, distance) {
  if (!Array.isArray(ranges) || ranges.length === 0) return { band: 0, label: '+0' };
  if (!Number.isFinite(distance) || distance < 0) distance = 0;
  // Normalize band shape on the fly — accept {s,e} or [s,e].
  const readBand = (b) => {
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      return { s: Number(b.s) || 0, e: Number(b.e) || 0 };
    }
    if (Array.isArray(b) && b.length >= 2) {
      return { s: Number(b[0]) || 0, e: Number(b[1]) || 0 };
    }
    return { s: 0, e: 0 };
  };
  const normalized = ranges.map(readBand);
  for (let i = 0; i < normalized.length; i++) {
    const { s, e } = normalized[i];
    if (distance >= s && distance <= e) return { band: i, label: '+' + i };
  }
  // Past the last band's end: extrapolate using the final band's width.
  const last = normalized[normalized.length - 1];
  const lastEnd = last.e;
  if (distance < normalized[0].s) return { band: 0, label: '+0 (inside minimum)' };
  if (distance > lastEnd) {
    const lastWidth = Math.max(1, lastEnd - last.s);
    const extra = Math.ceil((distance - lastEnd) / lastWidth);
    const band = Math.min(10, normalized.length - 1 + extra);
    return { band, label: '+' + band + ' (beyond max)' };
  }
  // Fallback — shouldn't normally hit.
  return { band: 0, label: '+0' };
}
