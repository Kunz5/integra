/*
  examples.js: the built-in collection.
  .........................................

  These are not a menu of what INTEGRA can do; any expression the parser
  accepts works. They are chosen because each one *demonstrates something*:
  a rule that succeeds, a rule that fails, a theorem's hypothesis being
  violated, a method's advantage showing up. The `why` on each is the reason
  it is in the list.
*/

export const GROUPS = [
  {
    name: 'The basics',
    blurb: 'Integrals with clean closed forms, where the numerical methods should — and do, reach machine precision.',
    items: [
      { f: 'x^2', a: '0', b: '1', why: 'The first integral anyone computes. Exactly 1/3, and every method here gets all sixteen digits.' },
      { f: 'sin(x)', a: '0', b: 'pi', why: 'Exactly 2. Smooth and periodic, which is the best case a quadrature rule ever sees.' },
      { f: 'e^x', a: '0', b: '1', why: 'e − 1. The exponential is its own derivative, so every error term stays the same size.' },
      { f: '4/(1+x^2)', a: '0', b: '1', why: 'Exactly π. This is how π was computed for two centuries before anything better existed.' },
      { f: '1/x', a: '1', b: 'e', why: 'Exactly 1 — the definition of e, read backwards.' },
    ],
  },
  {
    name: 'Where the symbolic engine stops',
    blurb: 'Perfectly ordinary functions with no elementary antiderivative. Not a limitation of this program, a theorem about the functions.',
    items: [
      { f: 'e^(-x^2)', a: '-2', b: '2', why: 'The Gaussian. Liouville proved no elementary antiderivative exists; the error function was invented to name it.' },
      { f: 'sin(x)/x', a: '0', b: '10', why: 'The sinc function. No elementary antiderivative either — its integral is called Si(x) because it needed a name.' },
      { f: 'sqrt(1+x^4)', a: '0', b: '1', why: 'Arc length of a parabola-like curve. Elementary integrand, non-elementary integral.' },
      { f: 'e^x/x', a: '1', b: '3', why: 'The exponential integral. Another function that exists only because this integral does not close.' },
      { f: '1/ln(x)', a: '2', b: '10', why: 'The logarithmic integral — the function that counts primes, approximately.' },
    ],
  },
  {
    name: 'Where the numerical methods struggle',
    blurb: 'The error bound for every polynomial rule contains a derivative of f. These are the integrands that make that derivative enormous, or infinite.',
    items: [
      { f: '1/sqrt(x)', a: '0', b: '1', why: 'Exactly 2, but the integrand is infinite at the left endpoint. Closed rules cannot sample it at all.' },
      { f: 'sqrt(x)', a: '0', b: '1', why: 'Finite everywhere, yet every rule drops to order 1.5 — the derivative is unbounded at 0 even though the function is not.' },
      { f: '|x|', a: '-1', b: '1', why: 'A single kink. Simpson\'s rule falls from fourth order to second; the trapezoidal rule is exact, because the kink lands on a node.' },
      { f: 'sin(60x)', a: '0', b: '1', why: 'Highly oscillatory. Each derivative brings another factor of 60, so Simpson\'s k⁴ error term is a million times larger.' },
      { f: '1/(1+10000*(x-0.5)^2)', a: '0', b: '1', why: 'A spike a hundredth of the interval wide. A uniform grid spends its whole budget on the flat parts.' },
      { f: 'sin(1/x)', a: '0.01', b: '1', why: 'Infinitely many oscillations crowding towards the origin. Move the lower limit down and watch every method disagree.' },
    ],
  },
  {
    name: 'Improper integrals',
    blurb: 'An integral over an infinite range, or of an unbounded function, is a limit. These are the ones worth watching approach.',
    items: [
      { f: '1/x^2', a: '1', b: 'inf', why: 'Converges to exactly 1. The area under a curve stretching to infinity is finite.' },
      { f: '1/x', a: '1', b: 'inf', why: 'Diverges — and slowly enough that the partial integrals look almost settled at every scale.' },
      { f: 'e^(-x^2)', a: '-inf', b: 'inf', why: 'Exactly √π. Famously impossible by one-dimensional methods and easy in polar coordinates.' },
      { f: '1/sqrt(x)', a: '0', b: '1', why: 'Unbounded at the endpoint, finite area. Tanh-sinh handles it without noticing.' },
      { f: 'x^(-1.01)', a: '1', b: 'inf', why: 'Converges to 100 — but so slowly that no numerical test can tell it apart from divergence.' },
      { f: 'e^(-x)*sin(x)', a: '0', b: 'inf', why: 'Exactly 1/2. Oscillating and decaying at once.' },
    ],
  },
  {
    name: 'Signs and cancellation',
    blurb: 'An integral is a signed area. These are the ones where forgetting that produces the wrong answer.',
    items: [
      { f: 'sin(x)', a: '0', b: '2pi', why: 'Exactly zero — the two halves cancel. The area under the curve is 4; the integral is 0.' },
      { f: 'x^3', a: '-1', b: '1', why: 'Zero by symmetry, whatever the method. Any odd function over a symmetric interval.' },
      { f: 'x*sin(x)', a: '0', b: '4pi', why: 'Integration by parts, twice. The lobes grow but do not quite cancel.' },
      { f: '1/x^2', a: '-1', b: '1', why: 'A positive function whose "antiderivative difference" is −2. The pole at zero makes the fundamental theorem inapplicable.' },
    ],
  },
];

/** Flattened, in display order. */
export const EXAMPLES = GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.name })));

export const DEFAULT_EXAMPLE = { f: 'e^(-x^2)', a: '-2', b: '2' };
