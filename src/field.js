'use strict';
/*
 * The generative field behind the panels: thin threads converging on the
 * terminal from the left, rays streaming out of it to the right, particles
 * riding the threads. Ambient when idle; every real event from the session
 * (tool call, edit, prompt) raises `energy`, which fattens and speeds it up.
 */
const Field = (() => {
  let cv, ctx;
  let W = 0;
  let H = 0;
  let box = null; // terminal rect, in canvas coordinates
  let threads = [];
  let rays = [];
  let rings = [];
  let parts = [];
  let arc = null;
  let energy = 0;
  let frameNo = 0;
  let lastNow = 0;
  // pointer position, -1..1, and its smoothed copy: threads shift with depth (parallax)
  let mouseX = 0;
  let mouseY = 0;
  let camX = 0;
  let camY = 0;
  let ink = '225,225,225';
  let hot = '255,255,255';
  let blend = 'lighter';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  function init(canvas) {
    cv = canvas;
    ctx = cv.getContext('2d');
    setTheme();
    window.addEventListener('mousemove', (e) => {
      mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      mouseY = (e.clientY / window.innerHeight) * 2 - 1;
    });
    requestAnimationFrame(frame);
  }

  function setTheme() {
    const cs = getComputedStyle(document.body);
    ink = cs.getPropertyValue('--ink').trim() || ink;
    hot = cs.getPropertyValue('--ink-hot').trim() || hot;
    blend = cs.getPropertyValue('--blend').trim() || 'lighter';
  }

  /** @param {{x:number,y:number,w:number,h:number}} termBox relative to the canvas */
  function layout(termBox) {
    const r = cv.getBoundingClientRect();
    const same = (a, b) => Math.abs(a - b) < 0.75;
    // Called on every panel resize, most of which do not move the centre: keep
    // the field as it is unless its own size or the box it wraps really changed.
    if (box && same(r.width, W) && same(r.height, H) && same(termBox.x, box.x) && same(termBox.y, box.y) && same(termBox.w, box.w) && same(termBox.h, box.h)) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    box = termBox;
    build();
  }

  function build() {
    threads = [];
    rays = [];
    rings = [];
    parts = [];
    if (!box || W < 50 || H < 50) return;

    // Threads: born across the left side (a few from above and below), all
    // landing on the terminal's left edge.
    const n = Math.round(Math.min(620, Math.max(220, (W * H) / 2000)));
    for (let i = 0; i < n; i++) {
      const fromEdge = Math.random() < 0.18;
      const ax = fromEdge ? rand(box.x * 0.2, box.x + box.w * 0.5) : rand(-30, box.x * 0.92);
      const ay = fromEdge ? (Math.random() < 0.5 ? -24 : H + 24) : rand(-20, H + 20);
      const tx = box.x;
      const ty = box.y + rand(10, box.h - 10);
      threads.push({
        ax, ay, tx, ty,
        c1x: ax + (tx - ax) * rand(0.25, 0.6),
        c1y: ay + rand(-0.3, 0.3) * H,
        c2x: ax + (tx - ax) * rand(0.62, 0.97),
        c2y: ty + rand(-110, 110),
        ph: rand(0, 6.283),
        sp: rand(0.12, 0.55),
        amp: rand(8, 46),
        tier: Math.random() < 0.07 ? 3 : Math.floor(rand(0, 3)),
        z: rand(0.2, 1), // depth: near threads move more with the pointer
      });
    }

    // Rays: near-horizontal streaks leaving the terminal's right edge, fanning
    // slightly away from its centre line.
    const m = Math.round(Math.min(340, Math.max(80, box.h / 1.9)));
    for (let i = 0; i < m; i++) {
      const y = box.y + rand(4, box.h - 4);
      const band = Math.random() < 0.12; // a few thick, bright bands among the hairlines
      rays.push({
        y,
        slope: ((y - (box.y + box.h / 2)) / box.h) * rand(0.05, 0.42),
        len: rand(0.15, 1),
        a: band ? rand(0.3, 0.6) : rand(0.1, 0.42),
        w: band ? rand(1.4, 2.6) : 0.7,
        ph: rand(0, 6.283),
        sp: rand(0.3, 1.4),
      });
    }

    // A big arc sweeping through the left side, with instrument rings on it.
    arc = { cx: box.x - H * 0.25, cy: H * 0.5, r: H * 0.62 };
    for (let i = 0; i < 16; i++) {
      rings.push({ ang: rand(2.2, 4.1), r: rand(1.6, 4.2), off: rand(-26, 26), ph: rand(0, 6.283) });
    }
    for (let i = 0; i < 46; i++) spawn(false);
  }

  function spawn(isHot) {
    if (!threads.length) return;
    parts.push({
      th: threads[(Math.random() * threads.length) | 0],
      u: isHot ? rand(0, 0.35) : Math.random(),
      sp: isHot ? rand(0.45, 1.1) : rand(0.04, 0.16),
      hot: isHot,
    });
  }

  /** A real session event happened: 0..1 intensity. */
  function burst(amount) {
    energy = Math.min(1, energy + (amount || 0.3));
    const k = Math.round(26 * (amount || 0.3) + 8);
    for (let i = 0; i < k && parts.length < 700; i++) spawn(true);
  }

  /** Terminal output is streaming: a light nudge. */
  function bump(amount) {
    energy = Math.min(1, energy + amount);
  }

  function wobble(th, t) {
    return Math.sin(t * th.sp + th.ph) * th.amp * (1 + energy * 0.9);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    frameNo++;
    if (!box || document.hidden) return;
    // Idle and unfocused: draw less often. Nobody is watching the threads.
    if (!document.hasFocus() && energy < 0.02 && frameNo % 4) return;
    if (lastNow && now - lastNow < 15) return; // ~60 fps is plenty, whatever the display
    const t = reduced ? 0 : now / 1000;
    // Real elapsed time, so the motion is the same speed on a 60 Hz and a 240 Hz display.
    const dt = reduced ? 0 : Math.min(0.05, (now - (lastNow || now)) / 1000);
    lastNow = now;

    if (!reduced) {
      camX += (mouseX - camX) * 0.05;
      camY += (mouseY - camY) * 0.05;
    }
    const shiftX = camX * 30;
    const shiftY = camY * 20;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = blend;
    ctx.lineWidth = 0.6;

    // threads, batched by brightness tier
    const alpha = [0.07, 0.12, 0.19];
    for (let tier = 0; tier < 4; tier++) {
      ctx.beginPath();
      for (const th of threads) {
        if (th.tier !== tier) continue;
        const w = wobble(th, t);
        const ox = shiftX * th.z;
        const oy = shiftY * th.z;
        ctx.moveTo(th.ax + ox * 1.3, th.ay + oy * 1.3);
        ctx.bezierCurveTo(th.c1x + ox, th.c1y + w + oy, th.c2x + ox * 0.4, th.c2y - w * 0.6 + oy * 0.4, th.tx, th.ty);
      }
      ctx.strokeStyle = tier === 3 ? `rgba(${hot},${0.3 + energy * 0.5})` : `rgba(${ink},${alpha[tier] * (1 + energy * 1.3)})`;
      ctx.lineWidth = tier === 3 ? 0.9 : 0.6;
      ctx.stroke();
    }

    // arc + rings
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = `rgba(${ink},0.16)`;
    ctx.beginPath();
    ctx.arc(arc.cx + shiftX * 0.5, arc.cy + shiftY * 0.5, arc.r, 2.0, 4.3);
    ctx.stroke();
    // two inner dials turning against each other
    ctx.setLineDash([3, 9]);
    ctx.lineDashOffset = -t * 16;
    ctx.beginPath();
    ctx.arc(arc.cx + shiftX * 0.5, arc.cy + shiftY * 0.5, arc.r * 0.86, 2.0, 4.3);
    ctx.stroke();
    ctx.setLineDash([1, 14]);
    ctx.lineDashOffset = t * 22;
    ctx.beginPath();
    ctx.arc(arc.cx + shiftX * 0.5, arc.cy + shiftY * 0.5, arc.r * 1.1, 2.0, 4.3);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(${ink},0.5)`;
    for (const g of rings) {
      const a = 2.2 + ((g.ang - 2.2 + t * 0.012 * (1 + energy * 6)) % 1.9); // drift along the arc
      const rr = arc.r + g.off;
      ctx.beginPath();
      ctx.arc(arc.cx + shiftX * 0.5 + Math.cos(a) * rr, arc.cy + shiftY * 0.5 + Math.sin(a) * rr, g.r, 0, 6.283);
      ctx.stroke();
    }

    // rays
    const right = box.x + box.w;
    const span = W - right;
    for (const r of rays) {
      const live = 0.55 + 0.45 * Math.sin(t * r.sp + r.ph);
      const len = Math.min(span, span * r.len * (0.45 + 0.55 * live) * (0.75 + energy * 0.6));
      ctx.lineWidth = r.w;
      ctx.strokeStyle = `rgba(${ink},${Math.min(0.9, r.a * (0.75 + energy))})`;
      ctx.beginPath();
      ctx.moveTo(right, r.y);
      ctx.lineTo(right + len, r.y + len * r.slope);
      ctx.stroke();
    }

    // particles riding the threads toward the terminal
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.u += p.sp * dt * (1 + energy * 1.5);
      if (p.u >= 1) {
        if (p.hot) {
          parts.splice(i, 1);
          continue;
        }
        p.u = 0;
        p.th = threads[(Math.random() * threads.length) | 0];
      }
      const th = p.th;
      const w = wobble(th, t);
      const u = p.u;
      const v = 1 - u;
      const ox = shiftX * th.z;
      const oy = shiftY * th.z;
      const x = v * v * v * (th.ax + ox * 1.3) + 3 * v * v * u * (th.c1x + ox) + 3 * v * u * u * (th.c2x + ox * 0.4) + u * u * u * th.tx;
      const y = v * v * v * (th.ay + oy * 1.3) + 3 * v * v * u * (th.c1y + w + oy) + 3 * v * u * u * (th.c2y - w * 0.6 + oy * 0.4) + u * u * u * th.ty;
      if (p.hot) {
        ctx.fillStyle = `rgba(${hot},0.95)`;
        ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
      } else {
        ctx.fillStyle = `rgba(${ink},0.55)`;
        ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
      }
    }

    energy *= Math.pow(0.43, dt);
    if (energy < 0.001) energy = 0;
  }

  return { init, layout, setTheme, burst, bump, get frame() { return frameNo; } };
})();
