/*
  derivative.js: exact symbolic differentiation.
  ..................................................

  Differentiation is the easy direction. Every elementary function has a
  derivative that is elementary, the rules compose mechanically, and there is
  no search: the algorithm is a recursive descent that always terminates with
  an answer.

  Integration is not like that at all, which is why this file is a hundred
  lines and `integrate.js` is a thousand. It is also why this file is the
  *referee* for that one: an antiderivative can be found by any heuristic you
  like, as long as differentiating it gets you back to where you started.
*/

import {
  NUM, ZERO, ONE, add, mul, pow, call, neg, div, sub, CONST,
  isNum, dependsOn,
} from './ast.js';
import { simplify } from './simplify.js';

/**
 * d/dvar of an expression.
 *
 * @param {object} node
 * @param {string} v      variable to differentiate with respect to
 * @param {number} order  differentiate this many times (default 1)
 */
export function derivative(node, v = 'x', order = 1) {
  let out = node;
  for (let i = 0; i < order; i++) out = simplify(d(simplify(out), v));
  return out;
}

function d(n, v) {
  switch (n.k) {
    case 'num': case 'const': return ZERO;
    case 'var': return n.name === v ? ONE : ZERO;

    case 'add': return add(n.args.map((a) => d(a, v)));

    case 'mul': {
      // Product rule generalised to n factors: Σ over which factor is
      // differentiated. Constant factors fall out as zero terms and the
      // simplifier drops them, so there is no special case for them.
      const terms = n.args.map((_, i) =>
        mul(n.args.map((a, j) => (i === j ? d(a, v) : a))));
      return add(terms);
    }

    case 'pow': return dPow(n, v);
    case 'call': return dCall(n, v);

    case 'piece':
      // The derivative of a piecewise function is piecewise, and is undefined
      // at the joins unless the pieces meet smoothly. This reports the pieces
      // and stays silent about the joins rather than inventing a value there.
      return {
        k: 'piece',
        cases: n.cases.map((c) => ({ when: c.when, then: d(c.then, v) })),
        otherwise: d(n.otherwise, v),
      };

    default: throw new Error(`I cannot differentiate a "${n.k}" node.`);
  }
}

function dPow(n, v) {
  const { base, exp } = n;
  const baseHasV = dependsOn(base, v);
  const expHasV = dependsOn(exp, v);

  if (!baseHasV && !expHasV) return ZERO;

  // u^c → c·u^(c−1)·u'
  if (!expHasV) return mul(exp, pow(base, sub(exp, NUM(1))), d(base, v));

  // c^u → c^u·ln(c)·u'
  if (!baseHasV) return mul(n, call('ln', base), d(exp, v));

  // u^w with both varying. Logarithmic differentiation:
  //   (u^w)' = u^w · (w'·ln u + w·u'/u)
  // valid where u > 0, which is where u^w is defined for a general real w.
  return mul(n, add(
    mul(d(exp, v), call('ln', base)),
    mul(exp, d(base, v), pow(base, NUM(-1))),
  ));
}

/** Outer derivative of each known function, as a function of its argument. */
const OUTER = {
  sin: (u) => call('cos', u),
  cos: (u) => neg(call('sin', u)),
  tan: (u) => pow(call('sec', u), NUM(2)),
  sec: (u) => mul(call('sec', u), call('tan', u)),
  csc: (u) => neg(mul(call('csc', u), call('cot', u))),
  cot: (u) => neg(pow(call('csc', u), NUM(2))),

  asin: (u) => pow(sub(ONE, pow(u, NUM(2))), NUM(-0.5)),
  acos: (u) => neg(pow(sub(ONE, pow(u, NUM(2))), NUM(-0.5))),
  atan: (u) => pow(add(ONE, pow(u, NUM(2))), NUM(-1)),

  sinh: (u) => call('cosh', u),
  cosh: (u) => call('sinh', u),
  tanh: (u) => sub(ONE, pow(call('tanh', u), NUM(2))),
  asinh: (u) => pow(add(pow(u, NUM(2)), ONE), NUM(-0.5)),
  acosh: (u) => pow(sub(pow(u, NUM(2)), ONE), NUM(-0.5)),
  atanh: (u) => pow(sub(ONE, pow(u, NUM(2))), NUM(-1)),

  exp: (u) => call('exp', u),
  ln: (u) => pow(u, NUM(-1)),
  log10: (u) => pow(mul(u, call('ln', NUM(10))), NUM(-1)),
  log2: (u) => pow(mul(u, call('ln', NUM(2))), NUM(-1)),

  sqrt: (u) => mul(NUM(0.5), pow(u, NUM(-0.5))),
  cbrt: (u) => mul(NUM(1 / 3), pow(u, NUM(-2 / 3))),

  // |u|' = sign(u)·u', undefined at u = 0 — which sign() reports as 0, and
  // which is the closest a total function gets to "there is no derivative
  // here". The kink is real and the display says so.
  abs: (u) => call('sign', u),
  // A step function is flat wherever it is defined, and has no derivative at
  // the step. Zero is right almost everywhere; the exception is a single point.
  sign: () => ZERO,
  floor: () => ZERO,
  ceil: () => ZERO,
  round: () => ZERO,

  // d/du erf(u) = 2/√π · e^(−u²)
  erf: (u) => mul(NUM(2 / Math.sqrt(Math.PI)), call('exp', neg(pow(u, NUM(2))))),
};

function dCall(n, v) {
  const f = OUTER[n.name];
  if (f) {
    if (n.args.length !== 1) throw new Error(`${n.name} takes one argument here.`);
    return mul(f(n.args[0]), d(n.args[0], v));   // chain rule
  }

  // log(u, b) with constant base
  if (n.name === 'log' && n.args.length === 2 && !dependsOn(n.args[1], v)) {
    return mul(pow(mul(n.args[0], call('ln', n.args[1])), NUM(-1)), d(n.args[0], v));
  }

  // min/max are piecewise-smooth; away from the crossing the derivative is that
  // of whichever branch is active. Reporting that honestly needs a piecewise
  // result rather than a single expression.
  if ((n.name === 'min' || n.name === 'max') && n.args.length === 2) {
    const [a, b] = n.args;
    const pick = n.name === 'min' ? call('le', a, b) : call('ge', a, b);
    return { k: 'piece', cases: [{ when: pick, then: d(a, v) }], otherwise: d(b, v) };
  }

  throw new Error(`I don't have a derivative rule for "${n.name}".`);
}

/** Is this function one the differentiator knows? */
export function canDifferentiate(name) {
  return Boolean(OUTER[name]) || name === 'log' || name === 'min' || name === 'max';
}

export { OUTER as DERIVATIVE_RULES };
