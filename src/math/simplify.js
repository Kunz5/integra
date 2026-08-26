/*
  simplify.js: push an expression into canonical form.
  ........................................................

  Simplification here is not "make it prettier". It is the operation that makes
  structural equality mean something: `x + x` and `2x` are the same expression,
  and until they are the same *tree*, nothing downstream, the integrator's
  pattern matching, the check that a derivative came back to where it started,
  the decision that a term vanished; can see that.

  The canonical form:
    · sums and products are n-ary and flat, never nested chains of binaries
    · numeric factors and terms are folded into one, and lead
    · like terms are collected: x + x → 2x,  x·x → x²
    · arguments are sorted by the total order in ast.js
    · powers of powers are flattened where that is unconditionally valid

  What it deliberately does NOT do: anything that is only true on part of the
  domain. √(x²) does not become x, ln(eˣ) does not become x, and (x²)^(1/2)
  stays put. Those "simplifications" are false for half the real line, and a
  mathematics tool that quietly makes them is worse than one that leaves the
  expression alone.
*/

import {
  NUM, VAR, CONST, add, mul, pow, call, numericValue, isNum, isZero, isOne,
  equal, compare, clone, CONST_VALUES,
} from './ast.js';

/** Simplify to canonical form. Idempotent: simplify(simplify(e)) === simplify(e). */
export function simplify(node) {
  if (!node || typeof node !== 'object') return node;
  switch (node.k) {
    case 'num': return Object.is(node.v, -0) ? NUM(0) : node;
    case 'var': case 'const': return node;
    case 'add': return simplifyAdd(node.args.map(simplify));
    case 'mul': return simplifyMul(node.args.map(simplify));
    case 'pow': return simplifyPow(simplify(node.base), simplify(node.exp));
    case 'call': return simplifyCall(node.name, node.args.map(simplify));
    case 'piece':
      return {
        k: 'piece',
        cases: node.cases.map((c) => ({ when: simplify(c.when), then: simplify(c.then) })),
        otherwise: simplify(node.otherwise),
      };
    default: return node;
  }
}

//  sums  ................................................................
function simplifyAdd(args) {
  const flat = [];
  for (const a of args) {
    if (a.k === 'add') flat.push(...a.args);
    else flat.push(a);
  }

  let constant = 0;
  /** term key (printed form of the non-numeric part) → { coeff, term } */
  const terms = new Map();

  for (const a of flat) {
    const n = a.k === 'num' ? a.v : null;
    if (n !== null) { constant += n; continue; }

    const { coeff, rest } = splitCoefficient(a);
    const key = keyOf(rest);
    const existing = terms.get(key);
    if (existing) existing.coeff += coeff;
    else terms.set(key, { coeff, term: rest });
  }

  const out = [];
  for (const { coeff, term } of terms.values()) {
    if (coeff === 0) continue;
    if (coeff === 1) out.push(term);
    else out.push(simplifyMul([NUM(coeff), term]));
  }

  if (constant !== 0 || out.length === 0) out.unshift(NUM(constant));
  if (out.length === 1) return out[0];
  out.sort(compare);
  return { k: 'add', args: out };
}

/** Split a·f into the number a and the rest f. */
function splitCoefficient(node) {
  if (node.k === 'mul') {
    let coeff = 1;
    const rest = [];
    for (const f of node.args) {
      if (f.k === 'num') coeff *= f.v;
      else rest.push(f);
    }
    if (rest.length === 0) return { coeff, rest: NUM(1) };
    if (rest.length === 1) return { coeff, rest: rest[0] };
    return { coeff, rest: { k: 'mul', args: rest } };
  }
  return { coeff: 1, rest: node };
}

//  products  ............................................................
function simplifyMul(args) {
  const flat = [];
  for (const a of args) {
    if (a.k === 'mul') flat.push(...a.args);
    else flat.push(a);
  }

  let coeff = 1;
  /** base key → { base, exponents[] } */
  const factors = new Map();

  for (const a of flat) {
    if (a.k === 'num') {
      coeff *= a.v;
      if (coeff === 0) return NUM(0);
      continue;
    }
    const { base, exp } = splitPower(a);
    const key = keyOf(base);
    const existing = factors.get(key);
    if (existing) existing.exps.push(exp);
    else factors.set(key, { base, exps: [exp] });
  }

  if (coeff === 0) return NUM(0);

  const out = [];
  for (const { base, exps } of factors.values()) {
    const e = exps.length === 1 ? exps[0] : simplifyAdd(exps);
    const p = simplifyPow(base, e);
    if (p.k === 'num') { coeff *= p.v; continue; }
    if (isOne(p)) continue;
    out.push(p);
  }

  if (coeff === 0) return NUM(0);
  if (out.length === 0) return NUM(coeff);
  if (coeff !== 1) out.unshift(NUM(coeff));
  if (out.length === 1) return out[0];
  out.sort(compare);
  return { k: 'mul', args: out };
}

/** Read f as base^exp. */
function splitPower(node) {
  if (node.k === 'pow') return { base: node.base, exp: node.exp };
  return { base: node, exp: NUM(1) };
}

//  powers  ..............................................................
function simplifyPow(base, exp) {
  if (isZero(exp)) {
    // 0^0 is left as-is rather than declared 1: it is genuinely undefined as a
    // limit, and the honest thing is not to pick a side silently.
    if (isZero(base)) return pow(base, exp);
    return NUM(1);
  }
  if (isOne(exp)) return base;
  if (isOne(base)) return NUM(1);
  if (isZero(base) && exp.k === 'num' && exp.v > 0) return NUM(0);

  if (base.k === 'num' && exp.k === 'num') {
    const v = Math.pow(base.v, exp.v);
    // Keep exact integer and simple rational results; leave anything that has
    // become an inexact float as a power, so that √2 stays √2.
    if (Number.isFinite(v)) {
      if (Number.isInteger(v)) return NUM(v);
      if (Number.isInteger(exp.v)) return NUM(v);
    }
    return { k: 'pow', base, exp };
  }

  // e^(ln u) → u. Valid wherever ln u is defined, which is exactly where the
  // left side is defined too, so this one is safe.
  if (base.k === 'const' && base.name === 'e' && exp.k === 'call' && exp.name === 'ln') {
    return exp.args[0];
  }

  // (u^a)^b → u^(ab) only when b is an integer. For non-integer b this is false
  // — (x²)^(1/2) is |x|, not x, and that is exactly the kind of quiet lie this
  // module refuses to tell.
  if (base.k === 'pow' && exp.k === 'num' && Number.isInteger(exp.v)) {
    return simplifyPow(base.base, simplifyMul([base.exp, exp]));
  }
  if (base.k === 'pow' && base.exp.k === 'num' && Number.isInteger(base.exp.v) && isOddInteger(base.exp.v)) {
    // (u^odd)^b = u^(odd·b) is also safe: an odd power preserves sign.
    return simplifyPow(base.base, simplifyMul([base.exp, exp]));
  }

  // (a·b)^n → a^n·b^n for integer n only, same reason.
  if (base.k === 'mul' && exp.k === 'num' && Number.isInteger(exp.v)) {
    return simplifyMul(base.args.map((f) => simplifyPow(f, exp)));
  }

  return { k: 'pow', base, exp };
}

const isOddInteger = (v) => Number.isInteger(v) && Math.abs(v % 2) === 1;

//  function calls  ......................................................
/** Exact values worth knowing, keyed by function then by argument's printed form. */
const EXACT = {
  sin: { '0': 0, 'pi': 0, '(1/2)*pi': 1, '(1/6)*pi': 0.5 },
  cos: { '0': 1, 'pi': -1, '(1/2)*pi': 0 },
  tan: { '0': 0, 'pi': 0 },
  ln: { '1': 0, 'e': 1 },
  exp: { '0': 1 },
  asin: { '0': 0 },
  atan: { '0': 0 },
  sinh: { '0': 0 },
  tanh: { '0': 0 },
  cosh: { '0': 1 },
};

const NUMERIC = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  exp: Math.exp, ln: Math.log, log10: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
};

const ODD = new Set(['sin', 'tan', 'asin', 'atan', 'sinh', 'tanh', 'asinh', 'atanh', 'cbrt', 'sign']);
const EVEN = new Set(['cos', 'cosh', 'abs']);

function simplifyCall(name, args) {
  // Fold a numeric argument, but only to an exact integer: turning sin(1) into
  // 0.8414709848078965 loses the expression and gains nothing.
  if (args.length === 1 && args[0].k === 'num' && NUMERIC[name]) {
    const v = NUMERIC[name](args[0].v);
    if (Number.isInteger(v) && Number.isFinite(v)) return NUM(v);
  }

  const table = EXACT[name];
  if (table && args.length === 1) {
    const k = keyOf(args[0]);
    if (k in table) return NUM(table[k]);
  }

  if (args.length === 1) {
    const a = args[0];
    // Odd and even symmetry pulls a sign out, which puts −sin(−x) and sin(x)
    // into the same shape and lets a difference of them cancel.
    const negated = asNegation(a);
    if (negated) {
      if (ODD.has(name)) return simplifyMul([NUM(-1), simplifyCall(name, [negated])]);
      if (EVEN.has(name)) return simplifyCall(name, [negated]);
    }

    switch (name) {
      case 'exp':
        if (a.k === 'call' && a.name === 'ln') return a.args[0];
        return simplifyPow(CONST('e'), a);
      case 'ln':
        if (a.k === 'const' && a.name === 'e') return NUM(1);
        // ln(e^u) → u is only valid for real u, which is all this engine has.
        if (a.k === 'pow' && a.base.k === 'const' && a.base.name === 'e') return a.exp;
        break;
      case 'sqrt':
        // √(u^2) is |u|, not u. Say so.
        if (a.k === 'pow' && isNum(a.exp, 2)) return simplifyCall('abs', [a.base]);
        if (a.k === 'num' && a.v >= 0) {
          const r = Math.sqrt(a.v);
          if (Number.isInteger(r)) return NUM(r);
        }
        return simplifyPow(a, NUM(0.5));
      case 'abs':
        if (a.k === 'call' && a.name === 'abs') return a;
        if (a.k === 'num') return NUM(Math.abs(a.v));
        break;
      case 'log10': return simplifyCall('ln', [a]).k === 'num'
        ? NUM(Math.log10(numericValue(a)))
        : { k: 'call', name: 'log10', args: [a] };
      default: break;
    }
  }

  // log(x, b) → ln(x)/ln(b)
  if (name === 'log' && args.length === 2) {
    return simplifyMul([simplifyCall('ln', [args[0]]), simplifyPow(simplifyCall('ln', [args[1]]), NUM(-1))]);
  }
  if (name === 'log' && args.length === 1) return simplifyCall('log10', args);

  return { k: 'call', name, args };
}

/** If `node` is (−1)·u or a negative number, return u (or |number|). */
function asNegation(node) {
  if (node.k === 'num' && node.v < 0) return NUM(-node.v);
  if (node.k === 'mul') {
    const nums = node.args.filter((a) => a.k === 'num');
    const product = nums.reduce((p, a) => p * a.v, 1);
    if (product < 0) {
      const rest = node.args.map((a) => (a.k === 'num' ? NUM(-a.v) : a));
      return simplifyMul(rest);
    }
  }
  return null;
}

//  keys  ................................................................
/**
 * A canonical string for a node, used to group like terms. This is why the
 * grouping is O(n) rather than O(n²) structural comparisons, and it is only
 * ever used on already-simplified subtrees, so equal keys mean equal trees.
 */
export function keyOf(node) {
  switch (node.k) {
    case 'num': return String(node.v);
    case 'var': return node.name;
    case 'const': return node.name;
    case 'add': return `(${node.args.map(keyOf).join('+')})`;
    case 'mul': return `(${node.args.map(keyOf).join('*')})`;
    case 'pow': return `${keyOf(node.base)}^${keyOf(node.exp)}`;
    case 'call': return `${node.name}(${node.args.map(keyOf).join(',')})`;
    case 'piece': return `piece(${node.cases.map((c) => `${keyOf(c.when)}:${keyOf(c.then)}`).join(',')};${keyOf(node.otherwise)})`;
    default: return '?';
  }
}

/**
 * Are two expressions the same after simplification?
 *
 * A structural test on canonical forms. It answers "yes" soundly and "no"
 * incompletely — a "no" means *this* simplifier could not show them equal, not
 * that they differ. General equivalence of elementary expressions is
 * undecidable (Richardson's theorem), so no implementation can do better in
 * every case, and claiming otherwise would be the lie.
 */
export function structurallyEqual(a, b) {
  return equal(simplify(a), simplify(b));
}

/** Expand products over sums: (a+b)(c+d) → ac+ad+bc+bd. */
export function expand(node) {
  const e = simplify(node);
  return simplify(expandOnce(e));
}

function expandOnce(node) {
  if (!node || typeof node !== 'object') return node;
  switch (node.k) {
    case 'add': return { k: 'add', args: node.args.map(expandOnce) };
    case 'mul': {
      const factors = node.args.map(expandOnce);
      let terms = [NUM(1)];
      for (const f of factors) {
        const fs = f.k === 'add' ? f.args : [f];
        const next = [];
        for (const t of terms) for (const g of fs) next.push(mul(t, g));
        terms = next;
        if (terms.length > 4096) return node;   // refuse to blow up
      }
      return terms.length === 1 ? terms[0] : { k: 'add', args: terms };
    }
    case 'pow': {
      const base = expandOnce(node.base);
      const exp = node.exp;
      if (base.k === 'add' && exp.k === 'num' && Number.isInteger(exp.v) && exp.v > 1 && exp.v <= 12) {
        let acc = base;
        for (let i = 1; i < exp.v; i++) acc = expandOnce(mul(acc, base));
        return acc;
      }
      return pow(base, expandOnce(exp));
    }
    case 'call': return { k: 'call', name: node.name, args: node.args.map(expandOnce) };
    default: return node;
  }
}
