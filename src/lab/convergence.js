/*
  convergence.js: measuring how fast a method actually converges.
  ..................................................................

  Every rule in the library carries a theoretical order: the trapezoidal rule
  is O(h²), Simpson's is O(h⁴). Those are theorems, and they come with
  hypotheses; Simpson's h⁴ requires f to have a bounded fourth derivative on
  the whole interval. The interesting question is not what the theorem says but
  whether the hypothesis holds for *this* integrand, and the way to find out is
  to measure.

  The measurement is a straight line. If E(N) ≈ C·N^(−p) then

      log E = log C − p·log N

  so plotting error against N on log-log axes turns the convergence rate into a
  slope, and reading that slope off is a linear regression. Everything below is
  that idea, plus the care needed to avoid the two ways it lies: fitting the
  flat floor where round-off has taken over, and fitting a single pair of
  points and calling it a rate.
*/

import { FIXED_METHODS } from '../numeric/quadrature.js';
import { ADAPTIVE_METHODS, tanhSinh, gauss } from '../numeric/advanced.js';
import { finiteIntegral } from '../numeric/improper.js';

/**
 * A reference value good enough to measure other methods against.
 *
 * Anything used as "the exact answer" must be several orders more accurate than
 * the errors being measured, or the measurement is of the reference's error and
 * not the method's. An exact symbolic value is used when there is one; failing
 * that, tanh-sinh at full tolerance, cross-checked against high-order Gauss.
 * When the two disagree, that is reported rather than papered over, an
 * unreliable reference makes every error in the table meaningless, and the user
 * needs to know.
 */
export function reference(f, a, b, exactValue = null) {
  if (exactValue !== null && Number.isFinite(exactValue)) {
    return { value: exactValue, source: 'exact', trustworthy: true };
  }
  // Cross-checked: tanh-sinh alone is blind to an interior kink, and a
  // reference that is wrong makes every error measured against it meaningless.
  const ts = finiteIntegral(f, a, b, 1e-14);
  const gl = gauss(f, a, b, 200);
  const scale = Math.max(1e-14, Math.abs(ts.value));
  const agree = Math.abs(ts.value - gl.value) / scale;

  return {
    value: ts.value,
    source: 'numerical (tanh-sinh, 1e-14)',
    crossCheck: gl.value,
    agreement: agree,
    trustworthy: agree < 1e-9 && ts.converged,
    note: agree < 1e-9
      ? 'Tanh-sinh and 200-point Gauss-Legendre agree to better than 1 part in 10⁹, so the reference is sound.'
      : `Tanh-sinh and Gauss-Legendre disagree by ${agree.toExponential(1)} relative. The reference value cannot be `
        + 'trusted, and every error below is measured against it — treat the whole table as indicative only.',
  };
}

/**
 * Error of one method across a sweep of N.
 *
 * @returns {{ N: number, value: number, error: number, evaluations: number }[]}
 */
export function sweep(f, a, b, methodKey, ns, exact) {
  const method = FIXED_METHODS[methodKey];
  const out = [];
  for (const n of ns) {
    let r;
    if (method) r = method.run(f, a, b, n);
    else if (methodKey === 'gauss') r = gauss(f, a, b, n);
    else if (ADAPTIVE_METHODS[methodKey]) r = ADAPTIVE_METHODS[methodKey].run(f, a, b, { points: n, tolerance: Math.pow(10, -n / 4) });
    else continue;
    out.push({
      N: n,
      value: r.value,
      error: Math.abs(r.value - exact),
      relativeError: Math.abs(r.value - exact) / Math.max(1e-300, Math.abs(exact)),
      evaluations: r.evaluations,
    });
  }
  return out;
}

/** Powers-of-two style sweep, dense enough to fit a line through. */
export function defaultNs(max = 4096) {
  const out = [];
  for (let n = 2; n <= max; n = Math.round(n * Math.SQRT2)) {
    const even = n % 2 === 0 ? n : n + 1;
    if (!out.includes(even)) out.push(even);
  }
  return out;
}

/**
 * Fit E ≈ C·N^(−p) and return p, by least squares on the logarithms.
 *
 * The subtlety that makes or breaks this: **round-off sets a floor**. Once the
 * error reaches about 10⁻¹⁶ relative, refining further does not reduce it: it
 * increases it, because a finer grid means more terms in the sum and more
 * accumulated rounding. Fitting a line through that flat or rising tail returns
 * a slope near zero and reports that Simpson's rule is first-order, which is
 * nonsense produced by measuring the wrong thing.
 *
 * So the fit is restricted to the range where the error is genuinely falling
 * and still well above the floor, and how many points survived is reported
 * alongside the answer. A rate fitted to three points is not the same claim as
 * one fitted to twelve, and the interface says which it is.
 */
export function fitOrder(points, options = {}) {
  const floor = options.floor ?? 1e-14;
  const usable = points.filter((p) => Number.isFinite(p.error) && p.error > 0 && p.relativeError > floor);

  if (usable.length < 3) {
    return {
      order: null,
      points: usable.length,
      reason: usable.length === 0
        ? 'Every error in the sweep is at or below the round-off floor — the method reached machine precision '
          + 'immediately, so there is no convergence to measure.'
        : 'Fewer than three points lie above the round-off floor. A rate fitted to one or two points is a '
          + 'coincidence, not a measurement.',
    };
  }

  // Drop any trailing rise: past the floor, more points make things worse.
  const trimmed = [];
  let best = Infinity;
  for (const p of usable) {
    if (p.error > best * 3) break;
    best = Math.min(best, p.error);
    trimmed.push(p);
  }
  const fit = trimmed.length >= 3 ? trimmed : usable;

  const n = fit.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of fit) {
    const x = Math.log(p.N), y = Math.log(p.error);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-15) return { order: null, points: n, reason: 'All the sample sizes were the same — nothing to fit.' };

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  // R² on the log-log fit, so a curved relationship does not masquerade as a
  // clean power law.
  const meanY = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const p of fit) {
    const x = Math.log(p.N), y = Math.log(p.error);
    ssTot += (y - meanY) ** 2;
    ssRes += (y - (intercept + slope * x)) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return {
    order: -slope,
    constant: Math.exp(intercept),
    r2,
    points: n,
    range: [fit[0].N, fit[n - 1].N],
    reason: null,
  };
}

/**
 * Compare a measured order against the theoretical one, in words.
 *
 * This is deliberately the only place in INTEGRA that produces a sentence about
 * *why* a method behaved as it did, and it is careful to describe rather than
 * to assert. "The observed rate is close to the theoretical one" is a
 * statement about a measurement. "Simpson's rule is fourth-order" is a theorem
 * with hypotheses, and whether they hold here is exactly what was being tested.
 */
export function interpretOrder(measured, theoretical, methodLabel, r2) {
  if (measured === null) return null;
  const gap = measured - theoretical;

  if (r2 !== undefined && r2 < 0.9) {
    return `The measured rate is ${measured.toFixed(2)}, but the log-log fit is poor (R² = ${r2.toFixed(3)}) — `
      + 'the error is not following a clean power law at all, so no single order describes it. That usually means '
      + 'the integrand violates the smoothness the error analysis assumes somewhere in the interval.';
  }
  if (Math.abs(gap) < 0.25) {
    // Deliberately not "the integrand is smooth". A first-order rule matches its
    // predicted rate on √x too, because its error bound is the one that survives
    // an integrable singularity, matching does not certify the hypothesis, it
    // only says this rule is achieving what it claims here.
    return `The measured rate of ${measured.toFixed(2)} matches the ${theoretical} that the error analysis predicts for `
      + `${methodLabel}. Whatever this integrand does, it is not costing this rule any of its nominal order.`;
  }
  if (gap < -0.25) {
    return `The measured rate is ${measured.toFixed(2)}, below the ${theoretical} that ${methodLabel} achieves on a smooth `
      + `integrand. The error bound for this rule involves a higher derivative of f, and a rate this low is what happens `
      + `when that derivative is unbounded — a kink, a pole, or a singularity at an endpoint. The rule has not failed; `
      + `its hypothesis has.`;
  }
  return `The measured rate of ${measured.toFixed(2)} is *above* the predicted ${theoretical}, which happens for real `
    + `reasons rather than by luck: a periodic integrand over a whole number of periods makes the Euler-Maclaurin `
    + `error terms cancel, and a symmetric one can make the leading term vanish. Superconvergence like this is fragile; `
    + `it usually disappears the moment the interval or the function is perturbed.`;
}

/** Everything the convergence panel needs, for a set of methods at once. */
export function convergenceStudy(f, a, b, methodKeys, exactValue = null, options = {}) {
  const ref = reference(f, a, b, exactValue);
  const ns = options.ns ?? defaultNs(options.maxN ?? 2048);
  const series = [];

  for (const key of methodKeys) {
    const meta = FIXED_METHODS[key] ?? ADAPTIVE_METHODS[key] ?? { label: key, order: null };
    const points = sweep(f, a, b, key, ns, ref.value);
    const fit = fitOrder(points);
    series.push({
      key,
      label: meta.label,
      theoreticalOrder: meta.order ?? null,
      points,
      fit,
      interpretation: meta.order != null ? interpretOrder(fit.order, meta.order, meta.label, fit.r2) : null,
    });
  }

  return { reference: ref, ns, series };
}
