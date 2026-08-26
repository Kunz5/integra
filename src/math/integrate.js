/**
 * integrate.js — symbolic antiderivatives, and an honest answer when there
 * isn't one.
 *
 * Integration is a search, not an algorithm. Differentiation of an elementary
 * function always yields an elementary function; integration frequently does
 * not — ∫e^(−x²)dx and ∫(sin x)/x dx have no elementary antiderivative at all,
 * and Liouville's theorem says that is a fact about the functions, not a gap in
 * anyone's cleverness. A full decision procedure exists (the Risch algorithm)
 * and is enormous. What follows is the classical toolkit, applied in order:
 *
 *   1. the table of standard forms
 *   2. linearity — constants out, sums term by term
 *   3. linear substitution — f(ax+b) needs only a factor of 1/a
 *   4. general u-substitution, searched over subexpressions
 *   5. integration by parts, with a recursion budget
 *   6. partial fractions for rational functions
 *   7. trigonometric powers and products
 *
 * The part that makes heuristic search safe is the last step, not the first:
 * **every candidate is differentiated and checked against the integrand**. A
 * rule may be wrong, a substitution may be invalid, the search may go somewhere
 * silly — and none of that can produce a wrong answer on screen, because a
 * candidate that does not differentiate back is discarded and the honest
 * "no elementary antiderivative found" is returned instead.
 *
 * The distinction between "none found" and "none exists" is preserved
 * everywhere. This module can prove neither, and says so.
 */

import {
  NUM, ZERO, ONE, VAR, CONST, add, mul, pow, call, neg, sub, div,
  isNum, isZero, isOne, dependsOn, substitute, equal, variables, complexity, clone,
} from './ast.js';
import { simplify, expand, keyOf } from './simplify.js';
import { derivative } from './derivative.js';
import { compileSafe } from './evaluate.js';

const X = 'x';

/**
 * @typedef {object} IntegralResult
 * @property {boolean} ok
 * @property {object=} antiderivative   the F with F' = f
 * @property {string=} method           which rule found it
 * @property {string=} verification     'symbolic' | 'numeric'
 * @property {string=} reason           why nothing was found
 */

/**
 * Find an antiderivative of `f` with respect to `v`.
 *
 * Returns `{ ok: false }` rather than a guess when the search fails. That is
 * not the same statement as "no antiderivative exists", and the `reason` field
 * says so in words the interface shows the user verbatim.
 */
export function integrate(f, v = X) {
  const expr = simplify(f);
  const trail = [];
  const candidate = search(expr, v, 0, trail);

  if (!candidate) {
    return {
      ok: false,
      reason: 'No elementary antiderivative was found by the rules this engine knows '
        + '(table, linearity, substitution, parts, partial fractions, trigonometric reduction). '
        + 'That is not a proof that none exists — for some functions, such as e^(−x²) and sin(x)/x, '
        + 'it is known that none does; for others this engine is simply not clever enough. '
        + 'The definite integral is still computed numerically.',
      attempted: trail,
    };
  }

  const F = simplify(candidate.expr);
  const check = verify(F, expr, v);
  if (!check.ok) {
    return {
      ok: false,
      reason: 'A candidate antiderivative was found but it failed verification — '
        + 'differentiating it did not return the original integrand, so it has been discarded '
        + 'rather than shown to you. This is a limitation of the engine, not of the integral.',
      attempted: trail,
      rejected: F,
    };
  }

  return {
    ok: true,
    antiderivative: F,
    method: candidate.method,
    verification: check.how,
    verificationDetail: check.detail,
  };
}

// ── verification ────────────────────────────────────────────────────────────

/**
 * Is F really an antiderivative of f?
 *
 * Two tests, in order of strength. Structural equality after simplification is
 * a proof, as far as this engine's algebra reaches. When that fails — and it
 * often does on a correct answer, because the simplifier is not complete —
 * fall back to sampling: agreement to 1e-9 relative at many scattered points
 * inside the domain is overwhelming evidence, and is *labelled* as evidence
 * rather than as proof, because that is what it is.
 */
export function verify(F, f, v = X) {
  const dF = simplify(derivative(F, v));
  const target = simplify(f);

  if (equal(dF, target)) return { ok: true, how: 'symbolic', detail: 'd/dx of the result is structurally identical to the integrand.' };
  if (equal(simplify(expand(dF)), simplify(expand(target)))) {
    return { ok: true, how: 'symbolic', detail: 'd/dx of the result equals the integrand after expansion.' };
  }

  const others = variables(dF).concat(variables(target)).filter((n) => n !== v);
  if (others.length) return { ok: false };

  let g, h;
  try { g = compileSafe(dF, [v]); h = compileSafe(target, [v]); }
  catch { return { ok: false }; }

  // Points scattered over several scales, avoiding the integers and simple
  // rationals where a wrong formula is most likely to agree by accident.
  const samples = [
    -7.3121, -3.1701, -1.6183, -0.7071, -0.3183, -0.1234,
    0.1234, 0.3183, 0.7071, 1.6183, 3.1701, 7.3121, 12.9091,
  ];
  let compared = 0, agreed = 0;
  for (const t of samples) {
    const a = g(t), b = h(t);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    compared++;
    const scale = Math.max(1e-8, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) <= 1e-9 * scale) agreed++;
  }

  if (compared >= 4 && agreed === compared) {
    return {
      ok: true,
      how: 'numeric',
      detail: `d/dx of the result matches the integrand to 1 part in 10⁹ at ${compared} sample points. `
        + 'The engine could not prove them equal algebraically, so this is strong evidence rather than a proof.',
    };
  }
  return { ok: false };
}

// ── the search ──────────────────────────────────────────────────────────────

// Deep enough for five nested applications of integration by parts, which is
// what ∫x⁵eˣ costs. Each level is cheap — the rules that recurse all shrink the
// integrand — and the whole search runs in single-digit milliseconds even when
// it fails, so the budget is set by what is useful rather than by what is fast.
const MAX_DEPTH = 20;

function search(f, v, depth, trail) {
  if (depth > MAX_DEPTH) return null;
  const e = simplify(f);

  for (const rule of RULES) {
    let got = null;
    try { got = rule.fn(e, v, depth, trail); } catch { got = null; }
    if (got) {
      trail.push(rule.name);
      return { expr: got, method: rule.name };
    }
  }
  return null;
}

/** Try a rule and return only the expression, for use inside other rules. */
function inner(f, v, depth, trail) {
  const r = search(f, v, depth + 1, trail);
  return r ? r.expr : null;
}

// ── rule 1: constants and the power rule ────────────────────────────────────

function ruleConstant(e, v) {
  if (!dependsOn(e, v)) return mul(e, VAR(v));
  return null;
}

function rulePower(e, v) {
  // x^n → x^(n+1)/(n+1) for n ≠ −1;  x^(−1) → ln|x|
  if (e.k === 'var' && e.name === v) return mul(NUM(0.5), pow(VAR(v), NUM(2)));
  if (e.k !== 'pow') return null;
  if (!(e.base.k === 'var' && e.base.name === v)) return null;
  if (dependsOn(e.exp, v)) return null;

  if (isNum(e.exp, -1)) return call('ln', call('abs', VAR(v)));
  const n1 = simplify(add(e.exp, ONE));
  return mul(pow(VAR(v), n1), pow(n1, NUM(-1)));
}

// ── rule 2: the table ───────────────────────────────────────────────────────

/**
 * Standard forms, keyed by function name. Each entry takes the argument — which
 * the caller has already checked is the bare variable — and returns the
 * antiderivative.
 */
const TABLE = {
  sin: (u) => neg(call('cos', u)),
  cos: (u) => call('sin', u),
  tan: (u) => neg(call('ln', call('abs', call('cos', u)))),
  cot: (u) => call('ln', call('abs', call('sin', u))),
  sec: (u) => call('ln', call('abs', add(call('sec', u), call('tan', u)))),
  csc: (u) => neg(call('ln', call('abs', add(call('csc', u), call('cot', u))))),

  exp: (u) => call('exp', u),
  ln: (u) => sub(mul(u, call('ln', u)), u),
  log10: (u) => div(sub(mul(u, call('ln', u)), u), call('ln', NUM(10))),
  log2: (u) => div(sub(mul(u, call('ln', u)), u), call('ln', NUM(2))),

  sinh: (u) => call('cosh', u),
  cosh: (u) => call('sinh', u),
  tanh: (u) => call('ln', call('cosh', u)),

  asin: (u) => add(mul(u, call('asin', u)), pow(sub(ONE, pow(u, NUM(2))), NUM(0.5))),
  acos: (u) => sub(mul(u, call('acos', u)), pow(sub(ONE, pow(u, NUM(2))), NUM(0.5))),
  atan: (u) => sub(mul(u, call('atan', u)), mul(NUM(0.5), call('ln', add(ONE, pow(u, NUM(2)))))),

  sqrt: (u) => mul(NUM(2 / 3), pow(u, NUM(1.5))),
  // |x| integrates to x|x|/2 — which is x²/2 for x > 0 and −x²/2 for x < 0,
  // exactly right and continuous through zero.
  abs: (u) => mul(NUM(0.5), u, call('abs', u)),
  sign: (u) => call('abs', u),
};

function ruleTable(e, v) {
  if (e.k !== 'call' || e.args.length !== 1) return null;
  const arg = e.args[0];
  if (!(arg.k === 'var' && arg.name === v)) return null;
  const f = TABLE[e.name];
  return f ? f(VAR(v)) : null;
}

/** Forms that are not a bare function call: 1/(1+x²), 1/√(1−x²), sec²x, … */
function ruleSpecialForms(e, v) {
  const s = simplify(e);

  // 1/(a² + x²) → (1/a)·atan(x/a)
  const inv = asInversePower(s);
  if (inv) {
    const q = asQuadratic(inv, v);
    if (q && isZero(simplify(q.b))) {
      const { a, c } = q;
      if (!dependsOn(a, v) && !dependsOn(c, v)) {
        const A = simplify(a), C = simplify(c);
        if (A.k === 'num' && C.k === 'num' && A.v > 0 && C.v > 0) {
          const k = Math.sqrt(C.v / A.v);                 // x² + k², scaled by A
          return mul(NUM(1 / (A.v * k)), call('atan', mul(NUM(1 / k), VAR(v))));
        }
        if (A.k === 'num' && C.k === 'num' && A.v > 0 && C.v < 0) {
          // 1/(ax² − |c|) → partial fractions; leave it to that rule.
          return null;
        }
      }
    }
  }

  // (1 − x²)^(−1/2) → asin x   and   (1 + x²)^(−1/2) → asinh x
  if (s.k === 'pow' && isNum(s.exp, -0.5)) {
    const q = asQuadratic(s.base, v);
    if (q && isZero(simplify(q.b))) {
      const A = simplify(q.a), C = simplify(q.c);
      if (A.k === 'num' && C.k === 'num') {
        if (A.v === -1 && C.v === 1) return call('asin', VAR(v));
        if (A.v === 1 && C.v === 1) return call('asinh', VAR(v));
        if (A.v === 1 && C.v === -1) return call('acosh', VAR(v));
      }
    }
  }

  // a^x → a^x / ln a. This belongs in the table rather than being left to the
  // substitution rule: e^x is the single most common integrand there is, and
  // reaching it only through a depth-limited search meant that ∫x²eˣ failed at
  // the third nesting of integration by parts while ∫xeˣ succeeded.
  if (s.k === 'pow' && !dependsOn(s.base, v) && s.exp.k === 'var' && s.exp.name === v) {
    if (s.base.k === 'const' && s.base.name === 'e') return s;
    return mul(s, pow(call('ln', s.base), NUM(-1)));
  }

  // sec²x → tan x, csc²x → −cot x, sec·tan → sec, csc·cot → −csc
  if (s.k === 'pow' && isNum(s.exp, 2) && s.base.k === 'call' && argIsVar(s.base, v)) {
    if (s.base.name === 'sec') return call('tan', VAR(v));
    if (s.base.name === 'csc') return neg(call('cot', VAR(v)));
  }
  if (s.k === 'mul' && s.args.length === 2) {
    const names = s.args.map((a) => (a.k === 'call' && argIsVar(a, v) ? a.name : null));
    if (names.includes('sec') && names.includes('tan')) return call('sec', VAR(v));
    if (names.includes('csc') && names.includes('cot')) return neg(call('csc', VAR(v)));
  }

  return null;
}

const argIsVar = (n, v) => n.args?.length === 1 && n.args[0].k === 'var' && n.args[0].name === v;

/** If e is u^(−1), return u. */
function asInversePower(e) {
  if (e.k === 'pow' && isNum(e.exp, -1)) return e.base;
  return null;
}

/** Read e as a·v² + b·v + c, or null if it is not quadratic in v. */
export function asQuadratic(e, v) {
  const p = asPolynomial(simplify(e), v);
  if (!p || p.length > 3) return null;
  return { a: p[2] ?? ZERO, b: p[1] ?? ZERO, c: p[0] ?? ZERO };
}

// ── rule 3: linearity ───────────────────────────────────────────────────────

function ruleSum(e, v, depth, trail) {
  if (e.k !== 'add') return null;
  const parts = [];
  for (const term of e.args) {
    const F = inner(term, v, depth, trail);
    if (!F) return null;
    parts.push(F);
  }
  return add(parts);
}

function ruleConstantMultiple(e, v, depth, trail) {
  if (e.k !== 'mul') return null;
  const constants = e.args.filter((a) => !dependsOn(a, v));
  if (!constants.length) return null;
  const rest = e.args.filter((a) => dependsOn(a, v));
  if (!rest.length) return null;
  const F = inner(rest.length === 1 ? rest[0] : mul(rest), v, depth, trail);
  return F ? mul(mul(constants), F) : null;
}

// ── rule 4: linear substitution ─────────────────────────────────────────────

/**
 * If every occurrence of v sits inside the same (a·v + b), integrate in that
 * variable and divide by a. This is the workhorse: it handles sin(3x), e^(−2x),
 * 1/(2x+1), (3x−4)^7 and everything of that shape without any search at all.
 */
function ruleLinearSubstitution(e, v, depth, trail) {
  const lin = commonLinearArgument(e, v);
  if (!lin) return null;
  const { a, b } = lin;
  if (isZero(simplify(a))) return null;
  if (isOne(simplify(a)) && isZero(simplify(b))) return null;   // nothing to do

  const u = 'ξ';                       // a name the user cannot have typed
  const inU = substitute(e, v, div(sub(VAR(u), b), a));
  const simplifiedInU = simplify(inU);
  if (dependsOn(simplifiedInU, v)) return null;

  const G = inner(simplifiedInU, u, depth, trail);
  if (!G) return null;
  const back = substitute(G, u, add(mul(a, VAR(v)), b));
  return mul(pow(a, NUM(-1)), back);
}

/**
 * Find a single a·v + b such that v appears only inside it.
 *
 * Collects every maximal subexpression containing v that is itself linear in v,
 * and returns it if they all agree.
 */
function commonLinearArgument(e, v) {
  const found = [];
  collectLinear(simplify(e), v, found);
  if (!found.length) return null;
  const first = found[0];
  for (const f of found) {
    if (!equal(simplify(f.a), simplify(first.a)) || !equal(simplify(f.b), simplify(first.b))) return null;
  }
  if (isOne(simplify(first.a)) && isZero(simplify(first.b))) return null;
  return first;
}

function collectLinear(n, v, out) {
  if (!dependsOn(n, v)) return;
  const lin = asLinear(n, v);
  if (lin) { out.push(lin); return; }
  switch (n.k) {
    case 'add': case 'mul': n.args.forEach((a) => collectLinear(a, v, out)); return;
    case 'pow': collectLinear(n.base, v, out); collectLinear(n.exp, v, out); return;
    case 'call': n.args.forEach((a) => collectLinear(a, v, out)); return;
    default: out.push(null); return;
  }
}

/** Read n as a·v + b with a, b free of v; else null. */
export function asLinear(n, v) {
  const p = asPolynomial(n, v);
  if (!p || p.length > 2) return null;
  return { a: p[1] ?? ZERO, b: p[0] ?? ZERO };
}

// ── rule 5: general substitution ────────────────────────────────────────────

/**
 * u-substitution by search.
 *
 * For each subexpression u that involves v, form f/u′ and ask whether the
 * result can be written entirely in terms of u. The test is structural: replace
 * every occurrence of u by a fresh symbol and see whether v has disappeared.
 * That is a sufficient condition and not a necessary one, which is exactly the
 * right side to err on — a substitution this misses costs a "not found", one it
 * takes wrongly is caught by the verifier.
 */
function ruleSubstitution(e, v, depth, trail) {
  if (depth > 3) return null;
  const candidates = substitutionCandidates(e, v);

  for (const u of candidates) {
    const du = simplify(derivative(u, v));
    if (isZero(du)) continue;

    const quotient = simplify(mul(e, pow(du, NUM(-1))));
    if (dependsOn(quotient, v) === false) {
      // f = c·u′ exactly: ∫f dx = c·u
      const G = inner(ONE, 'ζ', depth, trail);
      if (G) return mul(quotient, u);
      continue;
    }

    const t = 'ζ';
    const replaced = replaceSubtree(quotient, u, VAR(t));
    if (dependsOn(replaced, v)) continue;

    const G = inner(replaced, t, depth, trail);
    if (!G) continue;
    return substitute(G, t, u);
  }
  return null;
}

/** Interesting subexpressions to try as u, most promising first. */
function substitutionCandidates(e, v) {
  const seen = new Map();
  const push = (n) => {
    if (!n || !dependsOn(n, v)) return;
    if (n.k === 'var') return;
    const k = keyOf(n);
    if (!seen.has(k)) seen.set(k, n);
  };

  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    switch (n.k) {
      case 'call': n.args.forEach((a) => { push(a); visit(a); }); break;
      case 'pow': push(n.base); visit(n.base); push(n.exp); visit(n.exp); break;
      case 'add': case 'mul': n.args.forEach((a) => { push(a); visit(a); }); break;
      default: break;
    }
  };
  visit(e);
  push(e);

  // Prefer inner arguments of functions and denominators — the classical
  // choices — over whole products, and simpler over more complex.
  return [...seen.values()].sort((a, b) => complexity(a) - complexity(b));
}

/** Replace every occurrence of subtree `u` with `to`. */
function replaceSubtree(n, u, to) {
  if (!n || typeof n !== 'object') return n;
  if (equal(simplify(n), simplify(u))) return clone(to);
  switch (n.k) {
    case 'add': return { k: 'add', args: n.args.map((a) => replaceSubtree(a, u, to)) };
    case 'mul': return { k: 'mul', args: n.args.map((a) => replaceSubtree(a, u, to)) };
    case 'pow': return { k: 'pow', base: replaceSubtree(n.base, u, to), exp: replaceSubtree(n.exp, u, to) };
    case 'call': return { k: 'call', name: n.name, args: n.args.map((a) => replaceSubtree(a, u, to)) };
    default: return n;
  }
}

// ── rule 6: integration by parts ────────────────────────────────────────────

/**
 * ∫u dv = uv − ∫v du.
 *
 * The whole difficulty is choosing u. The classroom mnemonic LIATE —
 * logarithmic, inverse trig, algebraic, trigonometric, exponential — is a
 * ranking of how much better a factor gets when you differentiate it, and it is
 * a genuinely good heuristic. Rank each factor, differentiate the best-ranked
 * one, integrate the rest, and recurse. The depth budget stops x^n·e^x from
 * descending forever when n is large.
 */
function rulePartsRule(e, v, depth, trail) {
  // Each application of parts reduces the algebraic factor's degree by one, so
  // the budget is really "how large a power of x will you carry". Six covers
  // ∫x⁵eˣ, which is past where anyone does this by hand.
  if (depth > 16) return null;
  if (e.k !== 'mul' && !isPartsWorthySingle(e, v)) return null;

  const factors = e.k === 'mul' ? e.args.filter((a) => dependsOn(a, v)) : [e];
  if (!factors.length) return null;

  // A single log or inverse-trig factor: u = it, dv = dx.
  if (factors.length === 1) {
    const only = factors[0];
    if (!isPartsWorthySingle(only, v)) return null;
    const du = simplify(derivative(only, v));
    const vv = VAR(v);
    const rest = inner(simplify(mul(vv, du)), v, depth, trail);
    if (!rest) return null;
    return sub(mul(vv, only), rest);
  }

  const ranked = factors.map((f) => ({ f, rank: liate(f, v) })).sort((p, q) => p.rank - q.rank);
  for (const choice of ranked) {
    const u = choice.f;
    const dvFactors = factors.filter((f) => f !== u);
    const dv = dvFactors.length === 1 ? dvFactors[0] : mul(dvFactors);

    const V = inner(dv, v, depth, trail);
    if (!V) continue;
    const du = simplify(derivative(u, v));
    if (isZero(du)) continue;

    const remaining = simplify(mul(V, du));
    // Refuse a step that made the problem bigger — that is the loop.
    if (complexity(remaining) > complexity(e) * 3 + 8) continue;

    const R = inner(remaining, v, depth + 1, trail);
    if (!R) continue;
    return sub(mul(u, V), R);
  }
  return null;
}

function isPartsWorthySingle(e, v) {
  if (e.k !== 'call' || !argIsVar(e, v)) return false;
  return ['ln', 'log10', 'log2', 'asin', 'acos', 'atan'].includes(e.name);
}

/** LIATE rank: lower differentiates to something better. */
function liate(f, v) {
  if (f.k === 'call') {
    if (['ln', 'log', 'log10', 'log2'].includes(f.name)) return 0;
    if (['asin', 'acos', 'atan', 'asinh', 'acosh', 'atanh'].includes(f.name)) return 1;
    if (['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'sinh', 'cosh', 'tanh'].includes(f.name)) return 3;
    if (f.name === 'exp') return 4;
  }
  if (f.k === 'pow') {
    if (f.base.k === 'const' && f.base.name === 'e') return 4;
    if (f.base.k === 'call') return liate(f.base, v);
    if (!dependsOn(f.exp, v)) return 2;                  // algebraic
    return 4;
  }
  if (f.k === 'var' || f.k === 'add') return 2;
  return 2;
}

// ── rule 7: rational functions by partial fractions ─────────────────────────

/**
 * Coefficients of a polynomial in v, lowest power first, or null.
 * `asPolynomial(3x² − 1, 'x')` → `[NUM(-1), ZERO, NUM(3)]`.
 */
export function asPolynomial(e, v, maxDegree = 12) {
  const s = simplify(expand(e));
  const out = [];
  const addTerm = (deg, coeff) => {
    if (deg > maxDegree) throw new NotPolynomial();
    out[deg] = out[deg] ? simplify(add(out[deg], coeff)) : simplify(coeff);
  };

  const term = (t) => {
    if (!dependsOn(t, v)) { addTerm(0, t); return; }
    if (t.k === 'var' && t.name === v) { addTerm(1, ONE); return; }
    if (t.k === 'pow' && t.base.k === 'var' && t.base.name === v) {
      const n = t.exp;
      if (n.k !== 'num' || !Number.isInteger(n.v) || n.v < 0) throw new NotPolynomial();
      addTerm(n.v, ONE);
      return;
    }
    if (t.k === 'mul') {
      let deg = 0;
      const coeffs = [];
      for (const f of t.args) {
        if (!dependsOn(f, v)) { coeffs.push(f); continue; }
        if (f.k === 'var' && f.name === v) { deg += 1; continue; }
        if (f.k === 'pow' && f.base.k === 'var' && f.base.name === v
            && f.exp.k === 'num' && Number.isInteger(f.exp.v) && f.exp.v >= 0) {
          deg += f.exp.v; continue;
        }
        throw new NotPolynomial();
      }
      addTerm(deg, coeffs.length ? mul(coeffs) : ONE);
      return;
    }
    throw new NotPolynomial();
  };

  try {
    if (s.k === 'add') s.args.forEach(term);
    else term(s);
  } catch (err) {
    if (err instanceof NotPolynomial) return null;
    throw err;
  }

  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = ZERO;
  while (out.length && isZero(simplify(out[out.length - 1]))) out.pop();
  return out;
}

class NotPolynomial extends Error {}

/** Split e into numerator and denominator polynomials in v, or null. */
function asRational(e, v) {
  const s = simplify(e);
  const numFactors = [], denFactors = [];
  const push = (f) => {
    if (f.k === 'pow' && f.exp.k === 'num' && f.exp.v < 0 && Number.isInteger(f.exp.v)) {
      for (let i = 0; i < -f.exp.v; i++) denFactors.push(f.base);
    } else numFactors.push(f);
  };
  if (s.k === 'mul') s.args.forEach(push); else push(s);
  if (!denFactors.length) return null;

  const num = asPolynomial(numFactors.length ? mul(numFactors) : ONE, v);
  const den = asPolynomial(mul(denFactors), v);
  if (!num || !den) return null;
  if (den.length <= 1) return null;
  return { num, den };
}

function polyToNode(coeffs, v) {
  const terms = [];
  for (let i = 0; i < coeffs.length; i++) {
    if (isZero(simplify(coeffs[i]))) continue;
    terms.push(i === 0 ? coeffs[i] : mul(coeffs[i], pow(VAR(v), NUM(i))));
  }
  return terms.length ? add(terms) : ZERO;
}

/** Numeric coefficient list, or null if any coefficient is not a plain number. */
function numericCoeffs(poly) {
  const out = [];
  for (const c of poly) {
    const s = simplify(c);
    if (s.k !== 'num') return null;
    out.push(s.v);
  }
  return out;
}

/** Synthetic division of `p` by (x − r). Returns the quotient. */
function deflate(p, r) {
  const q = new Array(p.length - 1).fill(0);
  let carry = p[p.length - 1];
  for (let i = p.length - 2; i >= 0; i--) {
    q[i] = carry;
    carry = p[i] + carry * r;
  }
  return q;
}

/**
 * Rational roots of an integer-coefficient polynomial, by the rational root
 * theorem: any p/q root has p | a₀ and q | aₙ. Exhaustive over the divisors, so
 * it finds every rational root there is — and it is honest about the rest,
 * because an irrational or complex root is simply not returned.
 */
function rationalRoots(coeffs) {
  const scaled = clearDenominators(coeffs);
  if (!scaled) return [];
  const a0 = scaled[0], an = scaled[scaled.length - 1];
  if (an === 0) return [];

  const roots = [];
  let work = scaled.slice();

  const tryRoot = (r) => {
    while (work.length > 1 && Math.abs(evalPoly(work, r)) < 1e-9 * polyScale(work)) {
      roots.push(r);
      work = deflate(work, r);
    }
  };

  if (a0 === 0) {
    while (work.length > 1 && work[0] === 0) { roots.push(0); work = work.slice(1); }
  }

  const ps = divisors(Math.abs(work[0] ?? 0));
  const qs = divisors(Math.abs(work[work.length - 1] ?? 1));
  for (const p of ps) for (const q of qs) {
    for (const sign of [1, -1]) tryRoot((sign * p) / q);
  }
  return { roots, remainder: work };
}

const polyScale = (p) => Math.max(1, ...p.map(Math.abs));
const evalPoly = (p, x) => p.reduce((acc, c, i) => acc + c * Math.pow(x, i), 0);

function divisors(n) {
  if (!Number.isInteger(n) || n <= 0) return [1];
  const out = [];
  for (let i = 1; i <= Math.abs(n); i++) if (n % i === 0) out.push(i);
  return out.length ? out : [1];
}

/** Scale rational coefficients to integers, or null if they are not rational. */
function clearDenominators(coeffs) {
  const dens = [];
  for (const c of coeffs) {
    const f = asFraction(c);
    if (!f) return null;
    dens.push(f.den);
  }
  const L = dens.reduce(lcm, 1);
  if (!Number.isFinite(L) || L > 1e6) return null;
  return coeffs.map((c) => Math.round(c * L));
}

function asFraction(x, maxDen = 10000) {
  if (!Number.isFinite(x)) return null;
  if (Number.isInteger(x)) return { num: x, den: 1 };
  // Continued fractions: the standard way to recover p/q from a double, and it
  // returns the *simplest* fraction within tolerance rather than 6004799503160661/2^53.
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1, b = x;
  do {
    const a = Math.floor(b);
    let h2 = a * h1 + h0; h0 = h1; h1 = h2;
    let k2 = a * k1 + k0; k0 = k1; k1 = k2;
    if (k1 > maxDen) return null;
    b = 1 / (b - a);
  } while (Math.abs(x - h1 / k1) > Math.abs(x) * 1e-12 && Number.isFinite(b));
  return { num: h1, den: k1 };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const lcm = (a, b) => Math.abs(a * b) / (gcd(a, b) || 1);

/**
 * Partial fractions for a proper rational function whose denominator factors
 * over the rationals into distinct linear factors, plus repeated linear factors
 * and one irreducible quadratic.
 *
 * The coefficients are recovered by solving the linear system that equating
 * numerators produces — Gaussian elimination on a small dense matrix. Sampling
 * would be quicker to write and would quietly fail on repeated factors.
 */
function rulePartialFractions(e, v, depth, trail) {
  const rat = asRational(e, v);
  if (!rat) return null;
  const num = numericCoeffs(rat.num);
  const den = numericCoeffs(rat.den);
  if (!num || !den) return null;
  if (den.length < 2) return null;

  // Improper: divide first. ∫(x³+1)/(x+1) needs the polynomial part.
  if (num.length >= den.length) {
    const { quotient, remainder } = polyDivide(num, den);
    const polyPart = inner(polyToNode(quotient.map(NUM), v), v, depth, trail);
    if (!polyPart) return null;
    if (remainder.every((c) => Math.abs(c) < 1e-12)) return polyPart;
    const rest = inner(mul(polyToNode(remainder.map(NUM), v), pow(polyToNode(den.map(NUM), v), NUM(-1))), v, depth + 1, trail);
    return rest ? add(polyPart, rest) : null;
  }

  const factored = factorPolynomial(den);
  if (!factored) return null;
  const { lead, linear, quadratic } = factored;
  if (!linear.length && !quadratic.length) return null;

  // Build the ansatz: A/(x−r) + B/(x−r)² + … + (Cx+D)/(x²+px+q)
  const terms = [];
  for (const { root, multiplicity } of linear) {
    for (let m = 1; m <= multiplicity; m++) terms.push({ kind: 'linear', root, power: m });
  }
  for (const q of quadratic) terms.push({ kind: 'quadX', q }, { kind: 'quadC', q });
  if (!terms.length) return null;

  const unknowns = terms.length;
  const degree = den.length - 1;
  if (unknowns > degree) return null;

  // Equate numerators: Σ cᵢ·(denominator with that factor removed) = numerator.
  const rows = [];
  for (const t of terms) rows.push(numeratorContribution(t, factored, degree));
  const A = [];
  for (let r = 0; r < degree; r++) {
    A.push([...rows.map((row) => row[r] ?? 0), (num[r] ?? 0) / lead]);
  }
  const sol = solveLinear(A, unknowns);
  if (!sol) return null;

  const pieces = [];
  for (let i = 0; i < terms.length; i++) {
    const c = sol[i];
    if (Math.abs(c) < 1e-13) continue;
    const t = terms[i];
    if (t.kind === 'linear') {
      const shifted = sub(VAR(v), NUM(t.root));
      if (t.power === 1) pieces.push(mul(NUM(c), call('ln', call('abs', shifted))));
      else pieces.push(mul(NUM(c / (1 - t.power)), pow(shifted, NUM(1 - t.power))));
    } else {
      const { p, q } = t.q;
      // (Cx + D)/(x² + px + q), completed square: u = x + p/2, k² = q − p²/4
      const k2 = q - (p * p) / 4;
      if (k2 <= 0) return null;
      const k = Math.sqrt(k2);
      const u = add(VAR(v), NUM(p / 2));
      if (t.kind === 'quadX') {
        // C·x/(…) = C/2·(2x+p)/(…) − C·p/2·1/(…)
        pieces.push(mul(NUM(c / 2), call('ln', add(pow(VAR(v), NUM(2)), mul(NUM(p), VAR(v)), NUM(q)))));
        pieces.push(mul(NUM((-c * p) / (2 * k)), call('atan', mul(NUM(1 / k), u))));
      } else {
        pieces.push(mul(NUM(c / k), call('atan', mul(NUM(1 / k), u))));
      }
    }
  }
  if (!pieces.length) return null;
  return mul(NUM(1 / lead), add(pieces));
}

/** Coefficients (lowest first) of the polynomial multiplying one ansatz term. */
function numeratorContribution(term, factored, degree) {
  let poly = [1];
  for (const { root, multiplicity } of factored.linear) {
    let times = multiplicity;
    if (term.kind === 'linear' && term.root === root) times = multiplicity - term.power;
    for (let i = 0; i < times; i++) poly = polyMul(poly, [-root, 1]);
  }
  for (const q of factored.quadratic) {
    const isMine = (term.kind === 'quadX' || term.kind === 'quadC') && term.q === q;
    if (!isMine) poly = polyMul(poly, [q.q, q.p, 1]);
  }
  if (term.kind === 'quadX') poly = polyMul(poly, [0, 1]);
  const out = new Array(degree).fill(0);
  for (let i = 0; i < poly.length && i < degree; i++) out[i] = poly[i];
  return out;
}

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}

function polyDivide(num, den) {
  const q = new Array(Math.max(0, num.length - den.length + 1)).fill(0);
  const r = num.slice();
  const dLead = den[den.length - 1];
  for (let i = r.length - den.length; i >= 0; i--) {
    const c = r[i + den.length - 1] / dLead;
    q[i] = c;
    for (let j = 0; j < den.length; j++) r[i + j] -= c * den[j];
  }
  while (r.length > 1 && Math.abs(r[r.length - 1]) < 1e-12) r.pop();
  return { quotient: q, remainder: r };
}

/** Factor into a lead coefficient, linear factors with multiplicity, and quadratics. */
function factorPolynomial(coeffs) {
  const lead = coeffs[coeffs.length - 1];
  const monic = coeffs.map((c) => c / lead);
  const found = rationalRoots(monic);
  if (!found) return null;

  const counts = new Map();
  for (const r of found.roots) counts.set(r, (counts.get(r) ?? 0) + 1);
  const linear = [...counts.entries()].map(([root, multiplicity]) => ({ root, multiplicity }));

  const rest = found.remainder;
  const quadratic = [];
  if (rest.length === 3) {
    const p = rest[1] / rest[2], q = rest[0] / rest[2];
    if (p * p - 4 * q < 0) quadratic.push({ p, q });
    else return null;                     // real roots the rational search missed
  } else if (rest.length > 1) {
    return null;                          // higher-degree irreducible part
  }

  return { lead, linear, quadratic };
}

/** Gaussian elimination with partial pivoting on an augmented matrix. */
function solveLinear(A, n) {
  const m = A.length;
  if (m < n) return null;
  const M = A.map((r) => r.slice());
  const pivotRows = [];
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let best = row;
    for (let r = row; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[best][col])) best = r;
    if (Math.abs(M[best][col]) < 1e-12) continue;
    [M[row], M[best]] = [M[best], M[row]];
    for (let r = 0; r < m; r++) {
      if (r === row) continue;
      const f = M[r][col] / M[row][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[row][c];
    }
    pivotRows.push({ row, col });
    row++;
  }
  if (pivotRows.length < n) return null;
  const x = new Array(n).fill(0);
  for (const { row: r, col: c } of pivotRows) x[c] = M[r][n] / M[r][c];
  // Consistency: the rows we did not pivot on must be satisfied too.
  for (let r = row; r < m; r++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += M[r][c] * x[c];
    if (Math.abs(s - M[r][n]) > 1e-7 * Math.max(1, Math.abs(M[r][n]))) return null;
  }
  return x;
}

// ── rule 8: the cyclic case, e^(ax)·sin(bx) ─────────────────────────────────

/**
 * ∫e^(ax)·sin(bx) dx and its cosine twin.
 *
 * Integration by parts on these does not terminate: two applications return the
 * original integral, and the classical move is to treat that as an equation and
 * solve for it —
 *
 *     I = e^(ax)(a·sin bx − b·cos bx)/(a² + b²)
 *
 * A recursive search cannot discover that by itself; it simply spirals until it
 * runs out of depth. So the closed form goes in the table, where the verifier
 * checks it like anything else.
 */
function ruleCyclicParts(e, v) {
  const s = simplify(e);
  if (s.k !== 'mul' || s.args.length < 2) return null;

  let a = null, b = null, trig = null, coeff = 1;
  for (const f of s.args) {
    if (f.k === 'num') { coeff *= f.v; continue; }
    const expLin = exponentialRate(f, v);
    if (expLin !== null) { if (a !== null) return null; a = expLin; continue; }
    if (f.k === 'call' && (f.name === 'sin' || f.name === 'cos') && f.args.length === 1) {
      const lin = asLinear(f.args[0], v);
      if (!lin) return null;
      const A = simplify(lin.a), B = simplify(lin.b);
      if (A.k !== 'num' || !isZero(B)) return null;   // phase shifts not handled
      if (b !== null) return null;
      b = A.v; trig = f.name;
      continue;
    }
    return null;
  }
  if (a === null || b === null || !b) return null;

  const denom = a * a + b * b;
  const x = VAR(v);
  const E = call('exp', mul(NUM(a), x));
  const S = call('sin', mul(NUM(b), x));
  const C = call('cos', mul(NUM(b), x));

  const body = trig === 'sin'
    ? add(mul(NUM(a), S), mul(NUM(-b), C))
    : add(mul(NUM(a), C), mul(NUM(b), S));
  return mul(NUM(coeff / denom), E, body);
}

/** If f is e^(a·v) — written either way — return a. */
function exponentialRate(f, v) {
  if (f.k === 'call' && f.name === 'exp' && f.args.length === 1) {
    const lin = asLinear(f.args[0], v);
    if (!lin) return null;
    const A = simplify(lin.a), B = simplify(lin.b);
    if (A.k !== 'num' || !isZero(B)) return null;
    return A.v;
  }
  if (f.k === 'pow' && f.base.k === 'const' && f.base.name === 'e') {
    const lin = asLinear(f.exp, v);
    if (!lin) return null;
    const A = simplify(lin.a), B = simplify(lin.b);
    if (A.k !== 'num' || !isZero(B)) return null;
    return A.v;
  }
  return null;
}

// ── rule 9: trigonometric substitution ──────────────────────────────────────

/**
 * The three square-root forms that a trigonometric substitution linearises.
 *
 *   √(a² − x²)   x = a·sin θ    because 1 − sin²θ = cos²θ
 *   √(a² + x²)   x = a·tan θ    because 1 + tan²θ = sec²θ
 *   √(x² − a²)   x = a·sec θ    because sec²θ − 1 = tan²θ
 *
 * Each one trades a root for a trigonometric power, which the reduction rule
 * below then handles. Rather than carry the substitution through symbolically
 * and undo it with a right-triangle argument — which is where this goes wrong
 * by hand — the results are tabulated in their standard closed forms and left
 * to the verifier to confirm. Only the a² > 0 cases are attempted; the rest
 * fall through to the other rules.
 */
function ruleTrigSubstitution(e, v, depth, trail) {
  const s = simplify(e);
  const root = asSqrtQuadratic(s, v);
  if (!root) return null;
  const { A, C, power } = root;         // (A·x² + C)^(power/2), power odd

  const x = VAR(v);
  if (power === 1) {
    if (A < 0 && C > 0) {
      // ∫√(a² − x²) dx = ½(x√(a² − x²) + a²·asin(x/a))
      const a2 = C / -A, a = Math.sqrt(a2), k = Math.sqrt(-A);
      return mul(NUM(k / 2), add(
        mul(x, pow(sub(NUM(a2), pow(x, NUM(2))), NUM(0.5))),
        mul(NUM(a2), call('asin', mul(NUM(1 / a), x))),
      ));
    }
    if (A > 0 && C > 0) {
      // ∫√(x² + a²) dx = ½(x√(x² + a²) + a²·asinh(x/a))
      const a2 = C / A, a = Math.sqrt(a2), k = Math.sqrt(A);
      return mul(NUM(k / 2), add(
        mul(x, pow(add(pow(x, NUM(2)), NUM(a2)), NUM(0.5))),
        mul(NUM(a2), call('asinh', mul(NUM(1 / a), x))),
      ));
    }
    if (A > 0 && C < 0) {
      // ∫√(x² − a²) dx = ½(x√(x² − a²) − a²·acosh(x/a))
      const a2 = -C / A, a = Math.sqrt(a2), k = Math.sqrt(A);
      return mul(NUM(k / 2), sub(
        mul(x, pow(sub(pow(x, NUM(2)), NUM(a2)), NUM(0.5))),
        mul(NUM(a2), call('acosh', mul(NUM(1 / a), x))),
      ));
    }
    return null;
  }

  if (power === -1) {
    // These three are already in ruleSpecialForms for a = 1; this generalises
    // them to any positive a.
    if (A < 0 && C > 0) {
      const a = Math.sqrt(C / -A), k = Math.sqrt(-A);
      return mul(NUM(1 / k), call('asin', mul(NUM(1 / a), x)));
    }
    if (A > 0 && C > 0) {
      const a = Math.sqrt(C / A), k = Math.sqrt(A);
      return mul(NUM(1 / k), call('asinh', mul(NUM(1 / a), x)));
    }
    if (A > 0 && C < 0) {
      const a = Math.sqrt(-C / A), k = Math.sqrt(A);
      return mul(NUM(1 / k), call('acosh', mul(NUM(1 / a), x)));
    }
  }
  return null;
}

/** Read e as (A·v² + C)^(power/2) with numeric A, C and odd integer power. */
function asSqrtQuadratic(e, v) {
  let base = null, power = null;
  if (e.k === 'call' && e.name === 'sqrt' && e.args.length === 1) { base = e.args[0]; power = 1; }
  else if (e.k === 'pow' && e.exp.k === 'num') {
    const twice = e.exp.v * 2;
    if (!Number.isInteger(twice) || twice % 2 === 0) return null;
    base = e.base; power = twice;
  }
  if (!base || (power !== 1 && power !== -1)) return null;

  const q = asQuadratic(base, v);
  if (!q) return null;
  const A = simplify(q.a), B = simplify(q.b), C = simplify(q.c);
  if (!isZero(B)) return null;
  if (A.k !== 'num' || C.k !== 'num' || A.v === 0) return null;
  return { A: A.v, C: C.v, power };
}

// ── rule 9: trigonometric powers ────────────────────────────────────────────

/**
 * ∫sinᵐx·cosⁿx dx by the classical case split. An odd power of either function
 * peels off one factor to be the differential of the other, which is a
 * substitution; both even goes through the half-angle identities.
 */
function ruleTrigPowers(e, v, depth, trail) {
  const s = simplify(e);
  const { m, n, ok } = trigPowers(s, v);
  if (!ok) return null;
  if (m === 0 && n === 0) return null;

  if (m % 2 === 1 && m > 0) {
    // ∫sin^m cos^n = −∫(1−u²)^((m−1)/2) uⁿ du with u = cos x
    const u = 'ζ';
    const k = (m - 1) / 2;
    const body = mul(NUM(-1), pow(sub(ONE, pow(VAR(u), NUM(2))), NUM(k)), pow(VAR(u), NUM(n)));
    const G = inner(simplify(expand(body)), u, depth, trail);
    return G ? substitute(G, u, call('cos', VAR(v))) : null;
  }
  if (n % 2 === 1 && n > 0) {
    const u = 'ζ';
    const k = (n - 1) / 2;
    const body = mul(pow(VAR(u), NUM(m)), pow(sub(ONE, pow(VAR(u), NUM(2))), NUM(k)));
    const G = inner(simplify(expand(body)), u, depth, trail);
    return G ? substitute(G, u, call('sin', VAR(v))) : null;
  }

  // Both even: sin² = (1 − cos 2x)/2, cos² = (1 + cos 2x)/2.
  if (m % 2 === 0 && n % 2 === 0 && (m + n) > 0 && (m + n) <= 8) {
    const two = mul(NUM(2), VAR(v));
    const sinSq = mul(NUM(0.5), sub(ONE, call('cos', two)));
    const cosSq = mul(NUM(0.5), add(ONE, call('cos', two)));
    const body = simplify(expand(mul(pow(sinSq, NUM(m / 2)), pow(cosSq, NUM(n / 2)))));
    return inner(body, v, depth + 1, trail);
  }
  return null;
}

/** Read e as sin(v)^m · cos(v)^n with non-negative integer m, n. */
function trigPowers(e, v) {
  let m = 0, n = 0;
  const factors = e.k === 'mul' ? e.args : [e];
  for (const f of factors) {
    let base = f, exp = 1;
    if (f.k === 'pow') {
      if (f.exp.k !== 'num' || !Number.isInteger(f.exp.v) || f.exp.v < 0) return { ok: false };
      base = f.base; exp = f.exp.v;
    }
    if (base.k !== 'call' || !argIsVar(base, v)) return { ok: false };
    if (base.name === 'sin') m += exp;
    else if (base.name === 'cos') n += exp;
    else return { ok: false };
  }
  return { m, n, ok: true };
}

// ── rule order ──────────────────────────────────────────────────────────────

const RULES = [
  { name: 'constant', fn: ruleConstant },
  { name: 'power rule', fn: rulePower },
  { name: 'standard form', fn: ruleTable },
  { name: 'standard form', fn: ruleSpecialForms },
  { name: 'sum rule', fn: ruleSum },
  { name: 'constant multiple', fn: ruleConstantMultiple },
  { name: 'linear substitution', fn: ruleLinearSubstitution },
  { name: 'cyclic integration by parts', fn: ruleCyclicParts },
  { name: 'trigonometric substitution', fn: ruleTrigSubstitution },
  { name: 'trigonometric reduction', fn: ruleTrigPowers },
  { name: 'substitution', fn: ruleSubstitution },
  { name: 'partial fractions', fn: rulePartialFractions },
  { name: 'integration by parts', fn: rulePartsRule },
];

// ── definite integrals ──────────────────────────────────────────────────────

/**
 * Evaluate F(b) − F(a) exactly, when an antiderivative was found.
 *
 * This is only valid when F is continuous on [a, b] — the fundamental theorem
 * says so, and ∫₋₁¹ dx/x² is the standard counterexample where ignoring the
 * condition produces −2 for the integral of a positive function. The check
 * below samples F′ for a pole inside the interval and refuses the exact
 * evaluation when it finds one, rather than reporting a confident wrong number.
 */
export function definite(f, a, b, v = X) {
  const anti = integrate(f, v);
  if (!anti.ok) return { ok: false, reason: anti.reason, antiderivative: null };

  const F = anti.antiderivative;
  let g;
  try { g = compileSafe(F, [v]); } catch { return { ok: false, reason: 'The antiderivative could not be evaluated.' }; }

  const disc = discontinuityInside(f, a, b, v);
  if (disc !== null) {
    return {
      ok: false,
      antiderivative: F,
      method: anti.method,
      reason: `The integrand is not continuous at x ≈ ${disc.toPrecision(6)}, which is inside [${a}, ${b}]. `
        + 'The fundamental theorem of calculus does not apply across a discontinuity, so evaluating '
        + 'F(b) − F(a) here would produce a confident wrong number. Split the interval, or treat it as improper.',
      discontinuity: disc,
    };
  }

  const Fa = g(a), Fb = g(b);
  if (!Number.isFinite(Fa) || !Number.isFinite(Fb)) {
    return {
      ok: false,
      antiderivative: F,
      method: anti.method,
      reason: 'The antiderivative is not finite at one of the endpoints, so this is an improper integral.',
    };
  }

  return {
    ok: true,
    value: Fb - Fa,
    antiderivative: F,
    method: anti.method,
    verification: anti.verification,
    verificationDetail: anti.verificationDetail,
    endpoints: { Fa, Fb },
  };
}

/**
 * Look for a pole of the integrand strictly inside (a, b).
 *
 * Sampling, so it can miss one — a numerical search cannot prove continuity.
 * It is used only to *reject* an exact evaluation, never to bless one, so a
 * miss costs an over-confident answer in a rare case while a hit prevents a
 * wrong one in a common case.
 */
function discontinuityInside(f, a, b, v) {
  let h;
  try { h = compileSafe(simplify(f), [v]); } catch { return null; }
  const N = 400;
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const x = a + ((b - a) * i) / N;
    const y = h(x);
    if (!Number.isFinite(y) && i > 0 && i < N) return x;
    if (prev !== null && Number.isFinite(y) && Number.isFinite(prev.y)) {
      // A jump of many orders of magnitude between neighbouring samples is a
      // pole; refine to locate it rather than reporting the sample point.
      const jump = Math.abs(y - prev.y);
      const scale = Math.max(Math.abs(y), Math.abs(prev.y), 1);
      if (jump > 1e6 * scale / N && Math.sign(y) !== Math.sign(prev.y) && Math.abs(y) > 1e6) {
        return (x + prev.x) / 2;
      }
    }
    prev = { x, y };
  }
  return null;
}
