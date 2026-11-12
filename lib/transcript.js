'use strict';
/*
 * Follows the session transcript that Claude Code writes to
 * ~/.claude/projects/<project>/<session-id>.jsonl and turns each new line into
 * small, display-ready events for the dashboard. Read-only: LARP never writes
 * to these files.
 */
const fs = require('fs');
const path = require('path');

const countLines = (s) => (s ? String(s).split('\n').length : 0);

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Keep only what the panels show; tool inputs can be huge. */
function slimInput(name, input) {
  input = input || {};
  switch (name) {
    case 'Edit':
      return { file: input.file_path, add: countLines(input.new_string), del: countLines(input.old_string) };
    case 'MultiEdit': {
      let add = 0;
      let del = 0;
      for (const e of input.edits || []) {
        add += countLines(e.new_string);
        del += countLines(e.old_string);
      }
      return { file: input.file_path, add, del };
    }
    case 'Write':
      return { file: input.file_path, add: countLines(input.content), del: 0 };
    case 'NotebookEdit':
      return { file: input.notebook_path, add: countLines(input.new_source), del: 0 };
    case 'Read':
      return { file: input.file_path };
    case 'Bash':
    case 'PowerShell':
      return { cmd: clip(input.command, 160), desc: clip(input.description, 80) };
    case 'Grep':
    case 'Glob':
      return { pattern: clip(input.pattern, 80) };
    case 'WebFetch':
      return { url: clip(input.url, 120) };
    case 'WebSearch':
      return { query: clip(input.query, 100) };
    case 'Task':
    case 'Agent':
      return { desc: clip(input.description, 80), type: input.subagent_type || 'agent' };
    case 'TodoWrite':
      return { todos: (input.todos || []).slice(0, 40).map((t) => ({ c: clip(t.content, 90), s: t.status })) };
    case 'TaskCreate':
      return { subject: clip(input.subject || input.title || input.content || input.description, 90) };
    case 'TaskUpdate':
      return {
        taskId: String(input.taskId ?? input.id ?? ''),
        status: input.status,
        subject: input.subject ? clip(input.subject, 90) : undefined,
      };
    default: {
      let raw = '';
      try {
        raw = JSON.stringify(input);
      } catch {
        /* unserialisable input: show nothing */
      }
      return { raw: clip(raw, 100) };
    }
  }
}

function userText(text, out) {
  const t = String(text || '').trim();
  if (!t) return;
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
  if (cmd) {
    out.push({ k: 'command', text: cmd[1].trim() });
    return;
  }
  if (t.startsWith('[Request interrupted')) {
    out.push({ k: 'interrupt' });
    return;
  }
  if (t.startsWith('<')) return; // blocks injected by the harness, not typed by the user
  out.push({ k: 'prompt', text: clip(t, 200) });
}

/** One transcript line -> zero or more dashboard events. */
function parseEntry(o) {
  if (!o || typeof o !== 'object' || o.isSidechain) return [];
  const out = [];
  const m = o.message;

  if (o.type === 'assistant' && m) {
    if (m.usage) {
      out.push({
        k: 'usage',
        id: m.id || o.uuid,
        model: m.model,
        stop: m.stop_reason || null,
        u: {
          in: m.usage.input_tokens || 0,
          out: m.usage.output_tokens || 0,
          cr: m.usage.cache_read_input_tokens || 0,
          cw: m.usage.cache_creation_input_tokens || 0,
        },
      });
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push({ k: 'text', text: clip(b.text, 200) });
      else if (b.type === 'thinking') out.push({ k: 'think' });
      else if (b.type === 'tool_use') out.push({ k: 'tool', id: b.id, name: b.name, input: slimInput(b.name, b.input) });
    }
  } else if (o.type === 'user' && m && !o.isMeta) {
    const c = m.content;
    if (typeof c === 'string') userText(c, out);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_result') out.push({ k: 'result', id: b.tool_use_id, err: !!b.is_error });
        else if (b.type === 'text') userText(b.text, out);
      }
    }
  } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
    out.push({ k: 'system', text: 'context compacted' });
  }

  if (!out.length) return out;
  const ts = o.timestamp ? Date.parse(o.timestamp) : Date.now();
  for (const e of out) {
    e.ts = Number.isFinite(ts) ? ts : Date.now();
    if (o.gitBranch) e.branch = o.gitBranch;
    if (o.version) e.version = o.version;
    if (o.sessionId) e.sessionId = o.sessionId;
  }
  return out;
}

/** Claude Code names a project folder after its path, non-alphanumerics as dashes. */
const projectFolder = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

class TranscriptWatcher {
  /**
   * @param {object} o
   * @param {string} o.root       ~/.claude/projects
   * @param {string} o.cwd        folder the session runs in
   * @param {string} [o.sessionId] known id (new sessions); omitted when continuing
   * @param {number} o.startedAt  ms timestamp of the spawn
   * @param {(events: object[], replay: boolean) => void} o.onEvents
   * @param {(file: string) => void} [o.onLink]
   */
  constructor(o) {
    Object.assign(this, o);
    this.file = null;
    this.dir = null;
    this.offset = 0;
    this.links = 0;
    this.firstRead = true;
    this.lastGrow = Date.now();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* a file vanished or is mid-write: try again next tick */
      }
    }, 400);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (!this.file) this.locate();
    if (!this.file) return;
    this.read();
    this.followNewSession();
  }

  expectedDir() {
    return path.join(this.root, projectFolder(this.cwd));
  }

  newestIn(dir, minMtime) {
    let best = null;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.mtimeMs < minMtime) continue;
      if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs, born: st.birthtimeMs };
    }
    return best;
  }

  locate() {
    if (this.sessionId) {
      const name = this.sessionId + '.jsonl';
      const expected = path.join(this.expectedDir(), name);
      if (fs.existsSync(expected)) return this.link(expected);
      // The folder naming is Claude Code's own business: if ours is off, search.
      let dirs = [];
      try {
        dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        return;
      }
      for (const d of dirs) {
        const p = path.join(this.root, d.name, name);
        if (fs.existsSync(p)) return this.link(p);
      }
      return;
    }
    // Continuing: the session being resumed is the newest one for this folder.
    const best = this.newestIn(this.expectedDir(), 0);
    if (best) this.link(best.p);
  }

  link(p) {
    this.file = p;
    this.dir = path.dirname(p);
    this.offset = 0;
    this.links++;
    this.firstRead = true;
    this.lastGrow = Date.now();
    if (this.onLink) this.onLink(p);
  }

  /**
   * /clear and /resume start a new transcript file. Once ours goes quiet, follow
   * a newer file in the same folder — but only one written by the terminal CLI,
   * so a desktop or IDE session open on the same folder is never picked up.
   */
  followNewSession() {
    if (Date.now() - this.lastGrow < 2500) return;
    const best = this.newestIn(this.dir, Math.max(this.startedAt, this.lastGrow));
    if (!best || best.p === this.file || best.born < this.startedAt) return;
    if (!this.isCliTranscript(best.p)) return;
    this.link(best.p);
  }

  isCliTranscript(p) {
    let head = '';
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf8', 0, n);
    } catch {
      return false;
    }
    const m = /"entrypoint":"([^"]+)"/.exec(head);
    return !m || m[1] === 'cli';
  }

  read() {
    const st = fs.statSync(this.file);
    if (st.size < this.offset) this.offset = 0;
    if (st.size === this.offset) return;
    const len = st.size - this.offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    // Consume whole lines only, cut on the newline byte so a multi-byte
    // character split across two reads is never decoded in halves.
    const end = buf.lastIndexOf(10, n - 1);
    if (end < 0) return;
    this.offset += end + 1;
    this.lastGrow = Date.now();

    const events = [];
    for (const line of buf.toString('utf8', 0, end).split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      for (const e of parseEntry(o)) events.push(e);
    }
    // When continuing, the first read of the first file is the old conversation:
    // replay it silently (counters fill in, nothing animates).
    const replay = this.firstRead && !this.sessionId && this.links === 1;
    this.firstRead = false;
    if (events.length) this.onEvents(events, replay);
  }
}

module.exports = { TranscriptWatcher, parseEntry, projectFolder };
