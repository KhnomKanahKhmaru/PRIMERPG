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

  // ── AFFLICTIONS (Conditions & Circumstances) ──
  // Two preset libraries:
  //   conditions   — ongoing states OF the character (traumas, diseases,
  //                  disorders, injuries). "You have X."
  //   circumstances — ongoing external / situational effects (weather,
  //                  lighting, being hunted). "You are in X."
  //
  // Both use the same entry shape and render the same way; the split is
  // semantic only, so players can categorize their afflictions clearly.
  //
  // Preset entry shape:
  //   { id: 'cond_xxx', name, description, system }
  // `id` is the stable reference characters use via their entry's defId;
  // `name` / `description` / `system` are the authored content. Default
  // library is empty — GMs add entries via the ruleset editor, or
  // characters promote their own one-offs into their personal catalogue.
  //
  // NOTE: The outer key is still called `conditions` for storage-
  // compatibility with data saved before the Conditions/Circumstances
  // rename; the sub-keys were `physical`/`mental` in v1 and are now
  // `conditions`/`circumstances`. The normalizer migrates old data
  // transparently on load.
  conditions: {
    conditions:    [],
    circumstances: []
  },

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
    { code: 'power',    label: 'Power'    },
    { code: 'carry',    label: 'Carry'    }
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
      // Passive rolls are immune to Strain (Pain + Stress). Characters don't
      // suffer dice penalties when resisting bodily trauma just because they're
      // in pain — the whole point of the roll is to see if they can endure.
      passiveRoll: true,
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
      description: 'How fast you can move in feet per second.',
      group: 'movement',
      formula: 'DEX * 2.5',
      trackDamage: false,
      keepDecimals: true,     // 2.5 * DEX naturally fractional
      unit: 'ft/sec',
      // Penalty reduces movement values linearly — a character at 25%
      // Penalty moves at 75% of their base speed. Shown inline as
      // "10 − 2.5 ft/sec".
      penaltyReducesValue: true,
      // Expandable conversions panel on the card — 3s/6s/min/hr/mph/etc.
      showSpeedConversions: true
    },
    {
      code: 'SPDUP',
      name: 'Speed Boost',
      description: 'You may add increments equal to this amount to your Speed; every time you do so, you gain +1 Dice Penalty towards all physical actions for the rest of the Round.',
      group: 'movement',
      formula: 'STR * 1',
      trackDamage: false,
      keepDecimals: false,
      unit: 'ft',
      penaltyReducesValue: true,
      showSpeedConversions: true
    },
    {
      code: 'AGL',
      name: 'Agility',
      description: 'You may make a number of "free" (without normal penalties for spamming) Fast Actions, Fast Reactions, and Reactions per Round, equal to this. This applies independently to each.',
      group: 'movement',
      formula: '(DEX + PER) / 2 - 1',
      trackDamage: false,
      keepDecimals: false,
      unit: ''
    },
    {
      code: 'RFX',
      name: 'Reflex',
      description: 'Reaction time in seconds; used mostly for flavor, but also to determine whether you can participate in high-speed combat, or whether you get speedblitz\'d.',
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
      // Passive roll — Sanity resistance rolls are not reduced by Strain.
      passiveRoll: true,
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
    },
    // CARRY
    // CAP, ENC, LIFT are the three carry stats. All three are passive
    // (they don't contribute to dice pools themselves) and render as
    // their own cards at the top of the Inventory tab — NOT in the
    // Combat tab's derived-stats section. The 'carry' group flag is
    // read by the inventory renderer to know which stats to display.
    {
      code: 'CAP',
      name: 'Carrying Capacity',
      description: 'The weight in pounds you can carry without any Encumbrance. Baseline: STR × 10.',
      group: 'carry',
      formula: 'STR * 10',
      passiveRoll: true,
      trackDamage: false,
      keepDecimals: false,
      unit: 'lbs'
    },
    {
      code: 'LIFT',
      name: 'Maximum Lift',
      description: 'Absolute maximum you can ever carry without a roll. At this weight, ENC is 100% and you cannot move without rolling to "lift". Equal to CAP × 11.',
      group: 'carry',
      formula: 'CAP * 11',
      passiveRoll: true,
      trackDamage: false,
      keepDecimals: false,
      unit: 'lbs'
    },
    {
      code: 'ENC',
      name: 'Encumbrance',
      description: 'Penalty from carrying more than your CAP. Accumulates at 10% per CAP-increment over CAP; reaches 100% at LIFT. Auto-calculated from your inventory (groups tagged "count for encumbrance").',
      group: 'carry',
      // CARRIED is injected into the symbol table by computeDerivedStats
      // before formula evaluation (see the inventory weight sum there).
      // Formula: fraction of the over-CAP range, expressed as 0–100%.
      // max/min clamp handles carrying ≤ CAP (0%) and > LIFT (100%).
      formula: 'max(0, min(100, (CARRIED - CAP) / CAP * 10))',
      passiveRoll: true,
      trackDamage: false,
      keepDecimals: true,
      unit: '%'
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
  },

  // ─── INVENTORY ──────────────────────────────────────────────────────
  //
  // The inventory system is informational only — dimensions, weight, and
  // overflow are computed and displayed but don't enforce anything at the
  // data layer. The GM adjudicates: "yes you can strap five rifles to that
  // backpack, it's just ridiculous and the dice penalty is on you."
  //
  // Three catalogs make up the ruleset side:
  //
  //   bodySlots   — named positions on the character where worn containers
  //                 go. Purely labels; no per-slot capacity enforced.
  //                 Rulesets can add/rename/remove to taste (mech hardpoints,
  //                 cloak slots, etc.).
  //
  //   containers  — storage items with L×W×H dimensions and a weight. Items
  //                 go inside them. Containers can themselves go inside
  //                 other containers (recursive; no depth limit). A
  //                 character's top-level containers attach to a bodySlot
  //                 or live in a synthetic "Stowed" bucket.
  //
  //   equipment   — anything non-container a character can carry. Has
  //                 dimensions and weight for packing math. Optionally
  //                 links back to the weapon catalog (when added later) via
  //                 weaponId so inventory items can surface combat stats.
  //
  // Dimensions are inches (L×W×H), weight is pounds. These match what the
  // sheet displays; we don't convert to metric.
  //
  // packingEfficiency lets a messy-packed container waste some of its
  // volume. A duffel bag at 0.75 means 75% of its cubic volume can actually
  // be used for items — the rest is lost to lumps, odd shapes, and the
  // bag's own material. The longest-dimension check (item longest ≤
  // container longest) runs independently of this.

  // bodySlots are legacy — the current data model organizes everything
  // into groups (top-level: On-Person, plus any player-created groups
  // like Vehicle / Stash). The bodySlots field is kept as an empty array
  // for backward compatibility with older rulesets that still reference
  // it, but no new code reads from it. Players create their own
  // subgroups inside On-Person (e.g. "Back", "Belt", "Holster") as
  // purely organizational buckets.
  bodySlots: [],

  // ── UNIFIED ITEM CATALOG ──
  //
  // Every carryable thing — weapon, tool, armor, container — is a single
  // kind of record: an Item. An item becomes a container when its
  // `containerOf` block is populated (inner dims + packing efficiency).
  // This collapses the old "containers vs equipment" split into one
  // catalog that's easier to browse and categorize.
  //
  // Items are organized into a tree of categories via `categoryId` +
  // `categories` (a flat array with `parentId` pointers, allowing
  // arbitrary nesting depth). Uncategorized items fall into the
  // auto-created "Miscellaneous" category on display.

  items: [],
  categories: [
    // "Miscellaneous" is a built-in category that always exists. It's
    // the bucket for items whose categoryId is null or points to a
    // deleted category. Can be renamed/described but not deleted.
    {
      id: 'cat_misc', name: 'Miscellaneous', description: '',
      parentId: null, builtIn: true,
      defaultDimensions: { l: 0, w: 0, h: 0 }, defaultWeight: 0
    }
  ],

  // Dimension Presets — named L×W×H shapes (optionally with a matching
  // weight) that authors can pick when creating items. Picking a preset
  // autofills the item's dimensions (and weight, when non-zero) without
  // having to type them in. The Standard Set ships ~12 common shapes
  // covering pistols, rifles, shells, bandages, packs, and other
  // everyday sizes. Custom rulesets can add their own or edit these
  // built-ins (built-in presets CAN be renamed/sized but not deleted
  // so the shape dropdown always has a baseline to click).
  //
  // Shape: { id, name, dimensions: {l, w, h}, weight, builtIn? }
  dimensionPresets: [
    { id: 'dp_pistol',    name: 'Pistol',           dimensions: { l: 8,   w: 1.5, h: 5.5 }, weight: 1.5,   builtIn: true },
    { id: 'dp_rifle',     name: 'Rifle',            dimensions: { l: 40,  w: 3,   h: 8   }, weight: 8,     builtIn: true },
    { id: 'dp_shotgun',   name: 'Shotgun',          dimensions: { l: 42,  w: 3,   h: 8   }, weight: 7.5,   builtIn: true },
    { id: 'dp_smg',       name: 'SMG / Carbine',    dimensions: { l: 22,  w: 2.5, h: 7   }, weight: 5,     builtIn: true },
    { id: 'dp_dagger',    name: 'Dagger / Knife',   dimensions: { l: 10,  w: 1,   h: 1   }, weight: 0.5,   builtIn: true },
    { id: 'dp_sword',     name: 'Sword',            dimensions: { l: 38,  w: 1.5, h: 4   }, weight: 3,     builtIn: true },
    { id: 'dp_grenade',   name: 'Grenade',          dimensions: { l: 4,   w: 2.5, h: 2.5 }, weight: 1,     builtIn: true },
    { id: 'dp_shell',     name: 'Shotgun Shell',    dimensions: { l: 3,   w: 0.7, h: 0.7 }, weight: 0.08,  builtIn: true },
    { id: 'dp_bullet',    name: 'Pistol Cartridge', dimensions: { l: 1.2, w: 0.4, h: 0.4 }, weight: 0.02,  builtIn: true },
    { id: 'dp_magazine',  name: 'Magazine',         dimensions: { l: 5,   w: 1,   h: 3.5 }, weight: 0.75,  builtIn: true },
    { id: 'dp_bandage',   name: 'Bandage / Small Medical', dimensions: { l: 3, w: 2, h: 1 }, weight: 0.15, builtIn: true },
    { id: 'dp_pill',      name: 'Pill Bottle / Vial', dimensions: { l: 2, w: 1, h: 3 },     weight: 0.1,   builtIn: true },
    { id: 'dp_book',      name: 'Book',             dimensions: { l: 9,   w: 2,   h: 6   }, weight: 2,     builtIn: true },
    { id: 'dp_coin',      name: 'Coin / Token',     dimensions: { l: 1,   w: 0.1, h: 1   }, weight: 0.02,  builtIn: true },
    { id: 'dp_daypack',   name: 'Daypack',          dimensions: { l: 18,  w: 10,  h: 22  }, weight: 2,     builtIn: true },
    { id: 'dp_duffel',    name: 'Duffel Bag',       dimensions: { l: 28,  w: 14,  h: 14  }, weight: 2.5,   builtIn: true },
    { id: 'dp_pouch',     name: 'Belt Pouch',       dimensions: { l: 6,   w: 3,   h: 5   }, weight: 0.3,   builtIn: true },
    { id: 'dp_holster',   name: 'Holster',          dimensions: { l: 9,   w: 2,   h: 7   }, weight: 0.5,   builtIn: true }
  ],

  // ═══ WEAPONS ═══
  //
  // Weapon integration is ruleset-level. A ruleset defines:
  //   1. The four roll formulas (melee/ranged × attack/damage) — these
  //      use the same formula engine char-derived.js uses for derived
  //      stats, so expressions can reference stats (DEX, STR),
  //      stat mods (DEXMOD, STRMOD), skills (Melee, Ranged),
  //      weapon constants (DMG = dice count, ATK = attack roll result,
  //      DMGMOD = ranged damage bonus), and operators.
  //   2. A shared tag catalogue — short labels players can apply to
  //      their weapons (Silenced, Two-Handed, Bleeding, etc.). Tags
  //      are descriptive for now; later passes may add auto-computed
  //      effects but the base schema is just {id, name, description}.
  //
  // Individual weapons live on catalogue ITEMS (item.weapon = {...}),
  // not in the ruleset itself. This keeps the ruleset lean and lets
  // players define custom weapons in their personal catalogue.
  weapons: {
    meleeAttackFormula:  'DEX + Melee + DEXMOD',
    meleeDamageFormula:  'STR + DMG + ATK + STRMOD',
    rangedAttackFormula: 'DEX + Ranged + DEXMOD',
    rangedDamageFormula: 'DEX + DMG + ATK + DMGMOD'
  },

  // Tag catalogue. Order matters for display but not behavior. Each
  // entry is { id, name, description }. IDs follow the `t_` prefix
  // convention to avoid collisions with item ids elsewhere.
  //
  // The Standard Set ships with seven mechanically-active tags. The
  // resolver and card UI key off these by NAME (case-insensitive)
  // rather than id, so tags renamed/copied into custom rulesets still
  // behave correctly as long as the name matches. IDs are stable for
  // cross-reference.
  // Tag categories — nested tree for grouping weapon tags so large
  // tag catalogues stay manageable in the editor and on weapon cards.
  // Shape: {id, name, parentId|null, builtIn?}. Like item categories
  // (see categories[] elsewhere) but scoped ONLY to weapon tags. The
  // built-in "Uncategorized" category is the default home for tags
  // that don't specify a categoryId — deleting it is tolerated, but
  // the normalizer re-seeds it so at least one home always exists.
  tagCategories: [
    { id: 'tcat_uncategorized', name: 'Uncategorized', parentId: null, builtIn: true }
  ],

  weaponTags: [
    {
      id: 't_shotgun',
      name: 'Shotgun',
      description: 'Mag-fed Shotguns reload as normal; tube-shell Shotguns reload 1 AMMO per Fast Action spent. Damage +1 within half of the first range band, +2 within a quarter, +3 closer than that. If capable of sweeping, sweep AOE is doubled and requires 1 shell per increment instead of 5 rounds.'
    },
    {
      id: 't_firearm',
      name: 'Firearm',
      description: 'Firearm attacks are +3 Difficulty to Dodge without cover; +2 within half of one\'s dodge distance from cover, +1 within a quarter, +0 closer than that. Firearm attacks are +6 Difficulty to Defend against without a valid deflection, redirection (e.g. shield), or being in melee range.'
    },
    {
      id: 't_rapidfire_sweep',
      name: 'Rapidfire Sweep',
      description: 'Ranged weapons with ROF ≥ 2 can perform a Rapidfire Sweep against an area and all targets within it, one Attack roll and one Damage roll. For each AMMO spent past the first (minimum 2 AMMO) the covered volume grows by 2.5×ROF feet on every side of a cube — volume may be shaped any way you like (line, cone, zig-zag, dome, irregular). AMMO spent on a sweep does NOT also grant the Rapidfire damage bonus — choose to spread the AMMO across area OR concentrate it into damage, or split between the two. Example: ROF 2, 3 AMMO → 10×10×10 cube. ROF 2, 6 AMMO → 25×25×25 cube.'
    },
    {
      id: 't_scoped',
      name: 'Scoped',
      description: 'When the Aim action is taken, effective range is multiplied by the scope\'s magnification value.',
      params: [
        {
          key: 'magnification',
          type: 'number',
          label: 'Magnification',
          default: 4,
          min: 1,
          max: 50
        }
      ]
    },
    {
      id: 't_major_stabilization',
      name: 'Major Stabilization',
      description: 'Stabilized by a major fixture (tripod, vehicle mount, structural mount). Recoil is decreased by 3.'
    },
    {
      id: 't_stabilization',
      name: 'Stabilization',
      description: 'Stabilized by a standard fixture (bipod or similar). Recoil is decreased by 2.'
    },
    {
      id: 't_minor_stabilization',
      name: 'Minor Stabilization',
      description: 'Stabilized by a minor method (stationary prone, terrain, improvised stabilization, a specialized shooting stance). Recoil is decreased by 1.'
    }
  ]
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

  // ── CONDITIONS ──
  // Two preset lists (physical, mental). Each preset entry is {id,
  // name, description, system}. The normalizer coerces missing arrays
  // into empty ones and drops any malformed entries silently.
  const normalizeConditionList = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map(c => {
        if (!c || typeof c !== 'object') return null;
        const id = (typeof c.id === 'string' && c.id) ? c.id : null;
        if (!id) return null;
        return {
          id,
          name:        (typeof c.name === 'string')        ? c.name        : '',
          description: (typeof c.description === 'string') ? c.description : '',
          system:      (typeof c.system === 'string')      ? c.system      : ''
        };
      })
      .filter(Boolean);
  };
  if (!out.conditions || typeof out.conditions !== 'object') {
    out.conditions = { conditions: [], circumstances: [] };
  } else {
    // Migrate legacy keys: physical → conditions, mental → circumstances.
    // Prefer new keys if both somehow exist (shouldn't happen in practice).
    const legacyPhysical = Array.isArray(out.conditions.physical) ? out.conditions.physical : [];
    const legacyMental   = Array.isArray(out.conditions.mental)   ? out.conditions.mental   : [];
    const newConditions    = Array.isArray(out.conditions.conditions)    ? out.conditions.conditions    : null;
    const newCircumstances = Array.isArray(out.conditions.circumstances) ? out.conditions.circumstances : null;
    out.conditions = {
      conditions:    normalizeConditionList(newConditions    != null ? newConditions    : legacyPhysical),
      circumstances: normalizeConditionList(newCircumstances != null ? newCircumstances : legacyMental)
    };
  }

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
    } else {
      // Ensure every default group exists — missing groups would cause
      // their stats to orphan into an "Other" bucket in the Combat tab.
      // Older saved rulesets pre-date the 'carry' group, so without this
      // back-fill, CAP / LIFT / ENC stats were rendering under a stray
      // "Other" section on the Combat tab. New rulesets are unaffected.
      d.derivedStatGroups.forEach(defaultGroup => {
        if (!seenGroups.has(defaultGroup.code)) {
          out.derivedStatGroups.push({
            code: defaultGroup.code,
            label: defaultGroup.label
          });
          seenGroups.add(defaultGroup.code);
        }
      });
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
          // Passive rolls are exempt from Penalty dice reductions.
          // Defaults to false so new stats are treated as active (Penalty
          // applies) — only explicitly-marked passive stats skip it.
          passiveRoll: s.passiveRoll === true,
          // Penalty reduces the displayed VALUE of this stat instead of
          // the dice pool — used for movement-style stats where the value
          // isn't rolled but still suffers when the character is hurt/stressed.
          // Mutually coherent with passiveRoll: a stat with passiveRoll=true
          // is Penalty-immune, so penaltyReducesValue has no effect on it.
          // Legacy field `strainReducesValue` still read as a fallback so
          // saved rulesets from before the rename auto-migrate.
          penaltyReducesValue: s.penaltyReducesValue === true || s.strainReducesValue === true,
          // Expandable conversion panel on the stat card — 3s/6s/min/hr/mph.
          // Useful for speed stats (SPD, SPDUP, future burrow/swim/etc.).
          // The card's value is treated as ft/sec for the math.
          showSpeedConversions: s.showSpeedConversions === true,
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
      },
      // Movement stats — descriptions refined to reflect the actual rules
      // wording. Old stock phrasings were flavor-only; new versions tell
      // the player what the number DOES at the table.
      SPD: {
        oldNames: ['Speed'],
        oldDescs: ['Movement speed, in feet per second.'],
        newName: 'Speed',
        newDesc: 'How fast you can move in feet per second.'
      },
      SPDUP: {
        oldNames: ['Speed Boost'],
        oldDescs: ['Bonus feet of movement from raw strength.'],
        newName: 'Speed Boost',
        newDesc: 'You may add increments equal to this amount to your Speed; every time you do so, you gain +1 Dice Penalty towards all physical actions for the rest of the Round.'
      },
      AGL: {
        oldNames: ['Agility'],
        oldDescs: ['General agility: dodging, tumbling, quick footwork.'],
        newName: 'Agility',
        newDesc: 'You may make a number of "free" (without normal penalties for spamming) Fast Actions, Fast Reactions, and Reactions per Round, equal to this. This applies independently to each.'
      },
      RFX: {
        oldNames: ['Reflex'],
        oldDescs: ['Reaction time in seconds. Lower is faster.'],
        newName: 'Reflex',
        newDesc: 'Reaction time in seconds; used mostly for flavor, but also to determine whether you can participate in high-speed combat, or whether you get speedblitz\'d.'
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
      // Backfill passiveRoll for HP/SAN (or any default stat) if the saved
      // value still matches the pre-flag default of false. Safe: we only
      // flip false → true for stats that are DEFAULT passive; stats the user
      // actively set non-passive aren't touched.
      if (s.passiveRoll !== true) {
        const defaultStat = d.derivedStats.find(ds => ds.code === s.code);
        if (defaultStat && defaultStat.passiveRoll === true) {
          s.passiveRoll = true;
        }
      }
      // Same one-way backfill for penaltyReducesValue — if the default
      // says true but the saved stat is still unset/false, inherit it.
      if (s.penaltyReducesValue !== true) {
        const defaultStat = d.derivedStats.find(ds => ds.code === s.code);
        if (defaultStat && defaultStat.penaltyReducesValue === true) {
          s.penaltyReducesValue = true;
        }
      }
      // Same for showSpeedConversions — if the default says true but the
      // saved stat is still unset/false, inherit it.
      if (s.showSpeedConversions !== true) {
        const defaultStat = d.derivedStats.find(ds => ds.code === s.code);
        if (defaultStat && defaultStat.showSpeedConversions === true) {
          s.showSpeedConversions = true;
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

  // ─── INVENTORY NORMALIZATION ─────────────────────────────────────────
  //
  // bodySlots / containers / equipment are all arrays of small records.
  // We re-shape each entry to enforce the schema — drop fields we don't
  // recognize, coerce types, default anything missing. Empty / invalid
  // entries are filtered out so downstream code never sees garbage.

  // Slot entries need a stable `code` (used as a key in character data's
  // inventory.bySlot map) plus a human `label`. Code gets slugified so a
  // user-entered "Back Left" works as a key.
  const slugSlotCode = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!Array.isArray(out.bodySlots)) out.bodySlots = [];
  out.bodySlots = out.bodySlots
    .map(s => {
      if (!s || typeof s !== 'object') return null;
      const code  = slugSlotCode(s.code || s.label || '');
      const label = (typeof s.label === 'string' && s.label.trim()) ? s.label.trim()
                  : (typeof s.code  === 'string' && s.code.trim())  ? s.code.trim()
                  : '';
      if (!code || !label) return null;
      return { code, label };
    })
    .filter(Boolean);
  // Dedupe by code — if two entries collide, first wins.
  {
    const seen = new Set();
    out.bodySlots = out.bodySlots.filter(s => {
      if (seen.has(s.code)) return false;
      seen.add(s.code);
      return true;
    });
  }
  // Empty bodySlots is a valid, supported state now. The old fallback
  // auto-filled with defaults here; we no longer do that. Organization
  // is handled by the groups system instead (On-Person + player-created
  // groups + subgroups).

  // ── UNIFIED ITEM CATALOG + CATEGORIES ──
  //
  // The inventory catalog is ONE array of items (any kind of carryable
  // thing) plus a tree of categories. Items point at a category via
  // `categoryId`; uncategorized items fall into the built-in
  // "Miscellaneous" category at display time. Items become containers
  // when their `containerOf` block is populated.
  //
  // On load we handle three shapes:
  //   1. Legacy: `containers` + `equipment` arrays present, no `items`.
  //      → migrate containers into items (wrapped as container items),
  //        move equipment in directly, assemble unified `items` array,
  //        then drop the legacy fields.
  //   2. Current: `items` + `categories` arrays present.
  //      → validate and fill any gaps.
  //   3. Empty: nothing here.
  //      → create empty arrays + a built-in "Miscellaneous" category.

  const nextSynthId = (() => {
    let n = 0;
    return (prefix) => `${prefix}_${Date.now().toString(36)}_${(n++).toString(36)}`;
  })();

  const coerceFiniteNonNeg = (v, fallback) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const coerceDimensions = (raw) => {
    const d2 = (raw && typeof raw === 'object') ? raw : {};
    return {
      l: coerceFiniteNonNeg(d2.l, 0),
      w: coerceFiniteNonNeg(d2.w, 0),
      h: coerceFiniteNonNeg(d2.h, 0)
    };
  };
  const coerceContainerBlock = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const dims = coerceDimensions(raw.dimensions);
    // packingEfficiency defaults to 0.75 — a reasonable "soft packed"
    // number. Clamped to [0.1, 1.0] so nobody sets it to 0 (container
    // can't hold anything) or negative.
    let eff = coerceFiniteNonNeg(raw.packingEfficiency, 0.75);
    if (eff < 0.1) eff = 0.1;
    if (eff > 1.0) eff = 1.0;
    return { dimensions: dims, packingEfficiency: eff };
  };

  // Weapon block — optional. Items that aren't weapons omit this field
  // entirely (null return). The schema is split by `kind`:
  //
  //   shared:   dice (number), pen (number), tags (string[] of tag ids)
  //   melee:    ranges ([{s,e}, ...] in feet) — each band is an object
  //             with start/end in feet. Stored as objects NOT nested
  //             arrays because Firestore rejects arrays-of-arrays. The
  //             UI uses the count of bands to assign Difficulty (+0 for
  //             band 0, +1 for band 1, etc). Empty/missing ranges means
  //             "all ranges are +0" (trivial weapon).
  //   ranged:   range (base feet), ammo (string formula OR number),
  //             rof (string formula OR number), dmgmod (number — ranged
  //             weapons carry a DMG bonus woven into the damage formula)
  //
  // `ammo` and `rof` accept a formula string so rulesets can author
  // weapons like "AMMO = STR" or "ROF = (DEXMOD/2)-1". Resolution
  // happens at render time against the character's live stats; the
  // snapshot on inventory entries stores the original formula text so
  // later stat changes update the effective value while the weapon def
  // stays frozen.
  const coerceWeapon = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const kindRaw = (typeof raw.kind === 'string') ? raw.kind.toLowerCase() : '';
    if (kindRaw !== 'melee' && kindRaw !== 'ranged') return null;

    const dice = coerceFiniteNonNeg(raw.dice, 0);
    const pen  = coerceFiniteNonNeg(raw.pen,  0);

    // Tags: array of tag ids (strings). Anything non-string gets dropped.
    // Deduped by string-equality. Bad tags (referencing deleted ruleset
    // tags) are tolerated — the display layer silently skips unknown
    // ids and shows only the resolvable ones.
    let tags = [];
    if (Array.isArray(raw.tags)) {
      const seen = new Set();
      raw.tags.forEach(t => {
        if (typeof t !== 'string' || !t) return;
        if (seen.has(t)) return;
        seen.add(t);
        tags.push(t);
      });
    }

    // Tag parameter values. Shape: { [tagId]: { [paramKey]: value } }.
    // E.g. { t_scoped: { magnification: 4 } }. Preserved verbatim
    // here — the resolver looks up parameter defaults from the
    // ruleset's tag definitions and fills in missing values. Orphan
    // tagParams (for tags the weapon doesn't actually have) are
    // tolerated; they just do nothing.
    let tagParams = null;
    if (raw.tagParams && typeof raw.tagParams === 'object') {
      const clean = {};
      Object.keys(raw.tagParams).forEach(tagId => {
        const v = raw.tagParams[tagId];
        if (!v || typeof v !== 'object') return;
        const sub = {};
        Object.keys(v).forEach(key => {
          const val = v[key];
          if (typeof val === 'number' && Number.isFinite(val)) sub[key] = val;
          else if (typeof val === 'string') sub[key] = val;
          else if (typeof val === 'boolean') sub[key] = val;
        });
        if (Object.keys(sub).length > 0) clean[tagId] = sub;
      });
      if (Object.keys(clean).length > 0) tagParams = clean;
    }

    if (kindRaw === 'melee') {
      // Range bands. Stored as an array of {s, e} objects (NOT nested
      // arrays — Firestore doesn't support those). Legacy data
      // may still have the old [[s,e], ...] shape from before this
      // schema change; we accept either and normalize to the object
      // form. Invalid entries (missing numbers, e < s, negative) are
      // dropped silently.
      let ranges = [];
      if (Array.isArray(raw.ranges)) {
        raw.ranges.forEach(band => {
          let s, e;
          if (Array.isArray(band) && band.length >= 2) {
            s = Number(band[0]);
            e = Number(band[1]);
          } else if (band && typeof band === 'object') {
            s = Number(band.s);
            e = Number(band.e);
          } else {
            return;
          }
          if (!Number.isFinite(s) || !Number.isFinite(e)) return;
          if (s < 0 || e < s) return;
          ranges.push({ s, e });
        });
      }
      return { kind: 'melee', dice, pen, tags, ranges, tagParams };
    }

    // ranged
    const range  = coerceFiniteNonNeg(raw.range,  0);
    const dmgmod = Number.isFinite(Number(raw.dmgmod)) ? Number(raw.dmgmod) : 0;
    // ammo / rof accept either a number OR a formula string. We keep
    // whatever the author provided — the resolver at use-time decides
    // whether to eval a formula or use a literal.
    const coerceNumOrFormula = (v, fallback) => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim()) return v.trim();
      return fallback;
    };
    const ammo = coerceNumOrFormula(raw.ammo, 1);
    const rof  = coerceNumOrFormula(raw.rof,  0);
    // Legacy scopeMagnification field: if present, migrate into
    // tagParams.t_scoped.magnification so all tag parameters live in
    // one place going forward.
    if (Number.isFinite(Number(raw.scopeMagnification))) {
      const mag = Math.max(1, Number(raw.scopeMagnification));
      if (!tagParams) tagParams = {};
      if (!tagParams.t_scoped) tagParams.t_scoped = {};
      if (tagParams.t_scoped.magnification == null) {
        tagParams.t_scoped.magnification = mag;
      }
    }
    return { kind: 'ranged', dice, pen, tags, range, dmgmod, ammo, rof, tagParams };
  };

  // Normalize a single item record. Shared by the migration path
  // (legacy entry → item) and the validation path (existing item → item).
  // `sourceKind` is 'container' when coming from the old containers
  // array — those are auto-promoted to have a containerOf block synthesized
  // from their top-level dimensions/packing fields.
  const normalizeItem = (raw, sourceKind) => {
    if (!raw || typeof raw !== 'object') return null;
    const name = (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : '';
    if (!name) return null;

    // Outer dimensions (the item's physical size) — carried by every
    // item whether it's a container or not.
    const dimensions = coerceDimensions(raw.dimensions);

    // Determine the containerOf block. Three paths:
    //   - Legacy `container` record: synthesize from its top-level
    //     dimensions + packingEfficiency (those fields describe its
    //     internal capacity in the old schema).
    //   - Legacy `equipment` record or current item: use its containerOf
    //     block directly if present.
    //   - Plain item: null.
    let containerOf = null;
    if (sourceKind === 'container') {
      // Old containers carried packingEfficiency at the top level and
      // their outer/inner dimensions were the same. Wrap into the new
      // containerOf shape so they "just work" as containers.
      containerOf = {
        dimensions: { l: dimensions.l, w: dimensions.w, h: dimensions.h },
        packingEfficiency: coerceContainerBlock(raw) ? coerceContainerBlock(raw).packingEfficiency : 0.75
      };
    } else if (raw.containerOf) {
      containerOf = coerceContainerBlock(raw.containerOf);
    }

    return {
      id:           (typeof raw.id === 'string' && raw.id) ? raw.id : nextSynthId(sourceKind === 'container' ? 'cont' : 'item'),
      name,
      description:  (typeof raw.description === 'string') ? raw.description : '',
      dimensions,
      weight:       coerceFiniteNonNeg(raw.weight, 0),
      // Category membership — string id pointing at a categories entry,
      // or null for uncategorized (displays under Miscellaneous).
      categoryId:   (typeof raw.categoryId === 'string' && raw.categoryId) ? raw.categoryId : null,
      // Legacy free-form `category` string preserved if present, for
      // potential later auto-mapping to real categories. Safe to ignore
      // by new code.
      legacyCategory: (typeof raw.category === 'string' && raw.category) ? raw.category : '',
      // Future weapon-catalog linkage (not built yet).
      weaponId:     (typeof raw.weaponId === 'string' && raw.weaponId) ? raw.weaponId : null,
      // Weapon block — present when the item is a weapon. Null/omitted
      // otherwise. Structure depends on `weapon.kind` ('melee' or
      // 'ranged'). Added to the catalogue item's def; snapshot-copied
      // onto inventory entries at add-time (see char-inventory.js).
      weapon:       coerceWeapon(raw.weapon),
      // Default body slot — set on containers so adding one to a
      // character pre-selects the right slot.
      defaultSlot:  (typeof raw.defaultSlot === 'string' && raw.defaultSlot) ? raw.defaultSlot : null,
      containerOf
    };
  };

  // Detect legacy shape. If we find containers/equipment arrays AND no
  // items array, it's pre-unification data that needs migrating.
  const hasLegacyCatalog = Array.isArray(out.containers) || Array.isArray(out.equipment);
  const hasUnifiedItems  = Array.isArray(out.items);

  if (!hasUnifiedItems) {
    // Migration path — merge old catalogs into one items array.
    const items = [];
    (Array.isArray(out.containers) ? out.containers : []).forEach(c => {
      const item = normalizeItem(c, 'container');
      if (item) items.push(item);
    });
    (Array.isArray(out.equipment) ? out.equipment : []).forEach(e => {
      const item = normalizeItem(e, 'equipment');
      if (item) items.push(item);
    });
    out.items = items;
  } else {
    // Current shape — just validate and clean.
    out.items = out.items.map(i => normalizeItem(i, 'equipment')).filter(Boolean);
  }

  // Drop legacy fields so the persisted doc stays clean and we don't
  // keep re-migrating on every load.
  if (hasLegacyCatalog) {
    delete out.containers;
    delete out.equipment;
  }

  // ── CATEGORIES ──
  //
  // Flat array of { id, name, description, parentId, builtIn }.
  // parentId=null means top-level; non-null must point at another
  // category in the array. Arbitrary nesting depth is allowed.
  // "Miscellaneous" is a built-in category that always exists — items
  // with categoryId=null or pointing at a deleted category display
  // under it.

  if (!Array.isArray(out.categories)) out.categories = [];

  // Normalize entries: name required, description optional, parentId
  // nullable, builtIn preserved if set. defaultDimensions/defaultWeight
  // carry category-level dimension + weight defaults that new items in
  // this category will inherit. Missing fields become {0,0,0} and 0 —
  // treated as "no default" by the UI (won't overwrite anything).
  out.categories = out.categories.map(c => {
    if (!c || typeof c !== 'object') return null;
    const name = (typeof c.name === 'string' && c.name.trim()) ? c.name.trim() : '';
    if (!name) return null;
    const dd = c.defaultDimensions || {};
    const clampDim = v => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    return {
      id:          (typeof c.id === 'string' && c.id) ? c.id : nextSynthId('cat'),
      name,
      description: (typeof c.description === 'string') ? c.description : '',
      parentId:    (typeof c.parentId === 'string' && c.parentId) ? c.parentId : null,
      builtIn:     c.builtIn === true,
      defaultDimensions: { l: clampDim(dd.l), w: clampDim(dd.w), h: clampDim(dd.h) },
      defaultWeight:     clampDim(c.defaultWeight)
    };
  }).filter(Boolean);

  // Ensure built-in "Miscellaneous" exists. If the author tried to
  // delete it in raw JSON, add it back. If multiple exist (shouldn't
  // happen but defensive), keep the first.
  const miscExists = out.categories.find(c => c.id === 'cat_misc');
  if (!miscExists) {
    out.categories.push({
      id: 'cat_misc',
      name: 'Miscellaneous',
      description: 'Uncategorized items end up here.',
      parentId: null,
      builtIn: true,
      defaultDimensions: { l: 0, w: 0, h: 0 },
      defaultWeight: 0
    });
  } else {
    miscExists.builtIn = true;
  }

  // Validate parent links: a parentId pointing at a non-existent
  // category becomes null (orphan → top-level). A parentId pointing at
  // ITSELF also becomes null (would cause infinite render loops).
  // We don't try to detect longer cycles here — the editor should
  // prevent them at input time; if they somehow slip through, the
  // tree renderer guards against revisiting nodes.
  const catIds = new Set(out.categories.map(c => c.id));
  out.categories.forEach(c => {
    if (c.parentId && (c.parentId === c.id || !catIds.has(c.parentId))) {
      c.parentId = null;
    }
  });

  // ── WEAPONS ──
  // Ruleset-level roll formulas. A missing `weapons` object, or any
  // individual missing formula, falls back to Standard Set defaults.
  // Missing/blank formulas at runtime would be a silent roll bug, so
  // we always resolve each one to a non-empty string.
  if (!out.weapons || typeof out.weapons !== 'object') out.weapons = {};
  const defFormulas = d.weapons || {
    meleeAttackFormula:  'DEX + Melee + DEXMOD',
    meleeDamageFormula:  'STR + DMG + ATK + STRMOD',
    rangedAttackFormula: 'DEX + Ranged + DEXMOD',
    rangedDamageFormula: 'DEX + DMG + ATK + DMGMOD'
  };
  ['meleeAttackFormula','meleeDamageFormula','rangedAttackFormula','rangedDamageFormula'].forEach(f => {
    if (typeof out.weapons[f] !== 'string' || !out.weapons[f].trim()) {
      out.weapons[f] = defFormulas[f];
    }
  });

  // Tag categories — nested tree (same shape as item `categories`).
  // Each category is {id, name, parentId|null, builtIn?}. Seed with
  // the built-in "Uncategorized" if missing so the fallback home for
  // orphaned tags always exists. Invalid entries (no id or no name)
  // are dropped. Cycles (a category's parent pointing back to itself
  // or a descendant) are broken by nulling the offending parentId.
  if (!Array.isArray(out.tagCategories)) out.tagCategories = [];
  const tcatSeen = new Set();
  out.tagCategories = out.tagCategories.map(c => {
    if (!c || typeof c !== 'object') return null;
    const name = (typeof c.name === 'string') ? c.name.trim() : '';
    if (!name) return null;
    let id = (typeof c.id === 'string' && c.id) ? c.id : nextSynthId('tcat');
    while (tcatSeen.has(id)) id = nextSynthId('tcat');
    tcatSeen.add(id);
    return {
      id,
      name,
      parentId: (typeof c.parentId === 'string' && c.parentId) ? c.parentId : null,
      builtIn: !!c.builtIn
    };
  }).filter(Boolean);
  // Seed the built-in Uncategorized if absent.
  if (!out.tagCategories.some(c => c.id === 'tcat_uncategorized')) {
    out.tagCategories.unshift({
      id: 'tcat_uncategorized',
      name: 'Uncategorized',
      parentId: null,
      builtIn: true
    });
  }
  // Break parent cycles + repair orphaned parentIds.
  const tcatIds = new Set(out.tagCategories.map(c => c.id));
  out.tagCategories.forEach(c => {
    if (c.parentId && !tcatIds.has(c.parentId)) c.parentId = null;
  });
  const tcatHasCycle = (cid, visited) => {
    if (!cid) return false;
    if (visited.has(cid)) return true;
    visited.add(cid);
    const c = out.tagCategories.find(x => x.id === cid);
    return c ? tcatHasCycle(c.parentId, visited) : false;
  };
  out.tagCategories.forEach(c => {
    if (c.parentId && tcatHasCycle(c.parentId, new Set([c.id]))) {
      c.parentId = null;
    }
  });

  // Weapon tags — shared tag catalogue used across all weapons in this
  // ruleset. Each tag is {id, name, description, categoryId?, params?}.
  // Tags without a usable name are dropped. Missing descriptions become
  // empty strings. IDs autogenerate with the `t_` prefix if absent (or
  // invalid). A missing or orphaned categoryId is repaired to point at
  // the built-in Uncategorized so the display layer always has a bucket.
  if (!Array.isArray(out.weaponTags)) out.weaponTags = [];
  const tagSeen = new Set();
  out.weaponTags = out.weaponTags.map(t => {
    if (!t || typeof t !== 'object') return null;
    const name = (typeof t.name === 'string') ? t.name.trim() : '';
    if (!name) return null;
    let id = (typeof t.id === 'string' && t.id) ? t.id : nextSynthId('t');
    // Avoid duplicate ids — if two tags share, the later one gets a new id.
    while (tagSeen.has(id)) id = nextSynthId('t');
    tagSeen.add(id);
    // Preserve structured params if present. Each param is
    // {key, type, label, default, min?, max?}. Invalid entries drop.
    let params = null;
    if (Array.isArray(t.params) && t.params.length > 0) {
      const clean = t.params.map(p => {
        if (!p || typeof p !== 'object') return null;
        const key = (typeof p.key === 'string' && p.key.trim()) ? p.key.trim() : '';
        const type = (typeof p.type === 'string' && p.type.trim()) ? p.type.trim() : 'number';
        if (!key) return null;
        const entry = {
          key, type,
          label: (typeof p.label === 'string' && p.label) ? p.label : key,
          default: (typeof p.default === 'number' || typeof p.default === 'string' || typeof p.default === 'boolean')
            ? p.default : null
        };
        if (Number.isFinite(Number(p.min))) entry.min = Number(p.min);
        if (Number.isFinite(Number(p.max))) entry.max = Number(p.max);
        return entry;
      }).filter(Boolean);
      if (clean.length > 0) params = clean;
    }
    // Resolve categoryId — use the provided value if it references an
    // existing category; otherwise drop it into Uncategorized.
    let categoryId = 'tcat_uncategorized';
    if (typeof t.categoryId === 'string' && t.categoryId && tcatIds.has(t.categoryId)) {
      categoryId = t.categoryId;
    }
    const tag = {
      id,
      name,
      description: (typeof t.description === 'string') ? t.description : '',
      categoryId
    };
    if (params) tag.params = params;
    return tag;
  }).filter(Boolean);

  // Auto-merge the Standard Set's mechanically-active tags if the
  // ruleset is missing them. Match on case-insensitive name: if a
  // user-authored tag happens to be named "Shotgun" already, we
  // leave it alone (their description wins). Only absent tags get
  // injected. This keeps older rulesets working with the new
  // tag-driven mechanics without overwriting custom descriptions.
  const haveTagNames = new Set(out.weaponTags.map(t => (t.name || '').toLowerCase()));
  (d.weaponTags || []).forEach(stdTag => {
    if (!haveTagNames.has((stdTag.name || '').toLowerCase())) {
      const injected = {
        id:          stdTag.id,
        name:        stdTag.name,
        description: stdTag.description || '',
        categoryId:  'tcat_uncategorized'
      };
      if (Array.isArray(stdTag.params)) {
        injected.params = stdTag.params.map(p => Object.assign({}, p));
      }
      out.weaponTags.push(injected);
    }
  });

  // Dimension presets — named L×W×H (+ weight) shapes that the UI
  // exposes as a quick-pick dropdown on item dimension inputs. Each
  // preset is {id, name, dimensions:{l,w,h}, weight, builtIn?}.
  // Built-ins from RULESET_DEFAULTS are auto-merged into any ruleset
  // missing them, same pattern as Standard Set tags. Author-edited
  // built-ins keep the author's values (name match is case-insensitive).
  if (!Array.isArray(out.dimensionPresets)) out.dimensionPresets = [];
  const dpSeen = new Set();
  out.dimensionPresets = out.dimensionPresets.map(p => {
    if (!p || typeof p !== 'object') return null;
    const name = (typeof p.name === 'string') ? p.name.trim() : '';
    if (!name) return null;
    let id = (typeof p.id === 'string' && p.id) ? p.id : nextSynthId('dp');
    while (dpSeen.has(id)) id = nextSynthId('dp');
    dpSeen.add(id);
    const dims = p.dimensions || {};
    const dim = v => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    return {
      id,
      name,
      dimensions: { l: dim(dims.l), w: dim(dims.w), h: dim(dims.h) },
      weight:     dim(p.weight),
      builtIn:    p.builtIn === true
    };
  }).filter(Boolean);
  // Auto-merge built-ins from defaults if the ruleset is missing them.
  // Match on case-insensitive name. Author's values (if they already
  // defined "Pistol" with different dimensions) win — we don't overwrite.
  const havePresetNames = new Set(out.dimensionPresets.map(p => (p.name || '').toLowerCase()));
  (d.dimensionPresets || []).forEach(std => {
    if (!havePresetNames.has((std.name || '').toLowerCase())) {
      out.dimensionPresets.push({
        id:         std.id,
        name:       std.name,
        dimensions: Object.assign({}, std.dimensions),
        weight:     std.weight || 0,
        builtIn:    true
      });
    }
  });

  return out;
};
