/**
 * app.js — the controller.
 *
 * Holds one piece of state — the integral currently under study — and renders
 * whichever laboratory is open from it. Each laboratory is a pure function of
 * that state plus its own controls, so switching between them never loses work
 * and never shows a stale answer computed from a different function.
 *
 * The heavy work (convergence sweeps, the break-the-method scans) runs in a
 * worker. It is only a second or two, but a second of frozen interface is a
 * second in which a slider does not move, and a laboratory whose sliders stick
 * is not one anybody experiments with.
 */

import { parse, tryParse, ParseError } from '../math/parser.js';
import { simplify } from '../math/simplify.js';
import { compileSafe } from '../math/evaluate.js';
import { derivative } from '../math/derivative.js';
import { integrate, definite } from '../math/integrate.js';
import { FIXED_METHODS, strips } from '../numeric/quadrature.js';
import { ADAPTIVE_METHODS, gauss, adaptiveSimpson, romberg, tanhSinh, legendre } from '../numeric/advanced.js';
import { monteCarlo, stratified, antithetic, hitOrMiss, rng } from '../numeric/montecarlo.js';
import { analyseImproper, improper } from '../numeric/improper.js';
import { convergenceStudy, reference } from '../lab/convergence.js';
import { FAMILIES, scan, runAtBudget } from '../lab/breaker.js';
import { GROUPS, DEFAULT_EXAMPLE } from '../lab/examples.js';
import { Plot, LogLogPlot, sampleCurve, THEMES } from './plot.js';
import {
  toMathML, mathBlock, definiteIntegralML, indefiniteIntegralML,
  toText, formatNumber, formatError,
} from './notation.js';

const $ = (id) => document.getElementById(id);
const html = (strings, ...vals) => strings.reduce((s, part, i) => s + part + (vals[i] ?? ''), '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SERIES_COLOURS = ['#5eb0ff', '#ffb454', '#4ade80', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee'];

class App {
  constructor() {
    this.mode = 'lab';
    this.theme = 'dark';
    this.state = null;                 // the parsed, compiled integral

    this.plots = {
      main: new Plot($('main-plot')),
      riemann: new Plot($('riemann-plot')),
      conv: new LogLogPlot($('conv-plot')),
      monte: new Plot($('monte-plot')),
      improper: new Plot($('improper-plot')),
      break: new LogLogPlot($('break-plot')),
    };

    this.riemann = { method: 'left', n: 12, animating: false };
    this.monte = { exponent: 20, seed: 12345 };
    this.compare = { budget: 100 };
    this.breaker = { family: 'oscillatory', budget: 120 };
    this.cache = new Map();

    this.buildControls();
    this.bind();
    this.applyTheme(prefersLight() ? 'light' : 'dark');
    this.setEntry(DEFAULT_EXAMPLE);
    this.compute();
  }

  // ── setup ────────────────────────────────────────────────────────────────

  buildControls() {
    $('riemann-methods').innerHTML = Object.entries(FIXED_METHODS)
      .map(([k, m]) => `<button class="chip${k === this.riemann.method ? ' active' : ''}" data-method="${k}">${esc(m.label)}</button>`)
      .join('');

    $('break-family').innerHTML = Object.entries(FAMILIES)
      .map(([k, f]) => `<option value="${k}">${esc(f.label)}</option>`).join('');
    $('break-family').value = this.breaker.family;

    $('library').innerHTML = GROUPS.map((g) => html`
      <h2 class="section">${esc(g.name)}</h2>
      <p class="note" style="max-width:76ch">${esc(g.blurb)}</p>
      <div class="library-grid">
        ${g.items.map((it) => {
          const label = `∫ from ${it.a} to ${it.b} of ${it.f}`;
          let ml = `<code>${esc(it.f)}</code>`;
          try { ml = definiteIntegralML(simplify(parse(it.f)), limitNode(it.a), limitNode(it.b)); } catch { /* keep the code fallback */ }
          return html`
            <button class="example" data-f="${esc(it.f)}" data-a="${esc(it.a)}" data-b="${esc(it.b)}" aria-label="${esc(label)}">
              <span class="ex-math">${ml}</span>
              <span class="ex-why">${esc(it.why)}</span>
            </button>`;
        }).join('')}
      </div>`).join('');
  }

  bind() {
    $('entry').addEventListener('submit', (e) => { e.preventDefault(); this.compute(); });
    for (const id of ['fn', 'lo', 'hi']) {
      $(id).addEventListener('change', () => this.compute());
    }

    for (const btn of document.querySelectorAll('.rail-item')) {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    }

    $('theme').addEventListener('click', () => this.applyTheme(this.theme === 'dark' ? 'light' : 'dark'));

    $('riemann-methods').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      this.riemann.method = btn.dataset.method;
      for (const c of $('riemann-methods').children) c.classList.toggle('active', c === btn);
      this.renderRiemann();
    });

    const nSlider = $('riemann-n');
    nSlider.addEventListener('input', () => {
      this.riemann.n = Number(nSlider.value);
      this.riemann.animating = false;
      this.renderRiemann();
    });
    $('riemann-animate').addEventListener('click', () => this.animateRiemann());

    const budget = $('compare-budget');
    budget.addEventListener('input', () => {
      this.compare.budget = Number(budget.value);
      $('compare-budget-out').textContent = `≈${this.compare.budget} evaluations`;
      this.scheduleCompare();
    });

    const mSlider = $('monte-n');
    mSlider.addEventListener('input', () => {
      this.monte.exponent = Number(mSlider.value);
      this.renderMonte();
    });
    $('monte-reseed').addEventListener('click', () => {
      this.monte.seed = (this.monte.seed * 1103515245 + 12345) >>> 0;
      this.renderMonte();
    });

    $('break-family').addEventListener('change', () => {
      this.breaker.family = $('break-family').value;
      this.renderBreak();
    });
    const bb = $('break-budget');
    bb.addEventListener('input', () => {
      this.breaker.budget = Number(bb.value);
      $('break-budget-out').textContent = `≈${this.breaker.budget} evaluations`;
      this.scheduleBreak();
    });

    $('library').addEventListener('click', (e) => {
      const card = e.target.closest('.example');
      if (!card) return;
      this.setEntry({ f: card.dataset.f, a: card.dataset.a, b: card.dataset.b });
      this.setMode('lab');
      this.compute();
    });

    for (const plot of Object.values(this.plots)) this.bindHover(plot);

    window.addEventListener('resize', () => this.layout());
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      const keys = { 1: 'lab', 2: 'riemann', 3: 'convergence', 4: 'compare', 5: 'monte', 6: 'improper', 7: 'break', 8: 'working', 9: 'library' };
      if (keys[e.key]) { this.setMode(keys[e.key]); e.preventDefault(); }
    });
  }

  bindHover(plot) {
    const c = plot.canvas;
    c.addEventListener('mousemove', (e) => {
      if (!this.state) return;
      const rect = c.getBoundingClientRect();
      const b = plot.bounds(), a = plot.area;
      const x = plot.ux(e.clientX - rect.left, b, a);
      if (!Number.isFinite(x)) return;
      const y = plot === this.plots.main || plot === this.plots.riemann ? this.state.f(x) : NaN;
      plot.hover = {
        x,
        y,
        label: plot instanceof LogLogPlot
          ? `N = ${formatNumber(x, 3)}`
          : `x = ${formatNumber(x, 5)}${Number.isFinite(y) ? `   f = ${formatNumber(y, 5)}` : '   f undefined'}`,
      };
      plot.draw();
    });
    c.addEventListener('mouseleave', () => { plot.hover = null; plot.draw(); });
  }

  applyTheme(name) {
    this.theme = name;
    document.documentElement.dataset.theme = name;
    for (const p of Object.values(this.plots)) p.setTheme(name);
    $('theme').textContent = name === 'dark' ? '◐' : '◑';
    this.render();
  }

  layout() {
    for (const p of Object.values(this.plots)) p.resize();
    this.render();
  }

  setEntry({ f, a, b }) {
    $('fn').value = f;
    $('lo').value = a;
    $('hi').value = b;
  }

  setMode(mode) {
    this.mode = mode;
    for (const btn of document.querySelectorAll('.rail-item')) btn.classList.toggle('active', btn.dataset.mode === mode);
    for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('active', pane.dataset.mode === mode);
    // A canvas inside a hidden pane measures zero, so it has to be re-sized the
    // moment its pane becomes visible — and re-drawn, because setting a
    // canvas's width clears it.
    requestAnimationFrame(() => { for (const p of Object.values(this.plots)) p.resize(); this.render(); });
  }

  // ── the integral under study ─────────────────────────────────────────────

  compute() {
    const src = $('fn').value;
    const parsed = tryParse(src);
    if (!parsed.ok) return this.showParseError(parsed.error, src);

    let a, b;
    try { a = evalLimit($('lo').value); b = evalLimit($('hi').value); }
    catch (err) { return this.showParseError(err, `${$('lo').value} … ${$('hi').value}`); }

    if (!(a < b)) {
      return this.showError('The lower limit must be below the upper limit. '
        + '(Reversing them negates the integral, which is a convention rather than a computation.)');
    }

    this.clearError();
    const ast = simplify(parsed.ast);
    const vars = variablesIn(ast);
    if (vars.length > 1) {
      return this.showError(`This expression uses ${vars.map((v) => `"${v}"`).join(' and ')}. `
        + 'INTEGRA integrates in one variable — name it x.');
    }
    const v = vars[0] ?? 'x';

    let f;
    try { f = compileSafe(ast, [v]); }
    catch (err) { return this.showError(err.message); }

    const finiteA = Number.isFinite(a), finiteB = Number.isFinite(b);
    this.state = {
      src, ast, v, f, a, b,
      isImproper: !finiteA || !finiteB || !Number.isFinite(f(a)) || !Number.isFinite(f(b)),
      infinite: !finiteA || !finiteB,
    };
    this.cache.clear();
    this.render();
  }

  showParseError(err, src) {
    const at = err instanceof ParseError ? err.position : null;
    const caret = at != null ? `\n${' '.repeat(Math.max(0, at))}${'^'.repeat(Math.max(1, err.length ?? 1))}` : '';
    $('parse-error').innerHTML = `${esc(err.message)}${caret ? `<span class="caret">${esc(src)}${esc(caret)}</span>` : ''}`;
    $('parse-error').hidden = false;
  }

  showError(message) {
    $('parse-error').textContent = message;
    $('parse-error').hidden = false;
  }

  clearError() { $('parse-error').hidden = true; }

  // ── rendering ────────────────────────────────────────────────────────────

  render() {
    if (!this.state) return;
    switch (this.mode) {
      case 'lab': return this.renderLab();
      case 'riemann': return this.renderRiemann();
      case 'convergence': return this.renderConvergence();
      case 'compare': return this.renderCompare();
      case 'monte': return this.renderMonte();
      case 'improper': return this.renderImproper();
      case 'break': return this.renderBreak();
      case 'working': return this.renderWorking();
      default: return undefined;
    }
  }

  /** Curve samples over the plotting window, cached per view. */
  curve(plot, pad = 0.12) {
    const { f, a, b } = this.state;
    const lo = Number.isFinite(a) ? a : -10;
    const hi = Number.isFinite(b) ? b : 10;
    const width = hi - lo || 1;
    return sampleCurve(f, lo - width * pad, hi + width * pad, plot.area.w);
  }

  /** The best value available, and where it came from. */
  best() {
    const key = 'best';
    if (this.cache.has(key)) return this.cache.get(key);
    const { ast, v, f, a, b } = this.state;

    let exact = null, symbolic = null;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const d = definite(ast, a, b, v);
      symbolic = d;
      if (d.ok) exact = d.value;
    } else {
      symbolic = integrate(ast, v);
    }

    const numeric = this.state.infinite ? improper(f, a, b) : tanhSinh(f, a, b, 1e-14);
    const out = { exact, symbolic, numeric, reference: exact ?? numeric.value };
    this.cache.set(key, out);
    return out;
  }

  // ── laboratory: the integral ─────────────────────────────────────────────

  renderLab() {
    const { f, a, b, ast, v } = this.state;
    const plot = this.plots.main;
    const points = this.curve(plot);

    plot.setLayers([
      { kind: 'area', points, a: Number.isFinite(a) ? a : points[0].x, b: Number.isFinite(b) ? b : points[points.length - 1].x },
      { kind: 'curve', points, width: 2.1 },
      { kind: 'vlines', xs: [a, b].filter(Number.isFinite), dash: [4, 4] },
    ]).setView(null).draw();

    const { exact, symbolic, numeric } = this.best();
    const anti = symbolic?.antiderivative ?? (symbolic?.ok ? symbolic.antiderivative : null);

    $('main-caption').innerHTML = this.state.isImproper
      ? 'This integral is improper — shaded to the plotting window, not to the whole region. The <em>Improper</em> laboratory shows the limit being approached.'
      : 'The shaded region is what is being measured. Blue is positive area, red negative — an integral is a <em>signed</em> area, and the two subtract.';

    const rows = [];
    rows.push(`<div class="formula accent">${definiteIntegralML(ast, a, b, v)}</div>`);

    if (exact !== null) {
      rows.push(html`
        <div class="readout">
          <div class="readout-label">Exact</div>
          <div class="readout-value exact">${esc(formatNumber(exact, 15))}</div>
          <div class="readout-sub">by the fundamental theorem, from an antiderivative found symbolically</div>
        </div>`);
    }

    rows.push(html`
      <div class="readout">
        <div class="readout-label">Numerical${exact === null ? '' : ' (tanh-sinh)'}</div>
        <div class="readout-value numeric">${esc(formatNumber(numeric.value, 15))}</div>
        <div class="readout-sub">${numeric.evaluations} evaluations${numeric.converged === false ? ' · did not reach tolerance' : ''}</div>
      </div>`);

    if (exact !== null) {
      const err = Math.abs(numeric.value - exact);
      rows.push(html`
        <div class="readout">
          <div class="readout-label">Difference</div>
          <div class="readout-value error">${esc(formatError(err))}</div>
          <div class="readout-sub">${err === 0 ? 'identical to the last bit' : `relative ${formatError(err / Math.max(1e-300, Math.abs(exact)))}`}</div>
        </div>`);
    }

    rows.push('<h2 class="section">Antiderivative</h2>');
    if (anti) {
      rows.push(`<div class="formula">${indefiniteIntegralML(ast, v)}${mathBlock(`<mo>=</mo>`, {})} ${mathBlock(toMathML(anti) + '<mo>+</mo><mi>C</mi>', { display: true })}</div>`);
      rows.push(html`<p class="note">Found by <strong>${esc(symbolic.method ?? 'the rules')}</strong>.
        ${esc(symbolic.verificationDetail ?? '')}</p>`);
      rows.push(html`<p class="note">As text: <code>${esc(toText(anti))} + C</code></p>`);
    } else {
      rows.push(html`
        <div class="flag warn">
          <span class="flag-glyph">△</span>
          <span>${esc(symbolic?.reason ?? 'No antiderivative was found.')}</span>
        </div>`);
    }

    if (symbolic && !symbolic.ok && symbolic.discontinuity !== undefined && symbolic.antiderivative) {
      rows.push(html`
        <div class="flag bad">
          <span class="flag-glyph">✕</span>
          <span>${esc(symbolic.reason)}</span>
        </div>`);
    }

    if (this.state.isImproper) {
      rows.push(html`
        <div class="flag info">
          <span class="flag-glyph">∞</span>
          <span>This integral is improper. Its value is a limit, and the <em>Improper</em> laboratory shows that limit being approached rather than only its destination.</span>
        </div>`);
    }

    $('lab-results').innerHTML = rows.join('');
  }

  // ── laboratory: Riemann ──────────────────────────────────────────────────

  renderRiemann() {
    const { f, a, b } = this.state;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      $('riemann-results').innerHTML = '<div class="flag info"><span class="flag-glyph">∞</span><span>Riemann sums need a bounded interval. Set finite limits, or use the Improper laboratory.</span></div>';
      this.plots.riemann.setLayers([]).draw();
      return;
    }

    const n = this.riemann.n;
    const key = this.riemann.method;
    const method = FIXED_METHODS[key];
    const plot = this.plots.riemann;
    const points = this.curve(plot, 0.06);
    const stripKind = key === 'trapezoid' ? 'trapezoid' : key === 'simpson' ? 'simpson' : key === 'simpson38' ? 'simpson38' : key;

    plot.setLayers([
      { kind: 'strips', strips: strips(f, a, b, n, stripKind) },
      { kind: 'curve', points, width: 2.1 },
    ]).setView(null).draw();

    $('riemann-n-out').textContent = `N = ${n}`;

    const result = method.run(f, a, b, n);
    const truth = this.best().reference;
    const err = Math.abs(result.value - truth);

    const rows = [`<h2 class="section">${esc(method.label)}</h2>`];
    rows.push(`<div class="formula">${ruleFormula(key)}</div>`);
    rows.push(html`<p class="note">${esc(method.note)}</p>`);

    rows.push(html`
      <div class="readout">
        <div class="readout-label">I<sub>N</sub> with N = ${n}</div>
        <div class="readout-value numeric">${esc(formatNumber(result.value, 12))}</div>
        <div class="readout-sub">h = ${esc(formatNumber((b - a) / (result.adjustedN ?? n), 8))} · ${result.evaluations} evaluations${result.adjustedN ? ` · N raised to ${result.adjustedN}, which this rule requires` : ''}</div>
      </div>`);

    rows.push(html`
      <div class="readout">
        <div class="readout-label">E<sub>N</sub> = |I − I<sub>N</sub>|</div>
        <div class="readout-value error">${esc(formatError(err))}</div>
        <div class="readout-sub">against ${this.best().exact !== null ? 'the exact value' : 'a tanh-sinh reference'}</div>
      </div>`);

    if (result.skipped) {
      rows.push(html`
        <div class="flag warn"><span class="flag-glyph">△</span>
        <span>${result.skipped} of the ${result.evaluations} samples had no finite value and were left out of the sum. The result below is the integral of what could be sampled, which is not the same thing.</span></div>`);
    }

    // What happens if N doubles — the order, made concrete.
    const doubled = method.run(f, a, b, n * 2);
    const errDoubled = Math.abs(doubled.value - truth);
    if (err > 0 && errDoubled > 0) {
      const factor = err / errDoubled;
      rows.push('<h2 class="section">Doubling N</h2>');
      rows.push(html`<p class="note">At N = ${n * 2} the error is ${esc(formatError(errDoubled))} — smaller by a factor of
        <strong>${esc(formatNumber(factor, 4))}</strong>. A method of order <em>p</em> divides its error by 2<sup>p</sup> each
        time the interval count doubles, so this factor is 2<sup>${esc(formatNumber(Math.log2(factor), 3))}</sup>:
        an order of about <strong>${esc(formatNumber(Math.log2(factor), 3))}</strong> against a theoretical
        ${method.order}.</p>`);
    }

    $('riemann-results').innerHTML = rows.join('');
  }

  animateRiemann() {
    if (this.riemann.animating) { this.riemann.animating = false; return; }
    this.riemann.animating = true;
    const slider = $('riemann-n');
    let n = 1;
    const step = () => {
      if (!this.riemann.animating || this.mode !== 'riemann') { this.riemann.animating = false; return; }
      this.riemann.n = n;
      slider.value = String(n);
      this.renderRiemann();
      n = n < 20 ? n + 1 : Math.round(n * 1.16);
      if (n > 400) { this.riemann.animating = false; return; }
      setTimeout(() => requestAnimationFrame(step), 45);
    };
    step();
  }

  // ── laboratory: convergence ──────────────────────────────────────────────

  renderConvergence() {
    const { f, a, b } = this.state;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      $('conv-results').innerHTML = '<div class="flag info"><span class="flag-glyph">∞</span><span>Convergence against N needs a bounded interval.</span></div>';
      this.plots.conv.setLayers([]).draw();
      return;
    }

    const keys = ['left', 'trapezoid', 'mid', 'simpson', 'gauss'];
    const study = memo(this.cache, `conv:${keys.join()}`, () =>
      convergenceStudy(f, a, b, keys, this.best().exact, { maxN: 1024 }));

    const layers = [];
    study.series.forEach((s, i) => {
      const pts = s.points.filter((p) => p.error > 0).map((p) => ({ x: p.N, y: p.error }));
      layers.push({ kind: 'curve', points: pts, colour: SERIES_COLOURS[i % SERIES_COLOURS.length], width: 1.8 });
      layers.push({ kind: 'points', points: pts, colour: SERIES_COLOURS[i % SERIES_COLOURS.length], radius: 2.2 });
    });
    this.plots.conv.setLayers(layers).setView(null).draw();

    const rows = [];
    rows.push(html`<div class="legend">${study.series.map((s, i) =>
      `<span class="legend-item"><span class="swatch" style="background:${SERIES_COLOURS[i % SERIES_COLOURS.length]}"></span>${esc(s.label)}</span>`).join('')}</div>`);

    rows.push('<h2 class="section">Measured order</h2>');
    rows.push(html`
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Method</th><th class="num">Theory</th><th class="num">Measured</th><th class="num">R²</th></tr></thead>
        <tbody>${study.series.map((s) => html`
          <tr>
            <td class="method-name">${esc(s.label)}</td>
            <td class="num">${s.theoreticalOrder ?? '—'}</td>
            <td class="num">${s.fit.order === null ? '<span class="refused">—</span>' : esc(s.fit.order.toFixed(3))}</td>
            <td class="num">${s.fit.r2 === undefined ? '—' : esc(s.fit.r2.toFixed(4))}</td>
          </tr>`).join('')}
        </tbody></table></div>`);

    for (const s of study.series) {
      if (s.interpretation) rows.push(html`<p class="note"><strong>${esc(s.label)}.</strong> ${esc(s.interpretation)}</p>`);
      else if (s.fit.reason) rows.push(html`<p class="note"><strong>${esc(s.label)}.</strong> ${esc(s.fit.reason)}</p>`);
    }

    rows.push('<h2 class="section">Reference value</h2>');
    rows.push(html`<p class="note">${esc(study.reference.source === 'exact'
      ? 'The errors above are measured against the exact value, from a symbolic antiderivative.'
      : study.reference.note ?? '')}</p>`);
    if (!study.reference.trustworthy) {
      rows.push('<div class="flag bad"><span class="flag-glyph">✕</span><span>The reference value is not reliable for this integrand, so every error in the table is suspect. Treat the shapes as indicative and the numbers as not.</span></div>');
    }

    $('conv-results').innerHTML = rows.join('');
  }

  // ── laboratory: comparison ───────────────────────────────────────────────

  scheduleCompare() {
    clearTimeout(this._compareTimer);
    this._compareTimer = setTimeout(() => this.renderCompare(), 90);
  }

  renderCompare() {
    const { f, a, b } = this.state;
    const budget = this.compare.budget;
    $('compare-budget-out').textContent = `≈${budget} evaluations`;

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      $('compare-results').innerHTML = '<div class="flag info"><span class="flag-glyph">∞</span><span>The comparison runs on a bounded interval. The Improper laboratory handles the rest.</span></div>';
      return;
    }

    const truth = this.best().reference;
    const rows = [];

    const run = (label, fn, note) => {
      const t0 = performance.now();
      const r = fn();
      const ms = performance.now() - t0;
      const refused = !Number.isFinite(r.value);
      return {
        label, note, ms, refused,
        value: r.value,
        error: Math.abs(r.value - truth),
        relative: Math.abs(r.value - truth) / Math.max(1e-300, Math.abs(truth)),
        evaluations: r.evaluations,
        reason: r.reason,
      };
    };

    const results = [
      ...Object.entries(FIXED_METHODS).map(([k, m]) => run(m.label, () => m.run(f, a, b, budget), m.note)),
      run('Gauss-Legendre', () => gauss(f, a, b, Math.min(300, budget)), ADAPTIVE_METHODS.gauss.note),
      run('Adaptive Simpson', () => runAtBudget(f, a, b, 'adaptive', budget), ADAPTIVE_METHODS.adaptive.note),
      run('Romberg', () => romberg(f, a, b, Math.max(4, Math.min(16, Math.round(Math.log2(budget)) + 3))), ADAPTIVE_METHODS.romberg.note),
      run('Tanh-sinh', () => tanhSinh(f, a, b, 1e-13, 6), ADAPTIVE_METHODS.tanhsinh.note),
      run('Monte Carlo', () => monteCarlo(f, a, b, budget, { seed: 4242 }), 'Uniform random samples. Error falls as 1/√N — the same in one dimension and in fifty.'),
      run('Monte Carlo (stratified)', () => stratified(f, a, b, budget, { seed: 4242 }), 'One sample per equal sub-interval, which removes the between-stratum variance.'),
    ];

    const live = results.filter((r) => !r.refused);
    const bestErr = Math.min(...live.map((r) => r.error));
    const worstErr = Math.max(...live.map((r) => r.error));

    rows.push(html`<div class="formula accent">${definiteIntegralML(this.state.ast, a, b, this.state.v)}</div>`);
    rows.push(html`<p class="note">Reference value <code>${esc(formatNumber(truth, 15))}</code>,
      ${this.best().exact !== null ? 'exact, from a symbolic antiderivative' : 'from tanh-sinh quadrature at 10⁻¹⁴'}.</p>`);

    rows.push(html`
      <div class="table-scroll"><table class="data">
        <thead><tr>
          <th>Method</th><th class="num">Result</th><th class="num">Absolute error</th>
          <th class="num">Relative</th><th class="num">Evaluations</th><th class="num">Time</th>
        </tr></thead>
        <tbody>${results.map((r) => html`
          <tr>
            <td class="method-name">${esc(r.label)}</td>
            <td class="num">${r.refused ? '<span class="refused">refused</span>' : esc(formatNumber(r.value, 12))}</td>
            <td class="num ${r.refused ? '' : r.error === bestErr ? 'best' : r.error === worstErr ? 'worst' : ''}">${r.refused ? '—' : esc(formatError(r.error))}</td>
            <td class="num">${r.refused ? '—' : esc(formatError(r.relative))}</td>
            <td class="num">${r.evaluations}</td>
            <td class="num">${esc(r.ms.toFixed(2))} ms</td>
          </tr>`).join('')}
        </tbody></table></div>`);

    const refused = results.filter((r) => r.refused);
    for (const r of refused) {
      rows.push(html`<div class="flag warn"><span class="flag-glyph">△</span>
        <span><strong>${esc(r.label)}</strong> returned no value. ${esc(r.reason ?? 'The integrand could not be sampled where this rule needs it.')}</span></div>`);
    }

    rows.push('<h2 class="section">Why the ordering came out this way</h2>');
    const winner = live.reduce((w, r) => (r.error < w.error ? r : w), live[0]);
    rows.push(html`<p class="note"><strong>${esc(winner.label)}</strong> won this comparison, and the reason is a property of
      <em>this integrand</em> rather than of the rule. ${esc(winner.note)}</p>`);
    rows.push(html`<p class="note">Change the function at the top of the page and the ordering changes with it. A smooth integrand
      hands the contest to Gauss-Legendre by ten orders of magnitude; a spike hands it to adaptive Simpson; an endpoint
      singularity hands it to tanh-sinh and defeats everything else. "Which method is best" is not a question with an
      answer until an integrand is attached to it.</p>`);

    rows.push('<h2 class="section">All the notes</h2>');
    for (const r of results) rows.push(html`<p class="note"><strong>${esc(r.label)}.</strong> ${esc(r.note)}</p>`);

    $('compare-results').innerHTML = rows.join('');
  }

  // ── laboratory: Monte Carlo ──────────────────────────────────────────────

  renderMonte() {
    const { f, a, b } = this.state;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      $('monte-results').innerHTML = '<div class="flag info"><span class="flag-glyph">∞</span><span>Monte Carlo needs a bounded interval to sample uniformly over.</span></div>';
      this.plots.monte.setLayers([]).draw();
      return;
    }

    const n = Math.round(Math.pow(10, 1 + this.monte.exponent / 15));
    $('monte-n-out').textContent = `N = ${n.toLocaleString('en-GB')}`;

    const plot = this.plots.monte;
    const points = this.curve(plot, 0.04);
    const darts = hitOrMiss(f, a, b, Math.min(n, 4000), { seed: this.monte.seed, keepPoints: 4000 });

    plot.setLayers([
      { kind: 'darts', darts: darts.darts },
      { kind: 'curve', points, width: 2.2 },
    ]).setView(null).draw();

    const truth = this.best().reference;
    const uniform = monteCarlo(f, a, b, n, { seed: this.monte.seed });
    const strat = stratified(f, a, b, n, { seed: this.monte.seed });
    const anti = antithetic(f, a, b, n, { seed: this.monte.seed });

    const inside = Number.isFinite(uniform.value)
      && truth >= uniform.ci95[0] && truth <= uniform.ci95[1];

    const rows = [];
    rows.push(html`
      <div class="readout">
        <div class="readout-label">Estimate (uniform, N = ${n.toLocaleString('en-GB')})</div>
        <div class="readout-value numeric">${esc(formatNumber(uniform.value, 10))}</div>
        <div class="readout-sub">± ${esc(formatNumber(uniform.standardError, 6))} standard error</div>
      </div>`);

    rows.push(html`
      <div class="readout">
        <div class="readout-label">95% interval</div>
        <div class="readout-value" style="font-size:14px">[${esc(formatNumber(uniform.ci95[0], 9))}, ${esc(formatNumber(uniform.ci95[1], 9))}]</div>
        <div class="readout-sub">the true value ${inside ? 'is inside it' : 'is outside it'} — ${esc(formatNumber(truth, 10))}</div>
      </div>`);

    rows.push(html`
      <div class="flag ${inside ? 'good' : 'warn'}">
        <span class="flag-glyph">${inside ? '✓' : '△'}</span>
        <span>${inside
          ? 'The interval covers the true value, as it should about nineteen times in twenty. Press “New sample” a dozen times and watch roughly one miss.'
          : 'This interval misses. That is not a bug: a 95% interval is <em>designed</em> to miss one time in twenty, and seeing it happen is the only way to understand what the number means.'}</span>
      </div>`);

    rows.push('<h2 class="section">Variance reduction</h2>');
    rows.push(html`
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Sampling</th><th class="num">Estimate</th><th class="num">Error</th><th class="num">Std. error</th></tr></thead>
        <tbody>
          ${[['Uniform', uniform], ['Stratified', strat], ['Antithetic', anti]].map(([label, r]) => html`
            <tr>
              <td class="method-name">${label}</td>
              <td class="num">${esc(formatNumber(r.value, 10))}</td>
              <td class="num">${esc(formatError(Math.abs(r.value - truth)))}</td>
              <td class="num">${esc(formatNumber(r.standardError, 5))}</td>
            </tr>`).join('')}
        </tbody></table></div>`);

    rows.push(html`<p class="note">All three draw the same number of samples. <strong>Stratified</strong> takes one from each equal
      sub-interval instead of N independent ones, which removes the between-stratum variance — on a smooth function that
      is nearly all of it. <strong>Antithetic</strong> pairs every sample with its mirror; on a monotone integrand the two
      are negatively correlated and the pair mean is steadier than either.</p>`);

    rows.push('<h2 class="section">The 1/√N wall</h2>');
    const scaled = monteCarlo(f, a, b, Math.min(n * 100, 4_000_000), { seed: this.monte.seed });
    rows.push(html`<p class="note">A hundred times the samples — ${Math.min(n * 100, 4_000_000).toLocaleString('en-GB')} of them —
      gives ${esc(formatNumber(scaled.value, 12))}, an error of ${esc(formatError(Math.abs(scaled.value - truth)))}.
      A hundredfold increase in work buys one decimal place, and it always will: the error falls as 1/√N and no amount of
      computing changes the exponent. Simpson's rule reaches the same accuracy here with a few dozen evaluations.</p>`);
    rows.push(html`<p class="note">So why does anyone use it? Because that exponent has no dimension in it. A grid rule needs
      2<sup>d</sup> times as many points per refinement and is unusable past about six dimensions; Monte Carlo needs four
      times as many samples per extra digit whether the integral is over an interval or over a fifty-dimensional cube.
      The crossover is the reason the method exists.</p>`);

    $('monte-results').innerHTML = rows.join('');
  }

  // ── laboratory: improper ─────────────────────────────────────────────────

  renderImproper() {
    const { f, a, b } = this.state;
    const analysis = memo(this.cache, 'improper', () => analyseImproper(f, a, b));
    const seq = analysis.sequence.filter((s) => Number.isFinite(s.value));

    const plot = this.plots.improper;
    plot.setLayers([
      { kind: 'curve', points: seq.map((s, i) => ({ x: i, y: s.value })), width: 2.2 },
      { kind: 'points', points: seq.map((s, i) => ({ x: i, y: s.value })), radius: 3 },
      ...(analysis.verdict.limit !== undefined && Number.isFinite(analysis.verdict.limit)
        ? [{ kind: 'curve', points: seq.map((s, i) => ({ x: i, y: analysis.verdict.limit })), colour: THEMES[this.theme].curveAlt, width: 1.2, dash: [5, 4] }]
        : []),
    ]).setView(null).draw();

    const rows = [];
    rows.push(html`<div class="formula accent">${definiteIntegralML(this.state.ast, a, b, this.state.v)}</div>`);

    if (!this.state.isImproper) {
      rows.push('<div class="flag info"><span class="flag-glyph">i</span><span>This integral is proper — bounded interval, bounded integrand. The sequence below shows the interval being closed in on anyway, which is worth seeing once: it settles immediately.</span></div>');
    }

    const verdictClass = { 'appears convergent': 'good', 'appears divergent': 'bad', oscillating: 'warn', 'too slow to tell': 'warn', inconclusive: 'warn', unknown: 'info' }[analysis.verdict.verdict] ?? 'info';
    rows.push(html`
      <div class="readout">
        <div class="readout-label">Behaviour</div>
        <div class="readout-value" style="font-size:17px">${esc(analysis.verdict.verdict)}</div>
        <div class="readout-sub">confidence: ${esc(analysis.verdict.confidence)}</div>
      </div>`);
    rows.push(html`<div class="flag ${verdictClass}"><span class="flag-glyph">◆</span><span>${esc(analysis.verdict.reason)}</span></div>`);

    if (analysis.verdict.verdict !== 'appears divergent') {
      rows.push(html`
        <div class="readout">
          <div class="readout-label">Value</div>
          <div class="readout-value numeric">${esc(formatNumber(analysis.value.value, 14))}</div>
          <div class="readout-sub">${esc(analysis.value.transform)}</div>
        </div>`);
    }

    for (const w of analysis.warnings) {
      rows.push(html`<div class="flag warn"><span class="flag-glyph">△</span><span>${esc(w)}</span></div>`);
    }

    rows.push('<h2 class="section">The limit, term by term</h2>');
    rows.push(html`
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Cut-off</th><th class="num">Partial integral</th><th class="num">Change</th></tr></thead>
        <tbody>${seq.map((s, i) => html`
          <tr>
            <td>${esc(s.label)}</td>
            <td class="num">${esc(formatNumber(s.value, 12))}</td>
            <td class="num">${i === 0 ? '—' : esc(formatError(s.value - seq[i - 1].value))}</td>
          </tr>`).join('')}
        </tbody></table></div>`);

    rows.push(html`<p class="note">The test that separates the cases is not whether the increments are <em>small</em> but whether
      they are <strong>decaying</strong>. ∫₁<sup>R</sup> dx/x adds ln 4 ≈ 1.386 on every quadrupling of R, for ever;
      set against a partial integral of 80 that looks like nothing, and it never stops. Its ratio to the previous
      increment is 1, and stays 1.</p>`);

    $('improper-results').innerHTML = rows.join('');
  }

  // ── laboratory: break the method ─────────────────────────────────────────

  scheduleBreak() {
    clearTimeout(this._breakTimer);
    this._breakTimer = setTimeout(() => this.renderBreak(), 120);
  }

  renderBreak() {
    const family = FAMILIES[this.breaker.family];
    const budget = this.breaker.budget;
    $('break-budget-out').textContent = `≈${budget} evaluations`;

    const methods = ['trapezoid', 'simpson', 'gauss', 'adaptive', 'tanhsinh'];
    const scans = methods.map((m) => {
      try { return scan(this.breaker.family, m, budget, 44); }
      catch { return null; }
    }).filter(Boolean);

    const layers = [];
    scans.forEach((s, i) => {
      const pts = s.points.filter((p) => Number.isFinite(p.relativeError) && p.relativeError > 0)
        .map((p) => ({ x: Math.abs(p.parameter) || 1e-3, y: p.relativeError }));
      if (!pts.length) return;
      layers.push({ kind: 'curve', points: pts, colour: SERIES_COLOURS[i % SERIES_COLOURS.length], width: 1.8 });
    });
    this.plots.break.setLayers(layers).setView(null).draw();

    const rows = [];
    rows.push(html`<div class="legend">${scans.map((s, i) =>
      `<span class="legend-item"><span class="swatch" style="background:${SERIES_COLOURS[i % SERIES_COLOURS.length]}"></span>${esc(s.methodLabel)}</span>`).join('')}</div>`);

    rows.push(html`<h2 class="section">${esc(family.label)}</h2>`);
    rows.push(html`<p class="note">${esc(family.why)}</p>`);
    rows.push(html`<p class="note"><strong>What to watch for.</strong> ${esc(family.watchFor)}</p>`);

    rows.push('<h2 class="section">Worst case found</h2>');
    rows.push(html`
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Method</th><th>Worst at</th><th class="num">Relative error</th><th class="num">Best case</th></tr></thead>
        <tbody>${scans.map((s) => html`
          <tr>
            <td class="method-name">${esc(s.methodLabel)}</td>
            <td>${s.worst ? `<code>${esc(s.worst.expression)}</code>` : '<span class="refused">refused all</span>'}</td>
            <td class="num ${s.worst && s.worst.relativeError > 1e-3 ? 'worst' : ''}">${s.worst ? esc(formatError(s.worst.relativeError)) : '—'}</td>
            <td class="num ${s.best && s.best.relativeError < 1e-10 ? 'best' : ''}">${s.best ? esc(formatError(s.best.relativeError)) : '—'}</td>
          </tr>`).join('')}
        </tbody></table></div>`);

    for (const s of scans) rows.push(html`<p class="note"><strong>${esc(s.methodLabel)}.</strong> ${esc(s.summary)}</p>`);

    rows.push(html`
      <div class="flag info"><span class="flag-glyph">i</span>
      <span>Everything above is the worst case <em>found on the grid searched</em>, at this budget. It is a search, not a proof:
      a finer grid or a wider parameter range may find worse, and no finite search can establish that it will not.</span></div>`);

    $('break-results').innerHTML = rows.join('');
  }

  // ── laboratory: show the mathematics ─────────────────────────────────────

  renderWorking() {
    const { ast, v, a, b, f } = this.state;
    const { exact, symbolic, numeric } = this.best();
    const rows = [];

    rows.push('<div class="prose-block">');
    rows.push('<h2 class="section">The problem</h2>');
    rows.push(`<div class="formula accent">${definiteIntegralML(ast, a, b, v)}</div>`);

    rows.push('<h2 class="section">1 · The definition being approximated</h2>');
    rows.push(html`<div class="step">
      <div class="step-title">Riemann sum</div>
      <div class="formula">${mathBlock(`<msubsup><mo>∫</mo><mi>a</mi><mi>b</mi></msubsup><mi>f</mi><mo stretchy="false">(</mo><mi>x</mi><mo stretchy="false">)</mo><mspace width="0.15em"/><mi mathvariant="normal">d</mi><mi>x</mi><mo>=</mo><munder><mo movablelimits="false">lim</mo><mrow><mi>N</mi><mo>→</mo><mi>∞</mi></mrow></munder><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>N</mi></munderover><mi>f</mi><mo stretchy="false">(</mo><msubsup><mi>x</mi><mi>i</mi><mo>*</mo></msubsup><mo stretchy="false">)</mo><mi mathvariant="normal">Δ</mi><mi>x</mi>`, { display: true })}</div>
      <p>Every numerical method here is a way of choosing where the sample points <em>x</em><sub>i</sub>* go and what
      weight each one carries. That single choice is the difference between an error that falls as 1/N and one that
      falls as 1/N⁴.</p>
    </div>`);

    rows.push('<h2 class="section">2 · The antiderivative</h2>');
    if (symbolic?.antiderivative) {
      const F = symbolic.antiderivative;
      rows.push(html`<div class="step">
        <div class="step-title">Found by ${esc(symbolic.method ?? 'the rule table')}</div>
        <div class="formula">${indefiniteIntegralML(ast, v)}</div>
        <div class="formula">${mathBlock('<mi>F</mi><mo stretchy="false">(</mo><mi>x</mi><mo stretchy="false">)</mo><mo>=</mo>' + toMathML(F) + '<mo>+</mo><mi>C</mi>', { display: true })}</div>
        <p>${esc(symbolic.verificationDetail ?? '')}</p>
        <p><strong>Verification.</strong> A heuristic search is only safe because its output is checked. Differentiating the
        candidate gives</p>
        <div class="formula">${mathBlock('<mfrac><mrow><mi mathvariant="normal">d</mi><mi>F</mi></mrow><mrow><mi mathvariant="normal">d</mi><mi>x</mi></mrow></mfrac><mo>=</mo>' + toMathML(simplify(derivative(F, v))), { display: true })}</div>
        <p>which is the integrand. A candidate that fails this check is discarded and never shown — the engine reports
        that it found nothing rather than showing you something it cannot stand behind.</p>
      </div>`);
    } else {
      rows.push(html`<div class="step">
        <div class="step-title">None found</div>
        <p>${esc(symbolic?.reason ?? '')}</p>
        <p>This is worth being precise about. For some integrands — <em>e</em><sup>−x²</sup>, sin(x)/x, √(1+x⁴) —
        it is a <strong>theorem</strong> that no elementary antiderivative exists. Liouville proved it in 1835, and no
        amount of cleverness or computing power changes it. For others, this engine simply does not know the trick.
        It cannot tell you which case you are in, and it does not pretend to.</p>
      </div>`);
    }

    rows.push('<h2 class="section">3 · The fundamental theorem</h2>');
    if (exact !== null) {
      const g = compileSafe(symbolic.antiderivative, [v]);
      rows.push(html`<div class="step">
        <div class="step-title">F(b) − F(a)</div>
        <div class="formula">${mathBlock(
          `<mi>F</mi><mo stretchy="false">(</mo>${toMathML({ k: 'num', v: b })}<mo stretchy="false">)</mo>`
          + `<mo>−</mo><mi>F</mi><mo stretchy="false">(</mo>${toMathML({ k: 'num', v: a })}<mo stretchy="false">)</mo>`
          + `<mo>=</mo>${toMathML({ k: 'num', v: g(b) })}<mo>−</mo>${toMathML({ k: 'num', v: g(a) })}`
          + `<mo>=</mo>${toMathML({ k: 'num', v: exact })}`, { display: true })}</div>
        <p>The theorem requires <em>f</em> to be continuous on the whole of [a, b]. That hypothesis is checked before this
        step runs: ∫<sub>−1</sub><sup>1</sup> dx/x² evaluates to −2 if you ignore it, which is a confident, precise,
        obviously impossible answer for the integral of a positive function.</p>
      </div>`);
    } else {
      rows.push(html`<div class="step">
        <div class="step-title">Not applicable</div>
        <p>The fundamental theorem needs an antiderivative, and there is none to use. Every number on this page for this
        integral therefore comes from quadrature.</p>
        <p>That is the ordinary case rather than the exceptional one. Most integrals that arise in physics, statistics and
        engineering have no closed form, and for them the numerical value <em>is</em> the answer — not a fallback from a
        better method that failed. What the fundamental theorem buys, when it applies, is a way to get the answer exactly
        and instantly; what quadrature buys is a way to get it at all.</p>
      </div>`);
    }

    rows.push('<h2 class="section">4 · What the quadrature did</h2>');
    rows.push(html`<div class="step">
      <div class="step-title">Tanh-sinh</div>
      <div class="formula">${mathBlock('<mi>x</mi><mo>=</mo><mi>tanh</mi><mo stretchy="false">(</mo><mfrac><mi>π</mi><mn>2</mn></mfrac><mi>sinh</mi><mspace width="0.1em"/><mi>t</mi><mo stretchy="false">)</mo>', { display: true })}</div>
      <p>Under this substitution the interval (−1, 1) becomes the whole real line, and the Jacobian decays
      <em>doubly</em> exponentially at both ends. Two consequences: the endpoints are never evaluated, so a singularity
      there costs nothing; and the transformed integrand dies so fast that the plain trapezoidal rule on a uniform
      <em>t</em>-grid converges faster than any polynomial rule.</p>
      <p>It used <strong>${numeric.evaluations}</strong> function evaluations and
      ${numeric.converged === false ? 'did <strong>not</strong> reach its tolerance' : `reached its tolerance in ${numeric.levels} refinement levels`}.</p>
      <div class="formula">${mathBlock('<mi>I</mi><mo>≈</mo>' + toMathML({ k: 'num', v: numeric.value }), { display: true })}</div>
    </div>`);

    if (exact !== null) {
      rows.push(html`<div class="step">
        <div class="step-title">Exact against numerical</div>
        <p>Exact <code>${esc(formatNumber(exact, 17))}</code><br>
        Numerical <code>${esc(formatNumber(numeric.value, 17))}</code><br>
        Absolute difference <code>${esc(formatError(Math.abs(numeric.value - exact)))}</code></p>
        <p>The numerical value is <em>never</em> labelled exact anywhere in this program, however many digits agree.
        A number produced by a limiting process is an approximation with a good error estimate, and the two are not
        the same kind of object.</p>
      </div>`);
    }

    rows.push('</div>');
    $('working-results').innerHTML = rows.join('');
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function memo(cache, key, fn) {
  if (cache.has(key)) return cache.get(key);
  const v = fn();
  cache.set(key, v);
  return v;
}

function prefersLight() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function variablesIn(ast) {
  const seen = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.k === 'var' && !seen.includes(n.name)) seen.push(n.name);
    for (const key of ['args']) if (Array.isArray(n[key])) n[key].forEach(walk);
    if (n.base) walk(n.base);
    if (n.exp) walk(n.exp);
    if (n.cases) n.cases.forEach((c) => { walk(c.when); walk(c.then); });
    if (n.otherwise) walk(n.otherwise);
  };
  walk(ast);
  return seen;
}

/** A limit may be a number, an expression, or an infinity. */
function evalLimit(text) {
  const t = String(text).trim().toLowerCase();
  if (t === 'inf' || t === '∞' || t === '+inf' || t === 'infinity') return Infinity;
  if (t === '-inf' || t === '−inf' || t === '-∞' || t === '−∞' || t === '-infinity') return -Infinity;
  const ast = parse(text);
  const f = compileSafe(ast, []);
  const v = f();
  if (!Number.isFinite(v)) throw new ParseError(`"${text}" is not a number I can use as a limit.`, 0, text.length);
  return v;
}

function limitNode(text) {
  const t = String(text).trim().toLowerCase();
  if (t.includes('inf') || t.includes('∞')) return t.startsWith('-') || t.startsWith('−') ? -Infinity : Infinity;
  try { return simplify(parse(text)); } catch { return { k: 'num', v: NaN }; }
}

/** The summation formula for each fixed rule, as MathML. */
function ruleFormula(key) {
  const F = {
    left: '<msub><mi>L</mi><mi>N</mi></msub><mo>=</mo><mi>h</mi><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>0</mn></mrow><mrow><mi>N</mi><mo>−</mo><mn>1</mn></mrow></munderover><mi>f</mi><mo stretchy="false">(</mo><msub><mi>x</mi><mi>i</mi></msub><mo stretchy="false">)</mo>',
    right: '<msub><mi>R</mi><mi>N</mi></msub><mo>=</mo><mi>h</mi><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>N</mi></munderover><mi>f</mi><mo stretchy="false">(</mo><msub><mi>x</mi><mi>i</mi></msub><mo stretchy="false">)</mo>',
    mid: '<msub><mi>M</mi><mi>N</mi></msub><mo>=</mo><mi>h</mi><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>0</mn></mrow><mrow><mi>N</mi><mo>−</mo><mn>1</mn></mrow></munderover><mi>f</mi><mo stretchy="false">(</mo><mfrac><mrow><msub><mi>x</mi><mi>i</mi></msub><mo>+</mo><msub><mi>x</mi><mrow><mi>i</mi><mo>+</mo><mn>1</mn></mrow></msub></mrow><mn>2</mn></mfrac><mo stretchy="false">)</mo>',
    trapezoid: '<msub><mi>T</mi><mi>N</mi></msub><mo>=</mo><mfrac><mi>h</mi><mn>2</mn></mfrac><mrow><mo>[</mo><mi>f</mi><mo stretchy="false">(</mo><mi>a</mi><mo stretchy="false">)</mo><mo>+</mo><mn>2</mn><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mrow><mi>N</mi><mo>−</mo><mn>1</mn></mrow></munderover><mi>f</mi><mo stretchy="false">(</mo><msub><mi>x</mi><mi>i</mi></msub><mo stretchy="false">)</mo><mo>+</mo><mi>f</mi><mo stretchy="false">(</mo><mi>b</mi><mo stretchy="false">)</mo><mo>]</mo></mrow>',
    simpson: '<msub><mi>S</mi><mi>N</mi></msub><mo>=</mo><mfrac><mi>h</mi><mn>3</mn></mfrac><mrow><mo>[</mo><msub><mi>f</mi><mn>0</mn></msub><mo>+</mo><mn>4</mn><msub><mi>f</mi><mn>1</mn></msub><mo>+</mo><mn>2</mn><msub><mi>f</mi><mn>2</mn></msub><mo>+</mo><mn>4</mn><msub><mi>f</mi><mn>3</mn></msub><mo>+</mo><mo>⋯</mo><mo>+</mo><mn>4</mn><msub><mi>f</mi><mrow><mi>N</mi><mo>−</mo><mn>1</mn></mrow></msub><mo>+</mo><msub><mi>f</mi><mi>N</mi></msub><mo>]</mo></mrow>',
    simpson38: '<msub><mi>S</mi><mn>38</mn></msub><mo>=</mo><mfrac><mrow><mn>3</mn><mi>h</mi></mrow><mn>8</mn></mfrac><mrow><mo>[</mo><msub><mi>f</mi><mn>0</mn></msub><mo>+</mo><mn>3</mn><msub><mi>f</mi><mn>1</mn></msub><mo>+</mo><mn>3</mn><msub><mi>f</mi><mn>2</mn></msub><mo>+</mo><mn>2</mn><msub><mi>f</mi><mn>3</mn></msub><mo>+</mo><mo>⋯</mo><mo>+</mo><msub><mi>f</mi><mi>N</mi></msub><mo>]</mo></mrow>',
  };
  return mathBlock(F[key] ?? '', { display: true });
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.__integra = app;
});
