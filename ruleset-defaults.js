// ruleset-defaults.js
// Default values for the Basic Set, and the schema any ruleset should conform to.
// Included as a non-module script so edit-ruleset.html can use it directly.

window.RULESET_DEFAULTS = {
  tagline: '',
  startingXp: 100,

  // Stat caps / costs.
  statXp: [null, -10, 0, 10, 30, 60, 100],  // index 0 = not takable
  statMaxPurchasable: 6,                     // max level a player can START at
  statMax: 20,                               // absolute ceiling a stat can reach

  // Regular stats (SIZE is handled separately below).
  stats: [
    { code:'STR', name:'Strength',   description:'Physical power, raw force.' },
    { code:'DEX', name:'Dexterity',  description:'Fine motor control, reflexes, agility.' },
    { code:'PER', name:'Perception', description:'Awareness of surroundings, sensory acuity.' },
    { code:'INT', name:'Intellect',  description:'Reasoning, memory, learning capacity.' },
    { code:'CHA', name:'Charisma',   description:'Social presence, force of personality.' },
    { code:'POW', name:'Power',      description:'Willpower, mental fortitude, resolve.' }
  ],

  // STATMOD per level (index = level, 0..statMax).
  statMods: [-1,-1,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,9,10],

  // Stat flavor labels (index = level, 0..statMax).
  statLabels: [
    'Far Below Average','Below Average','Average','Above Average','Gifted','Exceptional','Peak Human',
    'Superhuman','Extraordinary','Legendary','Heroic','Titanic','Mythic','Godly','Divine',
    'Transcendent','Ascendant','Empyrean','Omnipotent','Absolute','Cosmic'
  ],

  // SIZE: its own scale, XP costs, and tier labels. Has no STATMOD.
  // size.tiers is an array of { level, label, xpCost } objects.
  // Tier levels are NOT dense — they jump (e.g. Small=3, Medium=4, Large=6,
  // skipping 5). The `level` field is the actual SIZE value; the array
  // index is NOT the SIZE value. Character data stores the SIZE level, not
  // the index. The `default` field below is the SIZE level for new
  // characters (Medium = 4).
  size: {
    default: 4,  // Medium — default starting size for new characters
    tiers: [
      { level: 0,  label: 'Nano',        xpCost: 0 },  // Ants, fleas, grains of rice
      { level: 1,  label: 'Micro',       xpCost: 0 },  // Scorpions, rat pups, small bats
      { level: 2,  label: 'Tiny',        xpCost: 0 },  // Rats, cats, human infants
      { level: 3,  label: 'Small',       xpCost: 0 },  // Wolves, children, kobolds
      { level: 4,  label: 'Medium',      xpCost: 0 },  // Adult humans, chimps, leopards
      { level: 6,  label: 'Large',       xpCost: 0 },  // Tigers, bears, werewolves
      { level: 8,  label: 'Huge',        xpCost: 0 },  // Moose, polar bears, horses, sedans
      { level: 10, label: 'Massive',     xpCost: 0 },  // Rhinos, hippos, ogres, dinosaurs
      { level: 12, label: 'Giant',       xpCost: 0 },  // Elephants, T-Rex, young dragons
      { level: 16, label: 'Colossal',    xpCost: 0 },  // Krakens, adult dragons, sauropods
      { level: 20, label: 'Titanic',     xpCost: 0 },  // Kaiju, mecha, elder dragons
      { level: 24, label: 'Behemoth',    xpCost: 0 },  // Large kaiju, worldserpents
      { level: 30, label: 'Cataclysmic', xpCost: 0 }   // World-tree ents, megakaiju, cthulhu
    ]
  },

  // Skills: arrays of XP costs, index = level (0..10)
  primarySkillXp:   [0, 2, 4, 8, 14, 22, 30, 40, 52, 66, 80],
  secondarySkillXp: [0, 1, 2, 4,  7, 11, 15, 20, 26, 33, 40],
  specialtySkillXp: [0, 1, 1, 2,  3,  5,  7, 10, 13, 16, 20],
  skillMax: 10,

  // Power Levels — ordered list
  powerLevels: [
    { value: 'powerless', label: 'Powerless',        xpPerAp: 10 },
    { value: 'low',       label: 'Low Power',        xpPerAp: 8  },
    { value: 'mid',       label: 'Mid Power',        xpPerAp: 6  },
    { value: 'high',      label: 'High Power',       xpPerAp: 4  },
    { value: 'very_high', label: 'Very High Power',  xpPerAp: 2  },
    { value: 'highest',   label: 'Highest Power',    xpPerAp: 1  }
  ],
  defaultPowerLevel: 'powerless',

  // Primary skills (name + description)
  primarySkills: [
    { name:'Academics',    description:'Learned subjects such as History or Political Science.' },
    { name:'Athletics',    description:'Physical activities like running, swimming, jumping, climbing, etc.' },
    { name:'Awareness',    description:'To be aware of one\'s surroundings utilizing one\'s senses.' },
    { name:'Crafts',       description:'A particular trade, tool, art, or practice.' },
    { name:'Drive',        description:'Operating vehicles.' },
    { name:'Investigation',description:'Uncovering, understanding, reasoning, and making deductions with information.' },
    { name:'Medical',      description:'Skill in medical treatment, and knowledge of the medical sciences.' },
    { name:'Melee',        description:'Melee combat, and melee weaponry.' },
    { name:'Occult',       description:'The esoteric; be it rituals, the supernatural, mythology, and so-on so-forth.' },
    { name:'Ranged',       description:'Ranged combat, and ranged weaponry.' },
    { name:'Science',      description:'Knowledge of the sciences.' },
    { name:'Social',       description:'Sociability, communication skills, people skills, etc.' },
    { name:'Society',      description:'Knowledge of society, institutions, laws, etiquette, etc.' },
    { name:'Stealth',      description:'Being stealthy, hiding, sneaking.' },
    { name:'Survival',     description:'Wilderness skills, foraging, identifying animal footprints, natural knowledge and skills.' },
    { name:'Technology',   description:'Knowledge, and operation, of technology.' }
  ],

  // Morals — plain string list. "" (blank) = Custom wildcard entry.
  morals: [],

  // ── ADVANTAGES & DISADVANTAGES ──
  // Both sides share the same shape: a tier scale + a catalog of entries.
  //
  // Tiers: 7 named rungs. Each has a label, a free-text description
  // (what "Minor" means at the table), and an XP cost/grant. Tier labels
  // and XP values are editable per ruleset so homebrew can re-balance.
  //
  // Entries reference a tier by *index* (0..6) rather than by label, so
  // renaming a tier in the ruleset doesn't orphan existing entries.
  //
  // Categories are a fixed list — Physical, Mental, Social, Background,
  // Special. Stored as a lowercase code so the display label can evolve
  // without touching saved data.

  advantageTiers: [
    { label: 'Minor',      description: '', xp: 0 },
    { label: 'Moderate',   description: '', xp: 0 },
    { label: 'Major',      description: '', xp: 0 },
    { label: 'Massive',    description: '', xp: 0 },
    { label: 'Monumental', description: '', xp: 0 },
    { label: 'Mega',       description: '', xp: 0 },
    { label: 'Mythical',   description: '', xp: 0 }
  ],
  disadvantageTiers: [
    { label: 'Minor',      description: '', xp: 0 },
    { label: 'Moderate',   description: '', xp: 0 },
    { label: 'Major',      description: '', xp: 0 },
    { label: 'Massive',    description: '', xp: 0 },
    { label: 'Monumental', description: '', xp: 0 },
    { label: 'Mega',       description: '', xp: 0 },
    { label: 'Mythical',   description: '', xp: 0 }
  ],

  // Catalog entries. tier = index into advantageTiers / disadvantageTiers.
  // category is one of: physical, mental, social, background, special.
  advantages: [],
  disadvantages: [],

  // ── DERIVED STATS SYSTEM ──
  //
  // Derived stats are values computed from base stats via formulas. The ruleset
  // defines them and their formulas; the character sheet evaluates them on the
  // fly. Formulas are strings like "(STR + SIZEMOD) / 2 + 1" — see char-derived.js
  // for the evaluator.
  //
  // Formula variables available:
  //   - Base stats by code: STR, DEX, PER, INT, CHA, POW, SIZE
  //   - STATMODs by code:   STRMOD, DEXMOD, PERMOD, INTMOD, CHAMOD, POWMOD, SIZEMOD
  //   - Derived stats by code: HP, AGL, etc. (evaluated in dependency order)
  //   - Purchased resources: POWERPOOL (value of power pool purchase)
  //   - Per-location context inside hit location formulas: maxHP, currentDamage
  //
  // Results are floored by default (Math.floor), unless the stat is flagged
  // `keepDecimals: true` (used by things like Reflex which are genuinely fractional).

  // Groups for organizing derived stats on the Combat tab. GM-customizable.
  // Every group has a code (stable ID) and a label (display name).
  derivedStatGroups: [
    { code: 'health',   label: 'Health'   },
    { code: 'movement', label: 'Movement' },
    { code: 'mental',   label: 'Mental'   },
    { code: 'power',    label: 'Power'    }
  ],

  derivedStats: [
    // HEALTH
    {
      code: 'HP',
      name: 'Health',
      description: 'Physical durability. Roll for physical resistances.',
      group: 'health',
      formula: 'STR + SIZE',
      // Stat modifier you roll with when the GM calls for a Health check —
      // e.g. resisting poison, disease, or other bodily trauma. Shown in the
      // card's top-right corner as a signed badge (+2, −1).
      rollModifier: 'STRMOD',
      trackDamage: false,
      keepDecimals: false,
      unit: ''
    },
    {
      code: 'FORT',
      name: 'Fortitude',
      description: 'Damage-stacking resilience. Biggest wound hits you in full; additional wounds stack through Fortitude at reduced efficiency. Higher FORT → multiple small hits bite you less.',
      group: 'health',
      // FORT is pre-computed in the symbol table from STRMOD via the
      // fortitudeTable lookup; the formula here just reads that value.
      formula: 'FORT',
      trackDamage: false,
      keepDecimals: true,
      unit: ''
    },
    // MOVEMENT
    {
      code: 'SPD',
      name: 'Speed',
      description: 'Movement speed, in feet per second.',
      group: 'movement',
      formula: 'DEX * 2.5',
      trackDamage: false,
      keepDecimals: true,     // 2.5 * DEX naturally fractional
      unit: 'ft/sec'
    },
    {
      code: 'SPDUP',
      name: 'Speed Boost',
      description: 'Bonus feet of movement from raw strength.',
      group: 'movement',
      formula: 'STR * 1',
      trackDamage: false,
      keepDecimals: false,
      unit: 'ft'
    },
    {
      code: 'AGL',
      name: 'Agility',
      description: 'General agility: dodging, tumbling, quick footwork.',
      group: 'movement',
      formula: '(DEX + PER) / 2 - 1',
      trackDamage: false,
      keepDecimals: false,
      unit: ''
    },
    {
      code: 'RFX',
      name: 'Reflex',
      description: 'Reaction time in seconds. Lower is faster.',
      group: 'movement',
      // Tuned curve: each 4 points of combined DEXMOD+PERMOD halves the
      // reaction time. At 0/0 this is 0.20s (average human); at 2/2 it's
      // 0.10s (gifted); at 4/4 it's 0.05s (exceptional). Negative stats
      // push it above 0.20s (slow reactions).
      formula: '0.2 / (2 ^ ((DEXMOD + PERMOD) / 4))',
      trackDamage: false,
      keepDecimals: true,
      unit: 's'
    },
    // MENTAL
    {
      code: 'SAN',
      name: 'Sanity',
      description: 'Mental durability. Roll for mental resistances.',
      group: 'mental',
      formula: 'CHA + INT',
      // For mental resistance rolls, character uses whichever of INT or CHA
      // gives the better modifier — reflects that sharp minds AND strong
      // willpower both help resist mental pressure, and the stronger trait
      // carries you through.
      rollModifier: 'max(INTMOD, CHAMOD)',
      trackDamage: false,
      keepDecimals: false,
      unit: ''
    },
    // POWER
    {
      code: 'POWER',
      name: 'Power Reserve',
      description: 'Total power energy available. Scales with your Power Pool and POW.',
      group: 'power',
      formula: 'POWERPOOL * POW_MULTIPLIER',
      trackDamage: false,
      keepDecimals: true,
      unit: ''
    }
  ],

  // ── HIT LOCATIONS ──
  //
  // Structural body parts. Each has its own HP formula (with maxHP being the
  // base HP derived stat) and a count (e.g. 2 arms). The character sheet creates
  // a damage tracker per location × count; a character with count=2 arms gets
  // "arm-1" and "arm-2" tracked separately.
  //
  // Damage thresholds below are applied to each location's max HP to determine
  // Disabled / Destroyed / Definitively Destroyed states.
  hitLocations: [
    { code: 'head',  name: 'Head',  count: 1, hpFormula: '(HP / 2) + (SIZE / 2) - 1' },
    { code: 'torso', name: 'Torso', count: 1, hpFormula: 'HP' },
    { code: 'arm',   name: 'Arm',   count: 2, hpFormula: '(HP / 2) + (SIZE / 2)' },
    { code: 'leg',   name: 'Leg',   count: 2, hpFormula: '(HP / 2) + (SIZE / 2)' }
  ],

  // Damage thresholds — formulas evaluated with a `maxHP` variable bound to the
  // location's max. `currentDamage` is also available if you need fancier rules.
  // Default is: 0 = Disabled, -maxHP = Destroyed, -2*maxHP = Definitively Destroyed.
  damageThresholds: {
    disabled:            { label: 'Disabled',              formula: '0' },
    destroyed:           { label: 'Destroyed',             formula: '-maxHP' },
    definitelyDestroyed: { label: 'Definitively Destroyed', formula: '-2 * maxHP' }
  },

  // ── FORTITUDE TABLE ──
  //
  // Looks up FORT (Fortitude) by STRMOD. Flat per-STRMOD entries, one row per
  // value — characters with STRMOD outside the declared range clamp to the
  // nearest endpoint.
  //
  // FORT is used in the per-location damage calculation:
  //   effective damage = highest instance + (sum of other instances) / FORT
  // So FORT=1 means damage stacks linearly; FORT=2 halves the impact of every
  // secondary wound; FORT=10 means the biggest hit matters, everything else
  // barely registers.
  //
  // Default curve: STRMOD −1 → 1, 0 → 1, 1 → 1.5, 2 → 2, linear past that.
  // Same shape as POW_MULTIPLIER — feel free to retune per ruleset.
  fortitudeTable: [
    { strmod: -1, value: 1   },
    { strmod: 0,  value: 1   },
    { strmod: 1,  value: 1.5 },
    { strmod: 2,  value: 2   },
    { strmod: 3,  value: 3   },
    { strmod: 4,  value: 4   },
    { strmod: 5,  value: 5   },
    { strmod: 6,  value: 6   },
    { strmod: 7,  value: 7   },
    { strmod: 8,  value: 8   },
    { strmod: 9,  value: 9   },
    { strmod: 10, value: 10  }
  ],

  // ── POWER POOL ──
  //
  // A resource purchased with XP. Separate from the POW stat. Used by power
  // reserve / energy systems. Ruleset can disable entirely. powMultiplier table
  // maps POWMOD (the stat modifier from POW) ranges to multiplier values used
  // by the POWER formula (e.g. POWER = POWERPOOL * POW_MULTIPLIER).
  //
  // Cost mode:
  //   'perPoint' — flat rate: cost = costPerPoint * level
  //   'perLevel' — per-level table: cost = sum of xpPerPoint[0..level]
  //
  // Basic Set defaults to perPoint at 2 XP/point — simple and flat.
  // Rulesets with curved progression (expensive higher tiers) should switch to
  // perLevel and fill out xpPerPoint.
  powerPool: {
    enabled: true,
    name: 'Power Pool',
    description: 'A reserve of power energy you pay XP to cultivate. Scales the POWER formula.',
    costMode: 'perPoint',
    costPerPoint: 2,
    xpPerPoint: [0, 5, 10, 15, 25, 40, 60, 90, 130, 180, 240],
    maxPurchasable: 20,

    // Flat lookup: one entry per POWMOD value. The POW_MULTIPLIER variable
    // is set from the entry whose `powmod` matches. If the character's POWMOD
    // falls outside the table's range, char-derived.js clamps to the nearest
    // endpoint (so impossibly high POWMOD still gets the highest multiplier).
    //
    // Default curve: POWMOD -1 → ×0.5, 0 → ×1, 1 → ×1.5, then linear from 2.
    powMultiplier: [
      { powmod: -1, value: 0.5 },
      { powmod:  0, value: 1   },
      { powmod:  1, value: 1.5 },
      { powmod:  2, value: 2   },
      { powmod:  3, value: 3   },
      { powmod:  4, value: 4   },
      { powmod:  5, value: 5   },
      { powmod:  6, value: 6   },
      { powmod:  7, value: 7   },
      { powmod:  8, value: 8   },
      { powmod:  9, value: 9   },
      { powmod: 10, value: 10  }
    ]
  }
};

// Normalize any ruleset doc by filling in missing fields from defaults.
// Useful for rulesets created before the schema existed.
window.normalizeRuleset = function(rs) {
  const d = window.RULESET_DEFAULTS;
  const out = Object.assign({}, rs);
  if (typeof out.tagline !== 'string') out.tagline = '';
  if (out.startingXp == null) out.startingXp = d.startingXp;
  if (!Array.isArray(out.statXp)) out.statXp = d.statXp.slice();
  if (out.statMaxPurchasable == null) out.statMaxPurchasable = d.statMaxPurchasable;
  if (out.statMax == null) out.statMax = d.statMax;
  if (out.statMax < out.statMaxPurchasable) out.statMax = out.statMaxPurchasable;
  if (!Array.isArray(out.stats) || out.stats.length === 0) out.stats = JSON.parse(JSON.stringify(d.stats));
  if (!Array.isArray(out.statMods) || out.statMods.length === 0) out.statMods = d.statMods.slice();
  if (!Array.isArray(out.statLabels) || out.statLabels.length === 0) out.statLabels = d.statLabels.slice();
  while (out.statMods.length < out.statMax + 1) out.statMods.push(out.statMods[out.statMods.length-1] ?? 0);
  while (out.statLabels.length < out.statMax + 1) out.statLabels.push('Level ' + out.statLabels.length);
  // SIZE block
  if (!out.size || typeof out.size !== 'object') out.size = JSON.parse(JSON.stringify(d.size));
  if (!Array.isArray(out.size.tiers) || out.size.tiers.length === 0) out.size.tiers = JSON.parse(JSON.stringify(d.size.tiers));
  if (out.size.default == null) out.size.default = d.size.default;
  if (!Array.isArray(out.primarySkillXp)) out.primarySkillXp = d.primarySkillXp.slice();
  if (!Array.isArray(out.secondarySkillXp)) out.secondarySkillXp = d.secondarySkillXp.slice();
  if (!Array.isArray(out.specialtySkillXp)) out.specialtySkillXp = d.specialtySkillXp.slice();
  if (out.skillMax == null) out.skillMax = d.skillMax;
  if (!Array.isArray(out.powerLevels) || out.powerLevels.length === 0) out.powerLevels = JSON.parse(JSON.stringify(d.powerLevels));
  if (!out.defaultPowerLevel) out.defaultPowerLevel = d.defaultPowerLevel;
  if (!Array.isArray(out.primarySkills) || out.primarySkills.length === 0) out.primarySkills = JSON.parse(JSON.stringify(d.primarySkills));
  if (!Array.isArray(out.morals)) out.morals = [];

  // ── A/D TIERS ──
  // Keep 7 entries; fill any missing slots with defaults. Any existing
  // label/description/xp values are preserved.
  const normalizeTierArray = (arr, defaults) => {
    const result = [];
    for (let i = 0; i < 7; i++) {
      const src = (Array.isArray(arr) && arr[i]) ? arr[i] : {};
      result.push({
        label: typeof src.label === 'string' && src.label ? src.label : defaults[i].label,
        description: typeof src.description === 'string' ? src.description : '',
        xp: Number.isFinite(src.xp) ? src.xp : 0
      });
    }
    return result;
  };
  out.advantageTiers    = normalizeTierArray(out.advantageTiers,    d.advantageTiers);
  out.disadvantageTiers = normalizeTierArray(out.disadvantageTiers, d.disadvantageTiers);

  // ── A/D ENTRIES ──
  // Each entry normalized to { name, category, tier, description, system, repeatable }.
  // Drop entries with no name (treat as corrupt/empty).
  //
  //   description = flavor text ("You've always been great at throwing.")
  //   system      = mechanical effect ("You benefit from 2 Difficulty Mitigation…")
  //   repeatable  = whether a character can take this entry multiple times
  const validCategories = ['physical','mental','social','background','special'];
  const normalizeEntry = (e) => {
    if (!e || typeof e !== 'object') return null;
    const name = (typeof e.name === 'string') ? e.name.trim() : '';
    if (!name) return null;
    const cat = validCategories.includes(e.category) ? e.category : 'physical';
    const tier = Number.isInteger(e.tier) ? Math.max(0, Math.min(6, e.tier)) : 0;
    const desc = (typeof e.description === 'string') ? e.description : '';
    const sys  = (typeof e.system === 'string') ? e.system : '';
    const rep  = e.repeatable === true;  // defaults to false unless explicitly true
    return { name, category: cat, tier, description: desc, system: sys, repeatable: rep };
  };
  out.advantages    = Array.isArray(out.advantages)    ? out.advantages.map(normalizeEntry).filter(Boolean)    : [];
  out.disadvantages = Array.isArray(out.disadvantages) ? out.disadvantages.map(normalizeEntry).filter(Boolean) : [];

  // ── DERIVED STAT GROUPS ──
  // Each group needs a code (stable ID) and label. Silently drop any that
  // are missing a code. Duplicate codes are filtered to the first occurrence.
  if (!Array.isArray(out.derivedStatGroups) || out.derivedStatGroups.length === 0) {
    out.derivedStatGroups = JSON.parse(JSON.stringify(d.derivedStatGroups));
  } else {
    const seenGroups = new Set();
    out.derivedStatGroups = out.derivedStatGroups
      .map(g => {
        if (!g || typeof g !== 'object') return null;
        const code = (typeof g.code === 'string') ? g.code.trim().toLowerCase() : '';
        if (!code || seenGroups.has(code)) return null;
        seenGroups.add(code);
        return {
          code,
          label: (typeof g.label === 'string' && g.label.trim()) ? g.label.trim() : code
        };
      })
      .filter(Boolean);
    if (out.derivedStatGroups.length === 0) {
      out.derivedStatGroups = JSON.parse(JSON.stringify(d.derivedStatGroups));
    }
  }

  // ── DERIVED STATS ──
  // Each entry: { code, name, description, group, formula, trackDamage, keepDecimals, unit }
  // `code` is required and must be uppercase; formulas refer to other derived stats by code.
  // `group` must match a group code (silently fallback to first group if orphaned).
  const validGroupCodes = new Set(out.derivedStatGroups.map(g => g.code));
  const fallbackGroup = out.derivedStatGroups[0].code;
  if (!Array.isArray(out.derivedStats)) {
    out.derivedStats = JSON.parse(JSON.stringify(d.derivedStats));
  } else {
    const seenCodes = new Set();
    out.derivedStats = out.derivedStats
      .map(s => {
        if (!s || typeof s !== 'object') return null;
        const code = (typeof s.code === 'string') ? s.code.trim().toUpperCase() : '';
        if (!code || seenCodes.has(code)) return null;
        seenCodes.add(code);
        const rawGroup = (typeof s.group === 'string') ? s.group.trim().toLowerCase() : '';
        return {
          code,
          name: (typeof s.name === 'string' && s.name.trim()) ? s.name.trim() : code,
          description: (typeof s.description === 'string') ? s.description : '',
          group: validGroupCodes.has(rawGroup) ? rawGroup : fallbackGroup,
          formula: (typeof s.formula === 'string') ? s.formula : '0',
          // Optional expression — displayed in the top-right of the card as
          // a signed badge indicating which stat modifier the player rolls
          // with when making resistance checks for this stat.
          rollModifier: (typeof s.rollModifier === 'string') ? s.rollModifier : '',
          trackDamage: s.trackDamage === true,
          keepDecimals: s.keepDecimals === true,
          unit: (typeof s.unit === 'string') ? s.unit : ''
        };
      })
      .filter(Boolean);

    // Auto-inject any NEW default stats that aren't in the user's list yet.
    // Rationale: when we add a core mechanic like FORT to the defaults, we
    // want existing rulesets to inherit it automatically — otherwise every
    // saved ruleset would need manual editing.
    //
    // Conservative: we only add stats that are TOTALLY ABSENT from the user's
    // list. If a stat is present with any config (even modified), we leave it
    // alone — the user's version wins. If a user explicitly DELETES a default
    // stat, it'll re-appear on next normalize; that's acceptable given the
    // low cost of re-deleting vs. the high cost of "I added FORT to defaults
    // but my characters don't see it".
    d.derivedStats.forEach(defaultStat => {
      const code = (defaultStat.code || '').toUpperCase();
      if (!code || seenCodes.has(code)) return;
      out.derivedStats.push(JSON.parse(JSON.stringify(defaultStat)));
      seenCodes.add(code);
    });

    // One-time sync for a small set of core stats where a prior default name
    // or description didn't reflect current UX wording. We only overwrite
    // when the stored value EXACTLY matches a known old default — that way,
    // anyone who intentionally renamed HP to "Hitpoints" keeps their version.
    const OLD_CORE_DEFAULTS = {
      HP: {
        oldNames: ['HP'],
        oldDescs: ['Hit Points — overall durability of the body.'],
        newName: 'Health',
        newDesc: 'Physical durability. Roll for physical resistances.'
      }
    };
    out.derivedStats.forEach(s => {
      const match = OLD_CORE_DEFAULTS[s.code];
      if (match) {
        if (match.oldNames.includes(s.name)) s.name = match.newName;
        if (match.oldDescs.includes(s.description)) s.description = match.newDesc;
      }
      // Backfill rollModifier from defaults for any core stat whose roll
      // modifier wasn't set yet. Non-destructive: we only fill when empty.
      if (!s.rollModifier) {
        const defaultStat = d.derivedStats.find(ds => ds.code === s.code);
        if (defaultStat && defaultStat.rollModifier) {
          s.rollModifier = defaultStat.rollModifier;
        }
      }
    });
  }

  // ── HIT LOCATIONS ──
  // Each entry: { code, name, count, hpFormula }. `count` is how many copies
  // of this location exist (e.g. 2 arms). Codes must be unique and non-empty.
  if (!Array.isArray(out.hitLocations)) {
    out.hitLocations = JSON.parse(JSON.stringify(d.hitLocations));
  } else {
    const seenLocs = new Set();
    out.hitLocations = out.hitLocations
      .map(l => {
        if (!l || typeof l !== 'object') return null;
        const code = (typeof l.code === 'string') ? l.code.trim().toLowerCase() : '';
        if (!code || seenLocs.has(code)) return null;
        seenLocs.add(code);
        const count = Number.isInteger(l.count) && l.count > 0 ? l.count : 1;
        return {
          code,
          name: (typeof l.name === 'string' && l.name.trim()) ? l.name.trim() : code,
          count,
          hpFormula: (typeof l.hpFormula === 'string' && l.hpFormula.trim()) ? l.hpFormula : 'HP'
        };
      })
      .filter(Boolean);
  }

  // ── DAMAGE THRESHOLDS ──
  // Three thresholds: disabled, destroyed, definitelyDestroyed. Always present
  // in the output object even if missing from input.
  if (!out.damageThresholds || typeof out.damageThresholds !== 'object') {
    out.damageThresholds = JSON.parse(JSON.stringify(d.damageThresholds));
  } else {
    ['disabled', 'destroyed', 'definitelyDestroyed'].forEach(key => {
      const defaultEntry = d.damageThresholds[key];
      const src = out.damageThresholds[key];
      if (!src || typeof src !== 'object') {
        out.damageThresholds[key] = JSON.parse(JSON.stringify(defaultEntry));
      } else {
        out.damageThresholds[key] = {
          label: (typeof src.label === 'string' && src.label.trim()) ? src.label.trim() : defaultEntry.label,
          formula: (typeof src.formula === 'string' && src.formula.trim()) ? src.formula : defaultEntry.formula
        };
      }
    });
  }

  // ── FORTITUDE TABLE ──
  // Flat per-STRMOD lookup → FORT value. Defaults to the Basic Set curve if
  // missing. When user-supplied, each entry is validated and missing STRMOD
  // values fall back to defaults so partial tables don't break the lookup.
  {
    const defaultRows = JSON.parse(JSON.stringify(d.fortitudeTable));
    const byStrmod = new Map();
    defaultRows.forEach(r => byStrmod.set(r.strmod, r.value));

    if (Array.isArray(out.fortitudeTable)) {
      out.fortitudeTable.forEach(e => {
        if (!e || typeof e !== 'object') return;
        const value = Number.isFinite(e.value) ? e.value : null;
        if (value === null) return;
        if (Number.isFinite(e.strmod)) byStrmod.set(e.strmod, value);
      });
    }

    out.fortitudeTable = Array.from(byStrmod.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([strmod, value]) => ({ strmod, value }));
  }

  // ── POWER POOL ──
  // Ruleset-level on/off, XP cost table, and POW range → multiplier lookup.
  if (!out.powerPool || typeof out.powerPool !== 'object') {
    out.powerPool = JSON.parse(JSON.stringify(d.powerPool));
  } else {
    const src = out.powerPool;
    out.powerPool = {
      enabled: src.enabled !== false,  // default on unless explicitly false
      name: (typeof src.name === 'string' && src.name.trim()) ? src.name.trim() : d.powerPool.name,
      description: (typeof src.description === 'string') ? src.description : d.powerPool.description,
      // costMode: 'perPoint' (flat) or 'perLevel' (table). Anything else falls back to default.
      costMode: (src.costMode === 'perPoint' || src.costMode === 'perLevel')
        ? src.costMode : d.powerPool.costMode,
      // Flat cost-per-point. Used only when costMode === 'perPoint'. Must be non-negative.
      costPerPoint: Number.isFinite(src.costPerPoint) && src.costPerPoint >= 0
        ? src.costPerPoint : d.powerPool.costPerPoint,
      xpPerPoint: (Array.isArray(src.xpPerPoint) && src.xpPerPoint.length > 0)
        ? src.xpPerPoint.map(v => Number.isFinite(v) ? v : 0)
        : d.powerPool.xpPerPoint.slice(),
      maxPurchasable: Number.isInteger(src.maxPurchasable) && src.maxPurchasable >= 0
        ? src.maxPurchasable : d.powerPool.maxPurchasable,
      powMultiplier: (() => {
        // Target shape: flat list, one entry per POWMOD value. Expand any
        // legacy range-based entries into per-POWMOD rows.
        //
        // Accepts three input shapes:
        //   1. Current: { powmod, value }
        //   2. Previous range-based: { powmodMin, powmodMax, value }
        //   3. Legacy (pre-POWMOD): { powMin, powMax, value } — treated as
        //      POWMOD values (numbers may need reinterpretation by the GM)
        //
        // The default table (POWMOD -1..10) is always merged in to fill any
        // gaps; user-supplied entries win on conflict.
        const defaultRows = JSON.parse(JSON.stringify(d.powerPool.powMultiplier));
        const byPowmod = new Map();
        defaultRows.forEach(r => byPowmod.set(r.powmod, r.value));

        if (Array.isArray(src.powMultiplier)) {
          src.powMultiplier.forEach(e => {
            if (!e || typeof e !== 'object') return;
            const value = Number.isFinite(e.value) ? e.value : null;
            if (value === null) return;

            // Flat format takes precedence.
            if (Number.isFinite(e.powmod)) {
              byPowmod.set(e.powmod, value);
              return;
            }

            // Range format — expand to one entry per integer in [min..max].
            const minRaw = Number.isFinite(e.powmodMin) ? e.powmodMin
                         : Number.isFinite(e.powMin)    ? e.powMin    : null;
            const maxRaw = Number.isFinite(e.powmodMax) ? e.powmodMax
                         : Number.isFinite(e.powMax)    ? e.powMax    : minRaw;
            if (minRaw === null) return;
            const lo = Math.floor(minRaw);
            const hi = Math.floor(maxRaw === null ? minRaw : maxRaw);
            for (let k = lo; k <= hi; k++) byPowmod.set(k, value);
          });
        }

        // Emit sorted by POWMOD for a stable, predictable table order.
        return Array.from(byPowmod.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([powmod, value]) => ({ powmod, value }));
      })()
    };
  }

  return out;
};
