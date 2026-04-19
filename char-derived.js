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
    // SIZEMOD derives from the SIZE tier index — convention: SIZEMOD =
    // SIZE - 6 (so Medium=0, Large=+1, Small=-1, etc.). This matches PRIME
    // Basic Set defaults.
    table.SIZEMOD = stats.size - 6;
  } else {
    table.SIZE = 6;
    table.SIZEMOD = 0;
  }

  // Power Pool purchased value.
  const pp = (typeof character.powerPool === 'number') ? character.powerPool : 0;
  table.POWERPOOL = pp;

  // POW_MULTIPLIER from ruleset table, looked up by POW value.
  const powVal = table.POW ?? 2;
  const multTable = (ruleset.powerPool && Array.isArray(ruleset.powerPool.powMultiplier))
    ? ruleset.powerPool.powMultiplier : [];
  const entry = multTable.find(e => powVal >= e.powMin && powVal <= e.powMax);
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

  locDefs.forEach(def => {
    const compiledHp = parseFormula(def.hpFormula);
    let maxHP = evalFormula(compiledHp, vars);
    let err = null;
    if (compiledHp.error) { err = compiledHp.message; maxHP = null; }
    else if (maxHP !== null) maxHP = Math.floor(maxHP);

    for (let i = 1; i <= (def.count || 1); i++) {
      // Build the tracking key. Single-count locations use just the code
      // (e.g. "head"), multi-count use code-N (e.g. "arm-1").
      const trackKey = (def.count && def.count > 1) ? `${def.code}-${i}` : def.code;
      const currentDamage = (typeof damageMap[trackKey] === 'number') ? damageMap[trackKey] : 0;

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
        currentDamage,
        thresholds,
        status,
        error: err
      });
    }
    if (err) errors.push({ code: def.code, message: err });
  });

  return { stats, locations, errors, vars };
}
