'use strict';
/* global Scenes3D */
/*
 * GALAXY — the whole repo as a spiral galaxy.
 *
 * Every file is a star (up to 3000 from a deep scan); each top-level folder is
 * a spiral arm; files of the same folder sit together and are joined by a thin
 * filament. The agent is the bright core. When it really reads or edits a file,
 * a comet flies from the core to that star, the star flares and stays lit, and
 * a constellation line traces the path the agent took from file to file. A new
 * prompt sends a shockwave through the disc. Click a star to @mention the file.
 *
 * The haze and the far background stars are decoration; the stars are data.
 */
const Galaxy = (() => {
  const R = 142;
  const TAU = 6.2832;
  const TWIST = 3.1; // how far an arm winds, in radians
  const { makeStage, theme } = Scenes3D;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let st;
  let onPick = () => {};
  let stars = [];
  let byPath = new Map();
  let arms = [];
  let filaments = [];
  let dust = null;
  let clouds = [];
  let far = null;
  let armCount = 0;
  const stats = new Map(); // path -> what the agent did to the file
  let trail = []; // stars in the order the agent visited them
  let comets = [];
  let flares = [];
  let agents = [];
  let warpAt = -1e9;
  let energy = 0;
  let last = 0;

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Seeded generator: a file always lands on the same spot of its arm. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const gauss = (r) => (r() + r() + r() + r() - 2) * 0.87;
  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  function init(canvas, tip, opts) {
    st = makeStage(canvas, tip, { yaw: 0.5, pitch: 0.98, minPitch: 0.06, maxPitch: 1.5, spin: 0.0011, centerY: 0.5 });
    onPick = (opts && opts.onPick) || onPick;
    st.bind(pick, describe, (s) => onPick({ path: s.path }));
    armCount = 2;
    makeHaze(armCount); // something to draw before the first scan lands
  }

  /* ---------- layout ---------- */

  function setTree(_name, items) {
    const groups = new Map();
    for (const f of items) {
      if (f.d) continue;
      const cut = f.p.indexOf('/');
      const top = cut < 0 ? '' : f.p.slice(0, cut);
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(f);
    }
    let bulge = groups.get('') || []; // files at the root live in the central bulge
    groups.delete('');
    let list = [...groups.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files.length - a.files.length);
    if (list.length > 6) {
      // more folders than arms: the small ones join the last arms
      list.splice(6).forEach((extra, i) => {
        const host = list[5 - (i % 3)];
        host.files.push(...extra.files);
        host.more = (host.more || 0) + 1;
      });
    }
    if (list.length === 1) {
      const all = list[0].files;
      const half = Math.ceil(all.length / 2);
      list = [{ name: list[0].name, files: all.slice(0, half) }, { name: '', files: all.slice(half) }];
    }
    if (list.length === 0) {
      list = [{ name: '', files: bulge.filter((_, i) => i % 2 === 0) }, { name: '', files: bulge.filter((_, i) => i % 2 === 1) }];
      bulge = [];
    }
    const A = list.length;

    stars = [];
    byPath = new Map();
    arms = [];
    filaments = [];
    const add = (f, x, y, z) => {
      const s = {
        path: f.p,
        name: f.p.slice(f.p.lastIndexOf('/') + 1),
        size: f.s || 0,
        x, y, z,
        r: 0.9 + Math.min(2.4, Math.log10(1 + (f.s || 0) / 500) * 0.75),
        tw: ((hash(f.p) % 1000) / 1000) * TAU,
        sx: 0, sy: 0, k: 1,
      };
      stars.push(s);
      byPath.set(f.p, s);
      return s;
    };

    for (const f of bulge) {
      const r = rng(hash(f.p));
      const rad = 4 + Math.abs(gauss(r)) * 16;
      const a = r() * TAU;
      add(f, Math.cos(a) * rad, gauss(r) * 7, Math.sin(a) * rad);
    }

    list.forEach((arm, k) => {
      const phi = (k / A) * TAU;
      arm.files.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)); // same folder = neighbours on the arm
      const n = arm.files.length;
      let prev = null;
      let prevDir = null;
      arm.files.forEach((f, i) => {
        const r = rng(hash(f.p));
        const u = 0.08 + 0.92 * Math.pow((i + 0.5) / n, 0.85); // 0 at the core, 1 at the tip
        const dir = f.p.slice(0, f.p.lastIndexOf('/'));
        const clump = rng(hash(dir)); // one offset per folder: its files form a clump
        const lateral = (clump() - 0.5) * 20 * (0.5 + u) + gauss(r) * 6 * (0.6 + u);
        const rad = 18 + u * 118 + lateral;
        const th = phi + u * TWIST + gauss(r) * 0.03;
        const y = (clump() - 0.5) * 7 + gauss(r) * 3 * (1 - u * 0.5);
        const s = add(f, Math.cos(th) * rad, y, Math.sin(th) * rad);
        if (prev && prevDir === dir) filaments.push(prev, s);
        prev = s;
        prevDir = dir;
      });
      const tip = 18 + 1.08 * 118;
      arms.push({
        name: arm.name + (arm.more ? ` +${arm.more}` : ''),
        x: Math.cos(phi + TWIST * 1.08) * tip,
        z: Math.sin(phi + TWIST * 1.08) * tip,
        n,
      });
    });

    // the layout was rebuilt: re-attach the agent's path to the new star objects
    trail = trail.map((t) => ({ t: t.t, star: byPath.get(t.star.path) })).filter((t) => t.star);
    comets = [];
    flares = [];
    if (A !== armCount || !dust) {
      armCount = A;
      makeHaze(A);
    }
  }

  /** Decoration only: a haze following the arms, a bulge, and far background stars. */
  function makeHaze(A) {
    const r = rng(20261112);
    // Three brightness tiers, each drawn in one pass (one alpha change per tier, not per particle).
    const tiers = [[], [], []];
    const N = 6400;
    for (let i = 0; i < N; i++) {
      const roll = r();
      let x, y, z, tier;
      if (roll < 0.2) {
        // the bulge
        const rad = Math.abs(gauss(r)) * 21;
        const an = r() * TAU;
        x = Math.cos(an) * rad;
        z = Math.sin(an) * rad;
        y = gauss(r) * 9 * Math.exp(-rad / 30);
        tier = rad < 12 ? 2 : 1;
      } else if (roll < 0.92) {
        // the arms: dense along the centre line, thinning outwards
        const k = Math.floor(r() * A);
        const u = Math.pow(r(), 0.75);
        const rad = 15 + u * 128 + gauss(r) * 8 * (0.5 + u);
        const th = (k / A) * TAU + u * TWIST + gauss(r) * 0.07;
        x = Math.cos(th) * rad;
        z = Math.sin(th) * rad;
        y = gauss(r) * 4 * (1 - u * 0.5);
        tier = r() < 0.22 - u * 0.1 ? 2 : r() < 0.5 ? 1 : 0;
      } else {
        // a thin scatter between the arms
        const rad = 20 + r() * 125;
        const an = r() * TAU;
        x = Math.cos(an) * rad;
        z = Math.sin(an) * rad;
        y = gauss(r) * 5;
        tier = 0;
      }
      tiers[tier].push(x, y, z);
    }
    dust = tiers.map((t) => new Float32Array(t));

    // soft clouds strung along each arm
    clouds = [];
    for (let k = 0; k < A; k++) {
      for (let j = 1; j <= 6; j++) {
        const u = j / 6.4 + (r() - 0.5) * 0.08;
        const rad = 15 + u * 128;
        const th = (k / A) * TAU + u * TWIST;
        clouds.push({ x: Math.cos(th) * rad, z: Math.sin(th) * rad, size: 20 + r() * 16 - u * 6, a: 0.085 - u * 0.03 });
      }
    }
    const F = 240;
    far = new Float32Array(F * 3);
    for (let i = 0; i < F; i++) {
      const a = r() * TAU;
      const b = Math.acos(2 * r() - 1);
      far.set([Math.sin(b) * Math.cos(a) * 380, Math.cos(b) * 380, Math.sin(b) * Math.sin(a) * 380], i * 3);
    }
  }

  /* ---------- session events ---------- */

  function touch(path, info) {
    const s = stats.get(path) || { reads: 0, edits: 0, add: 0, del: 0, at: -1e9 };
    if (info.edit) {
      s.edits++;
      s.add += info.add || 0;
      s.del += info.del || 0;
    } else s.reads++;
    stats.set(path, s);
    const star = byPath.get(path);
    if (!star || info.quiet) return;
    const now = performance.now();
    s.at = now;
    comets.push({ to: star, t: now, edit: !!info.edit, landed: false });
    if (!trail.length || trail[trail.length - 1].star !== star) {
      trail.push({ star, t: now });
      if (trail.length > 36) trail.shift();
    }
    energy = Math.min(1, energy + 0.3);
  }

  /** A new prompt: a shockwave runs through the disc. */
  function warp() {
    warpAt = performance.now();
    energy = 1;
  }

  function setAgents(list) {
    agents = list || [];
  }

  function clear() {
    stats.clear();
    trail = [];
    comets = [];
    flares = [];
  }

  /* ---------- drawing ---------- */

  function frame(now) {
    if (!st.W || !dust) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    st.begin(R);
    const g = st.g;
    const P = st.project;
    const t = now / 1000;
    const ink = `rgb(${theme.ink})`;
    const hot = `rgb(${theme.hot})`;
    const core = P(0, 0, 0);

    // far background stars (only the ones behind the disc)
    g.fillStyle = ink;
    for (let i = 0; i < far.length; i += 3) {
      const p = P(far[i], far[i + 1], far[i + 2]);
      if (p[3] < 60) continue;
      g.globalAlpha = 0.16 + 0.3 * (((i * 37) % 10) / 10);
      g.fillRect(p[0], p[1], 1.2, 1.2);
    }

    // core glow and haze add up where they overlap, like light does
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 1;
    const glow = 64 * st.scale * core[2] * (1 + energy * 0.3);
    const grad = g.createRadialGradient(core[0], core[1], 0, core[0], core[1], glow);
    grad.addColorStop(0, `rgba(${theme.hot},0.6)`);
    grad.addColorStop(0.22, `rgba(${theme.hot},0.17)`);
    grad.addColorStop(1, `rgba(${theme.hot},0)`);
    g.fillStyle = grad;
    g.fillRect(core[0] - glow, core[1] - glow, glow * 2, glow * 2);

    for (const c of clouds) {
      const p = P(c.x, 0, c.z);
      const rad = c.size * st.scale * p[2];
      const cg = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad);
      cg.addColorStop(0, `rgba(${theme.ink},${c.a * (1 + energy)})`);
      cg.addColorStop(1, `rgba(${theme.ink},0)`);
      g.fillStyle = cg;
      g.fillRect(p[0] - rad, p[1] - rad, rad * 2, rad * 2);
    }

    const lift = 1 + energy * 0.6;
    const px = Math.max(1.2, Math.min(2.6, st.scale * 0.55));
    for (let tier = 0; tier < 3; tier++) {
      const d = dust[tier];
      g.fillStyle = tier === 2 ? hot : ink;
      g.globalAlpha = Math.min(1, [0.2, 0.36, 0.62][tier] * lift);
      const size = px * (tier === 2 ? 1.25 : 1);
      for (let i = 0; i < d.length; i += 3) {
        const p = P(d[i], d[i + 1], d[i + 2]);
        g.fillRect(p[0], p[1], size, size);
      }
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    // range rings on the plane of the disc, like an instrument
    g.lineWidth = 0.6;
    for (let n = 1; n <= 3; n++) {
      const rr = n * 46;
      g.strokeStyle = `rgba(${theme.ink},${n === 3 ? 0.2 : 0.11})`;
      g.setLineDash(n === 3 ? [] : [2, 5]);
      g.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * TAU;
        const q = P(Math.cos(a) * rr, 0, Math.sin(a) * rr);
        if (i) g.lineTo(q[0], q[1]);
        else g.moveTo(q[0], q[1]);
      }
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = `rgba(${theme.ink},0.35)`;
    g.beginPath();
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * TAU;
      const long = i % 3 === 0;
      const q0 = P(Math.cos(a) * 138, 0, Math.sin(a) * 138);
      const q1 = P(Math.cos(a) * (long ? 146 : 142), 0, Math.sin(a) * (long ? 146 : 142));
      g.moveTo(q0[0], q0[1]);
      g.lineTo(q1[0], q1[1]);
    }
    g.stroke();

    for (const s of stars) {
      const p = P(s.x, s.y, s.z);
      s.sx = p[0];
      s.sy = p[1];
      s.k = p[2];
    }

    // filaments between files of the same folder
    g.strokeStyle = `rgba(${theme.ink},0.13)`;
    g.lineWidth = 0.5;
    g.beginPath();
    for (let i = 0; i < filaments.length; i += 2) {
      g.moveTo(filaments[i].sx, filaments[i].sy);
      g.lineTo(filaments[i + 1].sx, filaments[i + 1].sy);
    }
    g.stroke();

    // stars: the unvisited ones first, then the ones the agent touched
    const zoomBoost = Math.min(2.2, 0.75 + st.zoom * 0.25);
    const visited = [];
    g.fillStyle = ink;
    for (const s of stars) {
      const info = stats.get(s.path);
      if (info) {
        visited.push([s, info]);
        continue;
      }
      const tw = reduced ? 1 : 0.75 + 0.25 * Math.sin(t * 1.7 + s.tw);
      const size = s.r * s.k * zoomBoost * 1.45;
      g.globalAlpha = Math.min(1, tw * (0.62 + 0.38 * s.k));
      g.fillRect(s.sx - size / 2, s.sy - size / 2, size, size);
      if (s.r > 2.4) {
        // the biggest files get a four-point sparkle
        const arm = size * 2.2 * tw;
        g.fillRect(s.sx - arm, s.sy - 0.35, arm * 2, 0.7);
        g.fillRect(s.sx - 0.35, s.sy - arm, 0.7, arm * 2);
      }
    }
    g.globalAlpha = 1;
    for (const [s, info] of visited) {
      const size = s.r * s.k * zoomBoost * 1.8;
      g.fillStyle = info.edits ? theme.ok : hot;
      g.fillRect(s.sx - size / 2, s.sy - size / 2, size, size);
      g.strokeStyle = info.edits ? theme.ok : `rgba(${theme.hot},0.7)`;
      g.lineWidth = 0.8;
      g.beginPath();
      g.arc(s.sx, s.sy, size / 2 + 3.5, 0, TAU);
      g.stroke();
    }

    // the shockwave of a new prompt: every star streaks away from the core
    const since = now - warpAt;
    if (since < 700 && !reduced) {
      const u = since / 700;
      g.strokeStyle = `rgba(${theme.hot},${0.55 * (1 - u)})`;
      g.lineWidth = 0.8;
      g.beginPath();
      for (const s of stars) {
        const dx = s.sx - core[0];
        const dy = s.sy - core[1];
        const d = Math.hypot(dx, dy) || 1;
        const len = (1 - u) * 22 * s.k;
        g.moveTo(s.sx, s.sy);
        g.lineTo(s.sx + (dx / d) * len, s.sy + (dy / d) * len);
      }
      g.stroke();
      g.strokeStyle = `rgba(${theme.hot},${0.8 * (1 - u)})`;
      g.lineWidth = 1.4;
      g.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * TAU;
        const q = P(Math.cos(a) * 150 * u, 0, Math.sin(a) * 150 * u);
        if (i) g.lineTo(q[0], q[1]);
        else g.moveTo(q[0], q[1]);
      }
      g.stroke();
    }

    // the agent's path, star to star
    g.lineWidth = 0.7;
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1].star;
      const b = trail[i].star;
      const age = (now - trail[i].t) / 1000;
      g.strokeStyle = `rgba(${theme.hot},${clamp(0.6 - age / 60, 0.12, 0.6)})`;
      g.beginPath();
      g.moveTo(a.sx, a.sy);
      g.lineTo(b.sx, b.sy);
      g.stroke();
    }

    // comets: core -> the file being touched, arcing above the disc
    comets = comets.filter((c) => now - c.t < 900);
    for (const c of comets) {
      const u = (now - c.t) / 900;
      const e = u * u * (3 - 2 * u);
      const S = c.to;
      const at = (v) => {
        const w = 1 - v;
        return P(2 * w * v * (S.x / 2) + v * v * S.x, 2 * w * v * -38 + v * v * S.y, 2 * w * v * (S.z / 2) + v * v * S.z);
      };
      g.lineWidth = 1.5;
      for (let j = 0; j < 12; j++) {
        const v0 = e - j * 0.035;
        const v1 = e - (j + 1) * 0.035;
        if (v1 < 0) break;
        const p0 = at(v0);
        const p1 = at(v1);
        g.strokeStyle = c.edit ? theme.ok : hot;
        g.globalAlpha = 1 - j / 12;
        g.beginPath();
        g.moveTo(p0[0], p0[1]);
        g.lineTo(p1[0], p1[1]);
        g.stroke();
      }
      g.globalAlpha = 1;
      const head = at(e);
      g.fillStyle = hot;
      g.fillRect(head[0] - 2, head[1] - 2, 4, 4);
      if (u > 0.94 && !c.landed) {
        c.landed = true;
        flares.push({ star: S, t: now, edit: c.edit });
      }
    }

    // the star flares when the comet lands
    flares = flares.filter((f) => now - f.t < 900);
    for (const f of flares) {
      const u = (now - f.t) / 900;
      g.strokeStyle = f.edit ? theme.ok : hot;
      g.globalAlpha = 1 - u;
      g.lineWidth = 1.3;
      g.beginPath();
      g.arc(f.star.sx, f.star.sy, 4 + u * 30, 0, TAU);
      g.stroke();
    }
    g.globalAlpha = 1;

    // the core: the agent
    const beat = reduced ? 1 : 1 + 0.2 * Math.sin(now / 420);
    g.strokeStyle = hot;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * TAU + t * 0.6;
      const q = P(Math.cos(a) * 9 * beat, 0, Math.sin(a) * 9 * beat);
      if (i) g.lineTo(q[0], q[1]);
      else g.moveTo(q[0], q[1]);
    }
    g.stroke();
    g.fillStyle = hot;
    g.beginPath();
    g.arc(core[0], core[1], 3.2 * core[2] * (1 + energy * 0.6), 0, TAU);
    g.fill();

    // subagents orbit the core
    g.font = `9px ${theme.font}`;
    agents.forEach((a, j) => {
      const ang = j * 2.1 + (a.state === 'working' && !reduced ? t * 0.9 : 0);
      const q = P(Math.cos(ang) * 26, Math.sin(ang * 1.3) * 5, Math.sin(ang) * 26);
      const r = 4 * q[2];
      g.strokeStyle = a.state === 'failed' ? theme.err : a.state === 'done' ? theme.ok : theme.warn;
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(q[0], q[1] - r);
      g.lineTo(q[0] + r, q[1]);
      g.lineTo(q[0], q[1] + r);
      g.lineTo(q[0] - r, q[1]);
      g.closePath();
      g.stroke();
    });

    // labels: the arms, what was just touched, what is under the pointer
    g.textBaseline = 'middle';
    g.fillStyle = `rgba(${theme.ink},0.6)`;
    for (const arm of arms) {
      if (!arm.name) continue;
      const q = P(arm.x, 0, arm.z);
      g.fillText(`${arm.name.toUpperCase().slice(0, 18)} · ${arm.n}`, q[0] + 5, q[1]);
    }
    g.fillStyle = `rgba(${theme.hot},0.95)`;
    g.fillText('AGENT', core[0] + 14, core[1] - 12);
    let shown = 0;
    for (let i = trail.length - 1; i >= 0 && shown < 7; i--) {
      const s = trail[i].star;
      if (now - trail[i].t > 14000 || s === st.hover) continue;
      shown++;
      const info = stats.get(s.path);
      g.fillText(info && info.edits ? `${s.name}  +${info.add} −${info.del}` : s.name, s.sx + 9, s.sy);
    }
    if (st.hover) {
      const s = st.hover;
      g.strokeStyle = hot;
      g.lineWidth = 1;
      g.strokeRect(s.sx - 7, s.sy - 7, 14, 14);
      g.fillText(s.name, s.sx + 11, s.sy);
    }
    g.textBaseline = 'alphabetic';

    st.hud('DRAG = ORBIT · WHEEL = ZOOM · CLICK A STAR = @MENTION', 'STAR = FILE · ARM = FOLDER · HAZE = DECORATION');
    energy *= Math.pow(0.4, dt);
  }

  /* ---------- interaction ---------- */

  function pick(x, y) {
    let best = null;
    let bd = 9;
    for (const s of stars) {
      const d = Math.hypot(s.sx - x, s.sy - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  function describe(s) {
    const info = stats.get(s.path);
    const lines = [s.path, fmtSize(s.size)];
    if (info) lines.push(`READ ×${info.reads} · EDIT ×${info.edits} · +${info.add} −${info.del}`);
    lines.push('CLICK → @MENTION IN PROMPT');
    return lines;
  }

  return {
    init, setTree, touch, warp, setAgents, clear, frame,
    resize: () => st.resize(),
    get count() { return stars.length; },
    get arms() { return arms.filter((a) => a.name).length; },
  };
})();
