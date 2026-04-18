// char-constants.js
// All hardcoded game data for the character sheet.
// These are placeholder defaults — once the ruleset-wiring phase lands,
// most of these will be replaced by lookups against the character's
// active ruleset. Keeping them here gives us one tidy place to track
// what needs to become ruleset-driven.

// ── SEVERITY TABLES ──
// Used by Mental Conditions, Morals, and Moral Obligations.
// Each entry has a `value` (stored key) and a `label` (shown to the user).

export const SEVERITY_OPTIONS = [
  'Minor','Moderate','Major','Massive','Monumental','Mega','Mythical'
];

export const MORAL_SEVERITY = [
  { value: 'Minor',      label: 'Minor (−2 Difficulty / 1pt)' },
  { value: 'Moderate',   label: 'Moderate (−1 Difficulty / 2pt)' },
  { value: 'Major',      label: 'Major (+0 Difficulty / 3pt)' },
  { value: 'Massive',    label: 'Massive (+1 Difficulty / 4pt)' },
  { value: 'Monumental', label: 'Monumental (+2 Difficulty / 5pt)' },
  { value: 'Mega',       label: 'Mega (+3 Difficulty / 6pt)' },
  { value: 'Mythical',   label: 'Mythical (+4 Difficulty / 7pt)' }
];

export const CONDITION_SEVERITY = [
  { value: 'Minor',      label: 'Minor Condition (−1 Difficulty / 1 Break Point)' },
  { value: 'Moderate',   label: 'Moderate Condition (+0 Difficulty / 2 Break Points)' },
  { value: 'Major',      label: 'Major Condition (+1 Difficulty / 3 Break Points)' },
  { value: 'Massive',    label: 'Massive Condition (+2 Difficulty / 4 Break Points)' },
  { value: 'Monumental', label: 'Monumental Condition (+3 Difficulty / 5 Break Points)' },
  { value: 'Mega',       label: 'Mega Condition (+4 Difficulty / 6 Break Points)' },
  { value: 'Mythical',   label: 'Mythical Condition (+5 Difficulty / 7 Break Points)' }
];

export const OBLIGATION_SEVERITY = [
  { value: 'Minor',      label: 'Minor Obligation (1 Break Point)' },
  { value: 'Moderate',   label: 'Moderate Obligation (2 Break Points)' },
  { value: 'Major',      label: 'Major Obligation (3 Break Points)' },
  { value: 'Massive',    label: 'Massive Obligation (4 Break Points)' },
  { value: 'Monumental', label: 'Monumental Obligation (5 Break Points)' },
  { value: 'Mega',       label: 'Mega Obligation (6 Break Points)' },
  { value: 'Mythical',   label: 'Mythical Obligation (7 Break Points)' }
];

// ── POWER LEVELS ──
// Each level has a stored value, a display label, and the XP cost
// required to purchase one point of AP.

export const POWER_LEVELS = [
  { value: 'powerless', label: 'Powerless',       xpPerAp: 10 },
  { value: 'low',       label: 'Low Power',       xpPerAp: 8  },
  { value: 'mid',       label: 'Mid Power',       xpPerAp: 6  },
  { value: 'high',      label: 'High Power',      xpPerAp: 4  },
  { value: 'very_high', label: 'Very High Power', xpPerAp: 2  },
  { value: 'highest',   label: 'Highest Power',   xpPerAp: 1  }
];

// ── STATS ──
// The full list of stats a character has, in display order.
// Each stat has a short key (used internally), an abbreviation (shown in UI),
// the rest of the word that follows the abbreviation, and a default value.

export const STAT_DEFS = [
  { key: 'str',  abbr: 'STR',  rest: 'ength',   default: 2 },
  { key: 'dex',  abbr: 'DEX',  rest: 'terity',  default: 2 },
  { key: 'per',  abbr: 'PER',  rest: 'ception', default: 2 },
  { key: 'cha',  abbr: 'CHA',  rest: 'risma',   default: 2 },
  { key: 'int',  abbr: 'INT',  rest: 'ellect',  default: 2 },
  { key: 'pow',  abbr: 'POW',  rest: 'er',      default: 2 },
  { key: 'size', abbr: 'SIZE', rest: '',        default: 6 }
];

export const STAT_DESCRIPTIONS = {
  str:  'Your physical strength, endurance, and constitution.',
  dex:  'Your physical speed, flexibility, and finesse.',
  per:  'Your physical sharpness of your senses.',
  cha:  'Your social aptitude and acuity.',
  int:  'Your logical aptitude and acuity.',
  pow:  'Your supernatural aptitude in your paradigm and its powers.',
  size: 'Your size.'
};

// Flavor labels for stat values 0–20.
export const STAT_LABELS = [
  'Far Below Average','Below Average','Average','Above Average',
  'Impressive','Exceptional','Peak Human',
  'Lesser Superhuman','Superhuman','Greater Superhuman','Peak Superhuman',
  'Beyond Superhuman',
  'Lesser Legendary','Legendary','Greater Legendary',
  'Semi-Divine','Lesser Divine','Divine','Greater Divine','Beyond Divine',
  'Cosmic'
];

// SIZE uses a tier-style scale instead of a linear label array.
export const SIZE_OPTIONS = [
  { value: 1,  label: '1 — Nano' },
  { value: 2,  label: '2 — Micro' },
  { value: 3,  label: '3 — Tiny' },
  { value: 4,  label: '4 — Small' },
  { value: 6,  label: '6 — Medium' },
  { value: 8,  label: '8 — Large' },
  { value: 10, label: '10 — Huge' },
  { value: 12, label: '12 — Massive' },
  { value: 16, label: '16 — Giant' },
  { value: 20, label: '20 — Colossal' },
  { value: 24, label: '24 — Behemoth' },
  { value: 30, label: '30 — Cataclysmic' }
];

// ── SKILLS ──
// Skill level labels (0–10).
export const SKILL_LABELS = [
  'No Exposure','Minor Exposure','Exposure','Basic Training','Training',
  'Major Training','Expertise','Major Expertise','Near-Mastery','Mastery',
  'True Mastery'
];

// Fallback list of primary skills if no ruleset is available.
export const FALLBACK_SKILLS = [
  { name: 'Academics',     description: 'Learned subjects such as History or Political Science.' },
  { name: 'Athletics',     description: 'Physical activities like running, swimming, jumping, climbing, etc.' },
  { name: 'Awareness',     description: "To be aware of one's surroundings utilizing one's senses." },
  { name: 'Crafts',        description: 'A particular trade, tool, art, or practice.' },
  { name: 'Drive',         description: 'Operating vehicles.' },
  { name: 'Investigation', description: 'Uncovering, understanding, reasoning, and making deductions with information.' },
  { name: 'Medical',       description: 'Skill in medical treatment, and knowledge of the medical sciences.' },
  { name: 'Melee',         description: 'Melee combat, and melee weaponry.' },
  { name: 'Occult',        description: 'The esoteric; be it rituals, the supernatural, mythology, and so-on so-forth.' },
  { name: 'Ranged',        description: 'Ranged combat, and ranged weaponry.' },
  { name: 'Science',       description: 'Knowledge of the sciences.' },
  { name: 'Social',        description: 'Sociability, communication skills, people skills, etc.' },
  { name: 'Society',       description: 'Knowledge of society, institutions, laws, etiquette, etc.' },
  { name: 'Stealth',       description: 'Being stealthy, hiding, sneaking.' },
  { name: 'Survival',      description: 'Wilderness skills, foraging, identifying animal footprints, natural knowledge and skills.' },
  { name: 'Technology',    description: 'Knowledge, and operation, of technology.' }
];

// ── XP COSTS ──
// These tables will be replaced by ruleset values once wiring lands.

export const STAT_XP  = { 1: -10, 2: 0, 3: 10, 4: 30, 5: 60, 6: 100 };
export const PRIM_XP  = [0, 2, 4,  8, 14, 22, 30, 40, 52, 66, 80];
export const SEC_XP   = [0, 1, 2,  4,  7, 11, 15, 20, 26, 33, 40];
export const SPEC_XP  = [0, 1, 1,  2,  3,  5,  7, 10, 13, 16, 20];

// ── STAT ICONS ──
// SVG path data for each stat's icon. Displayed via char-util's statIcon() helper.

export const STAT_ICONS = {
  str:`M257.375 20.313c-13.418 0-26.07 7.685-35.938 21.75-9.868 14.064-16.343 34.268-16.343 56.75 0 22.48 6.475 42.654 16.344 56.718 9.868 14.066 22.52 21.75 35.937 21.75 13.418 0 26.038-7.684 35.906-21.75 9.87-14.063 16.376-34.236 16.376-56.718 0-22.48-6.506-42.685-16.375-56.75-9.867-14.064-22.487-21.75-35.905-21.75zm-150.25 43.062c-20.305.574-23.996 13.892-31.78 29.03-23.298 45.304-55.564 164.75-55.564 164.75l160.47-5.436 29.125 137.593-22.78 106.03h149.093l-22.282-106 24.25-137.5 157.53 5.313c.002 0-32.264-119.447-55.56-164.75-7.787-15.14-11.477-28.457-31.782-29.03-17.898 0-32.406 15.552-32.406 34.718 0 19.166 14.508 34.72 32.406 34.72 3.728 0 7.258-.884 10.594-2.126l7.937 74.406L309.437 165c-.285.42-.552.867-.843 1.28-12.436 17.724-30.604 29.69-51.22 29.69-20.614 0-38.782-11.966-51.218-29.69-.277-.395-.54-.816-.812-1.218l-116.75 40.032 7.937-74.406c3.337 1.242 6.867 2.125 10.595 2.125 17.898 0 32.406-15.553 32.406-34.72 0-19.165-14.507-34.718-32.405-34.718z`,
  dex:`M372.97 24.938c-8.67.168-17.816 3.644-26.69 10.28-12.618 9.44-24.074 25.203-30.5 44.844-6.424 19.642-6.48 39.12-1.874 54.157 4.608 15.036 13.375 25.225 24.97 29 11.593 3.772 24.724.72 37.343-8.72 12.618-9.44 24.074-25.234 30.5-44.875 6.424-19.642 6.512-39.12 1.905-54.156-4.607-15.038-13.404-25.196-25-28.97a32.051 32.051 0 0 0-8.938-1.563c-.573-.018-1.14-.01-1.718 0zm-155.69 69.78c-21.696.024-43.394 2.203-65.093 7.094-24.91 29.824-43.848 60.255-52.875 98.47l37.376 17.812c8.273-30.735 21.485-53.817 43.375-77 22.706-7.844 45.418-6.237 68.125 1.5-74.24 65.137-51.17 120.676-80.344 226.47-42.653 17.867-85.098 20.53-123.25-.002L23 415.625c59.418 27.09 125.736 29.818 190.844 0 20.368-43.443 27.214-88.603 25-132.906C295.31 354.663 323.11 398.2 338.78 498.56h57.94c-3.12-14.706-6.21-28.394-9.345-41.218-22.522-92.133-47.263-139.63-100.22-198.406 9.695-36.13 22.143-59.665 52.44-74.282 11.167 19.767 29.982 36.682 51.092 48.906l97.375 1.563.47-41.03L402 191.968c-8.05-5.556-14.925-11.73-20.75-18.314-14.886 9.08-32.024 12.563-48.156 7.313-18.422-5.997-31.143-21.962-37.063-41.282-3.482-11.37-4.742-24.05-3.686-37.25-25.017-4.884-50.047-7.746-75.063-7.72z`,
  per:`M121.406 18.313c-57.98 16.562-98.06 51.613-98.062 92.28-.003 40.518 39.805 75.616 97.437 92.25-33.653-22.005-55.22-55.224-55.218-92.25 0-37.237 21.85-70.277 55.844-92.28zm276.531 0c33.995 22.003 55.844 55.043 55.844 92.28.004 37.026-21.563 70.245-55.217 92.25 57.632-16.634 97.44-51.732 97.437-92.25-.003-40.667-40.082-75.718-98.063-92.28zM163.28 41.656c-43.303 12.368-73.215 38.565-73.218 68.938-.002 30.26 29.707 56.482 72.75 68.906-25.135-16.434-41.25-41.255-41.25-68.906 0-27.813 16.328-52.503 41.72-68.938zm192.782 0c25.39 16.435 41.72 41.125 41.72 68.938 0 27.65-16.115 52.472-41.25 68.906 43.043-12.424 72.752-38.645 72.75-68.906-.004-30.373-29.915-56.57-73.22-68.938zm-101.03 6.813c-23.457 3.027-44.22 30.026-44.22 64.655 0 19.094 6.635 36.007 16.438 47.75l10.22 12.25-15.69 2.938c-12.834 2.4-22.282 9.19-30.25 20.062-7.965 10.872-14 25.903-18.218 43.156-7.727 31.62-9.362 70.17-9.593 103.94h41.655l.625 8.655 10.625 141.375h90.344l9.374-141.313.594-8.718h39.625c-.017-34.152-.373-73.232-7.375-105.095-3.818-17.37-9.612-32.392-17.688-43.156-8.076-10.765-17.99-17.51-32.344-19.72l-16-2.47 10.125-12.624c9.38-11.682 15.69-28.4 15.69-47.03 0-36.92-23.274-64.564-49.095-64.564-2.8 0-4.505-.137-4.844-.093zm-51.438 12.155c-31.38 8.964-53.063 27.96-53.063 49.97 0 21.927 21.53 40.935 52.72 49.936-18.212-11.908-29.875-29.898-29.875-49.936.003-20.153 11.82-38.06 30.22-49.97zm112.156 0c18.398 11.91 30.216 29.816 30.22 49.97 0 20.037-11.664 38.027-29.876 49.936 31.19-9 52.72-28.008 52.72-49.936-.002-22.01-21.686-41.005-53.064-49.97z`,
  cha:`M165.262 25.154c-38.376 0-73.092 6.462-97.408 16.405-12.159 4.97-21.669 10.834-27.706 16.67-6.036 5.835-8.459 11.144-8.459 16.218 0 5.075 2.423 10.384 8.46 16.219 6.036 5.835 15.546 11.699 27.705 16.67 24.316 9.942 59.032 16.404 97.408 16.404.162 0 .32-.006.482-.006l-38.95 108.504 88.065-112.265c18.283-2.87 34.592-7.232 47.81-12.637 12.16-4.971 21.671-10.835 27.708-16.67 6.037-5.836 8.459-11.144 8.459-16.219 0-5.074-2.422-10.383-8.46-16.219-6.036-5.835-15.548-11.698-27.706-16.67-24.316-9.942-59.032-16.404-97.408-16.404zm183.797 94.815c-38.377 0-73.092 6.462-97.409 16.404-12.158 4.971-21.668 10.835-27.705 16.67-6.036 5.835-8.459 11.144-8.459 16.219 0 5.074 2.423 10.385 8.46 16.22 6.036 5.836 15.546 11.697 27.704 16.668a161.904 161.904 0 0 0 9.819 3.631l82.965 105.764-34.2-95.274c12.3 1.47 25.327 2.284 38.825 2.284 38.376 0 73.091-6.462 97.408-16.405 12.158-4.97 21.67-10.832 27.707-16.668 6.036-5.835 8.459-11.146 8.459-16.22 0-5.075-2.423-10.384-8.46-16.219-6.036-5.835-15.548-11.699-27.706-16.67-24.317-9.942-59.032-16.404-97.408-16.404zM96 249c-25.37 0-47 23.91-47 55s21.63 55 47 55 47-23.91 47-55-21.63-55-47-55zm320 0c-25.37 0-47 23.91-47 55s21.63 55 47 55 47-23.91 47-55-21.63-55-47-55zM58.166 363.348c-7.084 8.321-13.03 19.258-17.738 31.812-10.33 27.544-14.433 62.236-15.131 91.84h141.406c-.698-29.604-4.802-64.296-15.13-91.84-4.709-12.554-10.655-23.49-17.739-31.812C123.246 371.9 110.235 377 96 377c-14.235 0-27.246-5.1-37.834-13.652zm320 0c-7.084 8.321-13.03 19.258-17.738 31.812-10.33 27.544-14.433 62.236-15.131 91.84h141.406c-.698-29.604-4.802-64.296-15.13-91.84-4.709-12.554-10.655-23.49-17.739-31.812C443.246 371.9 430.235 377 416 377c-14.235 0-27.246-5.1-37.834-13.652z`,
  int:`M241.063 54.406a293.615 293.615 0 0 0-12.313.282c-8.814 1.567-12.884 5.426-15.094 9.843-2.435 4.87-2.34 11.423.375 17.25 2.717 5.83 7.7 10.596 14.657 12.376 6.958 1.78 16.536.86 29.125-7.187l10.063 15.75c-15.818 10.11-31.124 12.777-43.813 9.53-12.688-3.247-22.103-12.123-26.968-22.563-4.584-9.836-5.426-21.376-1.03-31.624-42.917 6.94-81.777 23.398-111.626 46.562-9.81 10.688-10.77 23.11-6.47 31.594 4.83 9.526 16.21 16.48 38.97 9.28l5.656 17.813c-28.58 9.04-52.137-.588-61.28-18.625-2.23-4.397-3.592-9.156-4.127-14.063-4.814 5.712-9.16 11.658-13 17.844l.126.06c-8.614 19.616-8.81 33.203-5.376 42.032 3.436 8.83 10.635 14.44 21.72 17.532 22.168 6.18 58.065-1.277 83.343-20.156 10.82-8.08 21.077-27.677 21.97-42.875.445-7.6-1.165-13.604-4.345-17.438-3.18-3.834-8.272-6.703-18.813-6.594l-.187-18.686c14.487-.15 26.25 4.754 33.375 13.344 7.124 8.59 9.26 19.652 8.625 30.468-1.27 21.633-12.595 44.172-29.438 56.75-29.876 22.314-69.336 31.606-99.53 23.188-13.988-3.9-26.37-12.386-32.75-25.53-9.546 45.446 4.323 87.66 30.718 116.874 3.45 3.82 7.122 7.43 10.97 10.78-2.754-7.887-4.016-16.1-3.72-24.093.53-14.325 6.082-28.346 17.22-38.03 9.134-7.946 21.752-12.53 36.843-12.5 1.006 0 2.034.018 3.062.06 2.35.1 4.763.304 7.22.626l-2.44 18.532c-15.588-2.048-25.705 1.522-32.436 7.375-6.73 5.854-10.443 14.614-10.813 24.625-.74 20.024 12.07 43.406 39.69 50.188l-.032.188c27.192 5.19 57.536.372 88-18.22.018-.012.043-.017.062-.03 6.34-4.45 9.755-8.808 11.438-12.563 1.985-4.432 1.943-8.292.53-12.438-2.824-8.29-12.94-16.812-22.218-19.187-15.002-3.84-24.532 1.436-29 7.72-4.468 6.28-4.74 12.45 2.156 17.81l-11.47 14.75c-14.187-11.033-15.092-30.487-5.905-43.405 6.892-9.688 18.985-16.326 33.564-16.75a46.963 46.963 0 0 1 1.844-.03c4.306.03 8.79.622 13.437 1.81 15.505 3.97 29.84 15.277 35.28 31.25a36.189 36.189 0 0 1 1.876 13.314c16.71-8.538 34.332-16.12 52.282-21.814 30.156-13.78 43.23-37.938 42.72-58.28-.515-20.493-13.187-37.74-42.376-40.626l1.844-18.594c36.666 3.626 58.462 29.848 59.188 58.75.422 16.84-5.754 34.363-18.188 49.28 16.072-1.8 32.044-1.495 47.53 1.627-3.152-6.472-4.68-13.478-4.467-20.438.677-22.036 19.42-42.593 48.875-42.906a66.155 66.155 0 0 1 6.03.218l-1.5 18.625c-24.927-1.998-34.3 11.086-34.718 24.656-.412 13.42 8.545 28.442 34.22 30.436 28.3.25 48.588-15.098 58.53-37.906 13.31-30.536 6.997-76.317-34.844-118.188-.792-.793-1.578-1.593-2.375-2.375a40.42 40.42 0 0 1-2.842 10.844c-7.25 17.39-24.233 29.128-41.875 32.407-24.335 4.522-44.29-5.347-53.5-20.406-9.21-15.057-6.792-36.35 9.78-47.56l10.47 15.5c-8.913 6.028-9.28 14.19-4.313 22.31 4.967 8.122 16.17 15.156 34.156 11.814 11.306-2.102 23.896-11.33 28.03-21.25 2.07-4.96 2.47-9.862.408-15.47-1.675-4.555-5.187-9.764-11.72-15.25l-.187-.155c-27.316-20.587-56.338-35.393-85.75-45.157.018.032.045.06.063.093 6.684 12.22 7.18 26.082 3.063 38.344-8.233 24.525-34.07 43.848-66.032 42.78-6.948-.23-13.56 3.12-19.186 9.657-5.627 6.537-9.735 16.113-10.688 26.313-1.905 20.4 6.923 42.886 41.344 54L277 258.28c-41.083-13.264-56.83-45.546-54.22-73.5 1.307-13.975 6.706-26.962 15.157-36.78 8.452-9.818 20.475-16.603 33.97-16.156 24.04.802 42.323-14.084 47.687-30.063 2.682-7.988 2.335-15.937-1.75-23.405-3.968-7.252-11.83-14.423-25.906-19.656a292.57 292.57 0 0 0-50.875-4.314zM342.28 306.344c-41.915 3.41-87.366 23.4-125.28 46.562-55.98 34.198-114.89 26.733-156.688-4.28 16.444 58.844 74.712 70.788 135.5 55.905 6.083-2.285 12.06-6.538 17.157-12.03 7.057-7.607 12.17-17.47 13.78-25.625l18.344 3.625c-2.445 12.383-9.078 24.666-18.406 34.72-8.95 9.645-20.61 17.35-34.094 19.374-6.766 15.07-12.334 29.68-14.594 39.906-3.55 16.06 14.206 22.225 22.156 6.03 19.022-38.743 45.87-73.23 79.406-102.967 26.064-17.153 48.406-38.303 62.72-61.22z`,
  pow:`M256 38.013c-22.458 0-66.472 110.3-84.64 123.502-18.17 13.2-136.674 20.975-143.614 42.334-6.94 21.358 84.362 97.303 91.302 118.662 6.94 21.36-22.286 136.465-4.116 149.665 18.17 13.2 118.61-50.164 141.068-50.164 22.458 0 122.9 63.365 141.068 50.164 18.17-13.2-11.056-128.306-4.116-149.665 6.94-21.36 98.242-97.304 91.302-118.663-6.94-21.36-125.444-29.134-143.613-42.335-18.168-13.2-62.182-123.502-84.64-123.502z`,
  size:`M384 22.545 307.271 99.27l25.458 25.458L366 91.457v329.086l-33.271-33.272-25.458 25.458L384 489.455l76.729-76.726-25.458-25.458L402 420.543V91.457l33.271 33.272L460.73 99.27 384 22.545zm-242.443.258c-23.366 3.035-44.553 30.444-44.553 65.935 0 19.558 6.771 36.856 16.695 48.815l11.84 14.263-18.217 3.424c-12.9 2.425-22.358 9.24-30.443 20.336-8.085 11.097-14.266 26.558-18.598 44.375-7.843 32.28-9.568 71.693-9.842 106.436h42.868l11.771 157.836c29.894 6.748 61.811 6.51 90.602.025l10.414-157.861h40.816c-.027-35.168-.477-75.125-7.584-107.65-3.918-17.933-9.858-33.371-18.04-44.342-8.185-10.97-18.08-17.745-32.563-19.989l-18.592-2.88 11.736-14.704c9.495-11.897 15.932-28.997 15.932-48.082 0-37.838-23.655-65.844-49.399-65.844l-4.843-.093z`
};
