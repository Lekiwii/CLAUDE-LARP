'use strict';
/*
 * --demo: feeds the dashboard a synthetic event stream so it can be filmed or
 * screenshotted without spending a single token. The UI shows a DEMO badge
 * while this runs, so nobody mistakes it for a real session.
 */
const FILES = [
  'src/router.ts',
  'src/fanout.ts',
  'src/agents/pool.ts',
  'src/review/rank.ts',
  'src/usage/window.ts',
  'test/router.test.ts',
  'test/fanout.test.ts',
  'README.md',
];
const COMMANDS = ['npm test -- --run', 'git diff --stat', 'npx tsc --noEmit', 'npm run lint', 'git status --short'];
const PATTERNS = ['spawnAgent\\(', 'TODO|FIXME', 'export class \\w+Router', 'usage\\.window'];
const PROMPTS = [
  'fan the prompt out to every agent and rank the diffs',
  'the router drops sessions when a host reconnects, find out why',
  'add usage window tracking and warn at 80%',
];
const PLAN = ['Trace the reconnect path', 'Reproduce with a failing test', 'Fix session routing', 'Rank diffs in review', 'Run the full suite'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));

/**
 * @param {(events: object[]) => void} emit
 * @param {string[]} [realFiles] paths in the open folder: when given, the demo
 *   "touches" a handful of them, so the graph and the city light up real nodes.
 */
function startDemo(emit, realFiles) {
  const files =
    realFiles && realFiles.length >= 4
      ? realFiles.slice().sort(() => Math.random() - 0.5).slice(0, 12)
      : FILES;
  let n = 0;
  let ctx = 18000;
  let step = 0;
  let stopped = false;
  const open = [];
  let started = false;
  const stamp = (e) => Object.assign(e, { ts: Date.now() });

  const todos = () => PLAN.map((c, i) => ({ c, s: i < step ? 'completed' : i === step ? 'in_progress' : 'pending' }));

  function tool(name, input) {
    const id = 'demo_' + ++n;
    open.push(id);
    return stamp({ k: 'tool', id, name, input });
  }

  function usage(stop) {
    ctx += rnd(400, 2600);
    return stamp({
      k: 'usage',
      id: 'msg_' + ++n,
      model: 'demo-model',
      stop,
      u: { in: rnd(4, 40), out: rnd(60, 900), cr: ctx, cw: rnd(200, 2400) },
    });
  }

  function tick() {
    if (stopped) return;
    const out = [];
    const r = Math.random();
    if (!started || r < 0.04) {
      started = true;
      out.push(stamp({ k: 'prompt', text: pick(PROMPTS) }));
      out.push(stamp({ k: 'think' }));
    } else if (r < 0.1) {
      step = (step + 1) % (PLAN.length + 1);
      out.push(tool('TodoWrite', { todos: todos() }));
    } else if (r < 0.3) {
      out.push(tool('Read', { file: pick(files) }));
    } else if (r < 0.42) {
      out.push(tool('Grep', { pattern: pick(PATTERNS) }));
    } else if (r < 0.62) {
      out.push(tool('Edit', { file: pick(files), add: rnd(1, 24), del: rnd(0, 12) }));
    } else if (r < 0.76) {
      out.push(tool('Bash', { cmd: pick(COMMANDS), desc: '' }));
    } else if (r < 0.82) {
      out.push(tool('Agent', { desc: pick(['audit the reconnect path', 'review ranked diffs', 'search for flaky tests']), type: pick(['Explore', 'general-purpose']) }));
    } else if (r < 0.86) {
      out.push(tool('WebSearch', { query: 'node-pty resize race condition' }));
    } else if (r < 0.93) {
      out.push(stamp({ k: 'text', text: pick(['The router keeps a stale host handle after reconnect.', 'Tests pass. Ranking diffs next.', 'Found it: the session map is keyed by the old socket.']) }));
      out.push(usage(Math.random() < 0.25 ? 'end_turn' : 'tool_use'));
    } else {
      out.push(usage('tool_use'));
    }
    // settle a couple of earlier tool calls
    while (open.length > rnd(0, 3)) out.push(stamp({ k: 'result', id: open.shift(), err: Math.random() < 0.04 }));
    emit(out);
    setTimeout(tick, rnd(160, 820));
  }

  setTimeout(tick, 1800);
  return () => {
    stopped = true;
  };
}

module.exports = { startDemo };
