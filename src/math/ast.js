/*
  ast.js: the expression tree everything else in INTEGRA operates on.
  ..................................................................

  A mathematical expression is held as a tree, never as a string. Strings are
  what the user types and what we print; between those two points the
  expression is a structure that can be differentiated, integrated, simplified,
  compared for equality and compiled to a closure. Keeping the tree canonical;
  n-ary sums and products, sorted, with numeric parts folded; is what makes
  `sin(x)^2 + cos(x)^2 - 1` reducible and what lets the integrator recognise
  the forms it knows.

  Node shapes:
    { k: 'num',  v: Number }
    { k: 'const', name: 'pi' | 'e' }
    { k: 'var',  name: String }
    { k: 'add',  args: Node[] }              n-ary
    { k: 'mul',  args: Node[] }              n-ary
    { k: 'pow',  base: Node, exp: Node }
    { k: 'call', name: String, args: Node[] }
    { k: 'piece', cases: [{ when: Node, then: Node }], otherwise: Node }
*/

export const NUM = (v) => ({ k: 'num', v });
export const VAR = (name) => ({ k: 'var', name });
export const CONST = (name) => ({ k: 'const', name });

export const ZERO = NUM(0);
export const ONE = NUM(1);
export const NEG_ONE = NUM(-1);
export const PI = CONST('pi');
export const E = CONST('e');

export const CONST_VALUES = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };

/** Raw constructors. These do not simplify; `simplify.js` owns that. */
export const add = (...args) => ({ k: 'add', args: args.flat() });
export const mul = (...args) => ({ k: 'mul', args: args.flat() });
export const pow = (base, exp) => ({ k: 'pow', base, exp });
export const call = (name, ...args) => ({ k: 'call', name, args: args.flat() });
export const piece = (cases, otherwise) => ({ k: 'piece', cases, otherwise });

export const neg = (a) => mul(NEG_ONE, a);
export const sub = (a, b) => add(a, neg(b));
export const div = (a, b) => mul(a, pow(b, NEG_ONE));

export const isNum = (n, v) => n?.k === 'num' && (v === undefined || n.v === v);
export const isZero = (n) => isNum(n, 0);
export const isOne = (n) => isNum(n, 1);
export const isVar = (n, name) => n?.k === 'var' && (name === undefined || n.name === name);

/** Numeric value of a node that has one, else null. Folds named constants. */
export function numericValue(n) {
  if (n?.k === 'num') return n.v;
  if (n?.k === 'const') return CONST_VALUES[n.name] ?? null;
  return null;
}

/** Deep structural copy. */
export function clone(n) {
  if (n === null || typeof n !== 'object') return n;
  if (Array.isArray(n)) return n.map(clone);
  const out = {};
  for (const [key, val] of Object.entries(n)) out[key] = clone(val);
  return out;
}

/** Every node in the tree, parents before children. */
export function* walk(n) {
  if (!n || typeof n !== 'object') return;
  yield n;
  for (const child of children(n)) yield* walk(child);
}

export function children(n) {
  switch (n?.k) {
    case 'add': case 'mul': case 'call': return n.args;
    case 'pow': return [n.base, n.exp];
    case 'piece': return [...n.cases.flatMap((c) => [c.when, c.then]), n.otherwise];
    default: return [];
  }
}

/** Rebuild a node with new children, preserving its kind. */
export function withChildren(n, kids) {
  switch (n.k) {
    case 'add': return { k: 'add', args: kids };
    case 'mul': return { k: 'mul', args: kids };
    case 'call': return { k: 'call', name: n.name, args: kids };
    case 'pow': return { k: 'pow', base: kids[0], exp: kids[1] };
    case 'piece': {
      const cases = [];
      for (let i = 0; i < n.cases.length; i++) cases.push({ when: kids[2 * i], then: kids[2 * i + 1] });
      return { k: 'piece', cases, otherwise: kids[kids.length - 1] };
    }
    default: return n;
  }
}

/** Does this expression mention the variable at all? */
export function dependsOn(n, name) {
  for (const node of walk(n)) if (node.k === 'var' && node.name === name) return true;
  return false;
}

/** Free variables, in first-seen order. */
export function variables(n) {
  const seen = [];
  for (const node of walk(n)) {
    if (node.k === 'var' && !seen.includes(node.name)) seen.push(node.name);
  }
  return seen;
}

/** Substitute `value` for every occurrence of variable `name`. */
export function substitute(n, name, value) {
  if (!n || typeof n !== 'object') return n;
  if (n.k === 'var' && n.name === name) return clone(value);
  const kids = children(n);
  if (!kids.length) return n;
  return withChildren(n, kids.map((c) => substitute(c, name, value)));
}

/**
 * Structural equality on the canonical form.
 *
 * This is deliberately *not* mathematical equality — deciding that in general
 * is undecidable, and pretending otherwise is how a symbolic engine starts
 * lying. Two trees are equal here when they are the same tree. `simplify` is
 * what makes that useful, by pushing equivalent expressions to the same shape
 * often enough to be worth something.
 */
export function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || a.k !== b.k) return false;
  switch (a.k) {
    case 'num': return a.v === b.v || (Number.isNaN(a.v) && Number.isNaN(b.v));
    case 'var': case 'const': return a.name === b.name;
    case 'add': case 'mul':
      return a.args.length === b.args.length && a.args.every((x, i) => equal(x, b.args[i]));
    case 'pow': return equal(a.base, b.base) && equal(a.exp, b.exp);
    case 'call':
      return a.name === b.name && a.args.length === b.args.length
        && a.args.every((x, i) => equal(x, b.args[i]));
    case 'piece':
      return a.cases.length === b.cases.length
        && a.cases.every((c, i) => equal(c.when, b.cases[i].when) && equal(c.then, b.cases[i].then))
        && equal(a.otherwise, b.otherwise);
    default: return false;
  }
}

/**
 * A total order over nodes, so that commutative arguments can be sorted into a
 * canonical sequence. Numbers first (they fold), then constants, variables,
 * powers, products, sums, calls — and within a kind, by name or recursively.
 */
const KIND_RANK = { num: 0, const: 1, var: 2, pow: 3, mul: 4, add: 5, call: 6, piece: 7 };

export function compare(a, b) {
  const ra = KIND_RANK[a.k] ?? 9, rb = KIND_RANK[b.k] ?? 9;
  if (ra !== rb) return ra - rb;
  switch (a.k) {
    case 'num': return a.v - b.v;
    case 'const': case 'var': return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    case 'pow': return compare(a.base, b.base) || compare(a.exp, b.exp);
    case 'call':
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return compareList(a.args, b.args);
    case 'add': case 'mul': return compareList(a.args, b.args);
    default: return 0;
  }
}

function compareList(xs, ys) {
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const c = compare(xs[i], ys[i]);
    if (c) return c;
  }
  return xs.length - ys.length;
}

/** Rough size, used to prefer the shorter of two equivalent antiderivatives. */
export function complexity(n) {
  let count = 0;
  for (const _ of walk(n)) count++;
  return count;
}
