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
  // Level 0 is "not takable"; real tiers start at 1.
  size: {
    default: 6,  // default starting tier for new characters (index into tiers)
    tiers: [
      { level: 1,  label: 'Nano',        xpCost: 0 },
      { level: 2,  label: 'Micro',       xpCost: 0 },
      { level: 3,  label: 'Tiny',        xpCost: 0 },
      { level: 4,  label: 'Small',       xpCost: 0 },
      { level: 5,  label: 'Below Average', xpCost: 0 },
      { level: 6,  label: 'Medium',      xpCost: 0 },
      { level: 7,  label: 'Above Average', xpCost: 0 },
      { level: 8,  label: 'Large',       xpCost: 0 },
      { level: 9,  label: 'Very Large',  xpCost: 0 },
      { level: 10, label: 'Huge',        xpCost: 0 },
      { level: 12, label: 'Massive',     xpCost: 0 },
      { level: 16, label: 'Giant',       xpCost: 0 },
      { level: 20, label: 'Colossal',    xpCost: 0 },
      { level: 24, label: 'Behemoth',    xpCost: 0 },
      { level: 30, label: 'Cataclysmic', xpCost: 0 }
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
  morals: []
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
  return out;
};
