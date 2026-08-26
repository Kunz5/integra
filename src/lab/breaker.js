/*
  breaker.js: search a family of functions for the one that defeats a method.
  ..................................................................

  Every quadrature rule comes with an error bound, and every error bound has a
  derivative in it. Simpson's is

      |E| ≤ (b − a)h⁴/180 · max|f⁗(ξ)|

  which is not a promise of accuracy. It is a promise of accuracy *divided by
  however large the fourth derivative gets*. The rule is only as good as that
  factor is small, and the factor is a property of the integrand, not of the
  rule.

  So the exercise is: hold the method and the budget fixed, walk a parameter
  through a family of integrands, and find where the accuracy falls off a
  cliff. The answer is never a surprise once you see it, and it is almost
  always invisible until you do.

  Two rules about honesty here. The search reports the worst case it *found*,
  which is the worst over the grid it examined and nothing more. And the
  explanation for each family is a statement of known mathematics: the
  relationship between the parameter and the derivative in the error bound;
  not a conclusion drawn from the numbers on screen.
*/

import { FIXED_METHODS } from '../numeric/quadrature.js';
import { ADAPTIVE_METHODS, gauss, tanhSinh } from '../numeric/advanced.js';

/**
 * The families. Each one has a knob that provably degrades some error bound,
 * and each carries the reason in its own words.
 */
export const FAMILIES = {
  oscillatory: {
    label: 'sin(kx)',
    expression: (k) => `sin(${fmt(k)}x)`,
    f: (k) => (x) => Math.sin(k * x),
    exact: (k, a, b) => (Math.cos(k * a) - Math.cos(k * b)) / k,
    range: [1, 400],
    parameter: 'k',
    interval: [0, 1],
    why: 'Every derivative of sin(kx) carries another factor of k, so the fourth derivative in Simpson\'s error bound '
      + 'grows as k⁴. Doubling the frequency costs sixteen times the error at the same number of samples. The rule '
      + 'has not stopped working, the quantity its bound depends on has grown.',
    watchFor: 'Accuracy collapses once there are fewer than a handful of sample points per oscillation. Below about '
      + 'two points per period the samples alias, and the estimate stops tracking the function at all.',
  },

  peak: {
    label: 'a sharp peak',
    expression: (k) => `1/(1 + ${fmt(k * k)}(x − 0.5)^2)`,
    f: (k) => (x) => 1 / (1 + k * k * (x - 0.5) * (x - 0.5)),
    exact: (k) => (Math.atan(k * 0.5) - Math.atan(-k * 0.5)) / k,
    range: [1, 3000],
    parameter: 'k',
    interval: [0, 1],
    why: 'A Lorentzian of width 1/k has derivatives that scale as k^n. As k grows, essentially all of the area sits in '
      + 'a sliver of width 1/k, and a uniform grid spends its entire budget sampling the flat parts either side of it.',
    watchFor: 'A fixed rule degrades steadily. Adaptive Simpson barely notices, because it puts its samples where the '
      + 'error estimate tells it to: this is the clearest demonstration in the whole laboratory of what adaptivity buys.',
  },

  endpoint: {
    label: 'an endpoint singularity',
    expression: (p) => `x^(−${fmt(p)})`,
    f: (p) => (x) => Math.pow(x, -p),
    exact: (p) => 1 / (1 - p),
    range: [0.05, 0.95],
    parameter: 'p',
    interval: [0, 1],
    why: 'x^(−p) is integrable for p < 1, but its derivatives blow up at the origin for any p > 0. The error bounds for '
      + 'every polynomial rule involve those derivatives, so they are all vacuous here; the bound is infinite and says '
      + 'nothing. The observed rate falls to 1 − p regardless of how high-order the rule claims to be.',
    watchFor: 'Every fixed rule and adaptive Simpson degrade together as p approaches 1. Tanh-sinh does not degrade at '
      + 'all, because it never evaluates the endpoint.',
  },

  cusp: {
    label: 'a moving kink',
    expression: (c) => `|x − ${fmt(c)}|`,
    f: (c) => (x) => Math.abs(x - c),
    exact: (c, a = 0, b = 1) => {
      const g = (t) => (t >= c ? ((t - c) * (t - c)) / 2 : -((c - t) * (c - t)) / 2);
      return g(b) - g(a);
    },
    range: [0.0, 0.5],
    parameter: 'c',
    interval: [0, 1],
    why: 'A polynomial rule interpolates across each panel. When the kink falls *on* a node the interpolant reproduces '
      + 'it exactly and the rule is exact; when it falls in the interior of a panel, the interpolant cannot represent '
      + 'the corner and the error is first-order there. The result depends on where the kink lands relative to the grid, '
      + 'which is a property of the arithmetic and not of the mathematics.',
    watchFor: 'The error is a sawtooth in c, not a smooth curve; near-zero at kinks that land on grid points, and '
      + 'orders of magnitude worse a hair either side. This is the single least intuitive plot in the laboratory.',
  },

  wild: {
    label: 'sin(1/x) near the origin',
    expression: (s) => `sin(1/(x + ${fmt(s)}))`,
    f: (s) => (x) => Math.sin(1 / (x + s)),
    exact: null,
    range: [0.5, 0.002],
    parameter: 'shift',
    interval: [0, 1],
    why: 'As the shift approaches zero, sin(1/(x + s)) oscillates ever faster near the left endpoint — infinitely often '
      + 'in the limit. No finite set of samples can resolve infinitely many oscillations, so every method fails here; '
      + 'the interesting question is which fails gracefully.',
    watchFor: 'The methods do not merely lose accuracy, they disagree with each other. When two good methods return '
      + 'different answers, that disagreement is the most reliable evidence available that neither should be believed.',
  },
};

const fmt = (v) => (Number.isInteger(v) ? String(v) : Number(v.toPrecision(4)).toString());

/**
 * Walk a family's parameter and record how one method does at a fixed budget.
 *
 * "Fixed budget" is the entire methodological point. Comparing methods at fixed
 * N is unfair, because Gauss-Legendre's N samples do far more work than a
 * Riemann sum's. Comparing at fixed *evaluations* is the honest test, and it is
 * what makes the answer to "which method is best" turn out to depend on the
 * integrand rather than on the rule.
 */
export function scan(familyKey, methodKey, budget = 200, steps = 60) {
  const family = FAMILIES[familyKey];
  if (!family) throw new Error(`No such family: ${familyKey}`);

  const [a, b] = family.interval;
  const [lo, hi] = family.range;
  const out = [];

  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    // Sweep geometrically when the range spans decades, linearly otherwise.
    const geometric = lo > 0 && hi > 0 && Math.abs(Math.log10(hi / lo)) > 1.2;
    const p = geometric ? lo * Math.pow(hi / lo, t) : lo + (hi - lo) * t;

    const f = family.f(p);
    const exact = family.exact ? family.exact(p, a, b) : referenceValue(f, a, b);
    if (!Number.isFinite(exact)) continue;

    const r = runAtBudget(f, a, b, methodKey, budget);
    const error = Math.abs(r.value - exact);
    out.push({
      parameter: p,
      value: r.value,
      exact,
      error,
      relativeError: Number.isFinite(r.value) ? error / Math.max(1e-300, Math.abs(exact)) : NaN,
      evaluations: r.evaluations,
      refused: !Number.isFinite(r.value),
      refusalReason: r.reason,
      expression: family.expression(p),
    });
  }

  const usable = out.filter((o) => Number.isFinite(o.relativeError));
  const refused = out.filter((o) => o.refused);
  const worst = usable.reduce((w, o) => (!w || o.relativeError > w.relativeError ? o : w), null);
  const best = usable.reduce((w, o) => (!w || o.relativeError < w.relativeError ? o : w), null);

  return {
    family: familyKey,
    familyLabel: family.label,
    method: methodKey,
    methodLabel: (FIXED_METHODS[methodKey] ?? ADAPTIVE_METHODS[methodKey] ?? { label: methodKey }).label,
    budget,
    points: out,
    worst,
    best,
    refusedCount: refused.length,
    totalCount: out.length,
    why: family.why,
    watchFor: family.watchFor,
    summary: summarise(worst, best, family, methodKey, refused, out.length),
  };
}

function summarise(worst, best, family, methodKey, refused = [], total = 0) {
  const label0 = (FIXED_METHODS[methodKey] ?? ADAPTIVE_METHODS[methodKey] ?? { label: methodKey }).label;

  // A method that declines to answer has not lost the comparison — it has made
  // the most useful statement available. Reporting it as "no usable points"
  // would throw away the finding.
  if (refused.length && refused.length === total) {
    return `${label0} returned no value anywhere in this family. ${refused[0].refusalReason ?? ''} `
      + 'A method that refuses is telling you something a method that returns a wrong number is not.';
  }
  if (!worst || !best) return 'The scan produced no usable points.';
  const spread = worst.relativeError / Math.max(1e-300, best.relativeError);
  const refusalNote = refused.length
    ? ` It declined to return a value for ${refused.length} of the ${total} members of the family.` : '';

  const head = `Over this family and at a fixed budget of about ${worst.evaluations} evaluations, ${label0} was `
    + `most accurate at ${family.parameter} = ${fmt(best.parameter)} (relative error ${best.relativeError.toExponential(2)}) `
    + `and least accurate at ${family.parameter} = ${fmt(worst.parameter)} (relative error ${worst.relativeError.toExponential(2)}).`;

  const gap = spread > 10
    ? ` That is a factor of ${spread.toExponential(1)} between the best and worst case, from the same rule with the same `
      + 'number of samples, on functions that differ only in one parameter.'
    : ' The spread across the family is small — this method is not especially sensitive to this parameter.';

  return `${head}${gap}${refusalNote} This is the worst case *found on the grid searched*, not a proven worst case.`;
}

function referenceValue(f, a, b) {
  const r = tanhSinh(f, a, b, 1e-14);
  return r.converged ? r.value : NaN;
}

/**
 * Run a method at approximately a given number of function evaluations.
 *
 * Each rule spends its budget differently; a closed rule uses N+1 samples for
 * N strips, Gauss uses exactly its point count, adaptive Simpson uses however
 * many it decides it needs. The budget is matched as closely as each rule
 * allows, and the actual count is returned so the comparison can be checked
 * rather than trusted.
 */
export function runAtBudget(f, a, b, methodKey, budget) {
  if (FIXED_METHODS[methodKey]) {
    const n = Math.max(2, Math.round(budget));
    return FIXED_METHODS[methodKey].run(f, a, b, n);
  }
  if (methodKey === 'gauss') return gauss(f, a, b, Math.max(2, Math.min(400, Math.round(budget))));
  if (methodKey === 'tanhsinh') return tanhSinh(f, a, b, 1e-12, 8);
  if (methodKey === 'adaptive') {
    // Adaptive rules take a tolerance, not a sample count. Bisect on the
    // tolerance until the evaluation count lands near the budget, so the
    // comparison against fixed rules is genuinely like for like.
    let loTol = 1e-16, hiTol = 1;
    let result = ADAPTIVE_METHODS.adaptive.run(f, a, b, { tolerance: 1e-8 });
    for (let i = 0; i < 24; i++) {
      const mid = Math.sqrt(loTol * hiTol);
      result = ADAPTIVE_METHODS.adaptive.run(f, a, b, { tolerance: mid });
      if (result.evaluations > budget) loTol = mid; else hiTol = mid;
      if (Math.abs(result.evaluations - budget) <= budget * 0.15) break;
    }
    return result;
  }
  throw new Error(`No such method: ${methodKey}`);
}

/**
 * Run every method over one family, so the crossovers show.
 *
 * The point of the grid is that no row wins it. Gauss-Legendre dominates the
 * smooth families by many orders of magnitude and then loses to tanh-sinh on
 * the endpoint singularity; adaptive Simpson is unremarkable everywhere except
 * the sharp peak, where it is untouchable. "Which method is best" has no answer
 * without an integrand attached to it.
 */
export function tournament(familyKey, methods, budget = 200, steps = 30) {
  return methods.map((m) => scan(familyKey, m, budget, steps));
}
