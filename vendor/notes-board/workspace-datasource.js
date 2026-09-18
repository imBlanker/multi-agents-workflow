/* MAWF-original (NOT part of the vendored upstream asset; task
 * 09-17-mawf-four-tool-integration, P5.1). Upgrade-safe: this file may be
 * regenerated freely — board.html is the only vendored artifact and it stays
 * byte-identical; the serve-time companion bootstrap fetches and evaluates
 * this script (token in a request HEADER, never a URL).
 *
 * WorkspaceRpcDataSource — patches the board's data ingestion WITHOUT
 * rewriting it:
 * - fetches the knowledge corpus over POST /rpc (`knowledge.list` +
 *   `knowledge.get` bodies) on the companion's token-authed loopback server;
 * - maps each store entry onto the board's 13-field note contract
 *   { id, slug, lifecycle, cls, date, title, status, problem, decision,
 *     alternatives, consequences, outLinks[], rawBody };
 * - sets window.__INLINE_DATA__ (the board ingests it at its own init when
 *   non-null; when this script finishes after init, it calls the board's
 *   global ingestDataset() directly — both data paths converge);
 * - sets the project title into #brand-project-title via project.list.
 *
 * Execution shape: a single IIFE, evaluated via new Function(src)() by the
 * injected bootstrap; sessionStorage keys must match src/companion/serve.js.
 */
(() => {
  

  var TOKEN_KEY = 'mawf.companion.token';
  var NOTES_KEY = 'mawf.companion.notes';
  var MAX_NOTES = 200; // bounded body fetches per load (corpora are small; guard anyway)
  var MAX_CACHE_BYTES = 2000000; // sessionStorage quota guard (~2MB)

  var seq = 0;

  function token() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  /** One token-authed protocol request -> response.result (throws on error frame). */
  function rpc(method, params) {
    return fetch('/rpc', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-Mawf-Token': token() || '' },
      body: JSON.stringify({ id: 'ds' + (++seq), method: method, params: params || {} })
    }).then((r) => {
      if (!r.ok) throw new Error(method + ': HTTP ' + r.status);
      return r.json();
    }).then((frame) => {
      if (!frame || frame.type !== 'response' || !frame.ok) {
        var code = frame && frame.error ? frame.error.code : 'no_response';
        throw new Error(method + ': ' + code);
      }
      return frame.result;
    });
  }

  /**
   * First markdown section of `text` whose heading starts with one of `names`
   * (case-insensitive). Knowledge docs follow the canonical
   * `## Problem / ## Decision / ## Alternatives considered / ## Consequences`
   * layout; a missing section maps to '' (the board renders blanks).
   */
  function sectionOf(text, names) {
    var lines = String(text || '').split('\n');
    var collected = [];
    var buf = null;
    for (var i = 0; i < lines.length; i++) {
      var h = /^#{1,6}\s+(.*)$/.exec(lines[i]);
      if (h) {
        var name = h[1].trim().toLowerCase();
        var want = false;
        for (var k = 0; k < names.length; k++) {
          if (name.startsWith(names[k])) { want = true; break; }
        }
        if (want) { buf = []; collected.push(buf); } else { buf = null; }
        continue;
      }
      if (buf) buf.push(lines[i]);
    }
    for (var j = 0; j < collected.length; j++) {
      var s = collected[j].join('\n').trim();
      if (s) return s;
    }
    return '';
  }

  /** [[wiki-links]] + markdown links ending in .md, deduped, order kept. */
  function outLinksOf(text) {
    var found = [];
    var seen = {};
    var re = /\[\[([^\]\n]+)\]\]|\]\(([^)\s]+\.md)\)/g;
    var m;
    while ((m = re.exec(String(text || '')))) {
      var t = (m[1] || m[2] || '').trim();
      if (t && !seen[t]) { seen[t] = true; found.push(t); }
    }
    return found;
  }

  /** knowledge.list entry + knowledge.get body -> the board's 13-field note. */
  function toNote(entry, body) {
    var rel = (entry && entry.rel) || (body && body.path) || '';
    var slug = rel.split('/').pop().replace(/\.md$/, '');
    var text = (body && body.text) || '';
    var dateM = slug.match(/\d{4}-\d{2}-\d{2}/);
    return {
      id: (entry && entry.id) || (body && body.id) || rel,
      slug: slug,
      lifecycle: (entry && entry.lifecycle) || (body && body.lifecycle) || 'implemented',
      cls: (entry && entry.cls) || (body && body.cls) || 'architecture',
      date: (entry && entry.date) || (dateM ? dateM[0] : null),
      title: (entry && entry.title) || (body && body.title) || slug,
      status: (entry && entry.status) || (body && body.status) || null,
      problem: sectionOf(text, ['problem']),
      decision: sectionOf(text, ['decision']),
      alternatives: sectionOf(text, ['alternatives']),
      consequences: sectionOf(text, ['consequences']),
      outLinks: outLinksOf(text),
      rawBody: text
    };
  }

  /**
   * Data is ready: set the board's inline-data slot, refresh the session
   * cache, and (when the board already initialized with empty data) drive its
   * own ingestDataset() so the same render path is used either way.
   */
  function publish(notes) {
    window.__INLINE_DATA__ = notes;
    try {
      var json = JSON.stringify(notes);
      if (json.length <= MAX_CACHE_BYTES) sessionStorage.setItem(NOTES_KEY, json);
    } catch (e) { /* quota/private mode: skip caching, data still renders */ }
    if (typeof window.ingestDataset === 'function') window.ingestDataset(notes);
  }

  if (!token()) return; // no session token: leave the board's own empty state

  rpc('knowledge.list').then((res) => {
    var entries = ((res && res.entries) || []).slice(0, MAX_NOTES);
    var chain = Promise.resolve();
    var notes = [];
    // Sequential (bounded, polite): one body fetch per entry; a vanished doc
    // must never blank the whole board.
    entries.forEach((entry) => {
      chain = chain.then(() => rpc('knowledge.get', { path: entry.rel, kind: entry.kind })
          .then((body) => { notes.push(toNote(entry, body)); })
          .catch(() => { /* skip unreadable entry */ }));
    });
    return chain.then(() => {
      publish(notes);
      // Project title from the single authorized project (best effort).
      return rpc('project.list').catch(() => null);
    }).then((pl) => {
      var el = document.getElementById('brand-project-title');
      var name = pl && pl.projects && pl.projects[0] && pl.projects[0].id;
      if (el && name) el.textContent = String(name);
    });
  }).catch((e) => {
    console.error('[mawf] companion data load failed:', e);
  });
})();
