// Vanilla canvas "live line" chart — a liveline-style smoothly-scrolling multi-line
// renderer with no framework + no build step. Each series eases (frame-rate-independent
// lerp) toward its latest pushed value while the time window scrolls left at 60fps.
// Pure helpers (lerp, niceRange) are exported for unit tests; the class touches the
// DOM only inside methods, so importing this module in Node (vitest) is safe.

export const lerp = (a, b, t) => a + (b - a) * t;

/** A padded [min,max] for the Y axis; never zero-height. */
export function niceRange(min, max) {
  if (!isFinite(min) || !isFinite(max)) return [-0.5, 0.5];
  if (min === max) { min -= 0.5; max += 0.5; }
  const pad = (max - min) * 0.12 || 0.5;
  return [min - pad, max + pad];
}

export class LiveChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.windowMs = opts.windowMs ?? 120000; // rolling window (~2 min)
    this.mode = opts.mode ?? "pnl";
    this.series = new Map(); // id -> { color, label, data:[{t,v}], value, display }
    this.iso = null;
    this.yMin = -0.5;
    this.yMax = 0.5;
    this.running = false;
    this.lastFrame = 0;
    this.lastCommit = 0;
    this.animate = !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion:reduce)").matches);
    this._raf = this._raf.bind(this);
    this._resize();
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
  }

  setMode(m) { this.mode = m; }
  setIsolation(id) { this.iso = id; }

  /** Reconcile the visible series (adds new, removes gone, updates color/label). */
  setSeries(list) {
    const ids = new Set(list.map((s) => s.id));
    for (const id of [...this.series.keys()]) if (!ids.has(id)) this.series.delete(id);
    for (const s of list) {
      const cur = this.series.get(s.id);
      if (cur) { cur.color = s.color; cur.label = s.label; }
      else this.series.set(s.id, { color: s.color, label: s.label, data: [], value: 0, display: 0 });
    }
  }

  /** Prefill a series from historical points [{t,v}] so it isn't empty on first show. */
  seed(id, points) {
    const s = this.series.get(id);
    if (!s) return;
    const cutoff = Date.now() - this.windowMs;
    s.data = (points || []).filter((p) => p.t >= cutoff).map((p) => ({ t: p.t, v: p.v }));
    if (s.data.length) s.value = s.display = s.data[s.data.length - 1].v;
  }

  /** Push the latest value for a series; the line eases toward it. */
  setValue(id, v) {
    const s = this.series.get(id);
    if (!s) return;
    s.value = v;
    if (!this.animate) s.display = v;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.lastCommit = 0;
    requestAnimationFrame(this._raf);
  }
  stop() { this.running = false; }
  destroy() {
    this.stop();
    if (this._ro) this._ro.disconnect();
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = r.width;
    this.H = r.height;
  }

  _raf(now) {
    if (!this.running) return;
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    const k = this.animate ? 1 - Math.exp(-dt / 120) : 1; // ~120ms time-constant
    const tNow = Date.now();
    const cutoff = tNow - this.windowMs;
    const commit = now - this.lastCommit >= 90; // ~11fps sample rate for the committed line
    for (const s of this.series.values()) {
      s.display = lerp(s.display, s.value, k);
      if (commit) s.data.push({ t: tNow, v: s.display });
      while (s.data.length && s.data[0].t < cutoff) s.data.shift();
    }
    if (commit) this.lastCommit = now;
    this._draw(tNow);
    requestAnimationFrame(this._raf);
  }

  _draw(tNow) {
    const ctx = this.ctx, W = this.W, H = this.H;
    const t0 = tNow - this.windowMs, t1 = tNow;
    ctx.clearRect(0, 0, W, H);

    let mn = Infinity, mx = -Infinity;
    for (const s of this.series.values()) for (const p of s.data) { if (p.v < mn) mn = p.v; if (p.v > mx) mx = p.v; }
    if (this.mode === "pnl") { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
    const [tmn, tmx] = niceRange(mn, mx);
    const ek = this.animate ? 0.12 : 1;
    this.yMin = lerp(this.yMin, tmn, ek);
    this.yMax = lerp(this.yMax, tmx, ek);

    const padL = 6, padR = 8, padTop = 8, padBot = 8;
    const plotW = W - padL - padR, plotH = H - padTop - padBot;
    const span = this.yMax - this.yMin || 1;
    const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const yOf = (v) => padTop + (1 - (v - this.yMin) / span) * plotH;

    // gridlines + value labels
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "bottom";
    for (let i = 0; i <= 3; i++) {
      const v = this.yMin + (span * i) / 3;
      const y = yOf(v);
      ctx.strokeStyle = "#181c27";
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillStyle = "#6b7286";
      ctx.fillText(this.mode === "pnl" ? (v >= 0 ? "+" : "") + "$" + v.toFixed(2) : "$" + v.toFixed(0), padL + 2, y - 1);
    }
    // zero baseline (PnL mode)
    if (this.mode === "pnl" && this.yMin < 0 && this.yMax > 0) {
      const y = yOf(0);
      ctx.save(); ctx.strokeStyle = "#2a3142"; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.restore();
    }
    // series lines
    for (const [id, s] of this.series) {
      if (!s.data.length) continue;
      const dimmed = this.iso && id !== this.iso;
      const hl = this.iso && id === this.iso;
      ctx.strokeStyle = dimmed ? s.color + "20" : s.color;
      ctx.lineWidth = hl ? 2.5 : 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (const p of s.data) {
        const x = xOf(p.t), y = yOf(p.v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.lineTo(xOf(tNow), yOf(s.display)); // live edge at "now"
      ctx.stroke();
      if (!dimmed) {
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(xOf(tNow) - 1, yOf(s.display), 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}
