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
export function renderSystemText(builder, instance) {
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

  (Array.isArray(builder.primaryParams) ? builder.primaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const disp = stepDisplay(resolveStep(p));
    if (disp != null) setToken(p.token, disp);
  });
  (Array.isArray(builder.secondaryParams) ? builder.secondaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const disp = stepDisplay(resolveStep(p));
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
    if (typeof window !== 'undefined' && typeof window.describeActivationRoll === 'function') {
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
    setToken('ACTIVATIONROLL',  arDesc);  // alias (both forms normalize to same key, but explicit registration is harmless)
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
