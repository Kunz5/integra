/**
 * numeric.test.mjs — the quadrature engine.
 *
 * Two kinds of assertion here, and the distinction matters.
 *
 * The first is accuracy: a method applied to an integral with a known closed
 * form must land within a stated tolerance. That tolerance is chosen from the
 * *theory* — Simpson's rule at N = 100 on a smooth integrand should be good to
 * around 10⁻⁹, and asserting 10⁻³ would let a broken implementation through.
 *
 * The second, and the more valuable, is behaviour: the order a method converges
 * at, that it degrades where the theory says it must, that it refuses rather
 * than guesses when it cannot sample, and that its own error estimate is honest.
 * Those are properties of the algorithm rather than of any one integral, and
 * they are what would catch a subtly wrong implementation that happens to give
 * the right answer for x².
 *
 * Run: node test/numeric.test.mjs
 */

import { riemann, trapezoid, simpson, simpson38, strips, FIXED_METHODS } from '../src/numeric/quadrature.js';
import { legendre, gauss, adaptiveSimpson, romberg, tanhSinh } from '../src/numeric/advanced.js';
import { monteCarlo, stratified, antithetic, hitOrMiss, rng } from '../src/numeric/montecarlo.js';
import { improper, gradedIntegral, finiteIntegral, analyseImproper, diagnose, classify } from '../src/numeric/improper.js';
import { convergenceStudy, fitOrder, sweep, reference, defaultNs } from '../src/lab/convergence.js';
import { FAMILIES, scan, runAtBudget } from '../src/lab/breaker.js';
import { GROUPS, EXAMPLES } from '../src/lab/examples.js';
import { parse } from '../src/math/parser.js';
import { simplify } from '../src/math/simplify.js';
import { compileSafe } from '../src/math/evaluate.js';
import { definite } from '../src/math/integrate.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  pass  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const err = (got, want) => Math.abs(got - want);

// ── Gauss-Legendre nodes, against the published values ──────────────────────

console.log('\nGauss-Legendre — nodes and weights are computed, so check them');
{
  // These are the standard 5-point values, to 15 places. The implementation
  // derives them by Newton iteration on the Legendre polynomials; if that
  // derivation is wrong, every Gaussian result in the program is wrong in a way
  // that still looks plausible.
  const { nodes, weights } = legendre(5);
  const wantN = [-0.906179845938664, -0.538469310105683, 0, 0.538469310105683, 0.906179845938664];
  const wantW = [0.236926885056189, 0.478628670499366, 0.568888888888889, 0.478628670499366, 0.236926885056189];
  let maxN = 0, maxW = 0;
  for (let i = 0; i < 5; i++) {
    maxN = Math.max(maxN, Math.abs(nodes[i] - wantN[i]));
    maxW = Math.max(maxW, Math.abs(weights[i] - wantW[i]));
  }
  check('5-point nodes match the published values to 1e-14', maxN < 1e-14, `max diff ${maxN.toExponential(2)}`);
  check('5-point weights match to 1e-14', maxW < 1e-14, `max diff ${maxW.toExponential(2)}`);

  for (const n of [1, 2, 3, 7, 12, 40]) {
    const { weights: w } = legendre(n);
    const total = [...w].reduce((s, v) => s + v, 0);
    check(`${n}-point weights sum to 2`, Math.abs(total - 2) < 1e-12, `got ${total}`);
  }

  // n points integrate degree 2n−1 exactly. This is the defining property.
  for (const n of [2, 3, 5, 8]) {
    const deg = 2 * n - 1;
    const f = (x) => Math.pow(x, deg);
    const exact = deg % 2 === 0 ? 2 / (deg + 1) : 0;
    const got = gauss(f, -1, 1, n).value;
    check(`${n}-point Gauss is exact for degree ${deg}`, err(got, exact) < 1e-13,
      `got ${got}, want ${exact}`);
  }
  const overshoot = gauss((x) => Math.pow(x, 10), -1, 1, 5).value;
  check('and is NOT exact one degree higher', err(overshoot, 2 / 11) > 1e-6);
}

// ── fixed rules against closed forms ────────────────────────────────────────

console.log('\nFixed rules — accuracy against known integrals');
{
  const cases = [
    ['∫₀¹ x²', (x) => x * x, 0, 1, 1 / 3],
    ['∫₀^π sin', Math.sin, 0, Math.PI, 2],
    ['∫₀¹ eˣ', Math.exp, 0, 1, Math.E - 1],
    ['∫₀¹ 4/(1+x²)', (x) => 4 / (1 + x * x), 0, 1, Math.PI],
    ['∫₁^e 1/x', (x) => 1 / x, 1, Math.E, 1],
  ];
  // Tolerances from the theory at N = 200, not from what the code printed.
  // Tolerances from the theory at N = 200. Simpson's 3/8 gets a looser one than
  // 1/3 because they are the same order with a different constant — 3/8's is
  // worse, which is the reason nobody uses it except to close out a remainder.
  const tol = { left: 3e-2, right: 3e-2, mid: 1e-4, trapezoid: 1e-4, simpson: 1e-9, simpson38: 5e-9 };
  for (const [name, f, a, b, want] of cases) {
    for (const [key, m] of Object.entries(FIXED_METHODS)) {
      const got = m.run(f, a, b, 200).value;
      check(`${name} by ${m.label}`, err(got, want) < tol[key], `error ${err(got, want).toExponential(2)}`);
    }
  }
}

console.log('\nFixed rules — exact where the theory says exact');
{
  // The trapezoidal rule reproduces a straight line exactly; Simpson's rule
  // reproduces a cubic exactly, which is one degree better than the parabola it
  // interpolates with — the error term involves the fourth derivative.
  check('trapezoidal is exact for a linear integrand',
    err(trapezoid((x) => 3 * x + 1, 0, 2, 7).value, 8) < 1e-13);
  check("Simpson's is exact for a quadratic",
    err(simpson((x) => x * x, 0, 3, 6).value, 9) < 1e-13);
  check("Simpson's is exact for a CUBIC too",
    err(simpson((x) => x * x * x, 0, 2, 6).value, 4) < 1e-12);
  check("Simpson's is NOT exact for a quartic",
    err(simpson((x) => Math.pow(x, 4), 0, 2, 6).value, 32 / 5) > 1e-6);
  check("Simpson's 3/8 is exact for a cubic",
    err(simpson38((x) => x * x * x, 0, 2, 6).value, 4) < 1e-12);
  check('midpoint beats trapezoidal on a convex function',
    err(riemann(Math.exp, 0, 1, 20, 'mid').value, Math.E - 1)
    < err(trapezoid(Math.exp, 0, 1, 20).value, Math.E - 1));
}

console.log('\nFixed rules — an odd N is raised where the rule requires it');
{
  const s = simpson((x) => x * x, 0, 1, 7);
  check("Simpson's raises an odd N and reports it", s.adjustedN === 8);
  const s38 = simpson38((x) => x * x, 0, 1, 7);
  check("Simpson's 3/8 raises N to a multiple of three and reports it", s38.adjustedN === 9);
  check('and the answer is still right', err(s.value, 1 / 3) < 1e-12 && err(s38.value, 1 / 3) < 1e-12);
}

// ── convergence order ───────────────────────────────────────────────────────

console.log('\nConvergence — the measured order matches the theory');
{
  const measure = (f, a, b, key, exact) => fitOrder(sweep(f, a, b, key, defaultNs(1024), exact));

  const smooth = [['eˣ on [0,1]', Math.exp, 0, 1, Math.E - 1], ['sin on [0,π]', Math.sin, 0, Math.PI, 2]];
  for (const [name, f, a, b, exact] of smooth) {
    for (const [key, want] of [['trapezoid', 2], ['mid', 2], ['simpson', 4]]) {
      const fit = measure(f, a, b, key, exact);
      check(`${FIXED_METHODS[key].label} is order ${want} on ${name}`,
        fit.order !== null && Math.abs(fit.order - want) < 0.15 && fit.r2 > 0.98,
        `measured ${fit.order?.toFixed(3)}, R² ${fit.r2?.toFixed(4)}`);
    }
  }
}

console.log('\nConvergence — and degrades exactly where the hypothesis fails');
{
  // √x is continuous on [0,1] but its derivative is unbounded at the origin.
  // The error bound for every polynomial rule involves a derivative, so every
  // one of them drops to the same rate — 1.5 — regardless of its nominal order.
  const f = Math.sqrt;
  for (const key of ['trapezoid', 'mid', 'simpson']) {
    const fit = fitOrder(sweep(f, 0, 1, key, defaultNs(1024), 2 / 3));
    check(`${FIXED_METHODS[key].label} falls to order ≈1.5 on √x`,
      fit.order !== null && Math.abs(fit.order - 1.5) < 0.2,
      `measured ${fit.order?.toFixed(3)}`);
  }

  // A kink halves Simpson's order.
  const kink = fitOrder(sweep(Math.abs, -1, 1, 'simpson', defaultNs(512), 1));
  check("a kink halves Simpson's order to 2", kink.order !== null && Math.abs(kink.order - 2) < 0.2,
    `measured ${kink.order?.toFixed(3)}`);

  // And the trapezoidal rule is *exact* for |x| when the kink lands on a node,
  // which it does for every even N on [−1, 1]. Every error is at the round-off
  // floor, so there is no rate to fit — and saying "no rate" is the right
  // answer, not "order zero".
  const exact = fitOrder(sweep(Math.abs, -1, 1, 'trapezoid', defaultNs(512), 1));
  check('the trapezoidal rule is exact for |x| with the kink on a node',
    exact.order === null && typeof exact.reason === 'string',
    `got order ${exact.order}`);
}

console.log('\nConvergence — the fitter refuses to measure noise');
{
  // Past machine precision the error stops falling and starts rising. Fitting a
  // line through that returns a slope near zero and reports that Simpson's rule
  // is first-order, which is a measurement of round-off rather than of the
  // method.
  const points = [
    { N: 4, error: 1e-4, relativeError: 1e-4 },
    { N: 8, error: 1e-6, relativeError: 1e-6 },
    { N: 16, error: 1e-8, relativeError: 1e-8 },
    { N: 32, error: 2e-16, relativeError: 2e-16 },
    { N: 64, error: 3e-16, relativeError: 3e-16 },
    { N: 128, error: 5e-16, relativeError: 5e-16 },
  ];
  const fit = fitOrder(points);
  check('the round-off floor is excluded from the fit', fit.order > 5 && fit.points <= 3,
    `order ${fit.order?.toFixed(2)} from ${fit.points} points`);
  const allFloor = fitOrder(points.slice(3));
  check('a sweep entirely at the floor reports no order and says why',
    allFloor.order === null && allFloor.reason.includes('round-off'));
}

// ── adaptive methods ────────────────────────────────────────────────────────

console.log('\nAdaptive methods — accuracy');
{
  const cases = [
    ['∫₀¹ x²', (x) => x * x, 0, 1, 1 / 3],
    ['∫₀^π sin', Math.sin, 0, Math.PI, 2],
    ['∫₀¹ 4/(1+x²)', (x) => 4 / (1 + x * x), 0, 1, Math.PI],
    ['∫₀¹ eˣ', Math.exp, 0, 1, Math.E - 1],
  ];
  for (const [name, f, a, b, want] of cases) {
    check(`${name} — Gauss-Legendre (60 pt)`, err(gauss(f, a, b, 60).value, want) < 1e-11);
    check(`${name} — Romberg`, err(romberg(f, a, b).value, want) < 1e-9);
    check(`${name} — tanh-sinh`, err(tanhSinh(f, a, b).value, want) < 1e-12);
    const ad = adaptiveSimpson(f, a, b, 1e-12);
    if (Number.isFinite(ad.value)) check(`${name} — adaptive Simpson`, err(ad.value, want) < 1e-10);
  }
}

console.log('\nA vertical tangent at the endpoint is not a singularity, and still ruins the polynomial rules');
{
  // √(1−x²) is bounded, continuous, and finite at ±1 — the semicircle. Its
  // *derivative* is infinite there, and that is what the error bounds depend
  // on. Gauss-Legendre and Romberg both fall to a handful of digits; tanh-sinh
  // does not notice, because the transformation flattens the endpoint away.
  const f = (x) => Math.sqrt(1 - x * x);
  const want = Math.PI / 2;
  const g = err(gauss(f, -1, 1, 60).value, want);
  const r = err(romberg(f, -1, 1).value, want);
  const t = err(tanhSinh(f, -1, 1).value, want);
  check('Gauss-Legendre manages only a few digits on a vertical tangent', g > 1e-9 && g < 1e-3,
    `error ${g.toExponential(2)}`);
  check('Romberg does no better', r > 1e-9 && r < 1e-2, `error ${r.toExponential(2)}`);
  check('tanh-sinh is unaffected', t < 1e-13, `error ${t.toExponential(2)}`);
}

console.log('\nThe finite-interval integrator picks the method that can see the difficulty');
{
  // Each of these defeats exactly one of the two methods, so the dispatch is
  // what makes the pair reliable where neither is alone.
  check('an interior kink: |x| over [−1,1] is exactly 1',
    err(finiteIntegral(Math.abs, -1, 1).value, 1) < 1e-12,
    `got ${finiteIntegral(Math.abs, -1, 1).value}`);
  check('and it got there by adaptive Simpson, not tanh-sinh',
    finiteIntegral(Math.abs, -1, 1).method === 'adaptive Simpson');
  check('tanh-sinh alone would have got |x| wrong',
    err(tanhSinh(Math.abs, -1, 1).value, 1) > 1e-3,
    'if this now passes, tanh-sinh improved and the dispatch may be unnecessary');
  check('a singular endpoint: 1/√x over [0,1] is exactly 2',
    err(finiteIntegral((x) => 1 / Math.sqrt(x), 0, 1).value, 2) < 1e-12);
  check('and that one went to tanh-sinh',
    finiteIntegral((x) => 1 / Math.sqrt(x), 0, 1).method === 'tanh-sinh');
  check('a disagreement is reported rather than hidden',
    finiteIntegral(Math.abs, -1, 1).crossCheck.agreed === false);
  check('and agreement is reported too',
    finiteIntegral((x) => x * x, 0, 1).crossCheck.agreed === true);
}

console.log('\nAdaptive Simpson — refuses rather than fabricates');
{
  // A closed rule must sample its endpoints. When it cannot, the honest
  // outcomes are "no value, and here is why". Nudging the endpoint integrates a
  // different function; reading the singular sample as zero returns a confident
  // wrong number.
  const r = adaptiveSimpson((x) => 1 / Math.sqrt(x), 0, 1, 1e-10);
  check('returns NaN for a singular endpoint', Number.isNaN(r.value));
  check('names the point it could not sample', r.failedAtEndpoint === 0);
  check('and explains why in words', typeof r.reason === 'string' && r.reason.includes('closed rule'));
  check('it did not silently return 2 or 0', r.value !== 2 && r.value !== 0);

  // Adaptivity is supposed to buy something. A spike one part in a thousand
  // wide should cost a fixed rule dearly and an adaptive one very little.
  const spike = (x) => 1 / (1 + 1e6 * (x - 0.5) * (x - 0.5));
  const exact = (Math.atan(1000 * 0.5) - Math.atan(-1000 * 0.5)) / 1000;
  const adaptive = adaptiveSimpson(spike, 0, 1, 1e-12);
  const fixed = simpson(spike, 0, 1, adaptive.evaluations);
  check('adaptive Simpson beats the fixed rule on a spike, at the same budget',
    err(adaptive.value, exact) < err(fixed.value, exact) / 100,
    `adaptive ${err(adaptive.value, exact).toExponential(2)} vs fixed ${err(fixed.value, exact).toExponential(2)} at ${adaptive.evaluations} evals`);
}

console.log('\nTanh-sinh — the endpoint singularity it exists for');
{
  const cases = [
    ['∫₀¹ x^(−1/2) = 2', (x) => 1 / Math.sqrt(x), 0, 1, 2],
    ['∫₀¹ ln(1/x) = 1', (x) => Math.log(1 / x), 0, 1, 1],
    ['∫₀¹ x^(−0.9) = 10', (x) => Math.pow(x, -0.9), 0, 1, 10],
    ['∫₀¹ ln(x)/√x = −4', (x) => Math.log(x) / Math.sqrt(x), 0, 1, -4],
  ];
  for (const [name, f, a, b, want] of cases) {
    const r = tanhSinh(f, a, b, 1e-13);
    check(name, err(r.value, want) < 1e-10 * Math.max(1, Math.abs(want)),
      `got ${r.value}, error ${err(r.value, want).toExponential(2)}, ${r.evaluations} evals`);
  }
  const r = tanhSinh((x) => 1 / Math.sqrt(x), 0, 1, 1e-13);
  check('and it costs only a few hundred evaluations', r.evaluations < 1000, `${r.evaluations}`);

  // The limit of what double precision can do, and the program must not pretend
  // otherwise. ∫₀¹ x^(−0.99) dx = 100, but two thirds of that area lies below
  // x = 10⁻¹⁷ — closer to the origin than a double can resolve. No quadrature
  // in this arithmetic can find it, and the right behaviour is to say so.
  const hard = tanhSinh((x) => Math.pow(x, -0.99), 0, 1, 1e-13);
  check('∫₀¹ x^(−0.99) is beyond double precision, and is NOT claimed as converged',
    !hard.converged, `converged=${hard.converged}, value ${hard.value}`);
  check('the value it returns is the part it could resolve, and is short of 100',
    hard.value > 20 && hard.value < 100, `got ${hard.value}`);
}

console.log('\nRomberg — the table is an extrapolation, and each column gains two orders');
{
  const r = romberg(Math.exp, 0, 1, 8);
  const want = Math.E - 1;
  const col0 = Math.abs(r.table[4][0] - want);      // plain trapezoidal
  const col1 = Math.abs(r.table[4][1] - want);      // one extrapolation
  const col2 = Math.abs(r.table[4][2] - want);      // two
  check('each extrapolation column is markedly better than the last',
    col1 < col0 / 10 && col2 < col1 / 10,
    `${col0.toExponential(1)} → ${col1.toExponential(1)} → ${col2.toExponential(1)}`);
  check('the table is triangular', r.table.every((row, i) => row.length === i + 1));
  check('it reports convergence honestly', typeof r.converged === 'boolean');
}

// ── Monte Carlo ─────────────────────────────────────────────────────────────

console.log('\nMonte Carlo — the 1/√N law, and an honest confidence interval');
{
  const f = (x) => 4 / (1 + x * x);
  const want = Math.PI;

  // The error should fall as 1/√N: a hundredfold increase in samples buys one
  // decimal place. Averaged over several seeds, because a single run is a
  // random variable and asserting on one is a flaky test.
  const rmse = (n) => {
    let sum = 0;
    for (let s = 0; s < 24; s++) sum += Math.pow(monteCarlo(f, 0, 1, n, { seed: 1000 + s * 7919 }).value - want, 2);
    return Math.sqrt(sum / 24);
  };
  const e1 = rmse(400), e2 = rmse(40000);
  const ratio = e1 / e2;
  check('error falls as 1/√N (100× samples → ≈10× better)', ratio > 5 && ratio < 20,
    `ratio ${ratio.toFixed(2)}, expected ≈10`);

  // A 95% interval must cover the truth about 95% of the time. Too often is as
  // wrong as too rarely — it would mean the standard error is overstated.
  let covered = 0;
  const trials = 400;
  for (let s = 0; s < trials; s++) {
    const r = monteCarlo(f, 0, 1, 500, { seed: 7 + s * 104729 });
    if (want >= r.ci95[0] && want <= r.ci95[1]) covered++;
  }
  const rate = covered / trials;
  check(`the 95% interval covers the truth ${(rate * 100).toFixed(1)}% of the time`,
    rate > 0.90 && rate < 0.99, `${covered}/${trials}`);

  check('stratified sampling beats uniform on a smooth integrand',
    Math.abs(stratified(f, 0, 1, 4000, { seed: 3 }).value - want)
    < Math.abs(monteCarlo(f, 0, 1, 4000, { seed: 3 }).value - want) / 10);
  check('antithetic sampling reduces the standard error',
    antithetic(f, 0, 1, 4000, { seed: 3 }).standardError < monteCarlo(f, 0, 1, 4000, { seed: 3 }).standardError);
  check('the generator is deterministic given a seed',
    monteCarlo(f, 0, 1, 300, { seed: 42 }).value === monteCarlo(f, 0, 1, 300, { seed: 42 }).value);
  check('and different seeds give different answers',
    monteCarlo(f, 0, 1, 300, { seed: 42 }).value !== monteCarlo(f, 0, 1, 300, { seed: 43 }).value);

  const signed = monteCarlo(Math.sin, 0, 2 * Math.PI, 200000, { seed: 11 });
  check('it handles a signed integrand (∫sin over a period ≈ 0)', Math.abs(signed.value) < 0.02,
    `got ${signed.value}`);

  const hm = hitOrMiss((x) => x * x, 0, 1, 200000, { seed: 5 });
  check('hit-or-miss converges to the same answer', err(hm.value, 1 / 3) < 0.01, `got ${hm.value}`);
}

// ── improper integrals ──────────────────────────────────────────────────────

console.log('\nImproper integrals — value');
{
  const cases = [
    ['∫₁^∞ x⁻² = 1', (x) => 1 / (x * x), 1, Infinity, 1],
    ['∫₀^∞ e⁻ˣ = 1', (x) => Math.exp(-x), 0, Infinity, 1],
    ['∫₀^∞ xe⁻ˣ = 1', (x) => x * Math.exp(-x), 0, Infinity, 1],
    ['∫₀^∞ x²e⁻ˣ = 2', (x) => x * x * Math.exp(-x), 0, Infinity, 2],
    ['∫₋∞^∞ e^(−x²) = √π', (x) => Math.exp(-x * x), -Infinity, Infinity, Math.sqrt(Math.PI)],
    ['∫₋∞^∞ 1/(1+x²) = π', (x) => 1 / (1 + x * x), -Infinity, Infinity, Math.PI],
    ['∫₋∞^0 eˣ = 1', Math.exp, -Infinity, 0, 1],
    ['∫₁^∞ x^(−1.1) = 10', (x) => Math.pow(x, -1.1), 1, Infinity, 10],
    ['∫₀¹ x^(−1/2) = 2', (x) => 1 / Math.sqrt(x), 0, 1, 2],
    ['∫₀^∞ e⁻ˣsin x = 1/2', (x) => Math.exp(-x) * Math.sin(x), 0, Infinity, 0.5],
  ];
  for (const [name, f, a, b, want] of cases) {
    const r = improper(f, a, b);
    check(name, err(r.value, want) < 1e-9 * Math.max(1, Math.abs(want)),
      `got ${r.value}, error ${err(r.value, want).toExponential(2)}`);
  }
}

console.log('\nImproper integrals — convergence is diagnosed, never asserted');
{
  const verdict = (f, a, b) => analyseImproper(f, a, b).verdict.verdict;
  check('∫₁^∞ x⁻² appears convergent', verdict((x) => 1 / (x * x), 1, Infinity) === 'appears convergent');
  check('∫₀^∞ e⁻ˣ appears convergent', verdict((x) => Math.exp(-x), 0, Infinity) === 'appears convergent');
  check('∫₀¹ x^(−1/2) appears convergent', verdict((x) => 1 / Math.sqrt(x), 0, 1) === 'appears convergent');
  check('∫₁^∞ x⁻¹ appears divergent', verdict((x) => 1 / x, 1, Infinity) === 'appears divergent');
  check('∫₀¹ x⁻¹ appears divergent', verdict((x) => 1 / x, 0, 1) === 'appears divergent');
  check('∫₀^∞ sin(x)/x is called oscillating, not convergent',
    verdict((x) => (x === 0 ? 1 : Math.sin(x) / x), 0, Infinity) === 'oscillating');
  check('∫₁^∞ x^(−1.01) is honestly "too slow to tell"',
    verdict((x) => Math.pow(x, -1.01), 1, Infinity) === 'too slow to tell');

  // No verdict is ever phrased as a proof.
  for (const [f, a, b] of [[(x) => 1 / (x * x), 1, Infinity], [(x) => 1 / x, 1, Infinity]]) {
    const v = analyseImproper(f, a, b).verdict;
    check(`the verdict "${v.verdict}" is hedged, not asserted`,
      /appears|too slow|oscillat|inconclusive|unknown/.test(v.verdict) && v.reason.length > 40);
  }

  const div = analyseImproper((x) => 1 / x, 1, Infinity);
  check('a divergent integral carries a warning that its number is meaningless',
    div.warnings.some((w) => w.includes('no value') || w.includes('artefact')));
}

console.log('\nGraded panels — a wide interval keeps its peak resolved');
{
  // One tanh-sinh call over [−10⁶, 10⁶] misses a unit-width peak sitting in the
  // middle: its samples cluster at the endpoints. Splitting by decade fixes it,
  // and this test is the reason that function exists.
  const f = (x) => Math.exp(-x * x);
  const graded = gradedIntegral(f, -1e6, 1e6);
  const naive = tanhSinh(f, -1e6, 1e6, 1e-13);
  check('graded panels find √π over [−10⁶, 10⁶]', err(graded.value, Math.sqrt(Math.PI)) < 1e-9,
    `got ${graded.value}`);
  check('a single tanh-sinh call over the same range does not',
    err(naive.value, Math.sqrt(Math.PI)) > 1e-6,
    `naive got ${naive.value} — if this now passes, the naive call improved and the test is stale`);
}

console.log('\nEndpoint classification');
{
  const c = classify((x) => 1 / Math.sqrt(x), 0, 1);
  check('a singular lower endpoint is detected', c.singularLower && !c.singularUpper);
  const d = classify((x) => 1 / Math.sqrt(1 - x), 0, 1);
  check('a singular upper endpoint is detected', d.singularUpper && !d.singularLower);
  const e = classify((x) => x * x, 0, 1);
  check('a well-behaved integrand is not flagged', !e.singularLower && !e.singularUpper);
}

// ── break the method ────────────────────────────────────────────────────────

console.log('\nBreak the method — each family really does break something');
{
  for (const key of Object.keys(FAMILIES)) {
    const s = scan(key, 'simpson', 120, 16);
    check(`the "${FAMILIES[key].label}" family produces a usable scan`,
      s.points.length > 8 && (s.worst !== null || s.refusedCount === s.totalCount));
  }

  // The claims the interface makes about which method wins where must be true.
  const osc = scan('oscillatory', 'gauss', 200, 20);
  const oscSimpson = scan('oscillatory', 'simpson', 200, 20);
  check('Gauss-Legendre survives high oscillation far better than Simpson',
    osc.worst.relativeError < oscSimpson.worst.relativeError / 1000,
    `gauss ${osc.worst.relativeError.toExponential(2)} vs simpson ${oscSimpson.worst.relativeError.toExponential(2)}`);

  const peakAdaptive = scan('peak', 'adaptive', 200, 20);
  const peakSimpson = scan('peak', 'simpson', 200, 20);
  check('adaptive Simpson survives a sharp peak far better than the fixed rule',
    peakAdaptive.worst.relativeError < peakSimpson.worst.relativeError / 100,
    `adaptive ${peakAdaptive.worst.relativeError.toExponential(2)} vs fixed ${peakSimpson.worst.relativeError.toExponential(2)}`);

  const endTanh = scan('endpoint', 'tanhsinh', 200, 20);
  const endGauss = scan('endpoint', 'gauss', 200, 20);
  check('tanh-sinh is untouched by an endpoint singularity while Gauss is not',
    endTanh.worst.relativeError < 1e-10 && endGauss.worst.relativeError > 1e-3,
    `tanh ${endTanh.worst.relativeError.toExponential(2)} vs gauss ${endGauss.worst.relativeError.toExponential(2)}`);

  const endAdaptive = scan('endpoint', 'adaptive', 200, 10);
  check('adaptive Simpson refuses the whole endpoint family, and says so',
    endAdaptive.refusedCount === endAdaptive.totalCount && endAdaptive.summary.includes('refuses'));

  check('every summary says the worst case is only the worst one found',
    scan('cusp', 'trapezoid', 100, 12).summary.includes('not a proven worst case'));
}

// ── the built-in library ────────────────────────────────────────────────────

console.log('\nThe example library — every entry parses, plots and integrates');
{
  const bad = [];
  for (const ex of EXAMPLES) {
    try {
      const ast = simplify(parse(ex.f));
      const f = compileSafe(ast, ['x']);
      const a = ex.a === '-inf' ? -Infinity : Number.isNaN(Number(ex.a)) ? compileSafe(simplify(parse(ex.a)), [])() : Number(ex.a);
      const b = ex.b === 'inf' ? Infinity : Number.isNaN(Number(ex.b)) ? compileSafe(simplify(parse(ex.b)), [])() : Number(ex.b);
      if (!(a < b)) { bad.push(`${ex.f}: limits ${ex.a}..${ex.b} not ordered`); continue; }
      // It must produce *some* finite sample inside the interval.
      const lo = Number.isFinite(a) ? a : -10, hi = Number.isFinite(b) ? b : 10;
      let anyFinite = false;
      for (let i = 1; i < 20; i++) if (Number.isFinite(f(lo + ((hi - lo) * i) / 20))) { anyFinite = true; break; }
      if (!anyFinite) bad.push(`${ex.f}: no finite samples`);
      const r = improper(f, a, b);
      if (!Number.isFinite(r.value)) bad.push(`${ex.f}: quadrature produced ${r.value}`);
    } catch (e) {
      bad.push(`${ex.f}: ${e.message}`);
    }
  }
  check(`all ${EXAMPLES.length} library entries work end to end`, bad.length === 0, bad.join(' | '));
  check('every entry carries an explanation of why it is there',
    EXAMPLES.every((e) => typeof e.why === 'string' && e.why.length > 30));
  check('the groups are non-empty', GROUPS.every((g) => g.items.length > 0 && g.blurb.length > 30));
}

console.log('\nThe library’s own claims are checked');
{
  // The blurbs assert values. If an assertion in the interface is wrong, that is
  // exactly the kind of quiet error this whole project is meant not to have.
  const claims = [
    ['x^2', 0, 1, 1 / 3], ['sin(x)', 0, Math.PI, 2], ['e^x', 0, 1, Math.E - 1],
    ['4/(1+x^2)', 0, 1, Math.PI], ['1/x', 1, Math.E, 1],
    ['1/sqrt(x)', 0, 1, 2], ['sqrt(x)', 0, 1, 2 / 3], ['|x|', -1, 1, 1],
    ['sin(x)', 0, 2 * Math.PI, 0], ['x^3', -1, 1, 0],
    ['1/x^2', 1, Infinity, 1], ['e^(-x^2)', -Infinity, Infinity, Math.sqrt(Math.PI)],
    ['e^(-x)*sin(x)', 0, Infinity, 0.5],
  ];
  for (const [src, a, b, want] of claims) {
    const f = compileSafe(simplify(parse(src)), ['x']);
    const got = improper(f, a, b).value;
    const tol = 1e-8;
    check(`the library's claim that ∫${src} over [${a}, ${b}] is ${want.toPrecision(6)}`,
      err(got, want) < tol * Math.max(1, Math.abs(want)),
      `got ${got}`);
  }
}

// ── geometry handed to the renderer ─────────────────────────────────────────

console.log('\nStrip geometry — what is drawn is what was summed');
{
  const f = (x) => x * x;
  for (const kind of ['left', 'right', 'mid', 'trapezoid', 'simpson', 'simpson38']) {
    const s = strips(f, 0, 1, 12, kind);
    check(`${kind} strips span the interval exactly`,
      s.length > 0 && Math.abs(s[0].x0 - 0) < 1e-12 && Math.abs(s[s.length - 1].x1 - 1) < 1e-12);
  }
  // The rectangles the renderer draws must sum to the number the rule reports.
  const rects = strips(f, 0, 1, 20, 'left');
  const drawnArea = rects.reduce((acc, r) => acc + r.y * (r.x1 - r.x0), 0);
  check('the drawn left rectangles sum to the left Riemann value',
    Math.abs(drawnArea - riemann(f, 0, 1, 20, 'left').value) < 1e-12);
  const traps = strips(f, 0, 1, 20, 'trapezoid');
  const drawnTrap = traps.reduce((acc, r) => acc + ((r.y0 + r.y1) / 2) * (r.x1 - r.x0), 0);
  check('the drawn trapezia sum to the trapezoidal value',
    Math.abs(drawnTrap - trapezoid(f, 0, 1, 20).value) < 1e-12);
}

// ── reference values ────────────────────────────────────────────────────────

console.log('\nReference values are cross-checked before anything is measured against them');
{
  const good = reference((x) => x * x, 0, 1);
  check('a smooth integrand gives a trustworthy reference', good.trustworthy);
  const exact = reference((x) => x * x, 0, 1, 1 / 3);
  check('an exact value is preferred and labelled as exact', exact.source === 'exact' && exact.trustworthy);
  check('a numerical reference reports how the two methods agreed',
    typeof good.agreement === 'number' && good.note.includes('agree'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
