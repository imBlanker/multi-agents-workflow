#!/usr/bin/env node
import { main } from "../src/index.js";
const code = main();
// Command handlers may return a numeric exit code (e.g. knowledge verify,
// archify adapter) or a PROMISE of one (e.g. `mawf bridge serve`,
// `mawf bridge install-helper`) — both paths must land on the real process
// exit code. Existing handlers signal via process.exitCode directly.
if (code && typeof code.then === "function") {
  code.then(
    (c) => {
      if (typeof c === "number") process.exitCode = c;
    },
    (e) => {
      console.error(`mawf: ${e?.message ?? e}`);
      process.exitCode = 1;
    },
  );
} else if (typeof code === "number") {
  process.exitCode = code;
}
