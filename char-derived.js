// char-derived.js
// Formula evaluator and derived-stat pipeline for the Combat tab.
//
// Exports:
//   parseFormula(src)           -> compiled formula (or { error, message })
//   evalFormula(compiled, vars) -> number (or null if vars missing)
//   buildSymbolTable(character, ruleset) -> { STR, DEX, ..., HP, AGL, ... }
//   computeDerivedStats(character, ruleset) -> { stats: Map, locations: Array, errors: Array }
//
// The formula grammar (safe — no JS eval, no arbitrary code):
//
//   expr    := term (('+' | '-') term)*
//   term    := power (('*' | '/') power)*
//   power   := unary ('^' unary)?
//   unary   := ('-' | '+')? atom
//   atom    := NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')'
//   args    := expr (',' expr)*
//
// Supported functions: floor, ceil, round, min, max, abs.
// Variables: passed in at eval time.
//
// Unknown variables → result is null (NOT zero) so callers can distinguish
// "missing data" from "formula says zero". Unknown functions → parse error.

// ─── TOKENIZER ───

const TOKEN_RE = /\s*(?:([0-9]+(?:\.[0-9]+)?)|([A-Za-z_][A-Za-z0-9_]*)|([+\-*/^(),]))/y;

function tokenize(src) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let lastIdx = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    // Skip trailing whitespace cleanly
    const nonWs = src.slice(TOKEN_RE.lastIndex).search(/\S/);
    if (nonWs === -1) break;
    const m = TOKEN_RE.exec(src);
    if (!m) {
      throw new Error(`Unexpected character at position ${TOKEN_RE.lastIndex}: "${src[TOKEN_RE.lastIndex]}"`);
    }
    if (m[1] !== undefined)      tokens.push({ type: 'num',   value: parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: 'ident', value: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: 'op',    value: m[3] });
    lastIdx = TOKEN_RE.lastIndex;
  }
  return tokens;
}

// ─── PARSER (recursive descent) ───
//
// Produces an AST of plain JS objects. Each node has a `kind`:
//   num    { kind:'num',   value:Number }
//   var    { kind:'var',   name:String }
//   unary  { kind:'unary', op:String, arg:Node }
//   binop  { kind:'binop', op:String, left:Node, right:Node }
//   call   { kind:'call',  name:String, args:[Node] }

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (type, value) => {
    const t = tokens[pos];
    if (!t) throw new Error('Unexpected end of formula');
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${value || type} but got "${t.value}"`);
    }
    pos++;
    return t;
  };

  // expr := term (('+' | '-') term)*
  const parseExpr = () => {
    let left = parseTerm();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  };

  // term := power (('*' | '/') power)*
  const parseTerm = () => {
    let left = parsePower();
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = tokens[pos++].value;
      const right = parsePower();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  };

  // power := unary ('^' unary)?  — right-associative
  const parsePower = () => {
    const base = parseUnary();
    if (peek() && peek().type === 'op' && peek().value === '^') {
      pos++;
      const exp = parsePower();   // right-associative recursion
      return { kind: 'binop', op: '^', left: base, right: exp };
    }
    return base;
  };

  // unary := ('-' | '+')? atom
  const parseUnary = () => {
    if (peek() && peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = tokens[pos++].value;
      const arg = parseUnary();
      return { kind: 'unary', op, arg };
    }
    return parseAtom();
  };

  // atom := NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')'
  const parseAtom = () => {
    const t = peek();
    if (!t) throw new Error('Unexpected end of formula');
    if (t.type === 'num') {
      pos++;
      return { kind: 'num', value: t.value };
    }
    if (t.type === 'ident') {
      pos++;
      // Check for function call
      if (peek() && peek().type === 'op' && peek().value === '(') {
        pos++;
        const args = [];
        if (!peek() || peek().value !== ')') {
          args.push(parseExpr());
          while (peek() && peek().type === 'op' && peek().value === ',') {
            pos++;
            args.push(parseExpr());
          }
        }
        eat('op', ')');
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'var', name: t.value };
    }
    if (t.type === 'op' && t.value === '(') {
      pos++;
      const inner = parseExpr();
      eat('op', ')');
      return inner;
    }
    throw new Error(`Unexpected token: "${t.value}"`);
  };

  const result = parseExpr();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing token: "${tokens[pos].value}"`);
  }
  return result;
}

// ─── FUNCTIONS ───
// Whitelist of allowed functions. Anything else is a parse/eval error.

const FUNCTIONS = {
  floor: (args) => Math.floor(args[0]),
  ceil:  (args) => Math.ceil(args[0]),
  round: (args) => Math.round(args[0]),
  min:   (args) => Math.min(...args),
  max:   (args) => Math.max(...args),
  abs:   (args) => Math.abs(args[0])
};

// ─── EVALUATOR ───
//
// Returns a Number, or null if any referenced variable is missing.
// Throws on function call errors or division by zero.

function evalNode(node, vars) {
  switch (node.kind) {
    case 'num': return node.value;
    case 'var': {
      if (!(node.name in vars)) return null;
      return vars[node.name];
    }
    case 'unary': {
      const v = evalNode(node.arg, vars);
      if (v === null) return null;
      return node.op === '-' ? -v : v;
    }
    case 'binop': {
      const l = evalNode(node.left, vars);
      const r = evalNode(node.right, vars);
      if (l === null || r === null) return null;
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new Error('Division by zero');
          return l / r;
        case '^': return Math.pow(l, r);
      }
      throw new Error(`Unknown operator: ${node.op}`);
    }
    case 'call': {
      const fn = FUNCTIONS[node.name.toLowerCase()];
      if (!fn) throw new Error(`Unknown function: ${node.name}`);
      const args = node.args.map(a => evalNode(a, vars));
      if (args.some(v => v === null)) return null;
      return fn(args);
    }
  }
  throw new Error(`Unknown node kind: ${node.kind}`);
}

// ─── PUBLIC API ───

// Compute total XP cost of a given Power Pool level for this ruleset.
// Respects costMode ('perPoint' flat vs 'perLevel' table).
// Returns 0 for level 0 or if Power Pool is disabled.
export function powerPoolXpCost(level, ruleset) {
  const pp = ruleset && ruleset.powerPool;
  if (!pp || !pp.enabled) return 0;
  const lv = Math.max(0, Math.floor(level || 0));
  if (lv === 0) return 0;
  if (pp.costMode === 'perPoint') {
    const rate = Number.isFinite(pp.costPerPoint) ? pp.costPerPoint : 0;
    return lv * rate;
  }
  // perLevel — sum costs for levels 1..lv (index 0 is typically 0 = "no pool bought")
  const table = Array.isArray(pp.xpPerPoint) ? pp.xpPerPoint : [];
  let total = 0;
  for (let i = 1; i <= lv; i++) {
    total += Number.isFinite(table[i]) ? table[i] : 0;
  }
  return total;
}

// parseFormula(src) -> { ast } or { error, message }
// Valid formulas return { ast }. Invalid ones return { error: true, message }.
export function parseFormula(src) {
  if (typeof src !== 'string' || !src.trim()) {
    return { error: true, message: 'Empty formula' };
  }
  try {
    const ast = parse(src);
    return { ast };
  } catch (e) {
    return { error: true, message: e.message };
  }
}

// evalFormula(compiled, vars) -> number or null
// If compiled is an error object, returns null.
// If any variable is missing, returns null (caller should display "—").
// If eval throws (div by zero, unknown fn), returns null.
export function evalFormula(compiled, vars) {
  if (!compiled || compiled.error || !compiled.ast) return null;
  try {
    const result = evalNode(compiled.ast, vars);
    if (result === null) return null;
    if (!Number.isFinite(result)) return null;
    return result;
  } catch (e) {
    return null;
  }
}

// ─── SYMBOL TABLE BUILDER ───
//
// Assembles the variable dictionary passed to evalFormula based on the
// character's current stats and the ruleset's STATMOD table.
//
// Includes:
//   - Raw stat values by code (STR, DEX, SIZE, ...)
//   - STATMODs by code (STRMOD, DEXMOD, SIZEMOD, ...)
//   - Purchased resources: POWERPOOL
//   - POW_MULTIPLIER derived from the ruleset's powMultiplier table
//
// Derived stats themselves are added incrementally by computeDerivedStats
// after each one evaluates, so later stats can reference earlier ones.

export function buildSymbolTable(character, ruleset) {
  const table = {};
  const stats = character.stats || {};
  const statMods = ruleset.statMods || [];

  // Base stats by code.
  (ruleset.stats || []).forEach(s => {
    const code = (s.code || '').toUpperCase();
    if (!code) return;
    const lowerKey = code.toLowerCase();
    const value = (typeof stats[lowerKey] === 'number') ? stats[lowerKey] : 2;
    table[code] = value;
    // STATMOD for this stat, looked up by level index.
    const modKey = code + 'MOD';
    const modVal = statMods[value];
    table[modKey] = (typeof modVal === 'number') ? modVal : 0;
  });

  // SIZE is stored outside the main stats list but lives in stats.size.
  if (typeof stats.size === 'number') {
    table.SIZE = stats.size;
    // SIZEMOD derives from SIZE relative to Medium (the reference tier).
    // Medium is SIZE 4 in the PRIME Basic Set, so SIZEMOD = SIZE - 4.
    // This makes Medium=0, Large=+2, Tiny=-2, etc. Homebrew rulesets with
    // different SIZE scales should compute SIZEMOD in their formulas using
    // raw SIZE if this convention doesn't fit.
    table.SIZEMOD = stats.size - 4;
  } else {
    table.SIZE = 4;
    table.SIZEMOD = 0;
  }

  // Power Pool purchased value.
  const pp = (typeof character.powerPool === 'number') ? character.powerPool : 0;
  table.POWERPOOL = pp;

  // POW_MULTIPLIER from ruleset table, looked up by POWMOD (the stat modifier
  // from POW). Allows rulesets to express a "POW capability scaling" curve
  // where low POW is penalized, mid-range is average, and high POW multiplies
  // resources linearly. The PRIME Basic Set curve is:
  //   POWMOD ≤ -1 → ×0.5, 0 → ×1, 1 → ×1.5, 2+ → equals POWMOD.
  const powmod = table.POWMOD ?? 0;
  const multTable = (ruleset.powerPool && Array.isArray(ruleset.powerPool.powMultiplier))
    ? ruleset.powerPool.powMultiplier : [];
  const entry = multTable.find(e => powmod >= e.powmodMin && powmod <= e.powmodMax);
  table.POW_MULTIPLIER = entry ? entry.value : 1;

  return table;
}

// ─── DEPENDENCY RESOLUTION ───
//
// Given a list of derived stat definitions, topologically sort them so that
// stats only reference earlier-evaluated stats. Stats with missing/broken
// dependencies still get included in the output (they'll eval to null) but
// are reported in the errors list.
//
// Returns { ordered: [defs in eval order], errors: [{code, message}] }.

function collectVarRefs(node, out) {
  if (!node) return;
  switch (node.kind) {
    case 'var':   out.add(node.name); break;
    case 'unary': collectVarRefs(node.arg, out); break;
    case 'binop': collectVarRefs(node.left, out); collectVarRefs(node.right, out); break;
    case 'call':  node.args.forEach(a => collectVarRefs(a, out)); break;
  }
}

function topoSort(defs, baseVarNames) {
  // Map code -> def.
  const byCode = new Map();
  defs.forEach(d => byCode.set(d.code, d));

  // Compile each formula once.
  const compiled = new Map();
  defs.forEach(d => compiled.set(d.code, parseFormula(d.formula)));

  // Figure dependencies on OTHER derived stats (not base vars).
  const deps = new Map();
  defs.forEach(d => {
    const c = compiled.get(d.code);
    if (c.error || !c.ast) { deps.set(d.code, []); return; }
    const refs = new Set();
    collectVarRefs(c.ast, refs);
    // Keep only refs that point to other derived stats.
    const thisDeps = [];
    refs.forEach(r => {
      if (byCode.has(r) && r !== d.code) thisDeps.push(r);
    });
    deps.set(d.code, thisDeps);
  });

  // Kahn's algorithm. Stats with circular deps remain unresolved → error.
  const inDegree = new Map();
  defs.forEach(d => inDegree.set(d.code, 0));
  deps.forEach((list, code) => {
    list.forEach(dep => {
      inDegree.set(code, (inDegree.get(code) || 0) + 1);
    });
  });

  const queue = [];
  inDegree.forEach((deg, code) => { if (deg === 0) queue.push(code); });

  const ordered = [];
  const errors = [];

  while (queue.length > 0) {
    const code = queue.shift();
    ordered.push(byCode.get(code));
    // For each stat that depends on this one, decrement its indegree.
    defs.forEach(d => {
      if (deps.get(d.code).includes(code)) {
        inDegree.set(d.code, inDegree.get(d.code) - 1);
        if (inDegree.get(d.code) === 0) queue.push(d.code);
      }
    });
  }

  // Anything left unresolved is circular.
  if (ordered.length < defs.length) {
    const unresolved = defs.filter(d => !ordered.includes(d));
    unresolved.forEach(d => {
      errors.push({ code: d.code, message: 'Circular dependency' });
      ordered.push(d);  // include so the UI can still show "ERR"
    });
  }

  return { ordered, compiled, errors };
}

// ─── MAIN PIPELINE ───
//
// computeDerivedStats(character, ruleset) -> {
//   stats: Map<code, { def, value, error? }>,
//   locations: [{ def, index, maxHP, currentDamage, thresholds: {disabled, destroyed, definitelyDestroyed}, status }],
//   errors: [{code, message}]
// }
//
// `stats` is keyed by derived stat code. Value is null if the formula failed.
// `locations` expands hitLocations × count into individual tracked locations
// (e.g. 2 arms → arm-1 and arm-2 with their own currentDamage).
// `status` for locations is one of: 'healthy', 'disabled', 'destroyed',
// 'definitelyDestroyed'.

export function computeDerivedStats(character, ruleset) {
  const errors = [];

  // 1. Build initial symbol table from base stats.
  const vars = buildSymbolTable(character, ruleset);

  // 2. Evaluate derived stats in dependency order.
  const defs = Array.isArray(ruleset.derivedStats) ? ruleset.derivedStats : [];
  const { ordered, compiled, errors: sortErrors } = topoSort(defs, Object.keys(vars));
  sortErrors.forEach(e => errors.push(e));

  const stats = new Map();
  ordered.forEach(def => {
    const c = compiled.get(def.code);
    if (c.error) {
      stats.set(def.code, { def, value: null, error: c.message });
      errors.push({ code: def.code, message: c.message });
      return;
    }
    let value = evalFormula(c, vars);
    if (value !== null && !def.keepDecimals) value = Math.floor(value);
    // Add to symbol table so downstream stats can reference this one.
    if (value !== null) vars[def.code] = value;
    stats.set(def.code, { def, value });
  });

  // 3. Evaluate hit locations. Each has its own formula; maxHP is the result
  //    of hpFormula, and each location × count gets its own damage tracker.
  const locations = [];
  const locDefs = Array.isArray(ruleset.hitLocations) ? ruleset.hitLocations : [];
  const damageMap = (character.hitLocationDamage && typeof character.hitLocationDamage === 'object')
    ? character.hitLocationDamage : {};

  // Hit location modifiers: { trackKey: [{ name, value }, ...], ... }
  // Each modifier is added to that instance's maxHP. Tracked per instance,
  // not per location def, so "arm-1" and "arm-2" can have different mods.
  const hlModsMap = (character.hitLocationModifiers && typeof character.hitLocationModifiers === 'object')
    ? character.hitLocationModifiers : {};

  locDefs.forEach(def => {
    const compiledHp = parseFormula(def.hpFormula);
    let baseMaxHP = evalFormula(compiledHp, vars);
    let err = null;
    if (compiledHp.error) { err = compiledHp.message; baseMaxHP = null; }
    else if (baseMaxHP !== null) baseMaxHP = Math.floor(baseMaxHP);

    for (let i = 1; i <= (def.count || 1); i++) {
      // Build the tracking key. Single-count locations use just the code
      // (e.g. "head"), multi-count use code-N (e.g. "arm-1").
      const trackKey = (def.count && def.count > 1) ? `${def.code}-${i}` : def.code;
      const currentDamage = (typeof damageMap[trackKey] === 'number') ? damageMap[trackKey] : 0;

      // Apply modifiers. Each modifier adds its value (positive or negative)
      // to the base maxHP computed from the formula. Clamp min to 0 so a
      // pile of negative mods doesn't produce a negative maxHP (which would
      // break threshold comparisons and bar rendering).
      const mods = Array.isArray(hlModsMap[trackKey]) ? hlModsMap[trackKey] : [];
      const modTotal = mods.reduce((acc, m) => acc + (parseInt(m.value) || 0), 0);
      let maxHP = baseMaxHP;
      if (maxHP !== null) maxHP = Math.max(0, maxHP + modTotal);

      // Evaluate thresholds. maxHP and currentDamage are injected as vars.
      const thresholds = {};
      const thresholdStatuses = ['disabled', 'destroyed', 'definitelyDestroyed'];
      const thresholdConfig = ruleset.damageThresholds || {};
      thresholdStatuses.forEach(key => {
        const tc = thresholdConfig[key];
        if (!tc || !tc.formula) { thresholds[key] = null; return; }
        const compiledT = parseFormula(tc.formula);
        const extraVars = Object.assign({}, vars, { maxHP: maxHP || 0, currentDamage });
        thresholds[key] = evalFormula(compiledT, extraVars);
      });

      // Compute status. Current remaining = maxHP - currentDamage. Compare
      // to each threshold (which are negative numbers like -maxHP).
      let status = 'healthy';
      if (maxHP !== null) {
        const remaining = maxHP - currentDamage;
        if (thresholds.definitelyDestroyed !== null && remaining <= thresholds.definitelyDestroyed) {
          status = 'definitelyDestroyed';
        } else if (thresholds.destroyed !== null && remaining <= thresholds.destroyed) {
          status = 'destroyed';
        } else if (thresholds.disabled !== null && remaining <= thresholds.disabled) {
          status = 'disabled';
        }
      }

      locations.push({
        def,
        index: i,
        trackKey,
        maxHP,
        baseMaxHP,     // pre-modifier max, useful for UI displaying "base +mod=total"
        currentDamage,
        modifiers: mods,
        thresholds,
        status,
        error: err
      });
    }
    if (err) errors.push({ code: def.code, message: err });
  });

  // ─── BODY POOL & CHARACTER STATUS ───
  //
  // Body is the total damage pool. Its max is the sum of all location maxHPs
  // (which already include per-location modifiers) plus any Body-specific
  // modifiers. Its current is bodyMax minus the sum of all damage everywhere.
  // Every point of location damage is also a point of Body damage — they're
  // the same pool.
  //
  // Damage past Def. Destroyed on a limb (phase 4) still ticks Body down. The
  // Def. Destroyed location's own bar reflects Body's state rather than more
  // location-specific damage.
  //
  // Character statuses derive from two sources:
  //   - Head/Torso hit location status (Disabled/Destroyed/etc.)
  //   - Body pool (0 = Dead)
  //
  // Priority: Dead > (Unconscious + Paralyzed) > Unconscious > Paralyzed > Alive
  let bodyMax = 0;
  let bodyDamage = 0;
  locations.forEach(l => {
    if (typeof l.maxHP === 'number') bodyMax += l.maxHP;
    if (typeof l.currentDamage === 'number') bodyDamage += l.currentDamage;
  });

  // Body-level modifiers live on charData.bodyModifiers = [{ name, value }, ...]
  // These stack onto bodyMax after location-modifier contributions are rolled in.
  const bodyMods = Array.isArray(character.bodyModifiers) ? character.bodyModifiers : [];
  const bodyModTotal = bodyMods.reduce((acc, m) => acc + (parseInt(m.value) || 0), 0);
  bodyMax = Math.max(0, bodyMax + bodyModTotal);

  const bodyCurrent = Math.max(0, bodyMax - bodyDamage);

  // Find head/torso for status. Multiple heads/torsos (unusual): any in a
  // death-triggering state kills the character. Disable status requires at
  // least one to be disabled (not all).
  const headLocs  = locations.filter(l => l.def.code === 'head');
  const torsoLocs = locations.filter(l => l.def.code === 'torso');

  const anyHeadDestroyed  = headLocs.some (l => l.status === 'destroyed' || l.status === 'definitelyDestroyed');
  const anyTorsoDestroyed = torsoLocs.some(l => l.status === 'destroyed' || l.status === 'definitelyDestroyed');
  const anyHeadDisabled   = headLocs.some (l => l.status === 'disabled');
  const anyTorsoDisabled  = torsoLocs.some(l => l.status === 'disabled');

  const isDead = (bodyMax > 0 && bodyCurrent <= 0)
              || anyHeadDestroyed
              || anyTorsoDestroyed;
  const isUnconscious = !isDead && anyHeadDisabled;
  const isParalyzed   = !isDead && anyTorsoDisabled;

  // Build a compact status object the combat UI can read directly.
  let statusLabel;
  if (isDead) statusLabel = 'DEAD';
  else if (isUnconscious && isParalyzed) statusLabel = 'Unconscious & Paralyzed';
  else if (isUnconscious) statusLabel = 'Unconscious';
  else if (isParalyzed) statusLabel = 'Paralyzed';
  else statusLabel = 'Alive';

  const body = {
    max: bodyMax,
    current: bodyCurrent,
    damage: bodyDamage,
    modifiers: bodyMods,
    dead: isDead,
    unconscious: isUnconscious,
    paralyzed: isParalyzed,
    statusLabel
  };

  // ─── POWER RESOURCE ───
  //
  // POWER is a spendable resource whose MAX is derived from the POWER formula
  // (usually POWERPOOL * POW_MULTIPLIER). The character stores `powerCurrent`,
  // the amount currently available to spend on Activated Abilities etc.
  //
  // If the max isn't defined (no POWER derived stat configured) or the ruleset
  // has Power Pool disabled, we report power as null and the combat UI hides
  // the section.
  //
  // Current caps to max but only on the downside — if max drops below current
  // (e.g. character loses POWMOD due to wound), current is clamped. If max
  // rises (buying more Power Pool), current stays where it was — you don't
  // magically get full refilled.
  let power = null;
  const powerStatEntry = stats.get('POWER');
  const ppEnabled = ruleset.powerPool && ruleset.powerPool.enabled !== false;
  if (ppEnabled && powerStatEntry && powerStatEntry.value !== null) {
    const powerMax = Math.floor(powerStatEntry.value);
    const storedCurrent = Number.isFinite(character.powerCurrent)
      ? character.powerCurrent : powerMax;
    const powerCurrent = Math.max(0, Math.min(powerMax, storedCurrent));
    const color = (typeof character.powerColor === 'string' && character.powerColor.trim())
      ? character.powerColor.trim() : '#e0e0e0';
    // Player-chosen name (e.g. "Vitae", "Mana", "Chi"). Blank / missing falls
    // back to the canonical "POWER" label. Trim so trailing whitespace doesn't
    // change whether the default applies.
    const rawName = (typeof character.powerName === 'string') ? character.powerName.trim() : '';
    const name = rawName || 'POWER';
    power = {
      max: powerMax,
      current: powerCurrent,
      color,
      name
    };
  }

  return { stats, locations, errors, vars, body, power };
}
