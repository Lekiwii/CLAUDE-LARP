'use strict';
/*
 * Two small 3D instruments for the side columns.
 *
 * Core    — a wireframe sphere that spins with session activity; every real
 *           event kicks a few vertices outward, pending tool calls orbit it.
 * Terrain — a receding ridgeline of recent activity, one ridge per time slice,
 *           one bump per kind of tool. The newest slice is at the front.
 */
const Viz = (() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const theme = { ink: '225,225,225', hot: '255,255,255', bg: '#0c0c0c', font: 'monospace' };

  function setTheme() {
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    theme.ink = v('--ink', theme.ink);
    theme.hot = v('--ink-hot', theme.hot);
    theme.bg = v('--panel', theme.bg);
    theme.font = v('--mono', theme.font);
  }

  function fitCanvas(c) {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(1, Math.round(r.width * dpr));
    const ph = Math.max(1, Math.round(r.height * dpr));
    // Assigning a canvas size wipes it, even to the same value: only do it on a real change.
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: r.width, h: r.height };
  }

  /* ---------- Core ---------- */

  const Core = (() => {
    const LAT = 9;
    const LON = 18;
    const spikes = new Float32Array((LAT + 1) * LON);
    let cv, g, w = 0, h = 0;
    let rot = 0;
    let energy = 0;
    let pending = 0;
    let last = 0;

    function init(canvas) {
      cv = canvas;
    }

    function resize() {
      ({ g, w, h } = fitCanvas(cv));
    }

    function hit(amount) {
      energy = Math.min(1, energy + amount);
      const n = 3 + Math.round(amount * 10);
      for (let i = 0; i < n; i++) spikes[(Math.random() * spikes.length) | 0] = 0.18 + amount * 0.5;
    }

    function point(i, j, R, tilt) {
      const phi = (i / LAT) * Math.PI;
      const th = (j / LON) * 6.2832 + rot;
      const r = R * (1 + spikes[i * LON + (j % LON)]);
      const x = r * Math.sin(phi) * Math.cos(th);
      const y0 = r * Math.cos(phi);
      const z0 = r * Math.sin(phi) * Math.sin(th);
      const y = y0 * Math.cos(tilt) - z0 * Math.sin(tilt);
      const z = y0 * Math.sin(tilt) + z0 * Math.cos(tilt);
      const k = 3.2 * R / (3.2 * R + z);
      return [w / 2 + x * k, h / 2 + y * k, z / R];
    }

    function seg(a, b) {
      const depth = (a[2] + b[2]) / 2; // -1 front .. 1 back
      g.strokeStyle = `rgba(${depth < -0.2 ? theme.hot : theme.ink},${0.62 - 0.42 * ((depth + 1) / 2)})`;
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    }

    function frame(now) {
      if (w < 20 || h < 20) return;
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      if (!reduced) rot += dt * (0.25 + energy * 2.6);
      const R = Math.min(w, h) * 0.33;
      const tilt = 0.42;

      g.clearRect(0, 0, w, h);
      g.lineWidth = 0.7;
      const grid = [];
      for (let i = 0; i <= LAT; i++) {
        grid.push([]);
        for (let j = 0; j <= LON; j++) grid[i].push(point(i, j, R, tilt));
      }
      for (let i = 1; i < LAT; i++) for (let j = 0; j < LON; j++) seg(grid[i][j], grid[i][j + 1]);
      for (let j = 0; j < LON; j++) for (let i = 0; i < LAT; i++) seg(grid[i][j], grid[i + 1][j]);

      // orbit ring with one satellite per pending tool call
      const rx = R * 1.5;
      const ry = R * 0.42;
      g.strokeStyle = `rgba(${theme.ink},0.3)`;
      g.setLineDash([2, 4]);
      g.beginPath();
      g.ellipse(w / 2, h / 2, rx, ry, -0.25, 0, 6.2832);
      g.stroke();
      g.setLineDash([]);
      const sats = Math.min(8, pending);
      for (let s = 0; s < sats; s++) {
        const a = now / 700 + (s / sats) * 6.2832;
        const ox = Math.cos(a) * rx;
        const oy = Math.sin(a) * ry;
        const x = w / 2 + ox * Math.cos(-0.25) - oy * Math.sin(-0.25);
        const y = h / 2 + ox * Math.sin(-0.25) + oy * Math.cos(-0.25);
        g.fillStyle = `rgb(${theme.hot})`;
        g.fillRect(x - 2, y - 2, 4, 4);
      }

      // heart
      g.fillStyle = `rgba(${theme.hot},${0.35 + energy * 0.65})`;
      g.beginPath();
      g.arc(w / 2, h / 2, 2 + energy * 5, 0, 6.2832);
      g.fill();

      for (let i = 0; i < spikes.length; i++) spikes[i] *= Math.pow(0.02, dt);
      energy *= Math.pow(0.45, dt);
    }

    return {
      init, resize, hit, frame,
      set pending(n) { pending = n; },
      get load() { return energy; },
    };
  })();

  /* ---------- Terrain ---------- */

  const Terrain = (() => {
    const COLS = 30;
    const ROWS = 20;
    const SLICE = 900; // ms of activity per ridge
    const LANES = { READ: 0.1, SEARCH: 0.24, EDIT: 0.4, SHELL: 0.56, WEB: 0.7, AGENT: 0.82, PLAN: 0.93, MCP: 0.5, OTHER: 0.5 };
    const TAGS = [['RD', 0.1], ['SR', 0.24], ['ED', 0.4], ['SH', 0.56], ['WB', 0.7], ['AG', 0.82], ['PL', 0.93]];
    const rows = Array.from({ length: ROWS }, () => new Float32Array(COLS));
    let current = new Float32Array(COLS);
    let cv, g, w = 0, h = 0;
    let sliceStart = 0;

    function init(canvas) {
      cv = canvas;
    }

    function resize() {
      ({ g, w, h } = fitCanvas(cv));
    }

    /** A real tool call of this kind happened. */
    function add(cat, weight) {
      const centre = (LANES[cat] != null ? LANES[cat] : 0.5) * (COLS - 1);
      for (let c = 0; c < COLS; c++) {
        const d = (c - centre) / 1.5;
        current[c] += weight * Math.exp(-d * d);
      }
    }

    function frame(now) {
      if (w < 20 || h < 20) return;
      if (!sliceStart) sliceStart = now;
      while (now - sliceStart >= SLICE) {
        sliceStart += SLICE;
        rows.pop();
        rows.unshift(current);
        current = new Float32Array(COLS);
      }
      const phase = reduced ? 0 : (now - sliceStart) / SLICE;

      g.clearRect(0, 0, w, h);
      g.lineWidth = 0.9;
      const floor = h - 16;
      const top = 10;
      // far ridges first so nearer ones cover them
      for (let r = ROWS - 1; r >= -1; r--) {
        const data = r < 0 ? current : rows[r];
        const t = Math.min(1, (r + 1 + phase) / ROWS); // 0 front .. 1 back
        const width = w * (0.94 - 0.5 * t);
        const x0 = (w - width) / 2 + t * w * 0.06;
        const y0 = floor - (floor - top) * Math.pow(t, 0.82);
        const amp = h * 0.34 * (1 - 0.6 * t) * (r < 0 ? phase : 1);

        g.beginPath();
        g.moveTo(x0, y0);
        for (let c = 0; c < COLS; c++) {
          const shimmer = 0.012 * Math.sin(c * 0.9 + now * 0.002 + r);
          const v = 1 - Math.exp(-data[c] / 2.2) + shimmer;
          g.lineTo(x0 + (c / (COLS - 1)) * width, y0 - Math.max(0, v) * amp);
        }
        g.lineTo(x0 + width, y0);
        g.fillStyle = theme.bg;
        g.fill();
        g.strokeStyle = `rgba(${r <= 0 ? theme.hot : theme.ink},${0.95 - 0.78 * t})`;
        g.stroke();
      }

      g.font = `8px ${theme.font}`;
      g.fillStyle = `rgba(${theme.ink},0.6)`;
      g.textAlign = 'center';
      for (const [tag, x] of TAGS) g.fillText(tag, w * 0.03 + x * w * 0.94, h - 4);
      g.textAlign = 'left';
    }

    return { init, resize, add, frame };
  })();

  return { Core, Terrain, setTheme };
})();
