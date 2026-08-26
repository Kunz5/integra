/**
 * advanced.js — the methods that decide for themselves.
 *
 * The rules in `quadrature.js` all sample on a grid you choose in advance. The
 * four here choose instead:
 *
 *   Gauss-Legendre    optimal node placement — 2n−1 degree exactness from n points
 *   adaptive Simpson  subdivide only where the error estimate says to
 *   Romberg           extrapolate the trapezoidal rule's error away
 *   tanh-sinh         a change of variable that crushes endpoint singularities
 *
 * All four are implemented from their definitions. The Gauss-Legendre nodes in
 * particular are *computed*, by Newton's method on the Legendre polynomials,
 * not copied from a table — which is the difference between a program that has
 * the numbers and one that knows where they come from.
 */

// ── Gauss-Legendre ──────────────────────────────────────────────────────────

const legendreCache = new Map();

/**
 * Nodes and weights for n-point Gauss-Legendre quadrature on [−1, 1].
 *
 * The nodes are the roots of the Legendre polynomial Pₙ, found by Newton
 * iteration from Tricomi's asymptotic starting guess — which is close enough
 * that three or four iterations converge to machine precision. Pₙ and its
 * derivative come from the standard three-term recurrences:
 *
 *   (n+1)·Pₙ₊₁(x) = (2n+1)·x·Pₙ(x) − n·Pₙ₋₁(x)
 *   (1 − x²)·P′ₙ(x) = n·(Pₙ₋₁(x) − x·Pₙ(x))
 *
 * and the weight at each root is  wᵢ = 2 / ((1 − xᵢ²)·P′ₙ(xᵢ)²).
 *
 * Why this is worth the trouble: n samples placed *here* integrate every
 * polynomial up to degree 2n−1 exactly. Ten function evaluations give what the
 * trapezoidal rule would need tens of thousands for — on a smooth integrand.
 * On a kinked or oscillatory one, that advantage evaporates, which is what the
 * pathological lab is for.
 */
export function legendre(n) {
  if (legendreCache.has(n)) return legendreCache.get(n);

  const nodes = new Float64Array(n);
  const weights = new Float64Array(n);
  const m = (n + 1) >> 1;                         // roots are symmetric about 0

  for (let i = 0; i < m; i++) {
    // Tricomi's approximation to the i-th root.
    let x = Math.cos(Math.PI * (i + 0.75) / (n + 0.5));
    let p = 0, dp = 0;

    for (let iter = 0; iter < 100; iter++) {
      let p0 = 1, p1 = 0;
      for (let j = 0; j < n; j++) {
        const p2 = p1;
        p1 = p0;
        p0 = ((2 * j + 1) * x * p1 - j * p2) / (j + 1);
      }
      p = p0;
      dp = (n * (x * p0 - p1)) / (x * x - 1);
      const dx = -p / dp;
      x += dx;
      if (Math.abs(dx) < 1e-15) break;
    }

    nodes[i] = -x;
    nodes[n - 1 - i] = x;
    const w = 2 / ((1 - x * x) * dp * dp);
    weights[i] = w;
    weights[n - 1 - i] = w;
  }

  const out = { nodes, weights };
  legendreCache.set(n, out);
  return out;
}

/**
 * n-point Gauss-Legendre on [a, b], by the affine map from [−1, 1].
 */
export function gauss(f, a, b, n = 10) {
  const { nodes, weights } = legendre(Math.max(1, Math.min(512, Math.round(n))));
  const half = (b - a) / 2, mid = (a + b) / 2;
  let sum = 0, evaluations = 0, skipped = 0;
  for (let i = 0; i < nodes.length; i++) {
    const y = f(mid + half * nodes[i]);
    evaluations++;
    if (!Number.isFinite(y)) { skipped++; continue; }
    sum += weights[i] * y;
  }
  return { value: sum * half, evaluations, skipped, points: nodes.length };
}

// ── adaptive Simpson ────────────────────────────────────────────────────────

/**
 * Adaptive Simpson with Richardson error control.
 *
 * On each interval, compare Simpson's estimate against the sum of Simpson's
 * estimates on the two halves. For a fourth-order rule the difference between
 * them is about 15 times the error in the finer one, so |S₂ − S₁|/15 is an
 * error estimate that costs nothing beyond the samples already taken. If it is
 * within the local tolerance, accept S₂ plus that correction — which is a free
 * upgrade to sixth order. Otherwise split and recurse on each half with half
 * the tolerance.
 *
 * This is where the effort goes to where the function is difficult, which is
 * the entire point: a spike on one thousandth of the interval costs a fixed
 * rule a thousandfold refinement everywhere, and costs this one a few dozen
 * extra evaluations in the neighbourhood of the spike.
 *
 * The recursion depth cap is what stops it grinding forever on a true
 * singularity. Hitting it is reported, not hidden — a result that exhausted its
 * depth is a result you should not trust to its stated tolerance.
 */
export function adaptiveSimpson(f, a, b, tolerance = 1e-10, maxDepth = 50, maxEvaluations = 200000) {
  let evaluations = 0;
  const g = (x) => { evaluations++; const y = f(x); return Number.isFinite(y) ? y : NaN; };

  const intervals = [];
  const MAX_RECORDED = 4000;      // the list is for drawing, not for arithmetic
  let depthExceeded = false;
  let budgetExceeded = false;
  let nanSeen = false;

  const simpsonOn = (x0, x2, y0, y1, y2) => ((x2 - x0) / 6) * (y0 + 4 * y1 + y2);

  const recurse = (x0, x2, y0, y1, y2, whole, tol, depth) => {
    // An adaptive method without a budget is unbounded. Handed sin(x)/x over
    // [10⁷, 10⁸] it will try to resolve sixteen million oscillations, and the
    // recursion consumes the machine before the depth cap ever bites — depth 50
    // permits 2⁵⁰ intervals. Stopping at a stated number of evaluations and
    // saying so is the only safe behaviour; silently grinding is not.
    if (evaluations > maxEvaluations) {
      budgetExceeded = true;
      return whole;
    }
    const xm = (x0 + x2) / 2;
    const xl = (x0 + xm) / 2, xr = (xm + x2) / 2;
    const yl = g(xl), yr = g(xr);
    if (Number.isNaN(yl) || Number.isNaN(yr)) nanSeen = true;

    const left = simpsonOn(x0, xm, y0, yl, y1);
    const right = simpsonOn(xm, x2, y1, yr, y2);
    const delta = left + right - whole;

    if (depth >= maxDepth) {
      depthExceeded = true;
      if (intervals.length < MAX_RECORDED) intervals.push({ a: x0, b: x2, depth, error: Math.abs(delta) / 15 });
      return left + right + delta / 15;
    }
    if (Math.abs(delta) <= 15 * tol) {
      if (intervals.length < MAX_RECORDED) intervals.push({ a: x0, b: x2, depth, error: Math.abs(delta) / 15 });
      // The +delta/15 is Richardson extrapolation: it cancels the leading error
      // term, turning a fourth-order estimate into a sixth-order one.
      return left + right + delta / 15;
    }
    return recurse(x0, xm, y0, yl, y1, left, tol / 2, depth + 1)
         + recurse(xm, x2, y1, yr, y2, right, tol / 2, depth + 1);
  };

  const y0 = g(a), y2 = g(b), y1 = g((a + b) / 2);

  // A closed rule samples its endpoints, and this one has just found that it
  // cannot. Returning NaN with a reason is the correct outcome: the honest
  // alternatives are to nudge the endpoint (which silently integrates a
  // *different* function) or to read the singular sample as zero (which
  // fabricates a value and returns a confident wrong answer). The interface
  // turns this into the suggestion to use tanh-sinh, which is the method that
  // genuinely handles it.
  if (Number.isNaN(y0) || Number.isNaN(y2)) {
    return {
      value: NaN,
      evaluations,
      intervals: [],
      depthExceeded: false,
      nanSeen: true,
      failedAtEndpoint: Number.isNaN(y0) ? a : b,
      reason: `The integrand has no finite value at x = ${Number.isNaN(y0) ? a : b}, and Simpson's rule `
        + 'is a closed rule — it must sample both endpoints. This integral is improper at that end. '
        + 'Tanh-sinh quadrature never evaluates the endpoints and handles it directly.',
      estimatedError: NaN,
    };
  }
  if (Number.isNaN(y1)) nanSeen = true;

  const whole = simpsonOn(a, b, y0, y1, y2);
  const value = recurse(a, b, y0, y1, y2, whole, tolerance, 0);

  return {
    value,
    evaluations,
    intervals,
    depthExceeded,
    budgetExceeded,
    nanSeen,
    reason: budgetExceeded
      ? `The subdivision reached its budget of ${maxEvaluations} evaluations without meeting the tolerance. `
        + 'The value returned is the best estimate at that point and its accuracy is unknown — this happens when the '
        + 'integrand has more structure than any finite number of samples can resolve.'
      : nanSeen
        ? 'Some interior samples had no finite value and were left out of the sum. Treat this result with suspicion.'
        : undefined,
    estimatedError: intervals.reduce((s, i) => s + i.error, 0),
  };
}

// ── Romberg ─────────────────────────────────────────────────────────────────

/**
 * Romberg integration: Richardson extrapolation applied to the trapezoidal rule.
 *
 * The trapezoidal rule's error has an expansion in even powers of h — the
 * Euler-Maclaurin formula — so it is c₂h² + c₄h⁴ + c₆h⁶ + …  Compute T(h) and
 * T(h/2), and the combination (4T(h/2) − T(h))/3 kills the h² term exactly.
 * That result has an h⁴ error; do it again to kill that, and again. Each column
 * of the table gains two orders, and column k is a rule of order 2k+2.
 *
 * The trapezoidal values themselves are built by *halving*, which reuses every
 * sample already taken: the new points are only the midpoints of the existing
 * strips. So the whole table costs 2^k + 1 evaluations, not k times that.
 *
 * On a smooth periodic function this converges spectacularly. On one with a
 * singularity at an endpoint the Euler-Maclaurin expansion does not hold and
 * the extrapolation is meaningless — the table stops improving and the returned
 * error estimate says so.
 */
export function romberg(f, a, b, maxLevels = 16, tolerance = 1e-13) {
  let evaluations = 0;
  const g = (x) => { evaluations++; const y = f(x); return Number.isFinite(y) ? y : NaN; };

  const table = [];
  let h = b - a;
  const fa = g(a), fb = g(b);
  const finite = (y) => (Number.isNaN(y) ? 0 : y);
  table.push([(h / 2) * (finite(fa) + finite(fb))]);

  for (let k = 1; k < maxLevels; k++) {
    h /= 2;
    // Only the new midpoints; every earlier sample is already in T(2h).
    let sum = 0;
    const count = 1 << (k - 1);
    for (let i = 1; i <= count; i++) sum += finite(g(a + (2 * i - 1) * h));
    const row = [table[k - 1][0] / 2 + h * sum];

    for (let j = 1; j <= k; j++) {
      const p = Math.pow(4, j);
      row.push((p * row[j - 1] - table[k - 1][j - 1]) / (p - 1));
    }
    table.push(row);

    const best = row[row.length - 1];
    const prev = table[k - 1][table[k - 1].length - 1];
    if (k >= 3 && Math.abs(best - prev) <= tolerance * Math.max(1, Math.abs(best))) {
      return { value: best, table, evaluations, levels: k + 1, converged: true, estimatedError: Math.abs(best - prev) };
    }
  }

  const last = table[table.length - 1];
  const prev = table[table.length - 2];
  return {
    value: last[last.length - 1],
    table,
    evaluations,
    levels: table.length,
    converged: false,
    estimatedError: Math.abs(last[last.length - 1] - prev[prev.length - 1]),
  };
}

// ── tanh-sinh (double exponential) ──────────────────────────────────────────

/**
 * Tanh-sinh quadrature — the right tool for an endpoint singularity.
 *
 * Substitute x = tanh(½π·sinh t). As t runs over the whole real line, x sweeps
 * (−1, 1), and the Jacobian decays *doubly* exponentially at both ends. Two
 * things follow. The endpoints are never actually evaluated, so a singularity
 * at a or b is simply not sampled. And the transformed integrand dies so fast
 * that the plain trapezoidal rule on a uniform t-grid converges at a rate no
 * polynomial rule reaches.
 *
 * This is how ∫₀¹ dx/√x — where Simpson's rule flounders because the fourth
 * derivative is unbounded — gets fifteen correct digits from a few hundred
 * evaluations.
 */
export function tanhSinh(f, a, b, tolerance = 1e-13, maxLevel = 14) {
  let evaluations = 0;
  const g = (x) => { evaluations++; const y = f(x); return Number.isFinite(y) ? y : NaN; };

  const c = (a + b) / 2, half = (b - a) / 2;
  const HALF_PI = Math.PI / 2;

  /**
   * One symmetric pair of abscissae, summed together.
   *
   * The subtlety that decides whether this method is worth anything: the node
   * nearest an endpoint is at 1 − x ≈ 10⁻¹⁶, and computing it as `c + half·x`
   * rounds it *onto* the endpoint — straight into the singularity the whole
   * transformation exists to avoid. So the distance from the endpoint is
   * carried directly, as 1 − tanh u = 2/(1 + e^{2u}), which stays exact all the
   * way down to underflow, and the two mirrored points are evaluated from their
   * own ends of the interval.
   */
  const pair = (t) => {
    const u = HALF_PI * Math.sinh(t);
    const e2u = Math.exp(2 * u);
    const dist = 2 / (1 + e2u);                       // = 1 − tanh u, exactly
    if (!Number.isFinite(dist) || dist === 0) return { sum: 0, alive: false };

    const ch = Math.cosh(u);
    const w = (HALF_PI * Math.cosh(t)) / (ch * ch);   // dx/dt
    if (!Number.isFinite(w) || w === 0) return { sum: 0, alive: false };

    const yHigh = g(b - half * dist);
    const yLow = g(a + half * dist);
    const contribution =
      (Number.isNaN(yHigh) ? 0 : yHigh) + (Number.isNaN(yLow) ? 0 : yLow);
    return { sum: contribution * w, alive: true, sampled: !Number.isNaN(yHigh) || !Number.isNaN(yLow) };
  };

  const centre = () => {
    const y = g(c);
    return (Number.isNaN(y) ? 0 : y) * HALF_PI;
  };

  let h = 1;
  let sum = centre();
  for (let k = 1; ; k++) {
    const p = pair(k * h);
    if (!p.alive) break;
    sum += p.sum;
    if (k > 1000) break;
  }
  let prev = sum * h * half;

  for (let level = 1; level <= maxLevel; level++) {
    h /= 2;
    for (let k = 1; ; k += 2) {
      const p = pair(k * h);
      if (!p.alive) break;
      sum += p.sum;
      if (k > 20000) break;
    }
    const value = sum * h * half;
    const diff = Math.abs(value - prev);
    if (level >= 3 && diff <= tolerance * Math.max(1, Math.abs(value))) {
      return { value, evaluations, levels: level + 1, converged: true, estimatedError: diff };
    }
    prev = value;
  }
  return { value: prev, evaluations, levels: maxLevel + 1, converged: false, estimatedError: NaN };
}

// ── registry ────────────────────────────────────────────────────────────────

export const ADAPTIVE_METHODS = {
  gauss: {
    label: 'Gauss-Legendre', run: (f, a, b, opt = {}) => gauss(f, a, b, opt.points ?? 20),
    note: 'Nodes at the roots of the Legendre polynomial, computed here by Newton iteration. n points integrate degree 2n−1 exactly — the best any n-sample rule can do.',
  },
  adaptive: {
    label: 'Adaptive Simpson', run: (f, a, b, opt = {}) => adaptiveSimpson(f, a, b, opt.tolerance ?? 1e-10),
    note: 'Splits an interval only when its own error estimate demands it, so the samples go where the function is difficult.',
  },
  romberg: {
    label: 'Romberg', run: (f, a, b, opt = {}) => romberg(f, a, b, opt.levels ?? 16, opt.tolerance ?? 1e-13),
    note: 'Extrapolates the trapezoidal rule against its own h² error expansion. Each column of the table gains two orders of accuracy.',
  },
  tanhsinh: {
    label: 'Tanh-sinh', run: (f, a, b, opt = {}) => tanhSinh(f, a, b, opt.tolerance ?? 1e-13),
    note: 'A double-exponential change of variable. Never samples the endpoints, so an endpoint singularity costs it nothing.',
  },
};
