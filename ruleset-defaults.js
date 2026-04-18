// ruleset-defaults.js
// Default values for the Basic Set, and the schema any ruleset should conform to.
// Included as a non-module script so edit-ruleset.html can use it directly.

window.RULESET_DEFAULTS = {
  startingXp: 100,

  // Stat caps / costs. The last index is the max purchasable base value.
  // A stat at level 0 means "not takable", level 2 is free, etc.
  // statXp[n] = XP cost to start a character at that level.
  statXp: [null, -10, 0, 10, 30, 60, 100],  // index 0 = not takable
  statMaxPurchasable: 6,                     // max level a player can START at
  statMax: 20,                               // absolute ceiling a stat can reach

  // List of stats (code + name + description).
  // Code is used internally (e.g. on character sheet), name is the full word.
  stats: [
    { code:'STR',  name:'Strength',     description:'Physical power, raw force.' },
    { code:'DEX',  name:'Dexterity',    description:'Fine motor control, reflexes, agility.' },
    { code:'PER',  name:'Perception',   description:'Awareness of surroundings, sensory acuity.' },
    { code:'INT',  name:'Intellect',    description:'Reasoning, memory, learning capacity.' },
    { code:'CHA',  name:'Charisma',     description:'Social presence, force of personality.' },
    { code:'POW',  name:'Power',        description:'Willpower, mental fortitude, resolve.' },
    { code:'SIZE', name:'Size',         description:'Physical mass and stature.' }
  ],

  // STATMOD per level (index = level, 0..statMax).
  // Default: 0-1 = -1, 2-3 = 0, 4-5 = +1, ... (step +1 every 2 levels)
  statMods: [-1,-1,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,9,10],

  // Stat flavor labels (index = level, 0..statMax).
  statLabels: [
    'Far Below Average','Below Average','Average','Above Average','Gifted','Exceptional','Peak Human',
    'Superhuman','Extraordinary','Legendary','Heroic','Titanic','Mythic','Godly','Divine',
    'Transcendent','Ascendant','Empyrean','Omnipotent','Absolute','Cosmic'
  ],

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
  if (out.startingXp == null) out.startingXp = d.startingXp;
  if (!Array.isArray(out.statXp)) out.statXp = d.statXp.slice();
  if (out.statMaxPurchasable == null) out.statMaxPurchasable = d.statMaxPurchasable;
  if (out.statMax == null) out.statMax = d.statMax;
  if (out.statMax < out.statMaxPurchasable) out.statMax = out.statMaxPurchasable;
  if (!Array.isArray(out.stats) || out.stats.length === 0) out.stats = JSON.parse(JSON.stringify(d.stats));
  if (!Array.isArray(out.statMods) || out.statMods.length === 0) out.statMods = d.statMods.slice();
  if (!Array.isArray(out.statLabels) || out.statLabels.length === 0) out.statLabels = d.statLabels.slice();
  // Resize statMods and statLabels to length statMax+1 if needed
  while (out.statMods.length < out.statMax + 1) out.statMods.push(out.statMods[out.statMods.length-1] ?? 0);
  while (out.statLabels.length < out.statMax + 1) out.statLabels.push('Level ' + out.statLabels.length);
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
