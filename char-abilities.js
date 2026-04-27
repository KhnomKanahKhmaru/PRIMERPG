// char-abilities.js
//
// Ability cost computation + Builder lookup utilities.
//
// This module is the single source of truth for the AP cost of an
// Ability. Both the Ruleset Editor (preview as designer tunes a Builder)
// and the Character Sheet (live cost on Player Ability cards) call into
// here so the math is identical across surfaces.
//
// LIVE REFERENCE MODEL: a Player Ability stores only a builderId plus
// their tuned paramValues + selectedFeatureIds + selectedFlawIds. At
// render time, we look up the live Builder from the active ruleset and
// compute cost against the current Builder definition. Ruleset edits
// propagate automatically. Orphaned ids (param value for a removed
// param, selected feature for a removed feature) are silently dropped
// from the cost calc — no errors, just graceful degradation.
//
// COST FORMULA (per the design doc):
//
//   flatPart   = builder.baseCost
//              + sum(primary param flat deltas)
//              + sum(feature costs)
//              − sum(flaw refunds)
//
//   percentMultiplier = product(secondary param step multipliers)
//
//   computedCost = max(1, floor(flatPart × percentMultiplier))
//
// The `max(1, ...)` enforces the "no Ability under 1 AP" floor. The
// floor() rounds down because partial AP can't be spent — a 4.7 AP
// Ability costs 4 AP, not 5.

// ─── BUILDER LOOKUP ───
//
// Walk the catalogue tree and return the Builder by id. Also returns
// the containing Category so callers that want to display "Offensive →
// Fire Bolt" have the path on hand. Returns null if not found OR if
// the ruleset has no catalogue / catalogue is disabled.
//
// The catalogue has a types-wrapper (Ability, Artifact, etc.) — we
// walk every type's categories, since BuilderIds are unique across
// types and callers don't know (or care) which type a Builder lives in.
// The returned object adds `typeKey` so UI that wants to show "Ability →
// Offensive → Fire Bolt" can.
//
// Backward-compat: an older shape with cat.categories at the top level
// is supported by the normalizer (migrates on read), but we also fall
// back to scanning cat.categories here so a not-yet-normalized payload
// doesn't break.
export function findBuilderById(ruleset, builderId) {
  if (!ruleset || !builderId) return null;
  const cat = ruleset.abilityCatalogue;
  if (!cat || cat.enabled === false) return null;

  // New shape: cat.types.{typeKey}.categories[].builders[]
  if (cat.types && typeof cat.types === 'object') {
    for (const typeKey of Object.keys(cat.types)) {
      const t = cat.types[typeKey];
      if (!t || !Array.isArray(t.categories)) continue;
      for (const category of t.categories) {
        if (!category || !Array.isArray(category.builders)) continue;
        const builder = category.builders.find(b => b && b.id === builderId);
        if (builder) {
          return { builder, category, catalogue: cat, typeKey, type: t };
        }
      }
    }
  }

  // Legacy shape fallback — pre-migration data
  if (Array.isArray(cat.categories)) {
    for (const category of cat.categories) {
      if (!category || !Array.isArray(category.builders)) continue;
      const builder = category.builders.find(b => b && b.id === builderId);
      if (builder) {
        return { builder, category, catalogue: cat, typeKey: 'ability', type: null };
      }
    }
  }

  return null;
}

// Convenience — list every builder in the catalogue, flattened, with
// category path attached. Useful for search UIs and the catalogue
// browser. Walks all types.
export function listAllBuilders(ruleset) {
  const out = [];
  if (!ruleset || !ruleset.abilityCatalogue) return out;
  const cat = ruleset.abilityCatalogue;
  if (cat.enabled === false) return out;

  // New shape
  if (cat.types && typeof cat.types === 'object') {
    Object.keys(cat.types).forEach(typeKey => {
      const t = cat.types[typeKey];
      if (!t || !Array.isArray(t.categories)) return;
      t.categories.forEach(category => {
        if (!category || !Array.isArray(category.builders)) return;
        category.builders.forEach(builder => {
          if (!builder) return;
          out.push({ builder, category, catalogue: cat, typeKey, type: t });
        });
      });
    });
    return out;
  }

  // Legacy shape fallback
  if (Array.isArray(cat.categories)) {
    cat.categories.forEach(category => {
      if (!category || !Array.isArray(category.builders)) return;
      category.builders.forEach(builder => {
        if (!builder) return;
        out.push({ builder, category, catalogue: cat, typeKey: 'ability', type: null });
      });
    });
  }
  return out;
}

// ─── COST COMPUTATION ───
//
// Compute the AP cost of an Ability instance against its Builder.
// Returns a structured result so callers can show breakdown UI ("Base
// 5 AP + 2 (damage) + 1 (range) − 0.5 (flaw) = 7.5 × 1.5 = 12 AP").
//
// Inputs:
//   builder   — Builder object from the ruleset catalogue
//   instance  — Ability instance from charData.abilities (the Player's
//               tuning: { paramValues, selectedFeatureIds, selectedFlawIds })
//   tiers     — abilityCatalogue.canonicalTiers (passed in so callers
//               can compute against draft tier tables in the editor
//               without committing them yet)
//
// Output:
//   {
//     computedCost,        — final AP cost (>= 1, floored)
//     baseCost,            — builder.baseCost
//     primaryDelta,        — sum of primary param flat deltas
//     featureCostTotal,    — sum of feature AP costs
//     flawRefundTotal,     — sum of flaw refunds (positive number)
//     flatPart,            — base + primaryDelta + featureCost − flawRefund
//     percentMultiplier,   — product of secondary param multipliers
//     breakdown: {         — per-line items for UI display
//       primary: [...],
//       secondary: [...],
//       features: [...],
//       flaws: [...]
//     },
//     warnings: [...]      — orphan ids, missing tier costs, etc.
//   }
export function computeAbilityCost(builder, instance, tiers) {
  const result = {
    computedCost: 1,
    baseCost: 0,
    primaryDelta: 0,
    featureCostTotal: 0,
    flawRefundTotal: 0,
    flatPart: 0,
    percentMultiplier: 1,
    breakdown: { primary: [], secondary: [], features: [], flaws: [] },
    warnings: []
  };

  if (!builder || typeof builder !== 'object') {
    result.warnings.push('No builder reference; defaulting to 1 AP.');
    return result;
  }

  // Defensive — instance might be null on a brand-new build, treat as
  // empty selections so we get the "default" cost preview.
  const inst = (instance && typeof instance === 'object') ? instance : {};
  const paramValues = (inst.paramValues && typeof inst.paramValues === 'object') ? inst.paramValues : {};
  const featureIds = Array.isArray(inst.selectedFeatureIds) ? inst.selectedFeatureIds : [];
  const flawIds    = Array.isArray(inst.selectedFlawIds)    ? inst.selectedFlawIds    : [];

  // Tiers default — if caller didn't pass, fall back to standard table.
  // This lets the editor preview without needing the catalogue context.
  const tiersResolved = (tiers && typeof tiers === 'object') ? tiers : DEFAULT_TIERS;
  const featureCosts  = (tiersResolved.featureCosts  && typeof tiersResolved.featureCosts  === 'object') ? tiersResolved.featureCosts  : DEFAULT_TIERS.featureCosts;
  const flawRefunds   = (tiersResolved.flawRefunds   && typeof tiersResolved.flawRefunds   === 'object') ? tiersResolved.flawRefunds   : DEFAULT_TIERS.flawRefunds;

  // Base
  result.baseCost = Number.isFinite(builder.baseCost) ? builder.baseCost : 0;

  // ─ Primary parameters ─
  // New shape (per Phase B redesign): primary params are a list of
  // explicit steps {label, value, cost}, where cost is FLAT AP added
  // when the player picks that step. The player's selection is stored
  // in paramValues[paramId] as the step INDEX. Falls back to defaultStep
  // (or 0) when no selection.
  //
  // This replaces the old defaultValue + (current - default) × deltaCost
  // model — the old model was implicit and made authoring multi-cost
  // step structures impossible.
  const primaryParams = Array.isArray(builder.primaryParams) ? builder.primaryParams : [];
  primaryParams.forEach(param => {
    // Linear mode: paramValues[id] is the player's chosen NUMERIC value
    // (not a step index). Cost = (value - defaultValue) × apPerStep.
    if (param.mode === 'linear') {
      const lc = (param.linearConfig && typeof param.linearConfig === 'object') ? param.linearConfig : {};
      const apPerStep    = Number.isFinite(lc.apPerStep)    ? lc.apPerStep    : 1;
      const defaultValue = Number.isFinite(lc.defaultValue) ? lc.defaultValue : 0;
      const selectedRaw  = paramValues[param.id];
      const value        = Number.isFinite(selectedRaw) ? selectedRaw : defaultValue;
      const cost = (value - defaultValue) * apPerStep;
      result.primaryDelta += cost;
      result.breakdown.primary.push({
        paramId: param.id,
        paramName: param.name || 'Parameter',
        mode: 'linear',
        defaultValue,
        selectedValue: value,
        cost
      });
      return;
    }
    // Manual (default) mode — paramValues[id] is the chosen step index.
    const steps = Array.isArray(param.steps) ? param.steps : [];
    const defaultIdx = Number.isFinite(param.defaultStep) ? param.defaultStep : 0;
    const selectedRaw = paramValues[param.id];
    const selectedIdx = Number.isFinite(selectedRaw) ? selectedRaw : defaultIdx;
    const step = (selectedIdx >= 0 && selectedIdx < steps.length) ? steps[selectedIdx] : null;
    const cost = (step && Number.isFinite(parseFloat(step.cost))) ? parseFloat(step.cost) : 0;
    result.primaryDelta += cost;
    result.breakdown.primary.push({
      paramId: param.id,
      paramName: param.name || 'Parameter',
      mode: 'manual',
      defaultStepIndex: defaultIdx,
      selectedStepIndex: selectedIdx,
      stepValue: step ? step.value : null,
      stepLabel: step ? step.label : '',
      cost
    });
  });

  // Warn about orphan paramValues — keys that don't match any current
  // primary or secondary param.
  const validParamIds = new Set([
    ...primaryParams.map(p => p && p.id).filter(Boolean),
    ...(Array.isArray(builder.secondaryParams) ? builder.secondaryParams : []).map(p => p && p.id).filter(Boolean)
  ]);
  Object.keys(paramValues).forEach(k => {
    if (!validParamIds.has(k)) {
      result.warnings.push(`Orphaned parameter value: ${k} no longer exists in the Builder.`);
    }
  });

  // ─ Secondary parameters ─
  // Same step-list shape as Primary; the difference is interpretation:
  // a step's `cost` for Secondary is treated as a MULTIPLIER on the
  // running total (1.0 = no change, 1.5 = +50%, 0.75 = -25%).
  // Multipliers compose multiplicatively across multiple secondaries.
  //
  // Backward compat: legacy secondary steps used `multiplier`; we read
  // either field (`cost` first, fall back to `multiplier`).
  const secondaryParams = Array.isArray(builder.secondaryParams) ? builder.secondaryParams : [];
  secondaryParams.forEach(param => {
    const steps = Array.isArray(param.steps) ? param.steps : [];
    const defaultIdx = Number.isFinite(param.defaultStep)
      ? param.defaultStep
      : (Number.isFinite(param.defaultStepIndex) ? param.defaultStepIndex : 0);
    const selectedRaw = paramValues[param.id];
    const selectedIdx = Number.isFinite(selectedRaw) ? selectedRaw : defaultIdx;
    const step = (selectedIdx >= 0 && selectedIdx < steps.length) ? steps[selectedIdx] : null;
    let multiplier = 1;
    if (step) {
      const raw = (step.cost !== undefined && step.cost !== null && step.cost !== '')
        ? parseFloat(step.cost)
        : parseFloat(step.multiplier);
      if (Number.isFinite(raw)) multiplier = raw;
    }
    if (step) {
      result.percentMultiplier *= multiplier;
    } else {
      const fallbackStep = (defaultIdx >= 0 && defaultIdx < steps.length) ? steps[defaultIdx] : null;
      if (fallbackStep) {
        const fbRaw = (fallbackStep.cost !== undefined && fallbackStep.cost !== null && fallbackStep.cost !== '')
          ? parseFloat(fallbackStep.cost)
          : parseFloat(fallbackStep.multiplier);
        if (Number.isFinite(fbRaw)) {
          result.percentMultiplier *= fbRaw;
          result.warnings.push(`Selected step for ${param.name || 'param'} is out of range; using default.`);
        }
      }
    }
    result.breakdown.secondary.push({
      paramId: param.id,
      paramName: param.name || 'Parameter',
      defaultStepIndex: defaultIdx,
      selectedStepIndex: selectedIdx,
      stepValue: step ? step.value : null,
      stepLabel: step ? step.label : '',
      multiplier
    });
  });

  // ─ Features ─
  // Selected features add their tier cost. Ids that don't match any
  // current feature on the Builder are silently dropped (graceful
  // degradation per live-reference spec).
  const builderFeatures = Array.isArray(builder.features) ? builder.features : [];
  const featureIndex = new Map(builderFeatures.filter(f => f && f.id).map(f => [f.id, f]));
  featureIds.forEach(fid => {
    const feature = featureIndex.get(fid);
    if (!feature) {
      result.warnings.push(`Selected feature ${fid} no longer exists in the Builder.`);
      return;
    }
    const tierCost = Number.isFinite(featureCosts[feature.tier]) ? featureCosts[feature.tier] : 0;
    if (!Number.isFinite(featureCosts[feature.tier])) {
      result.warnings.push(`Feature ${feature.name || fid} references unknown tier "${feature.tier}".`);
    }
    result.featureCostTotal += tierCost;
    result.breakdown.features.push({
      featureId: feature.id,
      featureName: feature.name || 'Feature',
      tier: feature.tier,
      cost: tierCost
    });
  });

  // ─ Flaws ─
  // Same shape as features but the values are refunds (subtracted).
  // Stored as positive numbers in flawRefunds; we negate when applying.
  const builderFlaws = Array.isArray(builder.flaws) ? builder.flaws : [];
  const flawIndex = new Map(builderFlaws.filter(f => f && f.id).map(f => [f.id, f]));
  flawIds.forEach(fid => {
    const flaw = flawIndex.get(fid);
    if (!flaw) {
      result.warnings.push(`Selected flaw ${fid} no longer exists in the Builder.`);
      return;
    }
    const refund = Number.isFinite(flawRefunds[flaw.tier]) ? flawRefunds[flaw.tier] : 0;
    if (!Number.isFinite(flawRefunds[flaw.tier])) {
      result.warnings.push(`Flaw ${flaw.name || fid} references unknown tier "${flaw.tier}".`);
    }
    result.flawRefundTotal += refund;
    result.breakdown.flaws.push({
      flawId: flaw.id,
      flawName: flaw.name || 'Flaw',
      tier: flaw.tier,
      refund
    });
  });

  // ─ Combine ─
  result.flatPart = result.baseCost + result.primaryDelta + result.featureCostTotal - result.flawRefundTotal;
  // Multiplier floored to prevent pathological negative or zero costs
  // from cascading negative percentile stacking. Per the design doc
  // commentary: floor at some minimum like 0.25× — but we already do
  // that PER STEP in the normalizer (clamp to >= 0.25), so the product
  // is bounded by the number of secondary params * 0.25^n. For typical
  // builds this is fine; we don't double-clamp here.
  const rawCost = result.flatPart * result.percentMultiplier;
  // Floor + minimum-of-1 enforces "no Ability under 1 AP" rule.
  result.computedCost = Math.max(1, Math.floor(rawCost));

  return result;
}

// Default tier table — used as fallback when caller doesn't pass tiers.
// Matches the canonical defaults in ruleset-defaults.js. Kept in sync
// manually; if the defaults change, update here too.
const DEFAULT_TIERS = {
  featureCosts: {
    minor: 1, moderate: 2, major: 3, massive: 4, monumental: 6, mega: 8, mythical: 10
  },
  flawRefunds: {
    minor: 0.5, moderate: 1, major: 1.5, massive: 2, monumental: 3, mega: 4, mythical: 5
  }
};

// ─── SYSTEM TEXT TEMPLATE ───
//
// Builder may have a systemTextTemplate string with {token} placeholders.
// Tokens are matched against primary param tokens (which display the
// current value) and secondary param tokens (which display the step
// label or value). Unknown tokens are left as-is so designers can
// spot template typos.
//
// Player override (instance.systemTextOverride) replaces the template
// output entirely if set.
// Resolve a STAT value from charData. Stats are stored lowercase-keyed
// on charData.stats (e.g. charData.stats.pow). Returns null if missing.
function resolveStatValueFromChar(charData, statCode) {
  if (!charData || !charData.stats || !statCode) return null;
  const v = charData.stats[String(statCode).toLowerCase()];
  return Number.isFinite(v) ? v : null;
}

// Resolve a SKILL value from charData. Skills live in three places:
//   charData.skills.primary    = { 'SkillName': value, ... }
//   charData.skills.secondary  = [{ name, value }, ...]
//   charData.skills.specialty  = [{ name, value }, ...]
// Returns null if the skill isn't found in any container.
function resolveSkillValueFromChar(charData, skillName) {
  if (!charData || !charData.skills || !skillName) return null;
  const sk = charData.skills;
  if (sk.primary && Number.isFinite(sk.primary[skillName])) return sk.primary[skillName];
  if (Array.isArray(sk.secondary)) {
    const m = sk.secondary.find(s => s && s.name === skillName);
    if (m && Number.isFinite(m.value)) return m.value;
  }
  if (Array.isArray(sk.specialty)) {
    const m = sk.specialty.find(s => s && s.name === skillName);
    if (m && Number.isFinite(m.value)) return m.value;
  }
  return null;
}

// Look up the STATMOD for a given stat value via the ruleset's
// statMods array (indexed by stat value, 0..statMax). Defensive against
// out-of-range values (clamped to the array bounds) and a missing or
// malformed ruleset (returns 0).
function lookupStatMod(ruleset, statValue) {
  const mods = (ruleset && Array.isArray(ruleset.statMods)) ? ruleset.statMods : [];
  if (!Number.isFinite(statValue) || mods.length === 0) return 0;
  const idx = Math.max(0, Math.min(mods.length - 1, statValue));
  const m = mods[idx];
  return Number.isFinite(m) ? m : 0;
}

// Compute the numerical activation-roll string (e.g. "(7D10)+1") from
// the player's sheet. Returns null when any slot can't be resolved
// (slot unpicked, stat/skill name missing from sheet, etc.) so the
// caller can fall back to the textual description.
//
// Pool = STAT1_value + STAT_OR_SKILL2_value  (number of d10s)
// Mod  = max of the two STATMODs (skills don't have statmods, so when
//        slot 2 is a skill, the mod is just slot 1's statmod)
function resolveActivationRollNumeric(builder, instance, context) {
  const ar = builder && builder.activationRoll;
  if (!ar || !ar.enabled || !context) return null;
  const charData = context.charData;
  const ruleset  = context.ruleset;
  if (!charData || !ruleset) return null;
  const choice = (instance && instance.activationRollChoice) || {};

  // Slot 1 — always a STAT. Either fixed or player-chosen.
  const slot1Code = (ar.slot1 && ar.slot1.mode === 'fixed-stat')
    ? ar.slot1.fixedStat
    : choice.slot1;
  if (!slot1Code) return null;
  const slot1Val = resolveStatValueFromChar(charData, slot1Code);
  if (slot1Val == null) return null;
  const slot1Mod = lookupStatMod(ruleset, slot1Val);

  // Slot 2 — STAT or SKILL. Determine which based on Builder mode and
  // (for player-pick modes) by checking whether the choice matches a
  // ruleset stat code. Skills don't contribute a statmod, so slot2Mod
  // stays null in that case.
  let slot2Val = null, slot2Mod = null;
  const s2 = ar.slot2 || {};
  if (s2.mode === 'fixed-stat') {
    slot2Val = resolveStatValueFromChar(charData, s2.fixedStat);
    if (slot2Val != null) slot2Mod = lookupStatMod(ruleset, slot2Val);
  } else if (s2.mode === 'fixed-skill') {
    slot2Val = resolveSkillValueFromChar(charData, s2.fixedSkill);
  } else if (choice.slot2) {
    // Player picked. Disambiguate STAT vs SKILL by checking whether the
    // choice matches one of the ruleset's stat codes.
    const stats = Array.isArray(ruleset.stats) ? ruleset.stats : [];
    const upper = String(choice.slot2).toUpperCase();
    const isStatPick = stats.some(s => s && s.code && s.code.toUpperCase() === upper);
    if (isStatPick) {
      slot2Val = resolveStatValueFromChar(charData, choice.slot2);
      if (slot2Val != null) slot2Mod = lookupStatMod(ruleset, slot2Val);
    } else {
      slot2Val = resolveSkillValueFromChar(charData, choice.slot2);
    }
  }
  if (slot2Val == null) return null;

  const pool = slot1Val + slot2Val;
  // Mod is the max of the two statmods. When slot 2 is a skill,
  // slot2Mod is null and we just use slot1Mod.
  const finalMod = (slot2Mod != null) ? Math.max(slot1Mod, slot2Mod) : slot1Mod;
  if (finalMod > 0) return `(${pool}D10)+${finalMod}`;
  if (finalMod < 0) return `(${pool}D10)${finalMod}`;  // negative renders as "-N" already
  return `(${pool}D10)`;
}

// Optional 3rd arg `context` carries `{charData, ruleset}` so the
// resolver can substitute live numerical values for the
// {ACTIVATION_ROLL} token. When absent, the token falls back to a
// textual description like "POW + DEX + STATMOD". Existing callers
// that don't pass context still work — the only difference is they
// see text instead of computed values.
export function renderSystemText(builder, instance, context) {
  if (instance && typeof instance.systemTextOverride === 'string' && instance.systemTextOverride.trim()) {
    return instance.systemTextOverride;
  }
  if (!builder || typeof builder.systemTextTemplate !== 'string' || !builder.systemTextTemplate) {
    return '';
  }
  const inst = (instance && typeof instance === 'object') ? instance : {};
  const paramValues = (inst.paramValues && typeof inst.paramValues === 'object') ? inst.paramValues : {};

  // Build token lookup: token-name → display string
  // Both Primary and Secondary now use step lists. The token resolves
  // to the picked step's label (preferred) or value, with no per-param
  // displayUnit suffix anymore — the label is authored verbatim by the
  // GM and meant to read as-is. (See normTokens below — built later;
  // we no longer need a separate case-sensitive `tokens` object.)
  const resolveStep = (p) => {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const defaultIdx = Number.isFinite(p.defaultStep)
      ? p.defaultStep
      : (Number.isFinite(p.defaultStepIndex) ? p.defaultStepIndex : 0);
    const selectedRaw = paramValues[p.id];
    const idx = Number.isFinite(selectedRaw) ? selectedRaw : defaultIdx;
    return (idx >= 0 && idx < steps.length) ? steps[idx] : null;
  };
  const stepDisplay = (step) => {
    if (!step) return null;
    if (step.label) return step.label;
    if (step.value !== undefined && step.value !== null && step.value !== '') return String(step.value);
    return null;
  };
  // Build a normalized token table. Both parameter tokens and the
  // built-in {ACTIVATION_ROLL} go in here. Normalization strips case
  // and non-alphanumeric chars so the GM can write {ACTIVATION_ROLL},
  // {activation_roll}, or {Activation Roll} interchangeably and they
  // all resolve to the same token. Same for parameter tokens — a
  // parameter with token "range" matches {Range}, {RANGE}, or {range}
  // in System text. Tokens that don't match anything are left as-is.
  const normTokens = {};
  function normalizeTokenKey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function setToken(name, val) {
    const k = normalizeTokenKey(name);
    if (k) normTokens[k] = val;
  }

  // Resolve built-in tokens that can appear INSIDE a parameter's
  // step labels, prefix, or suffix (not just at the top level of
  // the System text). Currently this is just {POWER_NAME} — when a
  // GM authors a Linear param's suffix as " {POWER_NAME}" or a step
  // label as "5 {POWER_NAME}", the player's custom Power name gets
  // substituted at the point the parameter resolves to a display
  // string. Returns the input unchanged if no built-in tokens match.
  function resolveBuiltins(s) {
    if (typeof s !== 'string' || s.indexOf('{') < 0) return s;
    const charData = (context && context.charData) ? context.charData : null;
    const rawName = (charData && typeof charData.powerName === 'string') ? charData.powerName.trim() : '';
    const powerName = rawName || 'Power';
    return s.replace(/\{([^{}]+)\}/g, (match, key) => {
      const norm = normalizeTokenKey(key);
      if (norm === 'powername') return powerName;
      return match;
    });
  }

  // Resolve a parameter's token-display value. Branches on mode:
  //   • linear  — paramValues[id] is the player's numeric value;
  //               render as "<prefix><value><suffix>" (e.g. "3d6")
  //   • manual  — paramValues[id] is the chosen step index; render
  //               via stepDisplay on the resolved step
  function resolveParamDisplay(p) {
    if (!p) return null;
    if (p.mode === 'linear') {
      const lc = (p.linearConfig && typeof p.linearConfig === 'object') ? p.linearConfig : {};
      const def = Number.isFinite(lc.defaultValue) ? lc.defaultValue : 0;
      const raw = paramValues[p.id];
      const value = Number.isFinite(raw) ? raw : def;
      const prefix = resolveBuiltins(typeof lc.valuePrefix === 'string' ? lc.valuePrefix : '');
      const suffix = resolveBuiltins(typeof lc.valueSuffix === 'string' ? lc.valueSuffix : '');
      return prefix + String(value) + suffix;
    }
    const step = resolveStep(p);
    const disp = stepDisplay(step);
    return disp != null ? resolveBuiltins(disp) : disp;
  }

  (Array.isArray(builder.primaryParams) ? builder.primaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const disp = resolveParamDisplay(p);
    if (disp != null) setToken(p.token, disp);
  });
  (Array.isArray(builder.secondaryParams) ? builder.secondaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const disp = resolveParamDisplay(p);
    if (disp != null) setToken(p.token, disp);
  });

  // {ACTIVATION_ROLL} token — resolves to a description of the activation
  // dice pool (e.g. "POW + Athletics + STATMOD"). Uses the player's
  // chosen stat/skill if set on the instance, otherwise the GM-configured
  // pool description with placeholder words like "STAT" or "SKILL".
  // Only filled when the Builder actually has activationRoll.enabled.
  // The describer lives in ruleset-abilitycatalogue.html (so the editor
  // and the runtime share one implementation) and exposes itself via
  // window.describeActivationRoll. If it's not loaded, we fall back to
  // a simple inline resolver so character.html still renders correctly
  // when the catalogue page hasn't been opened in this session.
  const ar = builder.activationRoll;
  if (ar && ar.enabled) {
    let arDesc = '';
    // Prefer numerical resolution when context is provided AND all
    // slots resolve to actual sheet values. resolveActivationRollNumeric
    // returns null when something can't be resolved; we then fall
    // through to the text descriptor below.
    const numeric = resolveActivationRollNumeric(builder, inst, context);
    if (numeric) {
      arDesc = numeric;
    } else if (typeof window !== 'undefined' && typeof window.describeActivationRoll === 'function') {
      arDesc = window.describeActivationRoll(builder, inst) || '';
    } else {
      // Inline fallback. Mirrors the logic in describeActivationRoll.
      const choice = (inst && inst.activationRollChoice) || {};
      const slot1 = ar.slot1 || {};
      const slot2 = ar.slot2 || {};
      let s1 = (slot1.mode === 'fixed-stat')
        ? (slot1.fixedStat || 'STAT')
        : (choice.slot1 || 'STAT');
      let s2;
      if (slot2.mode === 'fixed-stat')        s2 = slot2.fixedStat  || 'STAT';
      else if (slot2.mode === 'fixed-skill')  s2 = slot2.fixedSkill || 'SKILL';
      else if (choice.slot2)                  s2 = choice.slot2;
      else if (slot2.mode === 'any-stat')     s2 = 'STAT';
      else if (slot2.mode === 'any-skill')    s2 = 'SKILL';
      else                                    s2 = 'STAT or SKILL';
      arDesc = `${s1} + ${s2} + STATMOD`;
    }
    setToken('ACTIVATION_ROLL', arDesc);
    setToken('ACTIVATIONROLL',  arDesc);
  }

  // {POWER_NAME} token — resolves to the player's custom Power name
  // (set inline on the Power Bar, e.g. "Mana", "Vitae", "Stamina") so
  // GMs can author parameter labels and System text that follow the
  // player's chosen theme automatically. Falls back to "Power" if no
  // name is set, matching what the bar shows. Registered with both
  // {POWER_NAME} and {POWERNAME} aliases; the token-key normalizer
  // makes case and underscore variants match either way.
  {
    const charData = (context && context.charData) ? context.charData : null;
    const rawName = (charData && typeof charData.powerName === 'string') ? charData.powerName.trim() : '';
    const powerName = rawName || 'Power';
    setToken('POWER_NAME', powerName);
    setToken('POWERNAME',  powerName);
  }

  // Substitute. Match anything-between-single-braces. The captured text
  // is normalized the same way as token keys so {Foo Bar}, {foo_bar},
  // and {FOOBAR} all map to the same lookup. Unknown tokens are left
  // visible in the output so GMs can spot template typos.
  return builder.systemTextTemplate.replace(/\{([^{}]+)\}/g, (match, key) => {
    const norm = normalizeTokenKey(key);
    return Object.prototype.hasOwnProperty.call(normTokens, norm) ? normTokens[norm] : match;
  });
}

// Tiny HTML escape — purpose-built for renderSystemTextHtml. Only
// escapes the five characters that matter inside element bodies. Keeps
// this module dependency-free instead of importing a util.
function escapeForHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// HTML-form of renderSystemText. Identical token resolution, but the
// final output is HTML-safe AND each substituted token value is wrapped
// in <strong> tags so it stands out from the surrounding rules text.
// Caller does NOT escape the result — it is already escape-safe.
//
// Override path: when instance.systemTextOverride is set, it's the
// player's hand-written rules text. We escape it but DON'T wrap any
// tokens — overrides bypass templating entirely (matching the plain-
// text version's behavior).
export function renderSystemTextHtml(builder, instance, context) {
  if (instance && typeof instance.systemTextOverride === 'string' && instance.systemTextOverride.trim()) {
    return escapeForHtml(instance.systemTextOverride);
  }
  // Reuse the plain-text resolver to get the raw string (which has
  // already done all the token resolution and stat-value substitution).
  // Then re-walk the original template to identify which spans were
  // substituted, escape and bold those, and escape the rest.
  if (!builder || typeof builder.systemTextTemplate !== 'string' || !builder.systemTextTemplate) {
    return '';
  }

  // We need access to the SAME normTokens table renderSystemText built
  // internally. Easiest path: call renderSystemText to get the resolved
  // text, then walk the template's {tokenName} positions in lockstep.
  // For each token position, look up its substituted value (matching
  // by recomputing the normalized key) and emit `<strong>VALUE</strong>`.
  // For non-token spans, emit the escaped template text verbatim.

  const tpl = builder.systemTextTemplate;

  // Rebuild the normalized token table using the same logic as
  // renderSystemText. (Duplicated here to avoid exposing internals;
  // small enough that the duplication is OK.) If this drifts from
  // renderSystemText, both will produce different output for the same
  // input — keep them in sync.
  const inst = (instance && typeof instance === 'object') ? instance : {};
  const paramValues = (inst.paramValues && typeof inst.paramValues === 'object') ? inst.paramValues : {};
  const resolveStep = (p) => {
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const defaultIdx = Number.isFinite(p.defaultStep)
      ? p.defaultStep
      : (Number.isFinite(p.defaultStepIndex) ? p.defaultStepIndex : 0);
    const selectedRaw = paramValues[p.id];
    const idx = Number.isFinite(selectedRaw) ? selectedRaw : defaultIdx;
    return (idx >= 0 && idx < steps.length) ? steps[idx] : null;
  };
  const stepDisplay = (step) => {
    if (!step) return null;
    if (step.label) return step.label;
    if (step.value !== undefined && step.value !== null && step.value !== '') return String(step.value);
    return null;
  };
  const normTokens = {};
  function normalizeTokenKey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function setToken(name, val) {
    const k = normalizeTokenKey(name);
    if (k) normTokens[k] = val;
  }
  // See renderSystemText for full notes — resolves built-in tokens
  // ({POWER_NAME} for now) inside parameter strings before they're
  // returned as display values.
  function resolveBuiltins(s) {
    if (typeof s !== 'string' || s.indexOf('{') < 0) return s;
    const charData = (context && context.charData) ? context.charData : null;
    const rawName = (charData && typeof charData.powerName === 'string') ? charData.powerName.trim() : '';
    const powerName = rawName || 'Power';
    return s.replace(/\{([^{}]+)\}/g, (match, key) => {
      const norm = normalizeTokenKey(key);
      if (norm === 'powername') return powerName;
      return match;
    });
  }
  function resolveParamDisplay(p) {
    if (!p) return null;
    if (p.mode === 'linear') {
      const lc = (p.linearConfig && typeof p.linearConfig === 'object') ? p.linearConfig : {};
      const def = Number.isFinite(lc.defaultValue) ? lc.defaultValue : 0;
      const raw = paramValues[p.id];
      const value = Number.isFinite(raw) ? raw : def;
      const prefix = resolveBuiltins(typeof lc.valuePrefix === 'string' ? lc.valuePrefix : '');
      const suffix = resolveBuiltins(typeof lc.valueSuffix === 'string' ? lc.valueSuffix : '');
      return prefix + String(value) + suffix;
    }
    const step = resolveStep(p);
    const disp = stepDisplay(step);
    return disp != null ? resolveBuiltins(disp) : disp;
  }
  (Array.isArray(builder.primaryParams) ? builder.primaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const disp = resolveParamDisplay(p);
    if (disp != null) setToken(p.token, disp);
  });
  (Array.isArray(builder.secondaryParams) ? builder.secondaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const disp = resolveParamDisplay(p);
    if (disp != null) setToken(p.token, disp);
  });
  const ar = builder.activationRoll;
  if (ar && ar.enabled) {
    let arDesc = '';
    const numeric = resolveActivationRollNumeric(builder, inst, context);
    if (numeric) {
      arDesc = numeric;
    } else if (typeof window !== 'undefined' && typeof window.describeActivationRoll === 'function') {
      arDesc = window.describeActivationRoll(builder, inst) || '';
    } else {
      const choice = (inst && inst.activationRollChoice) || {};
      const slot1 = ar.slot1 || {};
      const slot2 = ar.slot2 || {};
      let s1 = (slot1.mode === 'fixed-stat')
        ? (slot1.fixedStat || 'STAT')
        : (choice.slot1 || 'STAT');
      let s2;
      if (slot2.mode === 'fixed-stat')        s2 = slot2.fixedStat  || 'STAT';
      else if (slot2.mode === 'fixed-skill')  s2 = slot2.fixedSkill || 'SKILL';
      else if (choice.slot2)                  s2 = choice.slot2;
      else if (slot2.mode === 'any-stat')     s2 = 'STAT';
      else if (slot2.mode === 'any-skill')    s2 = 'SKILL';
      else                                    s2 = 'STAT or SKILL';
      arDesc = `${s1} + ${s2} + STATMOD`;
    }
    setToken('ACTIVATION_ROLL', arDesc);
    setToken('ACTIVATIONROLL',  arDesc);
  }

  // {POWER_NAME} built-in — see renderSystemText for full notes.
  {
    const charData = (context && context.charData) ? context.charData : null;
    const rawName = (charData && typeof charData.powerName === 'string') ? charData.powerName.trim() : '';
    const powerName = rawName || 'Power';
    setToken('POWER_NAME', powerName);
    setToken('POWERNAME',  powerName);
  }

  // Walk the template, replacing tokens with bolded HTML.
  return tpl.replace(/\{([^{}]+)\}|([^{]+)/g, (match, tokenKey, plainText) => {
    if (tokenKey !== undefined) {
      const norm = normalizeTokenKey(tokenKey);
      if (Object.prototype.hasOwnProperty.call(normTokens, norm)) {
        return `<strong>${escapeForHtml(normTokens[norm])}</strong>`;
      }
      // Unknown token — render as escaped literal so GM can spot typos
      return escapeForHtml(match);
    }
    return escapeForHtml(plainText);
  });
}

// ─── CHARACTER-SIDE ABILITY ARRAY ACCESS ───
//
// Defensive accessor — char.abilities should always be an array but
// might be missing on legacy character data. This returns an empty
// array if not present. Callers that mutate should use ensureAbilities.
export function getAbilities(charData) {
  return Array.isArray(charData && charData.abilities) ? charData.abilities : [];
}

export function ensureAbilities(charData) {
  if (!Array.isArray(charData.abilities)) charData.abilities = [];
  return charData.abilities;
}

// Generate a stable id for a new Ability instance. Format mirrors the
// other id-generators in the codebase: prefix + base36 random suffix.
export function newAbilityId() {
  return 'abl_' + Math.random().toString(36).slice(2, 10);
}
