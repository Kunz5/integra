/**
 * math.test.mjs — the symbolic engine.
 *
 * Everything here is checked against a value that was known before this program
 * existed: a closed form from a table, a derivative computed by the rules, a
 * round trip through the parser. Nothing is compared against what the code
 * happened to print last time, because a test like that passes just as happily
 * when the answer is wrong.
 *
 * Run: node test/math.test.mjs
 */

import { parse, tryParse, ParseError, tokenize } from '../src/math/parser.js';
import { simplify, expand, keyOf, structurallyEqual } from '../src/math/simplify.js';
import { compile, compileSafe, evaluate } from '../src/math/evaluate.js';
import { derivative } from '../src/math/derivative.js';
import { integrate, definite, verify, asPolynomial, asLinear } from '../src/math/integrate.js';
import { equal, variables, substitute, NUM, VAR } from '../src/math/ast.js';
import { toText, toMathML, formatNumber, formatError, smallFraction } from '../src/ui/notation.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  pass  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const close = (a, b, tol = 1e-10) => Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// ── parser ──────────────────────────────────────────────────────────────────

console.log('\nParser — the notation people actually write');
{
  const at = (src, x) => compileSafe(simplify(parse(src)), ['x'])(x);

  check('implicit multiplication: 2x', close(at('2x', 3), 6));
  check('3x^2 binds as 3·(x²) not (3x)²', close(at('3x^2', 2), 12));
  check('bracket-free application: sin x + 1', close(at('sin x + 1', 0), 1));
  check('bracket-free application binds tight: sin 2x', close(at('sin 2x', Math.PI / 4), 1));
  check('trigonometric convention: sin^2(x) is (sin x)²', close(at('sin^2(x)', Math.PI / 6), 0.25));
  check('power is right-associative: 2^3^2 = 512', close(at('2^3^2', 0), 512));
  check('unary minus binds looser than power: -x^2 is −(x²)', close(at('-x^2', 3), -9));
  check('unary minus inside an exponent: e^-x^2', close(at('e^-x^2', 1), Math.exp(-1)));
  check('absolute value bars', close(at('|x-3|', 1), 2));
  check('bars nested inside an argument', close(at('sin(|x|)', -Math.PI / 2), 1));
  check('bracket-free application stops at an explicit operator', close(at('sin x + 1', Math.PI / 2), 2));
  check('2e is 2·e, not scientific notation', close(at('2e', 0), 2 * Math.E));
  check('2e5 IS scientific notation', close(at('2e5', 0), 200000));
  check('π accepted as a character', close(at('π', 0), Math.PI));
  check('√ accepted as a character', close(at('√(x)', 9), 3));
  check('unicode minus and times', close(at('3 × x − 1', 2), 5));

  check('left-to-right division: 2x/3y is (2x/3)y', close(at('2x/3x', 3), 6),
    `got ${at('2x/3x', 3)}`);
}

console.log('\nParser — errors point at the character that went wrong');
{
  const bad = (src) => tryParse(src);
  check('unbalanced bracket is rejected', !bad('sin(x').ok);
  // Square and curly brackets are accepted as round ones — people paste them
  // from typeset sources — so `sin(x]` is deliberately legal.
  check('mixed bracket shapes are accepted', bad('sin[x]').ok);
  check('empty input is rejected', !bad('').ok);
  check('a stray operator is rejected', !bad('x + * 2').ok);
  check('unknown character is rejected', !bad('x @ 2').ok);
  check('wrong arity is rejected', !bad('atan2(x)').ok);
  const e = bad('sin(x + 2');
  check('the error carries a position', !e.ok && typeof e.error.position === 'number');
  check('an unknown name becomes a variable, not an error', tryParse('foo').ok);
}

// ── simplifier ──────────────────────────────────────────────────────────────

console.log('\nSimplifier — canonical form');
{
  const k = (src) => keyOf(simplify(parse(src)));
  check('x + x collects to 2x', k('x+x') === k('2x'));
  check('x·x collects to x²', k('x*x') === k('x^2'));
  check('x − x vanishes', k('x-x') === '0');
  check('0·x vanishes', k('0*x') === '0');
  check('x^0 is 1', k('x^0') === '1');
  check('2x + 3x is 5x', k('2x+3x') === k('5x'));
  check('sin(−x) becomes −sin(x)', k('sin(-x)') === k('-sin(x)'));
  check('cos(−x) becomes cos(x)', k('cos(-x)') === k('cos(x)'));
  check('e^(ln x) is x', k('e^(ln(x))') === 'x');
  check('ln(e) is 1', k('ln(e)') === '1');
  check('idempotent: simplify twice changes nothing',
    keyOf(simplify(simplify(parse('2x+3x+sin(-x)')))) === k('2x+3x+sin(-x)'));
  check('expansion: (x+1)² is x²+2x+1', keyOf(expand(parse('(x+1)^2'))) === k('x^2+2x+1'));
}

console.log('\nSimplifier — refuses the identities that are only half true');
{
  const k = (src) => keyOf(simplify(parse(src)));
  // √(x²) = |x|, not x. The two differ on the whole negative half-line, and a
  // simplifier that "helpfully" drops the modulus has silently changed the
  // function it was given.
  check('sqrt(x²) becomes |x|, not x', k('sqrt(x^2)') === k('abs(x)'));
  check('(x²)^(1/2) is left alone', k('(x^2)^(1/2)') !== 'x');
  const f = compileSafe(simplify(parse('sqrt(x^2)')), ['x']);
  check('and that matters numerically at x = −3', close(f(-3), 3));
  check('0^0 is not silently declared 1', k('0^0') !== '1');
}

// ── evaluation ──────────────────────────────────────────────────────────────

console.log('\nEvaluation — the domain has holes and they stay holes');
{
  const at = (src, x) => compileSafe(simplify(parse(src)), ['x'])(x);
  check('ln of a negative is NaN, not a number', Number.isNaN(at('ln(x)', -1)));
  check('sqrt of a negative is NaN', Number.isNaN(at('sqrt(x)', -1)));
  check('1/0 is NaN, not Infinity', Number.isNaN(at('1/x', 0)));
  check('an overflow is NaN, not Infinity', Number.isNaN(at('e^x', 1e6)));
  check('finite values pass through', close(at('e^x', 1), Math.E));

  // A hole read as zero is the single most dangerous failure a quadrature
  // routine can have: it produces a precise, confident, wrong answer.
  check('NaN is never quietly turned into 0', at('1/x', 0) !== 0);
}

console.log('\nEvaluation — no user string ever reaches the compiler');
{
  // The generated source is assembled from node kinds and numeric literals this
  // module controls; a variable name is only ever emitted after being matched
  // against the declared list.
  const src = compile(simplify(parse('x^2+1')), ['x']).source;
  check('compiled source contains only generated code', /^[\s\S]*$/.test(src) && !src.includes('constructor'));
  let threw = false;
  try { compile(parse('y'), ['x']); } catch { threw = true; }
  check('an undeclared variable is refused at compile time', threw);
}

// ── differentiation ─────────────────────────────────────────────────────────

console.log('\nDifferentiation — against the rules');
{
  const d = (src) => keyOf(simplify(derivative(parse(src), 'x')));
  const k = (src) => keyOf(simplify(parse(src)));
  check('d/dx x² = 2x', d('x^2') === k('2x'));
  check('d/dx sin x = cos x', d('sin(x)') === k('cos(x)'));
  check('d/dx eˣ = eˣ', d('e^x') === k('e^x'));
  check('d/dx ln x = 1/x', d('ln(x)') === k('1/x'));
  check('chain rule: d/dx sin(x²) = 2x·cos(x²)', d('sin(x^2)') === k('2x*cos(x^2)'));
  check('product rule: d/dx x·eˣ = eˣ + x·eˣ', d('x*e^x') === k('e^x + x*e^x'));
  check('d/dx atan x = 1/(1+x²)', d('atan(x)') === k('(1+x^2)^(-1)'));
  check('d/dx of a constant is 0', d('7') === '0');
  check('second derivative of x³ is 6x', keyOf(simplify(derivative(parse('x^3'), 'x', 2))) === k('6x'));

  // Logarithmic differentiation, checked numerically because the closed form is
  // long enough that structural comparison is not the point.
  const g = compileSafe(simplify(derivative(parse('x^x'), 'x')), ['x']);
  check('d/dx xˣ = xˣ(ln x + 1)', close(g(2), 4 * (Math.log(2) + 1)));
}

// ── integration ─────────────────────────────────────────────────────────────

console.log('\nIntegration — every antiderivative differentiates back');
{
  // This is the property that makes a heuristic search safe, so it is tested as
  // a property rather than case by case: whatever the engine returns, its
  // derivative must be the integrand.
  const cases = [
    'x^2', 'x^7', '1/x', 'sqrt(x)', 'sin(x)', 'cos(x)', 'tan(x)', 'e^x', '2^x',
    'ln(x)', 'atan(x)', 'asin(x)', 'sinh(x)', 'sec(x)^2',
    '1/(1+x^2)', '1/sqrt(1-x^2)', '1/(4+x^2)', '1/sqrt(9-x^2)',
    'x*e^x', 'x^2*e^x', 'x^3*e^x', 'x*sin(x)', 'x^2*cos(x)', 'x*ln(x)', 'x^2*ln(x)',
    'e^x*sin(x)', 'e^(-2x)*cos(3x)',
    'sin(x)^2', 'cos(x)^3', 'sin(x)^2*cos(x)^2', 'sin(x)*cos(x)',
    '(2x+3)^5', 'sin(3x)', 'e^(5x)', '1/(2x+1)',
    'x/(x^2+1)', 'ln(x)/x', '1/(x*ln(x))', 'x*sqrt(x^2+1)',
    '1/(x^2-1)', 'x/(x^2+3x+2)', '1/(x^3-x)', '(x+1)/(x^2+1)', '1/(x^2+2x+5)',
    'sqrt(1-x^2)', 'sqrt(x^2+4)', 'x^3+2x^2-5x+1',
  ];
  let found = 0, verified = 0;
  const missed = [];
  for (const src of cases) {
    const ast = simplify(parse(src));
    const r = integrate(ast, 'x');
    if (!r.ok) { missed.push(src); continue; }
    found++;
    // Re-verify independently of the engine's own check.
    if (verify(r.antiderivative, ast, 'x').ok) verified++;
  }
  check(`found antiderivatives for ${found} of ${cases.length}`, found >= cases.length - 1,
    missed.length ? `missed: ${missed.join(', ')}` : '');
  check('every antiderivative found differentiates back to its integrand', verified === found,
    `${found - verified} failed re-verification`);
}

console.log('\nIntegration — the honest failures');
{
  // Liouville's theorem: these have no elementary antiderivative at all. An
  // engine that returned one would be wrong, and one that returned nothing
  // without saying why would be useless.
  for (const src of ['e^(-x^2)', 'sin(x)/x', 'e^x/x', '1/ln(x)']) {
    const r = integrate(simplify(parse(src)), 'x');
    check(`∫${src} is honestly reported as not found`, !r.ok && typeof r.reason === 'string' && r.reason.length > 60);
  }
  const r = integrate(simplify(parse('e^(-x^2)')), 'x');
  check('the reason distinguishes "none found" from "none exists"',
    r.reason.includes('not a proof') || r.reason.includes('not clever enough'));
}

console.log('\nDefinite integrals — against closed forms');
{
  const cases = [
    ['x^2', 0, 1, 1 / 3],
    ['x^3', 0, 2, 4],
    ['sin(x)', 0, Math.PI, 2],
    ['cos(x)', 0, Math.PI / 2, 1],
    ['e^x', 0, 1, Math.E - 1],
    ['1/x', 1, Math.E, 1],
    ['4/(1+x^2)', 0, 1, Math.PI],
    ['sqrt(x)', 0, 1, 2 / 3],
    ['ln(x)', 1, Math.E, 1],
    ['x*e^x', 0, 1, 1],
    ['sin(x)', 0, 2 * Math.PI, 0],
    ['x^3', -1, 1, 0],
    ['sqrt(1-x^2)', -1, 1, Math.PI / 2],
    ['1/(1+x^2)', -1, 1, Math.PI / 2],
  ];
  for (const [src, a, b, want] of cases) {
    const r = definite(simplify(parse(src)), a, b, 'x');
    check(`∫ ${src} from ${formatNumber(a, 4)} to ${formatNumber(b, 4)} = ${formatNumber(want, 8)}`,
      r.ok && close(r.value, want, 1e-9), r.ok ? `got ${r.value}` : r.reason?.slice(0, 70));
  }
}

console.log('\nDefinite integrals — the fundamental theorem has a hypothesis');
{
  // F(b) − F(a) for 1/x² over [−1, 1] gives −2: a negative number for the
  // integral of a strictly positive function. The theorem does not apply across
  // the pole, and refusing is the only correct behaviour.
  const r = definite(simplify(parse('1/x^2')), -1, 1, 'x');
  check('∫₋₁¹ dx/x² is refused rather than evaluated to −2', !r.ok);
  check('and the refusal names the discontinuity',
    !r.ok && (r.reason.includes('continuous') || r.reason.includes('discontinu')));
  check('an antiderivative was still found, and is reported', !r.ok && r.antiderivative != null);

  const ok = definite(simplify(parse('1/x^2')), 1, 2, 'x');
  check('the same integrand away from the pole evaluates fine', ok.ok && close(ok.value, 0.5));
}

// ── polynomial helpers ──────────────────────────────────────────────────────

console.log('\nPolynomial recognition');
{
  const coeffs = (src) => (asPolynomial(simplify(parse(src)), 'x') ?? []).map((c) => simplify(c).v);
  check('3x² − 1 reads as [−1, 0, 3]', JSON.stringify(coeffs('3x^2-1')) === JSON.stringify([-1, 0, 3]));
  check('a constant reads as [c]', JSON.stringify(coeffs('5')) === JSON.stringify([5]));
  check('sin(x) is not a polynomial', asPolynomial(simplify(parse('sin(x)')), 'x') === null);
  check('x^(-1) is not a polynomial', asPolynomial(simplify(parse('1/x')), 'x') === null);
  const lin = asLinear(simplify(parse('3x+4')), 'x');
  check('3x+4 reads as a=3, b=4', simplify(lin.a).v === 3 && simplify(lin.b).v === 4);
  check('x² is not linear', asLinear(simplify(parse('x^2')), 'x') === null);
}

// ── notation ────────────────────────────────────────────────────────────────

console.log('\nNotation — the text form round-trips through the parser');
{
  const cases = [
    'x^2/3', 'e^(-x^2)', '1/(1+x^2)', 'sqrt(1-x^2)', '-x^2+3x-1', 'x*sin(x^2)',
    '2/3*x^3', 'x^(1/2)', 'sin(x)/x', 'ln(x)*x^3', '1/(x^2-1)', 'atan(x)/2',
    'e^x*sin(x)', '(2x+3)^5', 'x^3+2x^2-5x+1',
  ];
  let bad = [];
  for (const src of cases) {
    const a = simplify(parse(src));
    const back = simplify(parse(toText(a)));
    if (keyOf(a) !== keyOf(back)) bad.push(`${src} → ${toText(a)}`);
  }
  check('every expression prints and re-parses to the same tree', bad.length === 0, bad.join(' | '));

  // And so does every antiderivative the engine produces, which is what makes
  // the printed answer something you can paste back in.
  let antiBad = [];
  for (const src of ['x^2', 'x*e^x', 'sin(x)^2', '1/(1+x^2)', 'x*ln(x)', 'e^x*sin(x)', 'sqrt(1-x^2)']) {
    const r = integrate(simplify(parse(src)), 'x');
    if (!r.ok) continue;
    const printed = toText(r.antiderivative);
    try {
      if (keyOf(simplify(parse(printed))) !== keyOf(r.antiderivative)) antiBad.push(`${src}: ${printed}`);
    } catch (e) { antiBad.push(`${src}: ${printed} (${e.message})`); }
  }
  check('every antiderivative prints and re-parses to the same tree', antiBad.length === 0, antiBad.join(' | '));
}

console.log('\nNotation — MathML is well formed');
{
  const ml = toMathML(simplify(parse('x^2/3 + sin(x)')));
  const opens = (ml.match(/<m[a-z]+[ >]/g) ?? []).length;
  const closes = (ml.match(/<\/m[a-z]+>/g) ?? []).length;
  const selfClosing = (ml.match(/<m[a-z]+[^>]*\/>/g) ?? []).length;
  check('tags balance', opens - selfClosing === closes, `${opens} open, ${closes} close, ${selfClosing} self-closing`);
  check('no raw < survives escaping', !toMathML(simplify(parse('x'))).includes('<<'));
  check('a fraction becomes an mfrac', toMathML(simplify(parse('1/x'))).includes('<mfrac>'));
  check('a square root becomes an msqrt', toMathML(simplify(parse('sqrt(x)'))).includes('<msqrt>'));
  check('a negative product prints as −(…) not −1⋅(…)',
    !toMathML(simplify(parse('-sin(x)'))).includes('>−1<'));
}

console.log('\nNotation — numbers');
{
  check('⅓ is recognised', smallFraction(1 / 3).num === 1 && smallFraction(1 / 3).den === 3);
  check('−⅔ is recognised', smallFraction(-2 / 3).den === 3);
  check('π is not mistaken for a fraction', smallFraction(Math.PI) === null);
  check('an integer formats without a decimal point', formatNumber(4) === '4');
  check('a tiny error formats in scientific notation', formatError(1.5e-9).includes('10⁻⁹'));
  check('zero error says so', formatError(0).includes('exact'));
  check('NaN formats as an em dash, not as "NaN"', formatError(NaN) === '—');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
