// @ts-check
// Tests for src/workspace/ref.js — pure identity logic, no fs access.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_REF_VERSION,
  makeWorkspaceRef, workspaceKey, sessionKey, displayLabel,
  encodeWorkspaceRef, decodeWorkspaceRef, normalizeRoot, serverId,
} from "../src/workspace/ref.js";

test("makeWorkspaceRef builds a valid local ref with normalized root", () => {
  const ref = makeWorkspaceRef({ endpoint: { kind: "local" }, root: "/srv/proj/" });
  assert.equal(ref.refVersion, WORKSPACE_REF_VERSION);
  assert.equal(ref.root, "/srv/proj");
  assert.equal(ref.repoId, null);
});

test("makeWorkspaceRef rejects empty/bad roots and bad endpoint kinds", () => {
  assert.throws(() => makeWorkspaceRef({ endpoint: { kind: "local" }, root: "" }));
  assert.throws(() => makeWorkspaceRef({ endpoint: { kind: "ftp" }, root: "/x" }));
  assert.throws(() => makeWorkspaceRef({ endpoint: { kind: "local" }, root: "/x", repoId: 42 }));
  assert.throws(() => makeWorkspaceRef({ endpoint: { kind: "local" }, root: "a\0b" }));
});

test("ssh ref derives serverId from user/host/port", () => {
  const ref = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox" }, root: "/srv/proj" });
  assert.match(ref.endpoint.serverId, /^[0-9a-f]{16}$/);
  // same connection facts => same serverId
  const ref2 = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox" }, root: "/other" });
  assert.equal(ref.endpoint.serverId, ref2.endpoint.serverId);
  // different user => different serverId
  const ref3 = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox", user: "alice" }, root: "/srv/proj" });
  assert.notEqual(ref.endpoint.serverId, ref3.endpoint.serverId);
});

test("workspaceKey separates servers with identical paths, joins aliases per serverId", () => {
  const local = makeWorkspaceRef({ endpoint: { kind: "local" }, root: "/repo" });
  const hostA = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "alpha" }, root: "/repo" });
  const hostB = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "beta" }, root: "/repo" });
  assert.notEqual(workspaceKey(local), workspaceKey(hostA));
  assert.notEqual(workspaceKey(hostA), workspaceKey(hostB)); // A12: hostA:/repo != hostB:/repo

  // same server reached via two aliases (same resolved serverId) => same key
  const alias1 = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "alias1", serverId: serverId({ host: "real" }) }, root: "/repo" });
  const alias2 = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "alias2", serverId: serverId({ host: "real" }) }, root: "/repo" });
  assert.equal(workspaceKey(alias1), workspaceKey(alias2));

  // different worktrees of one repo are distinct workspaces
  const wt1 = makeWorkspaceRef({ endpoint: { kind: "local" }, root: "/repo/.worktrees/feat" });
  assert.notEqual(workspaceKey(local), workspaceKey(wt1));
});

test("sessionKey is scoped by workspace+hostApp, rejects bare/unknown ids", () => {
  const ref = makeWorkspaceRef({ endpoint: { kind: "local" }, root: "/repo" });
  const other = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "beta" }, root: "/repo" });
  const k1 = sessionKey({ ref, hostApp: "pi", sessionId: "abc" });
  const k2 = sessionKey({ ref: other, hostApp: "pi", sessionId: "abc" });
  const k3 = sessionKey({ ref, hostApp: "claude", sessionId: "abc" });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.throws(() => sessionKey({ ref, hostApp: "pi", sessionId: "" }));
  assert.throws(() => sessionKey({ ref, hostApp: "", sessionId: "abc" }));
});

test("displayLabel keeps local and remote visually distinct", () => {
  assert.equal(displayLabel(makeWorkspaceRef({ endpoint: { kind: "local" }, root: "/repo" })), "local:/repo");
  assert.equal(displayLabel(makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox" }, root: "/repo" })), "devbox:/repo");
});

test("normalizeRoot: posix stays case-sensitive; win32 only when flagged", () => {
  assert.equal(normalizeRoot("/Repo//x/"), "/Repo/x");
  assert.equal(normalizeRoot("//srv//proj///"), "/srv/proj");
  assert.equal(normalizeRoot("/"), "/");
  assert.equal(normalizeRoot("C:\\Repo\\", { platform: "win32" }), "C:/Repo");
  // posix default must NOT fold case (Linux remote rule, contract §8.4)
  assert.notEqual(normalizeRoot("/Repo"), normalizeRoot("/repo"));
});

test("encode/decode round-trips and rejects tampered refs", () => {
  const ref = makeWorkspaceRef({ endpoint: { kind: "ssh", host: "devbox", user: "u" }, root: "/srv/proj", repoId: "https://github.com/x/y" });
  const decoded = decodeWorkspaceRef(encodeWorkspaceRef(ref));
  assert.deepEqual(decoded, ref);
  assert.throws(() => decodeWorkspaceRef(JSON.stringify({ ...ref, refVersion: 99 })));
  assert.throws(() => decodeWorkspaceRef("{not json"));
});
