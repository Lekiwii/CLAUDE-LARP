'use strict';
/*
 * Patch cables between the side panels and the terminal. Left panels feed the
 * agent (repo, session, plan, host); the agent feeds the right panels (context,
 * tools, subagents, files). A spark runs down a cable when the matching kind of
 * event really happens in the session.
 */
const Wires = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let svg, stage, centre;
  let wires = []; // { node, path, len }
  let generation = 0;
  let active = 0;

  const make = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  function init() {
    svg = document.getElementById('wires');
    stage = document.getElementById('stage');
    centre = document.getElementById('center');
  }

  /** Rebuild every cable from the current DOM geometry. Returns the terminal box. */
  function layout() {
    const sr = stage.getBoundingClientRect();
    // The centre can hold the terminal, the graph, or both side by side: cables
    // plug into the outer edges of whatever is showing.
    const shown = [...centre.children].filter((n) => n.offsetParent !== null);
    const first = (shown[0] || centre).getBoundingClientRect();
    const last = (shown[shown.length - 1] || centre).getBoundingClientRect();
    const t = { x: first.left - sr.left, y: first.top - sr.top, w: last.right - first.left, h: first.height };
    generation++;
    wires = [];
    svg.textContent = '';
    svg.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);

    const side = (selector, isLeft) => {
      const ports = [...document.querySelectorAll(selector)]
        .map((p) => {
          const r = p.getBoundingClientRect();
          return { x: r.left + r.width / 2 - sr.left, y: r.top + r.height / 2 - sr.top, node: p.closest('.node') };
        })
        .filter((o) => o.y > 0 && o.y < sr.height)
        .sort((a, b) => a.y - b.y);

      const edge = isLeft ? t.x : t.x + t.w;
      const busX = isLeft ? edge - 30 : edge + 30;
      const top = t.y + 30;
      const bottom = t.y + t.h - 14;

      // the bus rail with its ruler
      svg.appendChild(make('line', { class: 'bus', x1: busX, y1: t.y, x2: busX, y2: t.y + t.h }));
      for (let y = t.y + 8, i = 0; y < t.y + t.h - 4; y += 12, i++) {
        const major = i % 4 === 0;
        svg.appendChild(make('line', { class: 'tick', x1: busX - (major ? 4 : 2), y1: y, x2: busX + (major ? 4 : 2), y2: y }));
        if (major) {
          const label = make('text', { x: isLeft ? busX + 7 : busX - 7, y: y + 2.5, 'text-anchor': isLeft ? 'start' : 'end' });
          label.textContent = String(i).padStart(2, '0');
          svg.appendChild(label);
        }
      }

      ports.forEach((o, i) => {
        const ty = ports.length > 1 ? top + ((bottom - top) * i) / (ports.length - 1) : (top + bottom) / 2;
        const dx = Math.abs(edge - o.x) * 0.5;
        // Left cables run panel -> terminal, right cables terminal -> panel, so
        // a spark always travels in the direction the data does.
        const d = isLeft
          ? `M${o.x},${o.y} C${o.x + dx},${o.y} ${edge - dx},${ty} ${edge},${ty}`
          : `M${edge},${ty} C${edge + dx},${ty} ${o.x - dx},${o.y} ${o.x},${o.y}`;
        const path = make('path', { class: 'wire', d });
        svg.appendChild(path);
        // a slow bead of light always travelling the cable, in the data's direction
        const flow = make('path', { class: 'flow', d });
        flow.style.animationDelay = `${-(i * 0.37) % 2.4}s`;
        svg.appendChild(flow);
        svg.appendChild(make('circle', { class: 'jack', cx: edge, cy: ty, r: 2.6 }));
        wires.push({ node: o.node.dataset.node, el: o.node, path, len: path.getTotalLength() });
      });
    };

    side('.col.left .port.out', true);
    side('.col.right .port.in', false);
    return t;
  }

  /** Flash a panel and send a spark down one of its cables. */
  function pulse(nodeName) {
    const mine = wires.filter((w) => w.node === nodeName);
    if (!mine.length) return;
    const w = mine[(Math.random() * mine.length) | 0];

    w.el.classList.add('hit');
    setTimeout(() => w.el.classList.remove('hit'), 260);

    if (active > 28 || document.hidden) return;
    active++;
    const born = generation;
    const dot = make('circle', { class: 'spark', r: 2.4 });
    svg.appendChild(dot);
    w.path.classList.add('hot');
    const t0 = performance.now();
    const dur = 520 + Math.random() * 260;

    const step = (now) => {
      const u = Math.min(1, (now - t0) / dur);
      if (born !== generation) {
        active--;
        return; // the cables were rebuilt under us
      }
      const p = w.path.getPointAtLength(w.len * (u * u * (3 - 2 * u)));
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      if (u < 1) return requestAnimationFrame(step);
      dot.remove();
      w.path.classList.remove('hot');
      active--;
    };
    requestAnimationFrame(step);
  }

  return { init, layout, pulse };
})();
