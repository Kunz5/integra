/**
 * montecarlo.js — integration by random sampling.
 *
 * Monte Carlo is the worst method here on a smooth one-dimensional integral and
 * the only practical one in high dimensions, and understanding why is worth
 * more than either fact alone.
 *
 * Its error falls as 1/√N, full stop. Not h², not h⁴ — 1/√N. A hundredfold
 * increase in samples buys one extra digit. Against Simpson's rule on a smooth
 * function that is a rout. But the exponent has no d in it: doubling the
 * accuracy costs 4× the samples in one dimension and 4× the samples in twenty,
 * whereas a grid rule needs 2^d times as many points per refinement and is
 * hopeless past about six dimensions. That crossing point is the whole reason
 * the method exists.
 *
 * What it does uniquely well is *report its own uncertainty*. The samples are
 * independent, so the sample variance is an estimate of the estimator's
 * variance, and the central limit theorem turns that into a confidence
 * interval. No deterministic rule gives you that for free — a Simpson estimate
 * comes with an error bound involving a fourth derivative you do not have.
 */

/**
 * A small deterministic generator, so an experiment can be repeated exactly.
 *
 * `Math.random` cannot be seeded, and an unrepeatable experiment is not an
 * experiment. This is mulberry32: one multiply-xorshift round, statistically
 * respectable for this purpose and short enough to read.
 */
export function rng(seed = 0x2f6e2b1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plain Monte Carlo: the mean of f over uniform samples, times the width.
 *
 * @returns value, standardError, a 95% interval, and the running estimate at a
 *          series of checkpoints so the convergence can be drawn.
 */
export function monteCarlo(f, a, b, n = 10000, options = {}) {
  const random = options.random ?? rng(options.seed ?? 12345);
  const width = b - a;
  const checkpoints = options.checkpoints ?? defaultCheckpoints(n);
  const trail = [];
  const keepPoints = options.keepPoints ?? 0;
  const points = [];

  let sum = 0, sumSq = 0, used = 0, skipped = 0;
  let nextCheck = 0;

  for (let i = 0; i < n; i++) {
    const x = a + width * random();
    const y = f(x);
    if (!Number.isFinite(y)) { skipped++; }
    else {
      sum += y;
      sumSq += y * y;
      used++;
      if (points.length < keepPoints) points.push({ x, y });
    }

    while (nextCheck < checkpoints.length && i + 1 === checkpoints[nextCheck]) {
      trail.push(snapshot(sum, sumSq, used, width, i + 1));
      nextCheck++;
    }
  }

  const final = snapshot(sum, sumSq, used, width, n);
  return { ...final, evaluations: n, skipped, trail, points };
}

function snapshot(sum, sumSq, used, width, n) {
  if (used === 0) return { n, value: NaN, standardError: NaN, ci95: [NaN, NaN], used };
  const mean = sum / used;
  // Sample variance with Bessel's correction. Using the population variance
  // here would understate the uncertainty, which is the one direction a
  // confidence interval must never be wrong in.
  const variance = used > 1 ? Math.max(0, (sumSq - used * mean * mean) / (used - 1)) : 0;
  const standardError = width * Math.sqrt(variance / used);
  const value = width * mean;
  return { n, value, standardError, ci95: [value - 1.96 * standardError, value + 1.96 * standardError], used };
}

function defaultCheckpoints(n) {
  const out = [];
  for (let k = 10; k < n; k = Math.ceil(k * 1.35)) out.push(k);
  out.push(n);
  return out;
}

/**
 * Stratified sampling: one uniform sample from each of N equal sub-intervals.
 *
 * The variance of the estimator is the *average within-stratum* variance rather
 * than the total variance, and stratifying removes the between-stratum part
 * entirely. On a smooth monotone function almost all the variance is
 * between-stratum, so this is a large win — the error falls as N^(-3/2) rather
 * than N^(-1/2) for a C¹ integrand.
 *
 * The price: the samples are no longer independent, so the plain sample
 * variance is no longer an honest estimate of the estimator's variance. The
 * standard error reported here is computed *across strata*, which is valid, and
 * this is exactly the kind of bookkeeping that gets quietly wrong in code that
 * copies a formula from the unstratified case.
 */
export function stratified(f, a, b, n = 10000, options = {}) {
  const random = options.random ?? rng(options.seed ?? 12345);
  const width = b - a;
  const h = width / n;
  let sum = 0, sumSq = 0, used = 0, skipped = 0;
  const points = [];
  const keepPoints = options.keepPoints ?? 0;

  for (let i = 0; i < n; i++) {
    const x = a + (i + random()) * h;
    const y = f(x);
    if (!Number.isFinite(y)) { skipped++; continue; }
    sum += y; sumSq += y * y; used++;
    if (points.length < keepPoints) points.push({ x, y });
  }
  if (!used) return { value: NaN, standardError: NaN, ci95: [NaN, NaN], evaluations: n, skipped, points };

  const mean = sum / used;
  const variance = used > 1 ? Math.max(0, (sumSq - used * mean * mean) / (used - 1)) : 0;
  // Each stratum contributes variance/n² to the total, and there are n of them.
  const standardError = (width / used) * Math.sqrt(variance);
  const value = width * mean;
  return {
    value, standardError, ci95: [value - 1.96 * standardError, value + 1.96 * standardError],
    evaluations: n, skipped, used, points,
  };
}

/**
 * Antithetic variates: pair every sample x with its mirror a + b − x.
 *
 * If f is monotone the two are negatively correlated, and the variance of their
 * mean is lower than the variance of two independent samples — for a linear
 * integrand it is exactly zero, because the pair straddles the mean perfectly.
 * A variance reduction that costs nothing but a sign.
 */
export function antithetic(f, a, b, n = 10000, options = {}) {
  const random = options.random ?? rng(options.seed ?? 12345);
  const width = b - a;
  const pairs = Math.max(1, Math.floor(n / 2));
  let sum = 0, sumSq = 0, used = 0, skipped = 0;
  const points = [];
  const keepPoints = options.keepPoints ?? 0;

  for (let i = 0; i < pairs; i++) {
    const u = random();
    const x1 = a + width * u, x2 = a + width * (1 - u);
    const y1 = f(x1), y2 = f(x2);
    if (!Number.isFinite(y1) || !Number.isFinite(y2)) { skipped += 2; continue; }
    const m = (y1 + y2) / 2;
    sum += m; sumSq += m * m; used++;
    if (points.length + 1 < keepPoints) { points.push({ x: x1, y: y1 }, { x: x2, y: y2 }); }
  }
  if (!used) return { value: NaN, standardError: NaN, ci95: [NaN, NaN], evaluations: pairs * 2, skipped, points };

  const mean = sum / used;
  const variance = used > 1 ? Math.max(0, (sumSq - used * mean * mean) / (used - 1)) : 0;
  const standardError = width * Math.sqrt(variance / used);
  const value = width * mean;
  return {
    value, standardError, ci95: [value - 1.96 * standardError, value + 1.96 * standardError],
    evaluations: pairs * 2, skipped, used, points,
  };
}

/**
 * Hit-or-miss in two dimensions — the picture everyone has of Monte Carlo.
 *
 * Throw darts at a rectangle containing the region and count what lands inside.
 * It is much *worse* than the mean-value method above — the variance of a
 * Bernoulli indicator is larger than the variance of f itself — and it is here
 * because it is the version you can see, and seeing it is the point.
 *
 * Signed areas are handled by counting a point below the axis and above f as a
 * negative hit, so this stays correct for a function that changes sign rather
 * than silently returning the area of |f|.
 */
export function hitOrMiss(f, a, b, n = 5000, options = {}) {
  const random = options.random ?? rng(options.seed ?? 999);
  const probeCount = Math.min(2000, Math.max(200, Math.floor(n / 4)));
  let lo = 0, hi = 0;
  for (let i = 0; i <= probeCount; i++) {
    const y = f(a + ((b - a) * i) / probeCount);
    if (!Number.isFinite(y)) continue;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const pad = Math.max(1e-9, (hi - lo) * 0.05);
  lo -= pad; hi += pad;

  const boxArea = (b - a) * (hi - lo);
  let hits = 0, valid = 0;
  const darts = [];
  const keep = options.keepPoints ?? 0;

  for (let i = 0; i < n; i++) {
    const x = a + (b - a) * random();
    const y = lo + (hi - lo) * random();
    const fx = f(x);
    if (!Number.isFinite(fx)) continue;
    valid++;
    let hit = 0;
    if (fx >= 0 && y >= 0 && y <= fx) hit = 1;
    else if (fx < 0 && y < 0 && y >= fx) hit = -1;
    hits += hit;
    if (darts.length < keep) darts.push({ x, y, hit });
  }

  const p = valid ? hits / valid : NaN;
  const value = boxArea * p;
  // Binomial standard error on the signed indicator.
  const variance = valid > 1 ? Math.max(0, (Math.abs(p) - p * p)) : 0;
  const standardError = boxArea * Math.sqrt(variance / Math.max(1, valid));
  return {
    value, standardError, ci95: [value - 1.96 * standardError, value + 1.96 * standardError],
    hits, valid, evaluations: n, box: { lo, hi, a, b, area: boxArea }, darts,
  };
}

export const MONTE_CARLO_METHODS = {
  uniform: {
    label: 'Monte Carlo (uniform)', run: monteCarlo,
    note: 'The mean of f over uniform random samples, times the width. Error falls as 1/√N regardless of dimension — hopeless here, indispensable in twenty dimensions.',
  },
  stratified: {
    label: 'Monte Carlo (stratified)', run: stratified,
    note: 'One sample per equal sub-interval. Removes the between-stratum variance entirely, which on a smooth function is nearly all of it.',
  },
  antithetic: {
    label: 'Monte Carlo (antithetic)', run: antithetic,
    note: 'Every sample paired with its mirror image. Negatively correlated on a monotone function, so the pair mean has lower variance than two independent samples.',
  },
};
