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
  // Each contributes flat AP based on (currentValue − defaultValue) × stepCost.
  // Currentvalue defaults to defaultValue if the player hasn't tuned it
  // (a fresh build, or a param added to the Builder after the Ability
  // was authored).
  const primaryParams = Array.isArray(builder.primaryParams) ? builder.primaryParams : [];
  primaryParams.forEach(param => {
    const def = Number.isFinite(param.defaultValue) ? param.defaultValue : 0;
    const stepCost = Number.isFinite(param.stepCost) ? param.stepCost : 1;
    const currentRaw = paramValues[param.id];
    const current = Number.isFinite(currentRaw) ? currentRaw : def;
    const delta = (current - def) * stepCost;
    result.primaryDelta += delta;
    result.breakdown.primary.push({
      paramId: param.id,
      paramName: param.name || 'Parameter',
      defaultValue: def,
      currentValue: current,
      stepCost,
      delta,
      displayUnit: param.displayUnit || ''
    });
  });

  // Warn about orphan paramValues — keys that don't match any current
  // primary or secondary param. Useful for "this Ability's Builder
  // changed" indicators on the Player side.
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
  // Each contributes a multiplier from the active step. defaultStepIndex
  // controls which step is used when the Player hasn't selected one.
  // Multipliers compose multiplicatively: a 1.5× and a 0.75× yield 1.125×.
  const secondaryParams = Array.isArray(builder.secondaryParams) ? builder.secondaryParams : [];
  secondaryParams.forEach(param => {
    const steps = Array.isArray(param.steps) ? param.steps : [];
    const defaultIdx = Number.isFinite(param.defaultStepIndex) ? param.defaultStepIndex : 0;
    // The Player stores selected step index in paramValues[paramId] for
    // secondary params. (Primary params store the value directly; secondary
    // params store the step index since values can be non-numeric labels.)
    const selectedRaw = paramValues[param.id];
    const selectedIdx = Number.isFinite(selectedRaw) ? selectedRaw : defaultIdx;
    const step = (selectedIdx >= 0 && selectedIdx < steps.length) ? steps[selectedIdx] : null;
    const multiplier = (step && Number.isFinite(step.multiplier)) ? step.multiplier : 1;
    if (step) {
      result.percentMultiplier *= multiplier;
    } else {
      // Selected step index out of range — degrade to default step (or 1×).
      const fallbackStep = (defaultIdx >= 0 && defaultIdx < steps.length) ? steps[defaultIdx] : null;
      if (fallbackStep && Number.isFinite(fallbackStep.multiplier)) {
        result.percentMultiplier *= fallbackStep.multiplier;
        result.warnings.push(`Selected step for ${param.name || 'param'} is out of range; using default.`);
      }
    }
    result.breakdown.secondary.push({
      paramId: param.id,
      paramName: param.name || 'Parameter',
      defaultStepIndex: defaultIdx,
      selectedStepIndex: selectedIdx,
      stepValue: step ? step.value : null,
      stepLabel: step ? step.label : '',
      multiplier,
      displayUnit: param.displayUnit || ''
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
  const tokens = {};
  (Array.isArray(builder.primaryParams) ? builder.primaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const def = Number.isFinite(p.defaultValue) ? p.defaultValue : 0;
    const cur = Number.isFinite(paramValues[p.id]) ? paramValues[p.id] : def;
    const unit = p.displayUnit ? ' ' + p.displayUnit : '';
    tokens[p.token] = `${cur}${unit}`;
  });
  (Array.isArray(builder.secondaryParams) ? builder.secondaryParams : []).forEach(p => {
    if (!p || !p.token) return;
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const defaultIdx = Number.isFinite(p.defaultStepIndex) ? p.defaultStepIndex : 0;
    const selectedRaw = paramValues[p.id];
    const idx = Number.isFinite(selectedRaw) ? selectedRaw : defaultIdx;
    const step = (idx >= 0 && idx < steps.length) ? steps[idx] : null;
    if (!step) return;
    // Prefer label if set, else value + unit. Steps where value is a
    // string (e.g. "Touch") use the value as-is.
    let display;
    if (step.label) display = step.label;
    else if (typeof step.value === 'string') display = step.value;
    else if (Number.isFinite(step.value)) display = `${step.value}${p.displayUnit ? ' ' + p.displayUnit : ''}`;
    else display = String(step.value);
    tokens[p.token] = display;
  });

  // Substitute. Match {tokenName} pattern. Leave unknown tokens visible.
  return builder.systemTextTemplate.replace(/\{(\w+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match;
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
