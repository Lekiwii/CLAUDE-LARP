'use strict';
/*
 * The repo as a 3D force-directed graph, in the spirit of Obsidian's graph view.
 *
 * Nodes are the folders and files of the project (a bounded scan), plus the
 * agent. Every file the agent really reads or edits gets a live link from the
 * agent, a pulse, and grows with the number of edits. Drag the background to
 * orbit, drag a node to move it, wheel to zoom, click a node to @mention it in
 * the prompt.
 */
const Graph3D = (() => {
  const REPULSE = 260;
  const CUTOFF2 = 150 * 150;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const jitter = () => (Math.random() - 0.5) * 22;

  let cv, ctx, wrap, tip;
  let onPick = () => {};
  let W = 0;
  let H = 0;
  let nodes = [];
  let edges = [];
  const byId = new Map();
  const linked = new Set();
  let root = null;
  let agent = null;

  // camera
  let yaw = 0.7;
  let pitch = -0.32;
  let zoom = 1;
  let zoomTo = 1;
  let radius = 120;
  let scale = 1;
  let cam = 400;
  let cy = 1, sy = 0, cp = 1, sp = 0;

  // simulation + interaction
  let heat = 1;
  let hover = null;
  let grabbed = null;
  let orbiting = false;
  let travelled = 0;
  let px = 0;
  let py = 0;
  let lastInput = 0;
  let pulses = [];
  let packets = [];
  let touchSeq = 0;

  let ink = '225,225,225';
  let hot = '255,255,255';
  let ok = '#8fd18a';
  let warn = '#e8b23a';
  let err = '#e0544e';
  let font = 'monospace';

  /* ---------- model ---------- */

  function addNode(id, label, kind, parent) {
    let n = byId.get(id);
    if (n) return n;
    const p = parent || { x: 0, y: 0, z: 0 };
    n = {
      id, label, kind, parent: parent || null,
      x: p.x + jitter(), y: p.y + jitter(), z: p.z + jitter(),
      vx: 0, vy: 0, vz: 0,
      reads: 0, edits: 0, add: 0, del: 0, seen: 0, state: null,
      sx: 0, sy: 0, ss: 1, links: [],
    };
    // colour-coded themes: everything under one top-level folder shares that folder's colour
    if (kind === 'file' || kind === 'dir') {
      if (parent === root) {
        let sum = 0;
        for (let i = 0; i < label.length; i++) sum += label.charCodeAt(i);
        n.hue = (sum % 8) / 7;
      } else n.hue = parent ? parent.hue : null;
    }
    nodes.push(n);
    byId.set(id, n);
    if (parent) link(parent, n, 'tree');
    heat = Math.max(heat, 0.6);
    return n;
  }

  function link(a, b, kind) {
    const key = a.id + '\n' + b.id;
    if (linked.has(key)) return a.links.find((e) => e.b === b || e.a === b);
    linked.add(key);
    const e = { a, b, kind, hotAt: -1e9 };
    edges.push(e);
    a.links.push(e);
    b.links.push(e);
    return e;
  }

  function clear() {
    nodes = [];
    edges = [];
    byId.clear();
    linked.clear();
    pulses = [];
    packets = [];
    root = agent = hover = grabbed = null;
    heat = 1;
  }

  /** Walk a relative path, creating the folders on the way. */
  function ensure(path, isDir) {
    const parts = String(path).split('/').filter(Boolean);
    let cur = root;
    let id = '';
    parts.forEach((part, i) => {
      id = id ? id + '/' + part : part;
      const last = i === parts.length - 1;
      cur = addNode(id, part, last && !isDir ? 'file' : 'dir', cur);
    });
    return cur;
  }

  /** (Re)load the folder map. Existing nodes keep their place and their history. */
  function setTree(name, items) {
    if (root && root.label !== name) clear();
    if (!root) {
      root = addNode('', name, 'root', null);
      root.x = root.y = root.z = 0;
      agent = addNode('@agent', 'AGENT', 'agent', null);
      link(agent, root, 'link');
    }
    for (const it of items) ensure(it.p, it.d);
  }

  /** The agent really read or edited this file. */
  function touch(path, info) {
    if (!root) return;
    const n = ensure(path, false);
    if (n === root) return;
    if (info.edit) {
      n.edits++;
      n.add += info.add || 0;
      n.del += info.del || 0;
    } else n.reads++;
    n.seen = ++touchSeq;
    const now = performance.now();
    const e = link(agent, n, 'link');
    if (e) e.hotAt = now;
    if (!info.quiet) {
      pulses.push({ n, t: now, edit: !!info.edit });
      if (e) packets.push({ to: n, t: now });
    }
    heat = Math.max(heat, 0.3);
  }

  function sub(id, desc, state) {
    if (!agent) return;
    const n = addNode('sub:' + id, String(desc || 'subagent').slice(0, 26), 'sub', null);
    if (!n.state) {
      n.x = agent.x + jitter() * 2;
      n.y = agent.y + jitter() * 2;
      n.z = agent.z + jitter() * 2;
      link(agent, n, 'link').hotAt = performance.now();
    }
    n.state = state;
  }

  /* ---------- simulation ---------- */

  function simulate() {
    if (heat < 0.015) return;
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const d2 = dx * dx + dy * dy + dz * dz + 0.5;
        if (d2 > CUTOFF2) continue;
        const f = REPULSE / (d2 * Math.sqrt(d2));
        a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
        b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
      }
    }
    for (const e of edges) {
      const a = e.a;
      const b = e.b;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
      const rest = e.kind === 'tree' ? (b.kind === 'dir' ? 36 : 20) : 66;
      const f = ((d - rest) * (e.kind === 'tree' ? 0.05 : 0.008)) / d;
      a.vx += dx * f; a.vy += dy * f; a.vz += dz * f;
      b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
    }
    const step = Math.min(1, heat * 2);
    let far = 0;
    for (const a of nodes) {
      a.vx = clamp((a.vx - a.x * 0.004) * 0.82, -12, 12);
      a.vy = clamp((a.vy - a.y * 0.004) * 0.82, -12, 12);
      a.vz = clamp((a.vz - a.z * 0.004) * 0.82, -12, 12);
      if (a !== grabbed) {
        a.x += a.vx * step;
        a.y += a.vy * step;
        a.z += a.vz * step;
      }
      far = Math.max(far, a.x * a.x + a.y * a.y + a.z * a.z);
    }
    radius += (Math.max(60, Math.sqrt(far)) - radius) * 0.05;
    heat = grabbed ? Math.max(heat, 0.3) : heat * 0.993;
  }

  /* ---------- projection ---------- */

  function projectPoint(x, y, z) {
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const k = cam / (cam + z2);
    return [W / 2 + x1 * scale * k, H / 2 + y2 * scale * k, k];
  }

  /** The colour a node draws in: its folder's channel colour in a colour-coded theme, plain ink otherwise. */
  const tint = (n) => (Palette.on && n.hue != null ? Palette.rgb(n.hue) : ink);

  function nodeRadius(n) {
    if (n.kind === 'agent') return 7 * n.ss;
    if (n.kind === 'root') return 4.5 * n.ss;
    if (n.kind === 'dir') return 2.9 * n.ss;
    if (n.kind === 'sub') return 4 * n.ss;
    return (1.5 + Math.min(5, n.edits) * 0.55 + (n.reads ? 0.4 : 0)) * n.ss;
  }

  /* ---------- drawing ---------- */

  function gimbal() {
    const R = radius * 1.14;
    ctx.lineWidth = 0.6;
    for (let ring = 0; ring < 3; ring++) {
      ctx.beginPath();
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * 6.2832;
        const c = Math.cos(a) * R;
        const s = Math.sin(a) * R;
        const p = ring === 0 ? projectPoint(c, 0, s) : ring === 1 ? projectPoint(c, s, 0) : projectPoint(0, c, s);
        if (i) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
        if (i % 6 === 0) ctx.rect(p[0] - 1, p[1] - 1, 2, 2);
      }
      ctx.strokeStyle = `rgba(${ink},${ring === 0 ? 0.16 : 0.09})`;
      ctx.stroke();
    }
  }

  function frame(now) {
    if (!W || !root) return;
    simulate();

    const idle = now - lastInput > 2500 && !hover && !grabbed && !orbiting;
    if (idle && !reduced) yaw += 0.0022;
    zoom += (zoomTo - zoom) * 0.15;
    scale = ((Math.min(W, H) * 0.47) / radius) * zoom;
    cam = radius * 3.2;
    cy = Math.cos(yaw); sy = Math.sin(yaw); cp = Math.cos(pitch); sp = Math.sin(pitch);
    for (const n of nodes) {
      const p = projectPoint(n.x, n.y, n.z);
      n.sx = p[0];
      n.sy = p[1];
      n.ss = p[2];
    }

    ctx.clearRect(0, 0, W, H);
    gimbal();

    const near = new Set();
    if (hover) for (const e of hover.links) near.add(e.a === hover ? e.b : e.a);

    // links
    for (const e of edges) {
      const a = e.a;
      const b = e.b;
      const lit = hover && (a === hover || b === hover);
      const depth = clamp(((a.ss + b.ss) / 2 - 0.72) / 0.6, 0, 1);
      let al = e.kind === 'tree' ? 0.07 + 0.22 * depth : 0.2;
      const age = now - e.hotAt;
      if (e.kind === 'link' && age < 2600) al = 0.95 - 0.7 * (age / 2600);
      if (hover && !lit) al *= 0.35;
      if (e.kind === 'tree' && Palette.on) al = Math.min(1, al * 1.9);
      ctx.strokeStyle = lit ? `rgba(${hot},0.95)` : `rgba(${e.kind === 'link' ? hot : tint(b)},${al})`;
      ctx.lineWidth = lit ? 1.2 : e.kind === 'link' ? 0.9 : 0.6;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }

    // packets travelling agent -> file
    ctx.fillStyle = `rgb(${hot})`;
    packets = packets.filter((p) => now - p.t < 620);
    for (const p of packets) {
      const u = (now - p.t) / 620;
      const e = u * u * (3 - 2 * u);
      ctx.fillRect(agent.sx + (p.to.sx - agent.sx) * e - 1.5, agent.sy + (p.to.sy - agent.sy) * e - 1.5, 3, 3);
    }

    // nodes, far to near
    const order = nodes.slice().sort((a, b) => a.ss - b.ss);
    for (const n of order) {
      const dim = hover && n !== hover && !near.has(n) ? 0.3 : 1;
      const al = clamp(0.25 + 0.75 * ((n.ss - 0.72) / 0.6), 0.22, 1) * dim;
      const r = nodeRadius(n);
      const touched = n.reads + n.edits > 0;
      ctx.lineWidth = 1;
      if (n.kind === 'agent') {
        const beat = 1 + 0.18 * Math.sin(now / 420);
        ctx.strokeStyle = `rgba(${hot},${al})`;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, 6.2832); ctx.stroke();
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 1.7 * beat, 0, 6.2832);
        ctx.strokeStyle = `rgba(${hot},${al * 0.35})`; ctx.stroke();
        ctx.fillStyle = `rgba(${hot},${al})`;
        ctx.fillRect(n.sx - 1.5, n.sy - 1.5, 3, 3);
      } else if (n.kind === 'root') {
        ctx.strokeStyle = `rgba(${hot},${al})`;
        ctx.strokeRect(n.sx - r, n.sy - r, r * 2, r * 2);
      } else if (n.kind === 'dir') {
        ctx.strokeStyle = `rgba(${tint(n)},${al})`;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, 6.2832); ctx.stroke();
      } else if (n.kind === 'sub') {
        ctx.strokeStyle = n.state === 'failed' ? err : n.state === 'done' ? ok : warn;
        ctx.globalAlpha = al;
        ctx.beginPath();
        ctx.moveTo(n.sx, n.sy - r); ctx.lineTo(n.sx + r, n.sy); ctx.lineTo(n.sx, n.sy + r); ctx.lineTo(n.sx - r, n.sy);
        ctx.closePath(); ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = `rgba(${touched ? hot : tint(n)},${touched ? Math.max(al, 0.85 * dim) : al * (Palette.on ? 1 : 0.8)})`;
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, 6.2832); ctx.fill();
        if (n.edits) {
          ctx.strokeStyle = ok;
          ctx.globalAlpha = dim;
          ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 2.6, 0, 6.2832); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      if (n === hover) {
        ctx.strokeStyle = `rgb(${hot})`;
        ctx.strokeRect(n.sx - r - 5, n.sy - r - 5, (r + 5) * 2, (r + 5) * 2);
      }
    }

    // pulses on touched files
    pulses = pulses.filter((p) => now - p.t < 950);
    for (const p of pulses) {
      const u = (now - p.t) / 950;
      ctx.strokeStyle = p.edit ? ok : `rgb(${hot})`;
      ctx.globalAlpha = 1 - u;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.n.sx, p.n.sy, 4 + u * 26, 0, 6.2832);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    labels(near);
    hud();
  }

  function labels(near) {
    const want = [];
    if (hover) {
      want.push(hover);
      for (const n of near) want.push(n);
    }
    if (agent) want.push(agent);
    want.push(root);
    const recent = nodes.filter((n) => n.seen).sort((a, b) => b.seen - a.seen).slice(0, 12);
    for (const n of recent) want.push(n);
    for (const n of nodes) if (n.kind === 'sub') want.push(n);
    if (zoom > 1.3 || nodes.length < 70) for (const n of nodes) if (n.kind === 'dir' && n.parent === root) want.push(n);
    if (zoom > 2.2) for (const n of nodes) if (n.ss > 1.05) want.push(n);

    ctx.font = `9px ${font}`;
    ctx.textBaseline = 'middle';
    const taken = [];
    const seen = new Set();
    for (const n of want) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      const text = n.kind === 'file' && n.edits ? `${n.label}  +${n.add} −${n.del}` : n.label;
      const x = n.sx + nodeRadius(n) + 6;
      const y = n.sy;
      const w = ctx.measureText(text).width;
      if (n !== hover && taken.some((t) => Math.abs(t.y - y) < 10 && x < t.x + t.w + 4 && t.x < x + w + 4)) continue;
      taken.push({ x, y, w });
      const strong = n === hover || n.kind === 'agent' || n.seen;
      ctx.fillStyle = `rgba(${strong ? hot : ink},${strong ? 0.95 : 0.6})`;
      ctx.fillText(n.kind === 'file' ? text : text.toUpperCase(), x, y);
    }
  }

  function hud() {
    ctx.font = `9px ${font}`;
    ctx.fillStyle = `rgba(${ink},0.55)`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const help = W > 520 ? 'DRAG = ORBIT · DRAG NODE = MOVE · WHEEL = ZOOM · CLICK NODE = @MENTION' : W > 300 ? 'DRAG ORBIT · WHEEL ZOOM · CLICK = @MENTION' : 'DRAG · WHEEL · CLICK';
    ctx.fillText(help, 8, H - 8);
    ctx.textAlign = 'right';
    const deg = (r) => String(Math.round((((r * 57.2958) % 360) + 360) % 360)).padStart(3, '0');
    ctx.fillText(`YAW ${deg(yaw)}  PITCH ${deg(pitch)}  ZOOM ${zoom.toFixed(2)}`, W - 8, 14);
    ctx.textAlign = 'left';
  }

  /* ---------- interaction ---------- */

  function local(e) {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function pick(mx, my) {
    let best = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.sx - mx, n.sy - my);
      if (d > Math.max(9, nodeRadius(n) + 6)) continue;
      const score = d - n.ss * 4; // prefer what is in front
      if (score < bestD) {
        bestD = score;
        best = n;
      }
    }
    return best;
  }

  function showTip(n, mx, my) {
    if (!n) {
      tip.hidden = true;
      return;
    }
    const lines = [n.kind === 'agent' ? 'THE AGENT (CLAUDE CODE)' : n.kind === 'sub' ? `SUBAGENT · ${n.state || ''}` : n.id || n.label];
    if (n.kind === 'file' || n.kind === 'dir' || n.kind === 'root') {
      if (n.reads || n.edits) lines.push(`READ ×${n.reads} · EDIT ×${n.edits} · +${n.add} −${n.del}`);
      lines.push('CLICK → @MENTION IN PROMPT');
    }
    tip.textContent = lines.join('\n');
    tip.hidden = false;
    tip.style.left = Math.min(mx + 14, W - tip.offsetWidth - 6) + 'px';
    tip.style.top = Math.min(my + 14, H - tip.offsetHeight - 6) + 'px';
  }

  function bind() {
    cv.addEventListener('mousedown', (e) => {
      const [x, y] = local(e);
      px = x;
      py = y;
      travelled = 0;
      lastInput = performance.now();
      grabbed = pick(x, y);
      orbiting = !grabbed;
      tip.hidden = true;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!grabbed && !orbiting) {
        if (e.target === cv) {
          const [x, y] = local(e);
          hover = pick(x, y);
          cv.style.cursor = hover ? 'pointer' : 'grab';
          showTip(hover, x, y);
        }
        return;
      }
      const [x, y] = local(e);
      const dx = x - px;
      const dy = y - py;
      px = x;
      py = y;
      travelled += Math.abs(dx) + Math.abs(dy);
      lastInput = performance.now();
      if (grabbed) {
        // move the node in the plane facing the camera, at its own depth
        const k = 1 / (scale * grabbed.ss);
        const vx = dx * k;
        const vy = dy * k;
        const z1 = -vy * sp;
        grabbed.x += vx * cy - z1 * sy;
        grabbed.y += vy * cp;
        grabbed.z += vx * sy + z1 * cy;
        grabbed.vx = grabbed.vy = grabbed.vz = 0;
        heat = Math.max(heat, 0.35);
      } else {
        yaw -= dx * 0.008;
        pitch = clamp(pitch + dy * 0.008, -1.45, 1.45);
      }
    });

    window.addEventListener('mouseup', () => {
      if (grabbed && travelled < 4 && (grabbed.kind === 'file' || grabbed.kind === 'dir' || grabbed.kind === 'root')) {
        onPick({ path: grabbed.id, kind: grabbed.kind });
        pulses.push({ n: grabbed, t: performance.now(), edit: false });
      }
      grabbed = null;
      orbiting = false;
    });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomTo = clamp(zoomTo * (e.deltaY < 0 ? 1.12 : 0.89), 0.4, 6);
      lastInput = performance.now();
    }, { passive: false });

    cv.addEventListener('dblclick', () => {
      zoomTo = 1;
      pitch = -0.32;
    });

    cv.addEventListener('mouseleave', () => {
      if (grabbed) return;
      hover = null;
      tip.hidden = true;
    });
  }

  /* ---------- lifecycle ---------- */

  function init(canvas, tipEl, opts) {
    cv = canvas;
    ctx = cv.getContext('2d');
    wrap = cv.parentElement;
    tip = tipEl;
    onPick = (opts && opts.onPick) || onPick;
    setTheme();
    bind();
  }

  function setTheme() {
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    // The graph sits on the dark terminal surface in every theme.
    ink = v('--graph-ink', ink);
    hot = v('--graph-hot', hot);
    ok = v('--ok-on-dark', ok);
    warn = v('--warn-on-dark', warn);
    err = v('--err-on-dark', err);
    font = v('--mono', font);
  }

  function resize() {
    const r = wrap.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) {
      W = H = 0;
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw; // resizing wipes the canvas: only on a real change
      cv.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  return {
    init, setTheme, resize, frame, setTree, touch, sub, clear,
    get stats() {
      return { nodes: nodes.length, links: edges.length, touched: nodes.filter((n) => n.seen).length };
    },
  };
})();
