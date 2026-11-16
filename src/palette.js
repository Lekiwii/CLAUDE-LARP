'use strict';
/*
 * Colour channels.
 *
 * In LARP every side panel has a colour (its header: --h1 .. --h7 in the theme).
 * When a theme sets `--channels: 1`, the canvases reuse those same colours as
 * codes: a cable takes its panel's colour, each top-level folder gets one in the
 * graph and the galaxy, each kind of tool gets one on the activity terrain.
 *
 * The colours are flat steps, never a gradient: a channel is a category. They
 * come from the active theme, so each theme codes with its own palette.
 */
const Palette = (() => {
  let on = false;
  let steps = [];
  const byNode = new Map();

  const toRgb = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return `${n >> 16},${(n >> 8) & 255},${n & 255}`;
  };

  /** Call after the theme changes. */
  function refresh() {
    const cs = getComputedStyle(document.body);
    steps = [];
    for (let i = 1; i <= 7; i++) {
      const rgb = toRgb(cs.getPropertyValue('--h' + i).trim());
      if (rgb && !steps.includes(rgb)) steps.push(rgb);
    }
    // a theme whose headers all share one colour has nothing to code with
    on = cs.getPropertyValue('--channels').trim() === '1' && steps.length > 1;
    byNode.clear();
  }

  /** The i-th channel colour, as "r,g,b" (wraps around). */
  function pick(i) {
    return steps[((i % steps.length) + steps.length) % steps.length];
  }

  /** t in 0..1 -> the channel that range falls in, as "r,g,b". */
  function rgb(t) {
    return steps[Math.min(steps.length - 1, Math.max(0, Math.floor(t * steps.length)))];
  }

  /** The colour of a side panel, by its data-node name; null when the theme does not code by colour. */
  function ofNode(name) {
    if (!on) return null;
    if (!byNode.has(name)) {
      const el = document.querySelector(`.node[data-node="${name}"]`);
      byNode.set(name, el ? toRgb(getComputedStyle(el).getPropertyValue('--hdr').trim()) : null);
    }
    return byNode.get(name);
  }

  return { refresh, pick, rgb, ofNode, get on() { return on; } };
})();
