'use strict';
/*
 * Three more 3D scenes for the centre panel, next to the graph. All orbit with
 * a drag and zoom with the wheel; all are fed by the real session.
 *
 * City   — the repo as a city: one building per file (height = file size),
 *          folders as districts. Files the agent touches light up and fire a
 *          beam; a marker flies to the building it is working on. Click a
 *          building to @mention the file.
 * Helix  — the session as a spiral timeline, newest at the top: one node per
 *          prompt, reply and tool call, one lane per kind.
 * Orrery — tools as planets around the agent: size = calls so far, speed =
 *          recent activity, moons = calls running now, outer ring = context.
 */
const Scenes3D = (() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const TAU = 6.2832;
  const theme = { ink: '225,225,225', hot: '255,255,255', ok: '#8fd18a', warn: '#e8b23a', err: '#e0544e', bg: '#0a0a0a', font: 'monospace' };

  function setTheme() {
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    theme.ink = v('--graph-ink', theme.ink);
    theme.hot = v('--graph-hot', theme.hot);
    theme.ok = v('--ok-on-dark', theme.ok);
    theme.warn = v('--warn-on-dark', theme.warn);
    theme.err = v('--err-on-dark', theme.err);
    theme.bg = v('--term-bg', theme.bg);
    theme.font = v('--mono', theme.font);
  }

  /** Canvas + orbit camera + hover/click plumbing shared by the scenes. */
  function makeStage(cv, tip, o) {
    const s = {
      cv, g: cv.getContext('2d'), W: 0, H: 0,
      yaw: o.yaw, pitch: o.pitch, zoom: 1, zoomTo: 1,
      scale: 1, dist: 400, cy: 1, sy: 0, cp: 1, sp: 0,
      hover: null, drag: false, moved: 0, px: 0, py: 0, lastInput: 0,
    };

    s.resize = () => {
      const r = cv.parentElement.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) {
        s.W = s.H = 0;
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      s.W = r.width;
      s.H = r.height;
      const pw = Math.round(s.W * dpr);
      const ph = Math.round(s.H * dpr);
      if (cv.width !== pw || cv.height !== ph) {
        cv.width = pw; // resizing wipes the canvas: only on a real change
        cv.height = ph;
      }
      s.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /** Start a frame: advance the camera, clear. `radius` is what must fit. */
    s.begin = (radius) => {
      const idle = performance.now() - s.lastInput > 2500 && !s.hover && !s.drag;
      if (idle && !reduced) s.yaw += o.spin;
      s.zoom += (s.zoomTo - s.zoom) * 0.15;
      s.scale = ((Math.min(s.W, s.H) * 0.47) / radius) * s.zoom;
      s.dist = radius * 3.2;
      s.cy = Math.cos(s.yaw);
      s.sy = Math.sin(s.yaw);
      s.cp = Math.cos(s.pitch);
      s.sp = Math.sin(s.pitch);
      s.g.clearRect(0, 0, s.W, s.H);
    };

    /** World -> [screenX, screenY, perspective scale, depth (bigger = farther)]. */
    s.project = (x, y, z) => {
      const x1 = x * s.cy + z * s.sy;
      const z1 = -x * s.sy + z * s.cy;
      const y2 = y * s.cp - z1 * s.sp;
      const z2 = y * s.sp + z1 * s.cp;
      const k = s.dist / (s.dist + z2);
      return [s.W / 2 + x1 * s.scale * k, s.H * o.centerY + y2 * s.scale * k, k, z2];
    };

    s.tip = (lines, x, y) => {
      if (!lines) {
        tip.hidden = true;
        return;
      }
      tip.textContent = lines.join('\n');
      tip.hidden = false;
      tip.style.left = Math.max(4, Math.min(x + 14, s.W - tip.offsetWidth - 6)) + 'px';
      tip.style.top = Math.max(4, Math.min(y + 14, s.H - tip.offsetHeight - 6)) + 'px';
    };

    s.hud = (bottomLeft, topRight) => {
      const g = s.g;
      g.font = `9px ${theme.font}`;
      g.textBaseline = 'alphabetic';
      g.fillStyle = `rgba(${theme.ink},0.55)`;
      g.textAlign = 'left';
      g.fillText(s.W > 430 ? bottomLeft : 'DRAG · WHEEL', 8, s.H - 8);
      g.textAlign = 'right';
      if (s.W > 330) g.fillText(topRight, s.W - 8, 14);
      g.textAlign = 'left';
    };

    /** pick(x, y) -> thing under the pointer; describe(thing) -> tooltip lines. */
    s.bind = (pick, describe, click) => {
      const local = (e) => {
        const r = cv.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      cv.addEventListener('mousedown', (e) => {
        [s.px, s.py] = local(e);
        s.drag = true;
        s.moved = 0;
        s.lastInput = performance.now();
        tip.hidden = true;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!s.drag) {
          if (e.target !== cv) return;
          const [x, y] = local(e);
          s.hover = pick(x, y);
          cv.style.cursor = s.hover && click ? 'pointer' : 'grab';
          s.tip(s.hover ? describe(s.hover) : null, x, y);
          return;
        }
        const [x, y] = local(e);
        const dx = x - s.px;
        const dy = y - s.py;
        s.px = x;
        s.py = y;
        s.moved += Math.abs(dx) + Math.abs(dy);
        s.lastInput = performance.now();
        s.yaw -= dx * 0.008;
        s.pitch = clamp(s.pitch + dy * 0.008, o.minPitch, o.maxPitch);
      });
      window.addEventListener('mouseup', () => {
        if (s.drag && s.moved < 4 && s.hover && click) click(s.hover);
        s.drag = false;
      });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        s.zoomTo = clamp(s.zoomTo * (e.deltaY < 0 ? 1.12 : 0.89), 0.4, 6);
        s.lastInput = performance.now();
      }, { passive: false });
      cv.addEventListener('dblclick', () => {
        s.zoomTo = 1;
        s.pitch = o.pitch;
      });
      cv.addEventListener('mouseleave', () => {
        if (s.drag) return;
        s.hover = null;
        tip.hidden = true;
      });
    };
    return s;
  }

  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  function inPoly(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  /* ================= City ================= */

  const City = (() => {
    const R = 140;
    let st;
    let onPick = () => {};
    let buildings = [];
    let districts = [];
    let byPath = new Map();
    let order = [];
    const stats = new Map(); // path -> what the agent did to the file
    const drone = { x: 0, y: -70, z: 0, tx: 0, ty: -70, tz: 0, seen: false };

    function init(canvas, tip, opts) {
      st = makeStage(canvas, tip, { yaw: 0.65, pitch: 0.62, minPitch: 0.18, maxPitch: 1.4, spin: 0.0016, centerY: 0.56 });
      onPick = (opts && opts.onPick) || onPick;
      st.bind(pick, describe, (b) => onPick({ path: b.path }));
    }

    /** Treemap: split the items into two halves of similar weight, cut the lot along its long side, recurse. */
    function setTree(_name, items) {
      const root = { name: '', path: '', kids: new Map(), files: [], w: 0 };
      for (const it of items) {
        if (it.d) continue;
        const parts = it.p.split('/');
        let d = root;
        for (let i = 0; i < parts.length - 1; i++) {
          let k = d.kids.get(parts[i]);
          if (!k) {
            k = { name: parts[i], path: d.path ? d.path + '/' + parts[i] : parts[i], kids: new Map(), files: [], w: 0 };
            d.kids.set(parts[i], k);
          }
          d = k;
        }
        d.files.push({ path: it.p, name: parts[parts.length - 1], size: it.s || 0, w: 1 + Math.sqrt((it.s || 0) / 600) });
      }
      const weigh = (d) => {
        d.w = d.files.reduce((a, f) => a + f.w, 0);
        for (const k of d.kids.values()) d.w += weigh(k);
        return d.w;
      };
      weigh(root);

      buildings = [];
      districts = [];
      byPath = new Map();
      const place = (d, r, depth) => {
        const list = [
          ...d.files.map((f) => ({ f, w: f.w })),
          ...[...d.kids.values()].filter((k) => k.w > 0).map((k) => ({ d: k, w: k.w })),
        ].sort((a, b) => b.w - a.w);
        split(list, r, depth);
      };
      const split = (list, r, depth) => {
        if (!list.length) return;
        if (list.length === 1) {
          const it = list[0];
          if (it.f) {
            const gap = Math.min(1.6, r.w * 0.12, r.h * 0.12);
            const b = {
              path: it.f.path, name: it.f.name, size: it.f.size,
              x0: r.x + gap, z0: r.y + gap, x1: r.x + r.w - gap, z1: r.y + r.h - gap,
              h: 5 + 15 * Math.log10(1 + it.f.size / 300),
            };
            buildings.push(b);
            byPath.set(b.path, b);
          } else {
            districts.push({ name: it.d.name, depth, x0: r.x, z0: r.y, x1: r.x + r.w, z1: r.y + r.h });
            const pad = Math.min(2.2, r.w * 0.06, r.h * 0.06);
            place(it.d, { x: r.x + pad, y: r.y + pad, w: r.w - pad * 2, h: r.h - pad * 2 }, depth + 1);
          }
          return;
        }
        const total = list.reduce((a, i) => a + i.w, 0);
        let acc = 0;
        let cut = 0;
        while (cut < list.length - 1 && acc + list[cut].w <= total / 2) acc += list[cut++].w;
        if (cut === 0) {
          acc = list[0].w;
          cut = 1;
        }
        const ratio = acc / total;
        const a = list.slice(0, cut);
        const b = list.slice(cut);
        if (r.w >= r.h) {
          split(a, { x: r.x, y: r.y, w: r.w * ratio, h: r.h }, depth);
          split(b, { x: r.x + r.w * ratio, y: r.y, w: r.w * (1 - ratio), h: r.h }, depth);
        } else {
          split(a, { x: r.x, y: r.y, w: r.w, h: r.h * ratio }, depth);
          split(b, { x: r.x, y: r.y + r.h * ratio, w: r.w, h: r.h * (1 - ratio) }, depth);
        }
      };
      place(root, { x: -100, y: -100, w: 200, h: 200 }, 0);
    }

    function touch(path, info) {
      const s = stats.get(path) || { reads: 0, edits: 0, add: 0, del: 0, beam: -1e9 };
      if (info.edit) {
        s.edits++;
        s.add += info.add || 0;
        s.del += info.del || 0;
      } else s.reads++;
      if (!info.quiet) s.beam = performance.now();
      stats.set(path, s);
      const b = byPath.get(path);
      if (b) {
        drone.tx = (b.x0 + b.x1) / 2;
        drone.tz = (b.z0 + b.z1) / 2;
        drone.ty = -b.h - 16;
        drone.seen = true;
      }
    }

    function clear() {
      stats.clear();
      drone.seen = false;
    }

    function quad(pts, fill, stroke, width) {
      const g = st.g;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      if (fill) {
        g.fillStyle = fill;
        g.fill();
      }
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = width || 0.8;
        g.stroke();
      }
    }

    function frame(now) {
      if (!st.W) return;
      st.begin(R);
      const g = st.g;
      const P = st.project;

      // districts on the ground
      g.font = `8px ${theme.font}`;
      g.textAlign = 'center';
      for (const d of districts) {
        const c = [P(d.x0, 0, d.z0), P(d.x1, 0, d.z0), P(d.x1, 0, d.z1), P(d.x0, 0, d.z1)];
        quad(c, null, `rgba(${theme.ink},${d.depth === 0 ? 0.3 : 0.14})`, 0.7);
        if (d.depth === 0 && d.x1 - d.x0 > 26) {
          const m = P((d.x0 + d.x1) / 2, 0, (d.z0 + d.z1) / 2);
          g.fillStyle = `rgba(${theme.ink},0.4)`;
          g.fillText(d.name.toUpperCase().slice(0, 16), m[0], m[1]);
        }
      }
      g.textAlign = 'left';

      // which two walls face the camera (same for every box)
      const wallZ0 = st.cy > 0;
      const wallX1 = st.sy > 0;

      for (const b of buildings) {
        b.pp = [
          P(b.x0, 0, b.z0), P(b.x1, 0, b.z0), P(b.x1, 0, b.z1), P(b.x0, 0, b.z1),
          P(b.x0, -b.h, b.z0), P(b.x1, -b.h, b.z0), P(b.x1, -b.h, b.z1), P(b.x0, -b.h, b.z1),
        ];
        b.depth = (b.pp[0][3] + b.pp[2][3]) / 2;
        const p = b.pp;
        b.faces = [
          wallZ0 ? [p[0], p[1], p[5], p[4]] : [p[2], p[3], p[7], p[6]],
          wallX1 ? [p[1], p[2], p[6], p[5]] : [p[3], p[0], p[4], p[7]],
          [p[4], p[5], p[6], p[7]],
        ];
      }
      order = buildings.slice().sort((a, b) => b.depth - a.depth); // far first

      for (const b of order) {
        const k = (b.pp[4][2] + b.pp[6][2]) / 2;
        const al = clamp(0.3 + 0.7 * ((k - 0.72) / 0.6), 0.28, 1);
        const s = stats.get(b.path);
        const touched = s && s.reads + s.edits > 0;
        const lit = st.hover === b;
        const line = lit || touched ? `rgba(${theme.hot},${Math.max(al, 0.8)})` : `rgba(${theme.ink},${al * 0.7})`;
        quad(b.faces[0], theme.bg, line);
        quad(b.faces[1], theme.bg, line);
        quad(b.faces[2], theme.bg, line);
        if (touched || lit) {
          quad(b.faces[0], `rgba(${theme.hot},0.1)`);
          quad(b.faces[1], `rgba(${theme.hot},0.18)`);
          quad(b.faces[2], `rgba(${theme.hot},${lit ? 0.5 : 0.32})`);
        }
        if (s && s.edits) quad(b.faces[2], null, theme.ok, 1.3);
      }

      // beams on the files just touched
      for (const [path, s] of stats) {
        const age = now - s.beam;
        if (age > 1300) continue;
        const b = byPath.get(path);
        if (!b) continue;
        const u = age / 1300;
        const cx = (b.x0 + b.x1) / 2;
        const cz = (b.z0 + b.z1) / 2;
        const a = P(cx, -b.h, cz);
        const t = P(cx, -b.h - 30 - 80 * u, cz);
        g.strokeStyle = s.edits ? theme.ok : `rgb(${theme.hot})`;
        g.globalAlpha = 1 - u;
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(t[0], t[1]);
        g.stroke();
        g.beginPath();
        g.arc(a[0], a[1], 3 + u * 16, 0, TAU);
        g.stroke();
        g.globalAlpha = 1;
      }

      // the agent's marker flies to the building it is working on
      if (drone.seen) {
        drone.x += (drone.tx - drone.x) * 0.08;
        drone.y += (drone.ty - drone.y) * 0.08;
        drone.z += (drone.tz - drone.z) * 0.08;
        const bob = reduced ? 0 : Math.sin(now / 380) * 1.5;
        const d = P(drone.x, drone.y + bob, drone.z);
        const foot = P(drone.x, 0, drone.z);
        g.strokeStyle = `rgba(${theme.hot},0.5)`;
        g.setLineDash([2, 3]);
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(d[0], d[1]);
        g.lineTo(foot[0], foot[1]);
        g.stroke();
        g.setLineDash([]);
        const r = 5 * d[2];
        g.strokeStyle = `rgb(${theme.hot})`;
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(d[0], d[1] - r);
        g.lineTo(d[0] + r, d[1]);
        g.lineTo(d[0], d[1] + r);
        g.lineTo(d[0] - r, d[1]);
        g.closePath();
        g.stroke();
        g.fillStyle = `rgb(${theme.hot})`;
        g.font = `9px ${theme.font}`;
        g.fillText('AGENT', d[0] + r + 5, d[1] + 3);
      }

      // names of the files touched most recently, and the one under the pointer
      g.font = `9px ${theme.font}`;
      let shown = 0;
      for (let i = order.length - 1; i >= 0 && shown < 9; i--) {
        const b = order[i];
        const s = stats.get(b.path);
        if (b !== st.hover && !(s && now - s.beam < 9000)) continue;
        shown++;
        const top = P((b.x0 + b.x1) / 2, -b.h, (b.z0 + b.z1) / 2);
        g.fillStyle = `rgba(${theme.hot},0.95)`;
        g.fillText(s && s.edits ? `${b.name}  +${s.add} −${s.del}` : b.name, top[0] + 7, top[1] - 5);
      }

      st.hud('DRAG = ORBIT · WHEEL = ZOOM · CLICK BUILDING = @MENTION', 'HEIGHT = FILE SIZE · LIT = TOUCHED BY THE AGENT');
    }

    function pick(x, y) {
      for (let i = order.length - 1; i >= 0; i--) {
        const b = order[i];
        if (b.faces && (inPoly(b.faces[2], x, y) || inPoly(b.faces[0], x, y) || inPoly(b.faces[1], x, y))) return b;
      }
      return null;
    }

    function describe(b) {
      const s = stats.get(b.path);
      const lines = [b.path, fmtSize(b.size)];
      if (s) lines.push(`READ ×${s.reads} · EDIT ×${s.edits} · +${s.add} −${s.del}`);
      lines.push('CLICK → @MENTION IN PROMPT');
      return lines;
    }

    return { init, setTree, touch, clear, frame, resize: () => st.resize(), get count() { return buildings.length; } };
  })();

  /* ================= Helix ================= */

  const Helix = (() => {
    const R = 135;
    const LANE = { PROMPT: 16, REPLY: 26, PLAN: 36, READ: 46, SEARCH: 56, EDIT: 66, SHELL: 76, WEB: 86, AGENT: 96, MCP: 106, OTHER: 106 };
    const RISE = 5; // vertical step per event: enough for one line of label each
    const TURN = 0.42; // radians per event
    const WINDOW = 54; // events on screen
    let st;
    let onPick = () => {};
    let events = [];
    let seq = 0;
    let head = 0; // smoothed index of the newest event, so the spiral scrolls
    let turns = 0;

    function init(canvas, tip, opts) {
      st = makeStage(canvas, tip, { yaw: 0.4, pitch: 0.22, minPitch: -1.2, maxPitch: 1.2, spin: 0.003, centerY: 0.5 });
      onPick = (opts && opts.onPick) || onPick;
      st.bind(pick, describe, (e) => e.file && onPick({ path: e.file }));
    }

    function add(cat, label, file, weight, id, ts) {
      if (cat === 'PROMPT') turns++;
      events.push({ s: seq++, cat, label: String(label || ''), file: file || null, w: weight || 1, id: id || null, err: false, t: ts || Date.now(), turn: turns });
      if (events.length > 400) events.shift();
    }

    function fail(id) {
      const e = id && events.find((x) => x.id === id);
      if (e) e.err = true;
    }

    function clear() {
      events = [];
      seq = 0;
      head = 0;
      turns = 0;
    }

    function frame() {
      if (!st.W) return;
      st.begin(R);
      const g = st.g;
      const P = st.project;
      head += (Math.max(0, seq - 1) - head) * 0.12;
      const span = Math.min(seq, WINDOW) * RISE;
      const top = -span / 2;

      // spine
      const a0 = P(0, top - 12, 0);
      const a1 = P(0, top + Math.max(span, 60) + 12, 0);
      g.strokeStyle = `rgba(${theme.ink},0.25)`;
      g.lineWidth = 0.7;
      g.setLineDash([2, 4]);
      g.beginPath();
      g.moveTo(a0[0], a0[1]);
      g.lineTo(a1[0], a1[1]);
      g.stroke();
      g.setLineDash([]);

      const vis = [];
      for (const e of events) {
        const age = head - e.s;
        if (age > WINDOW || age < -1) continue;
        const y = top + age * RISE;
        const ang = e.s * TURN;
        const r = LANE[e.cat] || 106;
        e.p = P(Math.cos(ang) * r, y, Math.sin(ang) * r);
        e.axis = P(0, y, 0);
        e.fade = clamp(1 - age / WINDOW, 0, 1);
        e.y = y;
        vis.push(e);
      }

      // the strand through time, and a rung back to the spine for each event
      g.lineWidth = 0.7;
      for (let i = 1; i < vis.length; i++) {
        const a = vis[i - 1];
        const b = vis[i];
        g.strokeStyle = `rgba(${theme.ink},${0.32 * b.fade})`;
        g.beginPath();
        g.moveTo(a.p[0], a.p[1]);
        g.lineTo(b.p[0], b.p[1]);
        g.stroke();
      }
      for (const e of vis) {
        g.strokeStyle = `rgba(${theme.ink},${0.13 * e.fade})`;
        g.beginPath();
        g.moveTo(e.axis[0], e.axis[1]);
        g.lineTo(e.p[0], e.p[1]);
        g.stroke();
      }

      // a ring marks where each prompt (turn) starts
      for (const e of vis) {
        if (e.cat !== 'PROMPT') continue;
        g.strokeStyle = theme.warn;
        g.globalAlpha = 0.5 * e.fade;
        g.lineWidth = 0.9;
        g.beginPath();
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * TAU;
          const p = P(Math.cos(a) * 114, e.y, Math.sin(a) * 114);
          if (i) g.lineTo(p[0], p[1]);
          else g.moveTo(p[0], p[1]);
        }
        g.stroke();
        g.globalAlpha = 1;
        const tag = P(118, e.y, 0);
        g.font = `8px ${theme.font}`;
        g.fillStyle = theme.warn;
        g.globalAlpha = e.fade;
        g.fillText('TURN ' + e.turn, tag[0] + 4, tag[1] + 3);
        g.globalAlpha = 1;
      }

      // events
      for (const e of vis.slice().sort((a, b) => b.p[3] - a.p[3])) {
        const r = (1.5 + Math.min(4, e.w)) * e.p[2];
        const lit = e === st.hover;
        g.globalAlpha = lit ? 1 : 0.25 + 0.75 * e.fade;
        g.fillStyle = e.err ? theme.err : e.cat === 'EDIT' ? theme.ok : e.cat === 'PROMPT' ? theme.warn : `rgb(${head - e.s < 12 ? theme.hot : theme.ink})`;
        g.beginPath();
        g.arc(e.p[0], e.p[1], r, 0, TAU);
        g.fill();
        if (lit) {
          g.strokeStyle = `rgb(${theme.hot})`;
          g.lineWidth = 1;
          g.strokeRect(e.p[0] - r - 4, e.p[1] - r - 4, (r + 4) * 2, (r + 4) * 2);
        }
      }
      g.globalAlpha = 1;

      // the latest events, spelled out
      g.font = `9px ${theme.font}`;
      const latest = vis.slice(-6);
      for (const e of latest) {
        g.fillStyle = `rgba(${theme.hot},${0.4 + 0.6 * e.fade})`;
        g.fillText(`${e.cat}  ${e.label.slice(0, 34)}`, e.p[0] + 9, e.p[1] + 3);
      }
      if (!events.length) {
        g.fillStyle = `rgba(${theme.ink},0.6)`;
        g.textAlign = 'center';
        g.fillText('THE SPIRAL GROWS WITH THE SESSION: SEND A PROMPT', st.W / 2, st.H / 2);
        g.textAlign = 'left';
      }
      st.hud('DRAG = ORBIT · WHEEL = ZOOM · CLICK A FILE EVENT = @MENTION', 'NEWEST AT THE TOP · ONE LANE PER KIND OF EVENT');
    }

    function pick(x, y) {
      let best = null;
      let bd = 10;
      for (const e of events) {
        if (!e.p || head - e.s > WINDOW) continue;
        const d = Math.hypot(e.p[0] - x, e.p[1] - y);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      return best;
    }

    function describe(e) {
      const d = new Date(e.t);
      const hh = (n) => String(n).padStart(2, '0');
      const lines = [`${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())} · ${e.cat}${e.err ? ' · FAILED' : ''}`, e.label.slice(0, 70)];
      if (e.file) lines.push('CLICK → @MENTION THE FILE');
      return lines;
    }

    return { init, add, fail, clear, frame, resize: () => st.resize(), get count() { return events.length; } };
  })();

  /* ================= Orrery ================= */

  const Orrery = (() => {
    const R = 172;
    const KINDS = ['READ', 'SEARCH', 'EDIT', 'SHELL', 'WEB', 'AGENT', 'PLAN', 'MCP'];
    const planets = KINDS.map((cat, i) => ({
      cat, r: 34 + i * 14, tilt: (i % 2 ? -1 : 1) * (0.07 + i * 0.016), ang: i * 1.9, boost: 0, count: 0, pending: 0, p: null, rad: 3,
    }));
    const RING = 158;
    let st;
    let context = 0;
    let windowSize = 200000;
    let agents = [];
    let last = 0;

    function init(canvas, tip) {
      st = makeStage(canvas, tip, { yaw: 0.3, pitch: 0.95, minPitch: 0.1, maxPitch: 1.5, spin: 0.0012, centerY: 0.5 });
      st.bind(pick, describe, null);
    }

    function set(data) {
      for (const p of planets) {
        p.count = (data.cats[p.cat] || 0) + (p.cat === 'MCP' ? data.cats.OTHER || 0 : 0);
        p.pending = data.pending[p.cat] || 0;
      }
      context = data.ctx || 0;
      windowSize = data.window || 200000;
      agents = data.agents || [];
    }

    /** A real call of this kind just happened: its planet speeds up for a moment. */
    function kick(cat) {
      const p = planets.find((x) => x.cat === (cat === 'OTHER' ? 'MCP' : cat));
      if (p) p.boost = Math.min(1, p.boost + 0.5);
    }

    const at = (p, a) => [p.r * Math.cos(a), p.r * Math.sin(a) * Math.sin(p.tilt), p.r * Math.sin(a) * Math.cos(p.tilt)];

    function ring(radius, from, to, steps) {
      const g = st.g;
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const a = from + ((to - from) * i) / steps;
        const q = st.project(Math.cos(a) * radius, 0, Math.sin(a) * radius);
        if (i) g.lineTo(q[0], q[1]);
        else g.moveTo(q[0], q[1]);
      }
      g.stroke();
    }

    function frame(now) {
      if (!st.W) return;
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      st.begin(R);
      const g = st.g;
      const P = st.project;

      // outer ring: how full the context window is
      const used = clamp(context / windowSize, 0, 1);
      g.lineWidth = 0.8;
      g.strokeStyle = `rgba(${theme.ink},0.22)`;
      ring(RING, 0, TAU, 96);
      g.lineWidth = 2;
      g.strokeStyle = used > 0.8 ? theme.warn : `rgb(${theme.hot})`;
      if (used > 0) ring(RING, -1.5708, -1.5708 + TAU * used, Math.max(2, Math.round(96 * used)));
      const tag = P(0, 0, -RING);
      g.font = `9px ${theme.font}`;
      g.fillStyle = `rgba(${theme.hot},0.9)`;
      g.fillText(`CONTEXT ${Math.round(used * 100)}%`, tag[0] + 6, tag[1] - 6);

      // the agent
      const sun = P(0, 0, 0);
      const beat = reduced ? 1 : 1 + 0.2 * Math.sin(now / 420);
      g.lineWidth = 1;
      g.strokeStyle = `rgb(${theme.hot})`;
      g.beginPath();
      g.arc(sun[0], sun[1], 7 * sun[2], 0, TAU);
      g.stroke();
      g.strokeStyle = `rgba(${theme.hot},0.35)`;
      g.beginPath();
      g.arc(sun[0], sun[1], 12 * sun[2] * beat, 0, TAU);
      g.stroke();
      g.fillStyle = `rgb(${theme.hot})`;
      g.fillRect(sun[0] - 1.5, sun[1] - 1.5, 3, 3);
      g.fillText('AGENT', sun[0] + 16, sun[1] + 3);

      planets.forEach((p, i) => {
        if (!reduced) p.ang += dt * (0.2 / (1 + i * 0.22)) * (1 + p.boost * 6);
        p.boost *= Math.pow(0.3, dt);

        // orbit
        g.lineWidth = 0.6;
        g.strokeStyle = `rgba(${theme.ink},${st.hover === p ? 0.6 : 0.16})`;
        g.beginPath();
        for (let k = 0; k <= 64; k++) {
          const q = P(...at(p, (k / 64) * TAU));
          if (k) g.lineTo(q[0], q[1]);
          else g.moveTo(q[0], q[1]);
        }
        g.stroke();

        // trail
        g.lineWidth = 1.3;
        for (let k = 0; k < 14; k++) {
          const q0 = P(...at(p, p.ang - k * 0.05));
          const q1 = P(...at(p, p.ang - (k + 1) * 0.05));
          g.strokeStyle = `rgba(${theme.hot},${(0.6 + p.boost * 0.4) * (1 - k / 14) * (p.count ? 1 : 0.3)})`;
          g.beginPath();
          g.moveTo(q0[0], q0[1]);
          g.lineTo(q1[0], q1[1]);
          g.stroke();
        }

        // planet, sized by how many calls it has made
        p.p = P(...at(p, p.ang));
        p.rad = (2.6 + Math.log2(1 + p.count) * 1.7) * p.p[2];
        g.beginPath();
        g.arc(p.p[0], p.p[1], p.rad, 0, TAU);
        g.fillStyle = p.count ? `rgb(${theme.hot})` : theme.bg;
        g.fill();
        g.lineWidth = 1;
        g.strokeStyle = `rgba(${theme.hot},${p.count ? 1 : 0.5})`;
        g.stroke();

        // moons: calls running right now
        for (let m = 0; m < Math.min(6, p.pending); m++) {
          const a = now / 260 + (m / Math.min(6, p.pending)) * TAU;
          g.fillStyle = theme.warn;
          g.fillRect(p.p[0] + Math.cos(a) * (p.rad + 6) - 1.5, p.p[1] + Math.sin(a) * (p.rad + 6) * 0.6 - 1.5, 3, 3);
        }

        g.fillStyle = `rgba(${p.count ? theme.hot : theme.ink},${p.count ? 0.95 : 0.55})`;
        g.fillText(`${p.cat} ${p.count}`, p.p[0] + p.rad + 5, p.p[1] + 3);
      });

      // subagents fly a steep ellipse of their own
      agents.forEach((a, j) => {
        const ang = j * 2.1 + (a.state === 'working' && !reduced ? now / 1300 : 0);
        const pos = (t) => P(128 * Math.cos(t), 74 * Math.sin(t) * Math.sin(0.95), 74 * Math.sin(t) * Math.cos(0.95));
        const q = pos(ang);
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
        if (a.state === 'working') {
          g.beginPath();
          for (let k = 0; k <= 10; k++) {
            const t = pos(ang - k * 0.06);
            if (k) g.lineTo(t[0], t[1]);
            else g.moveTo(t[0], t[1]);
          }
          g.globalAlpha = 0.5;
          g.stroke();
          g.globalAlpha = 1;
        }
        g.fillStyle = `rgba(${theme.ink},0.8)`;
        g.fillText(String(a.desc || 'subagent').slice(0, 22).toUpperCase(), q[0] + r + 5, q[1] + 3);
      });

      st.hud('DRAG = ORBIT · WHEEL = ZOOM · HOVER A PLANET', 'SIZE = CALLS · SPEED = RECENT ACTIVITY · MOONS = RUNNING NOW');
    }

    function pick(x, y) {
      let best = null;
      let bd = Infinity;
      for (const p of planets) {
        if (!p.p) continue;
        const d = Math.hypot(p.p[0] - x, p.p[1] - y);
        if (d < Math.max(11, p.rad + 6) && d < bd) {
          bd = d;
          best = p;
        }
      }
      return best;
    }

    const describe = (p) => [p.cat === 'MCP' ? 'MCP + OTHER TOOLS' : p.cat + ' TOOLS', `${p.count} CALLS · ${p.pending} RUNNING NOW`];

    return { init, set, kick, frame, resize: () => st.resize() };
  })();

  // makeStage and theme are shared with galaxy.js, which is a scene of its own file.
  return { setTheme, City, Helix, Orrery, makeStage, theme };
})();
