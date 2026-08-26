/**
 * quadrature.js — the classical fixed-rule methods.
 *
 * Every rule here is a weighted sum of samples, and every one is implemented
 * from its definition rather than called out to. The differences between them
 * are the whole subject: what changes is where the samples go and what weights
 * they carry, and that single choice is worth two, four, or in the Gaussian
 * case 2n orders of accuracy.
 *
 * Shared contract for every routine:
 *   · returns { value, evaluations, samples }
 *   · a sample that is not finite is *not* silently replaced by zero — it is
 *     counted, reported, and left out of the sum, and the caller is told. An
 *     integrator that quietly reads NaN as 0 will return a confident, precise,
 *     wrong number for ∫₀¹ dx/√x, and that is the single most dangerous thing a
 *     numerical tool can do.
 */

/** @typedef {(x: number) => number} RealFunction */

function guard(f) {
  return (x) => {
    const y = f(x);
    return Number.isFinite(y) ? y : NaN;
  };
}

/**
 * Riemann sum with the sample taken at a fixed position within each strip.
 *
 * @param {RealFunction} f
 * @param {number} a
 * @param {number} b
 * @param {number} n      number of strips
 * @param {'left'|'right'|'mid'} where
 */
export function riemann(f, a, b, n, where = 'left') {
  const g = guard(f);
  const h = (b - a) / n;
  const offset = where === 'left' ? 0 : where === 'right' ? 1 : 0.5;
  let sum = 0, evaluations = 0, skipped = 0;
  for (let i = 0; i < n; i++) {
    const x = a + (i + offset) * h;
    const y = g(x);
    evaluations++;
    if (Number.isNaN(y)) { skipped++; continue; }
    sum += y;
  }
  return { value: sum * h, evaluations, skipped, h };
}

/**
 * Trapezoidal rule: straight lines between consecutive samples.
 *
 * Second-order — halving h quarters the error — and exact for anything linear.
 * The endpoints carry half weight because each interior sample is shared by the
 * two strips on either side of it.
 */
export function trapezoid(f, a, b, n) {
  const g = guard(f);
  const h = (b - a) / n;
  let sum = 0, evaluations = 0, skipped = 0;
  for (let i = 0; i <= n; i++) {
    const y = g(a + i * h);
    evaluations++;
    if (Number.isNaN(y)) { skipped++; continue; }
    sum += (i === 0 || i === n) ? y / 2 : y;
  }
  return { value: sum * h, evaluations, skipped, h };
}

/**
 * Simpson's 1/3 rule: a parabola through each consecutive triple of samples.
 *
 * The 1-4-2-4-…-4-1 weights are what integrating that parabola exactly gives.
 * It is fourth-order, and — this is the part worth noticing — exact for cubics
 * as well as quadratics, because the error term involves the fourth derivative
 * and a cubic's fourth derivative is zero. Two orders of accuracy for free.
 *
 * Needs an even number of strips; an odd `n` is rounded up, and the caller is
 * told rather than silently given a different rule's answer.
 */
export function simpson(f, a, b, n) {
  const g = guard(f);
  const adjusted = n % 2 === 0 ? n : n + 1;
  const h = (b - a) / adjusted;
  let sum = 0, evaluations = 0, skipped = 0;
  for (let i = 0; i <= adjusted; i++) {
    const y = g(a + i * h);
    evaluations++;
    if (Number.isNaN(y)) { skipped++; continue; }
    const w = (i === 0 || i === adjusted) ? 1 : (i % 2 === 1 ? 4 : 2);
    sum += w * y;
  }
  return { value: (sum * h) / 3, evaluations, skipped, h, adjustedN: adjusted !== n ? adjusted : undefined };
}

/**
 * Simpson's 3/8 rule: a cubic through each consecutive quadruple.
 *
 * Also fourth-order — it is *not* more accurate than the 1/3 rule despite using
 * a higher-degree interpolant, which surprises people. Its constant is slightly
 * worse per interval. It earns its place by needing a multiple of three strips
 * rather than two, which is how a composite rule closes out an odd remainder.
 */
export function simpson38(f, a, b, n) {
  const g = guard(f);
  const adjusted = n % 3 === 0 ? n : n + (3 - (n % 3));
  const h = (b - a) / adjusted;
  let sum = 0, evaluations = 0, skipped = 0;
  for (let i = 0; i <= adjusted; i++) {
    const y = g(a + i * h);
    evaluations++;
    if (Number.isNaN(y)) { skipped++; continue; }
    const w = (i === 0 || i === adjusted) ? 1 : (i % 3 === 0 ? 2 : 3);
    sum += w * y;
  }
  return { value: (sum * h * 3) / 8, evaluations, skipped, h, adjustedN: adjusted !== n ? adjusted : undefined };
}

/**
 * The rectangles or trapezia a Riemann-type rule actually uses, for drawing.
 *
 * Returned as geometry rather than re-derived by the renderer, so that what is
 * on screen is guaranteed to be the shapes that were summed. A picture that
 * disagrees with the arithmetic is worse than no picture.
 */
export function strips(f, a, b, n, method) {
  const g = guard(f);
  const h = (b - a) / n;
  const out = [];
  if (method === 'trapezoid') {
    for (let i = 0; i < n; i++) {
      const x0 = a + i * h, x1 = x0 + h;
      out.push({ x0, x1, y0: g(x0), y1: g(x1), kind: 'trapezoid' });
    }
    return out;
  }
  if (method === 'simpson' || method === 'simpson38') {
    const span = method === 'simpson' ? 2 : 3;
    const adjusted = n % span === 0 ? n : n + (span - (n % span));
    const hh = (b - a) / adjusted;
    for (let i = 0; i < adjusted; i += span) {
      const xs = [], ys = [];
      for (let j = 0; j <= span; j++) { const x = a + (i + j) * hh; xs.push(x); ys.push(g(x)); }
      out.push({ x0: xs[0], x1: xs[span], xs, ys, kind: method });
    }
    return out;
  }
  const offset = method === 'right' ? 1 : method === 'mid' ? 0.5 : 0;
  for (let i = 0; i < n; i++) {
    const x0 = a + i * h, x1 = x0 + h;
    const xs = a + (i + offset) * h;
    out.push({ x0, x1, xs, y: g(xs), kind: 'rect' });
  }
  return out;
}

/** Every fixed rule, by key, with the metadata the interface needs. */
export const FIXED_METHODS = {
  left: {
    label: 'Left Riemann', order: 1, run: (f, a, b, n) => riemann(f, a, b, n, 'left'),
    note: 'Each strip takes the height at its left edge. First-order: halving the width halves the error.',
  },
  right: {
    label: 'Right Riemann', order: 1, run: (f, a, b, n) => riemann(f, a, b, n, 'right'),
    note: 'Height at the right edge. Mirror image of the left rule, and it errs the opposite way on a monotone function — which is why averaging the two gives the trapezoidal rule.',
  },
  mid: {
    label: 'Midpoint', order: 2, run: (f, a, b, n) => riemann(f, a, b, n, 'mid'),
    note: 'Height at the centre. Second-order, and usually beats the trapezoidal rule by a factor of two: the overshoot on one side of the midpoint cancels the undershoot on the other.',
  },
  trapezoid: {
    label: 'Trapezoidal', order: 2, run: trapezoid,
    note: 'Straight lines between samples. Second-order. Exact for any linear function.',
  },
  simpson: {
    label: "Simpson's 1/3", order: 4, run: simpson,
    note: 'Parabolas through consecutive triples. Fourth-order, and exact for cubics too — the error term involves the fourth derivative, which a cubic does not have.',
  },
  simpson38: {
    label: "Simpson's 3/8", order: 4, run: simpson38,
    note: 'Cubics through consecutive quadruples. Also fourth-order — a higher-degree interpolant does not buy extra order here — with a slightly worse constant.',
  },
};
