'use strict';
/* global Terminal, FitAddon, WebLinksAddon, Field, Wires, Graph3D, Scenes3D, Galaxy, Viz, larp */
/*
 * Renderer: hosts the terminal and keeps every panel in sync with what the
 * session is really doing. All numbers on screen come from the session
 * transcript, git, or the host — nothing here is invented (except in --demo).
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtK = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(1) + 'K' : (n / 1e6).toFixed(2) + 'M');
  const pct = (x) => Math.round(Math.max(0, Math.min(1, x)) * 100) + '%';
  const clock = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };
  const span = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return (h ? pad(h) + ':' : '') + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  };
  const norm = (p) => String(p || '').replace(/\\/g, '/');
  const shortPath = (p) => {
    const parts = norm(p).split('/').filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : norm(p);
  };

  const THEMES = ['signal', 'phosphor', 'neon', 'amber', 'paper'];
  const CATS = ['READ', 'EDIT', 'SHELL', 'SEARCH', 'WEB', 'AGENT', 'PLAN', 'MCP', 'OTHER'];
  const BAR_CATS = ['READ', 'EDIT', 'SHELL', 'SEARCH', 'WEB', 'AGENT'];
  const STEP = 4; // px per column in the trace strip
  const VIEWS = ['term', 'split', 'graph'];
  const SCENES = ['graph', 'city', 'helix', 'orbit', 'galaxy'];
  const GLYPHS = '#%&/<>[]{}=+*^?_-01';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Which side panel lights up for which kind of tool. */
  const CAT_NODE = { READ: 'files', EDIT: 'files', SHELL: 'tools', SEARCH: 'tools', WEB: 'tools', MCP: 'tools', OTHER: 'tools', AGENT: 'agents', PLAN: 'tasks' };

  function category(name) {
    if (/^(Read|NotebookRead|LS)$/.test(name)) return 'READ';
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return 'EDIT';
    if (/^(Bash|BashOutput|KillShell|KillBash|PowerShell)$/.test(name)) return 'SHELL';
    if (/^(Grep|Glob|ToolSearch)$/.test(name)) return 'SEARCH';
    if (/^(WebFetch|WebSearch)$/.test(name)) return 'WEB';
    if (/^(Task|Agent)$/.test(name)) return 'AGENT';
    if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|ExitPlanMode)$/.test(name)) return 'PLAN';
    if (name.startsWith('mcp__')) return 'MCP';
    return 'OTHER';
  }

  /* ---------- state ---------- */

  const info = await larp.init();
  document.body.classList.add(info.platform === 'win32' ? 'win' : info.platform === 'darwin' ? 'mac' : 'linux');

  let view = VIEWS.includes(info.view) ? info.view : 'split';
  document.body.dataset.view = view;
  let scene = SCENES.includes(info.scene) ? info.scene : 'graph';
  document.body.dataset.scene = scene;

  let session = null;
  let git = null;
  let dirty = true;
  let replaying = false; // true while a resumed session's history is being loaded
  let turn = null; // the request in flight: { t0, t1, steps, last, done, stopped, doneAt }
  let exitShownFor = 0;
  let S = fresh();

  function fresh() {
    return {
      status: 'STARTING',
      turns: 0, tools: 0, edits: 0, errors: 0, add: 0, del: 0, agentsTotal: 0,
      cats: Object.fromEntries(CATS.map((c) => [c, 0])),
      pending: new Map(), // tool_use id -> { name, cat }
      usage: new Map(), // message id -> usage (a message can be written more than once)
      tokIn: 0, tokOut: 0, cacheRead: 0, cacheWrite: 0, ctx: 0, model: null,
      files: new Map(), seq: 0,
      agents: [], tasks: [],
      branch: null, version: null,
    };
  }

  // activity over time, independent of the session counters
  const stamps = [];
  const buckets = new Array(48).fill(0);
  const trace = Array.from({ length: 700 }, () => ({ w: 0, seed: (Math.random() * 4294967296) >>> 0 }));
  let traceWeight = 0;

  /* ---------- terminal ---------- */

  const termTheme = () => ({
    background: css('--term-bg'),
    foreground: css('--term-fg'),
    cursor: css('--term-cur'),
    cursorAccent: css('--term-bg'),
    selectionBackground: 'rgba(160,160,160,0.35)',
  });

  const term = new Terminal({
    fontFamily: css('--mono'),
    fontSize: 13,
    lineHeight: 1.12,
    cursorBlink: true,
    scrollback: 8000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => larp.openExternal(uri)));
  term.open($('term'));

  term.onData((d) => larp.write(d));
  term.onResize(({ cols, rows }) => larp.resize(cols, rows));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Ctrl/Cmd+C copies when text is selected; otherwise it reaches the CLI as an interrupt.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      larp.copy(term.getSelection());
      term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Shift+Enter inserts a newline in the prompt instead of sending it.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      larp.write('\x1b\r');
      e.preventDefault();
      return false;
    }
    return true;
  });

  larp.onData((d) => {
    term.write(d);
    Field.bump(Math.min(0.03, d.length / 40000));
  });

  /* ---------- layout ---------- */

  const traceCv = $('trace-cv');
  const histCv = $('hist');
  const ldCv = $('ld-bar');

  /* ---------- request loader: takes the tagline's place while Claude works ---------- */

  function startTurn() {
    turn = { t0: Date.now(), t1: 0, steps: 0, last: '', done: false, stopped: false, doneAt: 0, sent: -1 };
    $('loader').hidden = false;
    $('loader').classList.remove('done', 'stopped');
    document.body.classList.add('working');
    sizeCanvas(ldCv);
    updateLoader();
  }

  function dropTurn() {
    turn = null;
    $('loader').hidden = true;
    document.body.classList.remove('working');
    larp.progress('idle');
  }

  /** The request is answered (or was stopped): show the result a moment, then give the line back. */
  function endTurn(stopped) {
    if (!turn || turn.done) return;
    turn.done = true;
    turn.stopped = !!stopped;
    turn.t1 = Date.now();
    turn.doneAt = performance.now();
    $('loader').classList.add(stopped ? 'stopped' : 'done');
    larp.progress(stopped ? 'idle' : 'done');
    updateLoader();
    const mine = turn;
    setTimeout(() => {
      if (turn === mine) dropTurn();
    }, 1800);
  }

  function planRatio() {
    return S.tasks.length ? S.tasks.filter((t) => t.s === 'completed').length / S.tasks.length : 0;
  }

  function updateLoader() {
    if (!turn) return;
    const parts = [];
    if (!turn.done && turn.last) parts.push(turn.last.length > 46 ? turn.last.slice(0, 45) + '…' : turn.last);
    parts.push(`STEP ${turn.steps}`);
    if (S.tasks.length) parts.push(`PLAN ${S.tasks.filter((t) => t.s === 'completed').length}/${S.tasks.length}`);
    parts.push(span((turn.done ? turn.t1 : Date.now()) - turn.t0));
    $('ld-tag').textContent = turn.done ? (turn.stopped ? 'STOPPED' : 'DONE') : S.status;
    $('ld-info').textContent = parts.join('  ·  ');
    if (!turn.done) {
      const p = planRatio();
      if (p !== turn.sent) {
        turn.sent = p;
        larp.progress(p > 0 ? p : 'busy'); // with a plan, the taskbar shows real progress
      }
    }
  }

  /** Segmented bar: plan progress fills from the left, a comet of light sweeps while working. */
  function drawLoader(now) {
    if (!turn || !ldCv.cssW) return;
    const g = ldCv.getContext('2d');
    const w = ldCv.cssW;
    const h = ldCv.cssH;
    const ink = css('--ink');
    const hot = css('--ink-hot');
    const cell = 5;
    const gap = 2;
    const n = Math.max(4, Math.floor((w + gap) / (cell + gap)));
    const filled = turn.done ? (turn.stopped ? 0 : n) : Math.floor(planRatio() * n);
    const trail = Math.max(6, Math.round(n * 0.24));
    const head = reducedMotion ? -1 : (now / 34) % (n + trail);
    const flash = turn.done && !turn.stopped ? 0.55 + 0.45 * Math.abs(Math.cos((now - turn.doneAt) / 130)) : 0;
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < n; i++) {
      let a = i < filled ? 0.85 : 0.16;
      let lit = false;
      const d = head - i;
      if (!turn.done && d >= 0 && d < trail) {
        a = Math.max(a, 1 - d / trail);
        lit = true;
      }
      if (flash) {
        a = flash;
        lit = true;
      }
      g.fillStyle = `rgba(${lit ? hot : ink},${a})`;
      g.fillRect(i * (cell + gap), 0, cell, h);
    }
  }

  function sizeCanvas(c) {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    c.cssW = r.width;
    c.cssH = r.height;
  }

  function relayout() {
    if (view !== 'graph') {
      try {
        fit.fit(); // never while the terminal is hidden: it would shrink the CLI to nothing
      } catch {
        /* the terminal has no size yet */
      }
    }
    Field.layout(Wires.layout());
    $('term-size').textContent = `${term.cols}×${term.rows}`;
    sizeCanvas(traceCv);
    sizeCanvas(histCv);
    if (turn) sizeCanvas(ldCv);
    Graph3D.resize();
    Scenes3D.City.resize();
    Scenes3D.Helix.resize();
    Scenes3D.Orrery.resize();
    Galaxy.resize();
    Viz.Core.resize();
    Viz.Terrain.resize();
    drawTrace();
    drawHist();
    drawViz(performance.now()); // a resized canvas is blank: repaint before the next frame shows it
  }

  /** Clicking a node in the graph drops an @mention of it into the prompt. */
  function mention({ path }) {
    if (!session || session.status !== 'running' || session.missing) return;
    const ref = path || '.';
    larp.write('@' + (/\s/.test(ref) ? `"${ref}"` : ref) + ' ');
    if (view === 'graph') setView('split', true);
    term.focus();
  }

  Field.init($('field'));
  Wires.init();
  Viz.setTheme();
  Viz.Core.init($('core'));
  Viz.Terrain.init($('terrain'));
  Graph3D.init($('graph'), $('graph-tip'), { onPick: mention });
  Scenes3D.setTheme();
  Scenes3D.City.init($('city'), $('graph-tip'), { onPick: mention });
  Scenes3D.Helix.init($('helix'), $('graph-tip'), { onPick: mention });
  Scenes3D.Orrery.init($('orbit'), $('graph-tip'));
  Galaxy.init($('galaxy'), $('graph-tip'), { onPick: mention });
  let layoutQueued = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(layoutQueued);
    layoutQueued = requestAnimationFrame(relayout);
  });
  observer.observe($('stage'));
  observer.observe($('term-wrap'));
  observer.observe($('graph-wrap'));
  document.querySelectorAll('.col .node').forEach((n) => observer.observe(n));
  relayout();

  function setView(next, save) {
    view = next;
    document.body.dataset.view = next;
    $('b-view').textContent = 'VIEW: ' + next;
    if (save) larp.setView(next);
    requestAnimationFrame(() => {
      relayout();
      if (next !== 'graph') term.refresh(0, term.rows - 1);
    });
  }
  setView(view, false);

  /** Which 3D scene the centre panel shows. */
  function setScene(next, save) {
    scene = next;
    document.body.dataset.scene = next;
    $('graph-tip').hidden = true;
    if (save && next === 'galaxy') deepScan();
    for (const b of document.querySelectorAll('#scene-tabs button')) b.classList.toggle('on', b.dataset.scene === next);
    if (save) larp.setScene(next);
    dirty = true;
    requestAnimationFrame(relayout);
  }
  setScene(scene, false);
  for (const b of document.querySelectorAll('#scene-tabs button')) {
    b.addEventListener('click', () => setScene(b.dataset.scene, true));
  }

  /* ---------- repo map for the graph ---------- */

  async function scan() {
    try {
      const { name, items } = await larp.scan();
      Graph3D.setTree(name, items);
      Scenes3D.City.setTree(name, items);
      if (!galaxyDeep) Galaxy.setTree(name, items); // until the deep scan lands
      if (scene === 'galaxy') deepScan();
      dirty = true;
    } catch {
      /* the folder went away; the graph keeps what it has */
    }
  }
  /** The galaxy shows up to 3000 files: a deeper scan, only when that scene is on screen. */
  let galaxyDeep = false;
  let deepAt = 0;
  async function deepScan() {
    if (Date.now() - deepAt < 15000) return;
    deepAt = Date.now();
    try {
      const { name, items } = await larp.scanDeep();
      Galaxy.setTree(name, items);
      galaxyDeep = true;
      dirty = true;
    } catch {
      /* keep the quick map */
    }
  }

  let scanTimer = 0;
  const scanSoon = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 2500);
  };

  /* ---------- theme ---------- */

  let theme = THEMES.includes(info.theme) ? info.theme : THEMES[0];
  function applyTheme(name, announce) {
    theme = name;
    document.body.dataset.theme = name;
    term.options.theme = termTheme();
    Field.setTheme();
    Graph3D.setTheme();
    Scenes3D.setTheme();
    Viz.setTheme();
    $('b-theme').textContent = 'THEME: ' + name;
    if (announce) larp.setTheme({ name, bg: css('--bg'), fg: css('--dim') });
    drawTrace();
    drawHist();
    dirty = true;
  }
  applyTheme(theme, true);

  /* ---------- log ---------- */

  const logEl = $('log');
  function log(kind, tag, msg, ts) {
    const ln = el('div', 'ln e-' + kind);
    ln.append(el('span', 't', clock(ts || Date.now())), el('span', 'c', tag), el('span', 'm', msg));
    logEl.append(ln);
    while (logEl.childElementCount > 40) logEl.firstElementChild.remove();
  }

  /* ---------- session events ---------- */

  function relPath(p) {
    const a = norm(p);
    const base = norm(session && session.cwd).replace(/\/$/, '');
    if (base && a.toLowerCase().startsWith(base.toLowerCase() + '/')) return a.slice(base.length + 1);
    return shortPath(a);
  }

  function summary(i) {
    if (i.file) return relPath(i.file) + (i.add != null ? `  +${i.add} −${i.del}` : '');
    if (i.todos) return `${i.todos.length} items`;
    return i.cmd || i.pattern || i.url || i.query || i.desc || i.subject || i.raw || '';
  }

  function touchFile(p, add, del, isRead) {
    const key = relPath(p);
    const f = S.files.get(key) || { add: 0, del: 0, reads: 0, order: 0 };
    f.add += add;
    f.del += del;
    if (isRead) f.reads++;
    f.order = ++S.seq;
    S.files.set(key, f);
    Graph3D.touch(key, { edit: !isRead, add, del, quiet: replaying });
    Scenes3D.City.touch(key, { edit: !isRead, add, del, quiet: replaying });
    Galaxy.touch(key, { edit: !isRead, add, del, quiet: replaying });
  }

  function onTool(e) {
    const cat = category(e.name);
    const i = e.input || {};
    S.tools++;
    S.cats[cat]++;
    S.pending.set(e.id, { name: e.name, cat });
    S.status = 'RUN ' + e.name.replace(/^mcp__.*__/, '').slice(0, 14);

    if (cat === 'EDIT' && i.file) {
      S.edits++;
      S.add += i.add || 0;
      S.del += i.del || 0;
      touchFile(i.file, i.add || 0, i.del || 0, false);
    } else if (cat === 'READ' && i.file) {
      touchFile(i.file, 0, 0, true);
    } else if (cat === 'AGENT') {
      S.agentsTotal++;
      S.agents.unshift({ id: e.id, desc: i.desc || 'subagent', type: i.type || 'agent', state: 'working' });
      S.agents.length = Math.min(S.agents.length, 5);
      Graph3D.sub(e.id, i.desc, 'working');
    } else if (e.name === 'TodoWrite' && i.todos) {
      S.tasks = i.todos.map((t, n) => ({ id: String(n + 1), c: t.c, s: t.s }));
    } else if (e.name === 'TaskCreate' && i.subject) {
      S.tasks.push({ id: String(S.tasks.length + 1), c: i.subject, s: 'pending' });
    } else if (e.name === 'TaskUpdate') {
      const task = S.tasks.find((t) => t.id === i.taskId);
      if (task) {
        if (i.status === 'deleted') S.tasks = S.tasks.filter((t) => t !== task);
        else if (i.status) task.s = i.status;
        if (i.subject) task.c = i.subject;
      }
    }
    log(cat === 'EDIT' ? 'edit' : 'tool', cat === 'OTHER' ? 'TOOL' : cat, `${e.name.replace(/^mcp__/, '')}  ${summary(i)}`, e.ts);
    Scenes3D.Helix.add(cat, `${e.name.replace(/^mcp__/, '')} ${summary(i)}`, i.file ? relPath(i.file) : null, cat === 'EDIT' ? 2.5 : 1.2, e.id, e.ts);
    return cat;
  }

  function onUsage(e) {
    const prev = S.usage.get(e.id);
    if (prev) {
      S.tokIn -= prev.in;
      S.tokOut -= prev.out;
      S.cacheRead -= prev.cr;
      S.cacheWrite -= prev.cw;
    }
    S.usage.set(e.id, e.u);
    S.tokIn += e.u.in;
    S.tokOut += e.u.out;
    S.cacheRead += e.u.cr;
    S.cacheWrite += e.u.cw;
    S.ctx = e.u.in + e.u.cr + e.u.cw;
    if (e.model && e.model !== '<synthetic>') S.model = e.model;
    if (e.stop === 'end_turn' && S.pending.size === 0) S.status = 'AWAITING INPUT';
  }

  function handle(e, replay) {
    if (e.branch && e.branch !== 'HEAD') S.branch = e.branch;
    if (e.version) S.version = e.version;
    let node = null;
    let toolCat = null;
    let weight = 0.5;
    let energy = 0.12;

    switch (e.k) {
      case 'prompt':
        S.turns++;
        S.status = 'THINKING';
        log('prompt', 'PROMPT', e.text, e.ts);
        Scenes3D.Helix.add('PROMPT', e.text, null, 3, null, e.ts);
        if (!replay) {
          startTurn();
          Galaxy.warp(); // a shockwave through the disc
        }
        node = 'session';
        weight = 2;
        energy = 0.6;
        break;
      case 'command':
        log('sys', 'CMD', e.text, e.ts);
        break;
      case 'think':
        S.status = 'THINKING';
        if (!replay && !turn) startTurn(); // a turn that began without a typed prompt (slash command, resume)
        break;
      case 'text':
        log('sys', 'REPLY', e.text, e.ts);
        Scenes3D.Helix.add('REPLY', e.text, null, 1, null, e.ts);
        break;
      case 'tool': {
        const cat = onTool(e);
        toolCat = cat;
        if (!replay) {
          if (!turn || turn.done) startTurn();
          turn.steps++;
          turn.last = (e.name.replace(/^mcp__.*__/, '') + ' ' + summary(e.input || {})).trim();
        }
        node = CAT_NODE[cat];
        weight = cat === 'EDIT' ? 1.6 : 1;
        energy = cat === 'EDIT' || cat === 'AGENT' ? 0.45 : 0.28;
        break;
      }
      case 'result': {
        const p = S.pending.get(e.id);
        S.pending.delete(e.id);
        if (e.err) {
          S.errors++;
          Scenes3D.Helix.fail(e.id);
          log('err', 'ERR', `${p ? p.name : 'tool'} failed`, e.ts);
        }
        const agent = S.agents.find((a) => a.id === e.id);
        if (agent) {
          agent.state = e.err ? 'failed' : 'done';
          Graph3D.sub(e.id, agent.desc, agent.state);
        }
        // files may have appeared or gone: refresh the map shortly
        if (p && (p.cat === 'EDIT' || p.cat === 'SHELL') && !replaying) scanSoon();
        if (S.pending.size === 0 && S.status.startsWith('RUN')) S.status = 'THINKING';
        if (agent) node = 'agents';
        break;
      }
      case 'usage':
        onUsage(e);
        node = 'context';
        if ((e.stop === 'end_turn' || e.stop === 'stop_sequence') && S.pending.size === 0) endTurn(false);
        break;
      case 'interrupt':
        S.pending.clear();
        S.status = 'AWAITING INPUT';
        log('err', 'INT', 'interrupted by user', e.ts);
        endTurn(true);
        break;
      case 'system':
        log('sys', 'SYS', e.text, e.ts);
        break;
      case 'turn_end':
        S.pending.clear();
        S.status = 'AWAITING INPUT';
        endTurn(false);
        break;
      default:
        return;
    }

    dirty = true;
    if (replay) return;
    stamps.push(Date.now());
    buckets[buckets.length - 1]++;
    traceWeight += weight;
    Field.burst(energy);
    Viz.Core.hit(energy);
    if (toolCat) Scenes3D.Orrery.kick(toolCat);
    if (toolCat) Viz.Terrain.add(toolCat, weight * 2);
    if (node) Wires.pulse(node);
    if (e.k === 'tool') Wires.pulse('tools');
    if (e.k === 'prompt') Wires.pulse('core');
    if (toolCat) Wires.pulse('terrain');
  }

  larp.onEvents(({ events, replay }) => {
    replaying = !!replay;
    for (const e of events) handle(e, replay);
    replaying = false;
    // a replayed history must not leave the dashboard "working"
    if (replay && /^(THINKING|RUN)/.test(S.status)) {
      S.pending.clear();
      S.status = 'AWAITING INPUT';
    }
    if (replay) log('sys', 'SYS', `replayed ${events.length} events from the resumed session`);
  });

  larp.onSession((s) => {
    const isNew = !session || session.key !== s.key;
    session = s;
    if (isNew) {
      S = fresh();
      git = null;
      logEl.textContent = '';
      term.reset();
      dropTurn();
      Graph3D.clear();
      Scenes3D.City.clear();
      Scenes3D.Helix.clear();
      Galaxy.clear();
      galaxyDeep = false;
      deepAt = 0;
      scan();
      log('sys', 'SYS', s.missing ? 'claude code not found: opened a shell instead' : `${s.mode === 'continue' ? 'continuing' : 'new session'} in ${shortPath(s.cwd)}`);
      Wires.pulse('session');
      Field.burst(0.5);
    }
    if (s.status === 'exited') {
      S.status = 'EXITED';
      S.pending.clear();
      endTurn(true);
      if (exitShownFor !== s.key) {
        exitShownFor = s.key;
        log('sys', 'SYS', `process exited (code ${s.exitCode})`);
        term.write('\r\n\x1b[2m[larp] session ended: press NEW or CONTINUE in the top bar\x1b[0m\r\n');
      }
    } else if (s.status === 'failed') S.status = 'FAILED';
    else if (s.missing) S.status = 'NOT INSTALLED';
    else if (S.status === 'STARTING') S.status = 'READY';
    $('demo-badge').hidden = !s.demo;
    dirty = true;
  });

  larp.onGit((g) => {
    if (git && g.repo && git.dirty !== g.dirty) {
      Wires.pulse('repo');
      scanSoon();
    }
    git = g;
    dirty = true;
  });

  larp.onHost((h) => {
    $('host-cpu').textContent = pct(h.cpu);
    $('host-mem').textContent = pct(h.mem);
    $('host-cpu-bar').style.width = pct(h.cpu);
    $('host-mem-bar').style.width = pct(h.mem);
  });

  /* ---------- rendering ---------- */

  /** A changed value "decodes" into place: random glyphs resolving left to right. */
  const decoding = new WeakMap();
  function decode(n, text) {
    cancelAnimationFrame(decoding.get(n));
    if (reducedMotion || document.hidden || !text) {
      n.textContent = text;
      return;
    }
    const t0 = performance.now();
    const dur = Math.min(520, 180 + text.length * 16);
    n.classList.add('fx');
    const step = (now) => {
      const u = Math.min(1, (now - t0) / dur);
      const keep = Math.floor(u * text.length);
      let s = text.slice(0, keep);
      for (let i = keep; i < text.length; i++) s += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      n.textContent = s;
      if (u < 1) decoding.set(n, requestAnimationFrame(step));
      else n.classList.remove('fx');
    };
    decoding.set(n, requestAnimationFrame(step));
  }

  function setText(id, text, cls) {
    const n = $(id);
    text = String(text);
    if (n.dataset.value !== text) {
      const first = n.dataset.value === undefined;
      n.dataset.value = text;
      if (first || replaying) n.textContent = text;
      else decode(n, text);
    }
    if (cls !== undefined) n.className = 'v' + (n.classList.contains('n') ? ' n' : '') + (cls ? ' ' + cls : '');
  }

  /** Top-bar counters roll up to their value instead of jumping. */
  const counters = new Map();
  function countTo(id, value, format) {
    const c = counters.get(id) || { shown: 0, target: 0, format: format || String };
    c.target = value;
    counters.set(id, c);
  }
  function tickCounters() {
    for (const [id, c] of counters) {
      if (c.shown === c.target) continue;
      const gap = c.target - c.shown;
      c.shown = Math.abs(gap) < 1 || reducedMotion ? c.target : c.shown + gap * 0.18;
      $(id).textContent = c.format(Math.round(c.shown));
    }
  }

  function fill(listEl, rows, emptyText) {
    listEl.textContent = '';
    if (!rows.length) listEl.append(el('div', 'empty', emptyText));
    else listEl.append(...rows);
  }

  function render() {
    dirty = false;
    const busy = /^(THINKING|RUN)/.test(S.status);
    const off = /^(EXITED|FAILED|NOT INSTALLED)/.test(S.status);

    // top bar
    countTo('s-turns', S.turns);
    countTo('s-tools', S.tools);
    countTo('s-edits', S.edits);
    countTo('s-agents', S.agentsTotal);
    countTo('s-tokens', S.tokIn + S.tokOut + S.cacheWrite, fmtK);
    const live = $('live');
    live.className = 'live' + (busy ? ' busy' : off ? ' off' : '');
    live.lastElementChild.textContent = S.status;
    $('term-node').classList.toggle('busy', busy);
    updateLoader();
    Viz.Core.pending = S.pending.size;
    const g3 = Graph3D.stats;
    const pendingByCat = {};
    for (const p of S.pending.values()) pendingByCat[p.cat] = (pendingByCat[p.cat] || 0) + 1;
    Scenes3D.Orrery.set({ cats: S.cats, pending: pendingByCat, ctx: S.ctx, window: S.ctx > 200000 ? 1000000 : 200000, agents: S.agents });
    Galaxy.setAgents(S.agents);
    $('graph-n').textContent =
      scene === 'graph' ? `${g3.nodes} nodes · ${g3.touched} touched`
      : scene === 'city' ? `${Scenes3D.City.count} buildings · ${S.files.size} touched`
      : scene === 'helix' ? `${Scenes3D.Helix.count} events · ${S.turns} turns`
      : scene === 'orbit' ? `${S.tools} calls · ${S.pending.size} running`
      : `${Galaxy.count} stars · ${Galaxy.arms} arms · ${S.files.size} visited`;

    // repo
    const cwd = session ? session.cwd : info.cwd;
    setText('repo-path', shortPath(cwd));
    $('repo-path').title = cwd;
    if (git && git.repo) {
      setText('repo-branch', git.branch);
      setText('repo-remote', git.remote || 'none');
      setText('repo-dirty', git.dirty ? `${git.dirty} changed` : 'clean', git.dirty ? 'warn' : 'ok');
      setText('repo-last', git.last || 'no commits');
    } else {
      setText('repo-branch', git ? 'not a git repo' : '—');
      setText('repo-remote', '—');
      setText('repo-dirty', '—', '');
      setText('repo-last', '—');
    }

    // session
    setText('ses-status', S.status, busy ? 'warn' : off ? 'err' : 'ok');
    setText('ses-id', session ? (session.transcript || session.id || 'pending').slice(0, 8) : '—');
    setText('ses-cli', session && session.missing ? 'not installed' : 'v' + (S.version || (session && session.claudeVersion) || '…'));
    setText('ses-mode', session ? session.mode : '—');
    $('host-pty').textContent = session && session.pid ? 'pty pid ' + session.pid : '';

    // context
    setText('ctx-model', S.model ? S.model.replace(/^claude-/, '') : '—');
    const windowSize = S.ctx > 200000 ? 1000000 : 200000;
    setText('ctx-size', S.ctx ? fmtK(S.ctx) : '—');
    $('ctx-bar').style.width = pct(S.ctx / windowSize);
    setText('ctx-out', S.tokOut ? fmtK(S.tokOut) + ' tok' : '—');
    const seen = S.cacheRead + S.cacheWrite + S.tokIn;
    setText('ctx-cache', seen ? pct(S.cacheRead / seen) : '—');

    // tools
    for (const c of ['READ', 'EDIT', 'SHELL', 'SEARCH', 'WEB']) $('t-' + c).textContent = S.cats[c];
    $('t-MCP').textContent = S.cats.MCP + S.cats.OTHER;
    $('tools-run').textContent = S.pending.size ? `${S.pending.size} running` : 'idle';

    // tasks
    const done = S.tasks.filter((t) => t.s === 'completed').length;
    $('tasks-n').textContent = `${done}/${S.tasks.length}`;
    fill(
      $('tasks'),
      S.tasks.slice(0, 8).map((t) => {
        const row = el('div', 'item' + (t.s === 'completed' ? ' done' : t.s === 'in_progress' ? ' now' : ''));
        row.append(el('span', 'box', t.s === 'completed' ? '[x]' : t.s === 'in_progress' ? '[>]' : '[ ]'), el('span', 'txt', t.c));
        return row;
      }),
      'no plan yet'
    );

    // subagents
    $('agents-n').textContent = String(S.agentsTotal);
    fill(
      $('agents'),
      S.agents.slice(0, 4).map((a) => {
        const row = el('div', 'agent ' + a.state);
        const top = el('div', 'top');
        top.append(el('span', 'txt', a.desc), el('span', a.state === 'working' ? 'warn' : a.state === 'failed' ? 'err' : 'ok', a.state));
        const bar = el('div', 'bar');
        bar.append(el('i'));
        row.append(top, bar);
        return row;
      }),
      'none spawned'
    );

    // files
    $('files-n').textContent = `+${S.add} −${S.del}`;
    const files = [...S.files.entries()].sort((a, b) => b[1].order - a[1].order).slice(0, 7);
    fill(
      $('files'),
      files.map(([name, f], n) => {
        const row = el('div', 'item' + (n === 0 ? ' fresh' : ''));
        row.append(el('span', 'txt', name));
        if (f.add || f.del) row.append(el('span', 'add', '+' + f.add), el('span', 'del', '−' + f.del));
        else row.append(el('span', 'rd', 'read'));
        return row;
      }),
      'nothing touched yet'
    );

    // bottom: tool bars
    const total = Math.max(1, S.tools);
    const running = new Set([...S.pending.values()].map((p) => p.cat));
    fill(
      $('toolbars'),
      BAR_CATS.map((c) => {
        const share = S.cats[c] / total;
        const cells = Math.round(share * 12);
        const row = el('div', 'tb');
        row.append(
          el('span', 'n', c),
          el('span', 'bar', '#'.repeat(cells) + '·'.repeat(12 - cells)),
          el('span', 'pct', pct(share)),
          el('span', 'st' + (running.has(c) ? ' run' : ''), running.has(c) ? 'RUN' : S.cats[c] ? 'DONE' : 'IDLE')
        );
        return row;
      }),
      ''
    );

    // bottom: checks
    const check = (ok, text) => {
      const row = el('div', ok ? '' : 'no');
      row.append(el('span', 'tag', ok ? '[OK]' : '[--]'), document.createTextNode(text));
      return row;
    };
    fill(
      $('checks'),
      [
        session && session.missing
          ? check(false, 'claude code not found on this machine')
          : check(true, `claude code ${(session && session.claudeVersion) || ''} · your own login and settings`),
        check(!!(session && session.transcript), session && session.transcript ? `transcript linked · ${session.transcript.slice(0, 8)}` : 'transcript links on first prompt'),
        check(!!(git && git.repo), git && git.repo ? `git repo · ${git.branch}` : 'folder is not a git repo'),
      ],
      ''
    );

    renderMetrics();
  }

  function renderMetrics() {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 60000) stamps.shift();
    $('trace-stats').textContent = `EVENTS/MIN ${stamps.length} · PENDING ${S.pending.size} · ERRORS ${S.errors}`;
    const rows = [
      ['TURNS', S.turns],
      ['TOOL CALLS', S.tools],
      ['FILES TOUCHED', S.files.size],
      ['LINES +/−', `+${S.add} −${S.del}`],
      ['TOKENS OUT', fmtK(S.tokOut)],
      ['CACHE READ', fmtK(S.cacheRead)],
      ['EVENTS / MIN', stamps.length],
    ];
    fill(
      $('metrics'),
      rows.map(([k, v]) => {
        const row = el('div', 'mt');
        row.append(el('span', 'k', k), el('span', 'dots'), el('span', 'v', String(v)));
        return row;
      }),
      ''
    );
  }

  /* ---------- trace strip + histogram ---------- */

  function drawTrace() {
    const c = traceCv;
    if (!c.cssW) return;
    const g = c.getContext('2d');
    const ink = css('--ink');
    const hot = css('--ink-hot');
    g.clearRect(0, 0, c.cssW, c.cssH);
    const n = trace.length;
    for (let i = 0; i < n; i++) {
      const col = trace[i];
      const x = c.cssW - (n - i) * STEP;
      if (x < -STEP) continue;
      let seed = col.seed;
      const dots = 1 + Math.min(10, Math.round(col.w * 3));
      for (let k = 0; k < dots; k++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const y = 2 + (seed / 4294967296) * (c.cssH - 4);
        g.fillStyle = col.w > 0 ? `rgba(${hot},${0.55 + Math.min(0.4, col.w * 0.15)})` : `rgba(${ink},0.28)`;
        g.fillRect(x, y, col.w > 0 ? 2 : 1.4, col.w > 0 ? 2 : 1.4);
      }
    }
  }

  function drawHist() {
    const c = histCv;
    if (!c.cssW) return;
    const g = c.getContext('2d');
    const ink = css('--ink');
    g.clearRect(0, 0, c.cssW, c.cssH);
    const max = Math.max(4, ...buckets);
    const bw = c.cssW / buckets.length;
    const d = Math.min(4, bw * 0.45); // extrusion depth: each bar is a little box
    buckets.forEach((v, i) => {
      const live = i === buckets.length - 1;
      const h = Math.max(1, (v / max) * (c.cssH - 2 - d));
      const x = i * bw;
      const wd = Math.max(1, bw - 1.5 - d);
      const y = c.cssH - h;
      g.fillStyle = `rgba(${ink},${live ? 0.95 : 0.5})`;
      g.fillRect(x, y, wd, h);
      g.fillStyle = `rgba(${ink},${live ? 1 : 0.8})`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + d, y - d);
      g.lineTo(x + wd + d, y - d);
      g.lineTo(x + wd, y);
      g.closePath();
      g.fill();
      g.fillStyle = `rgba(${ink},0.25)`;
      g.beginPath();
      g.moveTo(x + wd, y);
      g.lineTo(x + wd + d, y - d);
      g.lineTo(x + wd + d, c.cssH - d);
      g.lineTo(x + wd, c.cssH);
      g.closePath();
      g.fill();
    });
  }

  setInterval(() => {
    trace.push({ w: traceWeight, seed: (Math.random() * 4294967296) >>> 0 });
    traceWeight = 0;
    const max = Math.ceil((traceCv.cssW || 1200) / STEP) + 2;
    while (trace.length > max) trace.shift();
    drawTrace();
  }, 140);

  setInterval(() => {
    buckets.shift();
    buckets.push(0);
    drawHist();
  }, 2500);

  setInterval(() => {
    const now = Date.now();
    const up = session ? span(now - session.startedAt) : '00:00';
    $('s-time').textContent = up;
    updateLoader();
    $('ses-up').textContent = up;
    const d = new Date(now);
    $('sub-right').textContent = `${norm(session ? session.cwd : info.cwd)}  ·  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    renderMetrics();
    drawHist();
  }, 1000);

  /** One frame of the active 3D scene and the two side instruments. */
  function drawViz(now) {
    if (view !== 'term') {
      if (scene === 'graph') Graph3D.frame(now);
      else if (scene === 'city') Scenes3D.City.frame(now);
      else if (scene === 'helix') Scenes3D.Helix.frame(now);
      else if (scene === 'orbit') Scenes3D.Orrery.frame(now);
      else Galaxy.frame(now);
    }
    Viz.Core.frame(now);
    Viz.Terrain.frame(now);
    drawLoader(now);
  }

  let vizLast = 0;
  (function loop(now) {
    requestAnimationFrame(loop);
    if (Field.frame % 5 === 0) $('s-frame').textContent = Field.frame;
    if (dirty) render();
    // the 3D instruments run at ~60 fps at most, and not at all while hidden
    if (document.hidden || now - vizLast < 15) return;
    vizLast = now;
    drawViz(now);
    tickCounters();
    if (Field.frame % 12 === 0) $('core-n').textContent = pct(Viz.Core.load);
  })(performance.now());

  /* ---------- controls ---------- */

  const start = (mode) => larp.start({ mode, cols: term.cols, rows: term.rows });
  $('b-new').addEventListener('click', () => {
    start('new');
    term.focus();
  });
  $('b-cont').addEventListener('click', () => {
    start('continue');
    term.focus();
  });
  $('b-repo').addEventListener('click', async () => {
    await larp.openRepo();
    term.focus();
  });
  $('b-view').addEventListener('click', () => {
    setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length], true);
    if (view !== 'graph') term.focus();
  });
  $('b-theme').addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length], true);
    term.focus();
  });

  $('app-ver').textContent = info.appVersion;
  $('foot-right').textContent = `LARP ${info.appVersion} · ${info.platform} ${info.arch} · NOT AFFILIATED WITH ANTHROPIC`;

  /* ---------- boot ---------- */

  start('new');
  term.focus();

  const boot = $('boot');
  const bootLog = $('boot-log');
  // Panels wipe in one after another when the boot screen hands over.
  [...document.querySelectorAll('.col.left .node')].forEach((n, i) => n.style.setProperty('--i', i));
  [...document.querySelectorAll('#center .node')].forEach((n, i) => n.style.setProperty('--i', 2 + i * 2));
  [...document.querySelectorAll('.col.right .node')].forEach((n, i) => n.style.setProperty('--i', 3 + i));
  [...document.querySelectorAll('#bottom .panel')].forEach((n, i) => n.style.setProperty('--i', 6 + i));
  const handOver = () => {
    boot.classList.add('gone');
    document.body.classList.add('ready');
  };
  boot.addEventListener('click', handOver);
  const lines = [
    `LARP / AGENT.CONTROL ${info.appVersion}`,
    '',
    `[OK] HOST      ${info.platform} ${info.arch}`,
    info.claudeFound ? '[OK] CLAUDE    CODE CLI FOUND' : '[!!] CLAUDE    CODE CLI NOT FOUND',
    `[OK] FOLDER    ${shortPath(info.cwd)}`,
    `[OK] PTY       ${term.cols}×${term.rows}`,
    '[OK] BUS       TRANSCRIPT LINK ARMED',
    '',
    '> HANDING CONTROL TO THE AGENT',
  ];
  for (const l of lines) {
    bootLog.textContent += l + '\n';
    await sleep(70);
  }
  await sleep(420);
  handOver();
})();
