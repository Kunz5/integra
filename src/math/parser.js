/**
 * parser.js — text to expression tree.
 *
 * A hand-written lexer and a Pratt (precedence-climbing) parser. Nothing here
 * goes near `eval`: what the user types is data, and the only thing built from
 * it is a tree of plain objects. That matters for safety — this is a page
 * anyone can paste a string into — and it matters mathematically, because an
 * expression you can only evaluate is an expression you cannot differentiate,
 * integrate, simplify or typeset.
 *
 * The grammar accepts the notation people actually write rather than a
 * programming language's:
 *
 *   2x            implicit multiplication
 *   3x^2          binds as 3·(x²), not (3x)²
 *   sin x         function application without brackets, tightest binding
 *   sin^2(x)      the trigonometric convention: (sin x)², not sin(sin x)
 *   e^-x^2        unary minus inside an exponent
 *   |x|           absolute value
 *   2^3^2         right-associative: 2^(3^2) = 512
 *   -x^2          -(x²), because unary minus binds looser than a power
 */

import { NUM, VAR, CONST, add, mul, pow, call, neg, sub, div, CONST_VALUES } from './ast.js';

export class ParseError extends Error {
  constructor(message, position = 0, length = 1) {
    super(message);
    this.name = 'ParseError';
    this.position = position;
    this.length = length;
  }
}

// ── functions ───────────────────────────────────────────────────────────────

/** Arity 1 unless stated. `log` takes an optional base as a second argument. */
export const FUNCTIONS = {
  sin: 1, cos: 1, tan: 1, sec: 1, csc: 1, cot: 1,
  asin: 1, acos: 1, atan: 1, atan2: 2,
  sinh: 1, cosh: 1, tanh: 1, asinh: 1, acosh: 1, atanh: 1,
  exp: 1, ln: 1, log: [1, 2], log10: 1, log2: 1,
  sqrt: 1, cbrt: 1, abs: 1, sign: 1,
  floor: 1, ceil: 1, round: 1,
  min: [1, 8], max: [1, 8], mod: 2,
  gamma: 1, erf: 1,
};

const ALIASES = {
  arcsin: 'asin', arccos: 'acos', arctan: 'atan',
  arcsinh: 'asinh', arccosh: 'acosh', arctanh: 'atanh',
  arsinh: 'asinh', arcosh: 'acosh', artanh: 'atanh',
  lg: 'log10', lb: 'log2',
};

const CONSTANTS = new Set(Object.keys(CONST_VALUES));

// ── lexer ───────────────────────────────────────────────────────────────────

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

export function tokenize(src) {
  const out = [];
  let i = 0;
  const push = (type, value, start) => out.push({ type, value, start, end: i });

  while (i < src.length) {
    const c = src[i];
    const start = i;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      while (i < src.length && DIGIT.test(src[i])) i++;
      if (src[i] === '.') { i++; while (i < src.length && DIGIT.test(src[i])) i++; }
      if (src[i] === 'e' || src[i] === 'E') {
        // Only an exponent if a number really follows; otherwise `2e` is 2·e.
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (DIGIT.test(src[j] ?? '')) { i = j; while (i < src.length && DIGIT.test(src[i])) i++; }
      }
      push('num', Number(src.slice(start, i)), start);
      continue;
    }

    if (NAME_START.test(c)) {
      while (i < src.length && NAME_CHAR.test(src[i])) i++;
      push('name', src.slice(start, i), start);
      continue;
    }

    // Unicode a working mathematician might paste in.
    const UNICODE = { '×': '*', '·': '*', '÷': '/', '−': '-', '–': '-', '≤': '<=', '≥': '>=', '∙': '*' };
    if (UNICODE[c]) { i++; push('op', UNICODE[c], start); continue; }
    if (c === 'π') { i++; push('name', 'pi', start); continue; }
    if (c === '√') { i++; push('name', 'sqrt', start); continue; }

    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '**') {
      i += 2; push('op', two === '**' ? '^' : two, start); continue;
    }

    if ('+-*/^%(),|<>='.includes(c)) { i++; push('op', c, start); continue; }
    if (c === '[') { i++; push('op', '(', start); continue; }
    if (c === ']') { i++; push('op', ')', start); continue; }
    if (c === '{') { i++; push('op', '(', start); continue; }
    if (c === '}') { i++; push('op', ')', start); continue; }

    throw new ParseError(`I don't recognise the character "${c}".`, start, 1);
  }
  out.push({ type: 'end', value: null, start: src.length, end: src.length });
  return out;
}

// ── parser ──────────────────────────────────────────────────────────────────

/**
 * Binding powers. Implicit multiplication sits at the same level as explicit
 * `*` and associates left to right, so `2x/3y` is `(2x/3)y` — the same reading
 * a calculator or any CAS gives it. Raising implicit multiplication above
 * division would make `1/2x` mean `1/(2x)`, which is what some people write by
 * hand but is not what the notation says.
 */
const BP = { '<': 5, '>': 5, '<=': 5, '>=': 5, '==': 5, '!=': 5, '+': 10, '-': 10, '*': 20, '/': 20, '%': 20, '^': 40 };

class Parser {
  constructor(tokens, src) {
    this.t = tokens;
    this.i = 0;
    this.src = src;
    // How many |…| bars are currently open. Inside one, a `|` is the closing
    // bar, not the start of another absolute value — without this, `|x|` reads
    // the second bar as juxtaposition and runs off the end looking for an
    // operand. The ambiguity is real in the notation; nesting |…|…|| is not
    // something this parser tries to disambiguate, and neither does anyone.
    this.barDepth = 0;
  }

  peek(k = 0) { return this.t[this.i + k]; }
  next() { return this.t[this.i++]; }
  at(type, value) {
    const tok = this.peek();
    return tok.type === type && (value === undefined || tok.value === value);
  }
  eat(type, value) { if (this.at(type, value)) { return this.next(); } return null; }
  expect(type, value, what) {
    const tok = this.eat(type, value);
    if (!tok) {
      const got = this.peek();
      throw new ParseError(
        `Expected ${what ?? `"${value}"`}${got.type === 'end' ? ' but the expression ended' : ` but found "${this.src.slice(got.start, got.end)}"`}.`,
        got.start, Math.max(1, got.end - got.start),
      );
    }
    return tok;
  }

  parse() {
    const e = this.expression(0);
    if (!this.at('end')) {
      const tok = this.peek();
      throw new ParseError(`Unexpected "${this.src.slice(tok.start, tok.end)}".`, tok.start, tok.end - tok.start);
    }
    return e;
  }

  expression(minBp) {
    let left = this.unary();

    for (;;) {
      const tok = this.peek();

      // Implicit multiplication: a primary follows with nothing between them.
      if (this.startsPrimary(tok) && BP['*'] > minBp) {
        const right = this.expression(BP['*'] + 1);
        left = mul(left, right);
        continue;
      }

      if (tok.type !== 'op') break;
      const bp = BP[tok.value];
      if (bp === undefined || bp <= minBp) break;
      this.next();

      // `^` is right-associative — 2^3^2 is 2^(3^2) = 512, not 64 — and its
      // right operand takes a unary minus without brackets, so e^-x parses.
      const right = tok.value === '^' ? this.expression(bp - 1) : this.expression(bp);

      switch (tok.value) {
        case '+': left = add(left, right); break;
        case '-': left = sub(left, right); break;
        case '*': left = mul(left, right); break;
        case '/': left = div(left, right); break;
        case '%': left = call('mod', left, right); break;
        case '^': left = pow(left, right); break;
        default: left = call(RELATIONS[tok.value], left, right); break;
      }
    }
    return left;
  }

  /** Could this token begin a primary expression, making juxtaposition a product? */
  startsPrimary(tok) {
    if (tok.type === 'num') return true;
    if (tok.type === 'name') return true;
    if (tok.type === 'op' && tok.value === '(') return true;
    if (tok.type === 'op' && tok.value === '|' && this.barDepth === 0) return true;
    return false;
  }

  unary() {
    if (this.at('op', '-')) { this.next(); return neg(this.unary()); }
    if (this.at('op', '+')) { this.next(); return this.unary(); }
    return this.power();
  }

  /** A primary, then any postfix `^`, so that -x^2 is -(x^2). */
  power() {
    const base = this.primary();
    if (this.at('op', '^')) {
      this.next();
      return pow(base, this.expression(BP['^'] - 1));
    }
    return base;
  }

  primary() {
    const tok = this.peek();

    if (tok.type === 'num') { this.next(); return NUM(tok.value); }

    if (tok.type === 'op' && tok.value === '(') {
      this.next();
      const e = this.expression(0);
      this.expect('op', ')', 'a closing bracket');
      return e;
    }

    if (tok.type === 'op' && tok.value === '|') {
      this.next();
      this.barDepth++;
      let e;
      try { e = this.expression(0); } finally { this.barDepth--; }
      this.expect('op', '|', 'a closing "|"');
      return call('abs', e);
    }

    if (tok.type === 'name') {
      this.next();
      const raw = tok.value;
      const name = ALIASES[raw] ?? raw;

      if (FUNCTIONS[name]) return this.functionCall(name, tok);
      if (CONSTANTS.has(name)) return CONST(name);
      return VAR(raw);
    }

    throw new ParseError(
      tok.type === 'end' ? 'The expression ended before it was complete.'
        : `I did not expect "${this.src.slice(tok.start, tok.end)}" here.`,
      tok.start, Math.max(1, tok.end - tok.start),
    );
  }

  functionCall(name, tok) {
    // The trigonometric convention: sin^2(x) means (sin x)^2, and the same for
    // any function. Only mathematics does this, and only because it is useful.
    let outerPower = null;
    if (this.at('op', '^')) {
      this.next();
      outerPower = this.primaryForExponent();
    }

    let args;
    if (this.at('op', '(')) {
      this.next();
      args = [];
      if (!this.at('op', ')')) {
        args.push(this.expression(0));
        while (this.eat('op', ',')) args.push(this.expression(0));
      }
      this.expect('op', ')', 'a closing bracket');
    } else {
      // Bracket-free application takes exactly one juxtaposed group: `sin 2x`
      // is sin(2x) and `sin x + 1` is (sin x) + 1. Parsing the argument with a
      // minimum binding power of BP['*'] does not work — implicit
      // multiplication sits *at* that level, so the loop stops before it and
      // `sin 2x` comes out as sin(2)·x. The argument is therefore parsed by its
      // own rule: a unary term, then any primaries juxtaposed onto it, and
      // nothing joined by an explicit operator.
      args = [this.bareArgument()];
    }

    const arity = FUNCTIONS[name];
    const [lo, hi] = Array.isArray(arity) ? arity : [arity, arity];
    if (args.length < lo || args.length > hi) {
      throw new ParseError(
        `${name} takes ${lo === hi ? lo : `${lo} to ${hi}`} argument${hi === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given.`,
        tok.start, tok.end - tok.start,
      );
    }

    const node = call(name, ...args);
    return outerPower ? pow(node, outerPower) : node;
  }

  /** One juxtaposed group: `2x`, `x^2`, `3pi`, but not `x + 1` or `x * 2`. */
  bareArgument() {
    let left = this.unary();
    while (this.startsPrimary(this.peek())) {
      left = mul(left, this.unary());
    }
    return left;
  }

  primaryForExponent() {
    if (this.at('op', '-')) { this.next(); return neg(this.primaryForExponent()); }
    return this.primary();
  }
}

const RELATIONS = { '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge', '==': 'eq', '!=': 'ne' };

/**
 * Parse an expression. Throws ParseError with a position, so the input box can
 * point at the character that went wrong rather than saying "invalid".
 */
export function parse(src) {
  if (typeof src !== 'string' || !src.trim()) {
    throw new ParseError('Nothing to parse — the expression is empty.', 0, 1);
  }
  return new Parser(tokenize(src), src).parse();
}

/** Parse, returning null instead of throwing. */
export function tryParse(src) {
  try { return { ok: true, ast: parse(src) }; }
  catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e };
    throw e;
  }
}
