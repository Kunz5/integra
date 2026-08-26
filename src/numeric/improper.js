/**
 * improper.js — integrals over an infinite interval, and integrals of an
 * unbounded function.
 *
 * An improper integral is a limit, not a sum:
 *
 *     ∫₁^∞ f dx = lim_{R→∞} ∫₁^R f dx        ∫₀¹ f dx = lim_{ε→0⁺} ∫_ε¹ f dx
 *
 * so the honest way to display one is to *show the limit being approached* —
 * the partial integrals as the cut-off moves — rather than to print a number
 * and call it done. That is what `approachSequence` is for, and it is the only
 * presentation that makes convergence and divergence look different on screen.
 *
 * For the value itself, an infinite range is mapped to a finite one and handed
 * to tanh-sinh quadrature. The substitutions are exact changes of variable, not
 * truncations: nothing is thrown away at a "large enough" cut-off, which is the
 * approximation that quietly loses the tail of a slowly decaying integrand.
 */

import { tanhSinh, adaptiveSimpson } from './advanced.js';

/**
 * Classify the endpoints of an integral.
 * @returns {{ infiniteLower, infiniteUpper, singularLower, singularUpper }}
 */
export function classify(f, a, b) {
  const infiniteLower = a === -Infinity;
  const infiniteUpper = b === Infinity;
  const probe = (x) => {
    const y = f(x);
    return Number.isFinite(y);
  };
  const width = (Number.isFinite(a) && Number.isFinite(b)) ? b - a : 1;
  return {
    infiniteLower,
    infiniteUpper,
    singularLower: !infiniteLower && !probe(a) && probe(a + width * 1e-8),
    singularUpper: !infiniteUpper && !probe(b) && probe(b - width * 1e-8),
    endpointFiniteLower: !infiniteLower && probe(a),
    endpointFiniteUpper: !infiniteUpper && probe(b),
  };
}

/**
 * Evaluate an integral that may be improper at either end.
 *
 * The transformations, each an exact substitution:
 *
 *   [a, ∞)     x = a + t/(1 − t),  t ∈ [0, 1),  dx = dt/(1 − t)²
 *   (−∞, b]    mirror of the above
 *   (−∞, ∞)    x = t/(1 − t²),     t ∈ (−1, 1), dx = (1 + t²)/(1 − t²)² dt
 *
 * Each maps the infinite end to an endpoint of a finite interval, where the
 * transformed integrand generally blows up — and tanh-sinh, which never samples
 * its endpoints, does not care.
 */
/**
 * A finite integral over a wide interval, split into geometrically graded panels.
 *
 * One tanh-sinh call over [−10⁶, 10⁶] does not integrate e^(−x²): the
 * transformation clusters its samples near the endpoints, and the peak sitting
 * in the middle of a six-order-of-magnitude interval falls between them. The
 * quadrature returns a confident number that is nowhere near the answer.
 *
 * Splitting at ±1, ±10, ±100, … puts a full set of nodes in every decade, so
 * whichever decade the interesting part of the function lives in, it is
 * resolved. The cost is logarithmic in the width of the interval.
 */
export function gradedIntegral(f, lo, hi, tol = 1e-13) {
  if (!(hi > lo)) return { value: 0, evaluations: 0, converged: true, estimatedError: 0, levels: 0 };
  if (hi - lo <= 4) return finiteIntegral(f, lo, hi, tol);

  const cuts = new Set([lo, hi]);
  for (const sign of [-1, 1]) {
    for (let m = 1; m <= 1e300; m *= 10) {
      const x = sign * m;
      if (x > lo && x < hi) cuts.add(x);
      if (Math.abs(x) > Math.max(Math.abs(lo), Math.abs(hi))) break;
    }
  }
  if (lo < 0 && hi > 0) cuts.add(0);

  const points = [...cuts].sort((p1, p2) => p1 - p2);
  const parts = [];
  for (let i = 0; i < points.length - 1; i++) parts.push(finiteIntegral(f, points[i], points[i + 1], tol));

  return {
    value: parts.reduce((s2, p) => s2 + p.value, 0),
    evaluations: parts.reduce((s2, p) => s2 + p.evaluations, 0),
    converged: parts.every((p) => p.converged),
    estimatedError: parts.reduce((s2, p) => s2 + (Number.isFinite(p.estimatedError) ? p.estimatedError : 0), 0),
    levels: Math.max(...parts.map((p) => p.levels)),
    panels: parts.length,
  };
}

/**
 * A finite integral, computed by whichever method can actually see the
 * integrand's difficulty.
 *
 * The two good methods here fail in complementary places, and neither one alone
 * is safe as a default:
 *
 *   · Tanh-sinh is unbeatable at an *endpoint* singularity, because it never
 *     samples the endpoints. But its nodes are sparsest in the middle of the
 *     interval, so an interior kink is exactly what it under-resolves — it
 *     returns 0.9848 for ∫₋₁¹|x|dx, which is 1.
 *
 *   · Adaptive Simpson subdivides wherever its error estimate demands, so an
 *     interior kink costs it a few dozen extra evaluations and nothing else.
 *     But it is a closed rule, so a singular endpoint stops it dead.
 *
 * So: run both, and let their agreement decide. When they agree the integrand
 * is smooth and tanh-sinh's answer is the more accurate one. When they disagree
 * the difficulty is interior — tanh-sinh's blind spot and adaptive Simpson's
 * speciality — so the adaptive answer wins. When adaptive cannot sample at all,
 * the difficulty is at an endpoint and tanh-sinh is the only one left standing.
 *
 * The disagreement itself is returned, because two good methods disagreeing is
 * the most reliable warning available that neither should be trusted.
 */
export function finiteIntegral(f, a, b, tol = 1e-13) {
  const ts = tanhSinh(f, a, b, tol);
  const ad = adaptiveSimpson(f, a, b, Math.max(tol, 1e-12));

  // A run that hit its budget did not converge; it is not evidence about
  // anything, least of all about tanh-sinh being wrong.
  if (!Number.isFinite(ad.value) || ad.budgetExceeded) {
    return { ...ts, method: 'tanh-sinh', crossCheck: null, reason: ad.reason };
  }
  if (!Number.isFinite(ts.value)) {
    return { ...ad, method: 'adaptive Simpson', crossCheck: null };
  }

  const scale = Math.max(1e-300, Math.abs(ts.value), Math.abs(ad.value));
  const disagreement = Math.abs(ts.value - ad.value) / scale;

  if (disagreement < 1e-10) {
    return {
      ...ts,
      method: 'tanh-sinh',
      crossCheck: { other: ad.value, disagreement, agreed: true },
      evaluations: ts.evaluations + ad.evaluations,
    };
  }

  return {
    value: ad.value,
    evaluations: ts.evaluations + ad.evaluations,
    converged: !ad.depthExceeded,
    estimatedError: ad.estimatedError,
    levels: ad.intervals?.length ?? 0,
    method: 'adaptive Simpson',
    crossCheck: { other: ts.value, disagreement, agreed: false },
    reason: `Tanh-sinh and adaptive Simpson disagree by ${disagreement.toExponential(2)} relative. `
      + 'That pattern means the difficulty is inside the interval rather than at an endpoint — a kink or a spike, '
      + 'which tanh-sinh under-samples because its nodes crowd towards the ends. The adaptive result is reported.',
  };
}

export function improper(f, a, b, options = {}) {
  const tol = options.tolerance ?? 1e-13;

  /**
   * The tail ∫_c^∞ f dx under x = 1/u, dx = −du/u².
   *
   *     ∫_c^∞ f(x) dx = ∫₀^{1/c} f(1/u)/u² du
   *
   * This is the transform to use for an algebraically decaying integrand, and
   * it is worth saying why over the more obvious x = c + t/(1 − t). Under the
   * reciprocal map, f ~ x^(−p) becomes u^(p−2): a *bounded* power singularity
   * at the origin, which tanh-sinh removes completely. Under the other map the
   * transformed integrand grows like (1 − t)^(−(2−p)) with an extra factor from
   * the Jacobian, and for a heavy tail such as x^(−1.1) it converges so slowly
   * that the quadrature runs out of levels two per cent short of the answer.
   * Same integral, same method, entirely different accuracy — chosen by the
   * substitution.
   */
  const tailFrom = (c) => tanhSinh((u) => (u === 0 ? NaN : f(1 / u) / (u * u)), 0, 1 / c, tol);
  const headTail = (parts) => {
    const value = parts.reduce((s2, p) => s2 + p.value, 0);
    return {
      value,
      evaluations: parts.reduce((s2, p) => s2 + p.evaluations, 0),
      converged: parts.every((p) => p.converged),
      estimatedError: parts.reduce((s2, p) => s2 + (Number.isFinite(p.estimatedError) ? p.estimatedError : NaN), 0),
      levels: Math.max(...parts.map((p) => p.levels)),
    };
  };

  if (a === -Infinity && b === Infinity) {
    const parts = [gradedIntegral(f, -1, 1, tol), tailFrom(1), mirrorTail(f, -1, tol)];
    return { ...headTail(parts), transform: 'split at ±1, then x = 1/u on each infinite tail' };
  }

  if (b === Infinity) {
    const c = Math.max(a, 1);
    const parts = c > a ? [gradedIntegral(f, a, c, tol), tailFrom(c)] : [tailFrom(c)];
    return {
      ...headTail(parts),
      transform: c > a
        ? `∫ from ${fmt(a)} to ${fmt(c)} directly, then x = 1/u on the tail from ${fmt(c)} to ∞`
        : `x = 1/u maps (0, ${fmt(1 / c)}] onto [${fmt(c)}, ∞)`,
    };
  }

  if (a === -Infinity) {
    const c = Math.min(b, -1);
    const parts = c < b ? [gradedIntegral(f, c, b, tol), mirrorTail(f, c, tol)] : [mirrorTail(f, c, tol)];
    return {
      ...headTail(parts),
      transform: c < b
        ? `∫ from ${fmt(c)} to ${fmt(b)} directly, then x = 1/u on the tail from −∞ to ${fmt(c)}`
        : `x = 1/u maps [${fmt(1 / c)}, 0) onto (−∞, ${fmt(c)}]`,
    };
  }

  // Finite interval, possibly singular at an endpoint.
  const r = finiteIntegral(f, a, b, tol);
  return { ...r, transform: `finite interval — evaluated directly by ${r.method}` };
}

/** ∫_{−∞}^{c} f dx for negative c, by the same reciprocal substitution. */
function mirrorTail(f, c, tol) {
  return tanhSinh((u) => (u === 0 ? NaN : f(1 / u) / (u * u)), 1 / c, 0, tol);
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toPrecision(4));

/**
 * The sequence of partial integrals as the cut-off approaches the improper end.
 *
 * This is the *definition* rendered as data. Each entry is ∫ over a truncated
 * interval, and watching the column either settle or run away is the whole
 * distinction between convergent and divergent — which is a far better answer
 * than the string "∞".
 *
 * @param {'upper'|'lower'|'both'} which  which end is improper
 */
export function approachSequence(f, a, b, which = 'upper', steps = 14) {
  const out = [];

  // Doubly infinite: move both cut-offs together, which is the symmetric
  // (principal-value) approach. Worth naming, because it is not the same limit
  // as letting the two ends run away independently — ∫x dx over (−∞, ∞) has a
  // symmetric limit of 0 and no limit at all in the general sense.
  if (a === -Infinity && b === Infinity) {
    let R = 4;
    for (let i = 0; i < steps; i++) {
      const r = gradedIntegral(f, -R, R, 1e-12);
      out.push({ cutoff: R, value: r.value, label: `∫ from −${R.toExponential(0)} to ${R.toExponential(0)}` });
      R *= 3;
    }
    return out;
  }

  if (which === 'upper' && b === Infinity) {
    let R = Math.max(Math.abs(a) * 2 + 1, 10);
    for (let i = 0; i < steps; i++) {
      const r = gradedIntegral(f, a, R, 1e-12);
      out.push({ cutoff: R, value: r.value, label: `∫ from ${fmt(a)} to ${R.toExponential(0)}` });
      R *= 4;
    }
    return out;
  }

  if (which === 'lower' && a === -Infinity) {
    let R = Math.max(Math.abs(b) * 2 + 1, 10);
    for (let i = 0; i < steps; i++) {
      const r = gradedIntegral(f, -R, b, 1e-12);
      out.push({ cutoff: -R, value: r.value, label: `∫ from −${R.toExponential(0)} to ${fmt(b)}` });
      R *= 4;
    }
    return out;
  }

  // Singular at a finite endpoint: walk ε down towards zero.
  const singularAtLower = which === 'lower';
  let eps = (b - a) * 0.1;
  for (let i = 0; i < Math.max(steps, 16); i++) {
    const lo = singularAtLower ? a + eps : a;
    const hi = singularAtLower ? b : b - eps;
    const r = gradedIntegral(f, lo, hi, 1e-12);
    out.push({ cutoff: eps, value: r.value, label: `ε = ${eps.toExponential(1)}` });
    eps /= 10;
    if (eps < 1e-17) break;
  }
  return out;
}

/**
 * Does the approach sequence look convergent?
 *
 * A *diagnosis from evidence*, never a proof. The tail of a sequence can do
 * anything: ∫₁^R dx/x grows like ln R, which over any four consecutive
 * quadruplings looks almost flat. So the verdict is deliberately labelled as an
 * observation, the reasoning is returned alongside it, and the interface prints
 * both. Nothing here is allowed to say "this integral converges" — only "the
 * partial integrals are behaving as though it does".
 */
export function diagnose(sequence) {
  const values = sequence.map((s) => s.value).filter(Number.isFinite);
  if (values.length < 5) {
    return { verdict: 'unknown', confidence: 'none', reason: 'Too few usable partial integrals to say anything.' };
  }

  const last = values[values.length - 1];
  const deltas = [];
  for (let i = 1; i < values.length; i++) deltas.push(values[i] - values[i - 1]);

  // The test that actually separates the cases is not "are the increments
  // small" but "are they *decaying*". ∫₁^R dx/x adds ln 4 ≈ 1.386 on every
  // quadrupling of R — forever — and against a partial integral of 37 that
  // increment looks negligible. Its ratio to the previous increment, however,
  // is exactly 1, and stays 1. Meanwhile ∫₁^R dx/x² has increments in a
  // geometric ratio of 1/4. The ratio is the diagnostic.
  // Once the partial integrals have converged, the remaining differences are
  // rounding noise: random in sign, comparable in size to each other, and
  // therefore a perfect impostor of both "oscillating" and "not decaying". Any
  // increment below the working precision of the value has to be read as zero
  // before the shape of the tail means anything at all.
  const scale = Math.max(...values.map(Math.abs), 1e-300);
  const noiseFloor = scale * 1e-12;
  const tail = deltas.slice(-5).filter((d) => Math.abs(d) > noiseFloor);
  if (tail.length < 3) {
    return {
      verdict: 'appears convergent', confidence: 'strong', limit: last,
      reason: 'The partial integrals stopped changing at the working precision — the remaining differences are '
        + 'rounding noise, not the tail of the integral. That is evidence of convergence, not a proof of it.',
    };
  }

  const ratios = [];
  for (let i = 1; i < tail.length; i++) ratios.push(Math.abs(tail[i]) / Math.abs(tail[i - 1]));
  const meanRatio = ratios.reduce((s2, r) => s2 + r, 0) / ratios.length;
  // Count sign changes rather than demanding strict alternation. The cut-offs
  // move geometrically and an oscillatory integrand's period does not, so the
  // partial integrals of ∫sin(x)/x change sign often but not on every step.
  let signChanges = 0;
  for (let i = 1; i < tail.length; i++) if (Math.sign(tail[i]) !== Math.sign(tail[i - 1])) signChanges++;
  const alternating = signChanges >= Math.max(1, Math.floor((tail.length - 1) / 2));
  const relative = Math.abs(tail[tail.length - 1]) / Math.max(1e-30, Math.abs(last));

  if (alternating && meanRatio > 0.4) {
    return {
      verdict: 'oscillating', confidence: 'moderate', limit: last,
      reason: 'The partial integrals alternate above and below rather than settling. That is the signature of a '
        + 'conditionally convergent oscillatory integral such as ∫sin(x)/x — the limit exists, but it is reached by '
        + 'cancellation rather than by decay. Numerical quadrature over an infinite oscillatory range resolves fewer '
        + 'and fewer oscillations as the cut-off grows, so the value shown should not be trusted beyond a digit or two.',
    };
  }

  if (meanRatio > 0.999) {
    return {
      verdict: 'appears divergent', confidence: 'strong',
      reason: `Each step adds as much as the one before it — the increments are in a ratio of ${meanRatio.toFixed(4)}, `
        + 'which is not decaying at all. A sum of increments that do not shrink has no limit. This is what logarithmic '
        + 'divergence looks like: each individual addition is small, and there are infinitely many of them. '
        + 'Note the limit of the test: it cannot separate ∫x⁻¹ from ∫x⁻¹·⁰⁰⁰¹, because over any finite range of '
        + 'cut-offs those two really do behave identically.',
      meanRatio,
    };
  }

  if (meanRatio > 0.9) {
    return {
      verdict: 'too slow to tell', confidence: 'weak', limit: last,
      reason: `The increments are shrinking, but only in a ratio of ${meanRatio.toFixed(4)} per step — so slowly that the `
        + 'range of cut-offs examined here cannot distinguish a convergent integral from a divergent one. '
        + '∫₁^∞ x^(−1.01) converges to 100, and reaching even half of that needs a cut-off around 10³⁰. '
        + 'This is a real limit on what numerical evidence can settle, not a failure to try hard enough.',
      meanRatio,
    };
  }

  if (meanRatio < 0.9) {
    // Geometric decay of the increments is the ratio test, and the ratio test
    // is a theorem: increments in a ratio bounded below 1 sum to something
    // finite. What remains uncertain is whether the *observed* ratio really is
    // the eventual one, which is why this is still labelled as evidence.
    return {
      verdict: 'appears convergent', confidence: relative < 1e-4 ? 'strong' : 'moderate',
      reason: `The increments are shrinking geometrically, in a ratio of about ${meanRatio.toFixed(3)} per step, and the `
        + `last one was ${relative.toExponential(1)} of the value itself. Increments in a fixed ratio below 1 sum to `
        + 'something finite — that is the ratio test. The evidence is that the ratio observed here is the eventual one, '
        + 'which no finite window of partial integrals can establish.',
      meanRatio,
    };
  }

  return {
    verdict: 'inconclusive', confidence: 'weak', limit: last,
    reason: `The increments are in a ratio of about ${meanRatio.toFixed(3)} — shrinking, but not fast enough over the range `
      + 'examined to distinguish slow convergence from slow divergence. This is a genuinely hard case numerically, '
      + 'not an evasion: the two behaviours are indistinguishable from finitely many samples.',
    meanRatio,
  };
}

/** Convenience: everything the improper-integral panel needs, in one call. */
export function analyseImproper(f, a, b) {
  const kind = classify(f, Number.isFinite(a) ? a : (a < 0 ? -1e6 : 1e6), Number.isFinite(b) ? b : 1e6);
  const which = (b === Infinity) ? 'upper'
    : (a === -Infinity) ? 'lower'
      : kind.singularLower ? 'lower' : 'upper';

  const sequence = approachSequence(f, a, b, which);
  const verdict = diagnose(sequence);
  const value = improper(f, a, b);
  const warnings = [];
  if (!value.converged) {
    warnings.push('The quadrature did not reach its tolerance. The number shown is the best estimate it had when it stopped, '
      + 'and its accuracy is unknown.');
  }
  if (verdict.verdict === 'too slow to tell') {
    warnings.push('The convergence test could not reach a verdict: the tail decays too slowly for any finite set of '
      + 'cut-offs to distinguish convergence from divergence.');
  }
  if (verdict.verdict === 'appears divergent') {
    warnings.push('A divergent integral has no value. Any number the quadrature returns for it is an artefact of where '
      + 'the transformation stopped sampling, not an answer.');
  }
  return { kind, which, sequence, verdict, value, warnings };
}
