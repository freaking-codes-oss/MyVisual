/* ════════════════════════════════════════════════════════════════════════
   SQL Playground & Visualizer — application logic
   ─────────────────────────────────────────────────────────────────────────
   MODULE MAP
     §1  Globals, config & tiny helpers
     §2  Syntax highlighter (SQL / JS / Python) for the layered editors
     §3  Engine bootstrap  — probes CDNs, boots sql.js (SQLite → WASM)
     §4  Engine wrapper    — the single choke point between the REAL sql.js
                             database and everything else:
                             split → run → extract schema → diff → notify UI
     §5  Schema extraction — sqlite_master + PRAGMA table_info /
                             foreign_key_list → plain JS model
     §6  Visualizer·Schema — ER diagram: auto-layout, draggable cards, SVG
                             foreign-key edges, pan/zoom world
     §7  Visualizer·Data   — live table rows + green "affected row" flash
     §8  Output rendering  — result grids, engine activity log, backend log
     §9  Backend simulation— fake Node/Python driver that drives the REAL
                             engine row-by-row (visualizer fills live)
     §10 Tutorials         — guided tasks, auto-detection & celebrations
     §11 UI wiring & init
   ════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ════════════════ §1  GLOBALS, CONFIG & TINY HELPERS ════════════════ */

// engine sources: several CDNs are probed at boot; the first reachable
// one wins so the app also works from file:// or behind strict proxies.
const SQLJS_SOURCES = [
  'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/',
  'https://unpkg.com/sql.js@1.13.0/dist/',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/',
];
const SQLJS_VER_QUERY = 'SELECT sqlite_version() AS v';

// pixel metrics shared by the ER diagram renderer and its CSS
const ER = { W: 218, HEAD: 36, ROW: 25, XPAD: 56, YMIN: 30, XGAP: 190, YGAP: 44 };
const ZOOM_MIN = 0.25, ZOOM_MAX = 2.2;

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const el = (id) => document.getElementById(id);

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function nowTag() {                      // console timestamp HH:MM:SS
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function sqlLit(value) {                 // escape a JS value into an SQL literal
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/* ---------- global application state -------------------------------------
   `state.db` is the one-and-only sql.js Database instance.  Every render
   (ER diagram, live data, row counts, task detection) is derived from it —
   there is no shadow model that could drift out of sync with the engine. */
const state = {
  db: null,                 // sql.js Database (the REAL engine)
  SQLModule: null,          // { SQL } class holder, set at boot — used to rebuild DBs
  engineReady: false,
  engineVersion: null,
  sampleLoaded: false,      // demo rows present on a fresh-ish db
  tables: new Map(),        // name → Table model (see §5)
  layout: {},               // name → {x, y} card positions (ER canvas)
  view: { k: 1, x: 24, y: 20 },   // zoom / pan of the ER world
  viewTouched: false,       // user panned/zoomed → stop auto-fitting
  needsFit: false,          // diagram changed → fit it into view when visible
  drag: null,               // active card drag {name, dx, dy}
  pan: null,                // active canvas pan {sx, sy, vx, vy}
  driverToken: 0,           // cancels a running backend simulation
  driverRunning: false,
  taskDone: [false, false, false, false],
};

const ui = {};              // cached element handles, filled in uiCache()

/* ---------- icon helper for dynamically generated markup ---------------- */
function icon(name, cls) {              // <i data-lucide="…"> (refreshed later)
  return '<i data-lucide="' + name + '" class="ic' + (cls ? ' ' + cls : '') + '"></i>';
}
function refreshIcons(root) {           // (re)hydrate lucide icons after DOM changes
  try { if (window.lucide) lucide.createIcons({ root: root || document }); } catch (_) { /* cosmetic */ }
}

/* ---------- toast + confetti (success animation) ------------------------ */
function toast(msg, type) {
  const host = el('toastHost');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info');
  const ic = type === 'ok' ? 'circle-check' : type === 'err' ? 'circle-x' : type === 'warn' ? 'triangle-alert' : 'circle-info';
  t.innerHTML = '<span class="toast-ic">' + icon(ic) + '</span><span class="toast-msg">' + msg + '</span>';
  host.appendChild(t);
  refreshIcons(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, type === 'err' ? 6500 : 4200);
}

function celebrate(rectEl) {            // confetti burst anchored at an element
  const host = el('confettiHost');
  const r = rectEl ? rectEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 3, width: 10, height: 10 };
  const colors = ['#34d399', '#22d3ee', '#f59e0b', '#fb923c', '#a78bfa', '#f472b6', '#60a5fa'];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('span');
    p.className = 'confetti-piece';
    const angle = rand(0, Math.PI * 2), dist = rand(60, 300);
    p.style.left = (r.left + r.width / 2) + 'px';
    p.style.top = (r.top + r.height / 2) + 'px';
    p.style.background = colors[(Math.random() * colors.length) | 0];
    p.style.setProperty('--cx', (Math.cos(angle) * dist) + 'px');
    p.style.setProperty('--cy', (Math.sin(angle) * dist - 90) + 'px');
    p.style.setProperty('--rot', rand(-540, 540) + 'deg');
    host.appendChild(p);
    setTimeout(() => p.remove(), 1600);
  }
}

/* ════════════════ §2  SYNTAX HIGHLIGHTER ═══════════════════════════════
   Three tiny tokenisers (SQL / JavaScript / Python) produce escaped HTML
   for the <pre> layer that sits underneath a transparent-text <textarea>. */
const SQL_KEYWORDS = new Set(('create table alter drop insert into update delete from select where ' +
  'join inner left right full outer cross on using as and or not null is in like between exists ' +
  'primary foreign key references unique default check constraint index group by having order ' +
  'asc desc limit offset union all except intersect case when then else end distinct set add ' +
  'column values with recursive begin commit rollback transaction explain pragma replace cascade ' +
  'returning over partition window rows range excluding current local temp temporary if for ' +
  'instead trigger view materialized vacuum revert reindex').split(' '));
const SQL_TYPES = new Set(('integer int bigint smallint tinyint real float double numeric decimal ' +
  'boolean text varchar char nvarchar blob date datetime timestamp time json uuid serial ' +
  'auto_increment boolean').split(' '));
const SQL_FNS = new Set(('count sum avg min max round abs random length upper lower trim substr ' +
  'replace ifnull coalesce nullif datetime date time julianday strftime printf cast typeof ' +
  'unicode instr ltrim rtrim hex zeroblob group_concat total changes last_insert_rowid ' +
  'current_timestamp current_date current_time').split(' '));
const JS_KEYWORDS = new Set(('import export from const let var function return async await ' +
  'if else for while of in new class extends super this typeof instanceof try catch finally ' +
  'throw switch case break continue default do delete void yield static get set true false ' +
  'null undefined').split(' '));
const PY_KEYWORDS = new Set(('import from def return if elif else for while in not and or is ' +
  'None True False class try except finally raise with as lambda pass break continue global ' +
  'del assert yield nonlocal match case').split(' '));
const PY_BUILTINS = new Set(('print len range str int float list dict set tuple type open ' +
  'enumerate zip sorted map filter input isinstance super object').split(' '));

function makeSpec(keywords, types, fns) {
  return {
    lineCmts: keywords === PY_KEYWORDS ? ['#'] : ['--', '//'],
    blockCmts: [['/*', '*/']],
    quotes: keywords === PY_KEYWORDS ? ["'", '"'] : ['"', "'", '`'],
    kw: keywords, types: types || new Set(), fns: fns || new Set(), fnAny: !!(fns && fns.size),
  };
}
const SPECS = {
  sql: makeSpec(SQL_KEYWORDS, SQL_TYPES, SQL_FNS),
  js: makeSpec(JS_KEYWORDS, new Set(['undefined', 'null', 'true', 'false'])),
  py: makeSpec(PY_KEYWORDS, PY_BUILTINS, PY_BUILTINS),
};

function highlight(source, lang) {
  const sp = SPECS[lang] || SPECS.sql;
  const out = [];
  let i = 0, plain = '';
  const flush = () => { if (plain) { out.push(escHtml(plain)); plain = ''; } };
  const span = (cls, text) => { flush(); out.push('<span class="' + cls + '">' + escHtml(text) + '</span>'); };

  while (i < source.length) {
    const ch = source[i];
    // line comment
    const lc = sp.lineCmts.find((c) => source.startsWith(c, i));
    if (lc) {
      const nl = source.indexOf('\n', i);
      span('t-cmt', source.slice(i, nl < 0 ? source.length : nl));
      i = nl < 0 ? source.length : nl; continue;
    }
    // block comment
    const bc = sp.blockCmts.find(([o]) => source.startsWith(o, i));
    if (bc) {
      const end = source.indexOf(bc[1], i + bc[0].length);
      span('t-cmt', source.slice(i, (end < 0 ? source.length : end) + bc[1].length));
      i = end < 0 ? source.length : end + bc[1].length; continue;
    }
    // string literal
    const q = sp.quotes.find((qq) => source.startsWith(qq, i));
    if (q) {
      let j = i + q.length, prev = '';
      while (j < source.length) {
        const c = source[j];
        if (c === '\\' && lang !== 'sql') { j += 2; continue; }        // backslash escapes (js/py)
        if (c === q && lang === 'sql' && source[j + 1] === q) { j += 2; continue; } // '' escape
        if (c === q) break;
        j++;
      }
      span('t-str', source.slice(i, Math.min(j + 1, source.length)));
      i = Math.min(j + 1, source.length); continue;
    }
    // number
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      let j = i;
      while (j < source.length && /[0-9a-fA-FxX_.]/.test(source[j])) j++;
      span('t-num', source.slice(i, j)); i = j; continue;
    }
    // word / identifier
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j), low = word.toLowerCase();
      const isCall = /^\s*\(/.test(source.slice(j));     // followed by '(' → function
      if (sp.kw.has(low)) span('t-kw', word);
      else if (sp.types.has(low)) span('t-kw2', word);
      else if (sp.fns.has(low) && isCall) span('t-fn', word);
      else if (lang === 'sql' && SQL_FNS.has(low) && isCall) span('t-fn', word);
      else span('t-id', word);
      i = j; continue;
    }
    // punctuation vs operator
    if ('()[]{};,'.includes(ch)) { span('t-punc', ch); i++; continue; }
    if ('=<>!+-*/%&|~?:'.includes(ch)) { span('t-op', ch); i++; continue; }
    plain += ch; i++;
  }
  flush();
  return out.join('');
}

/* Bind a textarea to its highlight <pre> — shared scroll offset sync. */
function bindEditor(areaId, preId, lang) {
  const area = el(areaId), pre = el(preId);
  const paint = () => { pre.innerHTML = highlight(area.value, lang); };
  const sync = () => { pre.style.transform = 'translate(' + (-area.scrollLeft) + 'px,' + (-area.scrollTop) + 'px)'; };
  area.addEventListener('input', paint);
  area.addEventListener('scroll', sync);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {    // indent / outdent selection
      e.preventDefault();
      const s = area.selectionStart, t = area.selectionEnd;
      const sel = area.value.slice(s, t);
      if (!sel) {
        area.value = area.value.slice(0, s) + (e.shiftKey ? '' : '  ') + area.value.slice(t);
        area.selectionStart = area.selectionEnd = e.shiftKey ? s : s + 2;
      } else {
        const lines = sel.split('\n');
        const indented = e.shiftKey
          ? lines.map((l) => (l.startsWith('  ') ? l.slice(2) : l.startsWith(' ') ? l.slice(1) : l)).join('\n')
          : lines.map((l) => (l ? '  ' + l : l)).join('\n');
        area.value = area.value.slice(0, s) + indented + area.value.slice(t);
        area.selectionStart = s;
        area.selectionEnd = s + indented.length;
      }
      paint(); sync();
    }
  });
  paint(); sync();
  return { area, pre, paint, sync };
}

/* ════════════════ §3  ENGINE BOOTSTRAP (sql.js) ═══════════════════════ */
function setEngineStatus(text, cls) {
  el('bootStatus').textContent = text;
  if (cls === 'err') {
    el('bootSpinner').hidden = true;
    el('bootRetry').hidden = false;
    el('bootNote').hidden = false;
  }
}

async function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function probeUrl(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', mode: 'cors' });
    if (r.ok) return true;
  } catch (_) { /* fall through to GET */ }
  try {
    const r = await fetch(url, { method: 'GET', mode: 'cors' });
    if (r.ok) { if (r.body && r.body.cancel) r.body.cancel(); return true; }
  } catch (_) { /* unreachable */ }
  return false;
}

async function loadSqlJs() {
  // probe CDNs → pick first that answers → inject its loader → init WASM
  for (const base of SQLJS_SOURCES) {
    try {
      const reachable = await probeUrl(base + 'sql-wasm.js');
      if (!reachable) continue;
      const loaded = await loadScript(base + 'sql-wasm.js');
      if (!loaded || typeof window.initSqlJs !== 'function') continue;
      const SQL = await window.initSqlJs({
        locateFile: (file) => base + file,        // fetch the .wasm from same CDN
      });
      return { SQL, base };
    } catch (_) { /* try the next mirror */ }
  }
  return null;
}

async function bootEngine() {
  // reset the overlay to its "loading" state (also used by Retry)
  el('bootSpinner').hidden = false;
  el('bootRetry').hidden = true;
  el('bootNote').hidden = true;
  setEngineStatus('Fetching sql.js (SQLite → WebAssembly)…');
  const ok = await loadSqlJs();
  if (!ok) { setEngineStatus('Engine load failed — could not reach a CDN.', 'err'); return; }
  try {
    state.SQLModule = { SQL: ok.SQL };                 // keep the class for rebuilds
    state.db = new ok.SQL.Database();
    state.db.run('PRAGMA foreign_keys = ON;');          // FK constraints really enforced
    const v = dbQuery('SELECT sqlite_version() AS v');
    state.engineVersion = v && v.length ? v[0].v : '?';
    state.engineReady = true;
  } catch (err) {
    setEngineStatus('Engine error: ' + err.message, 'err'); return;
  }
  // swap boot overlay → app
  const ov = el('bootOverlay'); ov.classList.add('done'); setTimeout(() => ov.remove(), 500);
  el('app').hidden = false;
  requestAnimationFrame(() => el('app').classList.add('fade-in'));

  const dot = el('engineDot'), txt = el('engineStateText');
  dot.className = 'dot dot-live'; txt.textContent = 'SQLite ' + state.engineVersion + ' · sql.js online';
  el('sqlStatus').textContent = 'Ready — Ctrl+Enter to run';

  activityLog('sys', 'Engine ready', 'SQLite v' + state.engineVersion + ' via sql.js — every statement below runs on this real in-memory database.');
  refreshIcons();
  renderTaskCards();
  if (el('sqlEditor')) { el('sqlEditor').focus(); }
}

/* ════════════════ §4  ENGINE WRAPPER (single SQL choke point) ════════════

   ┌─────────────────────────────── CHOKE POINT ─────────────────────────────┐
   │  EVERYTHING that touches SQL goes through runSqlText():                 │
   │   • the user's SQL terminal                                             │
   │   • "run sample for me" tutorial buttons                                │
   │   • the demo-database loader                                            │
   │   • the simulated backend script (Node/Python driver)                   │
   │  After each run the engine state is (1) executed, (2) mirrored into     │
   │  state.tables via PRAGMA introspection, (3) pushed to the visualizer,   │
   │  so schema & data views can never desync from the real database.        │
   └──────────────────────────────────────────────────────────────────────────┘ */

// split "a; b;" into real statements, keeping quote/comment awareness so a
// semicolon inside 'it''s; ok' or "-- ;" never splits. Offsets let us report
// precise line numbers for syntax errors. Comments never end up inside a
// statement buffer, so running a comment-only script is a no-op.
function splitStatements(src) {
  const stmts = [];
  let cur = '', curStart = 0, i = 0, q = null, mode = 'norm';
  while (i < src.length) {
    const c = src[i], nx = src[i + 1];
    if (mode === 'norm') {
      if (q) {
        if (c === q) { if (nx === q) { i += 2; continue; } q = null; }
      } else if (c === "'" || c === '"' || c === '`') { q = c; }
      else if (c === '-' && nx === '-') { mode = 'lc'; i += 2; continue; }
      else if (c === '/' && nx === '*') { mode = 'bc'; i += 2; continue; }
      else if (c === ';') {
        if (cur.trim()) stmts.push({ sql: cur, start: curStart });
        cur = ''; i++; continue;
      }
    } else if (mode === 'lc') {
      if (c === '\n') mode = 'norm';
      i++; continue;                         // skip comment text entirely
    } else if (mode === 'bc') {
      if (c === '*' && nx === '/') { mode = 'norm'; i += 2; continue; }
      i++; continue;                         // skip comment text entirely
    }
    if (/^\s*$/.test(cur) && !/[\s;]/.test(c)) curStart = i;   // note stmt start (first real char)
    cur += c; i++;
  }
  if (cur.trim()) stmts.push({ sql: cur, start: curStart });
  return stmts;
}

function sqlTypeOf(sql) {
  const m = sql.trim().match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : 'other';
}

// classify a statement so we can route it to the right sql.js call
function routeStmt(sql) {
  const t = sqlTypeOf(sql);
  if (t === 'select' || t === 'with' || t === 'explain') return 'query';
  if (t === 'pragma') return /pragma\s+[^;]*=/i.test(sql) ? 'run' : 'query';
  if (t === 'show') throw new Error("SQLite has no SHOW — try: SELECT name FROM sqlite_master WHERE type='table'");
  return 'run';            // create / insert / update / delete / drop / begin …
}

// execute ONE statement → {ok, kind, rows, columns?, meta} — errors thrown
function execStmt(sql) {
  const kind = routeStmt(sql);
  const t0 = performance.now();
  if (kind === 'query') {
    const blocks = state.db.exec(sql);
    const elapsed = performance.now() - t0;
    const sets = [];
    for (const b of blocks) {
      sets.push({ columns: b.columns || [], rows: (b.values || []).map((r) => r.slice()) });
    }
    return { ok: true, kind, sets, elapsed, changes: 0 };
  }
  state.db.run(sql);                                   // DDL / DML
  const changes = state.db.getRowsModified();
  const elapsed = performance.now() - t0;
  let lastId = null;
  try {
    const r = dbQuery('SELECT last_insert_rowid() AS id');
    if (r.length) { const v = r[0].id; lastId = v === 0 ? null : v; }
  } catch (_) { /* not every statement resets rowid semantics */ }
  return { ok: true, kind, sets: [], elapsed, changes, lastId };
}

// helper: query → array of plain objects
function dbQuery(sql) {
  const blocks = state.db.exec(sql);
  if (!blocks || !blocks.length) return [];
  const b = blocks[0];
  return (b.values || []).map((row) => {
    const o = {}; b.columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

// find a friendly "line N, column M" for an engine error, best effort
function errorLocation(msg, source, stmtStart) {
  let token = null;
  const m = msg.match(/near "([^"]*)"/) || msg.match(/unrecognized token: "([^"]*)"/);
  if (m) token = m[1];
  let idx = token ? source.indexOf(token, Math.max(0, stmtStart)) : -1;
  if (idx < 0) idx = stmtStart;
  const before = source.slice(0, idx);
  const line = (before.match(/\n/g) || []).length + 1;
  const col = idx - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col, token };
}

function guessAffectedTables(sql) {
  const out = new Set();
  const patterns = [
    /insert\s+(?:or\s+[a-z]+\s+)?into\s+(?:`|"|')?([A-Za-z_$][\w$]*)/i,
    /replace\s+into\s+(?:`|"|')?([A-Za-z_$][\w$]*)/i,
    /update\s+(?:`|"|')?([A-Za-z_$][\w$]*)/i,
    /delete\s+from\s+(?:`|"|')?([A-Za-z_$][\w$]*)/i,
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:`|"|')?([A-Za-z_$][\w$]*)/i,
    /drop\s+table\s+(?:if\s+exists\s+)?(?:`|"|')?([A-Za-z_$][\w$]*)/i,
    /alter\s+table\s+(?:`|"|')?([A-Za-z_$][\w$]*)/i,
  ];
  for (const p of patterns) { const m = sql.match(p); if (m) out.add(m[1].toLowerCase()); }
  return out;
}

/* The one public runner used by the whole app. */
async function runSqlText(src, opts = {}) {
  // opts: { origin: 'user'|'auto'|'backend'|'demo', label, silent }
  const origin = opts.origin || 'user';
  const summary = { statements: 0, ok: 0, errors: 0, rowsOut: 0, changes: 0,
    lastInsertId: null, affected: new Set(), results: [], hasResults: false, startTs: Date.now() };
  const list = splitStatements(src);
  if (!list.length) {
    activityLog('warn', 'No statements', 'Nothing to run — the editor is empty (or only comments).');
    return summary;
  }
  for (const st of list) {
    summary.statements++;
    const brief = st.sql.trim().replace(/\s+/g, ' ').slice(0, 96) + (st.sql.length > 96 ? '…' : '');
    try {
      const res = execStmt(st.sql);
      summary.ok++; summary.changes += res.changes || 0;
      if (res.lastId != null) summary.lastInsertId = res.lastId;
      // mirror into the UI: log + collect query results
      if (res.kind === 'query' && res.sets.length) {
        for (const s of res.sets) {
          summary.rowsOut += s.rows.length;
          summary.results.push({ text: brief, ...s, ms: res.elapsed });
        }
        summary.hasResults = true;
        activityLog('sql', brief, '');
        activityLog('ok', 'Query returned', summary.results.length
          ? (res.sets.reduce((n, s) => n + s.rows.length, 0) + ' row(s) · ' + res.elapsed.toFixed(1) + ' ms')
          : '0 rows · ' + res.elapsed.toFixed(1) + ' ms');
      } else {
        const meta = [];
        if (res.changes) meta.push(res.changes + ' row(s) affected');
        if (res.lastId != null) meta.push('last insert id ' + res.lastId);
        activityLog('sql', brief, '');
        activityLog('ok', sqlTypeOf(st.sql).toUpperCase() + ' done', meta.join(' · ') || (res.elapsed.toFixed(1) + ' ms'));
      }
      for (const t of guessAffectedTables(st.sql)) summary.affected.add(t);
    } catch (err) {
      summary.errors++;
      const loc = errorLocation(err.message || String(err), src, st.start);
      activityLog('err', 'Statement ' + summary.statements + ' failed',
        (err.message || '').slice(0, 220) + (loc.line ? '  [line ' + loc.line + ', col ' + loc.col + ']' : ''));
      summary.results.push({
        text: brief, error: (err.message || String(err)).slice(0, 400),
        atLine: loc.line, atCol: loc.col, token: loc.token, ms: 0,
      });
    }
  }
  summary.done = true;
  syncFromEngine(summary.affected, origin);      // schema + data + counts + tutorial checks
  return summary;
}

/* ════════════════ §5  SCHEMA EXTRACTION ═════════════════════════════════
   Reads the real engine catalog (sqlite_master + PRAGMAs) into a plain
   model that the visualizer renders.  Called after every executed script. */
function extractSchema() {
  const tables = new Map();
  const master = dbQuery("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  for (const t of master) {
    const colRows = dbQuery('PRAGMA table_info(' + quoteIdent(t.name) + ')');
    const fkRows = dbQuery('PRAGMA foreign_key_list(' + quoteIdent(t.name) + ')');
    const fkByCol = new Map();
    for (const fk of fkRows) {
      fkByCol.set(String(fk.from).toLowerCase(), {
        table: fk.table, col: fk.to, onUpdate: fk.on_update, onDelete: fk.on_delete,
      });
    }
    const cols = colRows.map((c) => ({
      name: c.name,
      type: (c.type || '').toUpperCase(),
      notnull: !!c.notnull,
      dflt: c.dflt_value,
      pk: c.pk > 0 ? c.pk : 0,                       // 0 = not PK, else PK order
      ref: fkByCol.get(String(c.name).toLowerCase()) || null,   // FK target
    }));
    tables.set(t.name, { name: t.name, sql: t.sql || '', cols });
  }
  state.tables = tables;
  return tables;
}

function rowCountOf(name) {
  try { const r = dbQuery('SELECT COUNT(*) AS n FROM ' + quoteIdent(name)); return r.length ? r[0].n : 0; }
  catch (_) { return 0; }
}
function totalRows() {
  let n = 0; for (const t of state.tables.keys()) n += rowCountOf(t); return n;
}
function tableExists(name) {
  const l = name.toLowerCase();
  for (const t of state.tables.keys()) if (t.toLowerCase() === l) return t;
  return null;
}

/* push fresh engine state into every consumer */
function syncFromEngine(affectedTables, origin) {
  extractSchema();
  const affectedNames = new Set();
  for (const a of affectedTables) { const real = tableExists(a); if (real) affectedNames.add(real); }
  updateStatChips();
  // visualizer
  if (!el('dataPanel').hidden) renderData(affectedNames);
  else if (!el('schemaPanel').hidden) renderSchema();
  // tutorials auto-detection (a real run just touched the engine)
  if (origin === 'user' || origin === 'auto') verifyTasks({ joined: false });
  updateVisualizerCounts();
}

function updateStatChips() {
  el('statTables').textContent = state.tables.size;
  el('statRows').textContent = totalRows();
}

/* ════════════════ §6  VISUALIZER — SCHEMA / ER DIAGRAM ═══════════════════
   Coordinate system: cards (HTML) and FK edges (SVG) share one "world"
   of px units inside #erWorld.  #erViewport applies pan/zoom by
   transforming #erWorld, so edges and cards can never drift apart. */
function erWorldSize() {                     // current world bounds (px)
  let w = 900, h = 600;
  for (const t of state.tables.values()) {
    const p = state.layout[t.name] || { x: 40, y: 40 };
    w = Math.max(w, p.x + ER.W + ER.XPAD);
    h = Math.max(h, p.y + erCardHeight(t) + ER.YGAP);
  }
  return { w: Math.ceil(w), h: Math.ceil(h) };
}
const erCardHeight = (t) => ER.HEAD + t.cols.length * ER.ROW;
const erRowY = (t, colIdx) => ER.HEAD + colIdx * ER.ROW + ER.ROW / 2;

function erPosOf(name) {
  const p = state.layout[name];
  if (p) return p;
  const pos = autoPlace(name);          // place any table we have not seen yet
  state.needsFit = true;                // world grew → refit after painting
  return state.layout[name] = pos;
}

/* Simple auto-layout: tables flow left→right by FK depth — a parentless
   table (no outgoing FK) lives in the leftmost column and every table
   that references it is placed one column further right. */
function autoPlaceAll() {
  state.needsFit = true;
  state.layout = {};
  const names = Array.from(state.tables.keys());
  const refsTo = (name) => {                 // distinct tables referenced by `name`
    const out = new Set();
    const t = state.tables.get(name);
    if (!t) return out;
    for (const c of t.cols) {
      if (!c.ref) continue;
      for (const n of names) if (n.toLowerCase() === c.ref.table.toLowerCase()) out.add(n);
    }
    return out;
  };
  const depth = new Map();
  for (const n of names) depth.set(n, refsTo(n).size ? Infinity : 0);   // parents first
  for (let pass = 0; pass < names.length; pass++) {                     // relax once per level
    for (const n of names) {
      if (depth.get(n) !== Infinity) continue;
      const deps = [...refsTo(n)];
      if (deps.every((d) => depth.get(d) !== Infinity)) {
        depth.set(n, 1 + Math.max(0, ...deps.map((d) => depth.get(d))));
      }
    }
  }
  for (const n of names) if (depth.get(n) === Infinity) depth.set(n, 0);  // FK cycles: keep at 0
  const byLevel = new Map();
  for (const n of names) {
    const l = depth.get(n); if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l).push(n);
  }
  const bottoms = new Map();
  for (const l of Array.from(byLevel.keys()).sort((a, b) => a - b)) {
    const col = byLevel.get(l).sort();
    for (const n of col) {
      const h = erCardHeight(state.tables.get(n));
      const y = (bottoms.get(l) || ER.YMIN) + (bottoms.has(l) ? ER.YGAP : 0);
      state.layout[n] = { x: ER.XPAD + l * (ER.W + ER.XGAP), y };
      bottoms.set(l, y + h);
    }
  }
}
function autoPlace(name) {                 // incremental slot for one new table
  const t = state.tables.get(name); if (!t) return { x: ER.XPAD, y: ER.YMIN };
  // find the rightmost card column → park the newcomer one full column further right
  let maxRight = ER.XPAD;
  for (const [n, p] of Object.entries(state.layout)) {
    if (!state.tables.has(n)) continue;
    maxRight = Math.max(maxRight, p.x);
  }
  return { x: maxRight + ER.W + ER.XGAP, y: ER.YMIN };
}

function erRowIdxOf(t, colName) {          // case-insensitive; clamp unknown cols to header
  const i = t.cols.findIndex((c) => c.name.toLowerCase() === String(colName).toLowerCase());
  return i < 0 ? 0 : i;
}

/* fit the world into the viewport when the panel is visible */
function queueFit() {
  if (state.needsFit) {
    state.needsFit = false;
    if (state.viewTouched) return;          // user is exploring on their own
    requestAnimationFrame(() => {
      const vp = el('erViewport');
      if (vp && vp.clientWidth > 10 && vp.clientHeight > 10) fitView();
      else state.needsFit = true;           // panel hidden → retry next time
    });
  }
}

/* render the full ER scene: cards + edges + world sizing */
function renderSchema() {
  const tables = state.tables;
  const empty = el('erEmpty');
  if (!tables.size) {
    empty.hidden = false; el('erCards').innerHTML = ''; el('erEdgeLayer').innerHTML = '';
    el('erCount').textContent = '0 tables';
    // reset the view for the next database
    if (!state.layout || !Object.keys(state.layout).length) {
      state.view = { k: 1, x: 24, y: 20 }; state.viewTouched = false;
      applyView();
    }
    return;
  }
  empty.hidden = true;
  if (!Object.keys(state.layout).length) autoPlaceAll();   // brand-new diagram

  // 1. cards (HTML layer)
  const counts = {};
  for (const t of tables.values()) counts[t.name] = rowCountOf(t.name);
  const cards = [];
  for (const t of tables.values()) {
    const p = erPosOf(t.name);
    const rows = t.cols.map((c, i) => {
      const badge = c.pk ? '<span class="er-badge pk' + (c.ref ? ' fk' : '') + '" title="PRIMARY KEY">PK</span>'
        : c.ref ? '<span class="er-badge fk" title="' + escHtml('FOREIGN KEY → ' + c.ref.table + '.' + c.ref.col) + '">FK</span>' : '';
      const badgePad = badge ? '' : '<span style="width:19px"></span>';
      return '<div class="er-col' + (c.pk ? ' pk' : '') + (c.ref ? ' fk' : '') + '" data-col="' + escHtml(c.name) + '"' +
        ' title="' + escHtml(c.name + '  ' + (c.type || 'ANY')) + (c.ref ? escHtml('  → ' + c.ref.table + '.' + c.ref.col) : '') + '">' +
        badgePad + badge + '<span class="er-colname">' + escHtml(c.name) + '</span>' +
        '<span class="er-type">' + escHtml((c.type || '').slice(0, 12)) + '</span></div>';
    }).join('');
    cards.push('<div class="er-table" data-table="' + escHtml(t.name) + '" style="left:' + p.x + 'px;top:' + p.y + 'px">' +
      '<div class="er-head"><span class="er-name" title="' + escHtml(t.sql || t.name) + '">' + escHtml(t.name) + '</span>' +
      '<span class="er-rows">' + (counts[t.name] || 0) + ' rows</span></div>' + rows + '</div>');
  }
  el('erCards').innerHTML = cards.join('');
  el('erCount').textContent = tables.size + (tables.size === 1 ? ' table' : ' tables');

  // 2. world + svg sizing
  const ws = erWorldSize();
  const svg = el('erSvg');
  svg.setAttribute('width', ws.w); svg.setAttribute('height', ws.h);
  svg.style.width = ws.w + 'px'; svg.style.height = ws.h + 'px';
  el('erCards').style.width = ws.w + 'px'; el('erCards').style.height = ws.h + 'px';

  // 3. FK edges (SVG layer underneath the cards)
  drawEdges();
  applyView();                 // keep pan/zoom sane after a relayout
  queueFit();                  // auto-fit brand-new / grown diagrams once
}

function edgeEndpoints(srcName, col, dstName, refCol) {
  const s = state.layout[srcName], d = state.layout[dstName];
  const st = state.tables.get(srcName), dt = state.tables.get(dstName);
  if (!s || !d) return null;
  const sy = s.y + erRowY(st, erRowIdxOf(st, col));
  const dy = d.y + erRowY(dt, erRowIdxOf(dt, refCol));
  const srcCX = s.x + ER.W / 2, dstCX = d.x + ER.W / 2;
  if (srcName === dstName) {                     // self-reference: little loop
    return { sx: s.x + ER.W, sy, ex: d.x + ER.W, ey: dy, d: +1, loop: true };
  }
  const dir = dstCX >= srcCX ? +1 : -1;          // +1: target is to the right
  const sx = dir > 0 ? s.x + ER.W : s.x;         // leave the side facing the target
  const ex = dir > 0 ? d.x : d.x + ER.W;         // enter the side facing the source
  return { sx, sy, ex, ey: dy, d: dir };
}

function drawEdges() {
  const layer = el('erEdgeLayer');
  if (!layer) return;
  const parts = [];
  for (const t of state.tables.values()) {
    t.cols.forEach((c) => {
      if (!c.ref) return;
      const target = tableExists(c.ref.table);
      if (!target) return;
      const e = edgeEndpoints(t.name, c.name, target, c.ref.col);
      if (!e) return;
      let d;
      if (e.loop) {
        d = 'M ' + e.sx + ' ' + e.sy + ' C ' + (e.sx + 120) + ' ' + e.sy + ', ' + (e.ex + 120) + ' ' + e.ey + ', ' + e.ex + ' ' + e.ey;
      } else {
        const mx = e.sx + (e.ex - e.sx) * 0.55;      // symmetric cubic elbow
        d = 'M ' + e.sx + ' ' + e.sy +
          ' C ' + mx + ' ' + e.sy + ', ' + mx + ' ' + e.ey + ', ' + e.ex + ' ' + e.ey;
      }
      parts.push(
        '<path class="fk-edge-hit" d="' + d + '" title="' + escHtml(t.name + '.' + c.name + ' → ' + target + '.' + c.ref.col) + '"></path>' +
        '<path class="fk-edge" d="' + d + '" marker-end="url(#fkArrow)" title="' +
        escHtml('FK: ' + t.name + '.' + c.name + '  →  ' + target + '.' + c.ref.col) + '"></path>');
    });
  }
  layer.innerHTML = parts.join('');
}

/* ---- pan / zoom / drag on the ER canvas -------------------------------- */
function applyView() {
  const v = state.view;
  const world = el('erWorld');
  world.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.k + ')';
  const pct = el('zoomPct'); if (pct) pct.textContent = Math.round(v.k * 100) + '%';
}
function fitView() {
  const vp = el('erViewport'); if (!vp || !state.tables.size) return;
  const ws = erWorldSize();
  const availW = vp.clientWidth - 32, availH = vp.clientHeight - 32;
  const k = Math.min(availW / ws.w, availH / ws.h, 1.25, 1.2);
  state.view.k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k));
  state.view.x = (vp.clientWidth - ws.w * state.view.k) / 2;
  state.view.y = (vp.clientHeight - ws.h * state.view.k) / 2;
  applyView();
}
function zoomAt(factor, cx, cy) {
  const vp = el('erViewport');
  const r = vp.getBoundingClientRect();
  const px = (cx == null ? r.width / 2 : cx - r.left), py = (cy == null ? r.height / 2 : cy - r.top);
  const k2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.view.k * factor));
  const wx = (px - state.view.x) / state.view.k, wy = (py - state.view.y) / state.view.k;
  state.view.k = k2;
  state.view.x = px - wx * k2; state.view.y = py - wy * k2;
  state.viewTouched = true;                 // manual zoom → stop auto-fitting
  applyView();
}

function wireERCanvas() {
  const vp = el('erViewport'), world = el('erWorld');
  // wheel = zoom to cursor
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });
  // card dragging + canvas panning share pointer events
  vp.addEventListener('pointerdown', (e) => {
    const card = e.target.closest ? e.target.closest('.er-table') : null;
    if (card) {
      const name = card.dataset.table;
      const p = state.layout[name]; if (!p) return;
      const r = card.getBoundingClientRect();
      state.drag = { name, dx: e.clientX - r.left, dy: e.clientY - r.top };
      card.classList.add('dragging');
      e.stopPropagation();
    } else {
      state.pan = { sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
      vp.classList.add('panning');
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (state.drag) {
      const vpRect = vp.getBoundingClientRect();
      const k = state.view.k;
      // convert the pointer to world coordinates, then snap to the grid
      const wx = (e.clientX - vpRect.left - state.view.x) / k;
      const wy = (e.clientY - vpRect.top - state.view.y) / k;
      const t = state.tables.get(state.drag.name);
      const nx = Math.max(8, Math.round(wx - state.drag.dx / k));
      const ny = Math.max(8, Math.round(wy - state.drag.dy / k));
      state.layout[state.drag.name].x = nx;
      state.layout[state.drag.name].y = ny;
      const card = vp.querySelector('.er-table.dragging');
      if (card) { card.style.left = nx + 'px'; card.style.top = ny + 'px'; }
      scheduleEdges();
    } else if (state.pan) {
      state.view.x = state.pan.vx + (e.clientX - state.pan.sx);
      state.view.y = state.pan.vy + (e.clientY - state.pan.sy);
      state.viewTouched = true;             // manual pan → stop auto-fitting
      applyView();
    }
  });
  const endDrag = () => {
    if (state.drag) {
      const c = vp.querySelector('.er-table.dragging');
      if (c) c.classList.remove('dragging');
      state.drag = null;
      scheduleEdges(true);
    }
    if (state.pan) { state.pan = null; vp.classList.remove('panning'); }
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}
let edgeRaf = 0;
function scheduleEdges(force) {
  if (edgeRaf) return;
  edgeRaf = requestAnimationFrame(() => { edgeRaf = 0; drawEdges(); });
}

/* ════════════════ §7  VISUALIZER — LIVE DATA ════════════════════════════
   Reads rows straight out of the engine (SELECT * FROM …) for every table
   and paints them. `flashTables` = tables touched by INSERT/UPDATE/DELETE
   in the run that just finished → their rows get the green flash. */
function dataBlock(t, opts = {}) {
  const q = 'SELECT * FROM ' + quoteIdent(t.name);
  const blocks = state.db.exec(q);
  const cols = blocks.length ? blocks[0].columns : t.cols.map((c) => c.name);
  const rows = blocks.length ? blocks[0].values : [];
  const typeOf = {};
  t.cols.forEach((c, i) => { typeOf[c.name] = c.type; });
  const numCol = cols.map((c) => /^(INT|REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)/.test(typeOf[c.name] || ''));
  const filter = (opts.filter || '').toLowerCase();
  const isNum = (v) => typeof v === 'number';
  const cell = (v, c, r) => {
    let html = '', cls = 'txt';
    if (v === null || v === undefined) { html = '<span class="null">NULL</span>'; cls = ''; }
    else if (typeof v === 'number') { html = String(v); cls = 'num'; }
    else if (v instanceof Uint8Array || v instanceof ArrayBuffer) { html = '<span class="blobchip">BLOB</span>'; cls = ''; }
    else { html = escHtml(String(v)); }
    const text = String(v == null ? '' : v instanceof Uint8Array ? '[BLOB]' : v);
    return '<td class="' + cls + '" data-t="' + escHtml(text.toLowerCase()) + '">' + html + '</td>';
  };
  let visibleRows = rows;
  if (filter) {
    visibleRows = rows.filter((row) =>
      t.name.toLowerCase().includes(filter) ||
      row.some((v) => String(v == null ? '' : v).toLowerCase().includes(filter)));
  }
  const head = '<table class="rgrid"><thead><tr>' + cols.map((c) =>
    '<th>' + escHtml(c) + (typeOf[c] ? '<span class="th-type">' + escHtml(typeOf[c]) + '</span>' : '') + '</th>').join('') + '</tr></thead><tbody>' +
    visibleRows.map((row, ri) => '<tr>' + row.map((v, ci) => cell(v, cols[ci], ri)).join('') + '</tr>').join('') +
    (visibleRows.length === 0 ? '<tr><td colspan="' + cols.length + '" style="text-align:center;color:#5f7196;font-style:italic;padding:14px">no rows yet — run an INSERT</td></tr>' : '') +
    '</tbody></table>';
  return { cols, rows: visibleRows.length, total: rows.length, head, html: head };
}

function renderData(flashTables) {
  const list = el('dataList');
  const filter = el('dataFilter') ? el('dataFilter').value.trim() : '';
  el('dataEmpty').hidden = state.tables.size > 0;
  el('dataCountChip').textContent = totalRows() + ' rows';
  if (!state.tables.size) { list.innerHTML = ''; return; }

  const htmlParts = [];
  for (const t of state.tables.values()) {
    const d = dataBlock(t, { filter });
    const chip = '<span class="chip' + (d.total > 0 ? ' green' : '') + '">' + d.total + ' row' + (d.total === 1 ? '' : 's') + '</span>';
    const colsChip = '<span class="chip">' + t.cols.length + ' col' + (t.cols.length === 1 ? '' : 's') + '</span>';
    htmlParts.push(
      '<div class="dtable' + (d.total === 0 ? ' norows' : '') + '" data-table="' + escHtml(t.name) + '">' +
      '<div class="dtable-head" data-collapse><span class="dt-name" title="' + escHtml(t.sql || '') + '">' + escHtml(t.name) + '</span>' +
      colsChip + chip + '<i data-lucide="chevron-down" class="ic chev"></i></div>' +
      '<div class="dt-body"><div class="dt-empty" style="display:none"></div><div class="rgrid-wrap">' + d.html + '</div></div></div>');
  }
  list.innerHTML = htmlParts.join('');
  refreshIcons(list);

  // green flash + row pop for tables touched by the run that just happened
  if (flashTables) {
    for (const name of flashTables) {
      const real = tableExists(name); if (!real) continue;
      const card = list.querySelector('.dtable[data-table="' + escHtml(real) + '"]');
      if (!card) continue;
      const rowsChip = card.querySelector('.dtable-head .chip.green') || card.querySelector('.dtable-head .chip');
      if (rowsChip) { rowsChip.classList.add('pop-badge'); setTimeout(() => rowsChip.classList.remove('pop-badge'), 1000); }
      card.classList.add('flash');
      card.classList.add('dt-new');
      setTimeout(() => card.classList.remove('flash'), 1300);
      setTimeout(() => card.classList.remove('dt-new'), 600);
    }
  }
}

/* refresh just the tiny row-count chips on ER cards + toolbar */
function updateVisualizerCounts() {
  if (state.tables.size) {
    const counts = {};
    for (const name of state.tables.keys()) counts[name.toLowerCase()] = rowCountOf(name);
    $$('#erCards .er-table').forEach((card) => {
      const n = counts[card.dataset.table.toLowerCase()];
      const b = card.querySelector('.er-rows');
      if (b && n != null) b.textContent = n + ' rows';
    });
  }
}
/* ════════════════ §8  OUTPUT RENDERING — grids & logs ═══════════════ */

/* engine activity feed */
function activityLog(type, msg, meta) {
  const list = el('activityList');
  const empty = el('activityEmpty'); if (empty) empty.hidden = true;
  while (list.childElementCount > 500) list.firstElementChild.remove();
  const li = document.createElement('li');
  const ic = type === 'ok' ? '✓' : type === 'err' ? '✕' : type === 'warn' ? '⚠' : '›';
  li.className = 'log-item ' + type;
  li.innerHTML = '<span class="log-time">' + nowTag() + '</span>' +
    '<span class="log-icon">' + ic + '</span>' +
    '<span class="log-msg">' + escHtml(msg) + '</span>' +
    (meta ? '<span class="log-meta' + (type === 'ok' ? ' green' : type === 'err' ? ' amber' : '') + '">' + escHtml(meta) + '</span>' : '');
  list.appendChild(li);
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

/* result banner (errors + execution summaries) */
function banner(type, html) {
  const b = el('resultBanner');
  b.className = 'banner ' + type;
  el('bannerIcon').outerHTML = '<i data-lucide="' +
    (type === 'err' ? 'circle-x' : type === 'info' ? 'circle-info' : 'circle-check') + '" class="ic banner-ic"></i>';
  el('resultBannerText').innerHTML = html;
  b.hidden = false;
  refreshIcons(b);
}

/* spreadsheet result cards */
function fmtMs(ms) { return (ms == null ? 0 : ms) < 1 ? '<1 ms' : ms.toFixed(1) + ' ms'; }

function showResults(summary) {
  const wrap = el('resultViews');
  const empty = el('resultsEmpty');
  const chip = el('outcomeChip');

  if (!summary || !summary.statements) {
    chip.textContent = 'no output yet'; empty.hidden = false; wrap.innerHTML = '';
    el('resultBanner').hidden = true;
    return;
  }
  // build cards
  const cards = [];
  (summary.results || []).forEach((res, idx) => {
    if (res.error) {
      cards.push('<div class="result-block" style="border-color:rgba(248,113,113,.5)">' +
        '<div class="result-head" style="color:#fecaca">' +
        '<span>✕</span><span style="font-family:var(--font-mono)">' + escHtml(res.text) + '</span>' +
        (res.atLine ? '<span style="margin-left:auto;color:#f87171">line ' + res.atLine + ', col ' + res.atCol + '</span>' : '') + '</div>' +
        '<div class="rgrid-wrap"><div style="padding:10px 12px;font-family:var(--font-mono);font-size:11.5px;color:#fecaca;white-space:pre-wrap">' + escHtml(res.error) + '</div></div></div>');
      return;
    }
    const head = res.columns.map((c) => '<th>' + escHtml(String(c)) + '</th>').join('');
    const MAX_CELLS = 500;                    // keep huge result sets browser-friendly
    const shown = res.rows.slice(0, MAX_CELLS);
    const truncated = res.rows.length > shown.length;
    const body = shown.map((row) => '<tr>' + row.map((v) => {
      if (v === null || v === undefined) return '<td><span class="null">NULL</span></td>';
      if (typeof v === 'number') return '<td class="num">' + v + '</td>';
      if (v instanceof Uint8Array) return '<td><span class="blobchip">BLOB</span></td>';
      return '<td>' + escHtml(String(v)) + '</td>';
    }).join('') + '</tr>').join('');
    const emptyRow = !res.rows.length
      ? '<tr><td colspan="' + Math.max(1, res.columns.length) + '" style="text-align:center;color:#5f7196;font-style:italic;padding:12px">query returned 0 rows</td></tr>'
      : truncated ? '<tr><td colspan="' + res.columns.length + '" style="text-align:center;color:#f59e0b;font-style:italic;padding:8px">… showing first ' + MAX_CELLS + ' of ' + res.rows.length + ' rows</td></tr>' : '';
    cards.push('<div class="result-block">' +
      '<div class="result-head"><span>' + (summary.results.filter((r) => !r.error).indexOf(res) + 1) + '.</span>' +
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">' + escHtml(res.text) + '</span>' +
      '<span class="elapsed">' + fmtMs(res.ms) + '</span>' +
      '<span class="count">' + res.rows.length + ' row' + (res.rows.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="rgrid-wrap"><table class="rgrid"><thead><tr>' + head + '</tr></thead><tbody>' + body + emptyRow + '</tbody></table></div></div>');
  });
  empty.hidden = cards.length > 0;
  wrap.innerHTML = cards.join('');
  refreshIcons(wrap);

  // summary chip + banner
  const errN = summary.errors, okN = summary.ok;
  if (errN) {
    chip.textContent = errN + ' error' + (errN === 1 ? '' : 's');
    const firstErr = (summary.results || []).find((r) => r.error);
    banner('err', '<b>' + errN + ' of ' + summary.statements + ' statement(s) failed.</b>' +
      (firstErr ? ' First error' + (firstErr.atLine ? ' (line ' + firstErr.atLine + ', col ' + firstErr.atCol + ')' : '') +
      ': <code>' + escHtml(firstErr.error.slice(0, 260)) + '</code>' : '') +
      '<br><span style="opacity:.8">Fix the highlighted statement and hit Run again — the other ' + okN + ' succeeded.</span>');
  } else if (summary.hasResults) {
    chip.textContent = summary.rowsOut + ' row' + (summary.rowsOut === 1 ? '' : 's');
    banner('ok', '<b>Run complete.</b> ' + summary.statements + ' statement(s) executed · ' + summary.rowsOut +
      ' row(s) returned · ' + summary.changes + ' row(s) modified.' +
      (summary.lastInsertId != null ? ' Last insert id: <code>' + summary.lastInsertId + '</code>' : ''));
  } else {
    chip.textContent = summary.statements + ' statement' + (summary.statements === 1 ? '' : 's');
    banner('info', '<b>Run complete.</b> ' + summary.statements + ' statement(s) executed' +
      (summary.changes ? ' · ' + summary.changes + ' row(s) modified' : '') +
      ' — no result set, check <b>Engine Activity</b> for details.');
  }
}

/* backend console */
function bcLog(msg, cls) {
  const log = el('backendLog');
  el('backendEmpty').hidden = true;
  while (log.childElementCount > 400) log.firstElementChild.remove();
  const line = document.createElement('div');
  line.className = 'lc';
  line.innerHTML = '<span class="lc-t">' + nowTag() + '</span><span class="lc-m ' + (cls || '') + '">' + escHtml(msg) + '</span>';
  log.appendChild(line);
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  if (near) log.scrollTop = log.scrollHeight;
}
function bcInput(msg) {                    // "typed command" look
  const log = el('backendLog');
  const line = document.createElement('div');
  line.className = 'lc in';
  line.innerHTML = '<span class="lc-t">' + nowTag() + '</span><span class="lc-m">' + escHtml(msg) + '</span>';
  log.appendChild(line);
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  if (near) log.scrollTop = log.scrollHeight;
}

/* console tab switching */
const consoleTab = { active: 'results' };
function focusConsoleTab(name) {
  consoleTab.active = name;
  $$('#consoleTabs .seg-btn').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-selected', 'true'); else b.setAttribute('aria-selected', 'false');
  });
  el('panelResults').hidden = name !== 'results';
  el('panelActivity').hidden = name !== 'activity';
  el('panelBackend').hidden = name !== 'backend';
}

/* ════════════════ §9  BACKEND CONNECTION SIMULATION ════════════════════
   "Run App Script" executes this: a pretend Node/Python driver that
   drives the REAL sql.js engine — introspect schema → DELETE stale rows →
   INSERT row by row → SELECT with a JOIN. Every real statement flows
   through the engine choke point, so the visualizer animates in sync. */
const LANGS = {
  node: {
    label: 'Node.js · mysql2',
    file: 'seed-db.js', cmd: 'node seed-db.js',
    driver: 'mysql2 (promise pool)', engine: 'mysql',
    conn: { host: 'db.internal.example.com', port: 3306, user: 'app_user', db: 'social_app' },
    spec: 'js',
    introspectSQL: 'SHOW TABLES;',
    code: [
      '// seed-db.js — a real backend job: connect → read rows → INSERT them',
      '// deps: npm install mysql2    ·    run: node seed-db.js',
      '',
      "import mysql from 'mysql2/promise';",
      '',
      '// 1 ─ connection config (from env vars in production)',
      'const config = {',
      "  host: 'db.internal.example.com',  // the DB server",
      '  port: 3306,',
      "  user: 'app_user',",
      "  password: process.env.DB_PASSWORD || 'app_user_pass',",
      "  database: 'social_app',",
      '};',
      '',
      '// 2 ─ connect, stream rows, insert them one by one',
      'async function main() {',
      '  const pool = mysql.createPool(config);',
      '  const conn = await pool.getConnection();',
      "  console.log('[Backend] Connecting to database... Connected!');",
      '',
      '  // pretend these rows arrived from an external CSV / API',
      '  const users = [',
      "    ['Alice Nguyen', 'alice@example.com', 27],",
      "    ['Bob Kowalski', 'bob@example.com', 34],",
      '  ];',
      '',
      '  for (const [full_name, email, age] of users) {',
      "    const sql = 'INSERT INTO users (full_name, email, age) VALUES (?, ?, ?)';",
      "    console.log('[Backend] Executing: ' + sql);",
      '    const [res] = await conn.execute(sql, [full_name, email, age]);',
      "    console.log('[Backend] Inserted Row ID: ' + res.insertId);",
      '  }',
      '',
      '  const [rows] = await conn.execute(',
      "    'SELECT users.full_name, posts.title FROM users ' +",
      "    + 'JOIN posts ON posts.user_id = users.id'",
      '  );',
      "  console.log('[Backend] JOIN returned ' + rows.length + ' rows');",
      '',
      '  conn.release();',
      '  await pool.end();',
      '}',
      '',
      'main().catch((err) => {',
      "  console.error('[Backend] Script failed:', err.message);",
      '  process.exit(1);',
      '});',
    ].join('\n'),
  },
  'py-sqlite': {
    label: 'Python · sqlite3',
    file: 'seed_db.py', cmd: 'python seed_db.py',
    driver: 'sqlite3 (stdlib)', engine: 'sqlite',
    conn: { host: 'local file: social_app.db', port: '—', user: '(none)', db: 'social_app.db' },
    spec: 'py',
    introspectSQL: "cursor.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")",
    code: [
      '# seed_db.py — a real backend job: connect → read rows → INSERT them',
      '# stdlib only · run: python seed_db.py',
      '',
      'import sqlite3',
      '',
      '# 1 ─ connection config (swap sqlite3.connect for MySQL in prod)',
      'config = {',
      "    'host': 'db.internal.example.com',",
      "    'port': 3306,",
      "    'user': 'app_user',",
      "    'password': 'app_user_pass',",
      "    'database': 'social_app',",
      '}',
      '',
      'def main():',
      "    # sqlite3 talks to a local file; mysql.connector would use config",
      "    conn = sqlite3.connect('social_app.db')",
      '    cur = conn.cursor()',
      "    print('[Backend] Connecting to database... Connected!')",
      '',
      '    # pretend these rows arrived from an external CSV / API',
      '    users = [',
      "        ('Alice Nguyen', 'alice@example.com', 27),",
      "        ('Bob Kowalski', 'bob@example.com', 34),",
      '    ]',
      '',
      '    for full_name, email, age in users:',
      '        sql = "INSERT INTO users (full_name, email, age) VALUES (?, ?, ?)"',
      "        print('[Backend] Executing: ' + sql)",
      '        cur.execute(sql, (full_name, email, age))',
      "        print('[Backend] Inserted Row ID: ' + str(cur.lastrowid))",
      '',
      '    conn.commit()',
      '    cur.close()',
      '    conn.close()',
      '',
      "    print('[Backend] Done — all rows inserted.')",
      '',
      'main()',
    ].join('\n'),
  },
  'py-mysql': {
    label: 'Python · mysql-connector',
    file: 'seed_db.py', cmd: 'python seed_db.py',
    driver: 'mysql.connector', engine: 'mysql',
    conn: { host: 'db.internal.example.com', port: 3306, user: 'app_user', db: 'social_app' },
    spec: 'py',
    introspectSQL: 'SHOW TABLES;',
    code: [
      '# seed_db.py — same job, MySQL flavour',
      '# deps: pip install mysql-connector-python · run: python seed_db.py',
      '',
      'import mysql.connector',
      '',
      '# 1 ─ connection config',
      'config = {',
      "    'host': 'db.internal.example.com',",
      "    'port': 3306,",
      "    'user': 'app_user',",
      "    'password': 'app_user_pass',",
      "    'database': 'social_app',",
      '}',
      '',
      'def main():',
      '    conn = mysql.connector.connect(**config)',
      '    cur = conn.cursor()',
      "    print('[Backend] Connecting to database... Connected!')",
      '',
      '    rows = [',
      "        ('Alice Nguyen', 'alice@example.com', 27),",
      "        ('Bob Kowalski', 'bob@example.com', 34),",
      '    ]',
      '',
      '    for full_name, email, age in rows:',
      '        sql = "INSERT INTO users (full_name, email, age) VALUES (%s, %s, %s)"',
      "        print('[Backend] Executing: ' + sql)",
      '        cur.execute(sql, (full_name, email, age))',
      "        print('[Backend] Inserted Row ID: ' + str(cur.lastrowid))",
      '',
      '    conn.commit()',
      '    cur.close()',
      '    conn.close()',
      '',
      "    print('[Backend] Done — all rows inserted.')",
      '',
      'main()',
    ].join('\n'),
  },
};

/* flexible field mapping: whatever the user called the columns, the
   simulated driver finds the right value (or synthesises a plausible one) */
const FIELD_PLANS = {
  users: [
    { match: ['full_name', 'name', 'username', 'user_name', 'nickname'], gen: (i) => ['Alice Nguyen', 'Bob Kowalski'][i] },
    { match: ['email', 'mail'], gen: (i) => ['alice@example.com', 'bob@example.com'][i] },
    { match: ['age'], gen: (i) => [27, 34][i] },
    { match: ['city', 'town'], gen: (i) => ['Lisbon', 'Kraków'][i] },
    { match: ['country', 'country_code'], gen: (i) => ['PT', 'PL'][i] },
    { match: ['created_at', 'created', 'created_on', 'joined_at'], gen: () => '2026-09-09 09:41:00' },
  ],
  posts: [
    { match: ['title', 'heading', 'subject'], gen: (i) => ['My very first post', 'JOINs are fun'][i] },
    { match: ['content', 'body', 'text', 'message'], gen: (i) => ['Inserted by the simulated backend script', 'Watch the visualizer fill up — then try a JOIN'][i] },
    { match: ['user_id', 'author_id', 'posted_by', 'userid'], gen: (i, ctx) => (ctx.userIds && ctx.userIds[i % ctx.userIds.length]) || ctx.minUserId || 1 },
    { match: ['created_at', 'created', 'posted_at', 'created_on'], gen: () => '2026-09-09 09:41:00' },
  ],
};

function makeDriverPlan(tableName) {
  const t = state.tables.get(tableName);
  const def = FIELD_PLANS[tableName] || [];
  const cols = [];
  const notices = [];
  t.cols.forEach((c) => {
    const lname = c.name.toLowerCase();
    const hit = def.find((p) => p.match.includes(lname));
    const autoPk = c.pk > 0 && /^int/i.test(c.type);          // INTEGER PRIMARY KEY → rowid, omit
    if (autoPk && !hit) return;
    if (hit) { cols.push({ col: c, gen: hit.gen }); return; }
    if (c.notnull && c.dflt === null) {                        // required col: synthesize
      cols.push({ col: c, gen: (i) => (/int/i.test(c.type) ? 100 + i * 7 : 'sample value ' + (i + 1)) });
      notices.push(c.name);
    }
    // nullable or defaulted & not in plan → let the DB default handle it
  });
  return { cols, notices };
}

function driverInsertSql(tableName, idx, ctx, plan) {
  const sets = plan.cols.map((c) => sqlLit(c.gen(idx, ctx)));
  const names = plan.cols.map((c) => quoteIdent(c.col.name)).join(', ');
  return 'INSERT INTO ' + quoteIdent(tableName) + ' (' + names + ') VALUES (' + sets.join(', ') + ')';
}

async function runBackendScript(langKey) {
  if (!state.engineReady) { toast('Engine is still starting — try again in a moment.', 'warn'); return; }
  if (state.driverRunning) return;
  const cfg = LANGS[langKey] || LANGS.node;
  const token = ++state.driverToken;
  state.driverRunning = true;
  el('btnRunScript').hidden = true; el('btnStopScript').hidden = false;
  el('scriptStatus').textContent = 'Running ' + cfg.file + ' — the driver below is really INSERTing into the engine…';
  focusConsoleTab('backend');                          // watch the console as it runs
  const conn = cfg.conn;

  // logging helpers that silently no-op once Stop was pressed
  const alive = () => state.driverToken === token && state.driverRunning;
  const step = (ms) => sleep(ms).then(() => alive());
  const say = (m, c) => { if (alive()) bcLog(m, c); };
  const sayIn = (m) => { if (alive()) bcInput(m); };

  sayIn('$ ' + cfg.cmd);
  try {
    // ── connect ────────────────────────────────────────────────
    say('[Backend] Connecting to database...', '');
    if (!(await step(620))) return;
    say('[Backend] Connected! (' + cfg.driver + ' driver · ' + cfg.engine + ' @ ' + conn.host + ')', 'green');
    if (!(await step(260))) return;

    // ── introspect the real schema ─────────────────────────────
    const usersReal = tableExists('users');
    const postsReal = tableExists('posts');
    sayIn(cfg.introspectSQL);
    if (!(await step(430))) return;
    if (!usersReal && !postsReal) {
      say('[Backend] Fatal: no tables named users / posts in the database.', 'red');
      say('[Backend] Create them first — Task 1 (users) and Task 3 (posts). Aborting.', 'red');
      say('[Backend] Script exited with code 1', 'red');
      return;
    }
    const found = [usersReal, postsReal].filter(Boolean);
    say('[Backend] Schema introspection found ' + found.length + ' table(s): ' + found.join(', '), 'cyan');
    if (!(await step(420))) return;

    // ── clear stale rows (FK-safe order: children first) ───────
    for (const name of [postsReal, usersReal].filter(Boolean)) {
      const res = await execWrap(name, 'DELETE FROM ' + quoteIdent(name), token);
      if (!res) return;
      say('[Backend] Cleared ' + (res.changes || 0) + ' stale row(s) from ' + name + ' — clean slate', 'grey');
      if (!(await step(320))) return;
    }

    // ── insert sample rows, table by table, row by row ─────────
    const ctx = { userIds: [], minUserId: null };
    const canPosts = postsReal && usersReal;    // FK target must exist
    if (postsReal && !usersReal) {
      say('[Backend] Warning: posts references users but users is missing → Task 1 first.', 'orange');
      say('[Backend] Skipping posts. Script exited with code 1', 'red');
      return;
    }
    if (usersReal) {
      const plan = makeDriverPlan(usersReal);
      for (const n of plan.notices) say('[Backend] Auto-mapped required column "' + n + '" to sample data', 'grey');
      for (let i = 0; i < 2; i++) {
        const sql = driverInsertSql(usersReal, i, ctx, plan);
        sayIn('Executing: ' + sql.slice(0, 110) + (sql.length > 110 ? ' …' : ''));
        if (!(await step(480))) return;
        const res = await execWrap(usersReal, sql, token);
        if (!res) return;
        ctx.userIds.push(res.lastId);
        say('[Backend] Inserted Row ID: ' + res.lastId, 'green');
        if (!(await step(280))) return;
      }
      ctx.minUserId = ctx.userIds[0];
    }
    if (canPosts) {
      const plan = makeDriverPlan(postsReal);
      for (const n of plan.notices) say('[Backend] Auto-mapped required column "' + n + '" to sample data', 'grey');
      for (let i = 0; i < 2; i++) {
        const sql = driverInsertSql(postsReal, i, ctx, plan);
        sayIn('Executing: ' + sql.slice(0, 110) + (sql.length > 110 ? ' …' : ''));
        if (!(await step(480))) return;
        const res = await execWrap(postsReal, sql, token);
        if (!res) return;
        say('[Backend] Inserted Row ID: ' + res.lastId, 'green');
        if (!(await step(280))) return;
      }
    }

    // ── the money shot: JOIN back what we just wrote ───────────
    if (usersReal && postsReal) {
      const joinSql = 'SELECT users.full_name, users.email, posts.title FROM users JOIN posts ON posts.user_id = users.id ORDER BY posts.id';
      sayIn('Executing: ' + joinSql);
      if (!(await step(520))) return;
      const r = await execWrap('posts', joinSql, token);
      if (!r) return;
      const n = r.sets ? r.sets.reduce((a, s) => a + s.rows.length, 0) : 0;
      say('[Backend] JOIN returned ' + n + ' row(s) — users ⋈ posts. Open the Live Data tab ↑', 'green');
    } else {
      say('[Backend] Skipping JOIN demo — it needs both a users and a posts table.', 'orange');
    }
    if (!(await step(300))) return;
    say('[Backend] Connection closed. Script exited with code 0 ✓', 'green');
    if (alive()) toast('Backend script finished — all rows landed in the real database.', 'ok');
  } finally {
    state.driverRunning = false;
    el('btnRunScript').hidden = false; el('btnStopScript').hidden = true;
    el('scriptStatus').textContent = state.driverToken === token
      ? 'Simulation finished — rerun to watch it fill the DB again.'
      : 'Simulation stopped by you — database left as-is.';
    updateVisualizerCounts();
  }
}

// one driver statement through the engine (logs + visualizer flash),
// aborts the driver narrative (returns null) when stopped or failing
async function execWrap(tableName, sql, token) {
  if (state.driverToken !== token || !state.driverRunning) return null;
  try {
    const res = execStmt(sql);
    // writes refresh the visualizer (with the green flash); plain reads don't
    if (res.kind !== 'query') syncFromEngine(new Set([tableName]), 'backend');
    return res;
  } catch (err) {
    bcLog('[Backend] Query failed: ' + String(err.message || err).slice(0, 220), 'red');
    bcLog('[Backend] Script exited with code 1', 'red');
    return null;
  }
}

/* ════════════════ §10  GUIDED TUTORIALS ═════════════════════════════════
   Four progressive tasks. Completion is detected automatically from the
   REAL engine state after every run (origin 'user' or 'auto'); each task
   only unlocks once the previous one is done. */
const TASKS = [
  {
    title: 'Create your first table',
    sub: 'CREATE TABLE users with a PRIMARY KEY',
    goal: 'Write a <code>CREATE TABLE users</code> statement with a primary key, then press <b>Run SQL</b>. Watch the card appear in the Schema ER view.',
    sample:
      'CREATE TABLE users (\n' +
      '  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
      '  full_name  TEXT NOT NULL,\n' +
      '  email      TEXT NOT NULL UNIQUE,\n' +
      '  age        INTEGER,\n' +
      '  city       TEXT,\n' +
      '  created_at TEXT DEFAULT CURRENT_TIMESTAMP\n' +
      ');',
    doneMsg: 'users table created — schema card + PK badge appeared in the ER diagram. Task 2 unlocked!',
  },
  {
    title: 'Insert data',
    sub: 'INSERT INTO users — rows that live in the engine',
    goal: 'Run an <code>INSERT INTO users</code> adding at least two rows. Switch to <b>Live Data</b> on the right — the new rows flash green.',
    sample:
      'INSERT INTO users (full_name, email, age, city)\n' +
      "VALUES ('Ada Lovelace', 'ada@example.com', 36, 'London'),\n" +
      "       ('Alan Turing',  'alan@example.com', 41, 'London');",
    doneMsg: '2 users live in the database — Live Data shows them. Task 3 unlocked!',
  },
  {
    title: 'Make a relationship',
    sub: 'CREATE TABLE posts … FOREIGN KEY → users',
    goal: 'Create a <code>posts</code> table whose <code>user_id</code> is a FOREIGN KEY referencing <code>users(id)</code> — watch the orange arrow + 🔗 FK badge appear.',
    sample:
      'CREATE TABLE posts (\n' +
      '  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
      '  user_id    INTEGER NOT NULL,\n' +
      '  title      TEXT NOT NULL,\n' +
      '  content    TEXT,\n' +
      '  created_at TEXT DEFAULT CURRENT_TIMESTAMP,\n' +
      '  FOREIGN KEY (user_id) REFERENCES users(id)\n' +
      ');',
    doneMsg: 'Relationship wired up — posts.user_id → users.id drawn as an orange SVG arrow.',
  },
  {
    title: 'Write a JOIN',
    sub: 'merge users + posts in one query',
    goal: 'Run a <code>SELECT … FROM users JOIN posts ON posts.user_id = users.id</code> that returns rows. It counts once it returns at least one row.',
    sample:
      'INSERT INTO posts (user_id, title, content)\n' +
      "SELECT id, 'Hello, relational world!', 'Written with real SQL'\n" +
      'FROM users ORDER BY id LIMIT 1;\n' +
      '\n' +
      'SELECT users.full_name, users.email, posts.title, posts.content\n' +
      'FROM users\n' +
      'JOIN posts ON posts.user_id = users.id\n' +
      'ORDER BY posts.id;',
    doneMsg: 'JOIN successful — you just merged two tables like a real backend query!',
  },
];

const taskGuards = [                       // engine prerequisites for "Run for me"
  () => true,
  () => !!tableExists('users'),
  () => !!tableExists('users'),
  () => !!tableExists('users') && !!tableExists('posts') && rowCountOf(tableExists('users')) > 0,
];
const taskGuardMsgs = [
  '', 'Task 1 first — create the users table, then I can insert into it.',
  'Task 1 first — posts needs a users table to reference.',
  'Need the users & posts tables with at least one user — finish Tasks 1–3 first.',
];

function taskCompleted(i) {
  const t = TASKS[i];
  if (i === 0) {
    const u = tableExists('users');
    return !!u && state.tables.get(u).cols.some((c) => c.pk > 0);
  }
  if (i === 1) {
    const u = tableExists('users');
    return !!u && rowCountOf(u) >= 2;
  }
  if (i === 2) {
    const p = tableExists('posts');
    if (!p) return false;
    const usersT = tableExists('users');
    return usersT && state.tables.get(p).cols.some((c) =>
      c.ref && c.ref.table.toLowerCase() === usersT.toLowerCase());
  }
  return false;                            // task 4 handled by run metadata
}

function renderTaskCards() {
  const list = el('taskList');
  const html = TASKS.map((t, i) => {
    const done = state.taskDone[i];
    const unlocked = i === 0 || state.taskDone[i - 1];
    const locked = !unlocked && !done;
    const stateIcon = done ? icon('circle-check', 'check')
      : locked ? icon('lock') : icon('chevron-down', 'chev');
    return '<div class="task-card' + (done ? ' done' : '') + (locked ? ' locked' : '') + ' open" data-i="' + i + '">' +
      '<div class="task-top">' +
      '<span class="task-num">' + (done ? '✓' : i + 1) + '</span>' +
      '<span style="min-width:0"><span class="task-title" style="display:block">' + escHtml(t.title) + '</span>' +
      '<span class="task-sub">' + escHtml(t.sub) + '</span></span>' +
      '<span class="task-state">' + stateIcon + '</span></div>' +
      '<p class="task-goal">' + t.goal + '</p>' +
      '<div class="task-body">' +
      '<pre class="sql-hint">' + escHtml(t.sample) + '</pre>' +
      '<div class="task-actions">' +
      '<button class="btn ghost small act-use">Use sample in editor</button>' +
      (locked ? '' : '<button class="btn small act-auto">' + icon('play') + ' Run for me</button>') +
      '</div></div></div>';
  }).join('');
  list.innerHTML = html;
  refreshIcons(list);
  const done = state.taskDone.filter(Boolean).length;
  el('progressDone').textContent = done;
  el('progressTotal').textContent = TASKS.length;
  el('progressBar').style.width = (done / TASKS.length) * 100 + '%';
}

function nextUndone() { return state.taskDone.findIndex((d) => !d); }

function completeTask(i, viaAuto) {
  if (state.taskDone[i]) return;
  state.taskDone[i] = true;
  renderTaskCards();
  const card = el('taskList').querySelector('.task-card[data-i="' + i + '"]');
  if (card) celebrate(card.querySelector('.task-num'));
  toast('<b>' + escHtml(TASKS[i].title) + '</b> — completed! ' + TASKS[i].doneMsg, 'ok');
  activityLog('sys', 'Tutorial task ' + (i + 1) + ' complete', '✓ ' + TASKS[i].title);
  const rest = nextUndone();
  if (rest === -1) {
    setTimeout(() => {
      toast('<b>All 4 tasks complete 🏆</b> — you built a relational database and JOINed it. Try Load demo DB or the backend script for more!', 'ok');
      celebrate();
    }, 700);
  } else {
    setTimeout(() => {
      const nxt = el('taskList').querySelector('.task-card[data-i="' + rest + '"]');
      if (nxt) { nxt.classList.add('open'); nxt.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }, 500);
  }
}

/* auto-verification after every user / tutorial run */
function verifyTasks(meta) {
  meta = meta || { joined: false };
  const first = nextUndone();
  if (first === -1) return;
  for (let i = first; i < TASKS.length && (i === first || state.taskDone[i - 1]); i++) {
    if (state.taskDone[i]) continue;
    if (i < 3) {
      if (taskCompleted(i)) completeTask(i);
      continue;
    }
    // task 4 — needs an actual JOIN that returned rows
    if (meta.joined) {
      const u = tableExists('users'), p = tableExists('posts');
      const usersRows = u ? rowCountOf(u) : 0;
      const postsRows = p ? rowCountOf(p) : 0;
      if (usersRows >= 1 && postsRows >= 1) completeTask(3, true);
      else toast('Nice JOIN — but it returned 0 rows. Make sure both tables have data (Tasks 2–3), then rerun.', 'warn');
    }
  }
}

/* ════════════════ §11  UI WIRING & INIT ═════════════════════════════════ */

function detectJoinMeta(src, summary) {
  const cleaned = String(src).replace(/'([^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const fromIdx = cleaned.search(/\bfrom\b/i);
  if (fromIdx < 0) return false;
  const tail = cleaned.slice(fromIdx).toLowerCase();
  if (!/\busers\b/.test(tail) || !/\bposts\b/.test(tail)) return false;
  if (/\bjoin\b/.test(tail)) return true;                 // explicit JOIN
  const list = tail.split(/\bfrom\b/i).pop() || tail;     // comma-style FROM a, b
  return /,/.test(list);
}

let editorBind = null;
function uiCache() {
  const ids = ['sqlEditor', 'sqlPre', 'backendArea', 'backendPre', 'btnRunSql', 'btnClearSql', 'sqlStatus',
    'btnSeedDemo', 'btnResetDb', 'btnRunScript', 'btnStopScript', 'scriptStatus', 'langTabs', 'connHost',
    'connUser', 'connDb', 'taskList', 'vizTabs', 'dataPanel', 'schemaPanel', 'dataList', 'dataFilter',
    'dataCountChip', 'erViewport', 'erWorld', 'erSvg', 'erEdgeLayer', 'erCards', 'erEmpty', 'erCount',
    'zoomPct', 'btnZoomIn', 'btnZoomOut', 'btnFit', 'resultViews', 'resultsEmpty', 'backendLog',
    'backendEmpty', 'activityList', 'activityEmpty', 'outcomeChip', 'resultBanner', 'resultBannerText',
    'resultBannerClose', 'bootRetry', 'engineDot', 'engineStateText', 'statTables', 'statRows',
    'dataEmpty', 'backendSection', 'backendBody', 'tutorialSection', 'toastHost'];
  ids.forEach((i) => { ui[i] = el(i); });
}

function wireTabs() {
  // console tabs
  $$('#consoleTabs .seg-btn').forEach((b) => b.addEventListener('click', () => focusConsoleTab(b.dataset.tab)));
  // visualizer tabs
  $$('#vizTabs .seg-btn').forEach((b) => b.addEventListener('click', () => {
    $$('#vizTabs .seg-btn').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
    const dataMode = b.dataset.viz === 'data';
    ui.schemaPanel.hidden = dataMode;
    ui.dataPanel.hidden = !dataMode;
    if (dataMode) renderData(); else { renderSchema(); requestAnimationFrame(fitView); }
  }));
}

function wireEditorActions() {
  el('btnRunSql').addEventListener('click', onRunSql);
  el('btnClearSql').addEventListener('click', () => { editorBind.area.value = ''; editorBind.paint(); editorBind.sync(); editorBind.area.focus(); });
  editorBind.area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRunSql(); }
  });
  editorBind.area.addEventListener('input', () => {
    const l = editorBind.area.value.split('\n').length;
    const s = editorBind.area.selectionStart;
    el('sqlStatus').textContent = l + ' lines · ' + editorBind.area.value.length + ' chars — Ctrl+Enter to run';
  });
}

async function onRunSql() {
  if (!state.engineReady) { toast('The SQL engine is still loading — one second…', 'warn'); return; }
  const src = editorBind.area.value;
  const joined = detectJoinMeta(src, null);
  const t0 = performance.now();
  const summary = await runSqlText(src, { origin: 'user' });
  summary.ms = performance.now() - t0;
  showResults(summary);
  focusConsoleTab(summary.hasResults && !summary.errors ? 'results' : summary.errors ? 'results' : 'activity');
  el('sqlStatus').textContent = 'Ran in ' + (performance.now() - t0).toFixed(0) + ' ms · ' +
    summary.ok + ' ok' + (summary.errors ? ' · ' + summary.errors + ' error(s)' : '');
  verifyTasks({ joined: joined && summary.rowsOut > 0, rows: summary.rowsOut });
}

function setLang(langKey) {
  const cfg = LANGS[langKey];
  $$('#langTabs .seg-btn').forEach((b) => {
    const on = b.dataset.lang === langKey;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ui.connHost.textContent = cfg.conn.host;
  ui.connUser.textContent = cfg.conn.user;
  ui.connDb.textContent = cfg.conn.db;
  if (ui.backendArea.value !== cfg.code) {
    ui.backendArea.value = cfg.code;
    ui.backendPre.innerHTML = highlight(cfg.code, cfg.spec);
  }
  state.backendLang = langKey;
  el('scriptStatus').textContent = 'Shows realistic ' + cfg.label + ' boilerplate — press Run App Script to simulate it against the engine.';
}

function armConfirm(btn, onConfirm) {      // two-click confirmation (no native dialogs)
  if (btn.dataset.armed) return;           // already awaiting a second click
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  const restore = () => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.onmouseleave = null;
    btn.onclick = null;
  };
  const t = setTimeout(restore, 2600);
  btn.onmouseleave = () => { clearTimeout(t); restore(); };
  btn.onclick = (e) => {
    if (e) e.stopPropagation();
    clearTimeout(t);
    restore();
    onConfirm();
  };
}

async function wipeDb() {
  if (!state.db || !state.SQLModule) { toast('Engine not ready yet — hold on a second.', 'warn'); return false; }
  state.driverToken++;                        // stop any running backend simulation
  await sleep(60);                            // let it unwind before closing the db
  try { state.db.close(); } catch (_) { /* already closed */ }
  state.db = new state.SQLModule.SQL.Database();
  state.db.run('PRAGMA foreign_keys = ON;');  // FK enforcement is ON for every new engine
  state.layout = {};
  state.tables = new Map();
  state.view = { k: 1, x: 24, y: 20 };
  state.viewTouched = false;
  state.needsFit = false;
  state.sampleLoaded = false;
  extractSchema();
  return true;
}

function wireActions() {
  // Run / Stop backend sim
  el('btnRunScript').addEventListener('click', () => runBackendScript(state.backendLang || 'node'));
  el('btnStopScript').addEventListener('click', () => { state.driverToken++; });

  // language tabs
  $$('#langTabs .seg-btn').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));

  // reset (two-click) + demo loader
  el('btnResetDb').addEventListener('click', () => armConfirm(el('btnResetDb'), async () => {
    if (!await wipeDb()) return;
    state.taskDone = [false, false, false, false];       // fresh start: tasks re-armed
    renderTaskCards(); renderSchema(); renderData();
    showResults(null); banner('info', '<b>Database reset.</b> Empty engine — every table and row is gone. Tasks were re-armed.');
    activityLog('sys', 'Database reset', 'fresh SQLite engine created in-memory');
    toast('Database wiped — a fresh SQLite engine is ready.', 'info');
    updateStatChips(); updateVisualizerCounts();
    focusConsoleTab('activity');
  }));
  el('btnSeedDemo').addEventListener('click', () => armConfirm(el('btnSeedDemo'), () => loadDemo()));

  // tutorial task card interactions
  el('taskList').addEventListener('click', (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    const i = +card.dataset.i;
    const useBtn = e.target.closest('.act-use');
    const autoBtn = e.target.closest('.act-auto');
    if (useBtn || autoBtn) {
      if (useBtn) {
        editorBind.area.value = TASKS[i].sample;
        editorBind.area.focus(); editorBind.paint();
        el('sqlStatus').textContent = 'Sample loaded — press Run SQL (or Ctrl+Enter) to execute it.';
        toast('Sample loaded into the SQL editor — hit <b>Run SQL</b>.', 'info');
      } else {
        const guard = (taskGuards[i] || (() => true))();
        if (!guard) { toast(taskGuardMsgs[i], 'warn'); return; }
        (async () => {
          const summary = await runSqlText(TASKS[i].sample, { origin: 'auto' });
          showResults(summary);
          focusConsoleTab(summary.hasResults && !summary.errors ? 'results' : 'activity');
          verifyTasks({ joined: detectJoinMeta(TASKS[i].sample, null) && summary.rowsOut > 0 });
          toast('Ran the sample SQL for you — read the console to see what happened.', 'info');
        })();
      }
      return;
    }
    // toggle open/close (locked cards give a nudge instead)
    const locked = card.classList.contains('locked');
    if (locked) {
      toast('Finish Task ' + i + ' first, then this one unlocks.', 'warn');
      return;
    }
    card.classList.toggle('open');
  });

  // collapsible backend section
  $('.collapse-head').addEventListener('click', () => {
    const head = $('.collapse-head');
    head.classList.toggle('collapsed');
    ui.backendBody.hidden = head.classList.contains('collapsed');
  });

  // data view: filter + collapsible tables
  el('dataFilter').addEventListener('input', () => renderData());
  el('dataList').addEventListener('click', (e) => {
    const head = e.target.closest('.dtable-head');
    if (head) head.parentElement.classList.toggle('collapsed');
  });

  // zoom controls + canvas
  el('btnZoomIn').addEventListener('click', () => zoomAt(1.2));
  el('btnZoomOut').addEventListener('click', () => zoomAt(1 / 1.2));
  el('btnFit').addEventListener('click', fitView);
  wireERCanvas();

  // banner dismiss
  el('resultBannerClose').addEventListener('click', () => { el('resultBanner').hidden = true; });
}

/* demo dataset — a real mini social app, FK-safe, uses plain SQL */
const DEMO_SQL = [
  'CREATE TABLE users (\n' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
  '  full_name TEXT NOT NULL,\n' +
  '  email TEXT NOT NULL UNIQUE,\n' +
  '  age INTEGER,\n' +
  '  city TEXT,\n' +
  "  created_at TEXT DEFAULT (datetime('now'))\n" +
  ');',
  "INSERT INTO users (full_name, email, age, city) VALUES\n" +
  "  ('Alice Nguyen',   'alice@example.com', 27, 'Lisbon'),\n" +
  "  ('Bob Kowalski',   'bob@example.com',   34, 'Kraków'),\n" +
  "  ('Cara O''Sullivan','cara@example.com',  29, 'Dublin');",
  'CREATE TABLE posts (\n' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
  '  user_id INTEGER NOT NULL,\n' +
  '  title TEXT NOT NULL,\n' +
  '  content TEXT,\n' +
  '  likes INTEGER DEFAULT 0,\n' +
  "  created_at TEXT DEFAULT (datetime('now')),\n" +
  '  FOREIGN KEY (user_id) REFERENCES users(id)\n' +
  ');',
  'INSERT INTO posts (user_id, title, content) VALUES\n' +
  "  ((SELECT id FROM users WHERE email = 'alice@example.com'), 'Learning SQL the fun way', 'The ER diagram drew itself from real CREATE TABLE statements.'),\n" +
  "  ((SELECT id FROM users WHERE email = 'bob@example.com'),   'Backend simulation', 'Hit Run App Script — a fake Node/Python driver INSERTs row by row.'),\n" +
  "  ((SELECT id FROM users WHERE email = 'cara@example.com'),  'Foreign keys 101', 'Orange arrows connect every FK to its referenced table.');",
];

async function loadDemo() {
  if (!state.engineReady) { toast('Engine is still starting…', 'warn'); return; }
  if (!await wipeDb()) return;                // demo replaces whatever is there
  activityLog('sys', 'Demo dataset', 'loading users + posts with sample rows…');
  for (const sql of DEMO_SQL) {
    try {
      const res = execStmt(sql);
      const brief = sql.trim().replace(/\s+/g, ' ').slice(0, 80);
      activityLog('sql', brief, '');
      if (res.changes) activityLog('ok', sqlTypeOf(sql).toUpperCase() + ' done', res.changes + ' row(s) inserted');
    } catch (err) {
      activityLog('err', 'demo failed', String(err.message || err).slice(0, 200));
    }
  }
  syncFromEngine(new Set(['users', 'posts']), 'demo');
  // switch the right panel to Live Data for the reveal
  const dataTab = $('.viz-tabs .seg-btn[data-viz="data"]');
  if (dataTab) dataTab.click();
  showResults(null);
  banner('ok', '<b>Demo database loaded.</b> 2 tables · 6 rows · 1 FK relationship. The tasks are still there — or write your own SQL above.');
  toast('Demo loaded — explore the ER diagram & live data, then try the tasks.', 'ok');
  focusConsoleTab('activity');
}

/* lucide is purely cosmetic — if the primary CDN failed we retry once,
   otherwise the app keeps working without icons */
function ensureLucide() {
  if (window.lucide) return Promise.resolve();
  const candidates = [
    'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/lucide/0.469.0/lucide.min.js',
  ];
  const tryNext = (i) => {
    if (i >= candidates.length || window.lucide) return Promise.resolve();
    const s = document.createElement('script');
    s.src = candidates[i];
    return new Promise((res) => { s.onload = () => res(); s.onerror = () => res(tryNext(i + 1)); document.head.appendChild(s); });
  };
  return tryNext(0);
}

function init() {
  uiCache();
  // syntax editors
  editorBind = bindEditor('sqlEditor', 'sqlPre', 'sql');
  bindEditor('backendArea', 'backendPre', 'js');
  setLang('node');
  renderTaskCards();
  renderSchema();
  renderData();
  wireTabs();
  wireEditorActions();
  wireActions();
  ui.bootRetry.addEventListener('click', () => { bootEngine(); });   // Retry after a failed CDN probe
  ensureLucide().then(() => refreshIcons(document));
  refreshIcons();
  bootEngine();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// small debug hook (console: window.__playground.db …)
window.__playground = state;
