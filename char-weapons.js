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
//       formula:          string,  // formula after any override substitutions
//       dicePool:         number,  // STAT + SKILL terms summed, pre-penalty
//       flatBonus:        number,  // MOD terms summed, pre-penalty
//       dicePoolReduced:  number,  // dicePool with penalty applied to stat/statmod terms
//       flatBonusReduced: number,  // flatBonus with penalty applied
//       diceSlots:        [{ label, value, valueReduced, category, statCode, skillName, skillTier, ... }, ...],
//       flatSlots:        [{ ...same shape... }, ...],
//       error:            string|null
//     },
//     damage: { ... same shape ... },
//     dice:   number,         // weapon's damage dice count (the D10s)
//     pen:    number,
//     tags:   [{ id, name, description }, ...],
//     // Melee-only:
//     ranges: [{s,e}, ...],   // pass-through from snapshot
//     // Ranged-only:
//     range:       number,    // base range in feet
//     ammo:        { raw, resolved, error },
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

function resolveRollFormula(formulaStr, symbols, weaponSymbols, character, ruleset, penaltyPct) {
  if (!formulaStr || typeof formulaStr !== 'string') {
    return {
      formula: '', dicePool: 0, flatBonus: 0,
      dicePoolReduced: 0, flatBonusReduced: 0,
      diceSlots: [], flatSlots: [], error: 'Missing formula'
    };
  }
  const mergedSymbols = Object.assign({}, symbols, weaponSymbols);
  const compiled = parseFormula(formulaStr);
  if (compiled.error) {
    return {
      formula: formulaStr, dicePool: 0, flatBonus: 0,
      dicePoolReduced: 0, flatBonusReduced: 0,
      diceSlots: [], flatSlots: [], error: compiled.message || 'Parse error'
    };
  }
  const total = evalFormula(compiled, mergedSymbols);
  if (total == null) {
    const missing = listMissingVars(compiled, mergedSymbols);
    return {
      formula:   formulaStr,
      dicePool:  0,
      flatBonus: 0,
      dicePoolReduced: 0,
      flatBonusReduced: 0,
      diceSlots: [],
      flatSlots: [],
      error:     missing.length > 0 ? 'Missing: ' + missing.join(', ') : 'Eval error'
    };
  }
  const terms = extractAdditiveTerms(compiled, mergedSymbols, character, ruleset);
  const diceSlots = [];
  const flatSlots = [];
  let dicePool  = 0;
  let flatBonus = 0;
  // Penalty-reduced versions. Penalty reduces DICE POOLS — stat and
  // skill contributions. It does NOT reduce STATMOD (a flat success
  // bonus, not a dice pool), weapon constants (DMG/PEN/ATK), or
  // literals. STATMOD has its own separate coupling to Difficulty
  // (handled in the UI layer, not here). Penalty applies per-term
  // and is floored (matches Roll Calc's Math.floor behavior).
  let dicePoolReduced  = 0;
  let flatBonusReduced = 0;
  const pen = Number.isFinite(penaltyPct) ? Math.max(0, Math.min(100, penaltyPct)) : 0;
  terms.forEach(term => {
    const affectedByPenalty = (term.category === 'stat' || term.category === 'skill');
    if (affectedByPenalty && pen > 0) {
      // Math.floor(abs * pen) preserves sign. The reduction magnitude is
      // subtracted from the absolute value, then re-signed.
      const mag = Math.abs(term.value);
      const reducedMag = Math.max(0, mag - Math.floor(mag * pen / 100));
      term.valueReduced = term.sign * reducedMag;
    } else {
      term.valueReduced = term.value;
    }
    if (term.isFlat) {
      flatBonus += term.value;
      flatBonusReduced += term.valueReduced;
      flatSlots.push(term);
    } else {
      dicePool += term.value;
      dicePoolReduced += term.valueReduced;
      diceSlots.push(term);
    }
  });
  dicePool        = Math.max(0, Math.floor(dicePool));
  dicePoolReduced = Math.max(0, Math.floor(dicePoolReduced));
  // Flat bonus stays signed (can be negative), but penalty can't flip
  // its sign — if it's +2 and reduced it's still +something or 0.
  return {
    formula:   formulaStr,
    dicePool,
    flatBonus,
    dicePoolReduced,
    flatBonusReduced,
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
      case 'call':  node.args.forEach(a => walk(a)); break;
    }
  };
  walk(compiled.ast);
  return Array.from(missing);
}

// Look up a variable name against the character + ruleset to figure
// out what category it is. Categories drive UI behavior — stats get
// penalty-reduced, skills contribute Difficulty mitigation based on
// tier, weapon constants (DMG/PEN/ATK) stay raw, MOD-suffixed vars
// are flat-bonus.
//
// Returns an object:
//   { category: 'stat'|'statmod'|'skill'|'weaponConst'|'literal'|'unknown',
//     statCode:    string,   // when category === 'stat' or 'statmod', the STAT code (STR/DEX/etc)
//     skillName:   string,   // when category === 'skill', the skill name as stored in char
//     skillTier:   'primary'|'secondary'|'specialty'|null  // only for skills
//   }
//
// The lookup is case-sensitive for skill names (character.skills entries
// use their canonical casing from the ruleset definition) but matches
// stat codes uppercase.
function classifyVar(name, character, ruleset) {
  if (!name) return { category: 'literal' };
  // Weapon constants — injected by resolveWeapon before evaluation.
  if (name === 'DMG' || name === 'PEN' || name === 'ATK' || name === 'WEAPONDMGMOD') {
    return { category: 'weaponConst' };
  }
  // MOD-suffixed. Could be a stat-MOD (DEXMOD) or a freestanding MOD var
  // (DMGMOD on ranged weapons, which we alias to WEAPONDMGMOD). We
  // classify both as 'statmod' for UI purposes — flat bonus, derived
  // from an underlying stat if one exists.
  if (/MOD$/.test(name)) {
    const stripped = name.replace(/MOD$/, '').toUpperCase();
    const baseStat = (ruleset && Array.isArray(ruleset.stats))
      ? ruleset.stats.find(s => s && (s.code || '').toUpperCase() === stripped)
      : null;
    return {
      category: 'statmod',
      statCode: baseStat ? baseStat.code.toUpperCase() : stripped
    };
  }
  // Base stat — case-insensitive match against ruleset.stats.
  if (ruleset && Array.isArray(ruleset.stats)) {
    const match = ruleset.stats.find(s => s && (s.code || '').toUpperCase() === name.toUpperCase());
    if (match) return { category: 'stat', statCode: match.code.toUpperCase() };
  }
  // Skills — check primary, then secondary, then specialty. Skill
  // names can contain spaces or hyphens ("Knife Fighting") that get
  // stripped when they're injected into a formula (the formula engine
  // only allows [A-Za-z0-9_] identifiers). When the override system
  // substitutes in a multi-word skill, the resulting formula has the
  // SANITIZED form. We match BOTH the exact name and the sanitized
  // form so the classifier correctly identifies the skill regardless.
  const skills = (character && character.skills) || {};
  const primarySkills = (ruleset && Array.isArray(ruleset.primarySkills)) ? ruleset.primarySkills : [];
  const sanitize = (s) => String(s || '').replace(/[^A-Za-z0-9_]+/g, '');
  const nameMatches = (skillName) =>
    skillName === name || sanitize(skillName) === name;

  const primaryHit = primarySkills.find(s => s && nameMatches(s.name));
  if (primaryHit) {
    return { category: 'skill', skillName: primaryHit.name, skillTier: 'primary' };
  }
  if (Array.isArray(skills.secondary)) {
    const hit = skills.secondary.find(s => s && nameMatches(s.name));
    if (hit) return { category: 'skill', skillName: hit.name, skillTier: 'secondary' };
  }
  if (Array.isArray(skills.specialty)) {
    const hit = skills.specialty.find(s => s && nameMatches(s.name));
    if (hit) return { category: 'skill', skillName: hit.name, skillTier: 'specialty' };
  }
  return { category: 'unknown' };
}

// Break a compiled additive expression into human-readable terms for
// the slot hint. Only handles top-level + and - chains; anything more
// complex (multiplication, function calls at the top) gets returned as
// a single opaque "formula" slot. This is fine because the four
// ruleset weapon formulas are all simple sums in practice.
//
// Each term carries:
//   label       — human-readable name for the leaf (usually the variable)
//   value       — evaluated numeric value (signed by the containing +/- chain)
//   sign        — +1 or -1
//   isFlat      — true if the leaf references any MOD-suffixed variable
//   category    — 'stat'|'statmod'|'skill'|'weaponConst'|'literal'|'unknown'
//                 (from classifyVar on the first var ref in the leaf)
//   statCode    — populated when category is 'stat' or 'statmod'
//   skillName   — populated when category is 'skill'
//   skillTier   — 'primary'|'secondary'|'specialty'|null when skill
//
// The category info lets the readout UI distinguish "reduce this by
// Penalty" (stat/statmod) from "leave alone" (skill/weaponConst) and
// apply Difficulty mitigation when a secondary/specialty skill is in
// the slot.
function extractAdditiveTerms(compiled, symbols, character, ruleset) {
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
    const rawLabel = termLabel(node);
    const varRefs = [];
    collectVarRefs(node, varRefs);
    const isFlat = varRefs.some(isFlatVar);
    // Classify using the FIRST variable reference in the leaf. In the
    // common case every leaf is a single variable — edge cases like
    // "2 * STR" still classify as 'stat' because STR is the first ref.
    const firstVar = varRefs[0];
    const classification = firstVar
      ? classifyVar(firstVar, character, ruleset)
      : { category: 'literal' };
    // Prefer the classification's `skillName` (which is the ORIGINAL,
    // human-readable name like "Knife Fighting") over the formula
    // label ("KnifeFighting"). Stats and other categories fall back
    // to the formula label.
    const displayLabel = (classification.category === 'skill' && classification.skillName)
      ? classification.skillName
      : rawLabel;
    terms.push({
      label:     displayLabel,
      value:     (v == null ? 0 : v) * sign,
      sign,
      isFlat,
      category:  classification.category,
      statCode:  classification.statCode  || null,
      skillName: classification.skillName || null,
      skillTier: classification.skillTier || null
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

// Rewrite variable names in a formula string using a substitution map.
// Whole-identifier match only — swapping 'DEX' to 'INT' won't touch
// 'DEXMOD' or 'INDEX' (boundaries \b on each side). Used to apply
// per-instance slot overrides without needing to re-parse the formula.
//
// mapping: { [fromVar]: toVar, ... } — keys are original var names,
//          values are the replacements. Empty/nullable mapping returns
//          the formula unchanged.
//
// The formula engine's identifier grammar only accepts [A-Za-z0-9_]+,
// so replacement values are sanitized (non-alphanumeric stripped) to
// match the variable-safe version that char-derived.js writes into
// the symbol table. A skill named "Knife Fighting" becomes
// "KnifeFighting" in the formula, which resolves correctly because
// buildSymbolTable() aliases it under both the original and sanitized
// names.
function applyOverrides(formula, mapping) {
  if (typeof formula !== 'string') return formula;
  if (!mapping || typeof mapping !== 'object') return formula;
  const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_]+/g, '');
  let out = formula;
  Object.keys(mapping).forEach(fromVar => {
    const toVar = mapping[fromVar];
    if (!fromVar || !toVar) return;
    const safeTo = sanitize(toVar);
    if (!safeTo || fromVar === safeTo) return;
    const esc = fromVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, 'g');
    out = out.replace(re, safeTo);
  });
  return out;
}

// MAIN ENTRY POINT.
//
// weapon     — the weapon snapshot object from an inventory entry.
//              Shape matches what coerceWeapon() in ruleset-defaults.js
//              produces: { kind, dice, pen, tags, ranges?|range?, ... }.
// character  — live character doc (charData).
// ruleset    — active ruleset.
// overrides  — optional per-instance slot substitutions to customize
//              which stat/skill each formula slot uses. Shape:
//                {
//                  attack: { [fromVar]: toVar, ... },
//                  damage: { [fromVar]: toVar, ... }
//                }
//              Example: { attack: { DEX: 'INT', Melee: 'Stealth' } }
//              rewrites "DEX + Melee + DEXMOD" to
//              "INT + Stealth + DEXMOD" before evaluation. The DEXMOD
//              stays because the override only touched DEX/Melee.
//              Null/missing means no override.
// atkResult  — optional contested attack result (number). When provided,
//              ATK resolves to this value in the damage formula instead
//              of 0. Lets the damage readout show the actual total once
//              the player has rolled their attack.
// penaltyPct — optional penalty percentage (0-100) to apply to stat and
//              statmod terms. Skills, weapon constants, and literals
//              are not reduced. Missing or 0 means no penalty.
// rapidfireExtra — optional non-negative integer. Number of EXTRA
//              AMMO spent beyond the base 1 shot, for ranged weapons.
//              Each extra +1 DMGMOD; Difficulty increases only where
//              the resulting effective DMGMOD exceeds the character's
//              STR (recoil check). ROF value mitigates the increased
//              Difficulty, absorbing it point-for-point up to the ROF
//              value. Ignored for melee weapons. The UI is responsible
//              for reading `out.rapidfire.finalDifficulty` and folding
//              it into the Difficulty row.
//
// Returns the readout object described at the top of this file. If the
// weapon argument is null/undefined or has no kind, returns null.
export function resolveWeapon(weapon, character, ruleset, overrides, atkResult, penaltyPct, rapidfireExtra, currentRange) {
  if (!weapon || (weapon.kind !== 'melee' && weapon.kind !== 'ranged')) return null;

  const symbols = buildSymbolTable(character || {}, ruleset || {});
  const rsWeapons = (ruleset && ruleset.weapons) || {};
  const rsTags    = Array.isArray(ruleset && ruleset.weaponTags) ? ruleset.weaponTags : [];

  // Normalize rapidfire input. Two modes:
  //   - Number  : legacy single value. Goes to the damage bucket.
  //   - Object  : { damage: N, sweep: M }. N AMMO boost DMGMOD and
  //     provoke recoil. M AMMO widen the Rapidfire Sweep cube and do
  //     NOT grant DMGMOD — the player splits a single AMMO pool
  //     between the two modes. Both are integer ≥ 0.
  // Only meaningful for ranged weapons.
  let rfDamage = 0;
  let rfSweep = 0;
  if (weapon.kind === 'ranged') {
    if (typeof rapidfireExtra === 'object' && rapidfireExtra !== null) {
      if (Number.isFinite(rapidfireExtra.damage) && rapidfireExtra.damage > 0) {
        rfDamage = Math.floor(rapidfireExtra.damage);
      }
      if (Number.isFinite(rapidfireExtra.sweep) && rapidfireExtra.sweep > 0) {
        rfSweep = Math.floor(rapidfireExtra.sweep);
      }
    } else if (Number.isFinite(rapidfireExtra) && rapidfireExtra > 0) {
      rfDamage = Math.floor(rapidfireExtra);
    }
  }
  // Legacy alias for existing callers/readers of rapidfire that
  // expect a single rfExtra. rfExtra == rfDamage for all downstream
  // math (only damage-extra creates DMGMOD + recoil; sweep-extra is
  // handled separately in the Rapidfire Sweep tag block).
  const rfExtra = rfDamage;

  // Compute the Shotgun close-range damage bonus up front so we can
  // bake it into DMGMOD before the damage formula evaluates. The
  // bonus is: +3 ≤ range × 0.25, +2 ≤ range × 0.5, +1 ≤ range,
  // 0 past range. Only applies when the Shotgun tag is present AND
  // a current engagement range is set. Tag detection happens below
  // (case-insensitive name match); we do it early here so the
  // weapon symbols can include the bonus.
  let shotgunBonus = 0;
  let shotgunZoneLabel = null;
  const tagIdsForEarly = Array.isArray(weapon.tags) ? weapon.tags : [];
  const earlyTagNames = new Set(tagIdsForEarly
    .map(id => rsTags.find(t => t.id === id))
    .filter(Boolean)
    .map(t => (t.name || '').toLowerCase()));
  const hasShotgunTag = earlyTagNames.has('shotgun');
  if (hasShotgunTag && weapon.kind === 'ranged'
      && Number.isFinite(currentRange) && currentRange >= 0) {
    const firstBandEnd = Number.isFinite(weapon.range) ? weapon.range : 0;
    if (firstBandEnd > 0) {
      if (currentRange <= firstBandEnd * 0.25) {
        shotgunBonus = 3; shotgunZoneLabel = 'point blank';
      } else if (currentRange <= firstBandEnd * 0.5) {
        shotgunBonus = 2; shotgunZoneLabel = 'close';
      } else if (currentRange <= firstBandEnd) {
        shotgunBonus = 1; shotgunZoneLabel = 'short';
      }
    }
  }

  // Weapon-local symbols overlaid on character symbols. DMGMOD falls
  // back to whatever the character symbol table already had (DEXMOD
  // or similar) so formulas that reference it outside the weapon's
  // own dmgmod work; the weapon's own dmgmod is a separate concept
  // stored under WEAPONDMGMOD for authors who want to distinguish.
  const weaponSymbols = {
    DMG: Number.isFinite(weapon.dice)   ? weapon.dice   : 0,
    PEN: Number.isFinite(weapon.pen)    ? weapon.pen    : 0,
    ATK: Number.isFinite(atkResult) ? Math.floor(atkResult) : 0
  };
  const baseDmgmod = (weapon.kind === 'ranged' && Number.isFinite(weapon.dmgmod))
    ? weapon.dmgmod
    : 0;
  if (weapon.kind === 'ranged') {
    // DMGMOD = base + rapidfire + shotgun close-range bonus. Each
    // source stacks in a single flat number the formula sees.
    weaponSymbols.WEAPONDMGMOD = baseDmgmod + rfExtra + shotgunBonus;
    weaponSymbols.DMGMOD       = weaponSymbols.WEAPONDMGMOD;
  } else {
    weaponSymbols.WEAPONDMGMOD = 0;
  }

  const rawAttackFormula = (weapon.kind === 'melee')
    ? (rsWeapons.meleeAttackFormula  || 'DEX + Melee + DEXMOD')
    : (rsWeapons.rangedAttackFormula || 'DEX + Ranged + DEXMOD');
  const rawDamageFormula = (weapon.kind === 'melee')
    ? (rsWeapons.meleeDamageFormula  || 'STR + DMG + ATK + STRMOD')
    : (rsWeapons.rangedDamageFormula || 'DEX + DMG + ATK + DMGMOD');

  // Apply per-instance slot overrides by rewriting variable names in
  // the formula string. Only whole-word substitutions are made, so
  // overriding 'DEX' to 'INT' won't accidentally rewrite 'DEXMOD'.
  const attackFormula = applyOverrides(rawAttackFormula, overrides && overrides.attack);
  const damageFormula = applyOverrides(rawDamageFormula, overrides && overrides.damage);

  const attack = resolveRollFormula(attackFormula, symbols, weaponSymbols, character, ruleset, penaltyPct);
  const damage = resolveRollFormula(damageFormula, symbols, weaponSymbols, character, ruleset, penaltyPct);

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

    // ─── TAG-DRIVEN MECHANICAL BEHAVIOR ────────────────────────────
    //
    // Detection is name-based (case-insensitive) so tags carry their
    // mechanics even when ids differ between rulesets. Names match
    // the Standard Set: Shotgun, Firearm, Scoped, Rapidfire Sweep,
    // Major Stabilization, Stabilization, Minor Stabilization.
    //
    // Each block emits a field on `out` that the UI reads. Missing
    // tags → field absent; the card skips the corresponding panel.

    const tagNames = new Set(tags.map(t => (t.name || '').toLowerCase().trim()));
    const hasTag = (name) => tagNames.has(name.toLowerCase());

    // Stabilization — the three tiers decrease recoil by 3/2/1
    // respectively. Only the HIGHEST tier counts if a weapon is
    // somehow tagged with multiple (a tripod is not also a bipod).
    // Stacks with ROF mitigation on top — ROF absorbs first, then
    // stabilization absorbs whatever rapidfire recoil remains.
    let stabilizationBonus = 0;
    let stabilizationLabel = null;
    if (hasTag('Major Stabilization'))      { stabilizationBonus = 3; stabilizationLabel = 'Major Stabilization'; }
    else if (hasTag('Stabilization'))       { stabilizationBonus = 2; stabilizationLabel = 'Stabilization'; }
    else if (hasTag('Minor Stabilization')) { stabilizationBonus = 1; stabilizationLabel = 'Minor Stabilization'; }
    if (stabilizationBonus > 0) {
      out.stabilization = {
        bonus: stabilizationBonus,
        label: stabilizationLabel
      };
    }

    // Scoped — expose the magnification + computed aim-action range
    // (base range × magnification). The card shows both numbers. The
    // magnification value comes from tagParams.t_scoped.magnification
    // (per-weapon override); if unset, falls back to the ruleset's
    // Scoped tag default (4×); if the ruleset doesn't define a
    // default, falls back to 1× (inert).
    if (hasTag('Scoped')) {
      let mag = null;
      const tp = weapon.tagParams && weapon.tagParams.t_scoped;
      if (tp && Number.isFinite(Number(tp.magnification))) {
        mag = Math.max(1, Number(tp.magnification));
      }
      if (mag == null) {
        // Look up ruleset default for the magnification param.
        const scopedDef = rsTags.find(t => (t.name || '').toLowerCase() === 'scoped');
        if (scopedDef && Array.isArray(scopedDef.params)) {
          const magParam = scopedDef.params.find(p => p.key === 'magnification');
          if (magParam && Number.isFinite(Number(magParam.default))) {
            mag = Math.max(1, Number(magParam.default));
          }
        }
      }
      if (mag == null) mag = 1;
      out.scoped = {
        magnification: mag,
        baseRange:     out.range,
        aimedRange:    out.range * mag
      };
    }

    // Shotgun — close-range damage bonus that's applied during damage
    // resolution (doesn't affect DMGMOD, and therefore doesn't affect
    // recoil). The UI computes which zone the current engagement
    // range falls in and exposes a chip; the damage block applies
    // the bonus once the player has selected an engagement range.
    //
    // The first range band's end is used as the reference point:
    //   distance ≤ band.end × 0.25 → +3 damage
    //   distance ≤ band.end × 0.5  → +2 damage
    //   distance ≤ band.end        → +1 damage
    //   distance >  band.end       → no bonus (past the first band)
    // Falls back to `range` for weapons without explicit bands.
    if (hasTag('Shotgun')) {
      const firstBandEnd = out.range;   // base range = end of the "first band"
      out.shotgun = {
        firstBandEnd,
        // Currently-active bonus/zone when engagement range is set.
        // Computed up-front (same time DMGMOD was built) so the card's
        // damage dice pool already includes it.
        activeBonus: shotgunBonus,
        activeZone:  shotgunZoneLabel,
        currentRange: Number.isFinite(currentRange) ? currentRange : null,
        zones: [
          { maxDist: firstBandEnd * 0.25, bonus: 3, label: 'point blank' },
          { maxDist: firstBandEnd * 0.5,  bonus: 2, label: 'close' },
          { maxDist: firstBandEnd,        bonus: 1, label: 'short' }
        ]
      };
    }

    // Rapidfire Sweep — ROF ≥ 2 gates this tag's effect. Each AMMO
    // spent into the SWEEP bucket (from the split rapidfire control)
    // widens the cubic AOE by 2.5×ROF feet on every side, starting
    // from nothing at 0-1 AMMO. Side = 2.5 × ROF × max(0, sweepAmmo − 1).
    // Volume = side³. The area can take ANY shape whose volume does
    // not exceed this cube (line, cone, zig-zag, dome, irregular).
    //
    // Key separation: AMMO spent on a sweep does NOT grant the
    // Rapidfire damage bonus. The player splits a single AMMO pool
    // between the two modes via the UI's two-input rapidfire panel.
    // `computeArea(ammo)` stays exported so authors and tools can
    // preview arbitrary splits without touching the card's state.
    //
    //   ROF 2, 2 AMMO  → side 5,  volume 125        (5×5×5)
    //   ROF 2, 3 AMMO  → side 10, volume 1,000      (10×10×10)
    //   ROF 2, 6 AMMO  → side 25, volume 15,625     (25×25×25)
    //   ROF 3, 4 AMMO  → side 22.5, volume ~11,391  (22.5×22.5×22.5)
    if (hasTag('Rapidfire Sweep')) {
      const rofRaw = out.rof && out.rof.resolved;
      const rofValue = Number.isFinite(Number(rofRaw)) ? Math.max(0, Number(rofRaw)) : 0;
      const computeArea = function(ammo) {
        const a = Math.max(0, Math.floor(ammo || 0));
        if (a < 2 || rofValue < 2) return { sideLen: 0, area: 0, volume: 0, ammo: a };
        const side = 2.5 * rofValue * (a - 1);
        const area = side * side;
        const volume = side * side * side;
        return { sideLen: side, area, volume, ammo: a };
      };
      const activeArea = computeArea(rfSweep);
      out.rapidfireSweep = {
        available: rofValue >= 2,
        rofValue,
        activeAmmo: rfSweep,             // how many AMMO the player selected
        sideLen:    activeArea.sideLen,   // current cube side (0 when < 2 ammo)
        area:       activeArea.area,
        volume:     activeArea.volume,
        computeArea                       // for arbitrary "what if?" previews
      };
    }

    // Firearm — pure description, no math. The card still shows the
    // tag's description prominently so players can see the
    // dodge/defense difficulty bonuses. We don't emit anything
    // special here — the base `tags` array already carries the
    // description for hover.

    // ─── RAPIDFIRE ─────────────────────────────────────────────────
    // Recoil is driven by the TOTAL AMMO expended past the first shot,
    // regardless of whether it went to the damage or sweep pool —
    // both cause the weapon to climb. Only the damage pool actually
    // boosts DMGMOD on the damage roll; the sweep pool feels like
    // DMGMOD to the recoil check but doesn't add to damage output.
    //
    //   effectiveDmgmod = baseDmgmod + damageExtra              (goes into the damage formula)
    //   recoilRef       = baseDmgmod + damageExtra + sweepExtra (used ONLY for the recoil check)
    //   recoilDifficulty = min(damageExtra + sweepExtra, max(0, recoilRef − STR))
    //
    // ROF mitigates first, stabilization absorbs whatever's left.
    // Both are Difficulty Mitigation in the standard sense — they
    // cancel point-for-point and flow into the Attack block's
    // Difficulty row alongside range/skill mitigation.
    if (rfDamage > 0 || rfSweep > 0) {
      const strVal = Number.isFinite(Number(symbols.STR)) ? Number(symbols.STR) : 0;
      const totalExtra = rfDamage + rfSweep;
      // Actual DMGMOD on the damage roll — only damage-pool AMMO
      // contributes. Sweep AMMO is for area, not damage.
      const effectiveDmgmod = baseDmgmod + rfDamage;
      // Recoil reference — both pools count toward how hard the
      // weapon kicks. A sweep-heavy spray still needs STR to hold
      // on target, even though it's not pushing DMGMOD up.
      const recoilRef = baseDmgmod + totalExtra;
      const overCapacity = Math.max(0, recoilRef - strVal);
      // Capped at totalExtra — you can't be punished for more recoil
      // than the extra AMMO you chose to spend this action.
      const recoilDifficulty = Math.min(totalExtra, overCapacity);
      // ROF absorption FIRST.
      const rofRaw = out.rof && out.rof.resolved;
      const rofValue = Number.isFinite(Number(rofRaw)) ? Math.max(0, Number(rofRaw)) : 0;
      const rofMitigation = Math.min(recoilDifficulty, rofValue);
      // Stabilization absorbs whatever ROF didn't.
      const afterRof = recoilDifficulty - rofMitigation;
      const stabMitigation = Math.min(afterRof, stabilizationBonus);
      const finalDifficulty = afterRof - stabMitigation;

      out.rapidfire = {
        // Split AMMO — UI reads both.
        damageExtra:       rfDamage,
        sweepExtra:        rfSweep,
        totalExtra,
        // Legacy alias for any code still reading `extra` as
        // "rapidfire damage extra". Always == damageExtra.
        extra:             rfDamage,
        dmgmodBonus:       rfDamage,
        baseDmgmod,
        effectiveDmgmod,   // damage-roll DMGMOD (excludes sweep)
        recoilRef,         // recoil-check DMGMOD (includes sweep)
        strVal,
        overCapacity,       // raw STR shortfall (uncapped)
        recoilDifficulty,   // capped at totalExtra
        rofValue,
        rofMitigation,
        stabilizationBonus,
        stabilizationLabel,
        stabilizationMitigation: stabMitigation,
        finalDifficulty,
        // Total AMMO consumed this action = 1 base shot + damage extra
        // + sweep extra. Both split pools contribute to the AMMO bill.
        totalAmmoCost:     1 + rfDamage + rfSweep
      };
    }
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
  // Iterate backwards so that on boundary ties — distance exactly
  // equal to the END of band N and the START of band N+1 — the
  // HIGHER band wins. This matches user intent: clicking the
  // "+3 3–4ft" chip sends distance=3, which would otherwise land in
  // band 2 (2–3ft) because both intervals include 3. Backward walk
  // finds band 3 first.
  for (let i = normalized.length - 1; i >= 0; i--) {
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
