// @ts-check
// Test fixture: a tiny "remote headless helper" that speaks the MAWF workspace
// bridge protocol over stdio, backed by BridgeServer + a stub provider set.
// SSH-transport tests spawn it DIRECTLY as `node fake-ssh-helper.mjs serve`
// via process.execPath (no ssh binary, no network) through SshTransport's
// injectable argv builder — same code path as the real remote chain.
//
// Modes (flags after `serve`) simulate contract §8.2 failure modes:
//   --noise-lines N    print N junk banner lines on stdout before serving
//   --noise-bytes N    print one junk line of N bytes (exceeds banner budget)
//   --slow-search MS   knowledge.search sleeps MS ms before answering
//   --silent           never answer (hello-timeout simulation)
//
// Provider quirks: project.get with id "boom" throws (provider-error path).

import readline from "node:readline";

import { BridgeServer } from "../../src/workspace/bridge.js";
import { CAPABILITIES } from "../../src/workspace/protocol.js";

const argv = process.argv.slice(2);
const serveIdx = argv.indexOf("serve");
if (serveIdx < 0) {
  console.error("usage: node fake-ssh-helper.mjs serve [--noise-lines N] [--noise-bytes N] [--slow-search MS] [--silent]");
  process.exit(2);
}
const flags = argv.slice(serveIdx + 1);
/** @param {string} name @param {number} dflt */
function flagNum(name, dflt) {
  const i = flags.indexOf(name);
  const v = i >= 0 ? Number(flags[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}
const noiseLines = flagNum("--noise-lines", 0);
const noiseBytes = flagNum("--noise-bytes", 0);
const slowSearchMs = flagNum("--slow-search", 0);
const silent = flags.includes("--silent");

const providers = {
  workspace: {
    describe: async () => ({ name: "fake-ws", root: "/srv/fake", host: "fake-host" }),
  },
  project: {
    list: async () => ({ projects: [{ id: "p1", name: "Fake Project" }] }),
    tasks: async () => ({ tasks: [{ id: "t1", title: "write tests" }] }),
    get: async (p) => {
      if (!p?.id) throw new Error("task id required");
      if (p.id === "boom") throw new Error("exploded on purpose");
      return { id: String(p.id), title: "write tests" };
    },
    specs: async () => ({ specs: [{ id: "backend" }] }),
    relations: async () => ({ edges: [] }),
  },
  knowledge: {
    list: async () => ({ docs: [{ id: "k1", title: "doc" }] }),
    get: async (p) => ({ id: String(p?.id ?? ""), title: "doc" }),
    search: async (p) => {
      if (slowSearchMs > 0) await new Promise((r) => setTimeout(r, slowSearchMs));
      return { hits: [{ id: "k1", title: `hit:${p?.q ?? ""}` }] };
    },
  },
  artifact: {
    list: async () => ({ artifacts: [{ id: "a1" }] }),
    receipt: async (p) => ({ id: String(p?.id ?? "a1"), bytes: 3, digest: "sha256:abc" }),
    read: async (p) => ({ id: String(p?.id ?? "a1"), content: "hi\n" }),
    chunk: async (p) => ({ id: String(p?.id ?? "a1"), offset: Number(p?.offset ?? 0), data: "hi" }),
  },
  runtime: {
    snapshot: async () => ({ agents: [] }),
    subscribe: async () => ({ subscribed: true, channel: "runtime" }),
    unsubscribe: async () => ({ subscribed: false, channel: "runtime" }),
  },
  terminal: {
    snapshot: async () => ({ panes: [] }),
  },
};

const server = new BridgeServer({
  serverId: "fake-helper",
  capabilities: Object.values(CAPABILITIES),
  providers,
});

// Banner noise precedes any protocol traffic (kept on stdout on purpose).
if (noiseLines > 0) {
  for (let i = 0; i < noiseLines; i++) {
    process.stdout.write(`banner line ${i}: welcome to the bastion, enjoy your authorized stay\n`);
  }
}
if (noiseBytes > 0) {
  process.stdout.write("N".repeat(noiseBytes) + "\n");
}

if (silent) {
  // Keep stdin open (process stays alive) but never answer: hello timeout.
  readline.createInterface({ input: process.stdin }).on("line", () => {});
} else {
  const rl = readline.createInterface({ input: process.stdin });
  /** @type {string[]} */
  const queue = [];
  /** Serialization chain so responses keep request order. */
  let chain = Promise.resolve();
  const drain = () => {
    while (queue.length > 0) {
      const line = queue.shift();
      chain = chain
        .then(() => server.handleLine(line))
        .then((lines) => {
          for (const l of lines) process.stdout.write(l);
        })
        .catch((e) => {
          process.stdout.write(
            JSON.stringify({ type: "response", id: "", ok: false, error: { code: "internal", message: String(e) } }) + "\n",
          );
        });
    }
  };
  rl.on("line", (line) => {
    queue.push(line);
    drain();
  });
}
