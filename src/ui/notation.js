/*
  notation.js: expression tree to mathematical notation.
  ..........................................................

  Two renderers over the same tree: MathML for display, and a plain linear
  string for input boxes, tooltips and export.

  MathML rather than a typesetting library, because it is what browsers
  actually implement, real fractions with real rules, real radicals, integral
  signs that stretch, proper spacing around operators, and it costs nothing to
  ship. A rendering library would be the largest dependency in the project by
  an order of magnitude, to produce something the browser can already do.

  The renderer works from the same tree the engine computes with. There is no
  second, prettier description of the expression that could drift out of step
  with the one being integrated: what you read is what was solved.
*/

import { numericValue } from '../math/ast.js';

const el = (tag, attrs, ...kids) => {
  const parts = [];
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null) parts.push(` ${k}="${escapeAttr(String(v))}"`);
  const inner = kids.flat().filter((k) => k != null && k !== '').join('');
  return `<${tag}${parts.join('')}>${inner}</${tag}>`;
};

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mi = (s, extra) => el('mi', extra, escapeText(s));
const mn = (s) => el('mn', null, escapeText(s));
const mo = (s, attrs) => el('mo', attrs, escapeText(s));
const mrow = (...kids) => el('mrow', null, ...kids);

/** Named constants get their proper glyphs. */
const CONST_GLYPH = { pi: 'π', e: 'e', tau: 'τ', phi: 'φ' };

/** Functions typeset upright, and the ones with their own notation. */
const FUNCTION_NAME = {
  ln: 'ln', log: 'log', log10: 'log', log2: 'log', exp: 'exp',
  sin: 'sin', cos: 'cos', tan: 'tan', sec: 'sec', csc: 'csc', cot: 'cot',
  asin: 'sin', acos: 'cos', atan: 'tan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
  asinh: 'sinh', acosh: 'cosh', atanh: 'tanh',
  sign: 'sgn', erf: 'erf', gamma: 'Γ', mod: 'mod', min: 'min', max: 'max',
};
const INVERSE = new Set(['asin', 'acos', 'atan', 'asinh', 'acosh', 'atanh']);

/**
 * Format a number for display.
 *
 * Recognises the small rationals: 0.3333333333333333 prints as ⅓ rather than
 * as a wall of threes — because those are what integration constants actually
 * are, and a reader who sees 0.16666666666666666 has to decode it before they
 * can read the formula.
 */
export function numberML(v) {
  if (!Number.isFinite(v)) return mi(v > 0 ? '∞' : (Number.isNaN(v) ? 'undefined' : '−∞'));
  if (Number.isInteger(v)) return mn(v < 0 ? `−${-v}` : String(v));

  const frac = smallFraction(v);
  if (frac) {
    const body = el('mfrac', null, mn(String(Math.abs(frac.num))), mn(String(frac.den)));
    return frac.num < 0 ? mrow(mo('−'), body) : body;
  }

  const s = Math.abs(v) < 1e-4 || Math.abs(v) >= 1e6
    ? v.toExponential(4).replace('e', ' × 10^').replace('+', '')
    : String(Number(v.toPrecision(8)));

  if (s.includes(' × 10^')) {
    const [m, e] = s.split(' × 10^');
    return mrow(mn(m.replace('-', '−')), mo('×'), el('msup', null, mn('10'), mn(e.replace('-', '−'))));
  }
  return mn(s.replace('-', '−'));
}

/** Recognise p/q with a small denominator, within floating-point tolerance. */
export function smallFraction(v, maxDen = 64) {
  for (let den = 2; den <= maxDen; den++) {
    const num = v * den;
    if (Math.abs(num - Math.round(num)) < 1e-10 * Math.max(1, Math.abs(num))) {
      const n = Math.round(num);
      if (gcd(Math.abs(n), den) === 1) return { num: n, den };
    }
  }
  return null;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

//  precedence, for deciding where brackets are actually needed  .........
const PREC = { add: 1, mul: 2, div: 2, pow: 4, atom: 5 };

function precedence(n) {
  switch (n?.k) {
    case 'add': return PREC.add;
    case 'mul': return PREC.mul;
    case 'pow': return PREC.pow;
    default: return PREC.atom;
  }
}

const bracket = (inner) => mrow(mo('(', { stretchy: 'true' }), inner, mo(')', { stretchy: 'true' }));

//  the renderer  ........................................................
/**
 * Render an expression as a MathML fragment.
 *
 * @param {object} node
 * @param {number} minPrec  bracket the result if its precedence is below this
 */
export function toMathML(node, minPrec = 0) {
  const body = render(node);
  return precedence(node) < minPrec ? bracket(body) : body;
}

/** A complete <math> element, ready to insert. */
export function mathBlock(node, { display = false, label = null } = {}) {
  // A raw fragment gets wrapped: <math> with several top-level children is
  // valid but lays them out one per row in some engines, which turns a formula
  // into a column of pieces. One <mrow> is unambiguous everywhere.
  const content = typeof node === 'string' ? mrow(node) : mrow(toMathML(node));
  return el('math', {
    xmlns: 'http://www.w3.org/1998/Math/MathML',
    display: display ? 'block' : 'inline',
    'aria-label': label,
  }, content);
}

function render(n) {
  if (!n) return mi('?');
  switch (n.k) {
    case 'num': return numberML(n.v);
    case 'const': return mi(CONST_GLYPH[n.name] ?? n.name, { mathvariant: 'normal' });
    case 'var': return mi(n.name);
    case 'add': return renderSum(n);
    case 'mul': return renderProduct(n);
    case 'pow': return renderPower(n);
    case 'call': return renderCall(n);
    case 'piece': return renderPiecewise(n);
    default: return mi('?');
  }
}

function renderSum(n) {
  const parts = [];
  n.args.forEach((term, i) => {
    const neg = negativeOf(term);
    if (i === 0) {
      if (neg) { parts.push(mo('−'), toMathML(neg, PREC.add + 1)); }
      else parts.push(toMathML(term, PREC.add + 1));
      return;
    }
    if (neg) { parts.push(mo('−'), toMathML(neg, PREC.add + 1)); }
    else { parts.push(mo('+'), toMathML(term, PREC.add + 1)); }
  });
  return mrow(...parts);
}

/** If a term carries an overall minus sign, return it without one. */
function negativeOf(term) {
  if (term.k === 'num' && term.v < 0) return { k: 'num', v: -term.v };
  if (term.k === 'mul') {
    const nums = term.args.filter((a) => a.k === 'num');
    const product = nums.reduce((p, a) => p * a.v, 1);
    if (product < 0) {
      const rest = term.args.map((a) => (a.k === 'num' ? { k: 'num', v: -a.v } : a))
        .filter((a) => !(a.k === 'num' && a.v === 1));
      if (!rest.length) return { k: 'num', v: 1 };
      return rest.length === 1 ? rest[0] : { k: 'mul', args: rest };
    }
  }
  return null;
}

/**
 * Products, rendered as a fraction when there are negative powers in them.
 *
 * `x·y^(−1)` is how the tree stores a quotient, and printing it that way is
 * technically correct and completely unreadable. Splitting the factors by the
 * sign of their exponent and building an <mfrac> is what makes the output look
 * like mathematics instead of like a data structure.
 */
function renderProduct(n) {
  // A product carrying an overall minus sign is written −(the rest), not
  // "−1 ⋅ the rest". The tree stores negation as multiplication by −1 because
  // that keeps the algebra uniform; notation has never written it that way.
  const negated = negativeOf(n);
  if (negated) return mrow(mo('−'), toMathML(negated, PREC.mul));

  const numerator = [], denominator = [];
  for (const f of n.args) {
    const inv = invertedFactor(f);
    if (inv) denominator.push(inv);
    else numerator.push(f);
  }

  if (denominator.length) {
    const num = numerator.length ? productRow(numerator) : mn('1');
    const den = productRow(denominator);
    return el('mfrac', null, mrow(num), mrow(den));
  }
  return productRow(n.args);
}

/** f^(−k) → f^k, for the denominator. */
function invertedFactor(f) {
  if (f.k !== 'pow') return null;
  const e = numericValue(f.exp);
  if (e === null || e >= 0) return null;
  if (e === -1) return f.base;
  return { k: 'pow', base: f.base, exp: { k: 'num', v: -e } };
}

function productRow(factors) {
  const parts = [];
  factors.forEach((f, i) => {
    if (i > 0) {
      // An explicit dot only where juxtaposition would be ambiguous: between two
      // numbers, or where a number follows anything. 2x reads fine; 2·3 does not.
      const prev = factors[i - 1];
      const needsDot = f.k === 'num' || (prev.k === 'num' && f.k === 'num');
      parts.push(needsDot ? mo('⋅') : el('mspace', { width: '0.14em' }));
    }
    parts.push(toMathML(f, PREC.mul + 1));
  });
  return mrow(...parts);
}

function renderPower(n) {
  const e = numericValue(n.exp);

  // A half power is a square root, and a third is a cube root. Everyone writes
  // them that way.
  if (e === 0.5) return el('msqrt', null, render(n.base));
  if (e === 1 / 3) return el('mroot', null, render(n.base), mn('3'));
  if (e !== null && e < 0) {
    const inv = e === -1 ? n.base : { k: 'pow', base: n.base, exp: { k: 'num', v: -e } };
    return el('mfrac', null, mn('1'), mrow(toMathML(inv, 0)));
  }

  // A function raised to a power uses the trigonometric convention: sin²x.
  if (n.base.k === 'call' && FUNCTION_NAME[n.base.name] && !INVERSE.has(n.base.name)) {
    return renderCall(n.base, render(n.exp));
  }

  return el('msup', null, mrow(toMathML(n.base, PREC.pow + 1)), mrow(render(n.exp)));
}

function renderCall(n, supIndex = null) {
  const name = FUNCTION_NAME[n.name] ?? n.name;

  if (n.name === 'abs' && n.args.length === 1) {
    return mrow(mo('|', { stretchy: 'true' }), render(n.args[0]), mo('|', { stretchy: 'true' }));
  }
  if (n.name === 'sqrt' && n.args.length === 1) return el('msqrt', null, render(n.args[0]));
  if (n.name === 'cbrt' && n.args.length === 1) return el('mroot', null, render(n.args[0]), mn('3'));
  if (n.name === 'exp' && n.args.length === 1) {
    return el('msup', null, mi('e', { mathvariant: 'normal' }), mrow(render(n.args[0])));
  }

  let head;
  if (INVERSE.has(n.name)) {
    head = el('msup', null, mi(name), mrow(mo('−'), mn('1')));
  } else if (supIndex) {
    head = el('msup', null, mi(name), mrow(supIndex));
  } else {
    head = mi(name);
  }

  // Bases on the logarithms that have one.
  if (n.name === 'log10') head = el('msub', null, mi('log'), mn('10'));
  if (n.name === 'log2') head = el('msub', null, mi('log'), mn('2'));
  if (n.name === 'log' && n.args.length === 2) {
    head = el('msub', null, mi('log'), mrow(render(n.args[1])));
    return mrow(head, el('mspace', { width: '0.1em' }), bracket(render(n.args[0])));
  }

  const args = n.args.map((a) => render(a));
  const inner = args.length === 1 ? args[0] : args.flatMap((a, i) => (i ? [mo(','), a] : [a]));
  return mrow(head, el('mspace', { width: '0.08em' }), bracket(mrow(...[inner].flat())));
}

function renderPiecewise(n) {
  const rows = n.cases.map((c) => el('mtr', null,
    el('mtd', null, render(c.then)),
    el('mtd', null, mrow(mi('if'), el('mspace', { width: '0.3em' }), render(c.when)))));
  rows.push(el('mtr', null,
    el('mtd', null, render(n.otherwise)),
    el('mtd', null, mi('otherwise'))));
  return mrow(mo('{', { stretchy: 'true' }), el('mtable', { columnalign: 'left left' }, ...rows));
}

//  whole-integral notation  .............................................
/** ∫ f(x) dx, indefinite. */
export function indefiniteIntegralML(f, v = 'x') {
  return mathBlock(mrow(
    mo('∫', { stretchy: 'false' }),
    el('mspace', { width: '0.15em' }),
    toMathML(f, 0),
    el('mspace', { width: '0.2em' }),
    mi('d', { mathvariant: 'normal' }), mi(v),
  ), { display: true });
}

/** ∫ from a to b of f(x) dx, with real limits above and below the sign. */
export function definiteIntegralML(f, a, b, v = 'x') {
  const limit = (value) => (typeof value === 'number'
    ? numberML(value)
    : (value === Infinity ? mi('∞') : value === -Infinity ? mrow(mo('−'), mi('∞')) : toMathML(value, 0)));

  return mathBlock(mrow(
    el('msubsup', null, mo('∫', { stretchy: 'false' }), mrow(limit(a)), mrow(limit(b))),
    el('mspace', { width: '0.15em' }),
    toMathML(f, 0),
    el('mspace', { width: '0.2em' }),
    mi('d', { mathvariant: 'normal' }), mi(v),
  ), { display: true });
}

//  linear text  .........................................................
/** A plain string, re-parseable by the parser it came from. */
export function toText(n, minPrec = 0) {
  const s = text(n);
  return precedence(n) < minPrec ? `(${s})` : s;
}

function text(n) {
  if (!n) return '?';
  switch (n.k) {
    case 'num': {
      if (Number.isInteger(n.v)) return n.v < 0 ? `(${n.v})` : String(n.v);
      // Print 1/3 rather than 0.333333333333: the text form is meant to be
      // read and re-typed, and a repeating decimal is neither.
      // Always bracketed: a bare 1/2 in an exponent position would re-parse as
      // (x^1)/2, because `^` binds tighter than `/`. The round-trip through the
      // parser has to give back the same tree or the text form is a lie.
      const f = smallFraction(n.v);
      if (f) return `(${f.num}/${f.den})`;
      const s2 = String(Number(n.v.toPrecision(12)));
      return n.v < 0 ? `(${s2})` : s2;
    }
    case 'const': return n.name;
    case 'var': return n.name;
    case 'add': return n.args.map((a, i) => {
      const neg = negativeOf(a);
      if (neg) return `${i ? ' - ' : '-'}${toText(neg, PREC.add + 1)}`;
      return `${i ? ' + ' : ''}${toText(a, PREC.add + 1)}`;
    }).join('');
    case 'mul': {
      const negated = negativeOf(n);
      if (negated) return `-${toText(negated, PREC.mul)}`;
      const num = [], den = [];
      for (const f of n.args) {
        const inv = invertedFactor(f);
        if (inv) den.push(inv); else num.push(f);
      }
      // A rational numeric coefficient becomes a divisor rather than a factor:
      // x^2/3 reads better than (1/3)*x^2 and re-parses to the same tree.
      const coeff = num.find((f) => f.k === 'num' && !Number.isInteger(f.v));
      if (coeff && !den.length) {
        const frac = smallFraction(coeff.v);
        if (frac) {
          const others = num.filter((f) => f !== coeff);
          const body = others.length ? others.map((f) => toText(f, PREC.mul + 1)).join('*') : '1';
          const scaled = frac.num === 1 ? body : `${frac.num}*${body}`;
          return `${scaled}/${frac.den}`;
        }
      }

      const top = num.length ? num.map((f) => toText(f, PREC.mul + 1)).join('*') : '1';
      if (!den.length) return top;
      const bottom = den.map((f) => toText(f, PREC.pow)).join('*');
      return `${top}/${den.length > 1 ? `(${bottom})` : bottom}`;
    }
    case 'pow': return `${toText(n.base, PREC.pow + 1)}^${toText(n.exp, PREC.pow + 1)}`;
    case 'call': return `${n.name}(${n.args.map((a) => toText(a, 0)).join(', ')})`;
    case 'piece': return `piecewise(${n.cases.map((c) => `${toText(c.then, 0)} if ${toText(c.when, 0)}`).join(', ')}, else ${toText(n.otherwise, 0)})`;
    default: return '?';
  }
}

/** A number for a results table: enough digits to be useful, not so many to be noise. */
export function formatNumber(v, digits = 10) {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? '—' : (v > 0 ? '∞' : '−∞');
  if (v === 0) return '0';
  // An exact integer prints as one. Padding 4 out to "4.000000000" implies a
  // measurement precision that is not there, and in a column of results it
  // makes the one exact answer look like the noisiest.
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  const a = Math.abs(v);
  if (a >= 1e-4 && a < 1e7) {
    const fixed = v.toFixed(Math.max(0, digits - Math.max(0, Math.floor(Math.log10(a)) + 1)));
    // Trailing zeros past the last significant figure are noise, but keep at
    // least one decimal so a non-integer never reads as an integer.
    return fixed.includes('.') ? fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0') : fixed;
  }
  return v.toExponential(Math.max(2, digits - 4));
}

/** Errors are always read as orders of magnitude, so always show them that way. */
export function formatError(v) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0 (exact)';
  const [mantissa, exponent] = v.toExponential(2).split('e');
  const e = Number(exponent);
  return `${mantissa.replace('-', '−')} × 10${supDigits(e)}`;
}

const SUP_DIGITS = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const supDigits = (n) => String(n).split('').map((c) => SUP_DIGITS[c] ?? c).join('');
