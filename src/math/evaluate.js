/*
  evaluate.js: expression tree to a fast numeric closure.
  ...........................................................

  Quadrature calls f tens of thousands of times per run and Monte Carlo calls
  it millions, so walking the tree per sample is not good enough. `compile`
  emits JavaScript source from the *tree* — never from the user's string: and
  builds one function from it. The distinction matters: the generated text is
  assembled from node kinds and numeric literals that this module controls, so
  nothing a user types reaches the compiler as code.

  The compiled function is also where domain trouble surfaces. Real analysis
  has holes in it — ln of a negative, √ of a negative, 1/0, tan at π/2: and
  every one of those is a place a numerical integrator can silently produce a
  beautiful wrong answer. The convention here is that such points evaluate to
  NaN, and every consumer treats NaN as "no value here", not as zero.
*/

import { CONST_VALUES } from './ast.js';

//  the runtime the compiled code is closed over  ........................
/** Lanczos approximation to the gamma function, g = 7, n = 9. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/**
 * Error function, Abramowitz & Stegun 7.1.26: about 1.5e-7 absolute.
 *
 * Good enough to *draw*, not good enough to be an answer. This is why the
 * Gaussian integral example is checked against a numerical quadrature rather
 * than against erf: a 1e-7 reference cannot certify a 1e-12 result.
 */
function erf(x) {
  const sign = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

const RUNTIME = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  exp: Math.exp, ln: Math.log, log10: Math.log10, log2: Math.log2,
  log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max,
  mod: (a, b) => a - b * Math.floor(a / b),
  gamma, erf,
  pow: Math.pow,
  lt: (a, b) => (a < b ? 1 : 0), gt: (a, b) => (a > b ? 1 : 0),
  le: (a, b) => (a <= b ? 1 : 0), ge: (a, b) => (a >= b ? 1 : 0),
  eq: (a, b) => (a === b ? 1 : 0), ne: (a, b) => (a !== b ? 1 : 0),
};

const RUNTIME_NAMES = Object.keys(RUNTIME);

//  code generation  .....................................................
function emit(node, vars) {
  switch (node.k) {
    case 'num': return literal(node.v);
    case 'const': return literal(CONST_VALUES[node.name] ?? NaN);
    case 'var': {
      if (!vars.includes(node.name)) {
        throw new Error(`"${node.name}" has no value here. The variables in scope are ${vars.map((v) => `"${v}"`).join(', ')}.`);
      }
      return node.name;
    }
    case 'add': return `(${node.args.map((a) => emit(a, vars)).join('+')})`;
    case 'mul': return `(${node.args.map((a) => emit(a, vars)).join('*')})`;
    case 'pow': {
      const b = emit(node.base, vars);
      const e = node.exp;
      // Small integer powers unrolled: Math.pow(x, 2) is measurably slower than
      // x*x, and at a million samples that difference is the whole budget.
      if (e.k === 'num' && Number.isInteger(e.v) && Math.abs(e.v) <= 4) {
        const n = Math.abs(e.v);
        if (n === 0) return '1';
        const body = n === 1 ? b : `Math.pow(${b},${n})`;
        const unrolled = n === 2 ? `(${b}*${b})` : n === 3 ? `(${b}*${b}*${b})` : n === 4 ? `((${b})*(${b})*(${b})*(${b}))` : body;
        return e.v < 0 ? `(1/${unrolled})` : unrolled;
      }
      return `Math.pow(${b},${emit(e, vars)})`;
    }
    case 'call': {
      if (!RUNTIME[node.name]) throw new Error(`I don't know the function "${node.name}".`);
      return `R.${node.name}(${node.args.map((a) => emit(a, vars)).join(',')})`;
    }
    case 'piece': {
      let out = emit(node.otherwise, vars);
      for (let i = node.cases.length - 1; i >= 0; i--) {
        const c = node.cases[i];
        out = `((${emit(c.when, vars)})?(${emit(c.then, vars)}):(${out}))`;
      }
      return out;
    }
    default: throw new Error(`I don't know how to evaluate a "${node.k}" node.`);
  }
}

function literal(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  // Bracket negatives so that a-(-3) does not emit `a--3`.
  return v < 0 ? `(${v})` : String(v);
}

/**
 * Compile an expression to `(…vars) => number`.
 *
 * @param {object} ast
 * @param {string[]} vars  variable names, in the order the closure takes them
 * @returns {(...args: number[]) => number}
 */
export function compile(ast, vars = ['x']) {
  const body = emit(ast, vars);
  // eslint-disable-next-line no-new-func
  const factory = new Function('R', `"use strict";return function(${vars.join(',')}){return ${body};};`);
  const fn = factory(RUNTIME);
  fn.source = body;
  fn.vars = vars;
  return fn;
}

/**
 * Compile, and wrap so that non-finite results and thrown errors both come back
 * as NaN.
 *
 * Every numerical routine in INTEGRA is written against this contract: a sample
 * is either a finite number or it is absent. Letting an Infinity through would
 * poison a whole Riemann sum with one endpoint, and turning it into 0 would be
 * a fabricated value, which is worse, because the answer would look fine.
 */
export function compileSafe(ast, vars = ['x']) {
  const raw = compile(ast, vars);
  const fn = (...args) => {
    let v;
    try { v = raw(...args); } catch { return NaN; }
    return Number.isFinite(v) ? v : NaN;
  };
  fn.source = raw.source;
  fn.vars = vars;
  fn.raw = raw;
  return fn;
}

/** Evaluate once, with a plain object of variable bindings. */
export function evaluate(ast, bindings = {}) {
  const vars = Object.keys(bindings);
  return compile(ast, vars)(...vars.map((v) => bindings[v]));
}

export { RUNTIME, RUNTIME_NAMES, gamma, erf };
