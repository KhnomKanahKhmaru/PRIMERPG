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
  // from POW). The table is a flat list with one entry per POWMOD value.
  // If the character's POWMOD falls outside the table's declared range, we
  // clamp to the nearest endpoint — i.e. a POWMOD of 15 uses the highest
  // defined entry's value (probably 10 in the default table). This keeps the
  // system working even for extreme edge cases without requiring the GM to
  // declare infinite rows.
  const powmod = table.POWMOD ?? 0;
  const multTable = (ruleset.powerPool && Array.isArray(ruleset.powerPool.powMultiplier))
    ? ruleset.powerPool.powMultiplier : [];
  let multiplier = 1;
  if (multTable.length > 0) {
    // Prefer an exact match.
    const exact = multTable.find(e => e.powmod === powmod);
    if (exact) {
      multiplier = exact.value;
    } else {
      // Clamp to nearest endpoint. Sort by powmod and pick min or max.
      const sorted = multTable.slice().sort((a, b) => a.powmod - b.powmod);
      if (powmod < sorted[0].powmod) multiplier = sorted[0].value;
      else if (powmod > sorted[sorted.length - 1].powmod) multiplier = sorted[sorted.length - 1].value;
      // Otherwise the table has a gap; fall back to the default of 1.
    }
  }
  table.POW_MULTIPLIER = multiplier;

  // FORT (Fortitude) — same curve-with-clamp pattern as POW_MULTIPLIER but
  // keyed off STRMOD. Used in per-location damage stacking:
  //   effective damage = highest instance + (sum of others) / FORT
  // Falls back to 1 if no table is present, which gives linear stacking
  // (no fortitude benefit) — safe default for old rulesets.
  const strmod = table.STRMOD ?? 0;
  const fortTable = Array.isArray(ruleset.fortitudeTable) ? ruleset.fortitudeTable : [];
  let fortValue = 1;
  if (fortTable.length > 0) {
    const exact = fortTable.find(e => e.strmod === strmod);
    if (exact) {
      fortValue = exact.value;
    } else {
      const sorted = fortTable.slice().sort((a, b) => a.strmod - b.strmod);
      if (strmod < sorted[0].strmod) fortValue = sorted[0].value;
      else if (strmod > sorted[sorted.length - 1].strmod) fortValue = sorted[sorted.length - 1].value;
    }
  }
  table.FORT = fortValue;

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

// ── CARRIED WEIGHT ──
//
// Total weight (lbs) of everything the character is carrying for
// encumbrance purposes. Walks the inventory group tree; each group
// individually flags whether it "counts for encumbrance" — On-Person
// defaults to true (undefined === true), other groups default to false.
// Player-created subgroups inherit their parent's status unless they
// have their own explicit flag.
//
// Within a counting group, ALL nested contents (entries, containers,
// sub-subgroups) contribute. A subgroup with countsForEncumbrance
// explicitly set to false opts itself out regardless of parent — lets
// the player stash stuff in an On-Person subgroup (e.g. "Cached" inside
// a hidden pocket) that doesn't weigh on them right now.
//
// Weight source per entry: the snapshot (post-Turn-A source of truth).
// Same precedence as the inventory tab's display — the number shown
// there is the number that counts here.
function computeCarriedWeight(character) {
  const inv = character && character.inventory;
  if (!inv || !Array.isArray(inv.groups)) return 0;

  // A node is a group if it has a kind of 'custom' or 'onPerson'.
  // Entries have defKind instead. This matches char-inventory.js's
  // isGroupNode — duplicated here to avoid module cycles.
  const isGroup = (n) => !!(n && (n.kind === 'custom' || n.kind === 'onPerson'));

  // Per group: does it count? On-Person counts unless explicitly set false.
  // Custom groups only count when explicitly true. Subgroup flag overrides
  // parent — undefined means "inherit parent".
  const groupCounts = (g, parentCounts) => {
    if (typeof g.countsForEncumbrance === 'boolean') return g.countsForEncumbrance;
    if (parentCounts != null) return parentCounts;
    if (g.kind === 'onPerson') return true;
    return false;
  };

  // Walk: if this group counts, sum every entry in it. Recurse into
  // subgroups with their own counts decision. If it doesn't count, we
  // still recurse — a subgroup might re-enable counting even inside an
  // opted-out parent (flexibility: "I don't usually count Vehicle, but
  // the Driver's-Seat subgroup is effectively on my person right now").
  let total = 0;
  const walk = (nodes, inheritedCounts) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;
      if (isGroup(node)) {
        const counts = groupCounts(node, inheritedCounts);
        walk(node.contents, counts);
      } else {
        if (inheritedCounts) {
          // Snapshot weight × quantity, plus anything nested (for containers).
          const qty = node.quantity || 1;
          const snapW = (node.snapshot && Number.isFinite(node.snapshot.weight))
            ? node.snapshot.weight : 0;
          total += snapW * qty;
          if (Array.isArray(node.contents)) {
            // Nested entries (inside a container) contribute at the
            // container's inherited counting status. They're not groups,
            // so they don't get their own flag.
            walk(node.contents, inheritedCounts);
          }
        }
      }
    });
  };
  // Top-level groups: each gets its own "does it count" read, starting
  // from no inheritance.
  inv.groups.forEach(g => {
    if (!isGroup(g)) return;
    const counts = groupCounts(g, null);
    walk(g.contents, counts);
  });
  return total;
}

export function computeDerivedStats(character, ruleset) {
  const errors = [];

  // 1. Build initial symbol table from base stats.
  const vars = buildSymbolTable(character, ruleset);

  // 1a. CARRIED — total weight (lbs) of everything in groups the player
  // has tagged as counting for encumbrance. On-Person counts by default;
  // other groups only count when group.countsForEncumbrance === true.
  // This is injected as a symbol BEFORE derivation so the ENC formula
  // can reference it like any other stat (CARRIED - CAP / CAP * 10 …).
  vars.CARRIED = computeCarriedWeight(character);

  // 2. Evaluate derived stats in dependency order.
  const defs = Array.isArray(ruleset.derivedStats) ? ruleset.derivedStats : [];
  const { ordered, compiled, errors: sortErrors } = topoSort(defs, Object.keys(vars));
  sortErrors.forEach(e => errors.push(e));

  const stats = new Map();
  ordered.forEach(def => {
    const c = compiled.get(def.code);
    if (c.error) {
      stats.set(def.code, {
        def, value: null, error: c.message,
        rollModifier: null, diceMods: [], diceModTotal: 0
      });
      errors.push({ code: def.code, message: c.message });
      return;
    }
    let value = evalFormula(c, vars);
    if (value !== null && !def.keepDecimals) value = Math.floor(value);
    // Add to symbol table so downstream stats can reference this one.
    if (value !== null) vars[def.code] = value;

    // Evaluate rollModifier expression if present. This is the STATIC mod
    // that gets added to the ROLL TOTAL (sum of dice) — e.g. STRMOD for
    // Health, max(INTMOD, CHAMOD) for Sanity. Read-only, shown in the card's
    // top-right corner as a signed badge.
    let rollModifier = null;
    if (def.rollModifier && typeof def.rollModifier === 'string' && def.rollModifier.trim()) {
      const rmCompiled = parseFormula(def.rollModifier);
      if (!rmCompiled.error) {
        const rmValue = evalFormula(rmCompiled, vars);
        if (rmValue !== null && Number.isFinite(rmValue)) {
          rollModifier = Math.round(rmValue);
        }
      }
    }

    // Dice modifiers — player/GM-editable bonus DICE added to the roll POOL
    // (not the total). E.g. "Brawny Trait: +2d" means you roll 2 extra D10s
    // when making a Health check. Stored per stat code on charData.diceModifiers.
    // Example: { HP: [{ name: 'Brawny Trait', value: 2 }], SAN: [...] }.
    const diceMap = (character && character.diceModifiers && typeof character.diceModifiers === 'object')
      ? character.diceModifiers : {};
    const diceMods = Array.isArray(diceMap[def.code]) ? diceMap[def.code] : [];
    const diceModTotal = diceMods.reduce((acc, m) => acc + (parseInt(m && m.value) || 0), 0);

    stats.set(def.code, {
      def, value,
      rollModifier,     // static mod (STRMOD, etc.) — read-only, added to roll total
      diceMods,         // list of {name, value} — editable bonus dice
      diceModTotal      // sum of dice modifier values
    });
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

  // Pre-compute damage instances per location. Each injury contributes one
  // instance (= its currentLevel, after levelModifiers); we group these by
  // trackKey so the per-location loop can grab them cheaply.
  //
  // This replaces the old "sum injury levels" approach. Damage now stacks
  // through FORT (highest instance + others/FORT), so we need the individual
  // values, not just the total.
  const injuriesIn = Array.isArray(character.injuries) ? character.injuries : [];
  const injuryInstancesByLocation = new Map();
  injuriesIn.forEach(inj => {
    const base = Number.isFinite(inj.baseLevel) ? inj.baseLevel : 0;
    const mods = Array.isArray(inj.levelModifiers) ? inj.levelModifiers : [];
    const modTotal = mods.reduce((a, m) => a + (parseInt(m.value) || 0), 0);
    const current = Math.max(0, base + modTotal);
    if (current <= 0) return;  // zero-level injuries don't contribute damage
    const loc = typeof inj.location === 'string' ? inj.location : 'torso';
    if (!injuryInstancesByLocation.has(loc)) injuryInstancesByLocation.set(loc, []);
    injuryInstancesByLocation.get(loc).push(current);
  });

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
      // Manual damage — tracked via +/- controls, stored in hitLocationDamage.
      const manualDamage = (typeof damageMap[trackKey] === 'number') ? damageMap[trackKey] : 0;
      // Injury damage instances — one per injury at this location.
      const injuryInstances = injuryInstancesByLocation.get(trackKey) || [];

      // Build the full instance list: injuries + (manual lumped as 1 instance
      // if > 0). Sort descending so instances[0] is the biggest single hit.
      const instances = injuryInstances.slice();
      if (manualDamage > 0) instances.push(manualDamage);
      instances.sort((a, b) => b - a);

      // FORT-reduced effective damage:
      //   biggest hit lands in full; every secondary hit divides by FORT.
      // No instances → no damage. One instance → it stands alone (FORT does
      // not matter with a single wound, which is the simple-case default).
      const fortValue = Math.max(0.01, vars.FORT || 1);
      let currentDamage;
      if (instances.length === 0) {
        currentDamage = 0;
      } else {
        const highest = instances[0];
        const othersSum = instances.slice(1).reduce((s, v) => s + v, 0);
        // Floor so damage stays integer — matches the rest of the HP system
        // and simplifies bar rendering / status threshold comparisons.
        currentDamage = Math.floor(highest + (othersSum / fortValue));
      }
      // Raw (pre-FORT) total — useful for UI breakdowns and for backwards
      // compatibility with any code that wants the un-reduced sum.
      const injuryDamage = injuryInstances.reduce((s, v) => s + v, 0);
      const rawDamage = manualDamage + injuryDamage;

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
        baseMaxHP,        // pre-modifier max, useful for UI displaying "base +mod=total"
        currentDamage,    // FORT-reduced effective damage (used by bar + Body total)
        rawDamage,        // pre-FORT linear sum (manualDamage + all injury levels)
        instances,        // array of individual damage instances (sorted desc)
        manualDamage,     // just the +/- ticked damage
        injuryDamage,     // linear sum of injury currentLevels at this location
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

  // bodyCurrent is the signed remaining Body, mirroring the full-range bar
  // shown in the UI: goes from +bodyMax (Healthy) through 0 (Incapacitated)
  // down to -bodyMax (Dead) and beyond (Destroyed). We don't clamp at 0 so
  // the number shown can distinguish "just passed out" from "your corpse is
  // being desecrated" without needing a separate flag to tell them apart.
  const bodyCurrent = bodyMax - bodyDamage;

  // Find head/torso for status. Multiple heads/torsos (unusual): any in a
  // death-triggering state kills the character. Disable status requires at
  // least one to be disabled (not all).
  const headLocs  = locations.filter(l => l.def.code === 'head');
  const torsoLocs = locations.filter(l => l.def.code === 'torso');

  const anyHeadDestroyed  = headLocs.some (l => l.status === 'destroyed' || l.status === 'definitelyDestroyed');
  const anyTorsoDestroyed = torsoLocs.some(l => l.status === 'destroyed' || l.status === 'definitelyDestroyed');
  const anyHeadDisabled   = headLocs.some (l => l.status === 'disabled');
  const anyTorsoDisabled  = torsoLocs.some(l => l.status === 'disabled');

  // Whether EVERY hit location is Definitively Destroyed. This gates the
  // Destroyed tag — Body damage alone going past 2·max isn't enough to
  // trigger Destroyed, because degradation on a single limb (e.g. bleeding,
  // exsanguination) can drive Body damage past that threshold while the
  // rest of the body is still intact. "Destroyed" semantically means
  // "nothing left of you", which requires nothing left — every limb gone.
  const allLocsDefDestroyed = locations.length > 0
    && locations.every(l => l.status === 'definitelyDestroyed');

  // Status priority (highest wins):
  //   1. Destroyed    — Body past 2·max AND every limb Def.Destroyed.
  //                     "Nothing left of you." Needs both conditions so a
  //                     single limb's degradation driving Body down doesn't
  //                     falsely imply total annihilation.
  //   2. Dead         — Body at -max, OR any head/torso destroyed. Death
  //                     from any source trumps everything except Destroyed.
  //   3. Incapacitated — Body at 0 HP, OR both head AND torso disabled.
  //                      Covers "Unconscious AND Paralyzed" as a single
  //                      tag — trumps either individual state since it IS
  //                      literally both.
  //   4. Unconscious   — head disabled, and not Incapacitated/Dead/Destroyed.
  //   5. Paralyzed     — torso disabled, and not Incapacitated/Dead/Destroyed.
  //   6. Alive         — everything else.
  const isDestroyed     = bodyMax > 0
                       && bodyDamage > 2 * bodyMax
                       && allLocsDefDestroyed;
  const isDead          = isDestroyed
                       || (bodyMax > 0 && bodyDamage >= 2 * bodyMax)
                       || anyHeadDestroyed
                       || anyTorsoDestroyed;
  const isIncapacitated = !isDead
                       && ((bodyMax > 0 && bodyDamage >= bodyMax)
                           || (anyHeadDisabled && anyTorsoDisabled));
  // Individual disability states only show if nothing stronger applies.
  // These keep being exposed (not folded into Incapacitated) so callers
  // that need to know specifically "which limb is down" can still check.
  const isUnconscious   = !isDead && !isIncapacitated && anyHeadDisabled;
  const isParalyzed     = !isDead && !isIncapacitated && anyTorsoDisabled;

  let statusLabel;
  if      (isDestroyed)     statusLabel = 'DESTROYED';
  else if (isDead)          statusLabel = 'DEAD';
  else if (isIncapacitated) statusLabel = 'Incapacitated';
  else if (isUnconscious)   statusLabel = 'Unconscious';
  else if (isParalyzed)     statusLabel = 'Paralyzed';
  else                      statusLabel = 'Alive';

  const body = {
    max: bodyMax,
    current: bodyCurrent,
    damage: bodyDamage,
    modifiers: bodyMods,
    // Flags — expose each tier as its own boolean so UI code can branch
    // cleanly. `dead` stays true for Destroyed too (destroyed IS dead, just
    // more so), so existing `body.dead` consumers keep working.
    destroyed:     isDestroyed,
    dead:          isDead,
    incapacitated: isIncapacitated,
    unconscious:   isUnconscious,
    paralyzed:     isParalyzed,
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

  // ─── SAN (SANITY) ───
  //
  // Linear mental health pool. Damage stacks directly — no FORT reduction.
  //
  // Two damage sources both contribute to total:
  //   - sanDamage (number): untracked manual damage from +/- controls
  //   - sanDamages (array of {id, name, baseLevel, levelModifiers, description}):
  //     structured "damages" the player/GM records, each with its own level and
  //     optional modifiers. Parallels Injuries but without location/traumas/
  //     degradation — mental wounds are pool-wide, not located.
  //
  // Effective SAN damage = sanDamage + sum(damage.currentLevel for each entry)
  //
  // Max comes from the SAN derived stat (CHA + INT by default). sanModifiers
  // (array of {name, value}) adjust max same pattern as Body.
  //
  // Status bands (in terms of current = max - damage):
  //   current > 0              → Healthy
  //   0  ≥ current > -SAN      → In Shock       (+1 Diff all rolls)
  //   -SAN ≥ current > -2*SAN  → Insane         (+2 Diff SAN, +1 Diff others)
  //   current ≤ -2*SAN         → Broken         (+3 Diff SAN, +1 Diff others,
  //                                               Breaking Point roll required)
  let san = null;
  const sanStatEntry = stats.get('SAN');
  if (sanStatEntry && sanStatEntry.value !== null) {
    const baseMax = Math.floor(sanStatEntry.value);
    const sanMods = Array.isArray(character.sanModifiers) ? character.sanModifiers : [];
    const sanModTotal = sanMods.reduce((acc, m) => acc + (parseInt(m.value) || 0), 0);
    const sanMax = Math.max(0, baseMax + sanModTotal);

    // Manual damage — untracked lump from +/- controls.
    const manualDamage = Math.max(0, Number.isFinite(character.sanDamage) ? character.sanDamage : 0);

    // Structured damages — compute currentLevel for each, carry them on the
    // result so the UI can render cards without re-doing the math.
    const damagesIn = Array.isArray(character.sanDamages) ? character.sanDamages : [];
    const damages = damagesIn
      .filter(d => d && typeof d === 'object')
      .map(d => {
        const base = Number.isFinite(d.baseLevel) ? d.baseLevel : 0;
        const mods = Array.isArray(d.levelModifiers) ? d.levelModifiers : [];
        const modTotal = mods.reduce((a, m) => a + (parseInt(m.value) || 0), 0);
        const currentLevel = Math.max(0, base + modTotal);
        return {
          id: d.id || ('sandmg_' + Math.random().toString(36).slice(2, 9)),
          name: typeof d.name === 'string' ? d.name : '',
          description: typeof d.description === 'string' ? d.description : '',
          baseLevel: base,
          currentLevel,
          levelModifiers: mods
        };
      });
    const damagesContribution = damages.reduce((s, d) => s + d.currentLevel, 0);

    const sanDamage = manualDamage + damagesContribution;
    const sanCurrent = sanMax - sanDamage;  // can be negative; that's the point

    let sanStatus = 'healthy';
    if (sanMax > 0) {
      if (sanCurrent <= -2 * sanMax) sanStatus = 'broken';
      else if (sanCurrent <= -sanMax) sanStatus = 'insane';
      else if (sanCurrent <= 0) sanStatus = 'inShock';
    }

    // Status label + penalty text for the UI. Penalties are narrative cues
    // for the GM — they're printed but not auto-applied to any dice rolls.
    let sanStatusLabel, sanPenaltyText;
    switch (sanStatus) {
      case 'broken':
        sanStatusLabel = 'Broken';
        sanPenaltyText = '+3 Difficulty to SAN rolls, +1 Difficulty to other rolls. Roll on Breaking Point table. Any further Mental Damage forces a reroll.';
        break;
      case 'insane':
        sanStatusLabel = 'Insane';
        sanPenaltyText = '+2 Difficulty to SAN rolls, +1 Difficulty to other rolls.';
        break;
      case 'inShock':
        sanStatusLabel = 'In Shock';
        sanPenaltyText = '+1 Difficulty to all rolls.';
        break;
      default:
        sanStatusLabel = 'Healthy';
        sanPenaltyText = '';
    }

    san = {
      baseMax,
      max: sanMax,
      current: sanCurrent,
      damage: sanDamage,
      manualDamage,
      damagesContribution,
      damages,                 // structured damages with computed currentLevel
      modifiers: sanMods,
      status: sanStatus,
      statusLabel: sanStatusLabel,
      penaltyText: sanPenaltyText
    };
  }

  // ─── INJURIES ───
  //
  // Injuries are free-floating wounds with their own base severity, location,
  // and degradation rate. The degradation RATE is driven by the injury's
  // baseLevel (the level it was recorded at) relative to half the character's
  // HP — heal/worsen modifiers affect current severity but NOT the rate.
  //
  // Two distinct modifier lists per injury:
  //   - levelModifiers:       adjust the current severity (what the player/GM
  //                           cares about mechanically right now)
  //   - degradationModifiers: shift the baseLevel as used for the RATE lookup
  //                           (bandages slowing degradation, traumas speeding
  //                           it up, etc.)
  //
  // Traumas are narrative tags with a System text field; GMs apply the
  // described mechanical effect manually via degradation modifiers.
  //
  // HP for the "half your HP" comparison is the derived HP stat (e.g. STR+SIZE).
  // Falls back to 0 if the ruleset has no HP derived stat.
  // (injuriesIn was already declared earlier — it's the same array we use for
  // pre-computing per-location damage before the hit-location loop.)
  const hpEntry = stats.get('HP');
  const hpTotal = (hpEntry && typeof hpEntry.value === 'number') ? hpEntry.value : 0;
  const halfHp = Math.floor(hpTotal / 2);

  const injuries = injuriesIn.map(inj => {
    const baseLevel = Number.isFinite(inj.baseLevel) ? inj.baseLevel : 0;

    const levelMods = Array.isArray(inj.levelModifiers) ? inj.levelModifiers : [];
    const levelModTotal = levelMods.reduce((a, m) => a + (parseInt(m.value) || 0), 0);
    const currentLevel = Math.max(0, baseLevel + levelModTotal);

    const degMods = Array.isArray(inj.degradationModifiers) ? inj.degradationModifiers : [];
    const degModTotal = degMods.reduce((a, m) => a + (parseInt(m.value) || 0), 0);

    // Effective base for rate lookup. Can't go below 0.
    const effectiveBase = Math.max(0, baseLevel + degModTotal);

    // Degradation only kicks in once the injury is >= halfHP.
    const diff = effectiveBase - halfHp;
    const rate = (hpTotal > 0 && diff >= 0) ? lookupDegradationRate(diff) : null;

    const traumas = Array.isArray(inj.traumas) ? inj.traumas : [];

    return {
      id: inj.id || ('inj_missing_' + Math.random().toString(36).slice(2, 8)),
      name: typeof inj.name === 'string' ? inj.name : '',
      description: typeof inj.description === 'string' ? inj.description : '',
      baseLevel,
      currentLevel,
      levelModifiers: levelMods,
      degradationModifiers: degMods,
      effectiveBase,
      location: typeof inj.location === 'string' ? inj.location : 'torso',
      halfHp,
      hpTotal,
      diff,          // effective base minus half-HP (negative = no degradation)
      rate,          // { seconds, label, tier } or null
      traumas
    };
  });

  // ─── PAIN / STRESS / OTHER / PENALTY ───
  //
  // Pain: percent of Body you're missing (bodyDamage / bodyMax × 100).
  // Stress: percent of SAN range you've lost (sanDamage / (sanMax × 3) × 100).
  //   SAN denominator is 3× because SAN ranges from +max down to -2*max, so
  //   the total damageable range is 3× the displayed max.
  // Other: player-entered modifiers for everything that isn't damage —
  //   Exposure, Encumbrance, drugged, bound, etc. Sum of otherModifiers
  //   values (each ±integer%). No implicit base percent.
  // Penalty: total drag on capabilities. Sum of Pain + Stress + Other,
  //   clamped to [0, 100].
  //
  // Pain and Stress also support internal MODIFIERS (charData.painModifiers /
  // stressModifiers arrays of {name, value}) that stack additively onto
  // the base percentage of that component. Final per-component values
  // clamp to [0, 100] before rolling up into Penalty.
  //
  // Penalty reduces the dice count on any stat whose def.passiveRoll isn't
  // true — applied in the stats loop's post-pass below. Also reduces
  // displayed values for stats with def.penaltyReducesValue (e.g. SPD).
  let pain = null;
  if (body && body.max > 0) {
    const rawPct = (body.damage / body.max) * 100;
    const basePct = Math.max(0, Math.min(100, Math.round(rawPct)));
    const mods = Array.isArray(character.painModifiers) ? character.painModifiers : [];
    const modTotal = mods.reduce((a, m) => a + (parseInt(m && m.value) || 0), 0);
    const finalPct = Math.max(0, Math.min(100, Math.round(basePct + modTotal)));
    pain = { basePercent: basePct, modifiers: mods, modTotal, finalPercent: finalPct };
  }

  let stress = null;
  if (san && san.max > 0) {
    const denom = san.max * 3;
    const rawPct = (san.damage / denom) * 100;
    const basePct = Math.max(0, Math.min(100, Math.round(rawPct)));
    const mods = Array.isArray(character.stressModifiers) ? character.stressModifiers : [];
    const modTotal = mods.reduce((a, m) => a + (parseInt(m && m.value) || 0), 0);
    const finalPct = Math.max(0, Math.min(100, Math.round(basePct + modTotal)));
    stress = { basePercent: basePct, modifiers: mods, modTotal, finalPercent: finalPct };
  }

  // "Other" Penalty — user-managed list of named +/- percentile entries
  // for Exposure and anything else that should drag on capabilities
  // without being Stress, Pain, or Encumbrance. Values can be negative
  // to model buffs that offset existing penalty (an adrenaline shot
  // briefly cancels exhaustion, say).
  //
  // Unlike Pain and Stress, Other has no "base percent" — every bit of
  // it comes from named modifiers. If the modifiers list is empty, the
  // component contributes nothing. The total is NOT clamped to [0, 100]
  // here (the roll-up into Penalty clamps the full sum instead) so that
  // negative Others can fully offset Pain/Stress/Encumbrance.
  const otherMods = Array.isArray(character.otherModifiers) ? character.otherModifiers : [];
  const otherTotal = otherMods.reduce((a, m) => a + (parseInt(m && m.value) || 0), 0);
  const other = { modifiers: otherMods, modTotal: otherTotal, finalPercent: otherTotal };

  // CAP / LIFT / ENC modifiers — character-managed named ± entries.
  // CAP and LIFT mods are ADDITIVE PERCENT adjustments applied to the
  // formula result: a "+50%" mod on CAP becomes base × 1.50; a "-25%"
  // mod becomes × 0.75. Multiple mods stack additively by percent
  // (+50% and +25% = ×1.75, not compounding) — matches how Pain and
  // Stress modifiers work elsewhere in the system.
  //
  // ENC mods are ADDITIVE PERCENT to the Encumbrance % itself, clamped
  // to [0, 100]. Negative values offset; positive values add. Useful
  // for circumstance modifiers ("Exhaustion: +10% ENC").
  //
  // Modifiers DO NOT change the stat entry.value — they only re-shape
  // the final reported value on the card + penalty rollup. The raw
  // formula value is still in stats.get('CAP').value; the UI reads the
  // augmented value from the `carry` object below.
  const applyPctMods = (base, mods) => {
    if (!Array.isArray(mods) || mods.length === 0) return base;
    const totalPct = mods.reduce((a, m) => a + (parseFloat(m && m.value) || 0), 0);
    return base * (1 + totalPct / 100);
  };
  const capMods  = Array.isArray(character.capModifiers)  ? character.capModifiers  : [];
  const liftMods = Array.isArray(character.liftModifiers) ? character.liftModifiers : [];
  const encMods  = Array.isArray(character.encModifiers)  ? character.encModifiers  : [];

  const capEntry  = stats.get('CAP');
  const liftEntry = stats.get('LIFT');
  const encEntry  = stats.get('ENC');

  const rawCap  = (capEntry  && Number.isFinite(capEntry.value))  ? capEntry.value  : 0;
  const rawLift = (liftEntry && Number.isFinite(liftEntry.value)) ? liftEntry.value : 0;

  const finalCap  = Math.max(0, Math.round(applyPctMods(rawCap,  capMods)));
  const finalLift = Math.max(0, Math.round(applyPctMods(rawLift, liftMods)));

  // Recompute ENC using the adjusted CAP so CAP modifiers propagate
  // naturally. Without this, a +50% CAP mod would still be measured
  // against the raw CAP in the ENC formula — which is wrong (the
  // whole point of the mod is "I can carry more before getting tired").
  const carried = vars.CARRIED || 0;
  let rawEncPct = 0;
  if (finalCap > 0) {
    rawEncPct = Math.max(0, Math.min(100, (carried - finalCap) / finalCap * 10));
  } else {
    // Zero CAP edge case — if we can carry zero, any weight is LIFT. Not
    // realistic but shouldn't crash: treat as max ENC if carrying anything.
    rawEncPct = carried > 0 ? 100 : 0;
  }
  const encModTotal = encMods.reduce((a, m) => a + (parseFloat(m && m.value) || 0), 0);
  const finalEncPct = Math.max(0, Math.min(100, Math.round((rawEncPct + encModTotal) * 10) / 10));

  // Expose `carry` as the canonical carry-stats bundle. Cards + Penalty
  // roll-up read from this object. The raw stats.get('CAP') / LIFT / ENC
  // still exist with their formula-only values for any caller that wants
  // to see them pre-modifier (e.g. a "show base vs modified" tooltip).
  const carry = {
    carried,
    cap:         finalCap,
    rawCap,
    capModifiers:  capMods,
    capModTotal:   capMods.reduce((a, m) => a + (parseFloat(m && m.value) || 0), 0),
    lift:        finalLift,
    rawLift,
    liftModifiers: liftMods,
    liftModTotal:  liftMods.reduce((a, m) => a + (parseFloat(m && m.value) || 0), 0),
    encPercent:  finalEncPct,
    rawEncPercent: rawEncPct,
    encModifiers:  encMods,
    encModTotal
  };

  // Encumbrance block fed into penalty — uses the post-modifier values.
  const encumbrance = {
    finalPercent: finalEncPct,
    carried,
    cap:          finalCap,
    lift:         finalLift
  };

  const painPct = pain ? pain.finalPercent : 0;
  const stressPct = stress ? stress.finalPercent : 0;
  const otherPct = other.finalPercent;
  const encPct = encumbrance.finalPercent;
  const penaltyPct = Math.max(0, Math.min(100, painPct + stressPct + encPct + otherPct));
  const penalty = {
    painPercent:        painPct,
    stressPercent:      stressPct,
    encumbrancePercent: encPct,
    otherPercent:       otherPct,
    percent:            penaltyPct
  };

  // Post-pass: for each stat entry, compute Penalty-adjusted dice count.
  // Passive rolls are exempt (HP/SAN resistance rolls don't suffer Penalty).
  stats.forEach(entry => {
    const def = entry.def;
    const baseDice = (entry.value != null && Number.isFinite(entry.value))
      ? Math.floor(entry.value) : 0;
    const diceModTotal = entry.diceModTotal || 0;
    const poolBeforePenalty = Math.max(0, baseDice + diceModTotal);

    const isPassive = def.passiveRoll === true;
    const penaltyDice = isPassive
      ? 0
      : Math.floor(poolBeforePenalty * penaltyPct / 100);
    const finalDice = Math.max(0, poolBeforePenalty - penaltyDice);

    // Value reduction — for stats like SPD/SPDUP where Penalty cuts the
    // displayed value rather than the dice pool.
    let penaltyValueReduction = 0;
    if (def.penaltyReducesValue === true && !isPassive
        && entry.value != null && Number.isFinite(entry.value)) {
      penaltyValueReduction = entry.value * penaltyPct / 100;
    }

    entry.isPassive = isPassive;
    entry.finalDice = finalDice;
    entry.penaltyDice = penaltyDice;
    entry.penaltyPercent = penaltyPct;
    entry.penaltyValueReduction = penaltyValueReduction;
    entry.poolBeforePenalty = poolBeforePenalty;
  });

  return { stats, locations, errors, vars, body, power, san, injuries, pain, stress, other, encumbrance, carry, penalty };
}

// ─── DEGRADATION TABLE ───
//
// Maps "difference above half-HP" to a rate. Each row is an exact integer
// difference. For differences beyond the table, clamp to the highest row
// (Every Second); for differences below 0 no degradation occurs.
//
// Labels are kept in "Every X" phrasing so the UI can prepend "Degrades" and
// read naturally: "Degrades Every 6 Hours", "Degrades Every Second".
//
// Tier names follow PRIME's severity scale (Minor → Mythical); they're
// included so the UI can color/label injuries by severity band.
const DEGRADATION_RATES = [
  { diff: 0,  seconds: 86400, label: 'Every 24 Hours',   tier: 'Minor'      },
  { diff: 1,  seconds: 57600, label: 'Every 16 Hours',   tier: 'Minor'      },
  { diff: 2,  seconds: 28800, label: 'Every 8 Hours',    tier: 'Minor'      },
  { diff: 3,  seconds: 21600, label: 'Every 6 Hours',    tier: 'Moderate'   },
  { diff: 4,  seconds: 14400, label: 'Every 4 Hours',    tier: 'Moderate'   },
  { diff: 5,  seconds: 7200,  label: 'Every 2 Hours',    tier: 'Moderate'   },
  { diff: 6,  seconds: 3600,  label: 'Every Hour',       tier: 'Major'      },
  { diff: 7,  seconds: 2400,  label: 'Every 40 Minutes', tier: 'Major'      },
  { diff: 8,  seconds: 1200,  label: 'Every 20 Minutes', tier: 'Major'      },
  { diff: 9,  seconds: 600,   label: 'Every 10 Minutes', tier: 'Massive'    },
  { diff: 10, seconds: 360,   label: 'Every 6 Minutes',  tier: 'Massive'    },
  { diff: 11, seconds: 120,   label: 'Every 2 Minutes',  tier: 'Massive'    },
  { diff: 12, seconds: 60,    label: 'Every Minute',     tier: 'Monumental' },
  { diff: 13, seconds: 45,    label: 'Every 45 Seconds', tier: 'Monumental' },
  { diff: 14, seconds: 30,    label: 'Every 30 Seconds', tier: 'Monumental' },
  { diff: 15, seconds: 18,    label: 'Every 18 Seconds', tier: 'Mega'       },
  { diff: 16, seconds: 12,    label: 'Every 12 Seconds', tier: 'Mega'       },
  { diff: 17, seconds: 6,     label: 'Every 6 Seconds',  tier: 'Mega'       },
  { diff: 18, seconds: 4,     label: 'Every 4 Seconds',  tier: 'Mythical'   },
  { diff: 19, seconds: 2,     label: 'Every 2 Seconds',  tier: 'Mythical'   },
  { diff: 20, seconds: 1,     label: 'Every Second',     tier: 'Mythical'   }
];

export function lookupDegradationRate(diff) {
  if (diff < 0) return null;
  if (diff >= DEGRADATION_RATES.length) return DEGRADATION_RATES[DEGRADATION_RATES.length - 1];
  return DEGRADATION_RATES[diff];
}

// Tiers in order, so UI code can map a level number to a severity tier for
// trauma level dropdowns and color coding.
export const TRAUMA_TIERS = ['Minor', 'Moderate', 'Major', 'Massive', 'Monumental', 'Mega', 'Mythical'];
