/**
 * plot.js — the graph engine.
 *
 * A canvas plotter built for mathematical functions rather than for data: it
 * knows about asymptotes, about the difference between a gap in the domain and
 * a vertical jump, about drawing an area that is signed, and about the fact
 * that a curve should be sampled where it is interesting rather than uniformly.
 *
 * Three decisions worth naming, because each is a place where a naïve plotter
 * draws something false:
 *
 *   · Poles are broken, not bridged. Plotting tan x by joining consecutive
 *     samples draws a near-vertical line through the asymptote — a line that
 *     is not part of the graph. The path is cut wherever the function leaves
 *     the viewport or stops being finite.
 *
 *   · Sampling is adaptive. A uniform grid at one sample per pixel misses a
 *     spike narrower than a pixel entirely: the curve is drawn smooth and flat
 *     straight through a feature that carries all of the area. Segments are
 *     subdivided where the curve bends.
 *
 *   · Everything is drawn at device resolution. A canvas scaled by CSS rather
 *     than by its backing store is soft on every display made in the last
 *     decade, and soft axes look like a mistake because they are one.
 */

export const THEMES = {
  dark: {
    background: '#0a0d13',
    panel: '#0e1219',
    grid: '#161c28',
    gridMajor: '#222b3d',
    axis: '#6b7789',
    axisLine: '#3d4759',
    text: '#e8edf5',
    textDim: '#7f8ca3',
    curve: '#5eb0ff',
    curveAlt: '#ffb454',
    area: 'rgba(94, 176, 255, 0.20)',
    areaNegative: 'rgba(255, 110, 110, 0.20)',
    strip: 'rgba(94, 176, 255, 0.28)',
    stripEdge: 'rgba(150, 200, 255, 0.85)',
    stripNegative: 'rgba(255, 110, 110, 0.26)',
    stripNegativeEdge: 'rgba(255, 150, 150, 0.85)',
    marker: '#ffd166',
    cursor: '#8b9bb4',
    accent: '#5eb0ff',
    hit: '#4ade80',
    miss: '#f87171',
  },
  light: {
    background: '#ffffff',
    panel: '#f7f9fc',
    grid: '#eef2f7',
    gridMajor: '#dde5ef',
    axis: '#8a97ab',
    axisLine: '#aab6c6',
    text: '#141a24',
    textDim: '#5d6a7d',
    curve: '#1668c6',
    curveAlt: '#c2670a',
    area: 'rgba(22, 104, 198, 0.16)',
    areaNegative: 'rgba(200, 40, 40, 0.16)',
    strip: 'rgba(22, 104, 198, 0.22)',
    stripEdge: 'rgba(22, 104, 198, 0.8)',
    stripNegative: 'rgba(200, 40, 40, 0.20)',
    stripNegativeEdge: 'rgba(200, 40, 40, 0.8)',
    marker: '#b45309',
    cursor: '#7b8798',
    accent: '#1668c6',
    hit: '#15803d',
    miss: '#b91c1c',
  },
};

const PAD = { left: 58, right: 18, top: 18, bottom: 34 };

export class Plot {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = options;
    this.theme = THEMES.dark;
    this.view = null;                 // { x0, x1, y0, y1 }, null = auto
    this.layers = [];
    this.hover = null;
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.resize();
  }

  setTheme(name) { this.theme = THEMES[name] ?? THEMES.dark; return this; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    // A hidden or mid-layout panel measures zero. Drawing into a zero-sized
    // canvas silently produces nothing, so floor both dimensions rather than
    // letting a transient measurement blank the plot.
    const w = Math.max(rect.width || 0, 240);
    const h = Math.max(rect.height || 0, 160);
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.width = w;
    this.height = h;
    return this;
  }

  get area() {
    const p = this.opts.padding ?? PAD;
    return { x: p.left, y: p.top, w: this.width - p.left - p.right, h: this.height - p.top - p.bottom };
  }

  setLayers(layers) { this.layers = layers; return this; }
  setView(view) { this.view = view; return this; }

  // ── coordinate mapping ────────────────────────────────────────────────────

  bounds() {
    if (this.view) return this.view;
    return this.autoBounds();
  }

  /**
   * Choose a viewport from the curves present.
   *
   * The y-range comes from a robust quantile rather than the extremes. One
   * sample beside a pole is a million times everything else, and letting it set
   * the scale flattens the entire rest of the graph into the axis. Trimming the
   * outer 1.5% keeps the shape of the function visible and lets the pole run
   * off the top of the frame, which is where it belongs.
   */
  autoBounds() {
    let x0 = Infinity, x1 = -Infinity;
    const ys = [];
    for (const layer of this.layers) {
      if (!layer.points) continue;
      for (const p of layer.points) {
        if (!Number.isFinite(p.x)) continue;
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (Number.isFinite(p.y)) ys.push(p.y);
      }
    }
    if (!Number.isFinite(x0)) return { x0: -1, x1: 1, y0: -1, y1: 1 };
    if (x1 === x0) { x0 -= 1; x1 += 1; }
    if (!ys.length) return { x0, x1, y0: -1, y1: 1 };

    ys.sort((a, b) => a - b);
    const q = (t) => ys[Math.min(ys.length - 1, Math.max(0, Math.floor(t * (ys.length - 1))))];
    let lo = q(0.015), hi = q(0.985);
    if (!(hi > lo)) { lo = ys[0]; hi = ys[ys.length - 1]; }
    if (hi === lo) { lo -= 1; hi += 1; }

    // Always include y = 0: for an integral the axis is not decoration, it is
    // the boundary of the region being measured.
    if (lo > 0) lo = 0;
    if (hi < 0) hi = 0;
    const pad = (hi - lo) * 0.08;
    return { x0, x1, y0: lo - pad, y1: hi + pad };
  }

  px(x, b, a) { return a.x + ((x - b.x0) / (b.x1 - b.x0)) * a.w; }
  py(y, b, a) { return a.y + a.h - ((y - b.y0) / (b.y1 - b.y0)) * a.h; }
  ux(px, b, a) { return b.x0 + ((px - a.x) / a.w) * (b.x1 - b.x0); }
  uy(py, b, a) { return b.y0 + ((a.y + a.h - py) / a.h) * (b.y1 - b.y0); }

  // ── drawing ───────────────────────────────────────────────────────────────

  draw() {
    const { ctx, theme } = this;
    const a = this.area;
    const b = this.bounds();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawGrid(b, a);

    ctx.save();
    ctx.beginPath();
    ctx.rect(a.x, a.y, a.w, a.h);
    ctx.clip();
    for (const layer of this.layers) this.drawLayer(layer, b, a);
    ctx.restore();

    this.drawAxes(b, a);
    if (this.hover) this.drawHover(b, a);
    return this;
  }

  drawGrid(b, a) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.lineWidth = 1;

    for (const t of niceTicks(b.x0, b.x1, Math.max(3, Math.round(a.w / 90)))) {
      const x = Math.round(this.px(t, b, a)) + 0.5;
      ctx.strokeStyle = t === 0 ? theme.gridMajor : theme.grid;
      ctx.beginPath(); ctx.moveTo(x, a.y); ctx.lineTo(x, a.y + a.h); ctx.stroke();
      ctx.fillStyle = theme.textDim;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(tickLabel(t), x, a.y + a.h + 7);
    }
    for (const t of niceTicks(b.y0, b.y1, Math.max(3, Math.round(a.h / 46)))) {
      const y = Math.round(this.py(t, b, a)) + 0.5;
      ctx.strokeStyle = t === 0 ? theme.gridMajor : theme.grid;
      ctx.beginPath(); ctx.moveTo(a.x, y); ctx.lineTo(a.x + a.w, y); ctx.stroke();
      ctx.fillStyle = theme.textDim;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(tickLabel(t), a.x - 8, y);
    }
    ctx.restore();
  }

  drawAxes(b, a) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.strokeStyle = theme.axisLine;
    ctx.lineWidth = 1.25;
    if (b.y0 <= 0 && b.y1 >= 0) {
      const y = Math.round(this.py(0, b, a)) + 0.5;
      ctx.beginPath(); ctx.moveTo(a.x, y); ctx.lineTo(a.x + a.w, y); ctx.stroke();
    }
    if (b.x0 <= 0 && b.x1 >= 0) {
      const x = Math.round(this.px(0, b, a)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, a.y); ctx.lineTo(x, a.y + a.h); ctx.stroke();
    }
    ctx.strokeStyle = theme.grid;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1);
    ctx.restore();
  }

  drawLayer(layer, b, a) {
    switch (layer.kind) {
      case 'area': return this.drawArea(layer, b, a);
      case 'strips': return this.drawStrips(layer, b, a);
      case 'curve': return this.drawCurve(layer, b, a);
      case 'points': return this.drawPoints(layer, b, a);
      case 'darts': return this.drawDarts(layer, b, a);
      case 'vlines': return this.drawVLines(layer, b, a);
      case 'bands': return this.drawBands(layer, b, a);
      default: return undefined;
    }
  }

  /**
   * A curve, broken wherever it leaves the world.
   *
   * The path restarts on a non-finite sample and on a jump large enough to be a
   * pole rather than a steep slope. That second test is what stops tan(x) being
   * drawn with vertical bars through its asymptotes — the bar is an artefact of
   * joining two points that the function never passes between.
   */
  drawCurve(layer, b, a) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = layer.colour ?? this.theme.curve;
    ctx.lineWidth = layer.width ?? 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (layer.dash) ctx.setLineDash(layer.dash);

    const jumpLimit = a.h * 4;
    let started = false, prevPx = 0, prevPy = 0;
    ctx.beginPath();
    for (const p of layer.points) {
      if (!Number.isFinite(p.y) || !Number.isFinite(p.x)) { started = false; continue; }
      const X = this.px(p.x, b, a), Y = this.py(p.y, b, a);
      if (!started) { ctx.moveTo(X, Y); started = true; }
      else if (Math.abs(Y - prevPy) > jumpLimit) { ctx.moveTo(X, Y); }
      else ctx.lineTo(X, Y);
      prevPx = X; prevPy = Y;
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The region between the curve and the axis, coloured by sign.
   *
   * An integral is a *signed* area, and a plot that shades everything the same
   * colour hides the single most common source of surprise — that ∫sin over a
   * full period is zero because the two halves cancel. Positive and negative
   * parts are shaded separately, so the cancellation is visible.
   */
  drawArea(layer, b, a) {
    const { ctx } = this;
    const inRange = layer.points.filter((p) => p.x >= layer.a - 1e-12 && p.x <= layer.b + 1e-12);
    if (inRange.length < 2) return;

    const zeroY = this.py(0, b, a);
    let run = [];
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      const positive = run.reduce((s, p) => s + p.y, 0) >= 0;
      ctx.beginPath();
      ctx.moveTo(this.px(run[0].x, b, a), zeroY);
      for (const p of run) ctx.lineTo(this.px(p.x, b, a), this.py(p.y, b, a));
      ctx.lineTo(this.px(run[run.length - 1].x, b, a), zeroY);
      ctx.closePath();
      ctx.fillStyle = positive ? (layer.colour ?? this.theme.area) : (layer.negativeColour ?? this.theme.areaNegative);
      ctx.fill();
      run = [];
    };

    ctx.save();
    let sign = 0;
    for (const p of inRange) {
      if (!Number.isFinite(p.y)) { flush(); sign = 0; continue; }
      const s = Math.sign(p.y) || sign;
      if (sign !== 0 && s !== 0 && s !== sign) { flush(); }
      sign = s;
      run.push(p);
    }
    flush();
    ctx.restore();
  }

  /** The rectangles, trapezia or parabolic panels a rule actually summed. */
  drawStrips(layer, b, a) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.lineWidth = layer.strips.length > 180 ? 0.5 : 1;

    for (const s of layer.strips) {
      const negative = (s.kind === 'rect' ? s.y : (s.y0 + s.y1) / 2) < 0;
      ctx.fillStyle = negative ? theme.stripNegative : theme.strip;
      ctx.strokeStyle = negative ? theme.stripNegativeEdge : theme.stripEdge;

      const x0 = this.px(s.x0, b, a), x1 = this.px(s.x1, b, a);
      const zero = this.py(0, b, a);

      if (s.kind === 'rect') {
        if (!Number.isFinite(s.y)) continue;
        const y = this.py(s.y, b, a);
        ctx.beginPath();
        ctx.rect(x0, Math.min(y, zero), Math.max(0.6, x1 - x0), Math.abs(y - zero));
        ctx.fill();
        if (layer.strips.length <= 400) ctx.stroke();
      } else if (s.kind === 'trapezoid') {
        if (!Number.isFinite(s.y0) || !Number.isFinite(s.y1)) continue;
        ctx.beginPath();
        ctx.moveTo(x0, zero);
        ctx.lineTo(x0, this.py(s.y0, b, a));
        ctx.lineTo(x1, this.py(s.y1, b, a));
        ctx.lineTo(x1, zero);
        ctx.closePath();
        ctx.fill();
        if (layer.strips.length <= 400) ctx.stroke();
      } else {
        // Simpson: draw the interpolating polynomial itself, not the samples.
        // The whole idea of the rule is the curve it fits, and a picture that
        // shows straight lines is a picture of a different method.
        const pts = polyThrough(s.xs, s.ys);
        if (!pts) continue;
        ctx.beginPath();
        ctx.moveTo(x0, zero);
        const steps = Math.max(8, Math.round(Math.abs(x1 - x0) / 2));
        for (let i = 0; i <= steps; i++) {
          const t = s.xs[0] + ((s.xs[s.xs.length - 1] - s.xs[0]) * i) / steps;
          ctx.lineTo(this.px(t, b, a), this.py(pts(t), b, a));
        }
        ctx.lineTo(x1, zero);
        ctx.closePath();
        ctx.fill();
        if (layer.strips.length <= 200) ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawPoints(layer, b, a) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = layer.colour ?? this.theme.marker;
    const r = layer.radius ?? 3;
    for (const p of layer.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      ctx.beginPath();
      ctx.arc(this.px(p.x, b, a), this.py(p.y, b, a), r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Monte Carlo darts, coloured by whether they landed under the curve. */
  drawDarts(layer, b, a) {
    const { ctx, theme } = this;
    ctx.save();
    for (const d of layer.darts) {
      ctx.fillStyle = d.hit ? theme.hit : theme.miss;
      ctx.globalAlpha = d.hit ? 0.72 : 0.34;
      ctx.beginPath();
      ctx.arc(this.px(d.x, b, a), this.py(d.y, b, a), layer.radius ?? 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawVLines(layer, b, a) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = layer.colour ?? this.theme.cursor;
    ctx.lineWidth = layer.width ?? 1.5;
    if (layer.dash) ctx.setLineDash(layer.dash);
    for (const x of layer.xs) {
      const X = Math.round(this.px(x, b, a)) + 0.5;
      ctx.beginPath(); ctx.moveTo(X, a.y); ctx.lineTo(X, a.y + a.h); ctx.stroke();
    }
    ctx.restore();
  }

  /** Shaded horizontal band — used for a Monte Carlo confidence interval. */
  drawBands(layer, b, a) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = layer.colour ?? 'rgba(94,176,255,0.15)';
    for (const band of layer.bands) {
      const y0 = this.py(band.hi, b, a), y1 = this.py(band.lo, b, a);
      ctx.fillRect(a.x, y0, a.w, Math.max(1, y1 - y0));
    }
    ctx.restore();
  }

  drawHover(b, a) {
    const { ctx, theme } = this;
    const { x, y, label } = this.hover;
    const X = this.px(x, b, a);
    ctx.save();
    ctx.strokeStyle = theme.cursor;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X, a.y); ctx.lineTo(X, a.y + a.h); ctx.stroke();
    ctx.setLineDash([]);

    if (Number.isFinite(y)) {
      const Y = this.py(y, b, a);
      ctx.fillStyle = theme.marker;
      ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill();
    }

    if (label) {
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      const w = ctx.measureText(label).width + 14;
      const bx = Math.min(Math.max(a.x + 2, X - w / 2), a.x + a.w - w - 2);
      ctx.fillStyle = theme.panel;
      ctx.strokeStyle = theme.gridMajor;
      roundRect(ctx, bx, a.y + 4, w, 20, 4);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + w / 2, a.y + 14);
    }
    ctx.restore();
  }
}

// ── log-scale plot, for convergence ─────────────────────────────────────────

/**
 * A log-log plot. Convergence is a power law, and a power law is a straight
 * line on log-log axes — which is the entire reason error-versus-N is never
 * plotted any other way. The slope you read off *is* the order of the method.
 */
export class LogLogPlot extends Plot {
  bounds() {
    if (this.view) return this.view;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const layer of this.layers) {
      for (const p of layer.points ?? []) {
        if (!(p.x > 0) || !(p.y > 0) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
    }
    if (!Number.isFinite(x0)) return { x0: 1, x1: 1000, y0: 1e-16, y1: 1 };
    return {
      x0: Math.pow(10, Math.floor(Math.log10(x0))),
      x1: Math.pow(10, Math.ceil(Math.log10(x1))),
      y0: Math.pow(10, Math.floor(Math.log10(y0))),
      y1: Math.pow(10, Math.ceil(Math.log10(y1))),
    };
  }

  px(x, b, a) {
    if (!(x > 0)) return -1e6;
    return a.x + ((Math.log10(x) - Math.log10(b.x0)) / (Math.log10(b.x1) - Math.log10(b.x0))) * a.w;
  }

  py(y, b, a) {
    if (!(y > 0)) return a.y + a.h + 1e6;
    return a.y + a.h - ((Math.log10(y) - Math.log10(b.y0)) / (Math.log10(b.y1) - Math.log10(b.y0))) * a.h;
  }

  drawGrid(b, a) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.lineWidth = 1;

    for (const t of decades(b.x0, b.x1)) {
      const x = Math.round(this.px(t.value, b, a)) + 0.5;
      ctx.strokeStyle = t.major ? theme.gridMajor : theme.grid;
      ctx.beginPath(); ctx.moveTo(x, a.y); ctx.lineTo(x, a.y + a.h); ctx.stroke();
      if (t.major) {
        ctx.fillStyle = theme.textDim;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(sciLabel(t.value), x, a.y + a.h + 7);
      }
    }
    for (const t of decades(b.y0, b.y1)) {
      const y = Math.round(this.py(t.value, b, a)) + 0.5;
      ctx.strokeStyle = t.major ? theme.gridMajor : theme.grid;
      ctx.beginPath(); ctx.moveTo(a.x, y); ctx.lineTo(a.x + a.w, y); ctx.stroke();
      if (t.major) {
        ctx.fillStyle = theme.textDim;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(sciLabel(t.value), a.x - 8, y);
      }
    }
    ctx.restore();
  }

  drawAxes(b, a) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.strokeStyle = theme.grid;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1);
    ctx.restore();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** 1-2-5 tick positions across a range. */
export function niceTicks(lo, hi, target = 6) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    if (out.length > 200) break;
  }
  return out;
}

/** Decade gridlines with 2 and 5 subdivisions, guarded against a bad range. */
export function decades(lo, hi) {
  const out = [];
  if (!(lo > 0) || !(hi > 0) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return out;
  const e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
  if (e1 - e0 > 40) return out;
  for (let e = e0; e <= e1; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push({ value: v, major: m === 1 });
    }
  }
  return out;
}

function tickLabel(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-4) return v.toExponential(0).replace('e', 'e').replace('+', '');
  return String(Number(v.toPrecision(6)));
}

function sciLabel(v) {
  const e = Math.log10(v);
  if (Number.isInteger(e)) {
    if (e === 0) return '1';
    if (e >= 0 && e <= 4) return String(Math.round(v));
    return `10${superscript(e)}`;
  }
  return String(Number(v.toPrecision(2)));
}

const SUPS = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const superscript = (n) => String(n).split('').map((c) => SUPS[c] ?? c).join('');

/** Lagrange interpolation through the sample points of one Simpson panel. */
function polyThrough(xs, ys) {
  if (!xs || xs.some((x) => !Number.isFinite(x)) || ys.some((y) => !Number.isFinite(y))) return null;
  return (t) => {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) {
      let term = ys[i];
      for (let j = 0; j < xs.length; j++) {
        if (i === j) continue;
        term *= (t - xs[j]) / (xs[i] - xs[j]);
      }
      sum += term;
    }
    return sum;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Sample a function across a range, refining where the curve bends.
 *
 * A uniform sample per pixel draws a Lorentzian of width 10⁻³ on [0, 1] as a
 * flat line: the peak falls between two samples and simply is not there. The
 * refinement here bisects a segment whose midpoint departs from the straight
 * line between its ends by more than a fraction of a pixel, which finds any
 * feature wide enough to be visible and costs nothing on a curve that is
 * already straight.
 */
export function sampleCurve(f, x0, x1, pixels, options = {}) {
  const base = Math.max(16, Math.min(4000, Math.round(pixels)));
  const maxExtra = options.maxExtra ?? base * 6;
  const points = [];
  let extra = 0;

  const yScaleHint = options.yScale ?? null;

  const emit = (x) => { const y = f(x); points.push({ x, y }); return y; };

  let prevX = x0;
  let prevY = emit(x0);

  for (let i = 1; i <= base; i++) {
    const x = x0 + ((x1 - x0) * i) / base;
    const y = f(x);
    refine(prevX, prevY, x, y, 0);
    points.push({ x, y });
    prevX = x; prevY = y;
  }

  function refine(xa, ya, xb, yb, depth) {
    if (depth > 6 || extra > maxExtra) return;
    if (!Number.isFinite(ya) && !Number.isFinite(yb)) return;
    const xm = (xa + xb) / 2;
    const ym = f(xm);
    extra++;

    // A change from finite to non-finite is a domain edge; resolve it closely
    // so the break in the drawn curve lands in the right place.
    const crossing = Number.isFinite(ya) !== Number.isFinite(ym) || Number.isFinite(ym) !== Number.isFinite(yb);
    if (!crossing && Number.isFinite(ya) && Number.isFinite(yb) && Number.isFinite(ym)) {
      const straight = (ya + yb) / 2;
      const scale = yScaleHint ?? Math.max(Math.abs(ya), Math.abs(yb), Math.abs(ym), 1e-12);
      if (Math.abs(ym - straight) <= scale * 0.004) return;
    }
    refine(xa, ya, xm, ym, depth + 1);
    points.push({ x: xm, y: ym });
    refine(xm, ym, xb, yb, depth + 1);
  }

  points.sort((p, q) => p.x - q.x);
  return points;
}
