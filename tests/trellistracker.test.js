import "./fixtures/test-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTrellisUpstream, isTrackerIssueOpen, TRACKER_PREFIX } from "../src/trellistracker.js";

const NOW = "2026-08-12T00:00:00.000Z";
const BASE = { lastKnownVersion: "0.6.14", upstreamOk: true, lastCheckedAt: "2026-08-05T00:00:00.000Z" };

/** Build a fake fetch from per-URL responses: { url -> {status, body} } */
function fakeFetch(routes) {
  return async (url) => {
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return { status: r.status, json: async () => r.body ?? {} };
  };
}
const npm = (version) => ({ status: 200, body: { version } });
const repo = (extra = {}) => ({ status: 200, body: { pushed_at: "2026-08-11T12:08:50Z", archived: false, ...extra } });

test("new version -> action=update with an issue + state advanced", async () => {
  const res = await checkTrellisUpstream({
    state: BASE,
    fetchImpl: fakeFetch({ [npmKey()]: npm("0.6.15"), [repoKey()]: repo() }),
    nowIso: NOW,
  });
  assert.equal(res.action, "update");
  assert.equal(res.exitCode, 0);
  assert.equal(res.state.lastKnownVersion, "0.6.15");
  assert.equal(res.state.upstreamOk, true);
  assert.equal(res.state.lastCheckedAt, NOW);
  assert.ok(res.issue.title.startsWith(TRACKER_PREFIX));
  assert.match(res.issue.title, /0\.6\.14 → 0\.6\.15/);
  assert.match(res.issue.body, /npm/);
  assert.match(res.issue.body, /mindfold-ai\/trellis/);
});

test("same version -> noop, only lastCheckedAt changes", async () => {
  const res = await checkTrellisUpstream({
    state: BASE,
    fetchImpl: fakeFetch({ [npmKey()]: npm("0.6.14"), [repoKey()]: repo() }),
    nowIso: NOW,
  });
  assert.equal(res.action, "noop");
  assert.equal(res.issue, undefined);
  assert.equal(res.state.lastKnownVersion, "0.6.14");
  assert.equal(res.state.lastCheckedAt, NOW);
});

test("upstream 404 (trellis deleted its repo) -> ONE notice, paused, exit 0", async () => {
  const res = await checkTrellisUpstream({
    state: BASE,
    fetchImpl: fakeFetch({ [npmKey()]: { status: 404, body: {} }, [repoKey()]: { status: 404, body: {} } }),
    nowIso: NOW,
  });
  assert.equal(res.action, "notice");
  assert.equal(res.exitCode, 0, "workflow must NOT fail when the repo is deleted");
  assert.equal(res.state.upstreamOk, false);
  assert.match(res.issue.title, /upstream unavailable \(404\)/);
  assert.match(res.issue.body, /paused/);
});

test("upstream still gone -> noop (no duplicate notice issues)", async () => {
  const res = await checkTrellisUpstream({
    state: { ...BASE, upstreamOk: false },
    fetchImpl: fakeFetch({ [npmKey()]: { status: 404, body: {} }, [repoKey()]: { status: 404, body: {} } }),
    nowIso: NOW,
  });
  assert.equal(res.action, "noop");
  assert.equal(res.issue, undefined);
  assert.equal(res.state.upstreamOk, false);
  assert.equal(res.exitCode, 0);
});

test("upstream recovers -> tracking resumes (recover action when no new version)", async () => {
  const res = await checkTrellisUpstream({
    state: { ...BASE, upstreamOk: false },
    fetchImpl: fakeFetch({ [npmKey()]: npm("0.6.14"), [repoKey()]: repo() }),
    nowIso: NOW,
  });
  assert.equal(res.action, "recover");
  assert.equal(res.state.upstreamOk, true);
  assert.equal(res.issue, undefined);
});

test("recovery WITH a new version -> update issue notes the recovery", async () => {
  const res = await checkTrellisUpstream({
    state: { ...BASE, upstreamOk: false },
    fetchImpl: fakeFetch({ [npmKey()]: npm("0.6.16"), [repoKey()]: repo() }),
    nowIso: NOW,
  });
  assert.equal(res.action, "update");
  assert.equal(res.state.upstreamOk, true);
  assert.match(res.issue.body, /Recovered/);
});

test("transient errors (5xx / rate limit) -> quiet noop, state untouched", async () => {
  const res = await checkTrellisUpstream({
    state: BASE,
    fetchImpl: fakeFetch({ [npmKey()]: { status: 200, body: { version: "0.6.15" } }, [repoKey()]: { status: 403, body: {} } }),
    nowIso: NOW,
  });
  assert.equal(res.action, "noop");
  assert.equal(res.exitCode, 0);
  assert.equal(res.state.upstreamOk, true, "transient error must not flip upstreamOk");
  assert.equal(res.state.lastKnownVersion, "0.6.14");
});

test("archived upstream repo is flagged in the update issue", async () => {
  const res = await checkTrellisUpstream({
    state: BASE,
    fetchImpl: fakeFetch({ [npmKey()]: npm("0.6.15"), [repoKey()]: repo({ archived: true }) }),
    nowIso: NOW,
  });
  assert.equal(res.action, "update");
  assert.match(res.issue.body, /ARCHIVED/);
});

test("isTrackerIssueOpen dedupes by exact tracker title", () => {
  const open = [{ title: `${TRACKER_PREFIX} Trellis update available: 0.6.14 → 0.6.15` }, { title: "unrelated issue" }];
  assert.equal(isTrackerIssueOpen(open, `${TRACKER_PREFIX} Trellis update available: 0.6.14 → 0.6.15`), true);
  assert.equal(isTrackerIssueOpen(open, `${TRACKER_PREFIX} Trellis update available: 0.6.14 → 0.6.16`), false);
  assert.equal(isTrackerIssueOpen([], "x"), false);
});

function npmKey() { return "https://registry.npmjs.org/@mindfoldhq/trellis/latest"; }
function repoKey() { return "https://api.github.com/repos/mindfold-ai/trellis"; }
